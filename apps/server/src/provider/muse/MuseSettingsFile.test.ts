import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { readMuseDataSharing, writeMuseDataSharing } from "./MuseSettingsFile.ts";

const configHome = () => {
  const root = mkdtempSync(join(tmpdir(), "threadlines-muse-settings-"));
  return { root, environment: { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv };
};

describe("Muse data-sharing settings", () => {
  it.effect("reads Muse's default when the file is missing, and saves only its own keys", () =>
    Effect.gen(function* () {
      const { root, environment } = configHome();
      const before = yield* readMuseDataSharing(environment);
      expect(before).toMatchObject({ enabled: true, acknowledged: false });

      mkdirSync(join(root, "muse"));
      writeFileSync(
        join(root, "muse", "settings.json"),
        JSON.stringify({ schema_version: 1, model: "muse-spark-1.3" }),
      );
      yield* writeMuseDataSharing(environment, false);
      expect(JSON.parse(readFileSync(join(root, "muse", "settings.json"), "utf8"))).toEqual({
        schema_version: 1,
        model: "muse-spark-1.3",
        contributor_mode_enabled: false,
        contributor_mode_disclosure_acknowledged: true,
      });
      expect(yield* readMuseDataSharing(environment)).toMatchObject({
        enabled: false,
        acknowledged: true,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("creates a file Muse accepts when there is none", () =>
    Effect.gen(function* () {
      const { root, environment } = configHome();
      yield* writeMuseDataSharing(environment, true);
      expect(JSON.parse(readFileSync(join(root, "muse", "settings.json"), "utf8"))).toEqual({
        schema_version: 1,
        contributor_mode_enabled: true,
        contributor_mode_disclosure_acknowledged: true,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("never replaces a settings file it cannot read or does not know", () =>
    Effect.gen(function* () {
      const { root, environment } = configHome();
      mkdirSync(join(root, "muse"));
      writeFileSync(join(root, "muse", "settings.json"), "{ not json");
      const failed = yield* writeMuseDataSharing(environment, true).pipe(Effect.flip);
      expect(failed.reason).toContain("not valid JSON");
      expect(readFileSync(join(root, "muse", "settings.json"), "utf8")).toBe("{ not json");

      writeFileSync(join(root, "muse", "settings.json"), JSON.stringify({ schema_version: 2 }));
      const newer = yield* writeMuseDataSharing(environment, true).pipe(Effect.flip);
      expect(newer.reason).toContain("newer format");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
