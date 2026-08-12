// @effect-diagnostics nodeBuiltinImport:off
import assert from "node:assert/strict";

import {
  EventId,
  ProviderDriverKind,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { describe, it } from "vite-plus/test";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  mapCodexSubagentTranscript,
  mapToRuntimeEvents,
  readCodexSubagentParentThreadId,
} from "./CodexAdapter.ts";

describe("CodexAdapter item mapping", () => {
  it("maps native subagent activity into the canonical collab-agent shape", () => {
    const [runtimeEvent] = mapToRuntimeEvents(
      {
        id: EventId.make("evt-subagent-started"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-07-13T18:38:47.000Z",
        method: "item/completed",
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-1"),
        itemId: ProviderItemId.make("subagent-activity-1"),
        payload: {
          completedAtMs: 1_783_967_927_000,
          threadId: "provider-parent-thread",
          turnId: "provider-parent-turn",
          item: {
            id: "subagent-activity-1",
            type: "subAgentActivity",
            kind: "started",
            agentPath: "/root/implement_pull_server",
            agentThreadId: "019f5cf1-e2fc-74f2-a6c0-16502ecc4826",
          },
        },
      },
      ThreadId.make("thread-1"),
    );

    assert.ok(runtimeEvent);
    assert.equal(runtimeEvent.type, "item.completed");
    if (runtimeEvent.type !== "item.completed") {
      return;
    }
    assert.equal(runtimeEvent.payload.itemType, "collab_agent_tool_call");
    assert.equal(runtimeEvent.payload.status, "completed");
    assert.equal(runtimeEvent.payload.title, "Subagent task");
    assert.deepStrictEqual(runtimeEvent.payload.data, {
      completedAtMs: 1_783_967_927_000,
      threadId: "provider-parent-thread",
      turnId: "provider-parent-turn",
      item: {
        id: "subagent-activity-1",
        type: "subAgentActivity",
        kind: "started",
        agentPath: "/root/implement_pull_server",
        agentThreadId: "019f5cf1-e2fc-74f2-a6c0-16502ecc4826",
        tool: "spawnAgent",
        status: "inProgress",
        receiverThreadIds: ["019f5cf1-e2fc-74f2-a6c0-16502ecc4826"],
        agentsStates: {
          "019f5cf1-e2fc-74f2-a6c0-16502ecc4826": {
            status: "running",
          },
        },
      },
    });
  });

  it("does not project root conversation activity as a subagent", () => {
    const runtimeEvents = mapToRuntimeEvents(
      {
        id: EventId.make("evt-root-interacted"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-07-13T18:38:49.000Z",
        method: "item/completed",
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-1"),
        itemId: ProviderItemId.make("root-activity-1"),
        payload: {
          completedAtMs: 1_783_967_929_000,
          threadId: "provider-child-thread",
          turnId: "provider-child-turn",
          item: {
            id: "root-activity-1",
            type: "subAgentActivity",
            kind: "interacted",
            agentPath: "/root",
            agentThreadId: "provider-parent-thread",
          },
        },
      },
      ThreadId.make("thread-1"),
    );

    assert.deepStrictEqual(runtimeEvents, []);
  });

  it("maps a stored Codex child thread into the shared transcript shape", () => {
    const thread = {
      id: "child-thread",
      parentThreadId: "parent-thread",
      source: {
        subAgent: {
          thread_spawn: {
            depth: 1,
            parent_thread_id: "parent-thread",
          },
        },
      },
      turns: [
        {
          id: "turn-child-1",
          status: "completed",
          startedAt: 1_769_947_200,
          items: [
            {
              id: "user-1",
              type: "userMessage",
              content: [{ type: "text", text: "Inspect the update path" }],
            },
            {
              id: "reasoning-1",
              type: "reasoning",
              summary: ["Checking the runtime wiring"],
            },
            {
              id: "command-1",
              type: "commandExecution",
              command: "rg -n update apps/server",
              commandActions: [],
              cwd: "C:/repo",
              status: "completed",
              aggregatedOutput: "apps/server/src/update.ts:10",
            },
            {
              id: "assistant-1",
              type: "agentMessage",
              phase: "final_answer",
              text: "The update path is correctly wired.",
            },
          ],
        },
      ],
    } as unknown as EffectCodexSchema.V2ThreadReadResponse["thread"];

    assert.equal(readCodexSubagentParentThreadId(thread), "parent-thread");
    assert.deepStrictEqual(mapCodexSubagentTranscript(thread), {
      truncated: false,
      agent: { id: "child-thread" },
      offset: 0,
      totalEntries: 4,
      entries: [
        {
          role: "user",
          text: "Inspect the update path",
          at: "2026-02-01T12:00:00.000Z",
          toolUses: [],
        },
        {
          role: "thinking",
          text: "Checking the runtime wiring",
          at: "2026-02-01T12:00:00.000Z",
          toolUses: [],
        },
        {
          role: "assistant",
          text: "",
          at: "2026-02-01T12:00:00.000Z",
          toolUses: [{ name: "shell_command", summary: "rg -n update apps/server" }],
          outputPreview: "apps/server/src/update.ts:10",
        },
        {
          role: "assistant",
          text: "The update path is correctly wired.",
          at: "2026-02-01T12:00:00.000Z",
          toolUses: [],
        },
      ],
    });
  });

  it("times a forked child's replayed first turn from the thread's own start", () => {
    // A forked child's history arrives as a synthetic turn -- Codex ids it
    // "rollout-N" -- with no startedAt, completedAt or durationMs, while every
    // real turn after it is stamped. Codex times a turn rather than an item, so
    // without a fallback the agent's opening words are the only untimed entries
    // in the transcript, which reads as the timestamps sitting a row too low.
    const thread = {
      id: "forked-child",
      createdAt: 1_786_487_612,
      turns: [
        {
          id: "rollout-2",
          status: "completed",
          startedAt: null,
          completedAt: null,
          items: [{ id: "assistant-1", type: "agentMessage", text: "I'll delegate both counts." }],
        },
        {
          id: "019ff2f5-a952-7c10-9fda-66f5498a6d49",
          status: "completed",
          startedAt: 1_786_487_613,
          items: [{ id: "assistant-2", type: "agentMessage", text: "50 .tsx files." }],
        },
      ],
    } as unknown as EffectCodexSchema.V2ThreadReadResponse["thread"];

    assert.deepStrictEqual(
      mapCodexSubagentTranscript(thread).entries.map((entry) => entry.at),
      ["2026-08-11T22:33:32.000Z", "2026-08-11T22:33:33.000Z"],
    );
  });

  it("drops the parent history a forked child replays before its own first turn", () => {
    // Codex spawns a subagent by forking, so the child's stored history opens
    // with the parent's conversation replayed as an untimed turn. Rendering it
    // labelled the operator's own message to the main thread as the instruction
    // this agent was given, and attributed the main thread's reply to the child.
    const thread = {
      id: "forked-child",
      forkedFromId: "parent-thread",
      parentThreadId: "parent-thread",
      createdAt: 1_786_487_612,
      turns: [
        {
          id: "rollout-2",
          status: "completed",
          startedAt: null,
          completedAt: null,
          items: [
            { id: "user-1", type: "userMessage", text: "can you start up subagents again" },
            { id: "assistant-1", type: "agentMessage", text: "Sure, starting two agents." },
          ],
        },
        {
          id: "019ff2f5-a952-7c10-9fda-66f5498a6d49",
          status: "completed",
          startedAt: 1_786_487_613,
          items: [{ id: "assistant-2", type: "agentMessage", text: "50 .tsx files." }],
        },
      ],
    } as unknown as EffectCodexSchema.V2ThreadReadResponse["thread"];

    assert.deepStrictEqual(
      mapCodexSubagentTranscript(thread).entries.map((entry) => entry.text),
      ["50 .tsx files."],
    );
  });

  it("drops the parent turn that was live at the fork, which carries a real time", () => {
    // The second shape of the same inheritance, and the one a "no timestamps"
    // rule slid straight past: the turn the parent was in the middle of when it
    // spawned this child comes across with an ordinary id and a startedAt from
    // before the child existed. Measured from a real fork: the parent's live
    // turn started 11s before creation, the child's own work 1s after it.
    const createdAt = 1_786_558_783;
    const thread = {
      id: "forked-child-live-parent-turn",
      forkedFromId: "parent-thread",
      parentThreadId: "parent-thread",
      createdAt,
      turns: [
        {
          id: "rollout-2",
          status: "completed",
          startedAt: null,
          items: [{ id: "assistant-1", type: "agentMessage", text: "Older replayed history." }],
        },
        {
          id: "019ff733-7569-7ad2-9171-d6f19574734f",
          status: "interrupted",
          startedAt: createdAt - 11,
          items: [
            { id: "user-1", type: "userMessage", text: "can you run just 1 subagent this time" },
            {
              id: "assistant-2",
              type: "agentMessage",
              text: "I can run exactly one subagent now.",
            },
          ],
        },
        {
          id: "019ff733-a3ec-7060-912e-f858d78b9ef9",
          status: "completed",
          startedAt: createdAt + 1,
          items: [{ id: "assistant-3", type: "agentMessage", text: "Read-only scan complete." }],
        },
      ],
    } as unknown as EffectCodexSchema.V2ThreadReadResponse["thread"];

    assert.deepStrictEqual(
      mapCodexSubagentTranscript(thread).entries.map((entry) => entry.text),
      ["Read-only scan complete."],
    );
  });

  it("keeps a child's own first turn that starts in the second it was created", () => {
    const createdAt = 1_786_558_783;
    const thread = {
      id: "forked-child-instant-start",
      forkedFromId: "parent-thread",
      createdAt,
      turns: [
        {
          id: "019ff733-7569-7ad2-9171-d6f19574734f",
          status: "completed",
          startedAt: createdAt - 4,
          items: [{ id: "assistant-1", type: "agentMessage", text: "Parent's own words." }],
        },
        {
          id: "019ff733-a3ec-7060-912e-f858d78b9ef9",
          status: "completed",
          startedAt: createdAt,
          items: [{ id: "assistant-2", type: "agentMessage", text: "Off to work." }],
        },
      ],
    } as unknown as EffectCodexSchema.V2ThreadReadResponse["thread"];

    assert.deepStrictEqual(
      mapCodexSubagentTranscript(thread).entries.map((entry) => entry.text),
      ["Off to work."],
    );
  });

  it("keeps every turn when a forked child has no timed turn to start from", () => {
    const thread = {
      id: "forked-child-untimed",
      forkedFromId: "parent-thread",
      createdAt: 1_786_487_612,
      turns: [
        {
          id: "rollout-2",
          status: "completed",
          startedAt: null,
          items: [{ id: "assistant-1", type: "agentMessage", text: "Only content there is." }],
        },
      ],
    } as unknown as EffectCodexSchema.V2ThreadReadResponse["thread"];

    assert.deepStrictEqual(
      mapCodexSubagentTranscript(thread).entries.map((entry) => entry.text),
      ["Only content there is."],
    );
  });

  it("uses source ancestry metadata and honors transcript limits", () => {
    const thread = {
      id: "grandchild-thread",
      source: {
        subAgent: {
          thread_spawn: {
            depth: 2,
            parent_thread_id: "child-thread",
          },
        },
      },
      turns: [
        {
          id: "turn-grandchild-1",
          status: "completed",
          items: [
            { id: "assistant-1", type: "agentMessage", text: "First" },
            { id: "assistant-2", type: "agentMessage", text: "Second" },
          ],
        },
      ],
    } as unknown as EffectCodexSchema.V2ThreadReadResponse["thread"];

    assert.equal(readCodexSubagentParentThreadId(thread), "child-thread");
    assert.deepStrictEqual(mapCodexSubagentTranscript(thread, { limit: 1 }), {
      truncated: true,
      agent: { id: "grandchild-thread" },
      offset: 0,
      totalEntries: 2,
      entries: [{ role: "assistant", text: "First", toolUses: [] }],
    });
    assert.deepStrictEqual(mapCodexSubagentTranscript(thread, { limit: 1, fromEnd: true }), {
      truncated: true,
      agent: { id: "grandchild-thread" },
      offset: 1,
      totalEntries: 2,
      entries: [{ role: "assistant", text: "Second", toolUses: [] }],
    });
    assert.deepStrictEqual(mapCodexSubagentTranscript(thread, { limit: 1, offset: 1 }), {
      truncated: true,
      agent: { id: "grandchild-thread" },
      offset: 1,
      totalEntries: 2,
      entries: [{ role: "assistant", text: "Second", toolUses: [] }],
    });
    assert.deepStrictEqual(mapCodexSubagentTranscript(thread, { limit: 0 }), {
      truncated: false,
      agent: { id: "grandchild-thread" },
      offset: 0,
      totalEntries: 2,
      entries: [
        { role: "assistant", text: "First", toolUses: [] },
        { role: "assistant", text: "Second", toolUses: [] },
      ],
    });
  });
});
