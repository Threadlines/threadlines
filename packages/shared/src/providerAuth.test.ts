import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

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
    expect(isProviderAuthErrorMessage("Sandbox setup failed")).toBe(false);
  });

  it("does not treat explanatory unauthenticated prose as an auth failure", () => {
    expect(
      isProviderAuthErrorMessage(
        "The UI would repeatedly appear unauthenticated even though the primary login was fresh.",
      ),
    ).toBe(false);
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

  it("does not duplicate provider login guidance", () => {
    const message = "Not logged in Run `codex login` in a terminal, then retry.";
    expect(addProviderAuthHint(ProviderDriverKind.make("codex"), message)).toBe(message);
  });
});
