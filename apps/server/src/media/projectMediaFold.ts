/**
 * Folds turn summary rows into the Media tab's entries: one per file a
 * thread's turns created or changed, as it stands after the thread's last
 * turn that touched it. Pure, so the rules are tested apart from SQL and git.
 */
import { classifyMediaPath, type MediaKind } from "@threadlines/shared/media";

/** One file of one checkpointed turn, as the listing query reads it. */
export interface ProjectMediaTurnFileRow {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly cwd: string;
  readonly turnId: string;
  readonly checkpointTurnCount: number;
  readonly changedAt: string;
  readonly assistantMessageId: string | null;
  readonly path: string;
  readonly kind: string;
  readonly previousPath: string | null;
}

export interface FoldedThreadMedia {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly cwd: string;
  /** Repository-root-relative, as the turn's patch named it. */
  readonly path: string;
  readonly mediaKind: MediaKind;
  readonly added: boolean;
  readonly turnId: string;
  readonly checkpointTurnCount: number;
  readonly changedAt: string;
  readonly assistantMessageId: string | null;
}

/**
 * Rows must come grouped by thread and, within a thread, in turn order. Per
 * thread and path: the latest turn wins; `added` holds when the first turn
 * that touched the path in this thread created it (a rename carries its
 * source's); a delete drops the path until a later turn writes it again.
 */
export function foldProjectMediaRows(
  rows: Iterable<ProjectMediaTurnFileRow>,
): ReadonlyArray<FoldedThreadMedia> {
  const folded: FoldedThreadMedia[] = [];
  let threadId: string | null = null;
  let byPath = new Map<string, FoldedThreadMedia>();
  const flush = () => {
    folded.push(...byPath.values());
    byPath = new Map();
  };
  for (const row of rows) {
    if (row.threadId !== threadId) {
      flush();
      threadId = row.threadId;
    }
    const path = row.path.replaceAll("\\", "/");
    let renamedFrom: FoldedThreadMedia | undefined;
    if (row.previousPath !== null) {
      const previousPath = row.previousPath.replaceAll("\\", "/");
      renamedFrom = byPath.get(previousPath);
      byPath.delete(previousPath);
    }
    if (row.kind === "delete") {
      byPath.delete(path);
      continue;
    }
    const mediaKind = classifyMediaPath(path);
    if (mediaKind === null) {
      // Renamed to something that is not media: the old entry is gone, and
      // nothing takes its place.
      byPath.delete(path);
      continue;
    }
    const existing = byPath.get(path);
    byPath.set(path, {
      threadId: row.threadId,
      threadTitle: row.threadTitle,
      cwd: row.cwd,
      path,
      mediaKind,
      added: existing?.added ?? renamedFrom?.added ?? row.kind === "add",
      turnId: row.turnId,
      checkpointTurnCount: row.checkpointTurnCount,
      changedAt: row.changedAt,
      assistantMessageId: row.assistantMessageId,
    });
  }
  flush();
  return folded;
}

/**
 * The path inside `cwd` for a repository-root-relative one, given where `cwd`
 * sits in its repository (`cwdPrefix`, "" at the root). Null for a path
 * outside `cwd`, which the Media tab does not list.
 */
export function pathInsideFolder(repositoryPath: string, cwdPrefix: string): string | null {
  if (cwdPrefix.length === 0) {
    return repositoryPath;
  }
  const prefix = `${cwdPrefix}/`;
  return repositoryPath.startsWith(prefix) ? repositoryPath.slice(prefix.length) : null;
}
