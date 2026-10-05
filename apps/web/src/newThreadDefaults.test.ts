import { scopeProjectRef } from "@threadlines/client-runtime";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
  type ServerSettings,
  ThreadId,
  ThreadParticipantId,
} from "@threadlines/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "./composerDraftStore";
import { useSavedEnvironmentRuntimeStore } from "./environments/runtime";
import { deriveDisplayProviderInstanceEntries } from "./providerInstances";
import {
  applyMovedDraftDefaults,
  applyNewThreadDefaultsToDraft,
  buildNewThreadParticipants,
  placeDraftFromSettings,
  readComputerConfig,
  resolveNewThreadDefaults,
} from "./newThreadDefaults";
import { resetServerStateForTests, setServerConfigSnapshot } from "./rpc/serverState";

const CLAUDE = ProviderInstanceId.make("claudeAgent");
const CODEX = ProviderInstanceId.make("codex");

function provider(input: {
  driver: string;
  instanceId: ProviderInstanceId;
  enabled?: boolean;
  models?: ReadonlyArray<{ slug: string; name: string }>;
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: ProviderDriverKind.make(input.driver),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-04T00:00:00.000Z",
    models: (input.models ?? []).map((model) => ({
      ...model,
      isCustom: false,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  };
}

const providers = [
  provider({
    driver: "claudeAgent",
    instanceId: CLAUDE,
    models: [{ slug: "claude-opus-5-5", name: "Opus 5.5" }],
  }),
  provider({
    driver: "codex",
    instanceId: CODEX,
    models: [{ slug: "gpt-6-astra", name: "GPT-6 Astra" }],
  }),
];

const opus = { instanceId: CLAUDE, model: "claude-opus-5-5" };
const astra = { instanceId: CODEX, model: "gpt-6-astra" };

describe("resolveNewThreadDefaults", () => {
  it("keeps only what can run on the computer, and no agents while Rooms is off", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      newThreadModelSelection: opus,
      newThreadRoomAgents: [{ modelSelection: astra, role: "Reviewer" }],
    };
    expect(resolveNewThreadDefaults({ settings, providers })).toEqual({
      modelSelection: opus,
      roomAgents: [{ modelSelection: astra, role: "Reviewer" }],
    });

    // Codex turned off: the agent on it is left out, the Claude default stays.
    const codexOff = [providers[0]!, { ...providers[1]!, enabled: false }];
    expect(resolveNewThreadDefaults({ settings, providers: codexOff }).roomAgents).toEqual([]);

    // Claude gone from the computer: back to the device's last used.
    expect(
      resolveNewThreadDefaults({ settings, providers: [providers[1]!] }).modelSelection,
    ).toBeNull();

    expect(
      resolveNewThreadDefaults({ settings: { ...settings, enableRooms: false }, providers })
        .roomAgents,
    ).toEqual([]);
  });

  it("trusts the defaults while the computer's providers are not known yet", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      newThreadModelSelection: opus,
      newThreadRoomAgents: [{ modelSelection: astra }],
    };
    expect(resolveNewThreadDefaults({ settings, providers: [] })).toEqual({
      modelSelection: opus,
      roomAgents: [{ modelSelection: astra }],
    });
  });
});

describe("buildNewThreadParticipants", () => {
  it("names agents like the model picker does, numbered past the thread's own agent", () => {
    let next = 0;
    const ids = [
      "7a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c21",
      "7a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c22",
      "7a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c23",
    ];
    const participants = buildNewThreadParticipants({
      agents: [
        { modelSelection: opus, role: "Reviewer" },
        { modelSelection: astra },
        { modelSelection: astra },
      ],
      primaryModelSelection: opus,
      instanceEntries: deriveDisplayProviderInstanceEntries(providers),
      newId: () => ThreadParticipantId.make(ids[next++]!),
    });
    expect(participants).toEqual([
      { id: ids[0], handle: "Opus 5.5 2", modelSelection: opus, role: "Reviewer" },
      { id: ids[1], handle: "GPT-6 Astra", modelSelection: astra },
      { id: ids[2], handle: "GPT-6 Astra 2", modelSelection: astra },
    ]);
  });
});

function computerConfig(
  environmentId: EnvironmentId,
  settings: Partial<ServerSettings> = {},
): ServerConfig {
  return {
    environment: { environmentId },
    providers,
    settings: { ...DEFAULT_SERVER_SETTINGS, ...settings },
  } as unknown as ServerConfig;
}

