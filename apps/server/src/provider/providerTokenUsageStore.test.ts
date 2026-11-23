import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { makeProviderTokenUsageStore } from "./providerTokenUsageStore.ts";

const openStore = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "threadlines-state-" });
  return yield* makeProviderTokenUsageStore({
    stateDir,
    provider: "claude",
    source: `/claude/${stateDir}`,
  });
});

describe("providerTokenUsageStore", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("keeps a later day saved by a reading that finished first", () =>
      Effect.gen(function* () {
        const store = yield* openStore;
        // Started after midnight, finished first.
        yield* store.remember({
          reading: [{ startDate: "2026-03-02", tokens: 50 }],
          today: "2026-03-02",
          completeFrom: "2026-02-01",
        });
        // Started before midnight, finished last.
        const late = yield* store.remember({
          reading: [{ startDate: "2026-03-01", tokens: 40 }],
          today: "2026-03-01",
          completeFrom: "2026-01-31",
        });

        assert.deepStrictEqual(late.buckets, [
          { startDate: "2026-03-01", tokens: 40 },
          { startDate: "2026-03-02", tokens: 50 },
        ]);
        assert.deepStrictEqual(late.completeRange, { from: "2026-01-31", through: "2026-03-02" });
      }),
    );

    it.effect("starts the known range over when a reading no longer sees its last day", () =>
      Effect.gen(function* () {
        const store = yield* openStore;
        // A morning read knows Jan 1 only up to then.
        yield* store.remember({ reading: [], today: "2026-01-01", completeFrom: "2025-12-03" });

        const joined = yield* store.remember({
          reading: [],
          today: "2026-01-30",
          completeFrom: "2026-01-01",
        });
        assert.deepStrictEqual(joined.completeRange, { from: "2025-12-03", through: "2026-01-30" });

        // Thirty days on, the files from Jan 30's afternoon may be gone.
        const restarted = yield* store.remember({
          reading: [],
          today: "2026-03-01",
          completeFrom: "2026-01-31",
        });
        assert.deepStrictEqual(restarted.completeRange, {
          from: "2026-01-31",
          through: "2026-03-01",
        });
      }),
    );
  });
});
