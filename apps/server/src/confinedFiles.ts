/**
 * Reading and writing one file that must stay inside a folder, when the path
 * came from somewhere we do not control (an agent, a provider's report).
 *
 * A check on the path and a later open of it can see two different files: a
 * folder can be swapped for a link in between. So a read opens the file
 * without following a link at its last step, then checks that what it opened
 * is a regular file with one name, the same file the path names, still inside
 * the folder. A write never opens the target at all: it writes a temporary
 * file the folder alone can see, then links or renames it into place, which
 * create or replace the folder's entry without following it.
 */
import { randomUUID } from "node:crypto";
import { constants as NodeFsConstants, type Stats } from "node:fs";
import * as NodeFs from "node:fs/promises";
import NodePath from "node:path";

/** Refuses to follow a symlink at the last step, where the platform can (not Windows). */
const OPEN_READ_NO_FOLLOW = NodeFsConstants.O_RDONLY | (NodeFsConstants.O_NOFOLLOW ?? 0);
const OPEN_CREATE_NO_FOLLOW =
  NodeFsConstants.O_WRONLY |
  NodeFsConstants.O_CREAT |
  NodeFsConstants.O_EXCL |
  (NodeFsConstants.O_NOFOLLOW ?? 0);

export type ConfinedReadRefusal = "missing" | "outside" | "not-a-file" | "too-large";

export type ConfinedReadResult =
  | { readonly bytes: Uint8Array }
  | { readonly refused: ConfinedReadRefusal; readonly size?: number };

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + NodePath.sep);
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * The bytes of `path`, if it is a regular file with one name inside `root`
 * and at most `maxBytes` long. `root` may itself be a link (macOS `/tmp`);
 * what counts is where it really is.
 */
export async function readConfinedFile(input: {
  readonly root: string;
  readonly path: string;
  readonly maxBytes: number;
}): Promise<ConfinedReadResult> {
  const root = await NodeFs.realpath(input.root).catch(() => null);
  if (root === null) return { refused: "missing" };
  const requested = NodePath.resolve(input.path);
  const real = await NodeFs.realpath(requested).catch(() => null);
  if (real === null) return { refused: "missing" };
  if (!inside(root, real)) return { refused: "outside" };
  const linkInfo = await NodeFs.lstat(requested).catch(() => null);
  if (linkInfo === null || !linkInfo.isFile() || linkInfo.nlink !== 1) {
    return { refused: "not-a-file" };
  }
  if (linkInfo.size > input.maxBytes) return { refused: "too-large", size: linkInfo.size };
  const handle = await NodeFs.open(requested, OPEN_READ_NO_FOLLOW).catch(() => null);
  if (handle === null) return { refused: "not-a-file" };
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(opened, linkInfo)) {
      return { refused: "not-a-file" };
    }
    // The path's own folders may have moved while it was opened.
    const realAfter = await NodeFs.realpath(requested).catch(() => null);
    const infoAfter = realAfter === null ? null : await NodeFs.lstat(realAfter).catch(() => null);
    if (
      realAfter === null ||
      !inside(root, realAfter) ||
      infoAfter === null ||
      !sameFile(infoAfter, opened)
    ) {
      return { refused: "outside" };
    }
    const bytes = new Uint8Array(await handle.readFile());
    if (bytes.byteLength > input.maxBytes) {
      return { refused: "too-large", size: bytes.byteLength };
    }
    return { bytes };
  } finally {
    await handle.close();
  }
}

export type ConfinedWriteOutcome = "written" | "exists";

/**
 * Writes `contents` as `name` in `directory`, which must already exist. A
 * name with a path separator or `..` is refused. Without `overwrite` an
 * existing entry is left alone (`exists`); with it, an entry that is a link is
 * still refused rather than replaced or written through.
 */
export async function writeConfinedFile(input: {
  readonly directory: string;
  readonly name: string;
  readonly contents: string;
  readonly overwrite: boolean;
}): Promise<ConfinedWriteOutcome> {
  if (
    input.name.length === 0 ||
    input.name === "." ||
    input.name === ".." ||
    input.name.includes("/") ||
    input.name.includes("\\") ||
    input.name.includes("\0")
  ) {
    throw new Error(`Refusing to write a file named '${input.name}'.`);
  }
  const target = NodePath.join(input.directory, input.name);
  const existing = await NodeFs.lstat(target).catch(() => null);
  if (existing !== null) {
    if (!input.overwrite) return "exists";
    if (!existing.isFile()) {
      throw new Error(`${target} is not a regular file; it was left alone.`);
    }
  }
  const temp = NodePath.join(input.directory, `.${input.name}.${randomUUID()}.tmp`);
  const handle = await NodeFs.open(temp, OPEN_CREATE_NO_FOLLOW, 0o644);
  try {
    await handle.writeFile(input.contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (input.overwrite) {
      await NodeFs.rename(temp, target);
    } else {
      // link() fails on an existing entry instead of replacing it.
      try {
        await NodeFs.link(temp, target);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "EEXIST") return "exists";
        throw cause;
      }
    }
    return "written";
  } finally {
    await NodeFs.rm(temp, { force: true });
  }
}
