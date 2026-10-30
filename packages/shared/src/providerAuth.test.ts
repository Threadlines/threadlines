import { ProviderDriverKind } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addProviderAuthHint,
  isProviderAuthErrorMessage,
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
    // Codex's other failed renewals, which a running session keeps until it restarts.
    for (const message of [
      "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
      "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.",
      "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.",
      "Your access token could not be refreshed. Please log out and sign in again.",
    ]) {
      expect(isProviderAuthErrorMessage(message)).toBe(true);
    }
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
