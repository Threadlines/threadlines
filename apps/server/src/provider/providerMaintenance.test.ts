// @effect-diagnostics nodeBuiltinImport:off
import { afterEach, describe, expect, it } from "@effect/vitest";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import os from "node:os";
import path from "node:path";
import { ProviderDriverKind } from "@threadlines/contracts";
import { randomUUIDv4 } from "@threadlines/shared/uuid";
import * as Effect from "effect/Effect";
import {
  clearLatestProviderVersionCacheForTests,
  createProviderVersionAdvisory,
  makePackageManagedProviderMaintenanceResolver,
  makeProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  makeWindowsNativeInstaller,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "./providerMaintenance.ts";

const driver = (value: string) => ProviderDriverKind.make(value);
const noInstallOrManualUpdate = {
  install: null,
  manualUpdateCommand: null,
  advisoryMessage: null,
} as const;
const windowsInstallerCommand = "irm https://example.test/install.ps1 | iex";
const windowsInstallerCommandEncoded = Buffer.from(windowsInstallerCommand, "utf16le").toString(
  "base64",
);
const makeTempDir = Effect.fn("makeTempDir")(function* (name: string) {
  const id = yield* randomUUIDv4;
  return path.join(os.tmpdir(), `${name}-${id}`);
});

const WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const nativeWindowsInstall = makeWindowsNativeInstaller({
  url: "https://example.test/install.ps1",
  lockKey: "package-tool-native",
  environmentPatch: { PACKAGE_TOOL_NON_INTERACTIVE: "1" },
});
const nativeWindowsTool = makePackageManagedProviderMaintenanceResolver({
  provider: driver("packageTool"),
  npmPackageName: "@example/package-tool",
  homebrewFormula: null,
  nativeInstall: { win32: nativeWindowsInstall },
  nativeUpdate: {
    ...nativeWindowsInstall,
    isCommandPath: (value) => value.endsWith("package-tool.exe"),
  },
});

/**
 * Put an executable named `name` in `dir` for the platform the test is
 * actually running on, so PATH lookups behave the way they would in
 * production. Returns the directory, for use as a PATH entry.
 */
function writeCommandShim(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") {
    writeFileSync(path.join(dir, `${name}.cmd`), "@echo off\r\n");
    return dir;
  }
  const commandPath = path.join(dir, name);
  writeFileSync(commandPath, "#!/bin/sh\n");
  chmodSync(commandPath, 0o755);
  return dir;
}

function linkPackageCommand(input: {
  readonly packageBinDir: string;
  readonly packageBinPath: string;
  readonly commandPath: string;
}): void {
  if (process.platform === "win32") {
    symlinkSync(input.packageBinDir, input.commandPath, "junction");
    return;
  }
  symlinkSync(input.packageBinPath, input.commandPath);
}

const isNativeTestCommandPath =
  (expectedPathSegment: string) =>
  (commandPath: string): boolean =>
    normalizeCommandPath(commandPath).includes(expectedPathSegment);
const packageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("packageTool"),
  npmPackageName: "@example/package-tool",
  homebrewFormula: "package-tool",
  nativeUpdate: null,
});
const nativePackageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("nativePackageTool"),
  npmPackageName: "@example/native-package-tool",
  homebrewFormula: "native-package-tool",
  nativeUpdate: {
    executable: "native-package-tool",
    args: ["update"],
    lockKey: "native-package-tool-native",
    isCommandPath: isNativeTestCommandPath("/.local/bin/native-package-tool"),
  },
});
const nativePackageToolPlatformOverrideUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("nativePackageTool"),
  npmPackageName: "@example/native-package-tool",
  homebrewFormula: "native-package-tool",
  nativeUpdate: {
    executable: "native-package-tool",
    args: ["update"],
    lockKey: "native-package-tool-native",
    isCommandPath: isNativeTestCommandPath("/.local/bin/native-package-tool"),
    platformUpdateOverrides: {
      win32: {
        executable: "powershell.exe",
        args: [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          windowsInstallerCommandEncoded,
        ],
        lockKey: "native-package-tool-installer-win32",
        displayCommand: windowsInstallerCommand,
        advisoryMessage:
          "Run the native-package-tool Windows installer instead of native-package-tool update.",
      },
    },
  },
});
const scopedPackageToolUpdate = makePackageManagedProviderMaintenanceResolver({
  provider: driver("scopedPackageTool"),
  npmPackageName: "@example/scoped-package-tool",
  homebrewFormula: "example/tap/scoped-package-tool",
  nativeUpdate: {
    executable: "scoped-package-tool",
    args: ["upgrade"],
    lockKey: "scoped-package-tool-native",
    isCommandPath: isNativeTestCommandPath("/.scoped-package-tool/bin/scoped-package-tool"),
  },
});
const staticToolUpdate = makeStaticProviderMaintenanceResolver(
  makeProviderMaintenanceCapabilities({
    provider: driver("staticTool"),
    packageName: null,
    updateExecutable: "static-tool",
    updateArgs: ["update"],
    updateLockKey: "static-tool",
  }),
);

