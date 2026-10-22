import { describe, expect, it } from "vite-plus/test";

import {
  initialCodexScanState,
  initialMuseScanState,
  parseClaudeLine,
  parseCodexLine,
  parseGrokLine,
  parseMuseLine,
  parsePiLine,
  piSessionIdFromFileName,
  totalTokens,
} from "./usageTranscripts.ts";

/** Shaped after a real Claude Code assistant record. */
function claudeLine(overrides: {
  messageId: string;
  contentType: string;
  requestId?: string;
  model?: string;
  outputTokens?: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-10T03:50:03.336Z",
    sessionId: "bf5b7ee7-6a3b-41b2-b47c-ba3ef4375b46",
    requestId: overrides.requestId ?? "req_011CdtPMPBEdPXGLpcmo3hze",
    cwd: "/Users/will/badcode",
    message: {
      id: overrides.messageId,
      role: "assistant",
      model: overrides.model ?? "claude-fable-5",
      content: [{ type: overrides.contentType }],
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 15501,
        cache_read_input_tokens: 17070,
        output_tokens: overrides.outputTokens ?? 499,
        service_tier: "standard",
        cache_creation: { ephemeral_1h_input_tokens: 15501, ephemeral_5m_input_tokens: 0 },
      },
    },
  });
}

describe("parseClaudeLine", () => {
  it("extracts token totals and a dedupe key", () => {
    const record = parseClaudeLine(claudeLine({ messageId: "msg_1", contentType: "text" }));

    expect(record?.provider).toBe("claude");
    expect(record?.model).toBe("claude-fable-5");
    expect(record?.sessionId).toBe("bf5b7ee7-6a3b-41b2-b47c-ba3ef4375b46");
    expect(record?.totals).toEqual({
      uncachedInputTokens: 2,
      cachedInputTokens: 17070,
      cacheCreationTokens: 15501,
      outputTokens: 499,
      reasoningTokens: 0,
    });
    // The 1h share of the cache write is what separates it from a 5m write at
    // pricing time.
    expect(record?.cacheCreation1hTokens).toBe(15501);
    expect(record?.dedupeKey).toBe("msg_1:req_011CdtPMPBEdPXGLpcmo3hze");
  });

  it("gives every content block of one message the same dedupe key", () => {
    // The CLI writes one record per content block, each repeating the parent
    // message's full usage. Summing them would overcount several times over.
    const text = parseClaudeLine(claudeLine({ messageId: "msg_2", contentType: "text" }));
    const toolUse = parseClaudeLine(claudeLine({ messageId: "msg_2", contentType: "tool_use" }));

    expect(text?.dedupeKey).toBe(toolUse?.dedupeKey);
    expect(text?.totals).toEqual(toolUse?.totals);
  });

  it("reads a reported cost only when the CLI wrote one", () => {
    const withoutCost = parseClaudeLine(claudeLine({ messageId: "msg_3", contentType: "text" }));
    const withCost = parseClaudeLine(
      JSON.stringify({
        ...(JSON.parse(claudeLine({ messageId: "msg_3", contentType: "text" })) as object),
        costUSD: 0.42,
      }),
    );

    expect(withoutCost?.reportedCostUsd).toBeNull();
    expect(withCost?.reportedCostUsd).toBe(0.42);
  });

  it("ignores records that are not assistant messages", () => {
    expect(parseClaudeLine(JSON.stringify({ type: "user", message: {} }))).toBeNull();
    expect(parseClaudeLine("not json")).toBeNull();
  });
});

