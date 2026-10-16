import { ProviderDriverKind, type ProviderInstanceConfig } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyGrokDraft,
  grokDraftReady,
  grokNextStep,
  readGrokSignInSetup,
  removeGrokKey,
} from "./grokSignIn.logic";

const proxy = { name: "HTTPS_PROXY", value: "http://proxy:8080", sensitive: false };
const savedKey = { name: "XAI_API_KEY", value: "", sensitive: true, valueRedacted: true };

const instance = (
  config: Record<string, unknown>,
  environment: ProviderInstanceConfig["environment"] = [proxy],
): ProviderInstanceConfig => ({
  driver: ProviderDriverKind.make("grok"),
  config,
  ...(environment ? { environment } : {}),
});

describe("applyGrokDraft", () => {
  it("saves the key method with the typed key as the secret XAI_API_KEY, replacing an old one", () => {
    const next = applyGrokDraft(instance({ binaryPath: "grok" }, [savedKey, proxy]), {
      method: "api-key",
      key: " xai-new ",
    });
    expect(next.config).toEqual({ binaryPath: "grok", authMethod: "api-key" });
    expect(next.environment).toEqual([
      proxy,
      { name: "XAI_API_KEY", value: "xai-new", sensitive: true },
    ]);
  });

  it("keeps a saved key when switching to the subscription, and removes it only on request", () => {
    const withKey = instance({ authMethod: "api-key" }, [savedKey, proxy]);
    const switched = applyGrokDraft(withKey, { method: "subscription", key: "" });
    expect(switched.config).toEqual({ authMethod: "subscription" });
    expect(switched.environment).toEqual([savedKey, proxy]);
    expect(removeGrokKey(withKey).environment).toEqual([proxy]);
    expect(removeGrokKey(instance({}, [savedKey]))).not.toHaveProperty("environment");
  });
});

describe("grokNextStep", () => {
  it("signs in with a subscription, and sends a key method without a key to its field", () => {
    expect(grokNextStep(readGrokSignInSetup(instance({})))).toEqual({
      kind: "run",
      label: "Sign in with Grok",
    });
    const noKey = readGrokSignInSetup(instance({ authMethod: "api-key" }));
    expect(grokNextStep(noKey)).toMatchObject({ kind: "settings", label: "Add key" });
    expect(grokDraftReady(noKey, { method: "api-key", key: "" })).toBe(false);
    // A redacted secret is a saved key: clients never see its value.
    const keySaved = readGrokSignInSetup(instance({ authMethod: "api-key" }, [savedKey]));
    expect(grokNextStep(keySaved)).toEqual({ kind: "run", label: "Check key" });
  });
});
