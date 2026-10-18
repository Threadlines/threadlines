import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  decodePi,
  parsePiModelSlug,
  PiAgentSettled,
  PiAvailableModels,
  PiCloneResult,
  PiCommands,
  PiCompactionEnd,
  PiCompactionStart,
  PiEntries,
  PiExtensionUiRequest,
  PiForkResult,
  PiMessageEvent,
  PiMessageUpdate,
  PiPromptAck,
  PiQueueUpdate,
  PiSessionStats,
  PiState,
  PiToolExecution,
} from "./PiProtocol.ts";

// One record of each kind, as Pi 1.3.0 wrote them in RPC mode.
const records = readFileSync(join(import.meta.dirname, "fixtures/pi-1.3.0-records.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as Record<string, unknown>);

const eventSchemas: Record<string, Schema.Top> = {
  agent_settled: PiAgentSettled,
  compaction_start: PiCompactionStart,
  compaction_end: PiCompactionEnd,
  extension_ui_request: PiExtensionUiRequest,
  message_start: PiMessageEvent,
  message_end: PiMessageEvent,
  message_update: PiMessageUpdate,
  queue_update: PiQueueUpdate,
  tool_execution_start: PiToolExecution,
  tool_execution_update: PiToolExecution,
  tool_execution_end: PiToolExecution,
};

const replySchemas: Record<string, Schema.Top> = {
  clone: PiCloneResult,
  fork: PiForkResult,
  get_available_models: PiAvailableModels,
  get_commands: PiCommands,
  get_entries: PiEntries,
  get_session_stats: PiSessionStats,
  get_state: PiState,
  prompt: PiPromptAck,
};

describe("PiProtocol", () => {
  it("decodes every recorded Pi 1.3.0 record the adapter reads", () => {
    let checked = 0;
    for (const record of records) {
      const schema =
        record.type === "response"
          ? record.success === true
            ? replySchemas[String(record.command)]
            : undefined
          : eventSchemas[String(record.type)];
      if (!schema) continue;
      const value = record.type === "response" ? record.data : record;
      expect(Option.isSome(decodePi(schema)(value)), JSON.stringify(record).slice(0, 120)).toBe(
        true,
      );
      checked += 1;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("splits model slugs at the first slash only", () => {
    expect(parsePiModelSlug("openrouter/deepseek/deepseek-v4")).toEqual({
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4",
    });
    expect(parsePiModelSlug("default")).toBeUndefined();
    expect(parsePiModelSlug("anthropic/")).toBeUndefined();
  });
});
