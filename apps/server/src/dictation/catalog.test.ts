import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  DICTATION_MODELS,
  DICTATION_RUNTIME_VERSION,
  dictationModel,
  modelIsReady,
  resolveRuntimePackage,
} from "./catalog.ts";

const SUPPORTED_PLATFORMS: ReadonlyArray<readonly [NodeJS.Platform, string]> = [
  ["win32", "x64"],
  ["darwin", "arm64"],
  ["darwin", "x64"],
  ["linux", "x64"],
  ["linux", "arm64"],
];

it.layer(NodeServices.layer)("dictation catalog", (it) => {
  it.effect("resolves a tarball url for every supported platform", () =>
    Effect.sync(() => {
      for (const [platform, arch] of SUPPORTED_PLATFORMS) {
        const runtimePackage = resolveRuntimePackage(platform, arch);
        assert.isNotNull(runtimePackage, `${platform}-${arch}`);
        assert.equal(
          runtimePackage?.tarballUrl,
          `https://registry.npmjs.org/${runtimePackage?.packageName}/-/${runtimePackage?.packageName}-${DICTATION_RUNTIME_VERSION}.tgz`,
        );
      }
      assert.isNull(resolveRuntimePackage("linux", "ia32"));
      assert.isNull(resolveRuntimePackage("freebsd", "x64"));
    }),
  );

  it.effect("names both models in catalog order", () =>
    Effect.sync(() => {
      assert.deepEqual(
        DICTATION_MODELS.map((entry) => entry.id),
        ["parakeet", "moonshine"],
      );
    }),
  );

  it.effect("treats a model as ready only when every file has its exact size", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "threadlines-dictation-catalog-" });
      const entry = dictationModel("moonshine");
      const modelDir = path.join(dir, "moonshine");
      yield* fs.makeDirectory(modelDir, { recursive: true });

      assert.isFalse(yield* modelIsReady(entry, modelDir));

      // Sized with `truncate` so the fixture costs no real bytes.
      for (const file of entry.files) {
        const filePath = path.join(modelDir, file.name);
        yield* fs.writeFile(filePath, new Uint8Array(0));
        yield* fs.truncate(filePath, file.bytes);
      }
      assert.isTrue(yield* modelIsReady(entry, modelDir));

      // A short file is what an interrupted download leaves behind.
      const short = entry.files[0]!;
      yield* fs.truncate(path.join(modelDir, short.name), short.bytes - 1);
      assert.isFalse(yield* modelIsReady(entry, modelDir));
    }),
  );
});
