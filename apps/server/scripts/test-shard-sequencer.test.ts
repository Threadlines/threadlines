import { describe, expect, it } from "vite-plus/test";

import { pickWeightedShard } from "./test-shard-sequencer.ts";

describe("pickWeightedShard", () => {
  // Shaped like the server suite: a few heavy orchestration files and a long
  // tail of small ones, with ties to exercise the path tie-break.
  const files = [
    { key: "src/orchestration/Reactor.test.ts", seconds: 57 },
    { key: "src/orchestration/Ingestion.test.ts", seconds: 23 },
    { key: "src/vcs/Broadcaster.test.ts", seconds: 23 },
    { key: "src/git/GitManager.test.ts", seconds: 13 },
    ...Array.from({ length: 120 }, (_, i) => ({
      key: `src/small/file${String(i).padStart(3, "0")}.test.ts`,
      seconds: 0.5 + (i % 7) * 0.3,
    })),
  ];

  it("runs every file in exactly one shard, whatever order the files arrive in", () => {
    const count = 3;
    const shards = Array.from({ length: count }, (_, i) =>
      pickWeightedShard(i % 2 === 0 ? files : files.toReversed(), i + 1, count),
    );

    const picked = shards.flat().map((file) => file.key);
    expect(picked.toSorted()).toEqual(files.map((file) => file.key).toSorted());
    expect(new Set(picked).size).toBe(files.length);

    const loads = shards.map((shard) => shard.reduce((sum, file) => sum + file.seconds, 0));
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThan(2);
  });
});
