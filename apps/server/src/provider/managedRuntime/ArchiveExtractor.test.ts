import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";

import { create as createTar } from "tar";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { makeTar, makeZip, type TarEntry, type ZipEntry } from "../testUtils/archiveFixtures.ts";
import {
  type ArchiveEntryHeader,
  ArchiveError,
  type ArchiveLimits,
  assertLinksStayInside,
  DEFAULT_ARCHIVE_LIMITS,
  extractArchive,
  planArchive,
} from "./ArchiveExtractor.ts";

const posix = process.platform !== "win32";

const file = (entryPath: string, extra: Partial<ArchiveEntryHeader> = {}): ArchiveEntryHeader => ({
  path: entryPath,
  type: "file",
  size: 1,
  ...extra,
});
const link = (entryPath: string, linkTarget: string): ArchiveEntryHeader => ({
  path: entryPath,
  type: "symlink",
  size: 0,
  linkTarget,
});

const plan = (
  headers: ReadonlyArray<ArchiveEntryHeader>,
  options: { platform?: NodeJS.Platform; stripComponents?: number; maxBytes?: number } = {},
) =>
  planArchive(headers, {
    ...DEFAULT_ARCHIVE_LIMITS,
    platform: "linux",
    stripComponents: 0,
    ...options,
  });

/** The refusal's reason, or what was planned when nothing was refused. */
const reasonFor = (...args: Parameters<typeof plan>) => {
  try {
    plan(...args);
    return "accepted";
  } catch (cause) {
    if (cause instanceof ArchiveError) return cause.reason;
    throw cause;
  }
};

