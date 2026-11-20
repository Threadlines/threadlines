import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  findAndroidSdk,
  hubArguments,
  parseHubStartupLine,
  platformReason,
} from "./LocalDeviceHost.ts";

describe("parseHubStartupLine", () => {
  // expo-device-hub 0.22.1 with --require-token prints exactly this (cli.mjs `startupMessage`).
  it("reads the port and token from the pinned hub's Local line", () => {
    expect(
      parseHubStartupLine(
        "  Local:   http://localhost:47811/?token=e0t5_0X1M1GVlfqrVNtbToKqFRKH6Rr0heuytDHo_HY",
      ),
    ).toEqual({ port: 47811, token: "e0t5_0X1M1GVlfqrVNtbToKqFRKH6Rr0heuytDHo_HY" });
  });

  it("ignores every other line, including a Local line without a token", () => {
    expect(parseHubStartupLine("Expo Device Hub ready")).toBeNull();
    expect(parseHubStartupLine("  Local:   http://localhost:47811")).toBeNull();
    expect(
      parseHubStartupLine("  Network: pass --host 0.0.0.0 to expose on your local network"),
    ).toBeNull();
  });
});

describe("hubArguments", () => {
  it("binds loopback and requires the token", () => {
    const args = hubArguments("/tools/cli.mjs", 4000, "darwin");
    expect(args.slice(0, 5)).toEqual(["/tools/cli.mjs", "--port", "4000", "--host", "127.0.0.1"]);
    expect(args).toContain("--require-token");
    expect(args).toContain("--hide-sidebar");
    expect(args).toContain("--hide-boot-device");
    expect(hubArguments("/tools/cli.mjs", 4000, "linux")).toContain("android");
  });
});

describe("platformReason", () => {
  const sdk = {
    root: "/sdk",
    adb: true,
    emulator: true,
    avdmanager: true,
    legacyAvdmanager: false,
    javaHome: "/jdk",
  };

  it("names what is missing in words the user can act on", () => {
    expect(platformReason("ios", "linux", sdk, false)).toBe(
      "iOS Simulators need macOS with Xcode.",
    );
    expect(platformReason("ios", "darwin", sdk, false)).toBe(
      "Xcode command line tools were not found.",
    );
    expect(platformReason("android", "darwin", { ...sdk, avdmanager: false }, true)).toContain(
      "Command-line Tools (latest) are missing from /sdk",
    );
    expect(platformReason("android", "darwin", { ...sdk, root: null }, true)).toContain(
      "Android SDK was not found",
    );
  });

  it("is null when the platform can run", () => {
    expect(platformReason("ios", "darwin", sdk, true)).toBeNull();
    expect(platformReason("android", "darwin", sdk, true)).toBeNull();
  });
});

describe("findAndroidSdk", () => {
  it.live("finds the Java the SDK tools need through JAVA_HOME", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "tl-android-sdk-" });
      const sdkRoot = path.join(base, "sdk");
      const javaHome = path.join(base, "jdk");
      yield* fs.makeDirectory(path.join(sdkRoot, "platform-tools"), { recursive: true });
      yield* fs.writeFileString(path.join(sdkRoot, "platform-tools", "adb"), "");
      yield* fs.makeDirectory(path.join(javaHome, "bin"), { recursive: true });
      yield* fs.writeFileString(path.join(javaHome, "bin", "java"), "");

      const sdk = yield* findAndroidSdk(
        { ANDROID_HOME: sdkRoot, JAVA_HOME: javaHome, HOME: base, PATH: "" },
        "darwin",
      );
      expect(sdk.root).toBe(sdkRoot);
      expect(sdk.javaHome).toBe(javaHome);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
