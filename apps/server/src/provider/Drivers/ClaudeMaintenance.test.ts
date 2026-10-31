// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";

import { resolveClaudeMaintenanceCapabilities } from "./ClaudeMaintenance.ts";

const POINTER_BASE = "https://downloads.claude.ai/claude-code-releases";

const configDirWith = (settings: string | null) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "claude-maintenance-"));
  if (settings !== null) writeFileSync(path.join(dir, "settings.json"), settings);
  return dir;
};

const resolve = (configDir: string, platform: NodeJS.Platform, binaryPath: string) =>
  resolveClaudeMaintenanceCapabilities(configDir, {
    binaryPath,
    platform,
    env: { PATH: "" },
  }).pipe(Effect.provide(NodeServices.layer));

const encodedScript = (args: ReadonlyArray<string> | undefined) =>
  Buffer.from(args?.at(-1) ?? "", "base64").toString("utf16le");

describe("ClaudeMaintenance", () => {
  it.effect("follows the saved release channel on every platform", () =>
    Effect.gen(function* () {
      const stable = configDirWith(JSON.stringify({ autoUpdatesChannel: "stable" }));

      const mac = yield* resolve(stable, "darwin", "/Users/alice/.local/bin/claude");
      expect(mac.update?.args).toEqual(["update"]);
      expect(mac.latestVersionSource).toEqual({
        kind: "releasePointer",
        url: `${POINTER_BASE}/stable`,
      });

      const windows = yield* resolve(stable, "win32", "C:\\Users\\alice\\.local\\bin\\claude.exe");
      expect(windows.latestVersionSource).toEqual({
        kind: "releasePointer",
        url: `${POINTER_BASE}/stable`,
      });
      expect(encodedScript(windows.update?.args)).toContain('"$downloadBaseUrl/stable"');
    }),
  );

  it.effect("uses the latest channel when the settings don't name another", () =>
    Effect.gen(function* () {
      for (const settings of [null, "{ not json", '{"autoUpdatesChannel":"nightly"}', "{}"]) {
        const windows = yield* resolve(
          configDirWith(settings),
          "win32",
          "C:\\Users\\alice\\.local\\bin\\claude.exe",
        );
        expect(windows.latestVersionSource).toEqual({
          kind: "releasePointer",
          url: `${POINTER_BASE}/latest`,
        });
        expect(encodedScript(windows.update?.args)).toContain('"$downloadBaseUrl/latest"');
      }
    }),
  );

  it.effect("keeps an npm install on npm", () =>
    Effect.gen(function* () {
      const capabilities = yield* resolve(
        configDirWith(JSON.stringify({ autoUpdatesChannel: "stable" })),
        "linux",
        "/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude",
      );
      expect(capabilities.update?.executable).toBe("npm");
      expect(capabilities.latestVersionSource).toBeUndefined();
    }),
  );
});
