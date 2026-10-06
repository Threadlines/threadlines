// @effect-diagnostics nodeBuiltinImport:off - release folders on disk
import * as NodeFS from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { acpRegistryNodes } from "./AcpRegistryNodes.ts";

const tempDir = Effect.acquireRelease(
  Effect.promise(() => NodeFS.mkdtemp(path.join(os.tmpdir(), "threadlines-acp-nodes-"))),
  (dir) => Effect.promise(() => NodeFS.rm(dir, { recursive: true, force: true })),
);

const listDir = (dir: string) =>
  Effect.promise(() => NodeFS.readdir(dir).then((names) => names.toSorted()));

describe("acpRegistryNodes", () => {
  it.live(
    "prunes the Node.js releases no installed agent names, and nothing during an install",
    () =>
      Effect.gen(function* () {
        const toolsDir = yield* tempDir;
        const kept = { version: "24.21.0", assetKey: "darwin-arm64" } as const;
        const makeRelease = (name: string) =>
          Effect.promise(async () => {
            await NodeFS.mkdir(path.join(toolsDir, name, "versions"), { recursive: true });
            await NodeFS.writeFile(path.join(toolsDir, name, "active.json"), "{}");
          });
        yield* makeRelease("24.21.0-darwin-arm64");
        yield* makeRelease("22.22.2-darwin-arm64");
        yield* Effect.promise(() => NodeFS.mkdir(path.join(toolsDir, "not-a-release")));
        const nodes = acpRegistryNodes(toolsDir);
        const everything = ["22.22.2-darwin-arm64", "24.21.0-darwin-arm64", "not-a-release"];

        // While an agent is being installed, every release stays.
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const installing = yield* nodes
          .whileInstalling(
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* nodes.prune(Effect.succeed([kept]));
        assert.deepStrictEqual(yield* listDir(toolsDir), everything);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(installing);

        // Not knowing which agents are installed deletes nothing either.
        yield* nodes.prune(Effect.succeed(undefined));
        assert.deepStrictEqual(yield* listDir(toolsDir), everything);

        yield* nodes.prune(Effect.succeed([kept]));
        assert.deepStrictEqual(yield* listDir(toolsDir), ["24.21.0-darwin-arm64", "not-a-release"]);
      }),
  );
});
