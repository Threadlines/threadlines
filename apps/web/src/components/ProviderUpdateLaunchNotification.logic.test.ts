import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";

import {
  advanceProviderUpdateRun,
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  describeProviderUpdateRun,
  failProviderUpdateRunStart,
  getProviderUpdatePromptView,
  hasOneClickUpdateProviderCandidate,
  isProviderUpdateCandidate,
  joinProviderUpdateRun,
  providerUpdateNotificationKey,
  shouldOpenProviderUpdatePrompt,
  type ProviderUpdateCandidate,
  type ProviderUpdateRun,
} from "./ProviderUpdateLaunchNotification.logic";

const checkedAt = "2026-04-23T10:00:00.000Z";
const laterCheckedAt = "2026-04-23T10:01:00.000Z";

const driver = (value: string) => ProviderDriverKind.make(value);
const instanceId = (value: string) => ProviderInstanceId.make(value);

function provider(input: {
  readonly driver: ReturnType<typeof ProviderDriverKind.make>;
  readonly instanceId?: ReturnType<typeof ProviderInstanceId.make>;
  readonly enabled?: boolean;
  readonly version?: string | null;
  readonly latestVersion?: string | null;
  readonly canUpdate?: boolean;
  readonly updateCommand?: string | null;
  readonly updateState?: ServerProvider["updateState"];
  readonly installed?: boolean;
  readonly advisoryStatus?: NonNullable<ServerProvider["versionAdvisory"]>["status"];
}): ServerProvider {
  const result: ServerProvider = {
    instanceId: input.instanceId ?? instanceId(String(input.driver)),
    driver: input.driver,
    enabled: input.enabled ?? true,
    installed: input.installed ?? true,
    version: input.version ?? "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: input.advisoryStatus ?? "behind_latest",
      currentVersion: input.version ?? "1.0.0",
      latestVersion: "latestVersion" in input ? input.latestVersion : "1.1.0",
      updateCommand: "updateCommand" in input ? input.updateCommand : "npm install -g provider",
      canUpdate: input.canUpdate ?? true,
      installCommand: null,
      canInstall: false,
      checkedAt,
      message: "Update available.",
    },
  };

  if (input.updateState) {
    return { ...result, updateState: input.updateState };
  }

  return result;
}

function updateCandidate(input: Parameters<typeof provider>[0]): ProviderUpdateCandidate {
  return provider(input) as ProviderUpdateCandidate;
}

