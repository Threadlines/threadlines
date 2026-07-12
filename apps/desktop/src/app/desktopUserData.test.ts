import { assert, describe, it } from "@effect/vitest";
import * as NodePath from "node:path";

import {
  readDesktopUserDataConfigFromEnv,
  resolveDesktopUserDataLocation,
  resolveDesktopUserDataPath,
  type DesktopUserDataConfig,
} from "./desktopUserData.ts";

const path = NodePath.posix;

const baseConfig: DesktopUserDataConfig = {
  isDevelopment: false,
  windowsAppDataDirectory: undefined,
  xdgConfigHome: undefined,
  appDataDirectoryOverride: undefined,
  userDataDirNameOverride: undefined,
};

const resolveLocation = (input: {
  readonly platform?: NodeJS.Platform;
  readonly config?: Partial<DesktopUserDataConfig>;
}) =>
  resolveDesktopUserDataLocation({
    platform: input.platform ?? "darwin",
    homeDirectory: "/Users/alice",
    config: { ...baseConfig, ...input.config },
    path,
  });

describe("readDesktopUserDataConfigFromEnv", () => {
  it("trims values and follows the THREADLINES → BADCODE → T3CODE alias order", () => {
    const config = readDesktopUserDataConfigFromEnv({
      VITE_DEV_SERVER_URL: "http://localhost:5173",
      THREADLINES_DESKTOP_APP_DATA_DIR: " /tmp/studio-app-data ",
      BADCODE_DESKTOP_APP_DATA_DIR: "/tmp/ignored",
      BADCODE_DESKTOP_USER_DATA_DIR_NAME: " threadlines-marketing-studio ",
      APPDATA: " C:/Users/alice/AppData/Roaming ",
      XDG_CONFIG_HOME: " /home/alice/.config ",
    });

    assert.deepEqual(config, {
      isDevelopment: true,
      windowsAppDataDirectory: "C:/Users/alice/AppData/Roaming",
      xdgConfigHome: "/home/alice/.config",
      appDataDirectoryOverride: "/tmp/studio-app-data",
      userDataDirNameOverride: "threadlines-marketing-studio",
    });
  });

  it("only treats a parsable dev-server URL as development", () => {
    assert.equal(readDesktopUserDataConfigFromEnv({}).isDevelopment, false);
    assert.equal(
      readDesktopUserDataConfigFromEnv({ VITE_DEV_SERVER_URL: "   " }).isDevelopment,
      false,
    );
    assert.equal(
      readDesktopUserDataConfigFromEnv({ VITE_DEV_SERVER_URL: "not a url" }).isDevelopment,
      false,
    );
  });
});

describe("resolveDesktopUserDataLocation", () => {
  it("uses platform default profile roots", () => {
    assert.equal(
      resolveLocation({ platform: "darwin" }).appDataDirectory,
      "/Users/alice/Library/Application Support",
    );
    assert.equal(
      resolveLocation({
        platform: "win32",
        config: { windowsAppDataDirectory: "/win/appdata" },
      }).appDataDirectory,
      "/win/appdata",
    );
    assert.equal(
      resolveLocation({ platform: "win32" }).appDataDirectory,
      "/Users/alice/AppData/Roaming",
    );
    assert.equal(
      resolveLocation({
        platform: "linux",
        config: { xdgConfigHome: "/home/alice/.config" },
      }).appDataDirectory,
      "/home/alice/.config",
    );
    assert.equal(resolveLocation({ platform: "linux" }).appDataDirectory, "/Users/alice/.config");
  });

  it("prefers an explicit app-data directory override on any platform", () => {
    assert.equal(
      resolveLocation({
        platform: "darwin",
        config: { appDataDirectoryOverride: "/tmp/studio-app-data" },
      }).appDataDirectory,
      "/tmp/studio-app-data",
    );
  });

  it("derives release and development directory names", () => {
    assert.deepEqual(resolveLocation({}), {
      appDataDirectory: "/Users/alice/Library/Application Support",
      userDataDirName: "threadlines",
      legacyUserDataDirName: "badcode",
    });
    assert.deepEqual(resolveLocation({ config: { isDevelopment: true } }), {
      appDataDirectory: "/Users/alice/Library/Application Support",
      userDataDirName: "threadlines-dev",
      legacyUserDataDirName: "badcode-dev",
    });
  });

  it("honors a safe development dir-name override and ignores unsafe ones", () => {
    assert.equal(
      resolveLocation({
        config: { isDevelopment: true, userDataDirNameOverride: "threadlines-marketing-studio" },
      }).userDataDirName,
      "threadlines-marketing-studio",
    );
    for (const unsafe of ["../outside", ".", "..", "a/b"]) {
      assert.equal(
        resolveLocation({
          config: { isDevelopment: true, userDataDirNameOverride: unsafe },
        }).userDataDirName,
        "threadlines-dev",
      );
    }
    assert.equal(
      resolveLocation({
        config: { isDevelopment: false, userDataDirNameOverride: "threadlines-marketing-studio" },
      }).userDataDirName,
      "threadlines",
    );
  });
});

describe("resolveDesktopUserDataPath", () => {
  it("keeps using the legacy userData path when it already exists", () => {
    const userDataPath = resolveDesktopUserDataPath({
      location: resolveLocation({}),
      path,
      directoryExists: (candidate) =>
        candidate === "/Users/alice/Library/Application Support/badcode",
    });

    assert.equal(userDataPath, "/Users/alice/Library/Application Support/badcode");
  });

  it("isolates development user data under an explicit app-data directory", () => {
    const userDataPath = resolveDesktopUserDataPath({
      location: resolveLocation({
        config: {
          isDevelopment: true,
          appDataDirectoryOverride: "/tmp/studio-app-data",
          userDataDirNameOverride: "threadlines-marketing-studio",
        },
      }),
      path,
      directoryExists: () => false,
    });

    assert.equal(userDataPath, "/tmp/studio-app-data/threadlines-marketing-studio");
  });
});
