import { describe, expect, it } from "vite-plus/test";

import {
  REMEMBERED_THREAD_LIMIT,
  keyedMemo,
  threadMemo,
  threadMemoOfInput,
} from "./derivationMemo";

describe("keyedMemo", () => {
  it("remembers a result per object until one of its other inputs changes", () => {
    let runs = 0;
    const visibleSteps = keyedMemo((steps: readonly string[], turn: string | null) => {
      runs += 1;
      return steps.filter((step) => turn === null || step.startsWith(turn));
    });
    const steps = ["t1 read", "t2 edit"];

    const first = visibleSteps(steps, "t1");
    expect(visibleSteps(steps, "t1")).toBe(first);
    expect(visibleSteps(steps, "t2")).toEqual(["t2 edit"]);
    expect(visibleSteps(steps, "t1")).toEqual(["t1 read"]);
    expect(runs).toBe(3);
  });
});

describe("threadMemo", () => {
  it("gives a thread back its result until any input changes", () => {
    let runs = 0;
    const visibleSteps = threadMemo((steps: readonly string[], turn: string | null) => {
      runs += 1;
      return steps.filter((step) => turn === null || step.startsWith(turn));
    });
    const threadA = ["t1 read", "t2 edit"];
    const threadB = ["t9 run"];

    const first = visibleSteps("env:a", threadA, "t1");
    visibleSteps("env:b", threadB, null);
    // Back to thread A with the same inputs: the result it had, not a new one.
    expect(visibleSteps("env:a", threadA, "t1")).toBe(first);
    expect(runs).toBe(2);
    // Same array, another turn: derived again, never the stale result.
    expect(visibleSteps("env:a", threadA, "t2")).toEqual(["t2 edit"]);
    // New data is a new array: derived again too.
    expect(visibleSteps("env:a", [...threadA, "t2 run"], "t2")).toEqual(["t2 edit", "t2 run"]);
    expect(runs).toBe(4);
  });

  it("keeps only the most recently used threads", () => {
    let runs = 0;
    const count = threadMemo((steps: readonly string[]) => {
      runs += 1;
      return steps.length;
    });
    const steps = ["read"];
    for (let index = 0; index <= REMEMBERED_THREAD_LIMIT; index += 1) {
      count(`env:${index}`, steps);
    }
    expect(runs).toBe(REMEMBERED_THREAD_LIMIT + 1);
    // The newest are still there; the oldest was dropped and derives again.
    count(`env:${REMEMBERED_THREAD_LIMIT}`, steps);
    expect(runs).toBe(REMEMBERED_THREAD_LIMIT + 1);
    count("env:0", steps);
    expect(runs).toBe(REMEMBERED_THREAD_LIMIT + 2);
  });
});

describe("threadMemoOfInput", () => {
  it("compares a rebuilt input object field by field", () => {
    let runs = 0;
    const label = threadMemoOfInput(
      (input: { rows: readonly string[]; names: ReadonlyMap<string, string>; busy: boolean }) => {
        runs += 1;
        return `${input.rows.length} ${input.busy} ${[...input.names.values()].join()}`;
      },
      {
        names: (left, right) =>
          left.size === right.size && [...left].every(([key, name]) => right.get(key) === name),
      },
    );
    const rows = ["a", "b"];

    const first = label("env:a", { rows, names: new Map([["x", "Sol"]]), busy: false });
    expect(label("env:a", { rows, names: new Map([["x", "Sol"]]), busy: false })).toBe(first);
    expect(runs).toBe(1);
    expect(label("env:a", { rows, names: new Map([["x", "Astra"]]), busy: false })).toBe(
      "2 false Astra",
    );
    expect(label("env:a", { rows, names: new Map([["x", "Astra"]]), busy: true })).toBe(
      "2 true Astra",
    );
    expect(runs).toBe(3);
  });
});
