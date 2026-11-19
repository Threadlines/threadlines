import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ThreadId, type OrchestrationThread } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeSecretScrubber, type SecretScrubberShape } from "../secrets/SecretScrubber.ts";
import { canMakeSymlinks } from "../testUtils/symlinks.ts";
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
function readerForThreadAnnouncing(
  announcedFile: string,
  scrubber: SecretScrubberShape = makeSecretScrubber(),
) {
  const thread = {
    activities: [
      {
        payload: {
          detail: `Command running in background with ID: b1x2. Output is being written to: ${announcedFile}`,
        },
      },
    ],
  } as unknown as OrchestrationThread;
  return makeBackgroundRunOutputReader(
    { getThreadDetailById: () => Effect.succeed(Option.some(thread)) },
    scrubber,
  );
}

describe("readBackgroundRunOutput", () => {
  it("reads the end of an output file the thread announced", async () => {
    const read = readerForThreadAnnouncing(outputFile);
    const result = await Effect.runPromise(read({ threadId: THREAD_ID, outputFile }));
    expect(result.tail).toContain("http://localhost:5173/");
  });

  it("hides a saved key whole even when it reaches into the end from before it", async () => {
    // A key of many lines, long enough that the 8 KB end starts inside it:
    // cut first, the lines after the cut would show.
    const key = Array.from({ length: 12 }, (_, line) => `${line}a1b2c3d4`.repeat(8)).join("\n");
    const scrubber = makeSecretScrubber();
    scrubber.watch("DEPLOY_KEY", key);
    await writeFile(outputFile, `${"x".repeat(9_000)}\n${key}\n${"y".repeat(8_000)}\ndone\n`);
    const read = readerForThreadAnnouncing(outputFile, scrubber);
    const result = await Effect.runPromise(read({ threadId: THREAD_ID, outputFile }));
    expect(result.tail).toContain("[DEPLOY_KEY hidden]");
    expect(result.tail).not.toContain("a1b2c3d4");
    expect(result.tail).toContain("done");
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

  // Links to files need symlink rights, which Windows grants only with Developer Mode.
  it.skipIf(!canMakeSymlinks)("refuses an announced file that is a symlink", async () => {
    const secret = path.join(directory, "secret.txt");
    await writeFile(secret, "private\n");
    const linked = path.join(directory, "tasks", "linked.output");
    await symlink(secret, linked);
    const read = readerForThreadAnnouncing(linked);
    const result = await Effect.runPromise(read({ threadId: THREAD_ID, outputFile: linked }));
    expect(result.tail).toBeNull();
  });
});
