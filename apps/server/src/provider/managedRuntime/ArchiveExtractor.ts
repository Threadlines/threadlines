// @effect-diagnostics nodeBuiltinImport:off - reads archives and writes their files
/**
 * ArchiveExtractor — unpacks a downloaded zip, tar.gz or tar.bz2 into a new
 * folder, in process, under one policy. The archive is somebody else's:
 * nothing in it is trusted to stay inside that folder.
 *
 * Three passes:
 * 1. Read every entry header and decide before a byte is written
 *    (`planArchive`).
 * 2. Write folders and regular files. No link exists yet, so nothing can be
 *    written through one.
 * 3. Copy hard links and create symbolic links.
 *
 * Rules that only matter on some systems apply only there: Windows' reserved
 * names and characters on Windows, names that differ only by case or Unicode
 * form on Windows and macOS. A Linux archive may hold `Makefile` beside
 * `makefile`, and a file named `aux.c`.
 *
 * @module provider/managedRuntime/ArchiveExtractor
 */
import { once } from "node:events";
import { constants as FsConstants, createReadStream, createWriteStream } from "node:fs";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import * as Data from "effect/Data";
import { Parser, type ReadEntry } from "tar";
import unbzip2 from "unbzip2-stream";
import yauzl from "yauzl";

export type ArchiveKind = "zip" | "tar.gz" | "tar.bz2";

export type ArchiveErrorReason =
  /** Not a readable archive of its kind, or one that changed while it was read. */
  | "format"
  /** An entry the policy refuses. */
  | "unsafe"
  /** Past the byte or entry budget. */
  | "tooLarge";

export class ArchiveError extends Data.TaggedError("ArchiveError")<{
  readonly reason: ArchiveErrorReason;
  /** What was wrong, naming the entry. For logs and for the install's error detail. */
  readonly message: string;
  readonly cause?: unknown;
}> {}

const archiveError = (reason: ArchiveErrorReason, message: string, cause?: unknown) =>
  new ArchiveError(cause === undefined ? { reason, message } : { reason, message, cause });

export interface ArchiveLimits {
  /** Total size of the files written. */
  readonly maxBytes: number;
  readonly maxEntries: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxBytes: 4 * 1024 ** 3,
  maxEntries: 100_000,
};

/** One archive entry as its header describes it, before any policy. */
export interface ArchiveEntryHeader {
  /** The path as the archive spells it, `/`-separated. */
  readonly path: string;
  readonly type: "file" | "directory" | "symlink" | "hardlink" | "other";
  /** What an `other` entry is, for the error. */
  readonly typeLabel?: string;
  /** Unix permission bits, when the archive records them. */
  readonly mode?: number;
  readonly size: number;
  /** Where a link points, as the archive spells it. */
  readonly linkTarget?: string;
}

export interface ArchivePlanOptions extends ArchiveLimits {
  readonly platform: NodeJS.Platform;
  /** Leading path components to drop (an archive that wraps everything in one folder). */
  readonly stripComponents: number;
}

/** What to write, in order. Paths are relative to the output folder and `/`-separated. */
export interface ArchivePlan {
  /** Parents first. */
  readonly directories: ReadonlyArray<string>;
  /** Regular files, by the index of their entry in the archive. */
  readonly files: ReadonlyMap<
    number,
    { readonly path: string; readonly mode: number; readonly size: number }
  >;
  /** Hard links, written as copies of a file from `files`. */
  readonly copies: ReadonlyArray<{
    readonly path: string;
    readonly from: string;
    readonly mode: number;
  }>;
  readonly symlinks: ReadonlyArray<{
    readonly path: string;
    readonly target: string;
    readonly pointsAtDirectory: boolean;
  }>;
  readonly totalBytes: number;
}

const DIRECTORY_MODE = 0o755;
const MAX_LINK_TARGET_BYTES = 4096;
/**
 * Longest entry path or link target accepted, in UTF-16 units. Longer than
 * macOS can create at all, and it bounds what one header can cost: a path
 * of a million `a/` would otherwise be a million folders.
 */
