// @effect-diagnostics nodeBuiltinImport:off
import * as os from "node:os";
import * as path from "node:path";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { antigravityChildStates, antigravityChildTranscript } from "./AntigravityChildRecords.ts";

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
  return { profile, brain, write, child };
}

describe("Antigravity child records", () => {
  it.live("reads each child's state from its records, and leaves out what they don't prove", () =>
    Effect.gen(function* () {
      const records = yield* Effect.promise(makeProfile);
      yield* Effect.promise(async () => {
        await records.child("child-working", "call_working");
        await records.child("child-reported", "call_reported");
        await records.child("child-killed", "call_killed", "SUBAGENT_STATE_KILLED");
        // Two children claiming one launch: neither is proven its child.
        await records.child("child-twin-a", "call_twin");
        await records.child("child-twin-b", "call_twin");
        await records.write([PARENT, ".system_generated", "messages", "report.json"], {
          sender: "child-reported",
          content: "README.md has 42 lines.",
        });
        // A follow-up message is not a launch.
        await records.write(["child-working", ".system_generated", "messages", "followup.json"], {
          sender: PARENT,
          content: "Also check LICENSE",
          sourceMetadata: { tool: { toolCall: { id: "call_followup", name: "send_message" } } },
        });
      });
      const states = yield* antigravityChildStates(records.profile, PARENT, [
        "call_working",
        "call_reported",
        "call_killed",
        "call_twin",
        "call_followup",
      ]);
      expect(
        Object.fromEntries([...states!].map(([id, child]) => [id, [child.state, child.report]])),
      ).toEqual({
        call_working: ["working", undefined],
        call_reported: ["reported", "README.md has 42 lines."],
        call_killed: ["killed", undefined],
      });
      // Without argumentsJson the role comes from the child's entry and the prompt from its launch.
      expect(states!.get("call_working")?.launch).toEqual({
        role: "Line Counter",
        prompt: "Count lines in README.md",
      });
      // A child with no transcript yet is still named, with its instruction.
      const transcript = yield* antigravityChildTranscript(records.profile, PARENT, "call_working");
      expect(transcript?.child.conversationId).toBe("child-working");
      expect(transcript?.entries).toEqual([
        { id: "launch", role: "user", text: "Count lines in README.md", toolUses: [] },
      ]);
      yield* Effect.promise(() => rm(records.profile, { recursive: true, force: true }));
    }),
  );

  it.live("proves nothing through a link or an unreadable inbox", () =>
    Effect.gen(function* () {
      const records = yield* Effect.promise(makeProfile);
      const elsewhere = yield* Effect.promise(() =>
        mkdtemp(path.join(os.tmpdir(), "agy-child-elsewhere-")),
      );
      yield* Effect.promise(async () => {
        await records.child("child-a", "call_a");
        await writeFile(path.join(elsewhere, "transcript.jsonl"), '{"step_index":1}\n');
        await mkdir(path.join(records.brain, "child-a", ".system_generated"), { recursive: true });
        await symlink(elsewhere, path.join(records.brain, "child-a", ".system_generated", "logs"));
      });
      // The linked transcript is not read: only the instruction shows.
      const transcript = yield* antigravityChildTranscript(records.profile, PARENT, "call_a");
      expect(transcript?.entries.map((entry) => entry.id)).toEqual(["launch"]);

      // A message that isn't JSON could be the one that matters.
      yield* Effect.promise(() =>
        records.write([PARENT, ".system_generated", "messages", "broken.json"], "{not json"),
      );
      expect(yield* antigravityChildStates(records.profile, PARENT, ["call_a"])).toBeUndefined();
      // A session id that walks a path is refused outright.
      expect(yield* antigravityChildStates(records.profile, "../x", ["call_a"])).toBeUndefined();
      yield* Effect.promise(async () => {
        await rm(records.profile, { recursive: true, force: true });
        await rm(elsewhere, { recursive: true, force: true });
      });
    }),
  );
});
