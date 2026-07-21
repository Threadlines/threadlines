import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ServerProvider,
} from "@threadlines/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@threadlines/contracts/settings";
import { createModelCapabilities } from "@threadlines/shared/model";
import { describe, expect, it } from "vite-plus/test";

import type { DraftSessionState } from "../composerDraftStore";
import type { Thread } from "../types";
import { resolveProviderReviewContext } from "./providerReview";

const ENVIRONMENT_ID = EnvironmentId.make("local");
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

function provider(
  driver: "codex" | "claudeAgent",
  model: string,
  instanceId: string = driver,
): ServerProvider {
  const driverKind = ProviderDriverKind.make(driver);
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: driverKind,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-09T00:00:00.000Z",
    models: [
      {
        slug: model,
        name: model,
        isCustom: false,
        capabilities:
          driver === "codex"
            ? createModelCapabilities({
                optionDescriptors: [
                  {
                    id: "reasoningEffort",
                    label: "Reasoning",
                    type: "select",
                    options: [
                      { id: "high", label: "High", isDefault: true },
                      { id: "xhigh", label: "Extra high" },
                    ],
                  },
                ],
              })
            : {},
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

function draftSession(overrides: Partial<DraftSessionState> = {}): DraftSessionState {
  return {
    threadId: THREAD_ID,
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    logicalProjectKey: "local:project-1",
    createdAt: "2026-07-09T00:00:00.000Z",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    envMode: "local",
    promotedTo: null,
    ...overrides,
  };
}

function serverThread(input: {
  provider: "codex" | "claudeAgent";
  status?: "connecting" | "ready" | "running";
}): Thread {
  const provider = ProviderDriverKind.make(input.provider);
  const instanceId = ProviderInstanceId.make(input.provider);
  return {
    id: THREAD_ID,
    environmentId: ENVIRONMENT_ID,
    codexThreadId: null,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: {
      instanceId,
      model: input.provider === "codex" ? "gpt-5.6-sol" : "claude-sonnet-4-6",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: {
      provider,
      providerInstanceId: instanceId,
      status: input.status ?? "ready",
      ...(input.status === "running" ? { activeTurnId: TurnId.make("turn-1") } : {}),
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
      orchestrationStatus:
        input.status === "running"
          ? "running"
          : input.status === "connecting"
            ? "starting"
            : "ready",
    },
    messages: [],
    error: null,
    createdAt: "2026-07-09T00:00:00.000Z",
    archivedAt: null,
    pinnedAt: null,
    latestTurn: null,
    branch: "main",
    worktreePath: null,
    effectiveCwd: null,
    goal: null,
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
  };
}

const providers = [provider("codex", "gpt-5.6-sol"), provider("claudeAgent", "claude-sonnet-4-6")];

describe("resolveProviderReviewContext", () => {
  it("preserves a new draft's selected Codex model and execution context", () => {
    const context = resolveProviderReviewContext({
      thread: undefined,
      draftSession: draftSession({ runtimeMode: "approval-required" }),
      composerDraft: {
        activeProvider: ProviderInstanceId.make("codex"),
        modelSelectionByProvider: {
          [ProviderInstanceId.make("codex")]: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6-sol",
            options: [{ id: "reasoningEffort", value: "xhigh" }],
          },
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
      },
      project: { defaultModelSelection: null },
      providers,
      settings: DEFAULT_UNIFIED_SETTINGS,
    });

    expect(context.unavailableReason).toBeNull();
    expect(context.modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "xhigh" }],
    });
    expect(context.bootstrap).toEqual({
      projectId: PROJECT_ID,
      modelSelection: context.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
    });
  });

  it("preselects Codex for a new draft whose composer is currently using Claude", () => {
    const context = resolveProviderReviewContext({
      thread: undefined,
      draftSession: draftSession(),
      composerDraft: {
        activeProvider: ProviderInstanceId.make("claudeAgent"),
        modelSelectionByProvider: {
          [ProviderInstanceId.make("claudeAgent")]: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
        },
        runtimeMode: null,
        interactionMode: null,
      },
      project: { defaultModelSelection: null },
      providers,
      settings: DEFAULT_UNIFIED_SETTINGS,
    });

    expect(context.unavailableReason).toBeNull();
    expect(context.providerDriver).toBe("codex");
    expect(context.modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(context.bootstrap?.modelSelection).toEqual(context.modelSelection);
  });

  it("uses a fresh Codex context without changing an existing Claude session", () => {
    const context = resolveProviderReviewContext({
      thread: serverThread({ provider: "claudeAgent" }),
      draftSession: null,
      composerDraft: {
        activeProvider: ProviderInstanceId.make("codex"),
        modelSelectionByProvider: {},
        runtimeMode: null,
        interactionMode: null,
      },
      project: { defaultModelSelection: null },
      providers,
      settings: DEFAULT_UNIFIED_SETTINGS,
    });

    expect(context.providerDriver).toBe("codex");
    expect(context.modelSelection.instanceId).toBe("codex");
    expect(context.bootstrap).toMatchObject({
      projectId: PROJECT_ID,
      modelSelection: context.modelSelection,
      branch: "main",
    });
    expect(context.unavailableReason).toBeNull();
  });

  it("prefers the composer's selected Codex instance over the source session", () => {
    const personalInstanceId = ProviderInstanceId.make("codex_personal");
    const context = resolveProviderReviewContext({
      thread: serverThread({ provider: "codex" }),
      draftSession: null,
      composerDraft: {
        activeProvider: personalInstanceId,
        modelSelectionByProvider: {
          [personalInstanceId]: {
            instanceId: personalInstanceId,
            model: "gpt-5.6-sol",
            options: [{ id: "reasoningEffort", value: "xhigh" }],
          },
        },
        runtimeMode: null,
        interactionMode: null,
      },
      project: { defaultModelSelection: null },
      providers: [
        provider("codex", "gpt-5.6-sol"),
        provider("codex", "gpt-5.6-sol", "codex_personal"),
      ],
      settings: DEFAULT_UNIFIED_SETTINGS,
    });

    expect(context.modelSelection).toEqual({
      instanceId: personalInstanceId,
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "xhigh" }],
    });
  });

  it("uses Codex when an unstarted source thread has a Claude model", () => {
    const thread = serverThread({ provider: "claudeAgent" });
    const context = resolveProviderReviewContext({
      thread: { ...thread, session: null },
      draftSession: null,
      composerDraft: null,
      project: { defaultModelSelection: null },
      providers,
      settings: DEFAULT_UNIFIED_SETTINGS,
    });

    expect(context.providerDriver).toBe("codex");
    expect(context.modelSelection.instanceId).toBe("codex");
    expect(context.unavailableReason).toBeNull();
  });

  it.each(["running", "connecting"] as const)(
    "does not block on a %s source session because the review uses a new thread",
    (status) => {
      const context = resolveProviderReviewContext({
        thread: serverThread({ provider: "codex", status }),
        draftSession: null,
        composerDraft: null,
        project: { defaultModelSelection: null },
        providers,
        settings: DEFAULT_UNIFIED_SETTINGS,
      });

      expect(context.unavailableReason).toBeNull();
      expect(context.bootstrap).not.toBeNull();
    },
  );

  it("does not block on background tasks in the source session", () => {
    const thread = serverThread({ provider: "codex" });
    const context = resolveProviderReviewContext({
      thread: {
        ...thread,
        session: thread.session ? { ...thread.session, pendingBackgroundTaskCount: 1 } : null,
      },
      draftSession: null,
      composerDraft: null,
      project: { defaultModelSelection: null },
      providers,
      settings: DEFAULT_UNIFIED_SETTINGS,
    });

    expect(context.unavailableReason).toBeNull();
    expect(context.bootstrap).not.toBeNull();
  });

  it("explains when no Codex provider is configured", () => {
    const context = resolveProviderReviewContext({
      thread: serverThread({ provider: "claudeAgent" }),
      draftSession: null,
      composerDraft: null,
      project: { defaultModelSelection: null },
      providers: [provider("claudeAgent", "claude-sonnet-4-6")],
      settings: DEFAULT_UNIFIED_SETTINGS,
    });

    expect(context.providerDriver).toBeNull();
    expect(context.providerInstanceEntries).toEqual([]);
    expect(context.unavailableReason).toBe("No Codex provider is configured.");
  });
});
