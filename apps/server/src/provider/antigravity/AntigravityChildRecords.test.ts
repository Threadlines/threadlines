// @effect-diagnostics nodeBuiltinImport:off
import * as os from "node:os";
import * as path from "node:path";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import {
  type AntigravityChildrenReading,
  antigravityChildOf,
  antigravityChildTranscript,
  readAntigravityChildren,
} from "./AntigravityChildRecords.ts";
import { openAntigravityProfileFile } from "./AntigravitySessionLog.ts";

const PARENT = "7d40e54d-5977-4239-940b-246cdd81a12b";

/** A profile with the CLI's records as agy 1.5.12+ writes them (shapes from T3 Code's fixtures). */
async function makeProfile() {
  const profile = await mkdtemp(path.join(os.tmpdir(), "agy-child-records-"));
  const brain = path.join(profile, "antigravity-acp", "brain");
  const write = async (segments: ReadonlyArray<string>, value: unknown) => {
    const file = path.join(brain, ...segments);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
  };
  const child = async (id: string, callId: string, state = "SUBAGENT_STATE_ALIVE") => {
    await write([PARENT, ".system_generated", "subagents", `${id}.json`], {
      conversationId: id,
      subagentDescriptor: { typeName: "research", role: "Line Counter" },
      state,
    });
    await write([id, ".system_generated", "messages", "launch.json"], {
      sender: PARENT,
      content: "Count lines in README.md",
      sourceMetadata: {
        tool: { conversationId: PARENT, toolCall: { id: callId, name: "invoke_subagent" } },
      },
    });
    await write([id, ".system_generated", "messages", "read.json"], { launch: true });
  };
  const report = (child: string, content: string) =>
    write([PARENT, ".system_generated", "messages", `${child}-report.json`], {
      sender: child,
      content,
    });
  return { profile, brain, write, child, report };
}

const withProfile = <A>(
  use: (records: Awaited<ReturnType<typeof makeProfile>>) => Effect.Effect<A>,
) =>
  Effect.acquireUseRelease(Effect.promise(makeProfile), use, (records) =>
    Effect.promise(() => rm(records.profile, { recursive: true, force: true })),
  );

/** Each bucket as `conversationId:launchCallId`, for comparing a whole reading at once. */
const summary = (reading: AntigravityChildrenReading) =>
  reading.available
    ? Object.fromEntries(
        (["running", "reported", "killed"] as const).map((state) => [
          state,
          reading[state].map((child) => `${child.conversationId}:${child.launchCallId ?? "?"}`),
        ]),
      )
    : reading;

describe("readAntigravityChildren", () => {
  it.live("sorts a session's children into running, reported and killed, by their launch", () =>
    withProfile((records) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await records.child("child-working", "call_working");
          await records.child("child-reported", "call_reported");
          await records.child("child-killed", "call_killed", "SUBAGENT_STATE_KILLED");
          await records.report("child-reported", "README.md has 42 lines.");
          // A follow-up message is not a launch.
          await records.write(["child-working", ".system_generated", "messages", "followup.json"], {
            sender: PARENT,
            content: "Also check LICENSE",
            sourceMetadata: { tool: { toolCall: { id: "call_followup", name: "send_message" } } },
          });
        });
        const reading = yield* readAntigravityChildren(records.profile, PARENT);
        expect(summary(reading)).toEqual({
          running: ["child-working:call_working"],
          reported: ["child-reported:call_reported"],
          killed: ["child-killed:call_killed"],
        });
        expect(antigravityChildOf(reading, "call_reported")?.report).toBe(
          "README.md has 42 lines.",
        );
        // Without argumentsJson the role is the entry's and the prompt the launch message's.
        expect(antigravityChildOf(reading, "call_working")?.launch).toEqual({
          role: "Line Counter",
          prompt: "Count lines in README.md",
        });
        expect(antigravityChildOf(reading, "call_followup")).toBeUndefined();
      }),
    ),
  );

  it.live("ties no child to a launch two children claim", () =>
    withProfile((records) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await records.child("child-a", "call_twin");
          await records.child("child-b", "call_twin");
        });
        const reading = yield* readAntigravityChildren(records.profile, PARENT);
        expect(summary(reading)).toEqual({
          running: ["child-a:?", "child-b:?"],
          reported: [],
          killed: [],
        });
        expect(antigravityChildOf(reading, "call_twin")).toBeUndefined();
      }),
    ),
  );

  it.live("says when there are no records, and when they can't be trusted", () =>
    withProfile((records) =>
      Effect.gen(function* () {
        expect(yield* readAntigravityChildren(records.profile, PARENT)).toEqual({
          available: false,
          reason: "no-records",
        });
        // A session id that walks a path is refused outright.
        expect(yield* readAntigravityChildren(records.profile, "../x")).toEqual({
          available: false,
          reason: "unreadable",
        });
        yield* Effect.promise(() => records.child("child-a", "call_a"));
        expect((yield* readAntigravityChildren(records.profile, PARENT)).available).toBe(true);
      }),
    ),
  );

  it.live("doesn't follow a link out of the profile", () =>
    withProfile((records) =>
      Effect.gen(function* () {
        const elsewhere = yield* Effect.promise(() =>
          mkdtemp(path.join(os.tmpdir(), "agy-child-elsewhere-")),
        );
        yield* Effect.promise(async () => {
          await records.child("child-a", "call_a");
          await writeFile(path.join(elsewhere, "transcript.jsonl"), '{"step_index":1}\n');
          await mkdir(path.join(records.brain, "child-a", ".system_generated"), {
            recursive: true,
          });
          await symlink(
            elsewhere,
            path.join(records.brain, "child-a", ".system_generated", "logs"),
          );
        });
        // The linked transcript is not read: only the instruction shows.
        const transcript = yield* antigravityChildTranscript(records.profile, PARENT, "call_a");
        expect(transcript?.entries.map((entry) => entry.id)).toEqual(["launch"]);
        // A linked subagents folder is no records at all.
        yield* Effect.promise(async () => {
          await rm(path.join(records.brain, PARENT, ".system_generated", "subagents"), {
            recursive: true,
          });
          await symlink(
            elsewhere,
            path.join(records.brain, PARENT, ".system_generated", "subagents"),
          );
        });
        expect((yield* readAntigravityChildren(records.profile, PARENT)).available).toBe(false);
        yield* Effect.promise(() => rm(elsewhere, { recursive: true, force: true }));
      }),
    ),
  );

  it.live("skips a message it can't read instead of giving up on the session", () =>
    withProfile((records) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await records.child("child-a", "call_a");
          await records.child("child-b", "call_b");
          await records.report("child-b", "Done.");
          // A report the CLI is still writing.
          await records.write([PARENT, ".system_generated", "messages", "partial.json"], '{"sen');
        });
        const reading = yield* readAntigravityChildren(records.profile, PARENT);
        expect(summary(reading)).toEqual({
          running: ["child-a:call_a"],
          reported: ["child-b:call_b"],
          killed: [],
        });
        expect(reading.available && reading.unreadable).toBe(1);
      }),
    ),
  );

  it.live("counts every entry of a folder toward its limit, read one at a time", () =>
    withProfile((records) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await records.child("child-a", "call_a");
          const inbox = path.join(records.brain, PARENT, ".system_generated", "messages");
          await mkdir(inbox, { recursive: true });
          for (let index = 0; index < 300; index += 1) {
            await writeFile(path.join(inbox, `${index}.tmp`), "");
          }
        });
        expect(yield* readAntigravityChildren(records.profile, PARENT)).toEqual({
          available: false,
          reason: "unreadable",
        });
      }),
    ),
  );
});