const MAX_NAME_LENGTH = 1024;
/** Decompressed tar bytes allowed per entry on top of file contents: headers, padding, long names. */
const TAR_OVERHEAD_PER_ENTRY = 4096;
/** Tar bytes handed to the parser at a time: at most this many headers' worth of new files. */
const TAR_FEED_BYTES = 16 * 1024;
/** Files allowed to be open (written, or still closing) before the tar walk waits. */
const MAX_OPEN_FILES = 32;
/** Filesystem lookups the link check may spend on one archive. */
const LINK_CHECK_STEP_BUDGET = 1_000_000;

const WINDOWS_FORBIDDEN_CHARACTERS = /[<>:"|?*]/u;
const hasControlCharacter = (name: string) =>
  Array.from(name).some((character) => character.charCodeAt(0) < 0x20);
const WINDOWS_DEVICE_NAME =
  /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9\u00b9\u00b2\u00b3])(?:\.|$)/iu;
/** Code points HFS+ leaves out when it compares names. */
const HFS_IGNORED_CHARACTERS = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu;

/**
 * A name as a case-insensitive filesystem compares it, erring towards
 * "same": every pair of names such a filesystem treats as one maps to one
 * key here, and a few it keeps apart do too. Upper-then-lower case reaches
 * what lowercasing alone misses (`\u017f` is `s`, `\u00df` is `ss`).
 */
function foldName(name: string): string {
  let folded = name.normalize("NFD").replace(HFS_IGNORED_CHARACTERS, "");
  for (let round = 0; round < 3; round += 1) {
    const next = folded.toUpperCase().toLowerCase();
    if (next === folded) break;
    folded = next;
  }
  return folded.normalize("NFD");
}

const foldsNames = (platform: NodeJS.Platform) => platform === "win32" || platform === "darwin";

/** Keeps owner read/write, drops group and other write, setuid, setgid and sticky. */
const fileMode = (mode: number | undefined) =>
  mode === undefined ? 0o644 : (mode & 0o755) | 0o600;

/**
 * The components of an entry's path, or an `unsafe` error: no absolute
 * paths, `..`, NUL or backslashes anywhere, nothing Windows can't name when
 * unpacking there, and nothing a name-folding filesystem would read as `.`
 * or `..`.
 */
function entryPathComponents(raw: string, platform: NodeJS.Platform): Array<string> {
  const refuse = (why: string) => archiveError("unsafe", `Entry "${raw.slice(0, 200)}" ${why}.`);
  if (raw.length > MAX_NAME_LENGTH) {
    throw refuse(`has a path longer than ${MAX_NAME_LENGTH} characters`);
  }
  if (raw.includes("\u0000")) throw refuse("has a NUL in its name");
  if (raw.includes("\\")) throw refuse("has a backslash in its name");
  if (raw.startsWith("/")) throw refuse("is an absolute path");
  const components: Array<string> = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw refuse("points outside the archive");
    if (platform === "win32") {
      if (WINDOWS_FORBIDDEN_CHARACTERS.test(part) || hasControlCharacter(part)) {
        throw refuse("has a character Windows doesn't allow in names");
      }
      if (/[. ]$/u.test(part)) throw refuse("has a name that ends in a dot or a space");
      if (WINDOWS_DEVICE_NAME.test(part)) throw refuse("uses a name Windows reserves for a device");
    }
    if (foldsNames(platform)) {
      const folded = foldName(part);
      if (folded === "" || folded === "." || folded === "..") {
        throw refuse("has a name this system reads as the folder itself or its parent");
      }
    }
    components.push(part);
  }
  return components;
}

/** What the plan knows sits at one path. */
interface PlanNode {
  readonly kind: "directory" | "file" | "symlink" | "hardlink";
  readonly name: string;
  /** Relative to the output folder, `/`-separated; empty for the folder itself. */
  readonly path: string;
  readonly parent: PlanNode | undefined;
  /** A folder's entries, by name as the filesystem compares names. */
  readonly children: Map<string, PlanNode> | undefined;
  /** A file's size. */
  readonly size: number;
}

/**
 * Pass 1: decides what an archive's entries become, or throws an
 * `ArchiveError` that names the first one the policy refuses.
 *
 * - Files, folders, symbolic links, and hard links to a file earlier in the
 *   archive. Anything else (devices, FIFOs, sparse files) is refused.
 * - No two entries share a destination, and no entry sits under a file or
 *   a link.
 * - A symbolic link's target, resolved from its own folder by its text
 *   alone, stays inside the output folder and passes through no other link.
 */
