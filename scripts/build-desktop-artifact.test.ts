import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { DESKTOP_RELEASE_APP_ID } from "@threadlines/shared/desktopIdentity";

import {
  createStagePackageJson,
  createBuildConfig,
  resolveGitHubPublishConfig,
  resolveDesktopRuntimeDependencies,
  resolveBuildOptions,
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  resolveDesktopUpdateChannel,
  filterPatchedDependenciesForStage,
  resolveMockUpdateServerPort,
  resolveMockUpdateServerUrl,
  createDesktopArtifactBuildEnv,
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
      macDarkIconPng: BRAND_ASSET_PATHS.productionMacDarkIconPng,
      macLightIconPng: BRAND_ASSET_PATHS.productionMacLightIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    });

    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42"), {
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
      macDarkIconPng: BRAND_ASSET_PATHS.productionMacDarkIconPng,
      macLightIconPng: BRAND_ASSET_PATHS.productionMacLightIconPng,
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

  it("keeps only staged dependency patches", () => {
    assert.deepStrictEqual(
      filterPatchedDependenciesForStage(
        {
          "@effect/vitest@4.0.0-beta.59": "patches/@effect__vitest@4.0.0-beta.59.patch",
          "effect@4.0.0-beta.59": "patches/effect@4.0.0-beta.59.patch",
        },
        ["effect", "electron"],
      ),
      {
        "effect@4.0.0-beta.59": "patches/effect@4.0.0-beta.59.patch",
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

      assert.equal(buildConfig.appId, DESKTOP_RELEASE_APP_ID);
      assert.equal(winConfig.icon, "icon.ico");
      assert.equal(winConfig.signExecutable, undefined);
      assert.equal(winConfig.signAndEditExecutable, undefined);
      assert.equal(winConfig.azureSignOptions, undefined);
      assert.deepStrictEqual(buildConfig.extraResources, [
        {
          from: "apps/desktop/resources/icon.ico",
          to: "icon.ico",
        },
      ]);
    }),
  );

  it.effect("configures Azure Trusted Signing for signed Windows builds", () =>
    Effect.gen(function* () {
      const buildConfig = yield* createBuildConfig(
        "win",
        "nsis",
        "0.0.2",
        true,
        false,
        undefined,
      ).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                AZURE_TRUSTED_SIGNING_PUBLISHER_NAME: "Wilfredo Leon",
                AZURE_TRUSTED_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net",
                AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME: "threadlinespublic",
                AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: "threadlinessigning",
              },
            }),
          ),
        ),
      );
      const winConfig = buildConfig.win as Record<string, unknown>;

      assert.deepStrictEqual(winConfig.azureSignOptions, {
        publisherName: "Wilfredo Leon",
        endpoint: "https://eus.codesigning.azure.net",
        certificateProfileName: "threadlinespublic",
        codeSigningAccountName: "threadlinessigning",
        fileDigest: "SHA256",
        timestampDigest: "SHA256",
        timestampRfc3161: "http://timestamp.acs.microsoft.com",
      });
    }),
  );

  it.effect("ad-hoc signs unsigned macOS artifacts for Squirrel updater validation", () =>
    Effect.gen(function* () {
      const buildConfig = yield* createBuildConfig("mac", "dmg", "0.0.19", false, false, undefined);
      const macConfig = buildConfig.mac as Record<string, unknown>;

      assert.equal(buildConfig.appId, DESKTOP_RELEASE_APP_ID);
      assert.deepStrictEqual(macConfig.target, ["dmg", "zip"]);
      assert.equal(macConfig.identity, "-");
      assert.equal(macConfig.hardenedRuntime, false);
      assert.equal(macConfig.gatekeeperAssess, false);
      assert.equal(macConfig.notarize, undefined);
      assert.equal(macConfig.extraResources, undefined);
      assert.equal(macConfig.extendInfo, undefined);
    }),
  );

  it.effect("ships the staged adaptive macOS icon when Assets.car was produced", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stageResourcesDir = yield* fs.makeTempDirectoryScoped({
        prefix: "threadlines-adaptive-icon-stage-",
      });
      yield* fs.writeFileString(`${stageResourcesDir}/Assets.car`, "car");

      const buildConfig = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.19",
        false,
        false,
        undefined,
        stageResourcesDir,
      );
      const macConfig = buildConfig.mac as Record<string, unknown>;
      const normalizePath = (value: unknown) => String(value).replaceAll("\\", "/");
      const extraResources = macConfig.extraResources as Array<Record<string, unknown>>;

      assert.equal(extraResources.length, 1);
      assert.equal(
        normalizePath(extraResources[0]?.from),
        `${stageResourcesDir.replaceAll("\\", "/")}/Assets.car`,
      );
      assert.equal(extraResources[0]?.to, "Assets.car");
      assert.deepStrictEqual(macConfig.extendInfo, { CFBundleIconName: "AppIcon" });
    }).pipe(Effect.scoped),
  );

  it.effect("enables hardened runtime and notarization for signed macOS artifacts", () =>
    Effect.gen(function* () {
      const buildConfig = yield* createBuildConfig("mac", "dmg", "0.0.19", true, false, undefined);
      const macConfig = buildConfig.mac as Record<string, unknown>;

      assert.equal(buildConfig.appId, DESKTOP_RELEASE_APP_ID);
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

  it.effect("uses staged absolute resource paths for signed macOS artifact builds", () =>
    Effect.gen(function* () {
      const stageResourcesDir = "/tmp/threadlines-stage/apps/desktop/resources";
      const buildConfig = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.19",
        true,
        false,
        undefined,
        stageResourcesDir,
      );
      const macConfig = buildConfig.mac as Record<string, unknown>;
      const normalizePath = (value: unknown) => String(value).replaceAll("\\", "/");

      assert.equal(
        normalizePath(macConfig.entitlements),
        "/tmp/threadlines-stage/apps/desktop/resources/entitlements.mac.plist",
      );
      assert.equal(
        normalizePath(macConfig.entitlementsInherit),
        "/tmp/threadlines-stage/apps/desktop/resources/entitlements.mac.inherit.plist",
      );
      assert.equal(
        normalizePath(buildConfig.afterSign),
        "/tmp/threadlines-stage/apps/desktop/resources/notarize-after-sign.cjs",
      );
    }),
  );

  it("uses Threadlines branding while preserving release app identity in staged package metadata", () => {
    const stagePackageJson = createStagePackageJson({
      appVersion: "0.0.7",
      commitHash: "abcdef123456",
      build: { appId: DESKTOP_RELEASE_APP_ID },
      dependencies: { effect: "4.0.0-beta.59" },
      electronVersion: "41.5.0",
      overrides: { vite: "^8.0.0" },
    });

    assert.equal(stagePackageJson.name, "threadlines");
    assert.equal(stagePackageJson.threadlinesCommitHash, "abcdef123456");
    assert.equal("badcodeCommitHash" in stagePackageJson, false);
    assert.equal("t3codeCommitHash" in stagePackageJson, false);
    assert.equal(stagePackageJson.author, "Threadlines");
    assert.deepStrictEqual(stagePackageJson.build, { appId: DESKTOP_RELEASE_APP_ID });
    assert.match(stagePackageJson.packageManager, /^pnpm@/u);
  });

  it("injects the artifact version into desktop build-time version env", () => {
    assert.deepStrictEqual(
      createDesktopArtifactBuildEnv("0.0.21-nightly.20260622.128", {
        PATH: "/bin",
        APP_VERSION: "0.0.21-nightly.20260622.127",
      }),
      {
        PATH: "/bin",
        APP_VERSION: "0.0.21-nightly.20260622.128",
        THREADLINES_APP_VERSION: "0.0.21-nightly.20260622.128",
        VITE_APP_VERSION: "0.0.21-nightly.20260622.128",
      },
    );
  });

  it("prefers the Threadlines update repository env var over GitHub defaults", () => {
    assert.deepStrictEqual(
      resolveGitHubPublishConfig("latest", {
        THREADLINES_DESKTOP_UPDATE_REPOSITORY: "threadlines/app",
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

  it("falls back to the GitHub repository env var", () => {
    assert.deepStrictEqual(
      resolveGitHubPublishConfig("latest", {
        BADCODE_DESKTOP_UPDATE_REPOSITORY: "badcuban/badcode",
        T3CODE_DESKTOP_UPDATE_REPOSITORY: "legacy/threadlines",
        GITHUB_REPOSITORY: "fallback/repo",
      }),
      {
        provider: "github",
        owner: "fallback",
        repo: "repo",
        private: true,
        releaseType: "release",
      },
    );
  });

  it("ignores legacy update repository env vars when GitHub repository is absent", () => {
    assert.deepStrictEqual(
      resolveGitHubPublishConfig("nightly", {
        T3CODE_DESKTOP_UPDATE_REPOSITORY: "legacy/threadlines",
      }),
      undefined,
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