describe("provider update launch notification logic", () => {
  it("detects enabled providers with a latest-version advisory", () => {
    expect(isProviderUpdateCandidate(provider({ driver: driver("codex") }))).toBe(true);
    expect(isProviderUpdateCandidate(provider({ driver: driver("codex"), enabled: false }))).toBe(
      false,
    );
    expect(
      isProviderUpdateCandidate(
        provider({ driver: driver("codex"), advisoryStatus: "current", latestVersion: null }),
      ),
    ).toBe(false);
    expect(
      isProviderUpdateCandidate(provider({ driver: driver("codex"), latestVersion: null })),
    ).toBe(false);
  });

  it("deduplicates multi-instance provider candidates by driver", () => {
    expect(
      collectProviderUpdateCandidates([
        provider({
          driver: driver("codex"),
          instanceId: instanceId("codex_personal"),
          latestVersion: "1.1.0",
        }),
        provider({
          driver: driver("codex"),
          instanceId: instanceId("codex"),
          latestVersion: "1.1.0",
        }),
        provider({ driver: driver("cursor"), latestVersion: "0.3.0" }),
      ]),
    ).toHaveLength(2);
  });

  it("treats each community agent as a program of its own", () => {
    const communityAgent = (id: string, name: string) => ({
      ...provider({
        driver: driver("acpRegistry"),
        instanceId: instanceId(`acp_${id}`),
        updateCommand: `Update ${name} (Threadlines downloads it)`,
      }),
      displayName: name,
    });
    const goose = communityAgent("goose", "goose") as ProviderUpdateCandidate;
    const gemini = communityAgent("gemini", "Gemini CLI") as ProviderUpdateCandidate;

    // Two agents on one driver, two updates: neither stands in for the other,
    // and their different commands don't rule out a one-click update.
    expect(collectProviderUpdateCandidates([goose, gemini])).toHaveLength(2);
    expect(canOneClickUpdateProviderCandidate(goose, [goose, gemini])).toBe(true);
    expect(providerUpdateNotificationKey([goose, gemini])).toBe(
      "acpRegistry:acp_gemini:1.1.0|acpRegistry:acp_goose:1.1.0",
    );
    // Named as themselves, not as their driver, and tracked one by one.
    const updatingGemini = {
      ...gemini,
      updateState: {
        status: "running" as const,
        startedAt: checkedAt,
        finishedAt: null,
        message: null,
        output: null,
      },
    };
    const run = advanceProviderUpdateRun(null, "environment-a", [goose, updatingGemini]);
    expect(describeProviderUpdateRun(run!, [goose, updatingGemini]).title).toBe(
      "Updating Gemini CLI",
    );
  });

  it("disables one-click updates when provider instances disagree on the update command", () => {
    const candidate = updateCandidate({
      driver: driver("claudeAgent"),
      instanceId: instanceId("claude_personal"),
      latestVersion: "2.1.123",
    });

    expect(
      canOneClickUpdateProviderCandidate(candidate, [
        candidate,
        provider({
          driver: driver("claudeAgent"),
          instanceId: instanceId("claude_work"),
          latestVersion: "2.1.123",
          canUpdate: true,
          updateCommand: "bun add -g @anthropic-ai/claude-code@latest",
        }),
      ]),
    ).toBe(false);
  });

  it("disables one-click updates for manual-only provider advisories", () => {
    const candidate = updateCandidate({
      driver: driver("claudeAgent"),
      latestVersion: "2.1.185",
      canUpdate: false,
      updateCommand: "manual claude update command",
    });

    expect(isProviderUpdateCandidate(candidate)).toBe(true);
    expect(hasOneClickUpdateProviderCandidate(candidate, [candidate])).toBe(false);
    expect(canOneClickUpdateProviderCandidate(candidate, [candidate])).toBe(false);
  });

  it("keeps one-click updates enabled when sibling instances are already current", () => {
    const candidate = updateCandidate({
      driver: driver("claudeAgent"),
      instanceId: instanceId("claude_personal"),
      latestVersion: "2.1.123",
      updateCommand: "npm install -g @anthropic-ai/claude-code@latest",
    });

    expect(
      hasOneClickUpdateProviderCandidate(candidate, [
        candidate,
        provider({
          driver: driver("claudeAgent"),
          instanceId: instanceId("claude_work"),
          version: "2.1.123",
          latestVersion: "2.1.123",
          advisoryStatus: "current",
          canUpdate: false,
          updateCommand: null,
        }),
      ]),
    ).toBe(true);
    expect(
      canOneClickUpdateProviderCandidate(candidate, [
        candidate,
        provider({
          driver: driver("claudeAgent"),
          instanceId: instanceId("claude_work"),
          version: "2.1.123",
          latestVersion: "2.1.123",
          advisoryStatus: "current",
          canUpdate: false,
          updateCommand: null,
        }),
      ]),
    ).toBe(true);
  });

  it("keeps the inline update action available while a provider update is already running", () => {
    const candidate = updateCandidate({
      driver: driver("codex"),
      updateState: {
        status: "running",
        startedAt: checkedAt,
        finishedAt: null,
        message: "Updating provider.",
        output: null,
      },
    });

    expect(hasOneClickUpdateProviderCandidate(candidate, [candidate])).toBe(true);
    expect(canOneClickUpdateProviderCandidate(candidate, [candidate])).toBe(false);
  });

  it("builds a notification key from provider latest versions", () => {
    const codex = updateCandidate({
      driver: driver("codex"),
      version: "1.0.0",
      latestVersion: "1.1.0",
    });
    const cursor = updateCandidate({
      driver: driver("cursor"),
      version: "0.2.0",
      latestVersion: "0.3.0",
    });

    expect(providerUpdateNotificationKey([codex, cursor])).toBe("codex:1.1.0|cursor:0.3.0");
    expect(providerUpdateNotificationKey([])).toBeNull();
  });

  it("keeps the same notification key while the published update version is unchanged", () => {
    const first = updateCandidate({
      driver: driver("codex"),
      version: "1.0.0",
      latestVersion: "1.2.0",
    });
    const second = updateCandidate({
      driver: driver("codex"),
      version: "1.1.0",
      latestVersion: "1.2.0",
    });
    const nextPublishedVersion = updateCandidate({
      driver: driver("codex"),
      version: "1.1.0",
      latestVersion: "1.3.0",
    });

    expect(providerUpdateNotificationKey([first])).toBe(providerUpdateNotificationKey([second]));
    expect(providerUpdateNotificationKey([nextPublishedVersion])).not.toBe(
      providerUpdateNotificationKey([first]),
    );
  });

  describe("shouldOpenProviderUpdatePrompt", () => {
    const OPENABLE = {
      notificationKey: "codex:1.1.0",
      isDismissed: false,
      isAlreadySeen: false,
      hasActiveToast: false,
      isHeldForSetup: false,
    } as const;

    it("opens on launch when there is an update nobody has been told about", () => {
      expect(shouldOpenProviderUpdatePrompt(OPENABLE)).toBe(true);
      expect(shouldOpenProviderUpdatePrompt({ ...OPENABLE, notificationKey: null })).toBe(false);
      expect(shouldOpenProviderUpdatePrompt({ ...OPENABLE, isDismissed: true })).toBe(false);
      expect(shouldOpenProviderUpdatePrompt({ ...OPENABLE, isAlreadySeen: true })).toBe(false);
      expect(shouldOpenProviderUpdatePrompt({ ...OPENABLE, hasActiveToast: true })).toBe(false);
    });

    it("waits while setup holds launch prompts, then opens once setup is done", () => {
      expect(shouldOpenProviderUpdatePrompt({ ...OPENABLE, isHeldForSetup: true })).toBe(false);
      // Deferred, not dropped: the same key still opens once setup is
      // completed or skipped, because nothing marked it seen while it waited.
      expect(shouldOpenProviderUpdatePrompt({ ...OPENABLE, isHeldForSetup: false })).toBe(true);
    });
  });

  it("describes a single one-click update", () => {
    const codex = updateCandidate({ driver: driver("codex"), latestVersion: "1.1.0" });
    expect(
      getProviderUpdatePromptView({ updateProviders: [codex], oneClickProviders: [codex] }),
    ).toEqual({
      title: "Codex v1.1.0 is available",
      description: "Install it now, or see the details in Settings.",
    });
  });

  it("describes multiple one-click updates without squeezing agent names into the title", () => {
    const codex = updateCandidate({ driver: driver("codex"), latestVersion: "1.1.0" });
    const claude = updateCandidate({ driver: driver("claudeAgent"), latestVersion: "2.1.197" });
    expect(
      getProviderUpdatePromptView({
        updateProviders: [codex, claude],
        oneClickProviders: [codex, claude],
      }),
    ).toEqual({
      title: "Updates available",
      description: "Codex v1.1.0 and Claude v2.1.197 are ready to install.",
    });
  });

  it("describes settings-only updates without one-click support", () => {
    const view = getProviderUpdatePromptView({
      updateProviders: [
        updateCandidate({ driver: driver("codex"), canUpdate: false }),
        updateCandidate({ driver: driver("cursor"), canUpdate: false }),
      ],
      oneClickProviders: [],
    });

    expect(view.description).toBe("Codex v1.1.0 and Cursor v1.1.0 can be updated from Settings.");
  });
});