describe("parseCodexLine", () => {
  const sessionMeta = JSON.stringify({
    type: "session_meta",
    timestamp: "2026-08-10T04:41:36.122Z",
    payload: {
      session_id: "019fe9f9-df22-7720-8727-262a9a10e5e9",
      id: "019fe9f9-df22-7720-8727-262a9a10e5e9",
      // Ordinary rollouts carry `source` as a plain string and a null fork id.
      source: "vscode",
      forked_from_id: null,
    },
  });
  // `turn_context` payloads carry `model` at the top level and no payload type.
  const turnContext = JSON.stringify({
    type: "turn_context",
    timestamp: "2026-08-10T04:41:38.694Z",
    payload: { model: "gpt-5.6-sol", cwd: "/Users/will/badcode" },
  });
  const tokenCount = (inputTokens: number, cached: number, output: number, reasoning: number) =>
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-10T04:41:46.840Z",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: inputTokens, output_tokens: output },
          last_token_usage: {
            input_tokens: inputTokens,
            cached_input_tokens: cached,
            cache_write_input_tokens: 0,
            output_tokens: output,
            reasoning_output_tokens: reasoning,
          },
        },
      },
    });

  it("attributes usage to the model from the preceding turn context", () => {
    const state = initialCodexScanState();
    parseCodexLine(sessionMeta, state);
    parseCodexLine(turnContext, state);
    const record = parseCodexLine(tokenCount(20642, 11008, 420, 169), state);

    expect(record?.provider).toBe("codex");
    expect(record?.model).toBe("gpt-5.6-sol");
    expect(record?.sessionId).toBe("019fe9f9-df22-7720-8727-262a9a10e5e9");
    // Codex reports input_tokens inclusive of the cached portion.
    expect(record?.totals.uncachedInputTokens).toBe(20642 - 11008);
    expect(record?.totals.cachedInputTokens).toBe(11008);
    expect(record?.totals.reasoningTokens).toBe(169);
  });

  it("skips a repeated token_count so deltas are not double counted", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const first = parseCodexLine(tokenCount(100, 0, 10, 0), state);
    const repeat = parseCodexLine(tokenCount(100, 0, 10, 0), state);

    expect(first).not.toBeNull();
    expect(repeat).toBeNull();
  });

  it("does not let a pre-model event poison the duplicate signature", () => {
    // A token_count before its turn_context is dropped; the identical event
    // re-emitted once the model is known must still be counted.
    const state = initialCodexScanState();
    expect(parseCodexLine(tokenCount(100, 0, 10, 0), state)).toBeNull();
    parseCodexLine(turnContext, state);
    expect(parseCodexLine(tokenCount(100, 0, 10, 0), state)).not.toBeNull();
  });

  // A forked or subagent rollout opens with the parent's history copied in and
  // every line re-stamped to the fork instant, then the ancestors' session
  // metas. Threadlines forks Codex threads natively, so counting those copies
  // again would multiply the prefix turns by the number of forks taken.
  describe("forked rollouts", () => {
    const meta = (overrides: {
      id: string;
      timestamp: string;
      forkedFromId?: string;
      spawnParentId?: string;
    }) =>
      JSON.stringify({
        type: "session_meta",
        timestamp: overrides.timestamp,
        payload: {
          id: overrides.id,
          forked_from_id: overrides.forkedFromId ?? null,
          ...(overrides.spawnParentId === undefined
            ? { source: "vscode" }
            : {
                source: {
                  subagent: { thread_spawn: { parent_thread_id: overrides.spawnParentId } },
                },
              }),
        },
      });
    const stamped = (timestamp: string, line: string) => {
      const parsed = JSON.parse(line) as { timestamp: string };
      parsed.timestamp = timestamp;
      return JSON.stringify(parsed);
    };

    it("keeps the child session id over copied ancestor metas", () => {
      const state = initialCodexScanState();
      parseCodexLine(meta({ id: "child", timestamp: "2026-07-21T05:11:54.120Z" }), state);
      parseCodexLine(meta({ id: "parent", timestamp: "2026-07-21T05:11:54.121Z" }), state);
      parseCodexLine(turnContext, state);
      const record = parseCodexLine(tokenCount(100, 0, 10, 0), state);

      expect(record?.sessionId).toBe("child");
    });

    it("drops the re-stamped copied burst and keeps the first real event", () => {
      // Timings taken from a real Threadlines Codex fork: the copied prefix
      // lands within a millisecond of the fork, the child's own turn 2.7s later.
      const state = initialCodexScanState();
      const forkInstant = "2026-07-21T05:11:54.120Z";
      parseCodexLine(meta({ id: "child", timestamp: forkInstant, forkedFromId: "parent" }), state);
      parseCodexLine(meta({ id: "parent", timestamp: "2026-07-21T05:11:54.121Z" }), state);
      parseCodexLine(stamped("2026-07-21T05:11:54.121Z", turnContext), state);

      expect(
        parseCodexLine(stamped("2026-07-21T05:11:54.121Z", tokenCount(17821, 1408, 20, 0)), state),
      ).toBeNull();
      expect(
        parseCodexLine(stamped("2026-07-21T05:11:54.140Z", tokenCount(17830, 1408, 25, 0)), state),
      ).toBeNull();

      const real = parseCodexLine(
        stamped("2026-07-21T05:11:56.826Z", tokenCount(17859, 1408, 11, 0)),
        state,
      );
      expect(real?.totals.outputTokens).toBe(11);

      // Suppression never restarts, even for closely spaced later events.
      expect(
        parseCodexLine(stamped("2026-07-21T05:11:56.926Z", tokenCount(17900, 1408, 40, 0)), state),
      ).not.toBeNull();
    });

    it("recognizes subagent spawns without forked_from_id", () => {
      const state = initialCodexScanState();
      const spawnInstant = "2026-08-01T20:36:12.311Z";
      parseCodexLine(
        meta({ id: "child", timestamp: spawnInstant, spawnParentId: "parent" }),
        state,
      );
      parseCodexLine(stamped(spawnInstant, turnContext), state);
      expect(
        parseCodexLine(stamped("2026-08-01T20:36:12.312Z", tokenCount(100, 0, 10, 0)), state),
      ).toBeNull();
    });

    it("does not suppress anything in a rollout that is not a fork", () => {
      const state = initialCodexScanState();
      parseCodexLine(meta({ id: "root", timestamp: "2026-08-01T20:36:12.311Z" }), state);
      parseCodexLine(stamped("2026-08-01T20:36:12.411Z", turnContext), state);
      const record = parseCodexLine(
        stamped("2026-08-01T20:36:12.511Z", tokenCount(100, 0, 10, 0)),
        state,
      );

      expect(record).not.toBeNull();
    });
  });
});