describe("new thread defaults on a draft", () => {
  const laptop = EnvironmentId.make("environment-laptop");
  const desktop = EnvironmentId.make("environment-desktop");
  const studio = EnvironmentId.make("environment-studio");
  const projectId = ProjectId.make("project-shared");
  const draftId = DraftId.make("draft-moving");

  beforeEach(() => {
    resetServerStateForTests();
    useSavedEnvironmentRuntimeStore.getState().reset();
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
  });

  // On a phone the app-wide config is whichever paired computer is on screen.
  it("reads the settings of the draft's own computer, never the one on screen", () => {
    setServerConfigSnapshot(computerConfig(laptop));
    expect(readComputerConfig(desktop)).toBeNull();
    expect(readComputerConfig(laptop)?.environment.environmentId).toBe(laptop);

    useSavedEnvironmentRuntimeStore
      .getState()
      .patch(desktop, { serverConfig: computerConfig(desktop) });
    expect(readComputerConfig(desktop)?.environment.environmentId).toBe(desktop);
  });

  it("ignores a computer's settings that arrive after the draft moved on", async () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(scopeProjectRef(desktop, projectId), draftId, {
      threadId: ThreadId.make("thread-moving"),
    });
    // The desktop's settings have not arrived yet: this one waits.
    const desktopRequest = applyNewThreadDefaultsToDraft(draftId, desktop);

    store.setDraftThreadContext(draftId, { projectRef: scopeProjectRef(studio, projectId) });
    useSavedEnvironmentRuntimeStore.getState().patch(studio, {
      serverConfig: computerConfig(studio, { newThreadModelSelection: astra }),
    });
    await applyNewThreadDefaultsToDraft(draftId, studio);

    useSavedEnvironmentRuntimeStore.getState().patch(desktop, {
      serverConfig: computerConfig(desktop, {
        newThreadModelSelection: opus,
        newThreadRoomAgents: [{ modelSelection: astra }],
      }),
    });
    await desktopRequest;

    const draft = useComposerDraftStore.getState().getComposerDraft(draftId);
    expect(draft?.activeProvider).toBe(CODEX);
    expect(draft?.modelSelectionByProvider[CODEX]).toEqual(astra);
    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.room).toBeUndefined();
  });
  it("never lets late settings override a draft the user has started on", async () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(scopeProjectRef(desktop, projectId), draftId, {
      threadId: ThreadId.make("thread-late"),
    });
    const request = applyNewThreadDefaultsToDraft(draftId, desktop);
    // The draft is open meanwhile, and the user picks a model.
    store.setModelSelection(draftId, astra);

    useSavedEnvironmentRuntimeStore.getState().patch(desktop, {
      serverConfig: computerConfig(desktop, {
        newThreadModelSelection: opus,
        newThreadRoomAgents: [{ modelSelection: astra }],
      }),
    });
    await request;

    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.activeProvider).toBe(CODEX);
    expect(useComposerDraftStore.getState().getDraftThread(draftId)?.room).toBeUndefined();
  });

  // The first new thread at startup opens before its computer's settings.
  it("places a draft that opened early where the computer's Start in says", () => {
    const store = useComposerDraftStore.getState();
    const openEarly = (draft: DraftId, computer: EnvironmentId) => {
      store.setProjectDraftThreadId(scopeProjectRef(computer, projectId), draft, {
        threadId: ThreadId.make(`thread-${draft}`),
        envMode: "local",
      });
      placeDraftFromSettings(draft, computer, (startIn) => ({
        branch: null,
        worktreePath: null,
        envMode: startIn,
      }));
    };
    const session = (draft: DraftId) => useComposerDraftStore.getState().getDraftSession(draft);
    openEarly(draftId, desktop);
    // On this one the user picks a branch before the settings come.
    const pickedId = DraftId.make("draft-picked");
    openEarly(pickedId, studio);
    store.setDraftThreadContext(pickedId, { branch: "release" });
    expect(session(draftId)?.envMode).toBe("local");

    for (const computer of [desktop, studio]) {
      useSavedEnvironmentRuntimeStore.getState().patch(computer, {
        serverConfig: computerConfig(computer, { defaultThreadEnvMode: "worktree" }),
      });
    }

    expect(session(draftId)?.envMode).toBe("worktree");
    expect(session(pickedId)).toMatchObject({ branch: "release", envMode: "local" });
  });

  it("gives a moved draft the new computer's model and Start in, unless the user picked a model", async () => {
    const store = useComposerDraftStore.getState();
    useSavedEnvironmentRuntimeStore.getState().patch(desktop, {
      serverConfig: computerConfig(desktop),
    });
    useSavedEnvironmentRuntimeStore.getState().patch(studio, {
      serverConfig: computerConfig(studio, {
        newThreadModelSelection: opus,
        defaultThreadEnvMode: "worktree",
      }),
    });
    store.setStickyModelSelection(astra);
    store.setProjectDraftThreadId(scopeProjectRef(desktop, projectId), draftId, {
      threadId: ThreadId.make("thread-moved"),
    });
    // Last used on the desktop: the draft starts on Astra without the user picking it.
    await applyNewThreadDefaultsToDraft(draftId, desktop);
    const draft = () => useComposerDraftStore.getState().getComposerDraft(draftId);
    expect(draft()?.activeProvider).toBe(CODEX);

    store.setDraftThreadContext(draftId, { projectRef: scopeProjectRef(studio, projectId) });
    await applyMovedDraftDefaults(draftId, studio);
    expect(draft()?.activeProvider).toBe(CLAUDE);
    // The studio's Start in comes with the move too.
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.envMode).toBe("worktree");

    store.setModelSelection(draftId, astra);
    store.setDraftThreadContext(draftId, { projectRef: scopeProjectRef(desktop, projectId) });
    store.setDraftThreadContext(draftId, { projectRef: scopeProjectRef(studio, projectId) });
    await applyMovedDraftDefaults(draftId, studio);
    expect(draft()?.activeProvider).toBe(CODEX);
  });
  it("keeps the last used model for a draft written in before the computer's settings came", async () => {
    const store = useComposerDraftStore.getState();
    store.setStickyModelSelection(opus);
    store.setProjectDraftThreadId(scopeProjectRef(desktop, projectId), draftId, {
      threadId: ThreadId.make("thread-early"),
    });
    const request = applyNewThreadDefaultsToDraft(draftId, desktop);
    store.setPrompt(draftId, "fix the flaky test");

    useSavedEnvironmentRuntimeStore.getState().patch(desktop, {
      serverConfig: computerConfig(desktop, { newThreadModelSelection: astra }),
    });
    await request;

    const draft = useComposerDraftStore.getState().getComposerDraft(draftId);
    expect(draft?.activeProvider).toBe(CLAUDE);
    expect(draft?.modelSelectionByProvider[CLAUDE]).toEqual(opus);
  });
});
