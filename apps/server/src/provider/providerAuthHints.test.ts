import { ProviderDriverKind } from "@threadlines/contracts";
import { expect, it } from "@effect/vitest";

import { addProviderAuthHint } from "./providerAuthHints.ts";

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

it("adds Codex login guidance to unauthenticated failures", () => {
  expect(addProviderAuthHint(ProviderDriverKind.make("codex"), "Not logged in")).toBe(
    "Not logged in Run `codex login` in a terminal, then retry.",
  );
});

it("leaves unrelated provider errors unchanged", () => {
  expect(addProviderAuthHint(ProviderDriverKind.make("codex"), "Sandbox setup failed")).toBe(
    "Sandbox setup failed",
  );
});
