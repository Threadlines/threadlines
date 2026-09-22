// @effect-diagnostics nodeBuiltinImport:off - gunzip and path resolution
/**
 * Minimal reader for npm package tarballs, used to unpack the prebuilt
 * sherpa-onnx runtime. npm tarballs are gzipped ustar archives with every
 * entry under a single `package/` directory; only regular files are kept and
 * that prefix is stripped. Anything that would land outside the destination
 * is rejected rather than skipped, because a tarball that tries is not one we
 * want to half-extract.
 *
 * @module dictation/npmTarball
 */
import * as nodePath from "node:path";
import * as zlib from "node:zlib";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

const BLOCK_SIZE = 512;
const NAME_OFFSET = 0;
const NAME_SIZE = 100;
const SIZE_OFFSET = 124;
const SIZE_FIELD_SIZE = 12;
const TYPE_FLAG_OFFSET = 156;
const PREFIX_OFFSET = 345;
const PREFIX_SIZE = 155;

export class NpmTarballError extends Error {
  readonly _tag = "NpmTarballError";
}

const readString = (block: Uint8Array, offset: number, size: number): string => {
  const slice = block.subarray(offset, offset + size);
  const end = slice.indexOf(0);
  return Buffer.from(end === -1 ? slice : slice.subarray(0, end)).toString("utf8");
};

const readOctal = (block: Uint8Array, offset: number, size: number): number => {
  const raw = readString(block, offset, size).trim();
  if (raw.length === 0) {
    return 0;
  }
  const parsed = Number.parseInt(raw, 8);
  return Number.isFinite(parsed) ? parsed : 0;
};

const isZeroBlock = (block: Uint8Array): boolean => block.every((byte) => byte === 0);

interface TarEntry {
  readonly name: string;
  readonly typeFlag: string;
  readonly data: Uint8Array;
}

/** Walks the ustar stream, resolving `L`/`x` long-name entries as it goes. */
function* readTarEntries(archive: Uint8Array): Generator<TarEntry> {
  let offset = 0;
  let pendingLongName: string | undefined;

  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;
    if (isZeroBlock(header)) {
      continue;
    }

    const size = readOctal(header, SIZE_OFFSET, SIZE_FIELD_SIZE);
    const typeFlag = readString(header, TYPE_FLAG_OFFSET, 1) || "0";
    const data = archive.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

    if (typeFlag === "L") {
      pendingLongName = Buffer.from(data).toString("utf8").replace(/\0+$/, "");
      continue;
    }

    const prefix = readString(header, PREFIX_OFFSET, PREFIX_SIZE);
    const shortName = readString(header, NAME_OFFSET, NAME_SIZE);
    const name = pendingLongName ?? (prefix.length > 0 ? `${prefix}/${shortName}` : shortName);
    pendingLongName = undefined;

    yield { name, typeFlag, data };
  }
}

/** Strips the single leading directory segment npm wraps every entry in. */
const stripPackagePrefix = (name: string): string | undefined => {
  const normalized = name.replace(/\\/g, "/").replace(/^\.\//, "");
  const separator = normalized.indexOf("/");
  if (separator === -1) {
    return undefined;
  }
  const rest = normalized.slice(separator + 1);
  return rest.length > 0 ? rest : undefined;
};

/**
 * Extracts the regular files of an npm tarball into `destDir`, dropping the
 * `package/` prefix. Fails if any entry resolves outside `destDir`.
 */
export const extractNpmTarball = Effect.fn("dictation.extractNpmTarball")(function* (
  tgzPath: string,
  destDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const compressed = yield* fs.readFile(tgzPath);
  const archive = yield* Effect.try({
    try: () => zlib.gunzipSync(compressed),
    catch: (cause) => new NpmTarballError(`Failed to gunzip ${tgzPath}: ${String(cause)}`),
  });

  const resolvedDest = nodePath.resolve(destDir);
  yield* fs.makeDirectory(resolvedDest, { recursive: true });

  const written: Array<string> = [];
  for (const entry of readTarEntries(archive)) {
    // Regular files only: "0"/"\0" are files, everything else is a
    // directory, link, or pax header we have no use for.
    if (entry.typeFlag !== "0" && entry.typeFlag !== "\0") {
      continue;
    }
    const relative = stripPackagePrefix(entry.name);
    if (relative === undefined) {
      continue;
    }

    const target = nodePath.resolve(resolvedDest, relative);
    if (target !== resolvedDest && !target.startsWith(resolvedDest + nodePath.sep)) {
      return yield* Effect.fail(
        new NpmTarballError(`Tarball entry escapes the destination directory: ${entry.name}`),
      );
    }

    yield* fs.makeDirectory(nodePath.dirname(target), { recursive: true });
    yield* fs.writeFile(target, entry.data);
    written.push(target);
  }

  return written;
});
