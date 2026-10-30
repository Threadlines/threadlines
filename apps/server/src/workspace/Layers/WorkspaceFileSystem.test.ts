import { createHash } from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem } from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import { WorkspaceFileSystemLive, WORKSPACE_TEXT_READ_MAX_BYTES } from "./WorkspaceFileSystem.ts";
import { PROJECT_WRITE_FILE_MAX_BYTES } from "@threadlines/contracts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

const ProjectLayer = WorkspaceFileSystemLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provide(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "threadlines-workspace-files-",
  });
});

function sha256HexOf(contents: string): string {
  return createHash("sha256").update(Buffer.from(contents, "utf8")).digest("hex");
}

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { cause?: unknown; code?: unknown; reason?: unknown };
  if (typeof record.code === "string") return record.code;
  if (record.cause && typeof record.cause === "object") {
    const causeCode = (record.cause as { code?: unknown }).code;
    if (typeof causeCode === "string") return causeCode;
  }
  if (record.reason && typeof record.reason === "object") {
    const reason = record.reason as { cause?: unknown; code?: unknown };
    if (typeof reason.code === "string") return reason.code;
    if (reason.cause && typeof reason.cause === "object") {
      const reasonCauseCode = (reason.cause as { code?: unknown }).code;
      if (typeof reasonCauseCode === "string") return reasonCauseCode;
    }
  }
  return undefined;
}

function isUnavailableWindowsSymlink(error: unknown) {
  return process.platform === "win32" && getErrorCode(error) === "EPERM";
}