export function planArchive(
  headers: ReadonlyArray<ArchiveEntryHeader>,
  options: ArchivePlanOptions,
): ArchivePlan {
  if (headers.length > options.maxEntries) {
    throw archiveError(
      "tooLarge",
      `The archive has ${headers.length} entries; at most ${options.maxEntries} are allowed.`,
    );
  }
  const keyOf = foldsNames(options.platform) ? foldName : (name: string) => name;
  const root: PlanNode = {
    kind: "directory",
    name: "",
    path: "",
    parent: undefined,
    children: new Map(),
    size: 0,
  };
  const directories: Array<string> = [];
  const files = new Map<number, { path: string; mode: number; size: number }>();
  const copies: Array<{ path: string; from: string; mode: number }> = [];
  const links: Array<{ node: PlanNode; target: string }> = [];
  let totalBytes = 0;
  let nodeCount = 0;

  const addBytes = (size: number) => {
    totalBytes += size;
    if (totalBytes > options.maxBytes) {
      throw archiveError("tooLarge", `The archive unpacks to more than ${options.maxBytes} bytes.`);
    }
  };

  /** Every file, link and folder counts, the folders a path only implies included. */
  const addNode = (parent: PlanNode, name: string, kind: PlanNode["kind"], size = 0): PlanNode => {
    nodeCount += 1;
    if (nodeCount > options.maxEntries) {
      throw archiveError(
        "tooLarge",
        `The archive holds more than ${options.maxEntries} files and folders.`,
      );
    }
    const node: PlanNode = {
      kind,
      name,
      path: parent.path === "" ? name : `${parent.path}/${name}`,
      parent,
      children: kind === "directory" ? new Map() : undefined,
      size,
    };
    parent.children?.set(keyOf(name), node);
    return node;
  };

  const collision = (existing: PlanNode, name: string) =>
    archiveError(
      "unsafe",
      `Entries "${existing.path}" and "${existing.parent?.path ? `${existing.parent.path}/` : ""}${name}" differ only by case or Unicode form.`,
    );

  /** The folder at `components`, creating what is missing; everything on the way must be a real folder. */
  const directoryAt = (components: ReadonlyArray<string>, entryPath: string): PlanNode => {
    let current = root;
    for (const name of components) {
      const existing = current.children?.get(keyOf(name));
      if (!existing) {
        current = addNode(current, name, "directory");
        directories.push(current.path);
      } else if (existing.kind !== "directory") {
        throw archiveError(
          "unsafe",
          `Entry "${entryPath}" needs "${existing.path}" to be a folder, and the archive has it as something else.`,
        );
      } else if (existing.name !== name) {
        throw collision(existing, name);
      } else {
        current = existing;
      }
    }
    return current;
  };

  /** Claims a destination nothing else names. */
  const claim = (
    components: ReadonlyArray<string>,
    kind: PlanNode["kind"],
    entryPath: string,
    size = 0,
  ): PlanNode => {
    const parent = directoryAt(components.slice(0, -1), entryPath);
    const name = components[components.length - 1]!;
    const existing = parent.children?.get(keyOf(name));
    if (existing) {
      throw existing.name === name
        ? archiveError("unsafe", `Entry "${existing.path}" appears more than once.`)
        : collision(existing, name);
    }
    return addNode(parent, name, kind, size);
  };

  const find = (components: ReadonlyArray<string>): PlanNode | undefined => {
    let current: PlanNode | undefined = root;
    for (const name of components) {
      current = current.children?.get(keyOf(name));
      if (!current || current.name !== name) return undefined;
    }
    return current;
  };

  headers.forEach((header, index) => {
    const components = entryPathComponents(header.path, options.platform).slice(
      options.stripComponents,
    );
    if (components.length === 0) {
      // The archive's own root, or what `stripComponents` drops.
      if (header.type === "directory" || options.stripComponents > 0) return;
      throw archiveError("unsafe", `Entry "${header.path}" has no name.`);
    }
    switch (header.type) {
      case "directory":
        directoryAt(components, header.path);
        return;
      case "file": {
        addBytes(header.size);
        const node = claim(components, "file", header.path, header.size);
        files.set(index, { path: node.path, mode: fileMode(header.mode), size: header.size });
        return;
      }
      case "hardlink": {
        const from = find(
          entryPathComponents(header.linkTarget ?? "", options.platform).slice(
            options.stripComponents,
          ),
        );
        if (!from || from.kind !== "file") {
          throw archiveError(
            "unsafe",
            `Hard link "${header.path}" doesn't point at a file earlier in the archive.`,
          );
        }
        addBytes(from.size);
        const node = claim(components, "hardlink", header.path);
        copies.push({ path: node.path, from: from.path, mode: fileMode(header.mode) });
        return;
      }
      case "symlink":
        links.push({
          node: claim(components, "symlink", header.path),
          target: header.linkTarget ?? "",
        });
        return;
      default:
        throw archiveError(
          "unsafe",
          `Entry "${header.path}" is a ${header.typeLabel ?? "special file"}, which can't be unpacked.`,
        );
    }
  });

  // Links are judged against the whole archive: a later entry may be the
  // link another one's target passes through.
  const symlinks = links.map(({ node, target }) => {
    const refuse = (why: string) =>
      archiveError("unsafe", `Link "${node.path}" (to "${target.slice(0, 200)}") ${why}.`);
    if (target === "" || target.includes("\u0000")) throw refuse("has no usable target");
    if (target.length > MAX_NAME_LENGTH) {
      throw refuse(`has a target longer than ${MAX_NAME_LENGTH} characters`);
    }
    if (target.includes("\\")) throw refuse("has a backslash in its target");
    if (target.startsWith("/") || /^[A-Za-z]:/u.test(target)) {
      throw refuse("points at an absolute path");
    }
    const parts = target.split("/").filter((part) => part !== "" && part !== ".");
    // Where the target leads, by its text alone: the last thing on the way
    // that the archive holds, and how many names past it.
    let current = node.parent ?? root;
    let beyond = 0;
    parts.forEach((part, position) => {
      if (part === "..") {
        if (beyond > 0) {
          beyond -= 1;
        } else if (current.parent) {
          current = current.parent;
        } else {
          throw refuse("points outside the archive");
        }
        return;
      }
      const next = beyond === 0 ? current.children?.get(keyOf(part)) : undefined;
      if (!next) {
        beyond += 1;
        return;
      }
      if (next.kind === "symlink" && position < parts.length - 1) {
        throw refuse(`passes through another link, "${next.path}"`);
      }
      current = next;
    });
    return {
      path: node.path,
      target: parts.length === 0 ? "." : parts.join("/"),
      pointsAtDirectory: beyond === 0 && current.kind === "directory",
    };
  });

  return { directories, files, copies, symlinks, totalBytes };
}

