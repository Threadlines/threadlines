// @effect-diagnostics nodeBuiltinImport:off - builds a tarball fixture
import * as zlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { extractNpmTarball } from "./npmTarball.ts";

const BLOCK_SIZE = 512;

/** Builds a gzipped ustar archive with one 512-byte header per file. */
function makeTarball(entries: ReadonlyArray<{ name: string; contents: string }>): Uint8Array {
  const blocks: Array<Buffer> = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.contents, "utf8");
    const header = Buffer.alloc(BLOCK_SIZE);
    header.write(entry.name, 0, 100, "utf8");
    header.write("000644 \0", 100, 8, "utf8");
    header.write("000000 \0", 108, 8, "utf8");
    header.write("000000 \0", 116, 8, "utf8");
    header.write(`${data.length.toString(8).padStart(11, "0")} `, 124, 12, "utf8");
    header.write("00000000000 ", 136, 12, "utf8");
    header.write("0", 156, 1, "utf8");
    header.write("ustar\0", 257, 6, "utf8");
    header.write("00", 263, 2, "utf8");
    // Checksum is computed over the header with the checksum field blanked.
    header.write(" ".repeat(8), 148, 8, "utf8");
    let checksum = 0;
    for (const byte of header) {
      checksum += byte;
    }
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");

    blocks.push(header);
    const padded = Buffer.alloc(Math.ceil(data.length / BLOCK_SIZE) * BLOCK_SIZE);
    data.copy(padded);
    blocks.push(padded);
  }
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return zlib.gzipSync(Buffer.concat(blocks));
}

const withTempDir = <A, E, R>(run: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "threadlines-npm-tarball-test-" });
    return yield* run(dir);
  });

it.layer(NodeServices.layer)("npmTarball", (it) => {
  it.effect("extracts files and strips the package prefix", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tgzPath = path.join(dir, "runtime.tgz");
        const destDir = path.join(dir, "out");
        yield* fs.writeFile(
          tgzPath,
          makeTarball([
            { name: "package/sherpa-onnx.node", contents: "addon" },
            { name: "package/nested/onnxruntime.dll", contents: "library" },
          ]),
        );

        yield* extractNpmTarball(tgzPath, destDir);

        assert.equal(yield* fs.readFileString(path.join(destDir, "sherpa-onnx.node")), "addon");
        assert.equal(
          yield* fs.readFileString(path.join(destDir, "nested", "onnxruntime.dll")),
          "library",
        );
      }),
    ),
  );

  it.effect("rejects an entry that escapes the destination directory", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tgzPath = path.join(dir, "evil.tgz");
        const destDir = path.join(dir, "out");
        yield* fs.writeFile(
          tgzPath,
          makeTarball([{ name: "package/../../escaped.txt", contents: "nope" }]),
        );

        const error = yield* extractNpmTarball(tgzPath, destDir).pipe(Effect.flip);

        assert.include(error.message, "escapes the destination directory");
        assert.isFalse(yield* fs.exists(path.join(dir, "..", "escaped.txt")));
      }),
    ),
  );
});