afterEach(() => {
  clearLatestProviderVersionCacheForTests();
});

describe("providerMaintenance", () => {
  it("installs a missing Windows provider without npm and keeps its native updater", () => {
    const install = nativeWindowsTool.resolve({
      binaryPath: "missing-package-tool",
      platform: "win32",
      env: { PATH: "" },
    }).install;
    expect(install).toMatchObject({
      executable: "powershell.exe",
      lockKey: "package-tool-native",
      environmentPatch: { PACKAGE_TOOL_NON_INTERACTIVE: "1" },
    });
    const encoded = install?.args.at(-1);
    expect(Buffer.from(encoded ?? "", "base64").toString("utf16le")).toContain(
      "irm 'https://example.test/install.ps1' | iex",
    );
    expect(
      nativeWindowsTool.resolve({
        binaryPath: "C:\\Users\\alice\\.local\\bin\\package-tool.exe",
        platform: "win32",
        env: { PATH: "" },
      }).update,
    ).toEqual(install);
  });

  it.effect("preserves an explicit npm install prefix even when a native installer exists", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-native-install-prefix");
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(path.join(tempDir, "npm.cmd"), "@echo off\r\n");
      const install = nativeWindowsTool.resolve({
        binaryPath: "missing-package-tool",
        platform: "win32",
        env: { PATH: tempDir, PATHEXT: WINDOWS_PATHEXT, NPM_CONFIG_PREFIX: tempDir },
      }).install;
      expect(install).toMatchObject({
        executable: "npm",
        environmentPatch: { NPM_CONFIG_PREFIX: tempDir },
      });
    }),
  );

  it("does not offer a default install for an explicit custom binary path", () => {
    expect(
      nativeWindowsTool.resolve({
        binaryPath: "C:\\custom\\missing.exe",
        platform: "win32",
        env: { PATH: "" },
      }).install,
    ).toBeNull();
  });
  it("marks providers with unknown current versions as unknown", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: null,
        latestVersion: "9.9.9",
      }),
    ).toMatchObject({
      status: "unknown",
      currentVersion: null,
      latestVersion: "9.9.9",
    });
  });

  it("marks providers with unknown latest versions as unknown", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: "1.0.0",
        latestVersion: null,
      }),
    ).toMatchObject({
      status: "unknown",
      currentVersion: "1.0.0",
      latestVersion: null,
      message: null,
    });
  });

  it("marks installed providers behind latest when a newer provider version is available", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("nativePackageTool"),
        currentVersion: "2.1.110",
        latestVersion: "2.1.117",
        maintenanceCapabilities: nativePackageToolUpdate.resolve(),
      }),
    ).toMatchObject({
      status: "behind_latest",
      currentVersion: "2.1.110",
      latestVersion: "2.1.117",
      updateCommand: "npm install -g @example/native-package-tool@latest",
      canUpdate: true,
      message: "Install the update now or review provider settings.",
    });
  });

  it("keeps update commands owned by provider maintenance capabilities", () => {
    expect(staticToolUpdate.resolve()).toEqual({
      provider: driver("staticTool"),
      packageName: null,
      update: {
        command: "static-tool update",

        executable: "static-tool",

        args: ["update"],

        lockKey: "static-tool",
      },
      ...noInstallOrManualUpdate,
    });
  });

  it.effect(
    "switches package-managed providers to vite-plus updates when the resolved binary lives in vite-plus global bin",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-vite-plus-capabilities");
        const vitePlusBinDir = path.join(tempDir, ".vite-plus", "bin");
        mkdirSync(vitePlusBinDir, { recursive: true });
        const packageToolPath = path.join(vitePlusBinDir, "package-tool");
        writeFileSync(packageToolPath, "#!/bin/sh\n");
        chmodSync(packageToolPath, 0o755);

        expect(
          packageToolUpdate.resolve({
            binaryPath: packageToolPath,
            platform: "darwin",
            env: {
              PATH: vitePlusBinDir,
            },
          }),
        ).toEqual({
          provider: driver("packageTool"),
          packageName: "@example/package-tool",
          update: {
            command: "vp i -g @example/package-tool",

            executable: "vp",

            args: ["i", "-g", "@example/package-tool"],

            lockKey: "vite-plus-global",
          },
          ...noInstallOrManualUpdate,
        });
      }),
  );

  it.effect(
    "switches package-managed providers to bun updates when the resolved binary lives in bun's global bin",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-bun-capabilities");
        const bunBinDir = path.join(tempDir, ".bun", "bin");
        mkdirSync(bunBinDir, { recursive: true });
        writeFileSync(path.join(bunBinDir, "native-package-tool.exe"), "MZ");

        expect(
          nativePackageToolUpdate.resolve({
            binaryPath: "native-package-tool",
            platform: "win32",
            env: {
              PATH: bunBinDir,
              PATHEXT: ".COM;.EXE;.BAT;.CMD",
            },
          }),
        ).toEqual({
          provider: driver("nativePackageTool"),
          packageName: "@example/native-package-tool",
          update: {
            command: "bun i -g @example/native-package-tool@latest",

            executable: "bun",

            args: ["i", "-g", "@example/native-package-tool@latest"],

            lockKey: "bun-global",
          },
          ...noInstallOrManualUpdate,
        });
      }),
  );

  it.effect(
    "switches package-managed providers to pnpm updates when the resolved binary lives in pnpm's global bin",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-pnpm-capabilities");
        const pnpmHomeDir = path.join(tempDir, ".local", "share", "pnpm");
        mkdirSync(pnpmHomeDir, { recursive: true });
        const scopedPackageToolPath = path.join(pnpmHomeDir, "scoped-package-tool");
        writeFileSync(scopedPackageToolPath, "#!/bin/sh\n");
        chmodSync(scopedPackageToolPath, 0o755);

        expect(
          scopedPackageToolUpdate.resolve({
            binaryPath: scopedPackageToolPath,
            platform: "darwin",
            env: {
              PATH: pnpmHomeDir,
            },
          }),
        ).toEqual({
          provider: driver("scopedPackageTool"),
          packageName: "@example/scoped-package-tool",
          update: {
            command: "pnpm add -g @example/scoped-package-tool@latest",

            executable: "pnpm",

            args: ["add", "-g", "@example/scoped-package-tool@latest"],

            lockKey: "pnpm-global",
          },
          ...noInstallOrManualUpdate,
        });
      }),
  );

  it("binds Windows npm updates to the prefix containing the resolved provider shim", () => {
    const appData = "C:\\Users\\Alice Smith\\AppData\\Roaming";
    const npmPrefix = `${appData}\\npm`;

    expect(
      packageToolUpdate.resolve({
        binaryPath: `${npmPrefix}\\package-tool.cmd`,
        platform: "win32",
        env: {
          APPDATA: appData,
          PATH: "C:\\fnm\\current;C:\\Program Files\\nodejs",
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
      }),
    ).toEqual({
      provider: driver("packageTool"),
      packageName: "@example/package-tool",
      update: {
        command: `npm --prefix "${npmPrefix}" install -g @example/package-tool@latest`,

        executable: "npm",

        args: ["install", "-g", "@example/package-tool@latest"],

        lockKey: "npm-global",

        environmentPatch: { NPM_CONFIG_PREFIX: npmPrefix },
      },
      ...noInstallOrManualUpdate,
    });
  });

  it("binds FNM-managed Windows provider shims to their multishell prefix", () => {
    const npmPrefix = "C:\\Users\\alice\\AppData\\Local\\fnm_multishells\\1234_session";

    expect(
      packageToolUpdate.resolve({
        binaryPath: `${npmPrefix}\\package-tool.cmd`,
        platform: "win32",
        env: {
          PATH: "C:\\Windows\\System32",
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
      }),
    ).toMatchObject({
      update: {
        command: `npm --prefix "${npmPrefix}" install -g @example/package-tool@latest`,
        executable: "npm",
        args: ["install", "-g", "@example/package-tool@latest"],
        environmentPatch: { NPM_CONFIG_PREFIX: npmPrefix },
      },
    });
  });

  it("switches package-tool to Homebrew updates when the binary resolves through Homebrew", () => {
    expect(
      packageToolUpdate.resolve({
        binaryPath: "/opt/homebrew/bin/package-tool",
        platform: "darwin",
        env: {
          PATH: "",
        },
      }),
    ).toEqual({
      provider: driver("packageTool"),
      packageName: "@example/package-tool",
      update: {
        command: "brew upgrade package-tool",

        executable: "brew",

        args: ["upgrade", "package-tool"],

        lockKey: "homebrew",
      },
      ...noInstallOrManualUpdate,
    });
  });

  it.effect(
    "switches native-package-tool to native updates when the binary resolves through the native installer",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-native-package-tool-native-capabilities");
        const nativeBinDir = path.join(tempDir, ".local", "bin");
        mkdirSync(nativeBinDir, { recursive: true });
        const nativePackageToolPath = path.join(nativeBinDir, "native-package-tool");
        writeFileSync(nativePackageToolPath, "#!/bin/sh\n");
        chmodSync(nativePackageToolPath, 0o755);

        expect(
          nativePackageToolUpdate.resolve({
            binaryPath: nativePackageToolPath,
            platform: "darwin",
            env: {
              PATH: nativeBinDir,
            },
          }),
        ).toEqual({
          provider: driver("nativePackageTool"),
          packageName: "@example/native-package-tool",
          update: {
            command: "native-package-tool update",

            executable: "native-package-tool",

            args: ["update"],

            lockKey: "native-package-tool-native",
          },
          ...noInstallOrManualUpdate,
        });
      }),
  );

  it("uses configured platform update overrides for native providers", () => {
    expect(
      nativePackageToolPlatformOverrideUpdate.resolve({
        binaryPath: "C:\\Users\\alice\\.local\\bin\\native-package-tool.exe",
        platform: "win32",
        env: {
          PATH: "",
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
      }),
    ).toEqual({
      provider: driver("nativePackageTool"),
      packageName: "@example/native-package-tool",
      update: {
        command: windowsInstallerCommand,

        executable: "powershell.exe",

        args: [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          windowsInstallerCommandEncoded,
        ],

        lockKey: "native-package-tool-installer-win32",
      },
      install: null,
      manualUpdateCommand: null,
      advisoryMessage:
        "Run the native-package-tool Windows installer instead of native-package-tool update.",
    });

    expect(
      nativePackageToolPlatformOverrideUpdate.resolve({
        binaryPath: "/Users/alice/.local/bin/native-package-tool",
        platform: "darwin",
        env: {
          PATH: "",
        },
      }),
    ).toEqual({
      provider: driver("nativePackageTool"),
      packageName: "@example/native-package-tool",
      update: {
        command: "native-package-tool update",

        executable: "native-package-tool",

        args: ["update"],

        lockKey: "native-package-tool-native",
      },
      ...noInstallOrManualUpdate,
    });
  });

  it("keeps platform update overrides as one-click version advisories", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("nativePackageTool"),
        currentVersion: "2.1.183",
        latestVersion: "2.1.185",
        maintenanceCapabilities: nativePackageToolPlatformOverrideUpdate.resolve({
          binaryPath: "C:\\Users\\alice\\.local\\bin\\native-package-tool.exe",
          platform: "win32",
          env: {
            PATH: "",
            PATHEXT: ".COM;.EXE;.BAT;.CMD",
          },
        }),
      }),
    ).toMatchObject({
      status: "behind_latest",
      currentVersion: "2.1.183",
      latestVersion: "2.1.185",
      updateCommand: windowsInstallerCommand,
      canUpdate: true,
      message:
        "Run the native-package-tool Windows installer instead of native-package-tool update.",
    });
  });

  it.effect(
    "switches scoped-package-tool to native upgrades when the binary resolves through the standalone installer",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDir("t3-scoped-package-tool-native-capabilities");
        const nativeBinDir = path.join(tempDir, ".scoped-package-tool", "bin");
        mkdirSync(nativeBinDir, { recursive: true });
        const scopedPackageToolPath = path.join(nativeBinDir, "scoped-package-tool");
        writeFileSync(scopedPackageToolPath, "#!/bin/sh\n");
        chmodSync(scopedPackageToolPath, 0o755);

        expect(
          scopedPackageToolUpdate.resolve({
            binaryPath: scopedPackageToolPath,
            platform: "darwin",
            env: {
              PATH: nativeBinDir,
            },
          }),
        ).toEqual({
          provider: driver("scopedPackageTool"),
          packageName: "@example/scoped-package-tool",
          update: {
            command: "scoped-package-tool upgrade",

            executable: "scoped-package-tool",

            args: ["upgrade"],

            lockKey: "scoped-package-tool-native",
          },
          ...noInstallOrManualUpdate,
        });
      }),
  );

  it.effect("derives an npm global install for a provider CLI that resolves nowhere on PATH", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-npm-install-capabilities");
      const npmBinDir = writeCommandShim(path.join(tempDir, "npm-bin"), "npm");

      expect(
        packageToolUpdate.resolve({
          binaryPath: "package-tool",
          platform: process.platform,
          env: { PATH: npmBinDir, PATHEXT: WINDOWS_PATHEXT },
        }).install,
      ).toEqual({
        command: "npm install -g @example/package-tool@latest",
        executable: "npm",
        args: ["install", "-g", "@example/package-tool@latest"],
        lockKey: "npm-global",
      });
    }),
  );

  it.effect("offers no install capability when npm itself is missing", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-npm-install-capabilities-missing");
      const emptyBinDir = writeCommandShim(path.join(tempDir, "empty-bin"), "unrelated-tool");

      expect(
        packageToolUpdate.resolve({
          binaryPath: "package-tool",
          platform: process.platform,
          env: { PATH: emptyBinDir, PATHEXT: WINDOWS_PATHEXT },
        }).install,
      ).toBeNull();
    }),
  );

  it.effect("scopes the derived install to the configured npm prefix", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-npm-install-capabilities-prefix");
      const npmBinDir = writeCommandShim(path.join(tempDir, "npm-bin"), "npm");
      const npmPrefix = path.join(tempDir, "npm prefix");

      expect(
        packageToolUpdate.resolve({
          binaryPath: "package-tool",
          platform: process.platform,
          env: {
            PATH: npmBinDir,
            PATHEXT: WINDOWS_PATHEXT,
            NPM_CONFIG_PREFIX: npmPrefix,
          },
        }).install,
      ).toEqual({
        command: `npm --prefix "${npmPrefix}" install -g @example/package-tool@latest`,
        executable: "npm",
        args: ["install", "-g", "@example/package-tool@latest"],
        lockKey: "npm-global",
        environmentPatch: { NPM_CONFIG_PREFIX: npmPrefix },
      });
    }),
  );

  it.effect("keeps an installed provider free of an install capability", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-npm-install-capabilities-installed");
      const npmBinDir = writeCommandShim(path.join(tempDir, "npm-bin"), "npm");
      writeCommandShim(npmBinDir, "package-tool");

      expect(
        packageToolUpdate.resolve({
          binaryPath: "package-tool",
          platform: process.platform,
          env: { PATH: npmBinDir, PATHEXT: WINDOWS_PATHEXT },
        }).install,
      ).toBeNull();
    }),
  );

  it("switches native-package-tool to Homebrew updates when the binary resolves through Homebrew", () => {
    expect(
      nativePackageToolUpdate.resolve({
        binaryPath: "/opt/homebrew/bin/native-package-tool",
        platform: "darwin",
        env: {
          PATH: "",
        },
      }),
    ).toEqual({
      provider: driver("nativePackageTool"),
      packageName: "@example/native-package-tool",
      update: {
        command: "brew upgrade native-package-tool",

        executable: "brew",

        args: ["upgrade", "native-package-tool"],

        lockKey: "homebrew",
      },
      ...noInstallOrManualUpdate,
    });
  });

  it("switches scoped-package-tool to Homebrew updates when the binary resolves through Homebrew", () => {
    expect(
      scopedPackageToolUpdate.resolve({
        binaryPath: "/opt/homebrew/bin/scoped-package-tool",
        platform: "darwin",
        env: {
          PATH: "",
        },
      }),
    ).toEqual({
      provider: driver("scopedPackageTool"),
      packageName: "@example/scoped-package-tool",
      update: {
        command: "brew upgrade example/tap/scoped-package-tool",

        executable: "brew",

        args: ["upgrade", "example/tap/scoped-package-tool"],

        lockKey: "homebrew",
      },
      ...noInstallOrManualUpdate,
    });
  });

  it.effect("keeps npm updates for binaries symlinked into npm's global node_modules tree", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-npm-capabilities");
      const binDir = path.join(tempDir, "bin");
      const packageBinDir = path.join(
        tempDir,
        "lib",
        "node_modules",
        "@example",
        "package-tool",
        "bin",
      );
      mkdirSync(binDir, { recursive: true });
      mkdirSync(packageBinDir, { recursive: true });
      const packageBinPath = path.join(packageBinDir, "package-tool.js");
      const symlinkPath = path.join(binDir, "package-tool");
      writeFileSync(packageBinPath, "#!/usr/bin/env node\n");
      chmodSync(packageBinPath, 0o755);
      linkPackageCommand({ packageBinDir, packageBinPath, commandPath: symlinkPath });

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: symlinkPath,
        platform: "darwin",
        env: {
          PATH: "",
        },
      }).pipe(Effect.provide(NodeServices.layer));

      expect(capabilities).toEqual({
        provider: driver("packageTool"),
        packageName: "@example/package-tool",
        update: {
          command: "npm install -g @example/package-tool@latest",

          executable: "npm",

          args: ["install", "-g", "@example/package-tool@latest"],

          lockKey: "npm-global",
        },
        ...noInstallOrManualUpdate,
      });
    }),
  );

  it.effect("uses Effect FileSystem realPath when detecting pnpm global symlinks", () =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDir("t3-pnpm-realpath-capabilities");
      const binDir = path.join(tempDir, "bin");
      const packageBinDir = path.join(
        tempDir,
        ".local",
        "share",
        "pnpm",
        "global",
        "5",
        "node_modules",
        "@example",
        "package-tool",
        "bin",
      );
      mkdirSync(binDir, { recursive: true });
      mkdirSync(packageBinDir, { recursive: true });
      const packageBinPath = path.join(packageBinDir, "package-tool.js");
      const symlinkPath = path.join(binDir, "package-tool");
      writeFileSync(packageBinPath, "#!/usr/bin/env node\n");
      chmodSync(packageBinPath, 0o755);
      linkPackageCommand({ packageBinDir, packageBinPath, commandPath: symlinkPath });

      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(packageToolUpdate, {
        binaryPath: symlinkPath,
        platform: "darwin",
        env: {
          PATH: "",
        },
      }).pipe(Effect.provide(NodeServices.layer));

      expect(capabilities).toEqual({
        provider: driver("packageTool"),
        packageName: "@example/package-tool",
        update: {
          command: "pnpm add -g @example/package-tool@latest",

          executable: "pnpm",

          args: ["add", "-g", "@example/package-tool@latest"],

          lockKey: "pnpm-global",
        },
        ...noInstallOrManualUpdate,
      });
    }),
  );

  it("disables one-click updates for explicit custom binary paths it cannot safely map", () => {
    expect(
      packageToolUpdate.resolve({
        binaryPath: "C:\\Tools\\package-tool\\package-tool.exe",
        platform: "win32",
        env: {
          PATH: "",
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
      }),
    ).toEqual({
      provider: driver("packageTool"),
      packageName: "@example/package-tool",
      update: null,
      ...noInstallOrManualUpdate,
    });
  });
});
