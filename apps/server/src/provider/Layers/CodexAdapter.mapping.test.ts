// @effect-diagnostics nodeBuiltinImport:off
import assert from "node:assert/strict";

import {
  EventId,
  type OrchestrationSubagent,
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
import { projectRuntimeEventToActivities } from "../../orchestration/Layers/ProviderActivityProjection.ts";
import { projectSubagentActivity } from "../../orchestration/subagentProjection.ts";
import { readCollabChildTurnStatus, type CodexServerNotification } from "./CodexSessionRuntime.ts";

describe("CodexAdapter item mapping", () => {
  it("maps structured automatic approval review outcomes", () => {
    const cases = [
      { reviewStatus: "approved", taskStatus: "completed", summary: "Auto-approved command" },
      { reviewStatus: "denied", taskStatus: "failed", summary: "Auto-review denied command" },
      {
        reviewStatus: "timedOut",
        taskStatus: "failed",
        summary: "Auto-review timed out for command",
      },
      {
        reviewStatus: "aborted",
        taskStatus: "stopped",
        summary: "Auto-review stopped for command",
      },
    ] as const;

    for (const { reviewStatus, taskStatus, summary } of cases) {
      const [runtimeEvent] = mapToRuntimeEvents(
        {
          id: EventId.make(`evt-review-${reviewStatus}`),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-08-28T12:00:00.000Z",
          method: "item/autoApprovalReview/completed",
          threadId: ThreadId.make("thread-1"),
          payload: {
            action: {
              command: "Get-ChildItem",
              cwd: "C:/repo",
              source: "unifiedExec",
              type: "command",
            },
            completedAtMs: 1_788_000_001_000,
            decisionSource: "agent",
            review: {
              status: reviewStatus,
              rationale: "The requested check is read-only.",
              riskLevel: "low",
              userAuthorization: "high",
            },
            reviewId: `review-${reviewStatus}`,
            startedAtMs: 1_788_000_000_000,
            targetItemId: "command-1",
            threadId: "provider-thread-1",
            turnId: "turn-1",
          },
        },
        ThreadId.make("thread-1"),
      );

      assert.equal(runtimeEvent?.type, "task.completed");
      if (runtimeEvent?.type !== "task.completed") {
        continue;
      }
      assert.equal(runtimeEvent.turnId, "turn-1");
      assert.equal(runtimeEvent.itemId, "command-1");
      assert.deepStrictEqual(runtimeEvent.payload, {
        taskId: `review-${reviewStatus}`,
        status: taskStatus,
        taskType: "approval-review",
        summary,
        approvalReview: {
          status: reviewStatus,
          rationale: "The requested check is read-only.",
          riskLevel: "low",
          userAuthorization: "high",
        },
      });
    }
  });

  it("classifies guardian notices without inferring their outcome from text", () => {
    const [runtimeEvent] = mapToRuntimeEvents(
      {
        id: EventId.make("evt-guardian-warning"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-08-28T12:00:00.000Z",
        method: "guardianWarning",
        threadId: ThreadId.make("thread-1"),
        payload: {
          message: "Automatic approval review approved: safe read-only check.",
          threadId: "provider-thread-1",
        },
      },
      ThreadId.make("thread-1"),
    );

    assert.equal(runtimeEvent?.type, "runtime.warning");
    if (runtimeEvent?.type === "runtime.warning") {
      assert.equal(runtimeEvent.payload.warningKind, "guardian");
    }
  });

  it("maps native subagent activity into the canonical collab-agent shape", () => {
    const [runtimeEvent, metadataEvent] = mapToRuntimeEvents(
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
    assert.ok(metadataEvent);
    assert.equal(metadataEvent.type, "subagent.metadata.updated");
    if (metadataEvent.type === "subagent.metadata.updated") {
      assert.deepStrictEqual(metadataEvent.payload, {
        callId: "subagent-activity-1",
        agentThreadId: "019f5cf1-e2fc-74f2-a6c0-16502ecc4826",
        agentPath: "/root/implement_pull_server",
      });
    }
  });

  it("tracks actual child turns without restarting a finished agent on message delivery", () => {
    const parentThreadId = ThreadId.make("thread-parent");
    const parentTurnId = TurnId.make("turn-parent");
    const eventBase = {
      kind: "notification",
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-09-05T06:40:10.000Z",
      threadId: parentThreadId,
      turnId: parentTurnId,
    } as const;
    let roster: ReadonlyArray<OrchestrationSubagent> = [];
    const foldEvents = (events: ReturnType<typeof mapToRuntimeEvents>) => {
      for (const activity of events.flatMap((event) => projectRuntimeEventToActivities(event))) {
        roster = projectSubagentActivity(roster, activity);
      }
    };
    const nativeActivity = (kind: "started" | "interacted") =>
      mapToRuntimeEvents(
        {
          ...eventBase,
          id: EventId.make(`native-${kind}`),
          method: "item/completed",
          payload: {
            completedAtMs: 1_788_590_410_000,
            threadId: "provider-parent",
            turnId: "provider-parent-turn",
            item: {
              id: `native-${kind}`,
              type: "subAgentActivity",
              kind,
              agentThreadId: "provider-child",
              agentPath: "/root/github_install_order",
            },
          },
        },
        parentThreadId,
      );
    const childLifecycle = (notification: CodexServerNotification) => {
      const metadata = readCollabChildTurnStatus(notification);
      assert.ok(metadata);
      const events = mapToRuntimeEvents(
        {
          ...eventBase,
          id: EventId.make(`child-${notification.method}`),
          method: "subagent/status/changed",
          providerThreadId: "provider-child",
          payload: metadata,
        },
        parentThreadId,
      );
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["subagent.metadata.updated"],
      );
      foldEvents(events);
      assert.equal(roster.length, 1);
      assert.equal(roster[0]?.agentThreadId, "provider-child");
    };

    foldEvents(nativeActivity("started"));
    childLifecycle({
      method: "turn/started",
      params: {
        threadId: "provider-child",
        turn: { id: "child-turn", status: "inProgress", items: [] },
      },
    });
    assert.equal(roster[0]?.status, "running");

    for (const status of ["completed", "failed", "interrupted"] as const) {
      childLifecycle({
        method: "turn/completed",
        params: {
          threadId: "provider-child",
          turn: { id: "child-turn", status, items: [] },
        },
      });
      assert.equal(roster[0]?.status, status);

      foldEvents(nativeActivity("interacted"));
      assert.equal(roster.length, 1);
      assert.equal(roster[0]?.status, status);

      childLifecycle({
        method: "turn/started",
        params: {
          threadId: "provider-child",
          turn: { id: "child-followup-turn", status: "inProgress", items: [] },
        },
      });
      assert.equal(roster[0]?.status, "running");
    }
  });

  it("maps explicit spawn settings without retaining the prompt message", () => {
    const [metadataEvent] = mapToRuntimeEvents(
      {
        id: EventId.make("evt-spawn-call"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-08-13T20:00:00.000Z",
        method: "rawResponseItem/completed",
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-1"),
        itemId: ProviderItemId.make("call-spawn-1"),
        payload: {
          threadId: "provider-parent-thread",
          turnId: "provider-parent-turn",
          item: {
            type: "function_call",
            name: "spawn_agent",
            call_id: "call-spawn-1",
            arguments: JSON.stringify({
              task_name: "inspect_runtime",
              message: "Sensitive delegated instructions",
              model: "gpt-5.6-sol",
              reasoning_effort: "high",
            }),
          },
        },
      },
      ThreadId.make("thread-1"),
    );

    assert.ok(metadataEvent);
    assert.equal(metadataEvent.type, "subagent.metadata.updated");
    if (metadataEvent.type === "subagent.metadata.updated") {
      assert.deepStrictEqual(metadataEvent.payload, {
        callId: "call-spawn-1",
        taskName: "inspect_runtime",
        objective: "inspect_runtime",
        model: "gpt-5.6-sol",
        modelSource: "explicit",
        reasoningEffort: "high",
        reasoningEffortSource: "explicit",
      });
      assert.equal(JSON.stringify(metadataEvent).includes("Sensitive"), false);
      assert.equal(metadataEvent.raw, undefined);
    }
  });

  it("maps spawned thread identity instead of treating the child as the root thread", () => {
    const [metadataEvent] = mapToRuntimeEvents(
      {
        id: EventId.make("evt-child-thread-started"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-08-13T20:00:01.000Z",
        method: "thread/started",
        threadId: ThreadId.make("thread-1"),
        providerThreadId: "provider-child-thread",
        payload: {
          subagentMetadata: {
            agentThreadId: "provider-child-thread",
          },
          thread: {
            id: "provider-child-thread",
            parentThreadId: "provider-parent-thread",
            agentNickname: "Mercury",
            agentRole: "explorer",
            cliVersion: "1.0.0",
            projectId: null,
            createdAt: 1_786_650_001,
            cwd: "C:/repo",
            ephemeral: false,
            modelProvider: "openai",
            preview: "",
            sessionId: "session-1",
            source: {
              subAgent: {
                thread_spawn: {
                  depth: 1,
                  parent_thread_id: "provider-parent-thread",
                  agent_path: "/root/inspect_runtime",
                  agent_nickname: "Mercury",
                  agent_role: "explorer",
                },
              },
            },
            status: { type: "idle" },
            turns: [],
            updatedAt: 1_786_650_001,
          },
        },
      },
      ThreadId.make("thread-1"),
    );

    assert.ok(metadataEvent);
    assert.equal(metadataEvent.type, "subagent.metadata.updated");
    if (metadataEvent.type === "subagent.metadata.updated") {
      assert.deepStrictEqual(metadataEvent.payload, {
        agentThreadId: "provider-child-thread",
        parentAgentThreadId: "provider-parent-thread",
        agentPath: "/root/inspect_runtime",
        agentNickname: "Mercury",
        agentRole: "explorer",
      });
    }
  });

  it("maps child effective settings with provider provenance", () => {
    const [metadataEvent] = mapToRuntimeEvents(
      {
        id: EventId.make("evt-child-settings"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-08-13T20:00:02.000Z",
        method: "thread/settings/updated",
        threadId: ThreadId.make("thread-1"),
        providerThreadId: "provider-child-thread",
        payload: {
          threadId: "provider-child-thread",
          threadSettings: {
            model: "gpt-5.6-sol",
            effort: "high",
          },
          subagentMetadata: {
            agentThreadId: "provider-child-thread",
            agentPath: "/root/inspect_runtime",
          },
        },
      },
      ThreadId.make("thread-1"),
    );

    assert.ok(metadataEvent);
    assert.equal(metadataEvent.type, "subagent.metadata.updated");
    if (metadataEvent.type === "subagent.metadata.updated") {
      assert.deepStrictEqual(metadataEvent.payload, {
        agentThreadId: "provider-child-thread",
        agentPath: "/root/inspect_runtime",
        model: "gpt-5.6-sol",
        modelSource: "provider",
        reasoningEffort: "high",
        reasoningEffortSource: "provider",
      });
    }
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
      agent: { id: "child-thread", directInput: "unknown" },
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
      agent: { id: "grandchild-thread", directInput: "unknown" },
      offset: 0,
      totalEntries: 2,
      entries: [{ role: "assistant", text: "First", toolUses: [] }],
    });
    assert.deepStrictEqual(mapCodexSubagentTranscript(thread, { limit: 1, fromEnd: true }), {
      truncated: true,
      agent: { id: "grandchild-thread", directInput: "unknown" },
      offset: 1,
      totalEntries: 2,
      entries: [{ role: "assistant", text: "Second", toolUses: [] }],
    });
    assert.deepStrictEqual(mapCodexSubagentTranscript(thread, { limit: 1, offset: 1 }), {
      truncated: true,
      agent: { id: "grandchild-thread", directInput: "unknown" },
      offset: 1,
      totalEntries: 2,
      entries: [{ role: "assistant", text: "Second", toolUses: [] }],
    });
    assert.deepStrictEqual(mapCodexSubagentTranscript(thread, { limit: 0 }), {
      truncated: false,
      agent: { id: "grandchild-thread", directInput: "unknown" },
      offset: 0,
      totalEntries: 2,
      entries: [
        { role: "assistant", text: "First", toolUses: [] },
        { role: "assistant", text: "Second", toolUses: [] },
      ],
    });
  });
});