describe("planArchive", () => {
  it("plans folders parents first, with the folders entries only imply", () => {
    const planned = plan([
      file("pkg/bin/tool", { mode: 0o755, size: 10 }),
      { path: "pkg/", type: "directory", size: 0 },
      file("./pkg/lib/data", { mode: 0o444, size: 5 }),
      link("pkg/current", "bin/tool"),
      { path: "pkg/lib/copy", type: "hardlink", size: 0, linkTarget: "pkg/lib/data", mode: 0o644 },
    ]);

    expect(planned.directories).toEqual(["pkg", "pkg/bin", "pkg/lib"]);
    expect([...planned.files]).toEqual([
      [0, { path: "pkg/bin/tool", mode: 0o755, size: 10 }],
      // Read-only in the archive, still ours to delete.
      [2, { path: "pkg/lib/data", mode: 0o644, size: 5 }],
    ]);
    expect(planned.symlinks).toEqual([
      { path: "pkg/current", target: "bin/tool", pointsAtDirectory: false },
    ]);
    expect(planned.copies).toEqual([{ path: "pkg/lib/copy", from: "pkg/lib/data", mode: 0o644 }]);
    // The copy takes real space too.
    expect(planned.totalBytes).toBe(20);
  });

  it("drops setuid, setgid and sticky bits, and group and other write", () => {
    const planned = plan([file("a", { mode: 0o6777 }), file("b", { mode: 0o1666 }), file("c")]);
    expect([...planned.files.values()].map((entry) => entry.mode)).toEqual([0o755, 0o644, 0o644]);
  });

  it("drops leading components on request, and what sits above them", () => {
    const planned = plan(
      [
        { path: "node-v1/", type: "directory", size: 0 },
        file("node-v1/bin/node"),
        file("stray-readme"),
        { path: "node-v1/lib/link", type: "hardlink", size: 0, linkTarget: "node-v1/bin/node" },
      ],
      { stripComponents: 1 },
    );
    expect(planned.directories).toEqual(["bin", "lib"]);
    expect([...planned.files.values()].map((entry) => entry.path)).toEqual(["bin/node"]);
    expect(planned.copies).toEqual([{ path: "lib/link", from: "bin/node", mode: 0o644 }]);
  });

  it("refuses entries that would land outside the folder", () => {
    for (const entryPath of ["../evil", "a/../../evil", "/etc/passwd", "a\\b", "a\u0000b"]) {
      expect(reasonFor([file(entryPath)]), entryPath).toBe("unsafe");
    }
  });

  it("refuses devices, FIFOs and anything else that isn't a file, folder or link", () => {
    expect(
      reasonFor([{ path: "dev/null", type: "other", typeLabel: "CharacterDevice", size: 0 }]),
    ).toBe("unsafe");
  });

  it("refuses two entries for one place, and anything under a file or a link", () => {
    expect(reasonFor([file("a"), file("a")])).toBe("unsafe");
    expect(reasonFor([file("a"), file("a/b")])).toBe("unsafe");
    expect(reasonFor([file("a/b"), file("a")])).toBe("unsafe");
    // A link followed by a write through it, in either order.
    expect(reasonFor([link("d", "elsewhere"), file("d/payload")])).toBe("unsafe");
    expect(reasonFor([file("d/payload"), link("d", "elsewhere")])).toBe("unsafe");
    // A folder listed twice is the same folder.
    expect(
      reasonFor([
        { path: "a/", type: "directory", size: 0 },
        { path: "a", type: "directory", size: 0 },
      ]),
    ).toBe("accepted");
  });

  it("refuses links that leave the folder, on their own or through another link", () => {
    expect(reasonFor([link("a/l", "../../outside")])).toBe("unsafe");
    expect(reasonFor([link("l", "/etc")])).toBe("unsafe");
    expect(reasonFor([link("l", "C:/Windows")])).toBe("unsafe");
    // Each stays inside by its text alone; followed for real, the second leaves.
    expect(reasonFor([link("d/up", ".."), link("escape", "d/up/..")])).toBe("unsafe");
    // The second link may come first in the archive.
    expect(reasonFor([link("escape", "d/up/.."), link("d/up", "..")])).toBe("unsafe");

    // Inside, and to another link as its last step: fine.
    expect(
      reasonFor([file("lib/v2/tool"), link("lib/current", "v2"), link("tool", "lib/current")]),
    ).toBe("accepted");
    expect(plan([file("lib/v2/tool"), link("lib/current", "./v2/")]).symlinks).toEqual([
      { path: "lib/current", target: "v2", pointsAtDirectory: true },
    ]);
  });

  it("judges links by the names a case-insensitive disk would match", () => {
    // `\u017f` (long s) is `s` to macOS and Windows: followed for real, the
    // second link goes through the first and out.
    const throughAnAlias = [link("d/s", ".."), link("escape", "d/\u017f/..")];
    expect(reasonFor(throughAnAlias, { platform: "darwin" })).toBe("unsafe");
    expect(reasonFor(throughAnAlias, { platform: "win32" })).toBe("unsafe");
    // Two names on Linux, and `d/\u017f` isn't there to follow.
    expect(reasonFor(throughAnAlias, { platform: "linux" })).toBe("accepted");

    for (const pair of [
      [file("s"), file("\u017f")],
      [file("stra\u00dfe"), file("STRASSE")],
      // HFS+ skips this character when it compares names.
      [file("config"), file("con\u200cfig")],
    ]) {
      expect(reasonFor(pair, { platform: "darwin" })).toBe("unsafe");
      expect(reasonFor(pair, { platform: "linux" })).toBe("accepted");
    }
    // A name such a disk would read as the parent folder.
    expect(reasonFor([file("a/.\u200c./b")], { platform: "darwin" })).toBe("unsafe");
  });

  it("refuses a hard link to anything but a file earlier in the archive", () => {
    const hard = (linkTarget: string): ArchiveEntryHeader => ({
      path: "copy",
      type: "hardlink",
      size: 0,
      linkTarget,
    });
    expect(reasonFor([hard("later"), file("later")])).toBe("unsafe");
    expect(reasonFor([hard("../outside")])).toBe("unsafe");
    expect(reasonFor([link("l", "x"), hard("l")])).toBe("unsafe");
  });

  it("applies each system's naming rules only where they bite", () => {
    const windowsOnly = ["aux.c", "COM1", "dir /x", "trailing.", "a:b", "what?"];
    for (const entryPath of windowsOnly) {
      expect(reasonFor([file(entryPath)], { platform: "win32" }), entryPath).toBe("unsafe");
      expect(reasonFor([file(entryPath)], { platform: "linux" }), entryPath).toBe("accepted");
    }
    // Same place on Windows and macOS, two files on Linux.
    const sameWhenFolded = [
      [file("Makefile"), file("makefile")],
      [file("caf\u00e9"), file("cafe\u0301")],
      [file("Dir/a"), file("dir/b")],
    ];
    for (const headers of sameWhenFolded) {
      expect(reasonFor(headers, { platform: "darwin" })).toBe("unsafe");
      expect(reasonFor(headers, { platform: "win32" })).toBe("unsafe");
      expect(reasonFor(headers, { platform: "linux" })).toBe("accepted");
    }
  });

  it("bounds what one header can ask for", () => {
    // One short entry must not become thousands of folders.
    expect(reasonFor([file(`${"a/".repeat(600)}f`)])).toBe("unsafe");
    expect(reasonFor([link("l", "x/".repeat(600))])).toBe("unsafe");
    // The folders a path implies count like any other entry.
    expect(() =>
      planArchive([file(`${"a/".repeat(50)}f`)], {
        maxBytes: 10,
        maxEntries: 10,
        platform: "linux",
        stripComponents: 0,
      }),
    ).toThrow(/more than 10 files and folders/u);
  });

  it("stops at the byte and entry budgets", () => {
    expect(
      reasonFor([file("a", { size: 600 }), file("b", { size: 600 })], { maxBytes: 1000 }),
    ).toBe("tooLarge");
    expect(() =>
      planArchive([file("a"), file("b")], {
        maxBytes: 10,
        maxEntries: 1,
        platform: "linux",
        stripComponents: 0,
      }),
    ).toThrow(/at most 1/u);
  });
});

