import { ProviderDriverKind, type ProviderInstanceConfig } from "@threadlines/contracts";
import { readAntigravitySignInSetup } from "@threadlines/shared/antigravitySignIn";
import { describe, expect, it } from "vite-plus/test";

import {
  antigravityApplyLabel,
  antigravityDraftReady,
  antigravityRunsAfterSave,
  applyAntigravityDraft,
  removeAntigravityKey,
} from "./antigravitySignIn.logic";

const instance: ProviderInstanceConfig = {
  driver: ProviderDriverKind.make("antigravity"),
  config: { authMethod: "agent-platform", gcpProject: "acme", gcpLocation: "us-central1" },
  environment: [
    { name: "GOOGLE_API_KEY", value: "", sensitive: true, valueRedacted: true },
    { name: "HTTPS_PROXY", value: "http://proxy:8080", sensitive: false },
  ],
};
const setup = readAntigravitySignInSetup(instance);

describe("applyAntigravityDraft", () => {
  it("saves the method and a new key as a secret under that method's name, keeping the other's", () => {
    const next = applyAntigravityDraft(instance, {
      method: "gemini-api-key",
      project: "",
      location: "",
      key: " AIzaNewKey ",
    });
    // The Vertex project stays for a later switch back.
    expect(next.config).toEqual({
      authMethod: "gemini-api-key",
      gcpProject: "acme",
      gcpLocation: "us-central1",
    });
    expect(next.environment).toEqual([
      ...instance.environment!,
      { name: "GEMINI_API_KEY", value: "AIzaNewKey", sensitive: true },
    ]);
  });

  it("replaces a saved key, and removing it leaves the rest of the environment", () => {
    const replaced = applyAntigravityDraft(instance, {
      method: "agent-platform",
      project: "acme",
      location: "us-central1",
      key: "vertex-new",
    });
    expect(replaced.environment).toEqual([
      { name: "HTTPS_PROXY", value: "http://proxy:8080", sensitive: false },
      { name: "GOOGLE_API_KEY", value: "vertex-new", sensitive: true },
    ]);
    expect(removeAntigravityKey(instance, "agent-platform").environment).toEqual([
      { name: "HTTPS_PROXY", value: "http://proxy:8080", sensitive: false },
    ]);
  });
});

describe("the method choice", () => {
  it("only offers a switch the method can use, and says what it does", () => {
    const enterprise = { method: "oauth-business", project: "", location: "", key: "" } as const;
    expect(antigravityDraftReady(instance, enterprise)).toBe(false);
    expect(
      antigravityDraftReady(instance, { ...enterprise, project: "acme", location: "global" }),
    ).toBe(true);
    expect(antigravityApplyLabel(setup, enterprise)).toBe("Switch and sign in");
    expect(antigravityRunsAfterSave(setup, enterprise)).toBe(true);

    const gemini = { method: "gemini-api-key", project: "", location: "", key: "" } as const;
    expect(antigravityDraftReady(instance, gemini)).toBe(false);
    expect(antigravityApplyLabel(setup, gemini)).toBe("Switch to Gemini API key");

    // Back to a Google account keeps its saved sign-in: nothing to start.
    const google = { method: "oauth-personal", project: "", location: "", key: "" } as const;
    expect(antigravityRunsAfterSave(setup, google)).toBe(false);
    expect(antigravityApplyLabel(setup, { ...setup, key: "" })).toBe("Save");
  });
});
