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
  Layer.provide(
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

        expect(result).toEqual({ relativePath: "plans/effect-rpc.md" });
        expect(saved).toBe("# Plan\n");
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

    it.effect("rejects reads outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "../etc/passwd",
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("WorkspacePathOutsideRootError");
      }),
    );

    it.effect("rejects symlinks that escape the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const outside = yield* makeTempDir;
        const cwd = yield* makeTempDir;
        yield* fileSystem
          .writeFileString(path.join(outside, "secret.txt"), "secret")
          .pipe(Effect.orDie);
        yield* fileSystem
          .symlink(path.join(outside, "secret.txt"), path.join(cwd, "link.txt"))
          .pipe(Effect.orDie);

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: "link.txt",
          })
          .pipe(Effect.flip);

        expect(error._tag).toBe("WorkspacePathOutsideRootError");
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
});
