import { scopeProjectRef } from "@threadlines/client-runtime";
import { EnvironmentId, ProjectId } from "@threadlines/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  resolveNewThreadPlacement,
  resolveThreadActionProjectRef,
  startNewLocalThreadFromContext,
  startNewThreadFromContext,
  type ChatThreadActionContext,
} from "./chatThreadActions";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const FALLBACK_PROJECT_ID = ProjectId.make("project-2");

function createContext(overrides: Partial<ChatThreadActionContext> = {}): ChatThreadActionContext {
  return {
    activeDraftThread: null,
    activeThread: undefined,
    defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID),
    handleNewThread: async () => {},
    ...overrides,
  };
}

describe("chatThreadActions", () => {
  it("prefers the active draft thread project when resolving thread actions", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        activeDraftThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          branch: "feature/refactor",
          worktreePath: "/tmp/worktree",
          envMode: "worktree",
        },
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("falls back to the default project ref when there is no active thread context", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("starts a local thread from the setting alone", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewLocalThreadFromContext(
      createContext({
        defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
        handleNewThread,
      }),
    );

    expect(didStart).toBe(true);
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), {
      continueActiveCheckout: false,
    });
  });

  it("does not start a thread when there is no project context", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewThreadFromContext(
      createContext({
        defaultProjectRef: null,
        handleNewThread,
      }),
    );

    expect(didStart).toBe(false);
    expect(handleNewThread).not.toHaveBeenCalled();
  });
});

describe("resolveNewThreadPlacement", () => {
  const projectRef = scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID);
  const worktreeThread = {
    environmentId: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    branch: "feature/existing",
    worktreePath: "/repo/.threadlines/worktrees/existing",
  };
  const base = {
    projectRef,
    startIn: "local",
    isGeneralChat: false,
    continueActiveCheckout: true,
    activeThread: null,
    activeDraftThread: null,
    isCheckoutMissing: () => false,
  } as const;
  const projectRoot = (envMode: "local" | "worktree") => ({
    branch: null,
    worktreePath: null,
    envMode,
  });

  it("gives every new thread its own worktree when Start in is New worktree", () => {
    expect(
      resolveNewThreadPlacement({
        ...base,
        startIn: "worktree",
        activeThread: { ...worktreeThread, worktreePath: null },
        activeDraftThread: { ...worktreeThread, envMode: "local" },
      }),
    ).toEqual(projectRoot("worktree"));
  });

  it("continues in the active thread's checkout under Local", () => {
    expect(resolveNewThreadPlacement({ ...base, activeThread: worktreeThread })).toEqual({
      branch: "feature/existing",
      worktreePath: "/repo/.threadlines/worktrees/existing",
      envMode: "worktree",
    });
    expect(
      resolveNewThreadPlacement({
        ...base,
        activeThread: { ...worktreeThread, branch: "effect-atom", worktreePath: null },
      }),
    ).toEqual({ branch: "effect-atom", worktreePath: null, envMode: "local" });
  });

  it("prefers the active draft's place over the thread it sits on", () => {
    expect(
      resolveNewThreadPlacement({
        ...base,
        activeThread: { ...worktreeThread, worktreePath: null },
        activeDraftThread: {
          ...worktreeThread,
          branch: "feature/new-draft",
          worktreePath: "/repo/worktree",
          envMode: "worktree",
        },
      }),
    ).toEqual({
      branch: "feature/new-draft",
      worktreePath: "/repo/worktree",
      envMode: "worktree",
    });
  });

  it("starts at the project root when the active thread is somewhere else", () => {
    // Another project, and the same project id on another computer.
    for (const activeThread of [
      { ...worktreeThread, projectId: FALLBACK_PROJECT_ID },
      { ...worktreeThread, environmentId: EnvironmentId.make("environment-2") },
    ]) {
      expect(resolveNewThreadPlacement({ ...base, activeThread })).toEqual(projectRoot("local"));
    }
  });

  // "It just uses whatever I picked last": a pick is for that one thread.
  it("does not carry a draft's New worktree pick over to the next thread", () => {
    expect(
      resolveNewThreadPlacement({
        ...base,
        activeDraftThread: { ...worktreeThread, worktreePath: null, envMode: "worktree" },
      }),
    ).toEqual(projectRoot("local"));
  });

  // One deleted worktree must not spread to every thread started from it.
  it("starts at the project root instead of continuing a checkout that is gone", () => {
    expect(
      resolveNewThreadPlacement({
        ...base,
        activeThread: worktreeThread,
        activeDraftThread: { ...worktreeThread, envMode: "worktree" },
        isCheckoutMissing: (cwd) => cwd === worktreeThread.worktreePath,
      }),
    ).toEqual(projectRoot("local"));
  });

  it("starts from the setting alone when asked not to continue", () => {
    expect(
      resolveNewThreadPlacement({
        ...base,
        continueActiveCheckout: false,
        activeThread: worktreeThread,
      }),
    ).toEqual(projectRoot("local"));
  });

  it("never puts a general chat in a worktree", () => {
    expect(
      resolveNewThreadPlacement({
        ...base,
        startIn: "worktree",
        isGeneralChat: true,
        activeThread: worktreeThread,
      }),
    ).toEqual(projectRoot("local"));
  });
});
