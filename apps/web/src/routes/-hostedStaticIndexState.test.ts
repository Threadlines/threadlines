import { EnvironmentId } from "@threadlines/contracts";
import { describe, expect, it } from "vitest";

import type { SavedEnvironmentRuntimeState } from "../environments/runtime";
import type { EnvironmentState } from "../store";
import { deriveHostedStaticIndexState } from "./-hostedStaticIndexState";

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