describe("parseGrokLine", () => {
  // A `turn_completed` line as Grok 1.0.41 writes it to `updates.jsonl`.
  const turnCompleted = (usage: Record<string, unknown>) =>
    JSON.stringify({
      method: "_x.ai/session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "p1",
          stop_reason: "end_turn",
          usage,
        },
        _meta: { agentTimestampMs: 1_790_321_083_824 },
      },
    });

  it("reads one record per model, cached input split out and cost from ticks", () => {
    const records = parseGrokLine(
      turnCompleted({
        inputTokens: 44_685,
        outputTokens: 167,
        cachedReadTokens: 23_424,
        reasoningTokens: 102,
        costUsdTicks: 250_000_000,
        modelUsage: {
          "grok-4.7-build": {
            inputTokens: 44_685,
            outputTokens: 167,
            cachedReadTokens: 23_424,
            reasoningTokens: 102,
          },
        },
      }),
    );
    expect(records).toEqual([
      expect.objectContaining({
        provider: "grok",
        model: "grok-4.7-build",
        timestampMs: 1_790_321_083_824,
        totals: {
          uncachedInputTokens: 21_261,
          cachedInputTokens: 23_424,
          cacheCreationTokens: 0,
          outputTokens: 167,
          reasoningTokens: 102,
        },
        reportedCostUsd: 0.025,
        dedupeKey: "s1:p1:grok-4.7-build",
      }),
    ]);
  });

  it("ignores every other update", () => {
    expect(
      parseGrokLine(
        JSON.stringify({
          params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk" } },
        }),
      ),
    ).toEqual([]);
  });
});

describe("totalTokens", () => {
  it("does not add reasoning on top of output", () => {
    expect(
      totalTokens({
        uncachedInputTokens: 10,
        cachedInputTokens: 20,
        cacheCreationTokens: 30,
        outputTokens: 40,
        reasoningTokens: 25,
      }),
    ).toBe(100);
  });
});

describe("parsePiLine", () => {
  // An assistant entry as Pi 1.3.0 writes it to its session file.
  const assistant = JSON.stringify({
    type: "message",
    id: "4853d7cb",
    parentId: "5e29ac9a",
    timestamp: "2026-10-18T18:02:26.279Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      provider: "anthropic",
      model: "claude-x",
      usage: {
        input: 100,
        output: 40,
        cacheRead: 2_000,
        cacheWrite: 300,
        cacheWrite1h: 300,
        reasoning: 10,
        totalTokens: 2_440,
        cost: {
          input: 0.0003,
          output: 0.0006,
          cacheRead: 0.0006,
          cacheWrite: 0.001,
          total: 0.0025,
        },
      },
      stopReason: "stop",
      timestamp: 1_792_346_546_264,
    },
  });

  it("reads an assistant entry's tokens and Pi's own cost, keyed so copies count once", () => {
    const record = parsePiLine(assistant, "s1");
    expect(record).toEqual({
      provider: "pi",
      timestampMs: Date.parse("2026-10-18T18:02:26.279Z"),
      model: "anthropic/claude-x",
      sessionId: "s1",
      totals: {
        uncachedInputTokens: 100,
        cachedInputTokens: 2_000,
        cacheCreationTokens: 300,
        outputTokens: 40,
        reasoningTokens: 10,
      },
      cacheCreation1hTokens: 300,
      reportedCostUsd: 0.0025,
      dedupeKey: "4853d7cb:2026-10-18T18:02:26.279Z:anthropic/claude-x",
    });
    // A revert or fork copies the entry, id and timestamp included, into another file.
    expect(parsePiLine(assistant, "s2")?.dedupeKey).toBe(record?.dedupeKey);
  });

  it("counts summaries and usage entries, and skips entries that spent nothing", () => {
    const compaction = parsePiLine(
      JSON.stringify({
        type: "compaction",
        id: "c1",
        parentId: "p",
        timestamp: "2026-10-18T19:00:00.000Z",
        summary: "…",
        firstKeptEntryId: "x",
        usage: { input: 5_000, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } },
      }),
      "s1",
    );
    expect(compaction).toMatchObject({ model: "pi-summary", reportedCostUsd: 0.02 });
    const warm = parsePiLine(
      JSON.stringify({
        type: "usage",
        id: "u1",
        parentId: "p",
        timestamp: "2026-10-18T19:00:00.000Z",
        kind: "cache_warm",
        provider: "anthropic",
        model: "claude-x",
        usage: { input: 0, output: 0, cacheRead: 50_000, cacheWrite: 0, cost: { total: 0.015 } },
      }),
      "s1",
    );
    expect(warm).toMatchObject({
      model: "anthropic/claude-x",
      totals: { cachedInputTokens: 50_000 },
    });
    const user = JSON.stringify({
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-10-18T19:00:00.000Z",
      message: { role: "user", content: "hello", timestamp: 1 },
    });
    expect(parsePiLine(user, "s1")).toBeNull();
    expect(piSessionIdFromFileName("2026-10-18T18-04-31-383Z_01a1502f-c916.jsonl")).toBe(
      "01a1502f-c916",
    );
  });
});