const nativePath = (outDir: string, path: string) => NodePath.join(outDir, ...path.split("/"));

async function writeDirectories(outDir: string, plan: ArchivePlan): Promise<void> {
  for (const directory of plan.directories) {
    await NodeFS.mkdir(nativePath(outDir, directory), { mode: DIRECTORY_MODE });
  }
}

/** Pass 3. Every file is written by now, and every parent is a folder pass 2 made. */
async function writeLinks(
  outDir: string,
  plan: ArchivePlan,
  platform: NodeJS.Platform,
  signal: AbortSignal,
) {
  for (const copy of plan.copies) {
    signal.throwIfAborted();
    const target = nativePath(outDir, copy.path);
    await NodeFS.copyFile(nativePath(outDir, copy.from), target, FsConstants.COPYFILE_EXCL);
    if (platform !== "win32") await NodeFS.chmod(target, copy.mode);
  }
  for (const link of plan.symlinks) {
    signal.throwIfAborted();
    await NodeFS.symlink(
      link.target.split("/").join(NodePath.sep),
      nativePath(outDir, link.path),
      link.pointsAtDirectory ? "dir" : "file",
    );
  }
  await assertLinksStayInside(outDir, plan, signal);
}

/**
 * The plan judged each link by its text. This asks the filesystem, which
 * may treat two names as one where the plan did not: every link is followed
 * as far as it leads to something that exists, and none of that may be
 * outside `outDir`. Nothing has run from the folder yet; a link that fails
 * here fails the archive.
 */
