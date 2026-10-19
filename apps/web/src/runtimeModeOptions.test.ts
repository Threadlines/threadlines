import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
} from "@threadlines/contracts";

import { deriveRuntimeModeOptions, shownRuntimeMode } from "./runtimeModeOptions";

const GROK = ProviderDriverKind.make("grok");

function provider(
  instanceId: string,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: GROK,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-18T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(supportedRuntimeModes ? { supportedRuntimeModes } : {}),
  };
}

describe("shownRuntimeMode", () => {
  it("shows the level the selected instance runs a chat at, not its driver default's", () => {
    // The default instance failed to load and reports no levels; the account
    // the chat uses is healthy and has Auto.
    const work = provider("grok_work", ["approval-required", "auto", "full-access"]);
    const providers = [provider("grok", undefined), work];
    const options = (snapshot: ServerProvider | null) =>
      deriveRuntimeModeOptions({ providers, provider: GROK, snapshot, models: [], model: null });

    expect(shownRuntimeMode({ providers, mode: "auto", options: options(work) })).toBe("auto");
    // Without Auto-accept edits, that level runs as Supervised.
    expect(shownRuntimeMode({ providers, mode: "auto-accept-edits", options: options(work) })).toBe(
      "approval-required",
    );
    // Before the server's agent list arrives, the choice shows as is.
    expect(shownRuntimeMode({ providers: [], mode: "auto", options: options(null) })).toBe("auto");
  });
});
