import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  createStagePackageJson,
  createBuildConfig,
  resolveGitHubPublishConfig,
  resolveDesktopRuntimeDependencies,
  resolveBuildOptions,
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  resolveDesktopUpdateChannel,
  resolveMockUpdateServerPort,
  resolveMockUpdateServerUrl,
} from "./build-desktop-artifact.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("resolves the dedicated nightly updater channel from nightly versions", () => {
    assert.equal(resolveDesktopUpdateChannel("0.0.17-nightly.20260413.42"), "nightly");
    assert.equal(resolveDesktopUpdateChannel("0.0.17"), "latest");
  });

  it("uses one desktop packaging product name across release channels", () => {
    assert.equal(resolveDesktopProductName("0.0.17"), "Threadlines");
    assert.equal(resolveDesktopProductName("0.0.17-nightly.20260413.42"), "Threadlines");
  });

  it("uses one desktop packaging icon set across release channels", () => {
    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17"), {
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    });

    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42"), {
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    });
  });

  it("omits bundled workspace packages from staged desktop dependencies", () => {
    assert.deepStrictEqual(
      resolveDesktopRuntimeDependencies(
        {
          "@effect/platform-node": "catalog:",
          "@threadlines/contracts": "workspace:*",
          "@threadlines/shared": "workspace:*",
          "@threadlines/ssh": "workspace:*",
          "@threadlines/tailscale": "workspace:*",
          effect: "catalog:",
          electron: "41.5.0",
        },
        {
          "@effect/platform-node": "4.0.0-beta.59",
          effect: "4.0.0-beta.59",
        },
      ),
      {
        "@effect/platform-node": "4.0.0-beta.59",
        effect: "4.0.0-beta.59",
      },
    );
  });

  it("falls back to the default mock update port when the configured port is blank", () => {
    assert.equal(resolveMockUpdateServerUrl(undefined), "http://localhost:3000");
    assert.equal(resolveMockUpdateServerUrl(4123), "http://localhost:4123");
  });

  it.effect("normalizes mock update server ports from env-style strings", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveMockUpdateServerPort(undefined), undefined);
      assert.equal(yield* resolveMockUpdateServerPort(""), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("   "), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("4123"), 4123);
    }),
  );

  it.effect("rejects non-numeric or out-of-range mock update ports", () =>
    Effect.gen(function* () {
      const invalidPorts = ["abc", "12.5", "0", "65536"];
      for (const port of invalidPorts) {
        const exit = yield* Effect.exit(resolveMockUpdateServerPort(port));
        assert.equal(exit._tag, "Failure");
      }
    }),
  );

  it.effect("keeps Windows executable resource editing enabled for unsigned builds", () =>
    Effect.gen(function* () {
      const buildConfig = yield* createBuildConfig("win", "nsis", "0.0.2", false, false, undefined);
      const winConfig = buildConfig.win as Record<string, unknown>;

      assert.equal(winConfig.icon, "icon.ico");
      assert.equal(winConfig.signExecutable, undefined);
      assert.equal(winConfig.signAndEditExecutable, undefined);
      assert.deepStrictEqual(buildConfig.extraResources, [
        {
          from: "apps/desktop/resources/icon.ico",
          to: "icon.ico",
        },
      ]);
    }),
  );

  it.effect("ad-hoc signs unsigned macOS artifacts for Squirrel updater validation", () =>
    Effect.gen(function* () {
      const buildConfig = yield* createBuildConfig("mac", "dmg", "0.0.19", false, false, undefined);
      const macConfig = buildConfig.mac as Record<string, unknown>;

      assert.deepStrictEqual(macConfig.target, ["dmg", "zip"]);
      assert.equal(macConfig.identity, "-");
      assert.equal(macConfig.hardenedRuntime, false);
      assert.equal(macConfig.gatekeeperAssess, false);
      assert.equal(macConfig.notarize, undefined);
    }),
  );

  it.effect("enables hardened runtime and notarization for signed macOS artifacts", () =>
    Effect.gen(function* () {
      const buildConfig = yield* createBuildConfig("mac", "dmg", "0.0.19", true, false, undefined);
      const macConfig = buildConfig.mac as Record<string, unknown>;

      assert.deepStrictEqual(macConfig.target, ["dmg", "zip"]);
      assert.equal(macConfig.identity, undefined);
      assert.equal(macConfig.hardenedRuntime, true);
      assert.equal(macConfig.gatekeeperAssess, true);
      assert.equal(macConfig.entitlements, "apps/desktop/resources/entitlements.mac.plist");
      assert.equal(
        macConfig.entitlementsInherit,
        "apps/desktop/resources/entitlements.mac.inherit.plist",
      );
      assert.equal(macConfig.notarize, false);
      assert.equal(buildConfig.afterSign, "apps/desktop/resources/notarize-after-sign.cjs");
    }),
  );

  it("uses Threadlines identity in staged desktop package metadata", () => {
    const stagePackageJson = createStagePackageJson({
      appVersion: "0.0.7",
      commitHash: "abcdef123456",
      build: { appId: "com.threadlines.app" },
      dependencies: { effect: "4.0.0-beta.59" },
      electronVersion: "41.5.0",
      overrides: { vite: "^8.0.0" },
    });

    assert.equal(stagePackageJson.name, "threadlines");
    assert.equal(stagePackageJson.threadlinesCommitHash, "abcdef123456");
    assert.equal("badcodeCommitHash" in stagePackageJson, false);
    assert.equal("t3codeCommitHash" in stagePackageJson, false);
    assert.equal(stagePackageJson.author, "Threadlines");
  });

  it("prefers the Threadlines update repository env var over legacy and GitHub defaults", () => {
    assert.deepStrictEqual(
      resolveGitHubPublishConfig("latest", {
        THREADLINES_DESKTOP_UPDATE_REPOSITORY: "threadlines/app",
        BADCODE_DESKTOP_UPDATE_REPOSITORY: "badcuban/badcode",
        T3CODE_DESKTOP_UPDATE_REPOSITORY: "legacy/threadlines",
        GITHUB_REPOSITORY: "fallback/repo",
      }),
      {
        provider: "github",
        owner: "threadlines",
        repo: "app",
        private: true,
        releaseType: "release",
      },
    );
  });

  it("falls back to the BadCode update repository env var before T3Code and GitHub defaults", () => {
    assert.deepStrictEqual(
      resolveGitHubPublishConfig("latest", {
        BADCODE_DESKTOP_UPDATE_REPOSITORY: "badcuban/badcode",
        T3CODE_DESKTOP_UPDATE_REPOSITORY: "legacy/threadlines",
        GITHUB_REPOSITORY: "fallback/repo",
      }),
      {
        provider: "github",
        owner: "badcuban",
        repo: "badcode",
        private: true,
        releaseType: "release",
      },
    );
  });

  it("falls back to the legacy update repository env var", () => {
    assert.deepStrictEqual(
      resolveGitHubPublishConfig("nightly", {
        T3CODE_DESKTOP_UPDATE_REPOSITORY: "legacy/threadlines",
        GITHUB_REPOSITORY: "fallback/repo",
      }),
      {
        provider: "github",
        owner: "legacy",
        repo: "threadlines",
        private: true,
        releaseType: "prerelease",
        channel: "nightly",
      },
    );
  });

  it.effect("prefers Threadlines desktop env aliases over BadCode and legacy T3Code aliases", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.none(),
        target: Option.none(),
        arch: Option.none(),
        buildVersion: Option.none(),
        outputDir: Option.none(),
        skipBuild: Option.none(),
        keepStage: Option.none(),
        signed: Option.none(),
        verbose: Option.none(),
        mockUpdates: Option.none(),
        mockUpdateServerPort: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                THREADLINES_DESKTOP_PLATFORM: "linux",
                BADCODE_DESKTOP_PLATFORM: "win",
                T3CODE_DESKTOP_PLATFORM: "mac",
                THREADLINES_DESKTOP_TARGET: "AppImage",
                BADCODE_DESKTOP_TARGET: "nsis",
                T3CODE_DESKTOP_TARGET: "dmg",
                THREADLINES_DESKTOP_ARCH: "arm64",
                BADCODE_DESKTOP_ARCH: "x64",
                T3CODE_DESKTOP_ARCH: "arm64",
                THREADLINES_DESKTOP_VERSION: "0.0.8",
                BADCODE_DESKTOP_VERSION: "0.0.7",
                T3CODE_DESKTOP_VERSION: "0.0.6",
                THREADLINES_DESKTOP_OUTPUT_DIR: "threadlines-release",
                BADCODE_DESKTOP_OUTPUT_DIR: "compat-release",
                T3CODE_DESKTOP_OUTPUT_DIR: "legacy-release",
                THREADLINES_DESKTOP_SKIP_BUILD: "false",
                BADCODE_DESKTOP_SKIP_BUILD: "true",
                T3CODE_DESKTOP_SKIP_BUILD: "false",
              },
            }),
          ),
        ),
      );

      assert.equal(resolved.platform, "linux");
      assert.equal(resolved.target, "AppImage");
      assert.equal(resolved.arch, "arm64");
      assert.equal(resolved.version, "0.0.8");
      assert.equal(resolved.outputDir.endsWith("threadlines-release"), true);
      assert.equal(resolved.skipBuild, false);
    }),
  );

  it.effect("falls back to legacy T3Code desktop env aliases", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.none(),
        target: Option.none(),
        arch: Option.none(),
        buildVersion: Option.none(),
        outputDir: Option.none(),
        skipBuild: Option.none(),
        keepStage: Option.none(),
        signed: Option.none(),
        verbose: Option.none(),
        mockUpdates: Option.none(),
        mockUpdateServerPort: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_PLATFORM: "win",
                T3CODE_DESKTOP_TARGET: "nsis",
                T3CODE_DESKTOP_ARCH: "x64",
                T3CODE_DESKTOP_VERSION: "0.0.6",
                T3CODE_DESKTOP_SKIP_BUILD: "true",
              },
            }),
          ),
        ),
      );

      assert.equal(resolved.platform, "win");
      assert.equal(resolved.target, "nsis");
      assert.equal(resolved.arch, "x64");
      assert.equal(resolved.version, "0.0.6");
      assert.equal(resolved.skipBuild, true);
    }),
  );

  it.effect("preserves explicit false boolean flags over true env defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some("mac"),
        target: Option.none(),
        arch: Option.some("arm64"),
        buildVersion: Option.none(),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                BADCODE_DESKTOP_SKIP_BUILD: "true",
                BADCODE_DESKTOP_KEEP_STAGE: "true",
                BADCODE_DESKTOP_SIGNED: "true",
                BADCODE_DESKTOP_VERBOSE: "true",
                BADCODE_DESKTOP_MOCK_UPDATES: "true",
              },
            }),
          ),
        ),
      );

      assert.equal(resolved.skipBuild, false);
      assert.equal(resolved.keepStage, false);
      assert.equal(resolved.signed, false);
      assert.equal(resolved.verbose, false);
      assert.equal(resolved.mockUpdates, false);
    }),
  );
});