export async function assertLinksStayInside(
  outDir: string,
  plan: Pick<ArchivePlan, "symlinks">,
  signal: AbortSignal,
) {
  if (plan.symlinks.length === 0) return;
  const root = await NodeFS.realpath(outDir);
  const inside = (path: string) => path === root || path.startsWith(`${root}${NodePath.sep}`);
  let steps = 0;
  for (const link of plan.symlinks) {
    signal.throwIfAborted();
    const escaped = () =>
      archiveError("unsafe", `Link "${link.path}" leads outside the folder it was unpacked into.`);
    // The link's own folder is one pass 2 made.
    let current = NodePath.dirname(nativePath(root, link.path));
    for (const part of link.target.split("/")) {
      steps += 1;
      if (steps > LINK_CHECK_STEP_BUDGET) {
        throw archiveError("tooLarge", "The archive's links take too long to check.");
      }
      if (part === ".") continue;
      if (part === "..") {
        current = NodePath.dirname(current);
        if (!inside(current)) throw escaped();
        continue;
      }
      const next = NodePath.join(current, part);
      const stats = await NodeFS.lstat(next).catch(() => undefined);
      // Nothing there: the rest of the target has nothing to follow.
      if (!stats) break;
      if (!stats.isSymbolicLink()) {
        current = next;
        continue;
      }
      // A link that leads nowhere (or in a circle) can't be followed further.
      const real = await NodeFS.realpath(next).catch(() => undefined);
      if (real === undefined) break;
      if (!inside(real)) throw escaped();
      current = real;
    }
  }
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const DOS_DIRECTORY_ATTRIBUTE = 0x10;
const ZIP_UNIX_HOSTS = new Set([3, 19]);

async function readSmallStream(stream: AsyncIterable<Buffer>, maxBytes: number): Promise<Buffer> {
  const chunks: Array<Buffer> = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) throw archiveError("unsafe", "A link's target is too long.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function zipEntryHeader(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<ArchiveEntryHeader> {
  const unixMode = ZIP_UNIX_HOSTS.has(entry.versionMadeBy >>> 8)
    ? entry.externalFileAttributes >>> 16
    : 0;
  const format = unixMode & S_IFMT;
  const mode = (unixMode & 0o777) === 0 ? undefined : unixMode & 0o777;
  const base = { path: entry.fileName, size: entry.uncompressedSize };
  if (
    entry.fileName.endsWith("/") ||
    format === S_IFDIR ||
    (entry.externalFileAttributes & DOS_DIRECTORY_ATTRIBUTE) !== 0
  ) {
    return { ...base, type: "directory", size: 0 };
  }
  if (format !== 0 && format !== S_IFREG && format !== S_IFLNK) {
    return { ...base, type: "other", typeLabel: "device or other special file" };
  }
  if (entry.isEncrypted()) {
    throw archiveError("format", `Entry "${entry.fileName}" is encrypted.`);
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw archiveError(
      "format",
      `Entry "${entry.fileName}" uses compression method ${entry.compressionMethod}.`,
    );
  }
  if (format !== S_IFLNK) return { ...base, type: "file", ...(mode === undefined ? {} : { mode }) };
  if (entry.uncompressedSize > MAX_LINK_TARGET_BYTES) {
    throw archiveError("unsafe", `Link "${entry.fileName}" has a target that is too long.`);
  }
  const target = await readSmallStream(
    await zip.openReadStreamPromise(entry),
    MAX_LINK_TARGET_BYTES,
  );
  return { ...base, type: "symlink", size: 0, linkTarget: target.toString("utf8") };
}

async function extractZip(input: Required<Omit<ExtractArchiveInput, "kind">>) {
  const { outDir, signal, platform } = input;
  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.openPromise(input.archivePath, {
      autoClose: false,
      lazyEntries: true,
      validateEntrySizes: true,
    });
  } catch (cause) {
    throw archiveError("format", "The download isn't a readable zip.", cause);
  }
  try {
    if (zip.entryCount > input.limits.maxEntries) {
      throw archiveError(
        "tooLarge",
        `The archive has ${zip.entryCount} entries; at most ${input.limits.maxEntries} are allowed.`,
      );
    }
    const entries: Array<yauzl.Entry> = [];
    const headers: Array<ArchiveEntryHeader> = [];
    try {
      for await (const entry of zip.eachEntry()) {
        signal.throwIfAborted();
        entries.push(entry);
        headers.push(await zipEntryHeader(zip, entry));
      }
    } catch (cause) {
      if (cause instanceof ArchiveError || signal.aborted) throw cause;
      // yauzl refuses these names itself, before an entry is handed over.
      const escapes = cause instanceof Error && /relative path|absolute path/iu.test(cause.message);
      throw escapes
        ? archiveError("unsafe", `An entry points outside the archive (${cause.message}).`, cause)
        : archiveError("format", "The zip's list of entries couldn't be read.", cause);
    }
    const plan = planArchive(headers, {
      ...input.limits,
      platform,
      stripComponents: input.stripComponents,
    });

    await writeDirectories(outDir, plan);
    for (const [index, file] of plan.files) {
      const target = nativePath(outDir, file.path);
      const source = await zip.openReadStreamPromise(entries[index]!).catch((cause: unknown) => {
        throw archiveError("format", `Entry "${file.path}" couldn't be read.`, cause);
      });
      await pipeline(
        source,
        async function* (chunks: AsyncIterable<Buffer>) {
          try {
            for await (const chunk of chunks) yield chunk;
          } catch (cause) {
            throw archiveError("format", `Entry "${file.path}" is corrupt.`, cause);
          }
        },
        createWriteStream(target, { flags: "wx", mode: file.mode }),
        { signal },
      );
      if (platform !== "win32") await NodeFS.chmod(target, file.mode);
    }
    await writeLinks(outDir, plan, platform, signal);
    return { entries: headers.length, bytes: plan.totalBytes };
  } finally {
    zip.close();
  }
}

