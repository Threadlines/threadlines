import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Command, CliError } from "effect/cli";
import { parse as parseYaml } from "yaml";

import { wingetManifestsCommand } from "./winget-manifests.ts";

const runCli = Command.runWith(wingetManifestsCommand, { version: "0.0.0" });
const SHA256 = "b7d0479a548a785dbb5a7b2d5d403b489dcf1a78834c477c109ec4c5d30255a8";

it.layer(NodeServices.layer)("winget-manifests cli", (it) => {
  it.effect("writes one package version in winget-pkgs' layout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outDir = yield* fs.makeTempDirectoryScoped({ prefix: "winget-manifests-cli-" });

      yield* runCli([
        "--version",
        "0.9.0",
        "--installer-sha256",
        SHA256,
        "--release-date",
        "2026-11-06",
        "--out",
        outDir,
      ]);

      const versionDir = path.join(outDir, "manifests/t/Threadlines/Threadlines/0.9.0");
      const manifests = new Map<string, Record<string, unknown>>();
      for (const fileName of yield* fs.readDirectory(versionDir)) {
        const content = yield* fs.readFileString(path.join(versionDir, fileName));
        assert.ok(content.startsWith("# yaml-language-server: $schema=https://aka.ms/winget-"));
        manifests.set(fileName, parseYaml(content));
      }

      assert.deepStrictEqual(
        [...manifests.entries()]
          .map(([fileName, manifest]) => [
            fileName,
            manifest.PackageIdentifier,
            manifest.PackageVersion,
            manifest.ManifestType,
          ])
          .toSorted(([a], [b]) => String(a).localeCompare(String(b))),
        [
          [
            "Threadlines.Threadlines.installer.yaml",
            "Threadlines.Threadlines",
            "0.9.0",
            "installer",
          ],
          [
            "Threadlines.Threadlines.locale.en-US.yaml",
            "Threadlines.Threadlines",
            "0.9.0",
            "defaultLocale",
          ],
          ["Threadlines.Threadlines.yaml", "Threadlines.Threadlines", "0.9.0", "version"],
        ],
      );
      const installer = manifests.get("Threadlines.Threadlines.installer.yaml");
      assert.equal(installer?.ReleaseDate, "2026-11-06");
      // The uninstall entry every install so far registered. If it changed,
      // winget would stop matching installs to the package.
      assert.equal(installer?.ProductCode, "a94f47f8-9cf3-5101-967f-32696ecbfc60");
      assert.deepStrictEqual(installer?.Installers, [
        {
          Architecture: "x64",
          InstallerUrl:
            "https://github.com/Threadlines/threadlines/releases/download/v0.9.0/Threadlines-0.9.0-win-x64.exe",
          InstallerSha256: SHA256.toUpperCase(),
        },
      ]);
    }),
  );

  it.effect("refuses a checksum that isn't SHA-256", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outDir = yield* fs.makeTempDirectoryScoped({ prefix: "winget-manifests-cli-" });

      const error = yield* runCli([
        "--version",
        "0.9.0",
        "--installer-sha256",
        "abc123",
        "--release-date",
        "2026-11-06",
        "--out",
        outDir,
      ]).pipe(Effect.flip);

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      const flagError =
        error._tag === "ShowHelp" ? (error.errors[0] as CliError.CliError | undefined) : error;
      if (!flagError || flagError._tag !== "InvalidValue") {
        assert.fail(`Expected InvalidValue, got ${String(flagError?._tag)}`);
      }
      assert.equal(flagError.option, "installer-sha256");
      assert.deepStrictEqual(yield* fs.readDirectory(outDir), []);
    }),
  );
});
