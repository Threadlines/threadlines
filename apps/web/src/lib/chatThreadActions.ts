import { scopeProjectRef } from "@threadlines/client-runtime";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@threadlines/contracts";
import type { DraftThreadEnvMode } from "../composerDraftStore";

interface ThreadContextLike {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  branch: string | null;
  worktreePath: string | null;
}

interface DraftThreadContextLike extends ThreadContextLike {
  envMode: DraftThreadEnvMode;
}

interface NewThreadHandler {
  (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
      continueActiveCheckout?: boolean;
    },
  ): Promise<void>;
}

export interface ChatThreadActionContext {
  readonly activeDraftThread: DraftThreadContextLike | null;
  readonly activeThread: ThreadContextLike | undefined;
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly handleNewThread: NewThreadHandler;
}

/** Where a new thread starts: its checkout, and the branch that goes with it. */
export interface NewThreadPlacement {
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly envMode: DraftThreadEnvMode;
}

/**
 * Where a new thread in `projectRef` starts when its caller did not pin it:
 * the computer's "Start in" setting (Settings › Threads), read by
 * `useNewThreadState` for every new-thread surface.
 *
 * "New worktree" always wins, so every new thread gets its own. Under "Local"
 * a thread started from one in the same project continues in that thread's
 * checkout, which keeps work in a worktree there, unless
 * `continueActiveCheckout` is off or that checkout is known to be gone (one
 * deleted worktree must not spread to every thread started from it). A draft
 * has a checkout to continue only once it points at a worktree: "New
 * worktree" picked on one draft is for that thread, not the next. The result
 * is always whole, so a reused draft never keeps where it was last pointed.
 */
export function resolveNewThreadPlacement(input: {
  readonly projectRef: ScopedProjectRef;
  readonly startIn: DraftThreadEnvMode;
  /** General chats run in per-thread scratch directories, never a worktree. */
  readonly isGeneralChat: boolean;
  readonly continueActiveCheckout: boolean;
  readonly activeThread: ThreadContextLike | null | undefined;
  readonly activeDraftThread: DraftThreadContextLike | null | undefined;
  /** Whether the client already knows this checkout was deleted. */
  readonly isCheckoutMissing: (cwd: string) => boolean;
}): NewThreadPlacement {
  if (input.isGeneralChat) {
    return { branch: null, worktreePath: null, envMode: "local" };
  }
  const projectRoot: NewThreadPlacement = {
    branch: null,
    worktreePath: null,
    envMode: input.startIn,
  };
  if (input.startIn === "worktree" || !input.continueActiveCheckout) {
    return projectRoot;
  }
  const canContinue = (thread: ThreadContextLike | null | undefined): thread is ThreadContextLike =>
    thread != null &&
    thread.environmentId === input.projectRef.environmentId &&
    thread.projectId === input.projectRef.projectId &&
    !(thread.worktreePath !== null && input.isCheckoutMissing(thread.worktreePath));
  if (canContinue(input.activeDraftThread) && input.activeDraftThread.worktreePath !== null) {
    return {
      branch: input.activeDraftThread.branch,
      worktreePath: input.activeDraftThread.worktreePath,
      envMode: input.activeDraftThread.envMode,
    };
  }
  if (canContinue(input.activeThread)) {
    return {
      branch: input.activeThread.branch,
      worktreePath: input.activeThread.worktreePath,
      envMode: input.activeThread.worktreePath ? "worktree" : "local",
    };
  }
  return projectRoot;
}

export function resolveThreadActionProjectRef(
  context: ChatThreadActionContext,
): ScopedProjectRef | null {
  if (context.activeThread) {
    return scopeProjectRef(context.activeThread.environmentId, context.activeThread.projectId);
  }
  if (context.activeDraftThread) {
    return scopeProjectRef(
      context.activeDraftThread.environmentId,
      context.activeDraftThread.projectId,
    );
  }
  return context.defaultProjectRef;
}

/** General Chats never seed branch/worktree context; they always run in
    per-thread scratch directories in local mode. */
export async function startNewGeneralChatThread(
  handleNewThread: NewThreadHandler,
  generalChatsRef: ScopedProjectRef,
): Promise<void> {
  await handleNewThread(generalChatsRef, { branch: null, worktreePath: null, envMode: "local" });
}

export async function startNewThreadInProjectFromContext(
  context: ChatThreadActionContext,
  projectRef: ScopedProjectRef,
): Promise<void> {
  await context.handleNewThread(projectRef);
}

export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  await startNewThreadInProjectFromContext(context, projectRef);
  return true;
}

/** A new thread from the "Start in" setting alone: it never continues the
    checkout of the thread on screen. */
export async function startNewLocalThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return false;
  }

  await context.handleNewThread(projectRef, { continueActiveCheckout: false });
  return true;
}
