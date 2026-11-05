#!/usr/bin/env node
/**
 * Writes the WinGet manifests for a stable Windows release: the version,
 * installer and en-US locale files that `komac submit` sends to
 * microsoft/winget-pkgs. winget.yml runs it after release.yml publishes a
 * stable release. The listing text below is what `winget search` and
 * `winget show` print, so it follows the copy rules for the site.
 */
import { createHash } from "node:crypto";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { stringify as stringifyYaml } from "yaml";

import { APP_THREAD_LINK_SCHEMES } from "@threadlines/shared/appThreadLinks";
import { DESKTOP_RELEASE_APP_ID } from "@threadlines/shared/desktopIdentity";

export const WINGET_PACKAGE_IDENTIFIER = "Threadlines.Threadlines";
const WINGET_MANIFEST_VERSION = "1.28.0";
const RELEASES_URL = "https://github.com/Threadlines/threadlines/releases/download";
const SITE_URL = "https://www.threadlines.dev";

/** electron-builder names its NSIS uninstall entry with a v5 UUID of the app id in this namespace. */
const ELECTRON_BUILDER_UUID_NAMESPACE = "50e065bc-3134-11e6-9bab-38c9862bdaf3";

export interface WingetRelease {
  /** Plain stable version, like `0.9.0`. */
  readonly version: string;
  /** SHA-256 of `Threadlines-<version>-win-x64.exe`, hex. */
  readonly installerSha256: string;
  /** The day the GitHub release was published, `YYYY-MM-DD`. */
  readonly releaseDate: string;
}

export interface WingetManifestFile {
  readonly fileName: string;
  readonly content: string;
}

/**
 * The uninstall entry the Windows installer registers for `appId`. winget
 * matches an existing install to the package by it, so `winget upgrade` finds
 * installs that came from the website too.
 */
export function electronBuilderProductCode(appId: string): string {
  const namespace = Buffer.from(ELECTRON_BUILDER_UUID_NAMESPACE.replaceAll("-", ""), "hex");
  const hash = createHash("sha1").update(namespace).update(appId, "utf8").digest();
  hash.writeUInt8((hash.readUInt8(6) & 0x0f) | 0x50, 6);
  hash.writeUInt8((hash.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = hash.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function manifestFile(
  fileName: string,
  schema: string,
  manifest: Record<string, unknown>,
): WingetManifestFile {
  return {
    fileName,
    content: `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${schema}.${WINGET_MANIFEST_VERSION}.schema.json\n\n${stringifyYaml(manifest, { lineWidth: 0 })}`,
  };
}

/** The three manifests winget-pkgs needs for one version of the package. */
export function wingetManifests(release: WingetRelease): ReadonlyArray<WingetManifestFile> {
  const header = {
    PackageIdentifier: WINGET_PACKAGE_IDENTIFIER,
    PackageVersion: release.version,
  };
  return [
    manifestFile(`${WINGET_PACKAGE_IDENTIFIER}.yaml`, "version", {
      ...header,
      DefaultLocale: "en-US",
      ManifestType: "version",
      ManifestVersion: WINGET_MANIFEST_VERSION,
    }),
    manifestFile(`${WINGET_PACKAGE_IDENTIFIER}.installer.yaml`, "installer", {
      ...header,
      // electron-builder's one-click NSIS installer, per user. `--updated`
      // is how electron-builder tells it an install is an upgrade.
      InstallerType: "nullsoft",
      Scope: "user",
      InstallerSwitches: { Upgrade: "--updated" },
      UpgradeBehavior: "install",
      Protocols: [APP_THREAD_LINK_SCHEMES.latest],
      ProductCode: electronBuilderProductCode(DESKTOP_RELEASE_APP_ID),
      ReleaseDate: release.releaseDate,
      Installers: [
        {
          Architecture: "x64",
          InstallerUrl: `${RELEASES_URL}/v${release.version}/Threadlines-${release.version}-win-x64.exe`,
          InstallerSha256: release.installerSha256.toUpperCase(),
        },
      ],
      ManifestType: "installer",
      ManifestVersion: WINGET_MANIFEST_VERSION,
    }),
    manifestFile(`${WINGET_PACKAGE_IDENTIFIER}.locale.en-US.yaml`, "defaultLocale", {
      ...header,
      PackageLocale: "en-US",
      Publisher: "Threadlines",
      PublisherUrl: `${SITE_URL}/`,
      PublisherSupportUrl: "https://github.com/Threadlines/threadlines/issues",
      PackageName: "Threadlines",
      PackageUrl: `${SITE_URL}/`,
      License: "MIT",
      LicenseUrl: "https://github.com/Threadlines/threadlines/blob/main/LICENSE",
      ShortDescription: "Desktop app for Claude Code, Codex and other coding agents.",
      Description: [
        "Threadlines runs the coding agents you already use, like Claude Code, Codex, OpenCode and Cursor, from one desktop app.",
        "Two agents can work in the same thread, so one can review the other's changes.",
        "Pull requests, CI checks, a browser and Git sit beside the chat, and each thread can get its own Git worktree.",
        "It uses your existing agent sign-ins. There's no Threadlines account.",
      ].join("\n"),
      Moniker: "threadlines",
      Tags: [
        "ai",
        "claude-code",
        "codex",
        "coding-agent",
        "cursor",
        "developer-tools",
        "git",
        "opencode",
      ],
      ReleaseNotesUrl: `${SITE_URL}/changelog/v${release.version}`,
      ManifestType: "defaultLocale",
      ManifestVersion: WINGET_MANIFEST_VERSION,
    }),
  ];
}

/** Writes the manifests under `<outDir>/manifests/t/Threadlines/Threadlines/<version>/`, winget-pkgs' layout. */
export const writeWingetManifests = Effect.fn("writeWingetManifests")(function* (
  release: WingetRelease,
  outDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const versionDir = path.resolve(
    outDir,
    "manifests",
    "t",
    ...WINGET_PACKAGE_IDENTIFIER.split("."),
    release.version,
  );
  yield* fs.makeDirectory(versionDir, { recursive: true });
  for (const file of wingetManifests(release)) {
    yield* fs.writeFileString(path.join(versionDir, file.fileName), file.content);
  }
  return versionDir;
});

export const wingetManifestsCommand = Command.make(
  "winget-manifests",
  {
    version: Flag.String("version").pipe(
      Flag.withSchema(Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/))),
      Flag.withDescription("Stable release version, like 0.9.0."),
    ),
    installerSha256: Flag.String("installer-sha256").pipe(
      Flag.withSchema(Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{64}$/))),
      Flag.withDescription("SHA-256 of the release's Windows installer."),
    ),
    releaseDate: Flag.String("release-date").pipe(
      Flag.withSchema(Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))),
      Flag.withDescription("The day the release was published, YYYY-MM-DD."),
    ),
    outDir: Flag.String("out").pipe(Flag.withDescription("Folder to write the manifests into.")),
  },
  ({ outDir, ...release }) =>
    writeWingetManifests(release, outDir).pipe(
      Effect.flatMap((versionDir) => Effect.log(`Wrote WinGet manifests to ${versionDir}`)),
    ),
).pipe(Command.withDescription("Write the WinGet manifests for a stable Windows release."));

if (import.meta.main) {
  Command.run(wingetManifestsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
