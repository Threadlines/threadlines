import { RuntimeTaskId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sameAwaitedBackgroundTasks } from "./awaitedBackgroundTasks.ts";

describe("sameAwaitedBackgroundTasks", () => {
  it("counts a different task behind the same words as a change", () => {
    const before = [{ kind: "command" as const, description: "npm run dev", stoppable: true }];
    expect(
      sameAwaitedBackgroundTasks(
        [{ ...before[0]!, taskId: RuntimeTaskId.make("task-a") }],
        [{ ...before[0]!, taskId: RuntimeTaskId.make("task-b") }],
      ),
    ).toBe(false);
    expect(
      sameAwaitedBackgroundTasks(before, [{ kind: "command", description: "npm run dev" }]),
    ).toBe(false);
    expect(sameAwaitedBackgroundTasks(undefined, [])).toBe(true);
  });
});