describe("provider update runs", () => {
  const environmentId = "environment-a";
  const state = (
    status: NonNullable<ServerProvider["updateState"]>["status"],
    input: { readonly at?: string; readonly message?: string } = {},
  ): ServerProvider["updateState"] => ({
    status,
    startedAt: status === "queued" ? null : (input.at ?? checkedAt),
    finishedAt: status === "queued" || status === "running" ? null : (input.at ?? checkedAt),
    message: input.message ?? null,
    output: null,
  });

  it("follows every agent in a run until the last one finishes", () => {
    let run = advanceProviderUpdateRun(null, environmentId, [
      provider({ driver: driver("codex"), updateState: state("running") }),
      provider({ driver: driver("claudeAgent"), updateState: state("queued") }),
    ]);

    // Codex fails while Claude still waits: the run isn't over.
    const midway = [
      provider({
        driver: driver("codex"),
        updateState: state("failed", { message: "npm said no." }),
      }),
      provider({ driver: driver("claudeAgent"), updateState: state("queued") }),
    ];
    run = advanceProviderUpdateRun(run, environmentId, midway);
    const view = describeProviderUpdateRun(run!, midway);
    expect(view).toMatchObject({ phase: "running", title: "Updating Codex and Claude" });
    expect(view.items.map((item) => item.status)).toEqual(["failed", "queued"]);

    const finished = [
      provider({
        driver: driver("codex"),
        updateState: state("failed", { message: "npm said no." }),
      }),
      provider({
        driver: driver("claudeAgent"),
        version: "2.1.230",
        updateState: state("succeeded"),
      }),
    ];
    run = advanceProviderUpdateRun(run, environmentId, finished);
    const result = describeProviderUpdateRun(run!, finished);
    expect(result).toMatchObject({ phase: "failed", title: "Couldn't update Codex" });
    expect(result.items).toEqual([
      {
        key: "codex",
        label: "Codex",
        status: "failed",
        statusLabel: "Failed",
        message: "npm said no.",
      },
      {
        key: "claudeAgent",
        label: "Claude",
        status: "succeeded",
        statusLabel: "v2.1.230",
        message: null,
      },
    ]);
  });

  it("doesn't count a result from before the run, even one the server reports again", () => {
    const before = [
      provider({ driver: driver("codex"), updateState: state("succeeded", { at: checkedAt }) }),
    ];
    let run: ProviderUpdateRun | null = joinProviderUpdateRun(null, environmentId, before, [
      "codex",
    ]);
    expect(describeProviderUpdateRun(run, before).phase).toBe("running");

    // Finished between two snapshots: never seen running, but a new result.
    const after = [
      provider({
        driver: driver("codex"),
        version: "1.1.0",
        updateState: state("succeeded", { at: laterCheckedAt }),
      }),
    ];
    run = advanceProviderUpdateRun(run, environmentId, after);
    expect(describeProviderUpdateRun(run!, after)).toMatchObject({
      phase: "succeeded",
      title: "Codex updated to v1.1.0",
      detail: "New chats use the new version.",
    });
  });

  it("follows the instance being updated, not the group's default one", () => {
    const providers = [
      provider({ driver: driver("codex"), instanceId: instanceId("codex") }),
      provider({
        driver: driver("codex"),
        instanceId: instanceId("codex_work"),
        updateState: state("running"),
      }),
    ];
    const run = advanceProviderUpdateRun(null, environmentId, providers);
    expect(run?.members.map((member) => member.key)).toEqual(["codex"]);
    expect(describeProviderUpdateRun(run!, providers)).toMatchObject({
      phase: "running",
      title: "Updating Codex",
      detail: "Getting v1.1.0.",
    });
  });

  it("keeps the server's reason when an update finishes without a new version", () => {
    const providers = [
      provider({
        driver: driver("claudeAgent"),
        updateState: state("unchanged", {
          message: "Stopped the Claude processes holding the update.",
        }),
      }),
    ];
    const run = joinProviderUpdateRun(
      null,
      environmentId,
      [provider({ driver: driver("claudeAgent") })],
      ["claudeAgent"],
    );
    expect(describeProviderUpdateRun(run, providers)).toMatchObject({
      phase: "unchanged",
      title: "Claude still needs an update",
      detail: "Stopped the Claude processes holding the update.",
    });
  });

  it("fails an agent the server refused to update, and only says so for the request that failed", () => {
    const providers = [provider({ driver: driver("codex") })];
    const run = joinProviderUpdateRun(null, environmentId, providers, ["codex"]);
    const attempt = run.members[0]!.attempt;
    const refusal = { environmentId, key: "codex", message: "Not allowed.", uncertain: false };

    // A late answer to an older request, or one from another computer, changes nothing.
    expect(failProviderUpdateRunStart(run, { ...refusal, attempt: attempt - 1 })).toBe(run);
    expect(
      failProviderUpdateRunStart(run, { ...refusal, attempt, environmentId: "environment-b" }),
    ).toBe(run);

    expect(
      describeProviderUpdateRun(
        failProviderUpdateRunStart(run, { ...refusal, attempt })!,
        providers,
      ),
    ).toMatchObject({ phase: "failed", title: "Couldn't update Codex", detail: "Not allowed." });

    // Asked again before the server reported: only the newer request can settle it.
    const again = joinProviderUpdateRun(run, environmentId, providers, ["codex"]);
    expect(failProviderUpdateRunStart(again, { ...refusal, attempt })).toBe(again);
  });

  it("doesn't call an update failed when the connection dropped before the server answered", () => {
    const providers = [provider({ driver: driver("codex") })];
    const run = joinProviderUpdateRun(null, environmentId, providers, ["codex"]);
    const dropped = failProviderUpdateRunStart(run, {
      environmentId,
      key: "codex",
      attempt: run.members[0]!.attempt,
      message: "Lost the connection to the Threadlines server before it answered.",
      uncertain: true,
    });
    expect(describeProviderUpdateRun(dropped!, providers)).toMatchObject({
      phase: "unchanged",
      title: "Couldn't confirm Codex's update",
    });
  });

  it("doesn't claim a new version when the version didn't change", () => {
    const before = [provider({ driver: driver("codex"), version: "1.0.0" })];
    const run = joinProviderUpdateRun(null, environmentId, before, ["codex"]);
    const after = [
      provider({ driver: driver("codex"), version: "1.0.0", updateState: state("succeeded") }),
    ];
    expect(describeProviderUpdateRun(run, after)).toMatchObject({
      phase: "succeeded",
      title: "Codex update finished",
      detail: "It's on v1.0.0.",
    });
  });

  it("drops a run when the window moves to another computer", () => {
    const providers = [provider({ driver: driver("codex"), updateState: state("running") })];
    const run = advanceProviderUpdateRun(null, environmentId, providers);
    expect(
      advanceProviderUpdateRun(run, "environment-b", [provider({ driver: driver("codex") })]),
    ).toBeNull();
  });
});
