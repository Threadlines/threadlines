import { EnvironmentId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SavedEnvironmentRuntimeState } from "../environments/runtime";
import type { EnvironmentState } from "../store";
import { deriveChatIndexState, deriveHostedStaticIndexState } from "./-chatIndexState";

const environmentId = EnvironmentId.make("environment-1");

function savedEnvironment(label = "Will's Mac") {
  return {
    environmentId,
    label,
  };
}

function runtime(input: Partial<SavedEnvironmentRuntimeState> = {}): SavedEnvironmentRuntimeState {
  return {
    connectionState: "disconnected",
    authState: "unknown",
    lastError: null,
    lastErrorAt: null,
    role: null,
    descriptor: null,
    serverConfig: null,
    connectedAt: null,
    disconnectedAt: null,
    ...input,
  };
}

function environmentState(bootstrapComplete: boolean): EnvironmentState {
  return {
    projectIds: [],
    projectById: {},
    threadIds: [],
    threadIdsByProjectId: {},
    threadShellById: {},
    threadSessionById: {},
    threadTurnStateById: {},
    messageIdsByThreadId: {},
    messageByThreadId: {},
    activityIdsByThreadId: {},
    activityByThreadId: {},
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
    sidebarThreadSummaryById: {},
    bootstrapComplete,
  };
}

describe("deriveHostedStaticIndexState", () => {
  it("shows onboarding before a phone browser has any saved desktop", () => {
    expect(
      deriveHostedStaticIndexState({
        savedEnvironments: [],
        savedEnvironmentRuntimeById: {},
        environmentStateById: {},
        projectCount: 0,
      }),
    ).toEqual({ kind: "unpaired" });
  });

  it("shows loading while a saved desktop has not delivered its shell snapshot", () => {
    expect(
      deriveHostedStaticIndexState({
        savedEnvironments: [savedEnvironment()],
        savedEnvironmentRuntimeById: {
          [environmentId]: runtime({ connectionState: "connected" }),
        },
        environmentStateById: {},
        projectCount: 0,
      }),
    ).toEqual({ kind: "loading", label: "Will's Mac" });
  });

  it("surfaces saved desktop connection failures before the generic empty state", () => {
    expect(
      deriveHostedStaticIndexState({
        savedEnvironments: [savedEnvironment()],
        savedEnvironmentRuntimeById: {
          [environmentId]: runtime({
            connectionState: "error",
            lastError: "Relay session closed.",
          }),
        },
        environmentStateById: {},
        projectCount: 0,
      }),
    ).toEqual({
      kind: "connection-error",
      label: "Will's Mac",
      message: "Relay session closed.",
    });
  });

  it("allows the normal empty state once an empty desktop snapshot is bootstrapped", () => {
    expect(
      deriveHostedStaticIndexState({
        savedEnvironments: [savedEnvironment()],
        savedEnvironmentRuntimeById: {
          [environmentId]: runtime({ connectionState: "connected" }),
        },
        environmentStateById: {
          [environmentId]: environmentState(true),
        },
        projectCount: 0,
      }),
    ).toEqual({ kind: "ready" });
  });

  it("uses the normal app once any projects are available", () => {
    expect(
      deriveHostedStaticIndexState({
        savedEnvironments: [savedEnvironment()],
        savedEnvironmentRuntimeById: {},
        environmentStateById: {},
        projectCount: 1,
      }),
    ).toEqual({ kind: "ready" });
  });
});

describe("deriveChatIndexState", () => {
  const directlyPairedInput = {
    hostedStatic: false,
    savedEnvironments: [],
    savedEnvironmentRuntimeById: {},
    environmentStateById: {},
    projectCount: 0,
  } as const;

  it("waits for the first workspace snapshot instead of showing a directly paired device an empty app", () => {
    expect(deriveChatIndexState({ ...directlyPairedInput, bootstrapComplete: false })).toEqual({
      kind: "workspace-loading",
    });
  });

  it("shows the normal app to a directly paired device once its snapshot arrives, even with no projects", () => {
    expect(deriveChatIndexState({ ...directlyPairedInput, bootstrapComplete: true })).toEqual({
      kind: "ready",
    });
  });

  it("keeps using the saved-desktop rules for the hosted app", () => {
    expect(
      deriveChatIndexState({
        hostedStatic: true,
        // The hosted app has no primary environment of its own, so its snapshot
        // flag must not decide anything here.
        bootstrapComplete: true,
        savedEnvironments: [],
        savedEnvironmentRuntimeById: {},
        environmentStateById: {},
        projectCount: 0,
      }),
    ).toEqual({ kind: "unpaired" });
  });
});
