/**
 * General Chats - hidden system project support.
 *
 * General Chats are project-independent threads backed by a hidden
 * `general-chat` kind project whose workspace lives under the Threadlines
 * state directory. Each thread runs in its own scratch cwd so providers get
 * an explicit, isolated working directory instead of falling back to
 * `process.cwd()`, and no two General Chats share files implicitly.
 *
 * @module generalChats
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  CommandId,
  ProjectId,
  type OrchestrationProjectShell,
  type ThreadId,
} from "@threadlines/contracts";

import { ServerConfig } from "../config.ts";
import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

/**
 * Stable id for the hidden system project. A well-known id lets clients start
 * General Chat threads without a discovery round-trip and keeps the ensure
 * step idempotent across restarts.
 */
export const GENERAL_CHATS_PROJECT_ID = ProjectId.make("project-general-chats");
export const GENERAL_CHATS_PROJECT_TITLE = "General Chats";
const GENERAL_CHATS_DIR_NAME = "general-chats";
const GENERAL_CHATS_THREADS_DIR_NAME = "threads";

type PathJoin = Pick<Path.Path, "join">;

export function generalChatsWorkspaceRoot(stateDir: string, path: PathJoin): string {
  return path.join(stateDir, GENERAL_CHATS_DIR_NAME);
}

export function generalChatThreadScratchCwd(
  workspaceRoot: string,
  threadId: ThreadId,
  path: PathJoin,
): string {
  return path.join(workspaceRoot, GENERAL_CHATS_THREADS_DIR_NAME, threadId);
}

/**
 * Resolve the provider cwd for a thread.
 *
 * Workspace projects use the worktree path or workspace root; general-chat
 * projects use a per-thread scratch directory so chats stay isolated.
 */
export function resolveThreadProviderCwd(input: {
  readonly thread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly project: Pick<OrchestrationProjectShell, "id" | "kind" | "workspaceRoot"> | undefined;
  readonly path: PathJoin;
}): string | undefined {
  if (input.project?.kind === "general-chat") {
    return generalChatThreadScratchCwd(input.project.workspaceRoot, input.thread.id, input.path);
  }
  return resolveThreadWorkspaceCwd({
    thread: input.thread,
    projects: input.project ? [input.project] : [],
  });
}

/**
 * Idempotently ensure the hidden General Chats project exists.
 *
 * Creates the backing state directory and dispatches `project.create` with
 * `kind: "general-chat"` when missing. Safe to run on every startup; a lost
 * race against a concurrent create surfaces as an invariant failure which is
 * resolved by re-reading the projection.
 */
export const ensureGeneralChatsProject = Effect.fn("ensureGeneralChatsProject")(function* () {
  const serverConfig = yield* ServerConfig;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const existing = yield* projectionSnapshotQuery.getProjectShellById(GENERAL_CHATS_PROJECT_ID);
  if (Option.isSome(existing)) {
    return existing.value.id;
  }

  const workspaceRoot = generalChatsWorkspaceRoot(serverConfig.stateDir, path);
  yield* fileSystem.makeDirectory(workspaceRoot, { recursive: true });
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  yield* orchestrationEngine
    .dispatch({
      type: "project.create",
      commandId: CommandId.make(crypto.randomUUID()),
      projectId: GENERAL_CHATS_PROJECT_ID,
      kind: "general-chat",
      title: GENERAL_CHATS_PROJECT_TITLE,
      workspaceRoot,
      defaultModelSelection: null,
      createdAt,
    })
    .pipe(
      Effect.catchIf(
        (error) => error._tag === "OrchestrationCommandInvariantError",
        () => Effect.void,
      ),
    );
  return GENERAL_CHATS_PROJECT_ID;
});

/**
 * Ensure the per-thread scratch directory exists before a provider session
 * starts in it.
 */
export const ensureGeneralChatThreadScratchCwd = Effect.fn("ensureGeneralChatThreadScratchCwd")(
  function* (input: { readonly workspaceRoot: string; readonly threadId: ThreadId }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scratchCwd = generalChatThreadScratchCwd(input.workspaceRoot, input.threadId, path);
    yield* fileSystem.makeDirectory(scratchCwd, { recursive: true });
    return scratchCwd;
  },
);
