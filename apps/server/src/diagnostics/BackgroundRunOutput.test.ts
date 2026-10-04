import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ThreadId, type OrchestrationThread } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeBackgroundRunOutputReader } from "./BackgroundRunOutput.ts";

const THREAD_ID = ThreadId.make("thread-1");

let directory = "";
let outputFile = "";

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "tl-background-output-"));
  await mkdir(path.join(directory, "tasks"));
  outputFile = path.join(directory, "tasks", "b1x2.output");
  await writeFile(outputFile, "VITE ready\n  ➜  Local:   http://localhost:5173/\n");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** A thread whose only activity is Claude's reply naming `announcedFile`. */
function readerForThreadAnnouncing(announcedFile: string) {
  const thread = {
    activities: [
      {
        payload: {
          detail: `Command running in background with ID: b1x2. Output is being written to: ${announcedFile}`,
        },
      },
    ],
  } as unknown as OrchestrationThread;
  return makeBackgroundRunOutputReader({
    getThreadDetailById: () => Effect.succeed(Option.some(thread)),
  });
}

describe("readBackgroundRunOutput", () => {
  it("reads the end of an output file the thread announced", async () => {
    const read = readerForThreadAnnouncing(outputFile);
    const result = await Effect.runPromise(read({ threadId: THREAD_ID, outputFile }));
    expect(result.tail).toContain("http://localhost:5173/");
  });

  it("refuses a file the thread never named, even one shaped like Claude's", async () => {
    const read = readerForThreadAnnouncing(path.join(directory, "tasks", "other.output"));
    const result = await Effect.runPromise(read({ threadId: THREAD_ID, outputFile }));
    expect(result.tail).toBeNull();
  });

  it("needs the exact path, not one that merely contains it", async () => {
    // Announcing a longer path must not open the shorter one inside it.
    const read = readerForThreadAnnouncing(`/elsewhere${outputFile}`);
    const result = await Effect.runPromise(read({ threadId: THREAD_ID, outputFile }));
    expect(result.tail).toBeNull();
  });

  it("refuses an announced file that is a symlink", async () => {
    const secret = path.join(directory, "secret.txt");
    await writeFile(secret, "private\n");
    const linked = path.join(directory, "tasks", "linked.output");
    await symlink(secret, linked);
    const read = readerForThreadAnnouncing(linked);
    const result = await Effect.runPromise(read({ threadId: THREAD_ID, outputFile: linked }));
    expect(result.tail).toBeNull();
  });
});
