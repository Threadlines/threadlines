import * as Base64Url from "effect/encoding/Base64Url";
import { CheckpointRef, type ProjectId, type ThreadId, type TurnId } from "@threadlines/contracts";

import { CHECKPOINT_REFS_PREFIX } from "../vcs/checkpointRefs.ts";

export { CHECKPOINT_REFS_PREFIX };

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(threadId)}/turn/${turnCount}`,
  );
}

export function checkpointPreTurnRefForThreadTurn(
  threadId: ThreadId,
  turnId: TurnId,
): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(threadId)}/pre-turn/${Base64Url.encode(turnId)}`,
  );
}

export function checkpointPreTurnRefForThreadTurnCount(
  threadId: ThreadId,
  turnCount: number,
): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(threadId)}/pre-turn-count/${turnCount}`,
  );
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}