function tarEntryHeader(entry: ReadEntry): ArchiveEntryHeader {
  const base = {
    path: entry.path,
    size: entry.size,
    ...(entry.mode === undefined ? {} : { mode: entry.mode & 0o777 }),
  };
  // GNU tar stores a sparse file under this name in the pax format; its
  // contents are a map, not the file.
  if (/(?:^|\/)GNUSparseFile\.\d+\//u.test(entry.path)) {
    return { ...base, type: "other", typeLabel: "sparse file" };
  }
  switch (entry.type) {
    case "File":
    case "OldFile":
    case "ContiguousFile":
      return { ...base, type: "file" };
    case "Directory":
      return { ...base, type: "directory", size: 0 };
    case "SymbolicLink":
      return { ...base, type: "symlink", size: 0, linkTarget: entry.linkpath ?? "" };
    case "Link":
      return { ...base, type: "hardlink", size: 0, linkTarget: entry.linkpath ?? "" };
    default:
      return { ...base, type: "other", typeLabel: entry.type };
  }
}

/** A tar on disk: gzipped as downloaded, or already plain. */
interface TarSource {
  readonly path: string;
  readonly compression: "gzip" | "none";
}

/** The source's tar stream, and a way to stop reading it. */
function openTarStream(source: TarSource) {
  const file = createReadStream(source.path);
  if (source.compression === "none")
    return { stream: file as Readable, close: () => file.destroy() };
  const stream = file.pipe(createGunzip());
  file.on("error", (cause) => stream.destroy(cause));
  return {
    stream: stream as Readable,
    close: () => {
      file.destroy();
      stream.destroy();
    },
  };
}

const asError = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)));

/**
 * Decodes a tar.bz2 into the plain tar at `tarPath`, stopping at `maxBytes`.
 * Done once, up front: the decoder is plain JavaScript and slow, and the tar
 * is read twice.
 */
async function decodeBzip2(
  archivePath: string,
  tarPath: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<void> {
  const file = createReadStream(archivePath);
  // An old-style stream. Piped on, it ends the way a modern one does; its
  // errors have to be passed along by hand.
  const decoder = unbzip2();
  const decoded = file.pipe(decoder).pipe(new PassThrough());
  decoder.on("error", (cause: unknown) => decoded.destroy(asError(cause)));
  file.on("error", (cause) => decoded.destroy(cause));
  let bytes = 0;
  try {
    await pipeline(
      decoded,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            throw archiveError("tooLarge", `The archive unpacks to more than ${maxBytes} bytes.`);
          }
          yield chunk;
        }
      },
      createWriteStream(tarPath, { flags: "wx", mode: 0o600 }),
      { signal },
    );
  } catch (cause) {
    if (cause instanceof ArchiveError || signal.aborted) throw cause;
    throw archiveError("format", "The download couldn't be decompressed.", cause);
  } finally {
    file.destroy();
  }
}

/**
 * Feeds the decompressed archive through the tar parser, one entry at a
 * time, and waits for `onEntry`'s work on each to finish. Fails on the first
 * invalid header, an entry type the parser skips (a sparse file), or a
 * stream that runs past `maxStreamBytes`.
 */
