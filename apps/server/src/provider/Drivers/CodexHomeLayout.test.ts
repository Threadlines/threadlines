import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CodexSettings } from "@threadlines/contracts";
import {
  codexContinuationIdentity,
  CodexShadowHomeError,
  codexSqliteHomePath,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
  withCodexSqliteHome,
  withoutCodexSqliteHome,
} from "./CodexHomeLayout.ts";
import { isPathWithinOverlayDir, normalizeOverlayPath } from "../accountOverlay.ts";
import { canMakeSymlinks } from "../../testUtils/symlinks.ts";
import {
  codexVisualizationDateShard,
  MAX_CODEX_INLINE_VISUALIZATION_BYTES,
  readCodexInlineVisualization,
} from "../CodexInlineVisualization.ts";
const decodeCodexSettingsValue = Schema.decodeSync(CodexSettings);

const decodeCodexSettings = (input: {
  readonly enabled?: boolean;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly customModels?: readonly string[];
  readonly binaryPath?: string;
}): CodexSettings => decodeCodexSettingsValue(input);

const makeTempDir = Effect.fn("CodexHomeLayout.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTextFile = Effect.fn("CodexHomeLayout.test.writeTextFile")(function* (
  filePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

it.layer(NodeServices.layer)("CodexHomeLayout", (it) => {
  describe("resolveCodexHomeLayout", () => {
    it.effect("uses direct CODEX_HOME when no shadow home is configured", () =>
      Effect.gen(function* () {
        const homePath = yield* makeTempDir("threadlines-codex-home-");

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath,
          }),
        );

        expect(layout).toMatchObject({
          mode: "direct",
          sharedHomePath: homePath,
          effectiveHomePath: homePath,
          continuationKey: `codex:home:${homePath}`,
        });
      }),
    );

    it.effect("uses the shared home for continuation and the shadow home for runtime", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("threadlines-codex-shared-");
        const shadowRoot = yield* makeTempDir("threadlines-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          }),
        );

        expect(layout).toMatchObject({
          mode: "authOverlay",
          sharedHomePath: sharedHome,
          effectiveHomePath: shadowHome,
          continuationKey: `codex:home:${sharedHome}`,
        });
      }),
    );
  });

  describe("Codex inline visualizations", () => {
    const providerThreadId = "019f8ca0-8000-7992-a481-9125813cb125";

    it.effect("derives the local date shard from a native UUIDv7 thread id", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const timestamp = new Date(Number.parseInt("019f8ca08000", 16));
        const expected = path.join(
          String(timestamp.getFullYear()).padStart(4, "0"),
          String(timestamp.getMonth() + 1).padStart(2, "0"),
          String(timestamp.getDate()).padStart(2, "0"),
        );

        expect(codexVisualizationDateShard(providerThreadId)).toBe(expected);
        expect(codexVisualizationDateShard("not-a-native-thread-id")).toBeNull();
      }),
    );

    it.effect("reads only the expected visualization fragment", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const codexHomePath = yield* makeTempDir("threadlines-codex-visualization-");
        const shard = codexVisualizationDateShard(providerThreadId);
        expect(shard).not.toBeNull();
        const filePath = path.join(
          codexHomePath,
          "visualizations",
          shard ?? "",
          providerThreadId,
          "connection-map.html",
        );
        yield* writeTextFile(filePath, "<div>Connection map</div>");

        const result = yield* readCodexInlineVisualization({
          codexHomePath,
          providerThreadId,
          file: "connection-map.html",
        });

        expect(result).toEqual({
          file: "connection-map.html",
          contents: "<div>Connection map</div>",
          sizeBytes: 25,
        });
      }),
    );

    it.effect("rejects symlinks and oversized visualization files", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const codexHomePath = yield* makeTempDir("threadlines-codex-visualization-");
        const shard = codexVisualizationDateShard(providerThreadId) ?? "";
        const directory = path.join(codexHomePath, "visualizations", shard, providerThreadId);
        const targetPath = path.join(directory, "target.html");
        const symlinkPath = path.join(directory, "linked-file.html");
        const oversizedPath = path.join(directory, "oversized-file.html");
        yield* writeTextFile(targetPath, "<div>target</div>");
        if (process.platform !== "win32") {
          yield* fileSystem.symlink(targetPath, symlinkPath);
          const symlinkError = yield* readCodexInlineVisualization({
            codexHomePath,
            providerThreadId,
            file: "linked-file.html",
          }).pipe(Effect.flip);
          expect(symlinkError.message).toContain("not a regular file");
        }

        yield* fileSystem.writeFile(
          oversizedPath,
          new Uint8Array(MAX_CODEX_INLINE_VISUALIZATION_BYTES + 1),
        );
        const oversizedError = yield* readCodexInlineVisualization({
          codexHomePath,
          providerThreadId,
          file: "oversized-file.html",
        }).pipe(Effect.flip);
        expect(oversizedError.message).toContain("too large");
      }),
    );
  });

  describe("materializeCodexShadowHome", () => {
    it.effect("materializes a shadow home with shared state links and private auth", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("threadlines-codex-shared-");
        const shadowRoot = yield* makeTempDir("threadlines-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");

        yield* fileSystem.makeDirectory(path.join(sharedHome, "sessions"));
        yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
        yield* writeTextFile(path.join(sharedHome, "models_cache.json"), '{"models":["shared"]}\n');
        yield* writeTextFile(path.join(sharedHome, "auth.json"), '{"shared":true}\n');
        // Codex's encrypted login store; an older overlay linked it.
        yield* writeTextFile(path.join(sharedHome, "secrets", "codex_auth.age"), "shared-login");
        yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
        yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
        if (process.platform !== "win32") {
          yield* fileSystem.symlink(
            path.join(sharedHome, "models_cache.json"),
            path.join(shadowHome, "models_cache.json"),
          );
          yield* fileSystem.symlink(
            path.join(sharedHome, "secrets"),
            path.join(shadowHome, "secrets"),
          );
        }

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          }),
        );

        yield* materializeCodexShadowHome(layout);

        const sessionsPath = path.join(shadowHome, "sessions");
        const configPath = path.join(shadowHome, "config.toml");
        const modelsCacheExists = yield* fileSystem.exists(
          path.join(shadowHome, "models_cache.json"),
        );
        const authLinkResult = yield* fileSystem
          .readLink(path.join(shadowHome, "auth.json"))
          .pipe(Effect.result);
        const authContents = yield* fileSystem.readFileString(path.join(shadowHome, "auth.json"));

        if (process.platform === "win32") {
          expect(yield* fileSystem.exists(sessionsPath)).toBe(true);
          expect(yield* fileSystem.readFileString(configPath)).toContain("gpt-5-codex");
        } else {
          expect(yield* fileSystem.readLink(sessionsPath)).toBe(path.join(sharedHome, "sessions"));
          expect(yield* fileSystem.readLink(configPath)).toBe(path.join(sharedHome, "config.toml"));
        }
        expect(modelsCacheExists).toBe(false);
        expect(yield* fileSystem.exists(path.join(shadowHome, "secrets"))).toBe(false);
        expect(authLinkResult._tag).toBe("Failure");
        expect(authContents).toContain("shadow");
      }),
    );

    it.effect("accepts Codex-created shadow-local runtime directories", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("threadlines-codex-shared-");
        const shadowRoot = yield* makeTempDir("threadlines-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");

        yield* fileSystem.makeDirectory(path.join(sharedHome, "log"));
        yield* fileSystem.makeDirectory(path.join(sharedHome, "memories"));
        yield* fileSystem.makeDirectory(path.join(sharedHome, "tmp"));
        yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
        yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
        yield* fileSystem.makeDirectory(path.join(shadowHome, "log"), { recursive: true });
        yield* fileSystem.makeDirectory(path.join(shadowHome, "memories"), { recursive: true });
        yield* fileSystem.makeDirectory(path.join(shadowHome, "tmp"), { recursive: true });

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          }),
        );

        yield* materializeCodexShadowHome(layout);

        const configPath = path.join(shadowHome, "config.toml");
        const logLinkResult = yield* fileSystem
          .readLink(path.join(shadowHome, "log"))
          .pipe(Effect.result);
        const memoriesLinkResult = yield* fileSystem
          .readLink(path.join(shadowHome, "memories"))
          .pipe(Effect.result);
        const tmpLinkResult = yield* fileSystem
          .readLink(path.join(shadowHome, "tmp"))
          .pipe(Effect.result);

        if (process.platform === "win32") {
          expect(yield* fileSystem.readFileString(configPath)).toContain("gpt-5-codex");
        } else {
          expect(yield* fileSystem.readLink(configPath)).toBe(path.join(sharedHome, "config.toml"));
        }
        expect(logLinkResult._tag).toBe("Failure");
        expect(memoriesLinkResult._tag).toBe("Failure");
        expect(tmpLinkResult._tag).toBe("Failure");
      }),
    );

    it.effect("rejects shadow homes that point at the shared home", () =>
      Effect.gen(function* () {
        const sharedHome = yield* makeTempDir("threadlines-codex-shared-");
        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: sharedHome,
          }),
        );

        const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

        expect(error).toBeInstanceOf(CodexShadowHomeError);
      }),
    );

    it.effect(
      "keeps the shadow home's own real files and drops shared history when sessions is real",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("threadlines-codex-shared-");
          const shadowRoot = yield* makeTempDir("threadlines-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(path.join(shadowHome, "config.toml"), 'model = "local"\n');
          yield* writeTextFile(path.join(shadowHome, "sessions", "local.jsonl"), "{}\n");

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          const result = yield* materializeCodexShadowHome(layout);

          expect(result.sharesMainHistory).toBe(false);
          expect(yield* fileSystem.readFileString(path.join(shadowHome, "config.toml"))).toBe(
            'model = "local"\n',
          );
          expect(
            yield* fileSystem.readFileString(path.join(shadowHome, "sessions", "local.jsonl")),
          ).toBe("{}\n");
          expect(codexContinuationIdentity(layout, result).continuationKey).toBe(
            `codex:home:${shadowHome}`,
          );
          expect(codexSqliteHomePath(layout, result)).toBeUndefined();
        }),
    );

    it.effect(
      "does not link SQLite databases, WAL/SHM sidecars, locks, or ephemeral runtime files",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("threadlines-codex-shared-");
          const shadowRoot = yield* makeTempDir("threadlines-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");

          // Shared home has live SQLite databases + sidecars, lock files, and
          // runtime state alongside shared config.
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(path.join(sharedHome, "AGENTS.md"), "be concise\n");
          for (const name of [
            "state_5.sqlite",
            "state_5.sqlite-wal",
            "state_5.sqlite-shm",
            "state_5.sqlite-journal",
            "logs_2.sqlite",
            "logs_2.sqlite-wal",
            "logs_2.sqlite-shm",
            "goals_1.sqlite",
            "memories_1.sqlite",
            "queue_1.sqlite",
            "thread_history_1.sqlite",
            "auth.json.lock",
            "auth.lock",
            ".sqlite-maintenance.lock",
            "installation_id",
            ".codex-global-state.json",
            "..codex-global-state.json.tmp-1234",
          ]) {
            yield* writeTextFile(path.join(sharedHome, name), "shared");
          }
          yield* fileSystem.makeDirectory(path.join(sharedHome, ".tmp"), { recursive: true });

          // Shadow home already has real conflicting SQLite DBs/sidecars and
          // runtime entries (reproducing the post-run state from issue #1119).
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          yield* writeTextFile(path.join(shadowHome, "state_5.sqlite"), "shadow-db");
          yield* writeTextFile(path.join(shadowHome, "state_5.sqlite-shm"), "shadow-shm");
          yield* writeTextFile(path.join(shadowHome, "state_5.sqlite-wal"), "shadow-wal");
          yield* writeTextFile(path.join(shadowHome, "logs_2.sqlite-wal"), "non-empty-wal");
          yield* writeTextFile(path.join(shadowHome, "installation_id"), "shadow-install");
          yield* fileSystem.makeDirectory(path.join(shadowHome, ".tmp"), { recursive: true });

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          const result = yield* materializeCodexShadowHome(layout);

          expect(result.sharesMainHistory).toBe(true);
          expect(codexSqliteHomePath(layout, result)).toBe(sharedHome);
          expect(yield* fileSystem.readFileString(path.join(shadowHome, "config.toml"))).toContain(
            "gpt-5-codex",
          );
          expect(yield* fileSystem.readFileString(path.join(shadowHome, "AGENTS.md"))).toBe(
            "be concise\n",
          );
          // SQLite files and runtime state in the shared home were not linked.
          expect(yield* fileSystem.exists(path.join(shadowHome, "goals_1.sqlite"))).toBe(false);
          expect(yield* fileSystem.exists(path.join(shadowHome, "logs_2.sqlite"))).toBe(false);
          expect(yield* fileSystem.exists(path.join(shadowHome, "auth.json.lock"))).toBe(false);
          expect(yield* fileSystem.exists(path.join(shadowHome, ".codex-global-state.json"))).toBe(
            false,
          );
          // Pre-existing real files in the shadow home were neither rejected nor deleted.
          expect(yield* fileSystem.readFileString(path.join(shadowHome, "state_5.sqlite"))).toBe(
            "shadow-db",
          );
          expect(yield* fileSystem.readFileString(path.join(shadowHome, "logs_2.sqlite-wal"))).toBe(
            "non-empty-wal",
          );
          expect(yield* fileSystem.readFileString(path.join(shadowHome, "installation_id"))).toBe(
            "shadow-install",
          );
        }),
    );

    it.effect.skipIf(!canMakeSymlinks)(
      "migrates legacy shadow homes by removing old shared SQLite and runtime symlinks",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("threadlines-codex-shared-");
          const shadowRoot = yield* makeTempDir("threadlines-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const externalTarget = path.join(shadowRoot, "custom-external.md");

          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(path.join(sharedHome, "state_5.sqlite"), "shared-db");
          yield* writeTextFile(path.join(sharedHome, "logs_2.sqlite"), "shared-logs");
          yield* writeTextFile(path.join(sharedHome, "auth.json.lock"), "");
          yield* writeTextFile(path.join(sharedHome, "installation_id"), "shared-id");
          yield* writeTextFile(externalTarget, "user-owned");

          yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          // Legacy links from the previous denylist layout, including a dangling -wal link.
          yield* fileSystem.symlink(
            path.join(sharedHome, "state_5.sqlite"),
            path.join(shadowHome, "state_5.sqlite"),
          );
          yield* fileSystem.symlink(
            path.join(sharedHome, "state_5.sqlite-wal"),
            path.join(shadowHome, "state_5.sqlite-wal"),
          );
          yield* fileSystem.symlink(
            path.join(sharedHome, "logs_2.sqlite"),
            path.join(shadowHome, "logs_2.sqlite"),
          );
          yield* fileSystem.symlink(
            path.join(sharedHome, "auth.json.lock"),
            path.join(shadowHome, "auth.json.lock"),
          );
          yield* fileSystem.symlink(
            path.join(sharedHome, "installation_id"),
            path.join(shadowHome, "installation_id"),
          );
          // A real sidecar created by Codex beside the legacy symlink stays untouched.
          yield* writeTextFile(path.join(shadowHome, "state_5.sqlite-shm"), "real-shm");
          // A symlink pointing outside the shared home stays untouched.
          yield* fileSystem.symlink(externalTarget, path.join(shadowHome, "custom-external.md"));

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          const result = yield* materializeCodexShadowHome(layout);

          expect(result.sharesMainHistory).toBe(true);
          expect(yield* fileSystem.exists(path.join(shadowHome, "state_5.sqlite"))).toBe(false);
          expect(
            (yield* fileSystem
              .readLink(path.join(shadowHome, "state_5.sqlite-wal"))
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(yield* fileSystem.exists(path.join(shadowHome, "logs_2.sqlite"))).toBe(false);
          expect(yield* fileSystem.exists(path.join(shadowHome, "auth.json.lock"))).toBe(false);
          expect(yield* fileSystem.exists(path.join(shadowHome, "installation_id"))).toBe(false);
          // Shared targets are untouched.
          expect(yield* fileSystem.readFileString(path.join(sharedHome, "state_5.sqlite"))).toBe(
            "shared-db",
          );
          // Real shadow files and external links are untouched.
          expect(
            yield* fileSystem.readFileString(path.join(shadowHome, "state_5.sqlite-shm")),
          ).toBe("real-shm");
          expect(yield* fileSystem.readLink(path.join(shadowHome, "custom-external.md"))).toBe(
            externalTarget,
          );
          // Allowlisted entries stay linked.
          expect(yield* fileSystem.readLink(path.join(shadowHome, "config.toml"))).toBe(
            path.join(sharedHome, "config.toml"),
          );
          expect(yield* fileSystem.readLink(path.join(shadowHome, "sessions"))).toBe(
            path.join(sharedHome, "sessions"),
          );
        }),
    );

    it.effect("defaults CODEX_SQLITE_HOME without overriding an explicit value", () =>
      Effect.gen(function* () {
        const sharedHome = yield* makeTempDir("threadlines-codex-shared-");
        const shadowHome = yield* makeTempDir("threadlines-codex-shadow-");
        const directLayout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({ homePath: sharedHome }),
        );
        const overlayLayout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
        );

        expect(codexSqliteHomePath(directLayout)).toBeUndefined();
        expect(codexSqliteHomePath(overlayLayout)).toBe(sharedHome);
        expect(codexSqliteHomePath(overlayLayout, { sharesMainHistory: false })).toBeUndefined();

        const defaulted = withCodexSqliteHome({}, sharedHome);
        expect(defaulted.CODEX_SQLITE_HOME).toBe(sharedHome);

        const preserved = withCodexSqliteHome({ CODEX_SQLITE_HOME: "/custom/sqlite" }, sharedHome);
        expect(preserved.CODEX_SQLITE_HOME).toBe("/custom/sqlite");

        // Windows env keys are case-insensitive when spread onto a plain object.
        const preservedWin = withCodexSqliteHome(
          { codex_sqlite_home: "C:\\custom\\sqlite" },
          sharedHome,
          "win32",
        );
        expect(preservedWin.codex_sqlite_home).toBe("C:\\custom\\sqlite");
        expect(preservedWin.CODEX_SQLITE_HOME).toBeUndefined();

        const strippedWin = withoutCodexSqliteHome(
          { codex_sqlite_home: "C:\\shared", CODEX_SQLITE_HOME: "C:\\other", PATH: "C:\\bin" },
          "win32",
        );
        expect(strippedWin).toEqual({ PATH: "C:\\bin" });
      }),
    );

    it.effect.skipIf(!canMakeSymlinks)(
      "rejects a shadow home that aliases the shared home through a symlink without deleting files",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* makeTempDir("threadlines-codex-alias-");
          const sharedHome = path.join(root, "shared");
          const shadowAlias = path.join(root, "shadow-alias");
          yield* writeTextFile(path.join(sharedHome, "auth.json"), '{"main":true}\n');
          yield* writeTextFile(path.join(sharedHome, "state_5.sqlite"), "main-db");
          yield* fileSystem.symlink(sharedHome, shadowAlias);

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowAlias,
            }),
          );

          const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

          expect(error).toBeInstanceOf(CodexShadowHomeError);
          expect(yield* fileSystem.readFileString(path.join(sharedHome, "auth.json"))).toBe(
            '{"main":true}\n',
          );
          expect(yield* fileSystem.readFileString(path.join(sharedHome, "state_5.sqlite"))).toBe(
            "main-db",
          );
        }),
    );

    it.effect.skipIf(!canMakeSymlinks)(
      "rejects a shadow auth.json symlink pointing to another account and preserves custom subpath links",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* makeTempDir("threadlines-codex-links-");
          const sharedHome = path.join(root, "shared");
          const otherAccount = path.join(root, "other-account");
          const shadowHome = path.join(root, "shadow");

          yield* writeTextFile(path.join(sharedHome, "tools", "bin", "helper.sh"), "#!/bin/sh\n");
          yield* writeTextFile(path.join(otherAccount, "auth.json"), '{"other":true}\n');
          yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
          // A custom symlink pointing to a subpath inside sharedHome that the old denylist
          // could never have created (`shadow/bin -> shared/tools/bin`) must survive migration.
          yield* fileSystem.symlink(
            path.join(sharedHome, "tools", "bin"),
            path.join(shadowHome, "bin"),
          );

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);
          expect(yield* fileSystem.readLink(path.join(shadowHome, "bin"))).toBe(
            path.join(sharedHome, "tools", "bin"),
          );

          // Symlinking auth.json to another account must be rejected without deleting the target.
          yield* fileSystem.symlink(
            path.join(otherAccount, "auth.json"),
            path.join(shadowHome, "auth.json"),
          );
          const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);
          expect(error.detail).toContain("must be a real file, not a symlink");
          expect(yield* fileSystem.readFileString(path.join(otherAccount, "auth.json"))).toBe(
            '{"other":true}\n',
          );
        }),
    );

    it.effect("normalizes Windows verbatim prefixes and casing for overlay path checks", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        expect(normalizeOverlayPath("\\\\?\\C:\\Users\\Me\\.codex\\sessions", "win32")).toBe(
          "c:\\users\\me\\.codex\\sessions",
        );
        expect(
          isPathWithinOverlayDir({
            path,
            dir: "/Users/me/.codex",
            candidate: "/Users/me/.codex/state_5.sqlite",
            platform: "darwin",
          }),
        ).toBe(true);
        expect(
          isPathWithinOverlayDir({
            path,
            dir: "/Users/me/.codex",
            candidate: "/Users/me/other/state_5.sqlite",
            platform: "darwin",
          }),
        ).toBe(false);
        expect(
          isPathWithinOverlayDir({
            path,
            dir: "/Users/me/.codex",
            candidate: "/Users/me/.codex/..backup",
            platform: "darwin",
          }),
        ).toBe(true);
      }),
    );
  });
});
