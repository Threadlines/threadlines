import { ProviderDriverKind } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addProviderAuthHint,
  findProviderAuthRetryUserMessageIndex,
  isProviderAuthErrorMessage,
  isProviderAuthErrorReply,
  providerAuthReconnectCommand,
} from "./providerAuth.ts";

describe("provider auth helpers", () => {
  it("detects provider authentication failures", () => {
    expect(
      isProviderAuthErrorMessage(
        "Failed to authenticate. API Error: 401 Invalid authentication credentials",
      ),
    ).toBe(true);
    expect(isProviderAuthErrorMessage("Access token expired")).toBe(true);
    expect(
      isProviderAuthErrorMessage(
        "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
      ),
    ).toBe(true);
    expect(isProviderAuthErrorMessage("Not logged in • Please run /login")).toBe(true);
    expect(isProviderAuthErrorMessage("Not logged in · Please run /login")).toBe(true);
    // The ACP providers' own status lines.
    expect(
      isProviderAuthErrorMessage(
        "Cursor Agent isn't signed in. Use Sign in, or run `cursor-agent login` in a terminal.",
      ),
    ).toBe(true);
    expect(
      isProviderAuthErrorMessage(
        "fx isn't signed in to Vercel AI Gateway. Use Sign in, or run `wsl fx login` in a terminal.",
      ),
    ).toBe(true);
    expect(isProviderAuthErrorMessage("Sandbox setup failed")).toBe(false);
  });

  it("does not treat explanatory unauthenticated prose as an auth failure", () => {
    expect(
      isProviderAuthErrorMessage(
        "The UI would repeatedly appear unauthenticated even though the primary login was fresh.",
      ),
    ).toBe(false);
    expect(
      isProviderAuthErrorMessage(
        "I could not change the live Vercel project setting yet because the local Vercel CLI is not authenticated and the connector returned 403.",
      ),
    ).toBe(false);
  });

  it("does not send the user to sign in over a request the service refused with a 403", () => {
    const refused =
      "Failed to authenticate. API Error: 403 Access to this model requires an access grant your request does not have.";
    expect(isProviderAuthErrorMessage(refused)).toBe(false);
    expect(addProviderAuthHint(ProviderDriverKind.make("claudeAgent"), refused)).toBe(refused);
  });

  it("reads a reply as a sign-in error only when the thread's own agent wrote just the error", () => {
    const reply = (
      text: string,
      origin: { participantId?: string; sideTurnId?: string; streaming?: boolean } = {},
    ) => isProviderAuthErrorReply({ role: "assistant", text, ...origin });

    expect(reply("Failed to authenticate. API Error: 401 Invalid authentication credentials")).toBe(
      true,
    );
    expect(reply("Not logged in · Please run /login")).toBe(true);
    expect(reply("Not logged in. Run `codex login` in a terminal, then retry.")).toBe(true);
    expect(
      reply(
        'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
      ),
    ).toBe(true);

    // An agent explaining a sign-in error: it quotes it, or says more than a line.
    expect(
      reply(
        'I reproduced `403: {"error":{"message":"Invalid authentication credentials"}}` yielding `permission` on the server.',
      ),
    ).toBe(false);
    expect(
      reply(
        "The narrow fix is to keep real errors like “not logged in” and “401 Invalid authentication credentials,” while dropping prose.",
      ),
    ).toBe(false);
    expect(
      reply('Checking why the probe still says "401 Invalid authentication credentials" here.'),
    ).toBe(false);
    expect(
      reply(
        "I found it. Nothing was wrong with your sign-in.\n\nThe review quoted 401 Invalid authentication credentials as an example.",
      ),
    ).toBe(false);

    // Another agent's words never stand for the thread's own agent's sign-in.
    const error = "Failed to authenticate. API Error: 401 Invalid authentication credentials";
    expect(reply(error, { participantId: "participant-sol" })).toBe(false);
    expect(reply(error, { sideTurnId: "side-turn-review" })).toBe(false);
    // Nor is a reply still being written: its first line is not the whole of it.
    expect(reply(error, { streaming: true })).toBe(false);
  });

  it("targets only the user message immediately followed by a terminal auth response", () => {
    expect(
      findProviderAuthRetryUserMessageIndex([
        { role: "user", text: "first request" },
        { role: "assistant", text: "first response" },
        { role: "user", text: "retry me" },
        { role: "assistant", text: "Not logged in · Please run /login" },
      ]),
    ).toBe(2);
    expect(
      findProviderAuthRetryUserMessageIndex([
        { role: "user", text: "failed request" },
        { role: "assistant", text: "Not logged in · Please run /login" },
        { role: "user", text: "later request" },
        { role: "assistant", text: "later response succeeded" },
      ]),
    ).toBeNull();
    // An answer that explains a sign-in error is not a failed turn to retry.
    expect(
      findProviderAuthRetryUserMessageIndex([
        { role: "user", text: "why did the card show?" },
        {
          role: "assistant",
          text: "It was a false alarm.\n\nThe review quoted `401 Invalid authentication credentials`.",
        },
      ]),
    ).toBeNull();
  });

  it("exposes the provider reconnect command", () => {
    expect(providerAuthReconnectCommand(ProviderDriverKind.make("claudeAgent"))).toBe(
      "claude auth login",
    );
    expect(providerAuthReconnectCommand(ProviderDriverKind.make("codex"))).toBe("codex login");
  });

  it("adds Claude login guidance to authentication failures", () => {
    expect(
      addProviderAuthHint(
        ProviderDriverKind.make("claudeAgent"),
        "Failed to authenticate. API Error: 401 Invalid authentication credentials",
      ),
    ).toBe(
      "Failed to authenticate. API Error: 401 Invalid authentication credentials Run `claude auth login` in a terminal, then retry.",
    );
  });

  it("translates Claude slash-login guidance into terminal sign-in guidance", () => {
    expect(
      addProviderAuthHint(
        ProviderDriverKind.make("claudeAgent"),
        "Not logged in • Please run /login",
      ),
    ).toBe("Not logged in • Please run /login Run `claude auth login` in a terminal, then retry.");
  });

  it("does not duplicate provider login guidance", () => {
    const message = "Not logged in Run `codex login` in a terminal, then retry.";
    expect(addProviderAuthHint(ProviderDriverKind.make("codex"), message)).toBe(message);
  });
});