async function walkTar(input: {
  readonly source: TarSource;
  readonly signal: AbortSignal;
  readonly maxStreamBytes: number;
  /**
   * Must consume `entry` (pipe it or `resume()` it). The promise is awaited
   * before the walk ends, and must settle once `stopped` aborts (the walk
   * failed or was cancelled).
   */
  readonly onEntry: (entry: ReadEntry, index: number, stopped: AbortSignal) => Promise<void> | void;
}): Promise<void> {
  // Aborted on the first failure, so nothing keeps waiting on a stream that
  // will never drain.
  const failed = new AbortController();
  let failure: unknown;
  const fail = (cause: unknown) => {
    if (failure !== undefined) return;
    failure = cause;
    failed.abort();
  };
  const signal = AbortSignal.any([input.signal, failed.signal]);
  // What `onEntry` started and hasn't finished: files being written or closed.
  const work = new Set<Promise<void>>();
  let index = 0;
  const parser = new Parser({
    strict: true,
    // What arrives here is already plain tar.
    zstd: false,
    onReadEntry: (entry) => {
      const entryIndex = index;
      index += 1;
      try {
        const result = input.onEntry(entry, entryIndex, signal);
        if (result) {
          const tracked: Promise<void> = result.catch(fail).finally(() => work.delete(tracked));
          work.add(tracked);
        }
      } catch (cause) {
        entry.resume();
        fail(cause);
      }
    },
  });
  parser.on("ignoredEntry", (entry: ReadEntry) => {
    fail(
      archiveError("unsafe", `Entry "${entry.path}" is a ${entry.type}, which can't be unpacked.`),
    );
  });
  parser.on("error", (cause: unknown) => {
    fail(archiveError("format", "The download isn't a readable tar archive.", cause));
  });
  const ended = once(parser, "end", { signal });
  // Rejections surface through `failure`, below.
  ended.catch(() => undefined);

  const source = openTarStream(input.source);
  signal.addEventListener("abort", source.close, { once: true });
  let streamBytes = 0;
  let head = Buffer.alloc(0);
  try {
    for await (const chunk of source.stream as AsyncIterable<Buffer>) {
      if (signal.aborted) break;
      if (head.length < 2) {
        // The parser would quietly decompress a second gzip layer, past the
        // byte count kept here.
        head = Buffer.concat([head, chunk.subarray(0, 2)]);
        if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
          fail(archiveError("format", "The download is compressed twice."));
          break;
        }
      }
      streamBytes += chunk.length;
      if (streamBytes > input.maxStreamBytes) {
        fail(
          archiveError(
            "tooLarge",
            `The archive unpacks to more than ${input.maxStreamBytes} bytes.`,
          ),
        );
        break;
      }
      // Small pieces, and a wait whenever many files are open: a run of tiny
      // entries otherwise opens a file each before the first has closed.
      for (let offset = 0; offset < chunk.length && !signal.aborted; offset += TAR_FEED_BYTES) {
        if (!parser.write(chunk.subarray(offset, offset + TAR_FEED_BYTES))) {
          await once(parser, "drain", { signal });
        }
        while (work.size > MAX_OPEN_FILES && !signal.aborted) await Promise.race(work);
      }
    }
    if (!signal.aborted) {
      parser.end();
      await ended;
    }
  } catch (cause) {
    // After an earlier failure this is only the abort it caused.
    fail(
      cause instanceof ArchiveError
        ? cause
        : archiveError("format", "The download couldn't be decompressed.", cause),
    );
  } finally {
    signal.removeEventListener("abort", source.close);
    source.close();
  }
  // Files that were mid-write close before the caller cleans up.
  await Promise.all(work);
  input.signal.throwIfAborted();
  if (failure !== undefined) throw failure;
}

async function extractTar(
  input: Required<Omit<ExtractArchiveInput, "kind">> & { readonly kind: "tar.gz" | "tar.bz2" },
) {
  const { limits, signal } = input;
  const maxStreamBytes = limits.maxBytes + limits.maxEntries * TAR_OVERHEAD_PER_ENTRY;
  if (input.kind === "tar.gz") {
    return extractTarSource(
      input,
      { path: input.archivePath, compression: "gzip" },
      maxStreamBytes,
    );
  }
  const tarPath = `${input.archivePath}.tar`;
  try {
    await decodeBzip2(input.archivePath, tarPath, maxStreamBytes, signal);
    return await extractTarSource(input, { path: tarPath, compression: "none" }, maxStreamBytes);
  } finally {
    await NodeFS.rm(tarPath, { force: true });
  }
}