describe("readAntigravityChildren, refused folders", () => {
  it.live("counts a child inbox that is a link as unread, not as empty", () =>
    withProfile((records) =>
      Effect.gen(function* () {
        const elsewhere = yield* Effect.promise(() =>
          mkdtemp(path.join(os.tmpdir(), "agy-child-elsewhere-")),
        );
        yield* Effect.promise(async () => {
          await records.child("child-a", "call_a");
          const inbox = path.join(records.brain, "child-a", ".system_generated", "messages");
          await rm(inbox, { recursive: true });
          await symlink(elsewhere, inbox);
        });
        const reading = yield* readAntigravityChildren(records.profile, PARENT);
        // The child is still running, tied to no launch, and the reading says it's incomplete.
        expect(summary(reading)).toEqual({ running: ["child-a:?"], reported: [], killed: [] });
        expect(reading.available && reading.unreadable).toBe(1);
        // A parent inbox that is a link makes the whole reading unavailable.
        yield* Effect.promise(() =>
          symlink(elsewhere, path.join(records.brain, PARENT, ".system_generated", "messages")),
        );
        expect(yield* readAntigravityChildren(records.profile, PARENT)).toEqual({
          available: false,
          reason: "unreadable",
        });
        yield* Effect.promise(() => rm(elsewhere, { recursive: true, force: true }));
      }),
    ),
  );
});

describe("openAntigravityProfileFile", () => {
  it.live("refuses a file reached through a folder swapped for a link after the check", () =>
    withProfile((records) =>
      Effect.gen(function* () {
        const elsewhere = yield* Effect.promise(() =>
          mkdtemp(path.join(os.tmpdir(), "agy-child-elsewhere-")),
        );
        const logs = path.join(records.brain, "child-a", ".system_generated", "logs");
        yield* Effect.promise(async () => {
          await records.write(
            ["child-a", ".system_generated", "logs", "transcript.jsonl"],
            "ours\n",
          );
          await mkdir(path.join(elsewhere, "logs"), { recursive: true });
          await writeFile(path.join(elsewhere, "logs", "transcript.jsonl"), "theirs\n");
        });
        const segments = ["brain", "child-a", ".system_generated", "logs", "transcript.jsonl"];
        // The path checks out, then a folder on it becomes a link out of the profile.
        const swapped = yield* Effect.promise(() =>
          openAntigravityProfileFile(records.profile, segments, async () => {
            await rename(logs, `${logs}.moved`);
            await symlink(path.join(elsewhere, "logs"), logs);
          }),
        );
        expect(swapped).toBe("refused");
        // Put back, the same file opens, and is told apart once swapped again.
        const opened = yield* Effect.promise(async () => {
          await rm(logs);
          await rename(`${logs}.moved`, logs);
          return openAntigravityProfileFile(records.profile, segments);
        });
        if (typeof opened === "string") throw new Error(`expected a file, got ${opened}`);
        expect(yield* Effect.promise(() => opened.stillHeld())).toBe(true);
        yield* Effect.promise(async () => {
          await rename(logs, `${logs}.moved`);
          await symlink(path.join(elsewhere, "logs"), logs);
        });
        expect(yield* Effect.promise(() => opened.stillHeld())).toBe(false);
        yield* Effect.promise(async () => {
          await opened.handle.close();
          await rm(elsewhere, { recursive: true, force: true });
        });
      }),
    ),
  );
});