describe("parseMuseLine", () => {
  // Records as Muse Code 1.4.11 writes them to its session logs.
  const museLine = (input: {
    id: string;
    streamKind: string;
    streamId: string;
    recordedAt: number;
    event: Record<string, unknown>;
  }) =>
    JSON.stringify({
      schema_version: 1,
      id: input.id,
      stream: { kind: input.streamKind, id: input.streamId },
      recorded_at: input.recordedAt,
      record_type: "event",
      payload_type: "runtime.session",
      payload: { kind: "run", run_id: "run-1", event: input.event },
    });
  const usage = {
    input_tokens: 36_401,
    output_tokens: 29,
    cached_tokens: 36_081,
    cache_write_tokens: 0,
    cache_read_tokens: 36_081,
    reasoning_tokens: 14,
  };

  it("reads a model call with the cached part split out of input", () => {
    const record = parseMuseLine(
      museLine({
        id: "01a14355-850f",
        streamKind: "session",
        streamId: "01a14355-7325",
        recordedAt: 1_792_131_040_527_451,
        event: { kind: "model_completed", usage, model: "muse-spark-1.3" },
      }),
      initialMuseScanState(),
      0,
    );

    expect(record).toEqual({
      provider: "muse",
      timestampMs: 1_792_131_040_527,
      model: "muse-spark-1.3",
      sessionId: "01a14355-7325",
      totals: {
        uncachedInputTokens: 320,
        cachedInputTokens: 36_081,
        cacheCreationTokens: 0,
        outputTokens: 29,
        reasoningTokens: 14,
      },
      cacheCreation1hTokens: 0,
      reportedCostUsd: null,
      dedupeKey: "01a14355-850f",
    });
  });

  it("dates an approval check by its file and names its model from the status line", () => {
    // Approval checks record on a fixed replay clock and name their model
    // only in an earlier status line.
    const state = initialMuseScanState();
    const replay = { streamKind: "approval.review.runtime", streamId: "9845cea2" };
    const status = museLine({
      ...replay,
      id: "status-1",
      recordedAt: 1_780_531_500_000_014,
      event: {
        kind: "status",
        details: {
          facets: [{ kind: "stream" }, { kind: "producer", detail: { model: "muse-wonder-1.0" } }],
        },
      },
    });
    const call = museLine({
      ...replay,
      id: "call-1",
      recordedAt: 1_780_531_500_000_016,
      event: { kind: "model_completed", usage },
    });

    expect(parseMuseLine(status, state, 1_792_090_000_000)).toBeNull();
    expect(parseMuseLine(call, state, 1_792_090_000_000)).toMatchObject({
      timestampMs: 1_792_090_000_000,
      model: "muse-wonder-1.0",
    });
  });

  it("ignores Muse's own usage accounting, which repeats the model calls", () => {
    const attribution = museLine({
      id: "attr-1",
      streamKind: "session",
      streamId: "01a14355-7325",
      recordedAt: 1_792_131_040_516_000,
      event: { kind: "goal_usage_attribution", record: { quantity: usage } },
    });

    expect(parseMuseLine(attribution, initialMuseScanState(), 0)).toBeNull();
  });
});