/** `tar cjf` of pkg/README (644) and pkg/bin/tool (755), made once with the system tar. */
const TAR_BZ2_FIXTURE = Buffer.from(
  "QlpoOTFBWSZTWe5b+VsAAO1/kdKQAMBoAP+AJgIVRH7v3oAEAAACAggwANjbCVKMEyYEwjATDSYTJpoEpKbBEBoyNMmmjTQNBk0wVSIRqabUHpBhAGnqDNRpvUwMSXfc6NCVxSM8olzAdruWBiVkMpD4z/NY6RquiYqTL1tlbDfp/8fyNkputmIeEhDMbCRG3bhhkLC0tOrVZolEedRMkZAatQwKwaEFD62Qwj0cDFA5HkCAocvInLp17YXvgWJBRHPHVOCQWDUPn0NtkbguGJPuhpQfHCZx+1Lyes7KGUvKrqFDSRyF3JFOFCQ7lv5WwA==",
  "base64",
);

const LAUNCHER = '#!/bin/sh\nexec "$(dirname "$0")/../lib/helper"\n';
const HELPER = "#!/bin/sh\necho helper ran\n";

describe("extractArchive", () => {
  const cleanups: Array<string> = [];
  afterEach(async () => {
    for (const dir of cleanups.splice(0)) {
      await NodeFS.rm(dir, { recursive: true, force: true });
    }
  });

  const tempDir = async () => {
    const dir = await NodeFS.mkdtemp(path.join(os.tmpdir(), "threadlines-archive-test-"));
    cleanups.push(dir);
    return dir;
  };

  /** Writes `archive` to disk and unpacks it into a new folder. */
  const unpack = async (
    archive: Buffer,
    kind: "zip" | "tar.gz" | "tar.bz2",
    options: { limits?: ArchiveLimits; stripComponents?: number } = {},
  ) => {
    const dir = await tempDir();
    const archivePath = path.join(dir, "archive");
    const outDir = path.join(dir, "out");
    await NodeFS.writeFile(archivePath, archive);
    await NodeFS.mkdir(outDir);
    const result = extractArchive({
      archivePath,
      kind,
      outDir,
      ...(options.stripComponents === undefined
        ? {}
        : { stripComponents: options.stripComponents }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    });
    return { outDir, result };
  };

  /** The reason an archive was refused, having checked nothing was written. */
  const refusal = async (...args: Parameters<typeof unpack>) => {
    const { outDir, result } = await unpack(...args);
    const error = await result.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(ArchiveError);
    expect(await NodeFS.readdir(outDir)).toEqual([]);
    return (error as ArchiveError).reason;
  };

  const modeOf = async (target: string) => (await NodeFS.stat(target)).mode & 0o7777;

  it.skipIf(!posix)("unpacks a real tar.gz: long names, modes, links and a hard link", async () => {
    const source = await tempDir();
    const deep = path.join("deep", "x".repeat(60), "y".repeat(60), "z".repeat(60));
    await NodeFS.mkdir(path.join(source, "bin"));
    await NodeFS.mkdir(path.join(source, "lib"));
    await NodeFS.mkdir(path.join(source, deep), { recursive: true });
    await NodeFS.writeFile(path.join(source, "bin", "launcher"), LAUNCHER, { mode: 0o755 });
    await NodeFS.writeFile(path.join(source, "lib", "helper"), HELPER, { mode: 0o755 });
    await NodeFS.writeFile(path.join(source, "lib", "data.txt"), "data\n", { mode: 0o644 });
    await NodeFS.writeFile(path.join(source, deep, "leaf.txt"), "leaf\n");
    await NodeFS.link(path.join(source, "lib", "data.txt"), path.join(source, "lib", "twin.txt"));
    await NodeFS.symlink("../lib/helper", path.join(source, "bin", "helper"));
    await NodeFS.symlink("lib", path.join(source, "current"));
    const archivePath = path.join(await tempDir(), "tree.tar.gz");
    await createTar({ gzip: true, cwd: source, file: archivePath }, [
      "bin",
      "lib",
      "deep",
      "current",
    ]);

    const { outDir, result } = await unpack(await NodeFS.readFile(archivePath), "tar.gz");
    await result;

    expect(await NodeFS.readFile(path.join(outDir, deep, "leaf.txt"), "utf8")).toBe("leaf\n");
    expect(await modeOf(path.join(outDir, "bin", "launcher"))).toBe(0o755);
    expect(await modeOf(path.join(outDir, "lib", "data.txt"))).toBe(0o644);
    expect(await NodeFS.readlink(path.join(outDir, "bin", "helper"))).toBe("../lib/helper");
    expect(await NodeFS.readlink(path.join(outDir, "current"))).toBe("lib");
    // The hard link is its own file now.
    expect(await NodeFS.readFile(path.join(outDir, "lib", "twin.txt"), "utf8")).toBe("data\n");
    const [original, twin] = await Promise.all([
      NodeFS.stat(path.join(outDir, "lib", "data.txt")),
      NodeFS.stat(path.join(outDir, "lib", "twin.txt")),
    ]);
    expect(twin.ino).not.toBe(original.ino);
    // A launcher that starts another unpacked program still can.
    expect(execFileSync(path.join(outDir, "bin", "launcher"), { encoding: "utf8" })).toBe(
      "helper ran\n",
    );

    // setuid doesn't survive.
    const privileged = await unpack(
      zlib.gzipSync(makeTar([{ name: "privileged", data: Buffer.from("x"), mode: 0o4755 }])),
      "tar.gz",
    );
    await privileged.result;
    expect(await modeOf(path.join(privileged.outDir, "privileged"))).toBe(0o755);
  });

  it("unpacks a zip with its Unix modes and links", async () => {
    const { outDir, result } = await unpack(
      makeZip([
        { name: "app/", mode: 0o040755 },
        { name: "app/bin/launcher", data: Buffer.from(LAUNCHER), mode: 0o100755 },
        { name: "app/lib/helper", data: Buffer.from(HELPER), mode: 0o104755 },
        { name: "app/lib/notes.txt", data: Buffer.from("notes\n") },
        { name: "app/run", data: Buffer.from("bin/launcher"), mode: 0o120777 },
      ]),
      "zip",
    );
    expect(await result).toEqual({ entries: 5, bytes: LAUNCHER.length + HELPER.length + 6 });

    expect(await NodeFS.readFile(path.join(outDir, "app", "lib", "notes.txt"), "utf8")).toBe(
      "notes\n",
    );
    if (!posix) return;
    expect(await modeOf(path.join(outDir, "app", "lib", "helper"))).toBe(0o755);
    expect(await modeOf(path.join(outDir, "app", "lib", "notes.txt"))).toBe(0o644);
    expect(await NodeFS.readlink(path.join(outDir, "app", "run"))).toBe("bin/launcher");
    expect(execFileSync(path.join(outDir, "app", "bin", "launcher"), { encoding: "utf8" })).toBe(
      "helper ran\n",
    );
  });

  it("unpacks a tar.bz2, dropping the folder that wraps it", async () => {
    const { outDir, result } = await unpack(TAR_BZ2_FIXTURE, "tar.bz2", { stripComponents: 1 });
    await result;

    expect((await NodeFS.readdir(outDir)).toSorted()).toEqual(["README", "bin"]);
    expect(await NodeFS.readFile(path.join(outDir, "README"), "utf8")).toBe("read me\n");
    if (posix) expect(await modeOf(path.join(outDir, "bin", "tool"))).toBe(0o755);
  });

  it("unpacks a long run of tiny files without holding them all open", async () => {
    const entries = Array.from({ length: 3000 }, (_, index) => ({
      name: `many/${index}`,
      data: index % 2 === 0 ? Buffer.alloc(0) : Buffer.from(String(index)),
    }));
    const { outDir, result } = await unpack(zlib.gzipSync(makeTar(entries)), "tar.gz");
    expect((await result).entries).toBe(3000);

    expect(await NodeFS.readdir(path.join(outDir, "many"))).toHaveLength(3000);
    expect(await NodeFS.readFile(path.join(outDir, "many", "2999"), "utf8")).toBe("2999");
    expect((await NodeFS.stat(path.join(outDir, "many", "0"))).size).toBe(0);
  });

  it.skipIf(!posix)("asks the disk where links lead, whatever their text says", async () => {
    const outDir = await tempDir();
    const never = new AbortController().signal;
    await NodeFS.mkdir(path.join(outDir, "lib", "v2"), { recursive: true });
    await NodeFS.symlink("v2", path.join(outDir, "lib", "current"));
    await NodeFS.symlink("lib/current/missing", path.join(outDir, "dangling"));
    const staysInside = [
      { path: "lib/current", target: "v2", pointsAtDirectory: true },
      { path: "dangling", target: "lib/current/missing", pointsAtDirectory: false },
    ];
    await assertLinksStayInside(outDir, { symlinks: staysInside }, never);

    // A link the plan didn't know its target passes through: on disk it
    // leads to the folder above.
    await NodeFS.symlink("..", path.join(outDir, "lib", "up"));
    await NodeFS.symlink("lib/up/../gone", path.join(outDir, "escape"));
    await expect(
      assertLinksStayInside(
        outDir,
        { symlinks: [{ path: "escape", target: "lib/up/../gone", pointsAtDirectory: false }] },
        never,
      ),
    ).rejects.toMatchObject({ reason: "unsafe" });
  });

  it("refuses a hostile tar before writing anything", async () => {
    const payload = Buffer.from("x");
    const hostile: Record<string, ReadonlyArray<TarEntry>> = {
      traversal: [
        { name: "ok", data: payload },
        { name: "../evil", data: payload },
      ],
      "write through a link": [
        { name: "ok", data: payload },
        { name: "d", type: "2", linkname: "/tmp" },
        { name: "d/payload", data: payload },
      ],
      "links that chain out": [
        { name: "ok", data: payload },
        { name: "d/up", type: "2", linkname: ".." },
        { name: "escape", type: "2", linkname: "d/up/.." },
      ],
      device: [
        { name: "ok", data: payload },
        { name: "null", type: "3" },
      ],
      fifo: [
        { name: "ok", data: payload },
        { name: "pipe", type: "6" },
      ],
      "sparse file": [
        { name: "ok", data: payload },
        { name: "sparse", type: "S" },
      ],
      "duplicate name": [
        { name: "ok", data: payload },
        { name: "ok", data: payload },
      ],
    };
    for (const [name, entries] of Object.entries(hostile)) {
      expect(await refusal(zlib.gzipSync(makeTar(entries)), "tar.gz"), name).toBe("unsafe");
    }
  });

  it("refuses a hostile zip before writing anything", async () => {
    const payload = Buffer.from("x");
    const hostile: Record<string, ReadonlyArray<ZipEntry>> = {
      traversal: [
        { name: "ok", data: payload },
        { name: "../evil", data: payload },
      ],
      "link out": [
        { name: "ok", data: payload },
        { name: "escape", data: Buffer.from("../../outside"), mode: 0o120777 },
      ],
      device: [
        { name: "ok", data: payload },
        { name: "null", mode: 0o020666 },
      ],
      "duplicate name": [
        { name: "ok", data: payload },
        { name: "ok", data: payload },
      ],
      "endless path": [
        { name: "ok", data: payload },
        { name: `${"a/".repeat(2000)}f`, data: payload },
      ],
    };
    for (const [name, entries] of Object.entries(hostile)) {
      expect(await refusal(makeZip(entries), "zip"), name).toBe("unsafe");
    }
  });

  it("stops a bomb at the byte budget, by what it declares and by what it sends", async () => {
    const megabyte = 1024 * 1024;
    const limits = { maxBytes: megabyte, maxEntries: 16 };
    // Declares more than the budget: refused from the header alone.
    const big = makeTar([{ name: "big", data: Buffer.alloc(4 * megabyte) }]);
    expect(await refusal(zlib.gzipSync(big), "tar.gz", { limits })).toBe("tooLarge");
    // Declares little and never stops: junk after the end of the archive.
    const padded = Buffer.concat([
      makeTar([{ name: "small", data: Buffer.from("x") }]),
      Buffer.alloc(4 * megabyte),
    ]);
    expect(await refusal(zlib.gzipSync(padded), "tar.gz", { limits })).toBe("tooLarge");
    expect(
      await refusal(makeZip([{ name: "big", data: Buffer.alloc(4 * megabyte) }]), "zip", {
        limits,
      }),
    ).toBe("tooLarge");
  });

  it("says so when the download isn't the archive it claims to be", async () => {
    expect(await refusal(Buffer.from("not an archive at all"), "zip")).toBe("format");
    expect(await refusal(Buffer.from("not an archive at all"), "tar.gz")).toBe("format");
    expect(await refusal(Buffer.from("not an archive at all"), "tar.bz2")).toBe("format");
    // A second layer of compression isn't unpacked on trust.
    const tar = makeTar([{ name: "inner", data: Buffer.from("x") }]);
    expect(await refusal(zlib.gzipSync(zlib.gzipSync(tar)), "tar.gz")).toBe("format");
    // A tar cut off in the middle of a file.
    const truncated = makeTar([{ name: "cut", data: Buffer.alloc(4096, 1) }]).subarray(0, 1536);
    expect(await refusal(zlib.gzipSync(truncated), "tar.gz")).toBe("format");
  });
});