async function extractTarSource(
  input: Required<Omit<ExtractArchiveInput, "kind">>,
  source: TarSource,
  maxStreamBytes: number,
) {
  const { outDir, signal, platform, limits } = input;
  const walk = { source, signal, maxStreamBytes };
  const headers: Array<ArchiveEntryHeader> = [];
  await walkTar({
    ...walk,
    onEntry: (entry) => {
      entry.resume();
      if (headers.length >= limits.maxEntries) {
        throw archiveError("tooLarge", `The archive has more than ${limits.maxEntries} entries.`);
      }
      // Checked before it is kept: a long-name entry may carry a megabyte.
      if (entry.path.length > MAX_NAME_LENGTH || (entry.linkpath?.length ?? 0) > MAX_NAME_LENGTH) {
        throw archiveError(
          "unsafe",
          `Entry "${entry.path.slice(0, 200)}" has a path or link target longer than ${MAX_NAME_LENGTH} characters.`,
        );
      }
      headers.push(tarEntryHeader(entry));
    },
  });
  const plan = planArchive(headers, {
    ...limits,
    platform,
    stripComponents: input.stripComponents,
  });

  await writeDirectories(outDir, plan);
  await walkTar({
    ...walk,
    onEntry: (entry, index, stopped) => {
      const planned = headers[index];
      if (!planned || planned.path !== entry.path || planned.size !== tarEntryHeader(entry).size) {
        entry.resume();
        throw archiveError("format", "The archive changed while it was being unpacked.");
      }
      const file = plan.files.get(index);
      if (!file) {
        entry.resume();
        return;
      }
      const target = nativePath(outDir, file.path);
      const output = createWriteStream(target, { flags: "wx", mode: file.mode });
      // A write that lands after the stream is closed must not crash the process.
      output.on("error", () => undefined);
      const close = () => {
        entry.unpipe(output);
        output.destroy();
      };
      stopped.addEventListener("abort", close, { once: true });
      // Minipass: pauses the entry, and with it the parser, while the file is behind.
      entry.pipe(output);
      return finished(output)
        .then(() => (platform === "win32" ? undefined : NodeFS.chmod(target, file.mode)))
        .finally(() => stopped.removeEventListener("abort", close));
    },
  });
  await writeLinks(outDir, plan, platform, signal);
  return { entries: headers.length, bytes: plan.totalBytes };
}

export interface ExtractArchiveInput {
  /**
   * The download. While a tar.bz2 is unpacked, its plain tar sits beside it
   * as `<archivePath>.tar`, so the folder must be writable and have the room.
   */
  readonly archivePath: string;
  readonly kind: ArchiveKind;
  /** An existing, empty folder only this call writes to. */
  readonly outDir: string;
  readonly signal?: AbortSignal;
  readonly limits?: ArchiveLimits;
  /** Leading path components to drop. Default 0. */
  readonly stripComponents?: number;
  /** Test seam: the system whose naming rules apply. */
  readonly platform?: NodeJS.Platform;
}

/**
 * Unpacks `archivePath` into `outDir`. Throws an `ArchiveError` when the
 * archive is unreadable, over budget, or holds an entry the policy refuses;
 * anything else it throws is the filesystem's. A refusal is decided before
 * anything is written; after any other failure, `outDir` holds a partial
 * tree for the caller to delete.
 */
export async function extractArchive(
  input: ExtractArchiveInput,
): Promise<{ readonly entries: number; readonly bytes: number }> {
  const resolved = {
    archivePath: input.archivePath,
    outDir: input.outDir,
    signal: input.signal ?? new AbortController().signal,
    limits: input.limits ?? DEFAULT_ARCHIVE_LIMITS,
    stripComponents: input.stripComponents ?? 0,
    platform: input.platform ?? process.platform,
  };
  resolved.signal.throwIfAborted();
  if ((await NodeFS.readdir(resolved.outDir)).length > 0) {
    throw new Error(`${resolved.outDir} is not empty`);
  }
  return input.kind === "zip"
    ? extractZip(resolved)
    : extractTar({ ...resolved, kind: input.kind });
}