it.layer(TestLayer)("WorkspaceFileSystemLive", (it) => {
  describe("writeFile", () => {
    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({
          kind: "written",
          relativePath: "plans/effect-rpc.md",
          contentHash: sha256HexOf("# Plan\n"),
        });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("writes when the expected content hash matches the disk state", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "notes.md", "v1");

        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "notes.md",
          contents: "v2",
          expectedContentHash: sha256HexOf("v1"),
        });

        expect(result).toEqual({
          kind: "written",
          relativePath: "notes.md",
          contentHash: sha256HexOf("v2"),
        });
      }),
    );

    it.effect("refuses stale-baseline writes with a conflict carrying disk state", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        // Another writer moved the file past the caller's baseline ("v1").
        yield* writeTextFile(cwd, "notes.md", "external v2");

        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "notes.md",
          contents: "my edit on top of v1",
          expectedContentHash: sha256HexOf("v1"),
        });

        expect(result).toEqual({
          kind: "conflict",
          relativePath: "notes.md",
          content: "external v2",
          contentHash: sha256HexOf("external v2"),
          size: 11,
        });
        const disk = yield* fileSystem
          .readFileString(path.join(cwd, "notes.md"))
          .pipe(Effect.orDie);
        expect(disk).toBe("external v2");
      }),
    );

    it.effect("recreates externally deleted files instead of reporting a conflict", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "gone.md",
          contents: "recreated",
          expectedContentHash: sha256HexOf("old baseline"),
        });

        expect(result).toEqual({
          kind: "written",
          relativePath: "gone.md",
          contentHash: sha256HexOf("recreated"),
        });
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.search({
          cwd,
          query: "rpc",
          limit: 10,
        });
        expect(beforeWrite).toEqual({
          entries: [],
          truncated: false,
        });

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.search({
          cwd,
          query: "rpc",
          limit: 10,
        });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        expect(escapedStat).toBeNull();
      }),
    );
  });

  describe("readFile", () => {
    it.effect("reads text files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/main.ts", "export const answer = 42;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/main.ts",
        });

        expect(result).toEqual({
          kind: "text",
          relativePath: "src/main.ts",
          content: "export const answer = 42;\n",
          size: 26,
          truncated: false,
          contentHash: sha256HexOf("export const answer = 42;\n"),
        });
      }),
    );

    it.effect("truncates oversized text files instead of reading them fully", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const oversized = "x".repeat(WORKSPACE_TEXT_READ_MAX_BYTES + 16);
        yield* writeTextFile(cwd, "big.log", oversized);

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "big.log",
        });

        expect(result.kind).toBe("text");
        if (result.kind === "text") {
          expect(result.truncated).toBe(true);
          expect(result.content.length).toBe(WORKSPACE_TEXT_READ_MAX_BYTES);
          expect(result.size).toBe(oversized.length);
        }
      }),
    );

    it.effect("reports NUL-containing files as binary", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* fileSystem
          .writeFile(path.join(cwd, "blob.dat"), new Uint8Array([1, 2, 0, 3]))
          .pipe(Effect.orDie);

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "blob.dat",
        });

        expect(result).toEqual({
          kind: "binary",
          relativePath: "blob.dat",
          size: 4,
        });
      }),
    );

    it.effect("serves known image extensions as base64", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const bytes = new Uint8Array([137, 80, 78, 71, 0, 13]);
        yield* fileSystem
          .makeDirectory(path.join(cwd, "assets"), { recursive: true })
          .pipe(Effect.orDie);
        yield* fileSystem.writeFile(path.join(cwd, "assets/logo.png"), bytes).pipe(Effect.orDie);

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "assets/logo.png",
        });

        expect(result).toEqual({
          kind: "image",
          relativePath: "assets/logo.png",
          mimeType: "image/png",
          base64: Buffer.from(bytes).toString("base64"),
          size: bytes.length,
        });
      }),
    );

    it.effect("reports paths with no filesystem entry as missing", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "deleted/TODO.md",
        });

        expect(result).toEqual({
          kind: "missing",
          relativePath: "deleted/TODO.md",
        });
      }),
    );

    it.effect("reports an outside path with nothing there as missing", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "../no-such-file.md",
        });

        expect(result).toEqual({ kind: "missing", relativePath: "../no-such-file.md" });
      }),
    );

    it.effect("serves an image outside the workspace root when its bytes are one", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outside = yield* makeTempDir;
        const cwd = yield* makeTempDir;
        const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
        yield* fileSystem.writeFile(path.join(outside, "shot.png"), bytes).pipe(Effect.orDie);
        const relativePath = path
          .relative(cwd, path.join(outside, "shot.png"))
          .replaceAll("\\", "/");

        const result = yield* workspaceFileSystem.readFile({ cwd, relativePath });

        expect(result).toEqual({
          kind: "image",
          relativePath,
          mimeType: "image/png",
          base64: Buffer.from(bytes).toString("base64"),
          size: bytes.length,
        });
      }),
    );

    it.effect("reads a text file outside the project by its absolute path", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outside = yield* makeTempDir;
        const cwd = yield* makeTempDir;
        const filePath = path.join(outside, "notes.md");
        yield* fileSystem.writeFileString(filePath, "# Notes\n").pipe(Effect.orDie);

        const result = yield* workspaceFileSystem.readFile({ cwd, relativePath: filePath });

        expect(result).toEqual({
          kind: "text",
          relativePath: filePath,
          content: "# Notes\n",
          size: 8,
          truncated: false,
          contentHash: sha256HexOf("# Notes\n"),
        });
      }),
    );

    it.effect("never serves an outside .png that isn't one as a picture", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outside = yield* makeTempDir;
        const cwd = yield* makeTempDir;
        const filePath = path.join(outside, "not-really.png");
        yield* fileSystem.writeFileString(filePath, "#!/bin/sh\nrm -rf /\n").pipe(Effect.orDie);

        const result = yield* workspaceFileSystem.readFile({ cwd, relativePath: filePath });

        // It reads as the text it is.
        expect(result.kind).toBe("text");
      }),
    );

    it.effect("treats a symlink that leaves the project as outside it", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outside = yield* makeTempDir;
        const cwd = yield* makeTempDir;
        const realFile = path.join(outside, "settings.json");
        yield* fileSystem.writeFileString(realFile, "{}\n").pipe(Effect.orDie);
        const symlinkCreated = yield* fileSystem
          .symlink(realFile, path.join(cwd, "link.json"))
          .pipe(
            Effect.as(true),
            Effect.catch((error) =>
              isUnavailableWindowsSymlink(error) ? Effect.succeed(false) : Effect.fail(error),
            ),
          );
        if (!symlinkCreated) return;

        const written = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "link.json",
          contents: '{"a":1}\n',
          expectedContentHash: sha256HexOf("{}\n"),
        });

        // Saved like any file outside the project: the original was kept, the
        // file behind the link changed, and the link is still a link.
        expect(written).toMatchObject({ kind: "written", original: expect.any(Object) });
        expect(yield* fileSystem.readFileString(realFile)).toBe('{"a":1}\n');
        expect(yield* fileSystem.readLink(path.join(cwd, "link.json"))).toBe(realFile);
      }),
    );

    it.effect("rejects directory reads", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/main.ts", "export {};\n");

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "src",
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("WorkspaceFileSystemError");
      }),
    );
  });

  describe("files outside the project", () => {
    const makeOutsideFile = (contents: string | Uint8Array, name = "settings.conf") =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outside = yield* makeTempDir;
        const cwd = yield* makeTempDir;
        const filePath = path.join(outside, name);
        if (typeof contents === "string") {
          yield* fileSystem.writeFileString(filePath, contents).pipe(Effect.orDie);
        } else {
          yield* fileSystem.writeFile(filePath, contents).pipe(Effect.orDie);
        }
        return { cwd, filePath };
      });

    it.effect("keeps the original before the first save, and puts it back", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig;
        const { cwd, filePath } = yield* makeOutsideFile("a=1\n");

        const first = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: filePath,
          contents: "a=2\n",
          expectedContentHash: sha256HexOf("a=1\n"),
        });
        expect(first).toMatchObject({ kind: "written", original: { savedAt: expect.any(String) } });
        // A second save keeps the first original, not the in-between version.
        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: filePath,
          contents: "a=3\n",
          expectedContentHash: sha256HexOf("a=2\n"),
        });
        const reread = yield* workspaceFileSystem.readFile({ cwd, relativePath: filePath });
        expect(reread).toMatchObject({
          kind: "text",
          content: "a=3\n",
          original: expect.any(Object),
        });

        // Originals can hold secrets, so only this user can read them.
        if (process.platform !== "win32") {
          const folder = yield* fileSystem.stat(path.join(config.stateDir, "file-originals"));
          expect(folder.mode & 0o077).toBe(0);
          for (const name of yield* fileSystem.readDirectory(
            path.join(config.stateDir, "file-originals"),
          )) {
            const stat = yield* fileSystem.stat(path.join(config.stateDir, "file-originals", name));
            expect(stat.mode & 0o077).toBe(0);
          }
        }

        const restored = yield* workspaceFileSystem.restoreOriginal({
          cwd,
          relativePath: filePath,
          expectedContentHash: sha256HexOf("a=3\n"),
        });
        expect(restored).toEqual({
          kind: "restored",
          relativePath: filePath,
          content: "a=1\n",
          contentHash: sha256HexOf("a=1\n"),
          size: 4,
        });
        expect(yield* fileSystem.readFileString(filePath)).toBe("a=1\n");
        // Restored, it is back to having no original until the next save.
        const afterRestore = yield* workspaceFileSystem.readFile({ cwd, relativePath: filePath });
        expect(afterRestore).not.toHaveProperty("original");
        expect(
          yield* workspaceFileSystem.restoreOriginal({
            cwd,
            relativePath: filePath,
            expectedContentHash: sha256HexOf("a=1\n"),
          }),
        ).toEqual({ kind: "unavailable", relativePath: filePath });
      }),
    );

    it.effect("empties a file, and puts back one that started empty", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const filled = yield* makeOutsideFile("a=1\n");
        const emptied = yield* workspaceFileSystem.writeFile({
          cwd: filled.cwd,
          relativePath: filled.filePath,
          contents: "",
          expectedContentHash: sha256HexOf("a=1\n"),
        });
        expect(emptied).toMatchObject({ kind: "written", contentHash: sha256HexOf("") });
        expect(yield* fileSystem.readFileString(filled.filePath)).toBe("");

        const blank = yield* makeOutsideFile("", "blank.conf");
        yield* workspaceFileSystem.writeFile({
          cwd: blank.cwd,
          relativePath: blank.filePath,
          contents: "x\n",
          expectedContentHash: sha256HexOf(""),
        });
        const restored = yield* workspaceFileSystem.restoreOriginal({
          cwd: blank.cwd,
          relativePath: blank.filePath,
          expectedContentHash: sha256HexOf("x\n"),
        });
        expect(restored).toMatchObject({ kind: "restored", content: "" });
        expect(yield* fileSystem.readFileString(blank.filePath)).toBe("");
      }),
    );

    it.effect("won't restore over a version the caller hasn't seen", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const { cwd, filePath } = yield* makeOutsideFile("a=1\n");
        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: filePath,
          contents: "a=2\n",
          expectedContentHash: sha256HexOf("a=1\n"),
        });
        // An agent changes it after the editor's last look.
        yield* fileSystem.writeFileString(filePath, "a=agent\n");

        const result = yield* workspaceFileSystem.restoreOriginal({
          cwd,
          relativePath: filePath,
          expectedContentHash: sha256HexOf("a=2\n"),
        });

        expect(result).toMatchObject({ kind: "conflict", content: "a=agent\n" });
        expect(yield* fileSystem.readFileString(filePath)).toBe("a=agent\n");
      }),
    );

    it.effect("only saves over a file that exists, from the version it was edited from", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const path = yield* Path.Path;
        const { cwd, filePath } = yield* makeOutsideFile("a=1\n");

        const created = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: path.join(path.dirname(filePath), "new.conf"),
            contents: "x\n",
            expectedContentHash: sha256HexOf(""),
          })
          .pipe(Effect.flip);
        expect(created._tag).toBe("WorkspacePathOutsideRootError");

        const unguarded = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: filePath, contents: "a=2\n" })
          .pipe(Effect.flip);
        expect(unguarded._tag).toBe("WorkspaceFileSystemError");
      }),
    );

    it.effect("counts a new file behind a link that leaves the project as outside", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outside = yield* makeTempDir;
        const cwd = yield* makeTempDir;
        const linked = yield* fileSystem.symlink(outside, path.join(cwd, "docs")).pipe(
          Effect.andThen(
            fileSystem.symlink(path.join(outside, "gone.md"), path.join(cwd, "dead.md")),
          ),
          Effect.as(true),
          Effect.catch((error) =>
            isUnavailableWindowsSymlink(error) ? Effect.succeed(false) : Effect.fail(error),
          ),
        );
        if (!linked) return;

        // Neither a folder link nor a link to nothing may create a file
        // outside the project.
        for (const relativePath of ["docs/new.md", "dead.md"]) {
          const error = yield* workspaceFileSystem
            .writeFile({ cwd, relativePath, contents: "x\n" })
            .pipe(Effect.flip);
          expect(error._tag).toBe("WorkspacePathOutsideRootError");
        }
        expect(yield* fileSystem.readDirectory(outside)).toEqual([]);
      }),
    );

    it.effect("clears what a cut-short save left behind", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig;
        const folder = path.join(config.stateDir, "file-originals");
        yield* fileSystem.makeDirectory(folder, { recursive: true });
        // A copy whose record never landed, and a temp file never renamed.
        const stale = ["cut-short.orig", "cut-short.orig.1234.tmp"];
        for (const name of [...stale, "in-progress.orig.5678.tmp"]) {
          yield* fileSystem.writeFileString(path.join(folder, name), "secret");
        }
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        for (const name of stale) {
          yield* fileSystem.utimes(path.join(folder, name), twoHoursAgo, twoHoursAgo);
        }
        const { cwd, filePath } = yield* makeOutsideFile("a=1\n");

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: filePath,
          contents: "a=2\n",
          expectedContentHash: sha256HexOf("a=1\n"),
        });

        const left = yield* fileSystem.readDirectory(folder);
        expect(left).toContain("in-progress.orig.5678.tmp");
        for (const name of stale) expect(left).not.toContain(name);
      }),
    );

    it.effect("blocks editing text a UTF-8 save would garble, and keeps a BOM", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        // "café" in Windows-1252.
        const latin = yield* makeOutsideFile(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]));
        const latinRead = yield* workspaceFileSystem.readFile({
          cwd: latin.cwd,
          relativePath: latin.filePath,
        });
        expect(latinRead).toMatchObject({ kind: "text", editBlock: "encoding" });
        const latinSave = yield* workspaceFileSystem
          .writeFile({
            cwd: latin.cwd,
            relativePath: latin.filePath,
            contents: "cafe\n",
            expectedContentHash: latinRead.kind === "text" ? latinRead.contentHash : "",
          })
          .pipe(Effect.flip);
        expect(latinSave._tag).toBe("WorkspaceFileSystemError");

        const bomBytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0a]);
        const bom = yield* makeOutsideFile(bomBytes);
        const bomRead = yield* workspaceFileSystem.readFile({
          cwd: bom.cwd,
          relativePath: bom.filePath,
        });
        expect(bomRead).toMatchObject({ kind: "text", content: "﻿hi\n" });
        expect(bomRead).not.toHaveProperty("editBlock");
        if (bomRead.kind !== "text") return;
        yield* workspaceFileSystem.writeFile({
          cwd: bom.cwd,
          relativePath: bom.filePath,
          contents: bomRead.content,
          expectedContentHash: bomRead.contentHash,
        });
        expect(Buffer.from(yield* fileSystem.readFile(bom.filePath))).toEqual(
          Buffer.from(bomBytes),
        );
      }),
    );

    it.effect("says when the system won't let a file be changed", () =>
      Effect.gen(function* () {
        // Root can write anything, and Windows has no mode bits to set.
        if (process.platform === "win32" || process.getuid?.() === 0) return;
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const { cwd, filePath } = yield* makeOutsideFile("locked\n");
        yield* fileSystem.chmod(filePath, 0o444);

        const result = yield* workspaceFileSystem.readFile({ cwd, relativePath: filePath });

        expect(result).toMatchObject({ kind: "text", editBlock: "read-only" });
      }),
    );

    it.effect("serves an outside SVG as a picture, and its source when asked", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>\n';
        const { cwd, filePath } = yield* makeOutsideFile(svg, "logo.svg");

        const picture = yield* workspaceFileSystem.readFile({ cwd, relativePath: filePath });
        const source = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: filePath,
          as: "text",
        });

        expect(picture).toMatchObject({ kind: "image", mimeType: "image/svg+xml" });
        expect(source).toMatchObject({ kind: "text", content: svg });
      }),
    );
  });

  describe("saves", () => {
    it.effect("take turns, so two saves from one version can't both land", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "shared.md", "base\n");

        const results = yield* Effect.all(
          ["first\n", "second\n"].map((contents) =>
            workspaceFileSystem.writeFile({
              cwd,
              relativePath: "shared.md",
              contents,
              expectedContentHash: sha256HexOf("base\n"),
            }),
          ),
          { concurrency: "unbounded" },
        );

        expect(results.map((result) => result.kind).toSorted()).toEqual(["conflict", "written"]);
      }),
    );

    it.effect("refuse more than 1 MB", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "huge.txt",
            contents: "x".repeat(PROJECT_WRITE_FILE_MAX_BYTES + 1),
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("WorkspaceFileSystemError");
      }),
    );
  });

  describe("documents", () => {
    it.effect("serves a PDF only to clients that can show one", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const bytes = new Uint8Array([...Buffer.from("%PDF-1.7\n%", "latin1"), 0xe2, 0, 0x01]);
        yield* fileSystem.writeFile(path.join(cwd, "spec.pdf"), bytes).pipe(Effect.orDie);
        yield* writeTextFile(cwd, "fake.pdf", "not a pdf\n");

        const shown = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "spec.pdf",
          documents: true,
        });
        const older = yield* workspaceFileSystem.readFile({ cwd, relativePath: "spec.pdf" });
        const fake = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "fake.pdf",
          documents: true,
        });

        expect(shown).toEqual({
          kind: "document",
          relativePath: "spec.pdf",
          mimeType: "application/pdf",
          base64: Buffer.from(bytes).toString("base64"),
          size: bytes.length,
        });
        expect(older.kind).toBe("binary");
        expect(fake.kind).toBe("binary");
      }),
    );
  });
});
