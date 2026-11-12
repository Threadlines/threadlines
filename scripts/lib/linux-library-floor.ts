// @effect-diagnostics nodeBuiltinImport:off
import { closeSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { basename, join, relative } from "node:path";

/**
 * The oldest system libraries the Linux desktop app may ask for.
 *
 * A Linux binary records the newest version of each system library function it
 * was linked against, and a system with an older library refuses to load it.
 * The terminal's native module (node-pty) is compiled on the build machine, so
 * it inherits that machine's glibc: built on Ubuntu 26.04 it needed glibc 2.42
 * and the app could not start on Ubuntu 24.04, 22.04 or Debian 12 and 13. The
 * machine that built it could not notice, because it had the new glibc.
 *
 * glibc 2.34 is what Ubuntu 22.04, Debian 12 and RHEL 9 can all load. The
 * other three are the compiler's own libraries as the oldest of those systems
 * ships them (GCC 11): libstdc++ (GLIBCXX and CXXABI) and libgcc. Raising any
 * number drops the systems below it, so do that on purpose.
 */
export const LINUX_LIBRARY_FLOOR = {
  GLIBC: "2.34",
  GLIBCXX: "3.4.29",
  CXXABI: "1.3.13",
  GCC: "11.0",
} as const;

/** Needs without a version number that every system at the floor meets. */
const NAMED_NEEDS_WITHIN_FLOOR: ReadonlySet<string> = new Set(["CXXABI_TM_1", "CXXABI_FLOAT128"]);

const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const DT_NULL = 0;
const DT_STRTAB = 5;
const DT_VERNEED = 0x6ffffffe;

function isElf(bytes: Uint8Array): boolean {
  return bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
}

/**
 * The library versions a Linux binary needs ("GLIBC_2.34", "GLIBCXX_3.4.22"),
 * read the way the system loader reads them: from the dynamic segment's
 * version-needs table, following each chain to its end (the loader ignores the
 * table's entry counts, so this does too). Null when the bytes are not a Linux
 * binary. Throws when they are one this cannot read (32-bit, big-endian, cut
 * short).
 */
export function readElfVersionNeeds(bytes: Uint8Array): ReadonlyArray<string> | null {
  if (!isElf(bytes)) return null;
  if (bytes[4] !== 2 || bytes[5] !== 1) {
    throw new Error("only 64-bit little-endian binaries can be checked");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const u64 = (at: number) => Number(view.getBigUint64(at, true));

  const programHeadersAt = u64(0x20);
  const programHeaderSize = u16(0x36);
  const segments = Array.from({ length: u16(0x38) }, (_, index) => {
    const at = programHeadersAt + index * programHeaderSize;
    return { type: u32(at), offset: u64(at + 8), address: u64(at + 16), size: u64(at + 32) };
  });
  const dynamic = segments.find((segment) => segment.type === PT_DYNAMIC);
  // A statically linked binary asks the system for nothing.
  if (dynamic === undefined) return [];

  let stringsAddress: number | undefined;
  let needsAddress: number | undefined;
  for (let at = dynamic.offset; at + 16 <= dynamic.offset + dynamic.size; at += 16) {
    const tag = u64(at);
    if (tag === DT_NULL) break;
    if (tag === DT_STRTAB) stringsAddress = u64(at + 8);
    if (tag === DT_VERNEED) needsAddress = u64(at + 8);
  }
  if (needsAddress === undefined) return [];
  if (stringsAddress === undefined) throw new Error("the binary has no string table");

  // The dynamic segment holds addresses as loaded; the load segments say where
  // those bytes sit in the file.
  const fileOffset = (address: number) => {
    const segment = segments.find(
      (candidate) =>
        candidate.type === PT_LOAD &&
        address >= candidate.address &&
        address < candidate.address + candidate.size,
    );
    if (segment === undefined) throw new Error("the binary points outside its own file");
    return address - segment.address + segment.offset;
  };
  const stringsAt = fileOffset(stringsAddress);
  const decoder = new TextDecoder();
  const text = (offset: number) => {
    const start = stringsAt + offset;
    const end = bytes.indexOf(0, start);
    if (end === -1) throw new Error("the binary's string table is cut short");
    return decoder.decode(bytes.subarray(start, end));
  };

  // One entry per library, each with a chain of the versions needed from it.
  // A read past the end of a cut-short file throws.
  const versions = new Set<string>();
  for (let needAt = fileOffset(needsAddress); ;) {
    for (let versionAt = needAt + u32(needAt + 8); ;) {
      versions.add(text(u32(versionAt + 8)));
      const nextVersion = u32(versionAt + 12);
      if (nextVersion === 0) break;
      versionAt += nextVersion;
    }
    const nextNeed = u32(needAt + 12);
    if (nextNeed === 0) break;
    needAt += nextNeed;
  }
  return [...versions];
}

function isNewerVersion(version: string, floor: string): boolean {
  const parts = version.split(".").map(Number);
  const floorParts = floor.split(".").map(Number);
  for (let index = 0; index < Math.max(parts.length, floorParts.length); index += 1) {
    const difference = (parts[index] ?? 0) - (floorParts[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/**
 * The needs a system at the floor cannot meet. A need in one of the floor's
 * families that is not a plain version (GLIBC_ABI_DT_RELR, which only glibc
 * 2.36 and newer provide) counts unless it is known to be old: a new kind of
 * need is one an older system has not heard of.
 */
export function versionNeedsAboveLinuxFloor(needs: ReadonlyArray<string>): ReadonlyArray<string> {
  return needs.filter((need) => {
    const match = /^(GLIBCXX|GLIBC|CXXABI|GCC)_(.+)$/.exec(need);
    if (match === null || NAMED_NEEDS_WITHIN_FLOOR.has(need)) return false;
    const [, family, version] = match;
    if (version === undefined || !/^\d+(\.\d+)*$/.test(version)) return true;
    return isNewerVersion(version, LINUX_LIBRARY_FLOOR[family as keyof typeof LINUX_LIBRARY_FLOOR]);
  });
}

function startsLikeElf(filePath: string): boolean {
  const descriptor = openSync(filePath, "r");
  try {
    const head = new Uint8Array(4);
    return readSync(descriptor, head, 0, 4, 0) === 4 && isElf(head);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Why a packaged Linux app would not start on the oldest systems we support,
 * or null when every binary in it loads there. `appDir` is the app as a folder
 * (electron-builder's `linux-unpacked`, or an unpacked AppImage); `otherFiles`
 * are binaries shipped outside it, such as the AppImage file itself, whose
 * first bytes are the program that mounts it. Finding no binary to check is a
 * failure too: the Electron executable is always one, so that means the check
 * itself is broken.
 */
export function checkLinuxAppLibraryFloor(
  appDir: string,
  otherFiles: ReadonlyArray<string> = [],
): string | null {
  const filePaths = readdirSync(appDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
  const problems: string[] = [];
  let binaryCount = 0;
  for (const filePath of [...filePaths, ...otherFiles]) {
    if (!startsLikeElf(filePath)) continue;
    binaryCount += 1;
    const name = filePath.startsWith(appDir) ? relative(appDir, filePath) : basename(filePath);
    try {
      const tooNew = versionNeedsAboveLinuxFloor(readElfVersionNeeds(readFileSync(filePath)) ?? []);
      if (tooNew.length > 0) problems.push(`${name} needs ${tooNew.join(", ")}`);
    } catch (cause) {
      problems.push(
        `${name} could not be checked: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  if (binaryCount === 0) {
    return `Found no Linux binaries to check in ${appDir}. The system library check is looking in the wrong place.`;
  }
  if (problems.length === 0) return null;
  return [
    `The Linux app would not start on systems with glibc ${LINUX_LIBRARY_FLOOR.GLIBC} (Ubuntu 22.04, Debian 12, RHEL 9), the oldest we support:`,
    ...problems.map((problem) => `  ${problem}`),
    "Native modules take the build machine's glibc, so build on an older system (the Linux jobs are pinned to ubuntu-24.04 for this). To drop the older systems on purpose, raise LINUX_LIBRARY_FLOOR in scripts/lib/linux-library-floor.ts.",
  ].join("\n");
}
