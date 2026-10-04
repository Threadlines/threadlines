/**
 * Ids for child threads (docs/design/child-threads.md), derived rather than
 * random so every retry lands on the same work.
 *
 * A provider can retry a tool call and the server can crash halfway through
 * setting a child up. Both are made safe the same way: the request's ids, the
 * child's thread and message ids, its worktree branch and every command id
 * come from one stable key, so a second attempt finds what the first one
 * left (an existing thread, a command receipt, a worktree on that branch)
 * instead of making another.
 */
import { CommandId } from "@threadlines/contracts";
import { WORKTREE_BRANCH_PREFIX } from "@threadlines/shared/git";
import { createHash } from "node:crypto";

const digest = (parts: ReadonlyArray<string>) =>
  createHash("sha256").update(parts.join("\u0000")).digest("hex");

/**
 * A UUID-shaped id derived from `parts`; the same parts always give the same
 * id. Shaped as an RFC 4122 version 5 UUID so it fits anywhere a random one
 * does (session keys, folder names, logs).
 */
export function derivedUuid(...parts: ReadonlyArray<string>): string {
  const hex = digest(parts);
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

/**
 * The command id for one step of a child request: `start` and `send` (the
 * tool's own command), `create`, `meta`, `setup-*` and `turn` (setting the
 * child up), `settle` (its answer coming back).
 */
export const childRequestCommandId = (id: string, step: string): CommandId =>
  CommandId.make(`server:child-request:${id}:${step}`);

/**
 * The child's worktree branch: the same placeholder shape a new thread gets
 * (`threadlines/<8 hex>`, see buildTemporaryWorktreeBranchName), so the
 * rename by kind after its first turn applies, but fixed by the request so a
 * resumed setup finds the worktree an interrupted one made.
 */
export const childWorktreeBranch = (requestId: string): string =>
  `${WORKTREE_BRANCH_PREFIX}/${digest(["child-worktree", requestId]).slice(0, 8)}`;
