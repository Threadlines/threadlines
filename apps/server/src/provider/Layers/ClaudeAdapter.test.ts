// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  Options as ClaudeQueryOptions,
  PermissionMode,
  PermissionResult,
  SDKControlGetContextUsageResponse,
  SDKMessage,
  SDKUserMessage,
  RewindFilesResult,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  ClaudeSettings,
  type ClaudeWorkflowSize,
  LEGACY_RUNTIME_MODES,
  MessageId,
  ProviderDriverKind,
  ProviderItemId,
  ProviderRuntimeEvent,
  RUNTIME_MODES,
  type RuntimeMode,
  ThreadId,
  ProviderInstanceId,
  TurnId,
  RuntimeTaskId,
} from "@threadlines/contracts";
import { createModelCapabilities, createModelSelection } from "@threadlines/shared/model";
import {
  SERVER_ADDED_VARIABLE,
  WORKING_FOLDER_LOOKUP_VARIABLE,
  stopWorkingFolderCommandLookup,
} from "@threadlines/shared/windowsCommandLookup";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import { mcpSessionRegistry } from "../../mcp/McpSessionRegistry.ts";
import { ROOM_REQUEST_DEADLINE } from "../../mcp/roomToolTimeouts.ts";
import { ROOM_TOOL_NAMES } from "../../mcp/roomToolAccess.ts";
import type { ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { claudeProjectDirectoryName } from "../Drivers/ClaudeSessionTranscripts.ts";
import {
  MARK_LONG_RUNNING_TOOL_ID,
  MARK_LONG_RUNNING_TOOL_NAME,
  THREADLINES_CLAUDE_MCP_SERVER_NAME,
} from "../claudeLongRunningTool.ts";
import {
  lockDownClaudeQueryOptions,
  makeClaudeAdapter,
  mapClaudeSubagentTranscript,
  pageClaudeSubagentTranscriptEntries,
  parseEnterWorktreeCwd,
  publishedArtifactFromToolResult,
  type ClaudeAdapterLiveOptions,
} from "./ClaudeAdapter.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

/**
 * Adapter environment pointing Claude transcript lookups at a directory that
 * never exists, so tests neither scan nor mutate the developer's real
 * `~/.claude/projects`. Resume tests that need a transcript on disk seed a
 * real config dir instead (see `seedClaudeTranscript`).
 */
/**
 * The test process's environment without Claude Code's own variables. An
 * agent running these tests from inside a Claude Code session would otherwise
 * hand its session's values (a suggestions setting, a session id) to every
 * session here, and tests that check what a session started with would see
 * the agent's instead.
 */
const hostEnvironment = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== "CLAUDECODE" && !key.startsWith("CLAUDE_CODE_"),
    ),
  );

const missingClaudeConfigEnvironment = (): NodeJS.ProcessEnv => ({
  ...hostEnvironment(),
  CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), "threadlines-claude-adapter-test-no-config"),
});

/** Create a temp Claude config dir holding a resumable transcript for `sessionId`. */
function seedClaudeTranscript(
  sessionId: string,
  contents = "",
): {
  readonly environment: NodeJS.ProcessEnv;
  readonly cleanup: () => void;
} {
  const configDir = mkdtempSync(path.join(os.tmpdir(), "claude-adapter-transcripts-"));
  const projectDir = path.join(configDir, "projects", claudeProjectDirectoryName(process.cwd()));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), contents);
  return {
    environment: { ...hostEnvironment(), CLAUDE_CONFIG_DIR: configDir },
    cleanup: () => rmSync(configDir, { recursive: true, force: true }),
  };
}

// Test-local service tag so the rest of the file can keep using `yield* ClaudeAdapter`.
class ClaudeAdapter extends Context.Service<ClaudeAdapter, ClaudeAdapterShape>()(
  "test/ClaudeAdapter",
) {}

class FakeClaudeQuery implements AsyncIterable<SDKMessage> {
  private readonly queue: Array<SDKMessage> = [];
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<SDKMessage>) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  private done = false;
  private failure: unknown | undefined;

  public readonly interruptCalls: Array<void> = [];
  public readonly stopTaskCalls: Array<string> = [];
  public readonly setModelCalls: Array<string | undefined> = [];
  public readonly setPermissionModeCalls: Array<string> = [];
  public readonly setMaxThinkingTokensCalls: Array<number | null> = [];
  public readonly applyFlagSettingsCalls: Array<{
    readonly effortLevel?: string | null;
    readonly alwaysThinkingEnabled?: boolean | null;
    readonly fastMode?: boolean | null;
    readonly ultracode?: boolean | null;
    readonly workflowSizeGuideline?: string | null;
    readonly env?: Readonly<Record<string, string>> | null;
  }> = [];
  public readonly getContextUsageCalls: Array<void> = [];
  public readonly rewindFilesCalls: Array<{
    readonly userMessageId: string;
    readonly options?: { readonly dryRun?: boolean };
  }> = [];
  private contextUsageResponses: Array<SDKControlGetContextUsageResponse> = [];
  private lastContextUsageResponse: SDKControlGetContextUsageResponse | undefined;
  public getContextUsage?: () => Promise<SDKControlGetContextUsageResponse>;
  public rewindFilesResult: RewindFilesResult = {
    canRewind: true,
    filesChanged: [],
    insertions: 0,
    deletions: 0,
  };
  public closeCalls = 0;

  setContextUsageResponse(response: SDKControlGetContextUsageResponse): void {
    this.setContextUsageResponses([response]);
  }

  setContextUsageResponses(responses: ReadonlyArray<SDKControlGetContextUsageResponse>): void {
    this.contextUsageResponses = [...responses];
    this.lastContextUsageResponse = responses[responses.length - 1];
    this.getContextUsage = async function (this: FakeClaudeQuery) {
      this.getContextUsageCalls.push(undefined);
      const response = this.contextUsageResponses.shift() ?? this.lastContextUsageResponse;
      if (!response) {
        throw new Error("No fake Claude context usage response configured.");
      }
      return response;
    } as () => Promise<SDKControlGetContextUsageResponse>;
  }

  emit(message: SDKMessage): void {
    if (this.done) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  fail(cause: unknown): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = cause;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(cause);
    }
  }

  finish(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = undefined;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  readonly interrupt = async (): Promise<void> => {
    this.interruptCalls.push(undefined);
  };

  readonly stopTask = async (taskId: string): Promise<void> => {
    this.stopTaskCalls.push(taskId);
  };

  public readonly backgroundTasksCalls: Array<string | undefined> = [];
  public taskOutputs = new Map<string, string>();

  readonly getTaskOutput = async (taskId: string) => {
    const output = this.taskOutputs.get(taskId) ?? "";
    return { output, total_bytes: Buffer.byteLength(output), truncated: false };
  };

  /** What `mcpServerStatus()` answers, as a test sets it. */
  public mcpStatus: unknown = [];
  public readonly mcpCalls: Array<unknown> = [];

  readonly mcpServerStatus = async (): Promise<unknown> => this.mcpStatus;

  readonly request = async (request: unknown): Promise<unknown> => {
    this.mcpCalls.push(request);
    return {
      subtype: "success",
      response: {
        content: [{ type: "text", text: "Counter at 4" }],
        structuredContent: { count: 4 },
      },
    };
  };

  readonly backgroundTasks = async (toolUseId?: string): Promise<boolean> => {
    this.backgroundTasksCalls.push(toolUseId);
    return true;
  };

  readonly setModel = async (model?: string): Promise<void> => {
    this.setModelCalls.push(model);
  };

  readonly setPermissionMode = async (mode: PermissionMode): Promise<void> => {
    this.setPermissionModeCalls.push(mode);
  };

  readonly setMaxThinkingTokens = async (maxThinkingTokens: number | null): Promise<void> => {
    this.setMaxThinkingTokensCalls.push(maxThinkingTokens);
  };

  readonly applyFlagSettings = async (settings: {
    readonly effortLevel?: string | null;
    readonly alwaysThinkingEnabled?: boolean | null;
    readonly fastMode?: boolean | null;
    readonly ultracode?: boolean | null;
    readonly workflowSizeGuideline?: string | null;
    readonly env?: Readonly<Record<string, string>> | null;
  }): Promise<void> => {
    this.applyFlagSettingsCalls.push(settings);
  };

  public readonly reloadCalls: Array<"plugins" | "skills"> = [];
  public failNextPluginReload = false;

  readonly reloadPlugins = async (): Promise<void> => {
    this.reloadCalls.push("plugins");
    if (this.failNextPluginReload) {
      this.failNextPluginReload = false;
      throw new Error("reload_plugins failed");
    }
  };

  readonly reloadSkills = async (): Promise<void> => {
    this.reloadCalls.push("skills");
  };

  readonly rewindFiles = async (
    userMessageId: string,
    options?: { readonly dryRun?: boolean },
  ): Promise<RewindFilesResult> => {
    this.rewindFilesCalls.push({
      userMessageId,
      ...(options !== undefined ? { options } : {}),
    });
    return this.rewindFilesResult;
  };

  readonly close = (): void => {
    this.closeCalls += 1;
    this.finish();
  };

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          const value = this.queue.shift();
          if (value) {
            return Promise.resolve({
              done: false,
              value,
            });
          }
        }
        if (this.failure !== undefined) {
          const failure = this.failure;
          this.failure = undefined;
          return Promise.reject(failure);
        }
        if (this.done) {
          return Promise.resolve({
            done: true,
            value: undefined,
          });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push({
            resolve,
            reject,
          });
        });
      },
    };
  }
}

function makeContextUsageResponse(input: {
  readonly totalTokens: number;
  readonly maxTokens: number;
  readonly rawMaxTokens?: number;
  readonly isAutoCompactEnabled?: boolean;
  readonly categories?: SDKControlGetContextUsageResponse["categories"];
}): SDKControlGetContextUsageResponse {
  return {
    // A category-less response is treated as a partially started process and
    // ignored by the adapter, so a usable fixture needs at least one category.
    categories: input.categories ?? [
      { name: "Messages", tokens: input.totalTokens, color: "#000000", kind: "used" },
    ],
    totalTokens: input.totalTokens,
    maxTokens: input.maxTokens,
    rawMaxTokens: input.rawMaxTokens ?? input.maxTokens,
    percentage: (input.totalTokens / input.maxTokens) * 100,
    gridRows: [],
    model: "claude-opus-4-6",
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled: input.isAutoCompactEnabled ?? true,
    apiUsage: null,
  };
}

function makeHarness(config?: {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: ClaudeAdapterLiveOptions["nativeEventLogger"];
  readonly cwd?: string;
  readonly baseDir?: string;
  readonly claudeConfig?: Partial<ClaudeSettings>;
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly onChatAuthStateChanged?: ClaudeAdapterLiveOptions["onChatAuthStateChanged"];
  readonly resolveModelMetadata?: ClaudeAdapterLiveOptions["resolveModelMetadata"];
  readonly workflowSize?: ClaudeAdapterLiveOptions["workflowSize"];
  readonly installedCliVersion?: string;
  readonly suggestionsWhenUsageRunsFast?: ClaudeAdapterLiveOptions["suggestionsWhenUsageRunsFast"];
}) {
  const query = new FakeClaudeQuery();
  let createInput:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptions;
      }
    | undefined;

  const adapterOptions: ClaudeAdapterLiveOptions = {
    environment: config?.environment ?? missingClaudeConfigEnvironment(),
    ...(config?.instanceId ? { instanceId: config.instanceId } : {}),
    createQuery: (input) => {
      createInput = input;
      return query;
    },
    ...(config?.nativeEventLogger
      ? {
          nativeEventLogger: config.nativeEventLogger,
        }
      : {}),
    ...(config?.nativeEventLogPath
      ? {
          nativeEventLogPath: config.nativeEventLogPath,
        }
      : {}),
    ...(config?.onChatAuthStateChanged
      ? { onChatAuthStateChanged: config.onChatAuthStateChanged }
      : {}),
    ...(config?.resolveModelMetadata ? { resolveModelMetadata: config.resolveModelMetadata } : {}),
    ...(config?.workflowSize ? { workflowSize: config.workflowSize } : {}),
    ...(config?.installedCliVersion
      ? { installedCliVersion: Effect.succeed(config.installedCliVersion) }
      : {}),
    ...(config?.suggestionsWhenUsageRunsFast
      ? { suggestionsWhenUsageRunsFast: config.suggestionsWhenUsageRunsFast }
      : {}),
  };

  return {
    layer: Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings(config?.claudeConfig ?? {});
        return yield* makeClaudeAdapter(claudeConfig, adapterOptions);
      }),
    ).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(
          config?.cwd ?? "/tmp/claude-adapter-test",
          config?.baseDir ?? "/tmp",
        ),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    ),
    query,
    getLastCreateQueryInput: () => createInput,
  };
}

/**
 * A tool_progress message a test sends after the messages it checks. The
 * adapter handles messages in order, so once this one's event arrives, every
 * event the earlier messages produce has too: collecting up to it lets a test
 * assert that an event never appeared, which a fixed `Stream.take(n)` window
 * cannot see past.
 */
const SETTLED_MARKER_TOOL_USE_ID = "toolu_events-settled";

function emitSettledMarker(harness: ReturnType<typeof makeHarness>): void {
  harness.query.emit({
    type: "tool_progress",
    tool_use_id: SETTLED_MARKER_TOOL_USE_ID,
    tool_name: "Bash",
    parent_tool_use_id: null,
    elapsed_time_seconds: 0,
    session_id: "sdk-session-settled-marker",
    uuid: "events-settled-marker",
  } as unknown as SDKMessage);
}

const isSettledMarker = (event: ProviderRuntimeEvent): boolean =>
  event.type === "tool.progress" && event.payload.toolUseId === SETTLED_MARKER_TOOL_USE_ID;

function makeDeterministicRandomService(seed = 0x1234_5678): {
  nextIntUnsafe: () => number;
  nextDoubleUnsafe: () => number;
} {
  let state = seed >>> 0;
  const nextIntUnsafe = (): number => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state;
  };

  return {
    nextIntUnsafe,
    nextDoubleUnsafe: () => nextIntUnsafe() / 0x1_0000_0000,
  };
}

async function readFirstPromptText(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<string | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  if (typeof next.value.message.content === "string") {
    return next.value.message.content;
  }
  const content = next.value.message.content[0];
  if (!content || content.type !== "text") {
    return undefined;
  }
  return content.text;
}

async function readFirstPromptMessage(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<SDKUserMessage | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  return next.value;
}

/** The first `count` messages sent to Claude, read from one iterator. */
async function readPromptMessages(
  input: { readonly prompt: AsyncIterable<SDKUserMessage> } | undefined,
  count: number,
): Promise<ReadonlyArray<SDKUserMessage>> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  const messages: Array<SDKUserMessage> = [];
  if (!iterator) return messages;
  while (messages.length < count) {
    const next = await iterator.next();
    if (next.done) break;
    messages.push(next.value);
  }
  return messages;
}

/** What decides how Claude treats a message: who it says wrote it, whether it
 *  starts a turn, and its text. */
function promptMessageShape(message: SDKUserMessage | undefined) {
  const content = message?.message.content;
  const first = Array.isArray(content) ? content[0] : undefined;
  return {
    origin: message?.origin,
    shouldQuery: message?.shouldQuery,
    text: typeof content === "string" ? content : first?.type === "text" ? first.text : undefined,
  };
}

/** Claude's init message, which names the CLI version. */
function claudeInitMessage(version: string): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    claude_code_version: version,
    tools: [],
    mcp_servers: [],
    model: "claude-opus-5-5",
    permissionMode: "bypassPermissions",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    session_id: "sdk-session-init",
    uuid: `init-${version}`,
  } as unknown as SDKMessage;
}

const THREAD_ID = ThreadId.make("thread-claude-1");
const RESUME_THREAD_ID = ThreadId.make("thread-claude-resume");

describe("mapClaudeSubagentTranscript", () => {
  const transcriptLine = (record: unknown) => JSON.stringify(record);

  it("maps thinking, text, tool calls, and tool results into renderable entries", () => {
    const jsonl = [
      "not-json",
      transcriptLine({ type: "system", message: { content: "ignored" } }),
      transcriptLine({
        type: "assistant",
        timestamp: "2026-07-26T12:00:00.000Z",
        message: {
          content: [
            { type: "thinking", thinking: "Plan the directory listing first." },
            { type: "text", text: "Listing the project now." },
            { type: "tool_use", name: "Bash", input: { command: "ls apps" } },
          ],
        },
      }),
      transcriptLine({
        type: "user",
        timestamp: "2026-07-26T12:00:01.000Z",
        message: {
          content: [{ type: "tool_result", content: [{ type: "text", text: "apps/\npackages/" }] }],
        },
      }),
      transcriptLine({
        type: "user",
        timestamp: "2026-07-26T12:00:02.000Z",
        message: { content: "plain user text" },
      }),
    ].join("\n");

    const result = mapClaudeSubagentTranscript(jsonl);
    assert.equal(result.truncated, false);
    assert.equal(result.entries.length, 4);
    assert.deepStrictEqual(result.entries[0], {
      role: "thinking",
      text: "Plan the directory listing first.",
      at: "2026-07-26T12:00:00.000Z",
      toolUses: [],
    });
    assert.equal(result.entries[1]?.role, "assistant");
    assert.equal(result.entries[1]?.text, "Listing the project now.");
    assert.equal(result.entries[1]?.at, "2026-07-26T12:00:00.000Z");
    assert.equal(result.entries[1]?.toolUses[0]?.name, "Bash");
    assert.ok(result.entries[1]?.toolUses[0]?.summary.includes("ls apps"));
    assert.deepStrictEqual(result.entries[2], {
      role: "user",
      text: "",
      at: "2026-07-26T12:00:01.000Z",
      toolUses: [],
      outputPreview: "apps/\npackages/",
    });
    assert.deepStrictEqual(result.entries[3], {
      role: "user",
      text: "plain user text",
      at: "2026-07-26T12:00:02.000Z",
      toolUses: [],
    });
  });

  it("keeps the agent's label for a shell call and marks a failed result", () => {
    const jsonl = [
      transcriptLine({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "pnpm test", description: "Run the van tests" },
            },
          ],
        },
      }),
      transcriptLine({
        type: "user",
        message: {
          content: [{ type: "tool_result", is_error: true, content: "1 test failed" }],
        },
      }),
    ].join("\n");

    const result = mapClaudeSubagentTranscript(jsonl);
    assert.equal(result.entries[0]?.toolUses[0]?.description, "Run the van tests");
    assert.equal(result.entries[1]?.outputIsError, true);
    assert.equal(result.entries[1]?.outputPreview, "1 test failed");
  });

  it("caps entry counts and long content", () => {
    const longLine = transcriptLine({
      type: "assistant",
      message: { content: [{ type: "text", text: "y".repeat(10_000) }] },
    });
    const capped = mapClaudeSubagentTranscript(longLine);
    assert.equal(capped.entries[0]?.text.length, 4_000);

    // A spawn prompt is read whole, so text sent to the agent keeps far more
    // than the agent's own output does.
    const longPrompt = transcriptLine({
      type: "user",
      message: { content: "p".repeat(40_000) },
    });
    const cappedPrompt = mapClaudeSubagentTranscript(longPrompt);
    assert.equal(cappedPrompt.entries[0]?.text.length, 32_000);

    const many = Array.from({ length: 5 }, () =>
      transcriptLine({
        type: "assistant",
        message: { content: [{ type: "text", text: "step" }] },
      }),
    ).join("\n");
    const limited = mapClaudeSubagentTranscript(many, { limit: 3 });
    assert.equal(limited.entries.length, 3);
    assert.equal(limited.truncated, true);
    assert.equal(limited.offset, 0);
    assert.equal(limited.totalEntries, 5);

    const latest = mapClaudeSubagentTranscript(many, { limit: 2, fromEnd: true });
    assert.deepStrictEqual(latest, {
      entries: [
        { role: "assistant", text: "step", toolUses: [] },
        { role: "assistant", text: "step", toolUses: [] },
      ],
      truncated: true,
      offset: 3,
      totalEntries: 5,
    });

    const earlier = mapClaudeSubagentTranscript(many, { limit: 2, offset: 1 });
    assert.deepStrictEqual(earlier, {
      entries: [
        { role: "assistant", text: "step", toolUses: [] },
        { role: "assistant", text: "step", toolUses: [] },
      ],
      truncated: true,
      offset: 1,
      totalEntries: 5,
    });

    const zeroLimit = mapClaudeSubagentTranscript(many, { limit: 0 });
    assert.equal(zeroLimit.entries.length, 5);
    assert.equal(zeroLimit.truncated, false);
  });

  it("uses absolute offsets when the incremental cache dropped older entries", () => {
    const retained = ["six", "seven", "eight"].map((text) => ({
      role: "assistant" as const,
      text,
      toolUses: [],
    }));
    assert.deepStrictEqual(
      pageClaudeSubagentTranscriptEntries(retained, { limit: 2, offset: 1 }, 5),
      {
        entries: retained.slice(0, 2),
        truncated: true,
        offset: 5,
        totalEntries: 8,
      },
    );
  });
});

describe("publishedArtifactFromToolResult", () => {
  // What Claude Code 2.1.295 reported for a real publish.
  const published = {
    url: "https://claude.ai/artifact/2vMm3R6NhqMe1ZDt7Y5v4k",
    path: "/tmp/probe/threadlines-artifact-test.html",
    artifact_id: "0f8c5a13-f4dc-47b8-8b31-195ff30a295d",
    title: "Threadlines artifact test",
    updated: false,
    icon: "chart",
    audience: "owner",
    seq: 1,
  };

  it("reads the file and link of a publish", () => {
    assert.deepStrictEqual(
      publishedArtifactFromToolResult({ file_path: published.path, icon: "chart" }, published),
      { path: published.path, url: published.url, title: published.title, icon: "chart" },
    );
  });

  it("ignores the tool's other actions and results that name no file", () => {
    assert.strictEqual(publishedArtifactFromToolResult({ action: "read" }, published), undefined);
    assert.strictEqual(
      publishedArtifactFromToolResult({ action: "list" }, { artifacts: [{ url: published.url }] }),
      undefined,
    );
    assert.strictEqual(publishedArtifactFromToolResult({}, { url: published.url }), undefined);
  });
});

describe("parseEnterWorktreeCwd", () => {
  it("prefers the explicit path input when entering an existing worktree", () => {
    assert.strictEqual(
      parseEnterWorktreeCwd(
        { path: "/repo/.claude/worktrees/feature" },
        "Entered existing worktree.",
      ),
      "/repo/.claude/worktrees/feature",
    );
  });

  it("parses the created-worktree sentence, including paths with spaces", () => {
    assert.strictEqual(
      parseEnterWorktreeCwd(
        { name: "feature" },
        "Created worktree at /Users/w/My Repo/.claude/worktrees/feature on branch worktree-feature. The session is now working in the worktree.",
      ),
      "/Users/w/My Repo/.claude/worktrees/feature",
    );
  });

  it("returns undefined for unrecognized result wording", () => {
    assert.strictEqual(parseEnterWorktreeCwd({}, "Switched somewhere unexpected."), undefined);
  });
});

describe("ClaudeAdapterLive", () => {
  it.effect("returns validation error for non-claude provider on startSession", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const result = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("codex"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.deepEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "startSession",
          issue: "Expected provider 'claudeAgent' but received 'codex'.",
        }),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("refuses to replace a live session while background tasks are running", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const startedEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-replace-guard",
        description: "Long-running background agent",
        task_type: "local_agent",
        session_id: "sdk-session-replace-guard",
        uuid: "task-replace-guard-started",
      } as unknown as SDKMessage);

      yield* Fiber.join(startedEventsFiber);

      const blocked = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);
      assert.equal(blocked._tag, "Failure");
      if (blocked._tag === "Failure") {
        assert.deepEqual(
          blocked.failure,
          new ProviderAdapterValidationError({
            provider: ProviderDriverKind.make("claudeAgent"),
            operation: "startSession",
            issue: `Refusing to replace the live Claude session for thread '${THREAD_ID}' while 1 background task(s) are still running. Stop the session first to discard them.`,
          }),
        );
      }

      const completedEventFiber = yield* Stream.take(adapter.streamEvents, 1).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-replace-guard",
        patch: {
          status: "completed",
        },
        session_id: "sdk-session-replace-guard",
        uuid: "task-replace-guard-updated",
      } as unknown as SDKMessage);
      yield* Fiber.join(completedEventFiber);

      // With every task settled the replace proceeds as before.
      const replaced = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);
      assert.equal(replaced._tag, "Success");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("derives bypass permission mode from full-access runtime policy", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settingSources, ["user", "project", "local"]);
      assert.equal(createInput?.options.permissionMode, "bypassPermissions");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("loads Claude filesystem settings sources for SDK sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settingSources, ["user", "project", "local"]);
      assert.equal(createInput?.options.enableFileCheckpointing, true);
      assert.equal(createInput?.options.promptSuggestions, true);
      assert.equal(createInput?.options.persistSession, true);
      assert.equal(createInput?.options.permissionMode, "default");
      assert.equal(createInput?.options.allowDangerouslySkipPermissions, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards configured Claude fallback model chains into query options", () => {
    const harness = makeHarness({
      claudeConfig: {
        fallbackModel: ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5", "claude-fable-5"],
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-5",
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(
        createInput?.options.fallbackModel,
        "claude-opus-4-8,claude-haiku-4-5,claude-fable-5",
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude model_fallback system messages to model reroute events", () => {
    const harness = makeHarness({
      claudeConfig: {
        fallbackModel: ["claude-opus-4-8"],
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-fable-5",
        ),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "system",
        subtype: "model_fallback",
        original_model: "claude-fable-5",
        fallback_model: "claude-opus-4-8",
        trigger: "unavailable",
        session_id: "sdk-session-model-fallback",
        uuid: "model-fallback-1",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-model-fallback",
        uuid: "result-model-fallback",
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const reroute = runtimeEvents.find((event) => event.type === "model.rerouted");
      assert.equal(reroute?.type, "model.rerouted");
      if (reroute?.type === "model.rerouted") {
        assert.equal(reroute.payload.fromModel, "claude-fable-5");
        assert.equal(reroute.payload.toModel, "claude-opus-4-8");
        assert.equal(reroute.payload.reason, "fallback:unavailable");
      }
      assert.isUndefined(runtimeEvents.find((event) => event.type === "runtime.warning"));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("runs Claude SDK sessions with the configured Claude HOME", () => {
    const harness = makeHarness({ claudeConfig: { homePath: "~/.claude-work" } });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.env?.HOME, path.join(os.homedir(), ".claude-work"));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("starts Claude SDK sessions with the user's command lookup, not the server's", () => {
    const hostValue = process.env[WORKING_FOLDER_LOOKUP_VARIABLE];
    // What the server does at startup on Windows, before the harness copies the
    // environment (the host may have set the variable itself).
    delete process.env[WORKING_FOLDER_LOOKUP_VARIABLE];
    stopWorkingFolderCommandLookup(process.env, "win32");
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
        ),
        runtimeMode: "full-access",
      });

      const env = harness.getLastCreateQueryInput()?.options.env;
      assert.equal(env?.PATH, process.env.PATH);
      assert.isUndefined(env?.[WORKING_FOLDER_LOOKUP_VARIABLE]);
      assert.isUndefined(env?.[SERVER_ADDED_VARIABLE]);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          delete process.env[SERVER_ADDED_VARIABLE];
          if (hostValue === undefined) delete process.env[WORKING_FOLDER_LOOKUP_VARIABLE];
          else process.env[WORKING_FOLDER_LOOKUP_VARIABLE] = hostValue;
        }),
      ),
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards the Claude Opus 4.7 default xhigh effort into query options", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-7",
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "xhigh");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses high effort and 1M context for Claude Opus 4.8 by default", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-8",
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.model, "claude-opus-4-8[1m]");
      assert.equal(createInput?.options.effort, "high");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses high effort and bare model id for Claude Sonnet 5 by default", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-5",
        },
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.model, "claude-sonnet-5");
      assert.equal(createInput?.options.effort, "high");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards Claude Opus 5 effort and fast mode on the canonical model id", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-5",
          [
            { id: "effort", value: "max" },
            { id: "fastMode", value: true },
            { id: "thinking", value: false },
          ],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.model, "claude-opus-5");
      assert.equal(createInput?.options.effort, "max");
      assert.deepEqual(createInput?.options.settings, {
        fastMode: true,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards live-discovered Claude model options through instance metadata", () => {
    const harness = makeHarness({
      resolveModelMetadata: () =>
        Effect.succeed({
          capabilities: createModelCapabilities({
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [
                  { id: "low", label: "Low" },
                  { id: "max", label: "Max" },
                ],
              },
              {
                id: "fastMode",
                label: "Fast Mode",
                type: "boolean",
              },
            ],
          }),
          supportedRuntimeModes: ["approval-required", "auto", "full-access"],
        }),
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-6",
          [
            { id: "effort", value: "max" },
            { id: "fastMode", value: true },
          ],
        ),
        runtimeMode: "auto",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.model, "claude-opus-6");
      assert.equal(createInput?.options.effort, "max");
      assert.equal(createInput?.options.permissionMode, "auto");
      assert.deepEqual(createInput?.options.settings, {
        fastMode: true,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores adaptive effort for Haiku 4.5", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-haiku-4-5",
          [{ id: "effort", value: "high" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards Claude Fable 5 effort without a thinking toggle", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-fable-5",
          [
            { id: "effort", value: "xhigh" },
            { id: "thinking", value: false },
          ],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.model, "claude-fable-5");
      assert.equal(createInput?.options.effort, "xhigh");
      assert.equal(createInput?.options.settings, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards Claude thinking toggle into SDK settings for Haiku 4.5", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-haiku-4-5",
          [{ id: "thinking", value: false }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.deepEqual(createInput?.options.settings, {
        alwaysThinkingEnabled: false,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards Claude ultracode as xhigh effort plus SDK settings", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-8",
          [{ id: "effort", value: "ultracode" }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "xhigh");
      assert.deepEqual(createInput?.options.settings, {
        ultracode: true,
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // Claude Code 2.1.284 runs Ultracode at any effort, so the switch rides
  // alongside the chosen level and turns off without moving it.
  it.effect("sends the Ultracode switch alongside the chosen effort", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-5-5",
          [
            { id: "effort", value: "medium" },
            { id: "ultracode", value: true },
          ],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.effort, "medium");
      assert.deepEqual(createInput?.options.settings, { ultracode: true });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-5-5",
          [
            { id: "effort", value: "medium" },
            { id: "ultracode", value: false },
          ],
        ),
        attachments: [],
      });

      assert.deepEqual(harness.query.applyFlagSettingsCalls, [
        {
          effortLevel: "medium",
          alwaysThinkingEnabled: null,
          fastMode: null,
          ultracode: null,
          workflowSizeGuideline: null,
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "sends the workflow size from Settings at start, and a changed one on the next turn",
    () => {
      let workflowSize: ClaudeWorkflowSize = "large";
      const harness = makeHarness({ workflowSize: Effect.sync(() => workflowSize) });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const selection = createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-5-5",
          [],
        );
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          modelSelection: selection,
          runtimeMode: "full-access",
        });

        assert.deepEqual(harness.getLastCreateQueryInput()?.options.settings, {
          workflowSizeGuideline: "large",
        });

        // Set back to Claude's default in Settings: null, so Claude's own size
        // (or its settings files') applies again, without a restart. A turn
        // that names no model still carries it, and keeps the other options.
        workflowSize = "default";
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });
        assert.deepEqual(harness.query.applyFlagSettingsCalls, [
          {
            effortLevel: harness.getLastCreateQueryInput()?.options.effort ?? null,
            alwaysThinkingEnabled: null,
            fastMode: null,
            ultracode: null,
            workflowSizeGuideline: null,
          },
        ]);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "keeps suggestions while usage runs fast as Settings says, from the next message both ways",
    () => {
      let keepSuggestions = true;
      const harness = makeHarness({
        suggestionsWhenUsageRunsFast: Effect.sync(() => keepSuggestions),
      });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          modelSelection: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            "claude-opus-5-5",
            [],
          ),
          runtimeMode: "full-access",
        });
        assert.deepEqual(harness.getLastCreateQueryInput()?.options.settings, {
          env: { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "true" },
        });

        // Claude keeps a flag `env` value after the key is cleared, so off
        // writes an empty value (read as unset), then clears the key so a
        // value from Claude's settings files comes back.
        keepSuggestions = false;
        yield* adapter.sendTurn({ threadId: session.threadId, input: "one", attachments: [] });
        keepSuggestions = true;
        yield* adapter.sendTurn({ threadId: session.threadId, input: "two", attachments: [] });
        // Unchanged: the env is left alone.
        yield* adapter.sendTurn({ threadId: session.threadId, input: "three", attachments: [] });
        assert.deepEqual(
          harness.query.applyFlagSettingsCalls.map((call) => call.env),
          [
            { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "" },
            null,
            { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "true" },
          ],
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("ignores claude fast mode for non-opus models", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "fastMode", value: true }],
        ),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.settings, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("injects a cross-driver context seed ahead of the first turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        contextSeed: {
          version: 1,
          fromProvider: ProviderDriverKind.make("codex"),
          entries: [{ kind: "message", role: "user", text: "Earlier: build a parser" }],
          workspacePointer: "The repo at /tmp/ws reflects in-progress work.",
        },
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "now add tests",
        attachments: [],
      });

      const promptText = yield* Effect.promise(() =>
        readFirstPromptText(harness.getLastCreateQueryInput()),
      );
      assert.isDefined(promptText);
      assert.include(promptText!, '<conversation-handoff from="codex">');
      assert.include(promptText!, "Earlier: build a parser");
      assert.include(promptText!, "The repo at /tmp/ws reflects in-progress work.");
      // The user's own prompt follows the seed preamble.
      assert.include(promptText!, "now add tests");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores a context seed when resuming a native session", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        resumeCursor: { threadId: RESUME_THREAD_ID, turnCount: 2 },
        contextSeed: {
          version: 1,
          fromProvider: ProviderDriverKind.make("codex"),
          entries: [{ kind: "message", role: "user", text: "Should not appear" }],
        },
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "continue",
        attachments: [],
      });

      const promptText = yield* Effect.promise(() =>
        readFirstPromptText(harness.getLastCreateQueryInput()),
      );
      assert.equal(promptText, "continue");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses Threadlines user message UUIDs for Claude SDK user messages", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const messageId = MessageId.make("33333333-3333-4333-8333-333333333333");
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        messageId,
        input: "hello",
        attachments: [],
      });

      const promptMessage = yield* Effect.promise(() =>
        readFirstPromptMessage(harness.getLastCreateQueryInput()),
      );
      assert.equal(promptMessage?.uuid, String(messageId));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("marks only the words a person typed as theirs, after the context on its own", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const configuredFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "session.configured",
      ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      harness.query.emit(claudeInitMessage("2.1.226"));
      yield* Fiber.join(configuredFiber);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "<room-catch-up>Sol: done</room-catch-up>\n\nultracode do X",
        typed: { text: "ultracode do X", context: "<room-catch-up>Sol: done</room-catch-up>" },
        attachments: [],
      });
      // Nobody typed this one (an agent or automation wrote it): never the user's.
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Report from a child thread: ultracode",
        attachments: [],
      });

      const messages = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 3),
      );
      assert.deepEqual(messages.map(promptMessageShape), [
        {
          origin: undefined,
          shouldQuery: false,
          text: "<room-catch-up>Sol: done</room-catch-up>",
        },
        { origin: { kind: "human" }, shouldQuery: undefined, text: "ultracode do X" },
        {
          origin: undefined,
          shouldQuery: undefined,
          text: "Report from a child thread: ultracode",
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("sends the device note on its own to a CLI known to take it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const configuredFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "session.configured",
      ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      harness.query.emit(claudeInitMessage("2.1.226"));
      yield* Fiber.join(configuredFiber);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "ultracode do X",
        typed: { text: "ultracode do X" },
        deviceNote: "Sent from their phone.",
        attachments: [],
      });
      // A side question: nobody's words are marked, the note still goes apart.
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "do Y",
        deviceNote: "Sent from their phone.",
        attachments: [],
      });

      const messages = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 4),
      );
      assert.deepEqual(messages.map(promptMessageShape), [
        { origin: undefined, shouldQuery: false, text: "Sent from their phone." },
        { origin: { kind: "human" }, shouldQuery: undefined, text: "ultracode do X" },
        { origin: undefined, shouldQuery: false, text: "Sent from their phone." },
        { origin: undefined, shouldQuery: undefined, text: "do Y" },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("never unmarks the user's words for the device note before the CLI is known", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      // A cold session's first sends: the CLI has not said which version it
      // is, and no check found the installed one either.
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "ultracode do X",
        typed: { text: "ultracode do X" },
        deviceNote: "Sent from their phone.",
        attachments: [],
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "do Y",
        deviceNote: "Sent from their phone.",
        attachments: [],
      });

      const messages = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 2),
      );
      assert.deepEqual(messages.map(promptMessageShape), [
        // Left out: sending it would take the mark off the user's words.
        { origin: { kind: "human" }, shouldQuery: undefined, text: "ultracode do X" },
        // Nobody's words are marked: it leads them.
        {
          origin: undefined,
          shouldQuery: undefined,
          text: "Sent from their phone.\n\n---\n\ndo Y",
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("sends a cold session's device note on its own when the installed CLI takes it", () => {
    const harness = makeHarness({ installedCliVersion: "2.1.226" });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "ultracode do X",
        typed: { text: "ultracode do X" },
        deviceNote: "Sent from their phone.",
        attachments: [],
      });

      const messages = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 2),
      );
      assert.deepEqual(messages.map(promptMessageShape), [
        { origin: undefined, shouldQuery: false, text: "Sent from their phone." },
        { origin: { kind: "human" }, shouldQuery: undefined, text: "ultracode do X" },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "moves running work to the background when the user steers, not when an agent does",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "Run the test suite",
          attachments: [],
        });
        const steer = (input: string, typed?: { readonly text: string }) =>
          adapter.steerTurn!({
            threadId: session.threadId,
            expectedTurnId: turn.turnId,
            input,
            ...(typed ? { typed } : {}),
            attachments: [],
          });

        // An agent's reply steered in waits for the running command.
        yield* steer("Report from a child thread: done.");
        yield* steer("Stop waiting and look at the failure", {
          text: "Stop waiting and look at the failure",
        });

        // The SDK pulls the turn's message and both steers...
        const sdk = harness.getLastCreateQueryInput()!.prompt[Symbol.asyncIterator]();
        for (let index = 0; index < 3; index++) {
          yield* Effect.promise(() => sdk.next());
        }
        // ...but has not sent the user's steer on yet: nothing moves before it is there.
        yield* Effect.yieldNow;
        assert.deepEqual(harness.query.backgroundTasksCalls, []);

        // Asking for the next message means the steer went out.
        void sdk.next();
        for (let spin = 0; spin < 100 && harness.query.backgroundTasksCalls.length === 0; spin++) {
          yield* Effect.yieldNow;
        }
        assert.deepEqual(harness.query.backgroundTasksCalls, [undefined]);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "reports Claude's check-backs, marks the turn one starts, and ends them with the session",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        type Hook = (
          input: unknown,
          toolUseId: string | undefined,
          options: unknown,
        ) => Promise<unknown>;
        const hooks = harness.getLastCreateQueryInput()?.options.hooks as unknown as Record<
          string,
          ReadonlyArray<{ readonly hooks: ReadonlyArray<Hook> }>
        >;
        const runHook = (event: string, input: unknown) =>
          Effect.promise(() => hooks[event]![0]!.hooks[0]!(input, undefined, {}));
        const nextEvent = (type: string) =>
          Stream.filter(adapter.streamEvents, (event) => event.type === type).pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.map((events) => events[0]),
            Effect.forkChild,
          );

        // Claude sets the job in a turn of this session.
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "Watch the deploy",
          attachments: [],
        });
        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-check-back",
          uuid: "cron-create-tool",
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "toolu_cron",
              name: "CronCreate",
              input: { cron: "*/5 * * * *", prompt: "Look at the deploy", recurring: true },
            },
          },
        } as unknown as SDKMessage);
        const created = yield* nextEvent("item.completed");
        harness.query.emit({
          type: "user",
          session_id: "sdk-session-check-back",
          uuid: "cron-create-result",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_cron", content: "Scheduled." }],
          },
          tool_use_result: {
            id: "job-1",
            humanSchedule: "every 5 minutes",
            recurring: true,
            durable: false,
          },
        } as unknown as SDKMessage);
        const createdItem = yield* Fiber.join(created);
        // Scheduling a check-back is a tool call, not a file change.
        assert.equal(
          createdItem?.type === "item.completed" ? createdItem.payload.itemType : null,
          "dynamic_tool_call",
        );
        const turnDone = yield* nextEvent("turn.completed");
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-check-back",
          uuid: "cron-create-turn-done",
        } as unknown as SDKMessage);
        yield* Fiber.join(turnDone);

        const reported = yield* nextEvent("session.check-backs.updated");
        yield* runHook("Stop", {
          hook_event_name: "Stop",
          session_crons: [
            { id: "job-1", schedule: "*/5 * * * *", recurring: true, prompt: "Look at the deploy" },
          ],
        });
        const update = yield* Fiber.join(reported);
        assert.equal(update?.type, "session.check-backs.updated");
        if (update?.type !== "session.check-backs.updated") return;
        assert.deepEqual(
          update.payload.checkBacks.map((checkBack) => [checkBack.id, checkBack.recurring]),
          [["job-1", true]],
        );

        // The job fires: Claude submits its prompt, then the turn it starts streams.
        const turnStarted = yield* nextEvent("turn.started");
        yield* runHook("UserPromptSubmit", {
          hook_event_name: "UserPromptSubmit",
          prompt: "Look at the deploy",
        });
        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-check-back",
          uuid: "stream-check-back-1",
          parent_tool_use_id: null,
          event: { type: "message_start", message: {} },
        } as unknown as SDKMessage);
        const started = yield* Fiber.join(turnStarted);
        assert.equal(
          started?.type === "turn.started" ? started.payload.trigger?.checkBackId : null,
          "job-1",
        );

        const ended = yield* nextEvent("session.check-backs.updated");
        yield* adapter.stopSession(session.threadId);
        const final = yield* Fiber.join(ended);
        assert.deepEqual(
          final?.type === "session.check-backs.updated"
            ? [
                final.payload.checkBacks.length,
                final.payload.ended?.map((checkBack) => checkBack.id),
              ]
            : null,
          [0, ["job-1"]],
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "gives a finished MCP call whose tool ships an app its app, and runs the app's calls",
    () => {
      const harness = makeHarness();
      const sdkSession = "sdk-session-mcp-app";
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: session.threadId, input: "Count", attachments: [] });
        harness.query.mcpStatus = [
          {
            name: "probe apps",
            status: "connected",
            tools: [
              { name: "show_counter", _meta: { ui: { resourceUri: "ui://probe/counter.html" } } },
              { name: "bump", _meta: { ui: { visibility: ["app"] } } },
            ],
          },
        ];
        const completed = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "item.completed" && event.itemId === "toolu_app",
        ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        harness.query.emit({
          type: "stream_event",
          session_id: sdkSession,
          uuid: "mcp-app-tool-use",
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "toolu_app",
              // Claude writes the server's name with "_" for anything but letters,
              // digits, "_" and "-".
              name: "mcp__probe_apps__show_counter",
              input: { start: 3 },
            },
          },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "user",
          session_id: sdkSession,
          uuid: "mcp-app-result",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_app", content: '{"count":3}' }],
          },
          tool_use_result: { content: '{"count":3}', structuredContent: { count: 3 } },
        } as unknown as SDKMessage);

        const [event] = yield* Fiber.join(completed);
        assert.deepEqual(event?.type === "item.completed" ? event.payload.mcpApp : null, {
          server: "probe apps",
          tool: "show_counter",
          resourceUri: "ui://probe/counter.html",
          arguments: { start: 3 },
          result: {
            content: [{ type: "text", text: '{"count":3}' }],
            structuredContent: { count: 3 },
          },
        });

        // The app's own call goes to the same server, under Claude's name for it.
        assert.deepEqual(
          yield* adapter.readMcpToolUi!(session.threadId, { server: "probe apps", tool: "bump" }),
          {
            resourceUri: null,
            visibility: ["app"],
          },
        );
        const result = yield* adapter.callMcpTool!(session.threadId, {
          server: "probe apps",
          tool: "bump",
          arguments: {},
        });
        // Its result is for the app, not Claude: the tool's own content blocks.
        assert.deepEqual(harness.query.mcpCalls, [
          {
            subtype: "mcp_call",
            tool: "mcp__probe_apps__bump",
            arguments: {},
            result_not_for_model: true,
          },
        ]);
        assert.deepEqual(result.content, [{ type: "text", text: "Counter at 4" }]);
        assert.deepEqual(result.structuredContent, { count: 4 });
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("reads what a running command has printed, by the tool call that started it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "Run it", attachments: [] });
      const nextEvent = (type: string) =>
        Stream.filter(adapter.streamEvents, (event) => event.type === type).pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
      const read = (toolCallId: string) => adapter.readCommandOutput!(session.threadId, toolCallId);

      const toolStarted = yield* nextEvent("item.started");
      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-output",
        uuid: "stream-output-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool-run", name: "Bash", input: {} },
        },
      } as unknown as SDKMessage);
      yield* Fiber.join(toolStarted);
      // Claude registers the command a few seconds in: until then there is nothing to read.
      assert.deepEqual(yield* read("tool-run"), { status: "pending" });
      assert.deepEqual(yield* read("tool-other"), { status: "unavailable" });

      const taskStarted = yield* nextEvent("task.started");
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-run",
        tool_use_id: "tool-run",
        description: "pnpm test",
        task_type: "local_bash",
        is_backgrounded: false,
        session_id: "sdk-session-output",
        uuid: "task-run-started",
      } as unknown as SDKMessage);
      yield* Fiber.join(taskStarted);
      harness.query.taskOutputs.set("task-run", "line 1\nline 2\n");
      assert.deepEqual(yield* read("tool-run"), {
        status: "running",
        tail: "line 1\nline 2\n",
        totalBytes: 14,
      });

      const taskEnded = yield* nextEvent("task.completed");
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-run",
        tool_use_id: "tool-run",
        status: "completed",
        output_file: "",
        summary: "pnpm test",
        session_id: "sdk-session-output",
        uuid: "task-run-ended",
      } as unknown as SDKMessage);
      yield* Fiber.join(taskEnded);
      assert.deepEqual(yield* read("tool-run"), { status: "unavailable" });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("sends words the user did not type as written when Claude would run them", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const configuredFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "session.configured",
      ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      harness.query.emit(claudeInitMessage("2.1.301"));
      yield* Fiber.join(configuredFiber);

      const send = (input: string, typed?: { readonly text: string }) =>
        adapter.sendTurn({
          threadId: session.threadId,
          input,
          ...(typed ? { typed } : {}),
          attachments: [],
        });
      // An agent's report that happens to start with a command.
      yield* send("/compact is what I ran earlier; the tests pass now.");
      // The user typing a command means it.
      yield* send("/compact", { text: "/compact" });
      yield* send("Report: the tests pass now.");

      const messages = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 3),
      );
      assert.deepEqual(
        messages.map((message) => (message as { client_composed?: true }).client_composed),
        [true, undefined, undefined],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "guards a command-like message with a character for a CLI too old to send as written",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const configuredFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "session.configured",
        ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        harness.query.emit(claudeInitMessage("2.1.240"));
        yield* Fiber.join(configuredFiber);
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "/goal was met by the other agent.",
          attachments: [],
        });
        const [message] = yield* Effect.promise(() =>
          readPromptMessages(harness.getLastCreateQueryInput(), 1),
        );
        assert.equal(promptMessageShape(message).text, "\u2060/goal was met by the other agent.");
        assert.isUndefined((message as { client_composed?: true } | undefined)?.client_composed);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("ends the turn on its own result, not on the context message's empty one", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const configuredFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "session.configured",
      ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
      const completedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      harness.query.emit(claudeInitMessage("2.1.226"));
      yield* Fiber.join(configuredFiber);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "<room-catch-up>Sol: done</room-catch-up>\n\nultracode do X",
        typed: { text: "ultracode do X", context: "<room-catch-up>Sol: done</room-catch-up>" },
        attachments: [],
      });
      // As CLI 2.1.296 does: the context message gets a result with no turn in
      // it before the turn the user's words start.
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 0,
        result: "",
        errors: [],
        session_id: "sdk-session-append",
        uuid: "result-append",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        result: "Done.",
        stop_reason: "end_turn",
        errors: [],
        session_id: "sdk-session-append",
        uuid: "result-turn",
      } as unknown as SDKMessage);

      const [completed] = Array.from(yield* Fiber.join(completedFiber));
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.stopReason, "end_turn");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("sends a CLI too old to append context the single unmarked message", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const configuredFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "session.configured",
      ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      harness.query.emit(claudeInitMessage("2.1.225"));
      yield* Fiber.join(configuredFiber);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "<room-catch-up>Sol: done</room-catch-up>\n\nultracode do X",
        typed: { text: "ultracode do X", context: "<room-catch-up>Sol: done</room-catch-up>" },
        attachments: [],
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "next", attachments: [] });

      const messages = yield* Effect.promise(() =>
        readPromptMessages(harness.getLastCreateQueryInput(), 2),
      );
      assert.deepEqual(messages.map(promptMessageShape), [
        {
          origin: undefined,
          shouldQuery: undefined,
          text: "<room-catch-up>Sol: done</room-catch-up>\n\nultracode do X",
        },
        { origin: undefined, shouldQuery: undefined, text: "next" },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("queues Claude compact slash command for manual context compaction", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      assert.isDefined(adapter.compactContext);
      yield* adapter.compactContext(session.threadId);
      const promptText = yield* Effect.promise(() =>
        readFirstPromptText(harness.getLastCreateQueryInput()),
      );
      assert.equal(promptText, "/compact");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("emits prompt suggestion runtime events after successful turns", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-suggestion",
        uuid: "result-suggestion",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "prompt_suggestion",
        suggestion: "Add regression tests for the completed change.",
        session_id: "sdk-session-suggestion",
        uuid: "prompt-suggestion-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const suggestionEvent = runtimeEvents.find(
        (event) => event.type === "turn.prompt-suggestion.updated",
      );
      assert.equal(suggestionEvent?.type, "turn.prompt-suggestion.updated");
      if (suggestionEvent?.type === "turn.prompt-suggestion.updated") {
        assert.equal(suggestionEvent.turnId, turn.turnId);
        assert.equal(
          suggestionEvent.payload.suggestion,
          "Add regression tests for the completed change.",
        );
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // A message sent while Claude writes its final answer runs as Claude's own
  // next turn once that answer ends. The thread must read as busy, and the
  // reply stream live, from its first streamed event.
  it.effect("opens a turn as soon as Claude streams output on its own", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const eventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) =>
          event.type === "turn.started" ||
          event.type === "turn.completed" ||
          event.type === "content.delta",
      ).pipe(Stream.take(4), Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "write it up",
        attachments: [],
      });
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-own-turn",
        uuid: "result-own-turn",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-own-turn",
        uuid: "stream-own-turn",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "And the follow-up:" },
        },
      } as unknown as SDKMessage);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepEqual(
        events.map((event) => event.type),
        ["turn.started", "turn.completed", "turn.started", "content.delta"],
      );
      const [, , ownTurnStarted, delta] = events;
      assert.notEqual(ownTurnStarted?.turnId, turn.turnId);
      assert.equal(delta?.turnId, ownTurnStarted?.turnId);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "And the follow-up:");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("embeds image attachments in Claude user messages", () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "claude-attachments-"));
    const harness = makeHarness({
      cwd: "/tmp/project-claude-attachments",
      baseDir,
    });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          rmSync(baseDir, {
            recursive: true,
            force: true,
          }),
        ),
      );

      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;

      const attachment = {
        type: "image" as const,
        id: "thread-claude-attachment-12345678-1234-1234-1234-123456789abc",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const attachmentPath = path.join(attachmentsDir, attachmentRelativePath(attachment));
      mkdirSync(path.dirname(attachmentPath), { recursive: true });
      writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "What's in this image?",
        attachments: [attachment],
      });

      const createInput = harness.getLastCreateQueryInput();
      const promptMessage = yield* Effect.promise(() => readFirstPromptMessage(createInput));
      assert.isDefined(promptMessage);
      assert.deepEqual(promptMessage?.message.content, [
        {
          type: "text",
          text: "What's in this image?",
        },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "AQIDBA==",
          },
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("embeds file attachments as native Claude document blocks", () => {
    const baseDir = mkdtempSync(path.join(os.tmpdir(), "claude-file-attachments-"));
    const harness = makeHarness({
      cwd: "/tmp/project-claude-file-attachments",
      baseDir,
    });
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          rmSync(baseDir, {
            recursive: true,
            force: true,
          }),
        ),
      );

      const adapter = yield* ClaudeAdapter;
      const { attachmentsDir } = yield* ServerConfig;

      const pdfBytes = Buffer.from("%PDF-1.4 fake");
      const pdfAttachment = {
        type: "file" as const,
        kind: "pdf" as const,
        id: "thread-claude-attachment-12345678-1234-1234-1234-123456789abc",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: pdfBytes.byteLength,
      };
      const textAttachment = {
        type: "file" as const,
        kind: "text" as const,
        id: "thread-claude-attachment-12345678-1234-1234-1234-123456789abd",
        name: "notes.md",
        mimeType: "text/markdown",
        sizeBytes: 7,
      };
      for (const [attachment, bytes] of [
        [pdfAttachment, pdfBytes],
        [textAttachment, Buffer.from("# notes")],
      ] as const) {
        const attachmentPath = path.join(attachmentsDir, attachmentRelativePath(attachment));
        mkdirSync(path.dirname(attachmentPath), { recursive: true });
        writeFileSync(attachmentPath, bytes);
      }

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "Summarize these files.",
        attachments: [pdfAttachment, textAttachment],
      });

      const createInput = harness.getLastCreateQueryInput();
      const promptMessage = yield* Effect.promise(() => readFirstPromptMessage(createInput));
      assert.isDefined(promptMessage);
      assert.deepEqual(promptMessage?.message.content, [
        {
          type: "text",
          text: "Summarize these files.",
        },
        {
          type: "document",
          title: "report.pdf",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: pdfBytes.toString("base64"),
          },
        },
        {
          type: "document",
          title: "notes.md",
          source: {
            type: "text",
            media_type: "text/plain",
            data: "# notes",
          },
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude stream/runtime messages to canonical provider runtime events", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-5",
        },
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-0",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Hi",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-3",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: {
              command: "ls",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-1",
        uuid: "stream-4",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-1",
        uuid: "assistant-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-1",
          content: [{ type: "text", text: "Hi" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-1",
        uuid: "result-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.completed",
          "turn.completed",
        ],
      );

      const turnStarted = runtimeEvents[3];
      assert.equal(turnStarted?.type, "turn.started");
      if (turnStarted?.type === "turn.started") {
        assert.equal(String(turnStarted.turnId), String(turn.turnId));
      }

      const deltaEvent = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");
      if (deltaEvent?.type === "content.delta") {
        assert.equal(deltaEvent.payload.delta, "Hi");
        assert.equal(String(deltaEvent.turnId), String(turn.turnId));
      }

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "command_execution");
      }

      const assistantCompletedIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      const toolStartedIndex = runtimeEvents.findIndex((event) => event.type === "item.started");
      assert.equal(
        assistantCompletedIndex >= 0 &&
          toolStartedIndex >= 0 &&
          assistantCompletedIndex < toolStartedIndex,
        true,
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "completed");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude compacting status to a waiting session state runtime event", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const statusEventFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) =>
          event.type === "session.state.changed" && event.payload.reason === "status:compacting",
      ).pipe(Stream.runHead, Effect.forkChild);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "system",
        subtype: "status",
        status: "compacting",
        session_id: "sdk-session-compacting",
        uuid: "status-compacting-1",
      } as unknown as SDKMessage);

      const statusEvent = yield* Fiber.join(statusEventFiber);
      assert.equal(statusEvent._tag, "Some");
      if (statusEvent._tag !== "Some") {
        return;
      }
      assert.equal(statusEvent.value.type, "session.state.changed");
      if (statusEvent.value.type !== "session.state.changed") {
        return;
      }
      assert.equal(statusEvent.value.payload.state, "waiting");
      assert.equal(statusEvent.value.payload.reason, "status:compacting");
      assert.equal(String(statusEvent.value.turnId), String(turn.turnId));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("adds login guidance to Claude authentication runtime errors", () => {
    const authStates: Array<"verified" | "unauthenticated"> = [];
    const harness = makeHarness({
      onChatAuthStateChanged: (state) =>
        Effect.sync(() => {
          authStates.push(state);
        }),
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const authRecoveryEventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "runtime.error" || event.type === "session.exited",
      ).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["Failed to authenticate. API Error: 401 Invalid authentication credentials"],
        session_id: "sdk-session-1",
        uuid: "result-auth-error",
      } as unknown as SDKMessage);

      const authRecoveryEvents = Array.from(yield* Fiber.join(authRecoveryEventsFiber));
      const runtimeError = authRecoveryEvents.find((event) => event.type === "runtime.error");
      const sessionExited = authRecoveryEvents.find((event) => event.type === "session.exited");
      assert.equal(runtimeError?.type, "runtime.error");
      if (runtimeError?.type !== "runtime.error") {
        return;
      }
      assert.equal(
        runtimeError.payload.message,
        "Failed to authenticate. API Error: 401 Invalid authentication credentials Run `claude auth login` in a terminal, then retry.",
      );
      assert.equal(runtimeError.payload.class, "authentication_error");
      assert.equal(sessionExited?.type, "session.exited");
      if (sessionExited?.type !== "session.exited") {
        return;
      }
      assert.deepEqual(sessionExited.payload, {
        reason: "Authentication failed",
        recoverable: true,
        exitKind: "error",
      });
      assert.equal(harness.query.closeCalls, 1);
      assert.deepEqual(authStates, ["unauthenticated"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("verifies chat authentication after a successful live turn", () => {
    const authStates: Array<"verified" | "unauthenticated"> = [];
    const harness = makeHarness({
      onChatAuthStateChanged: (state) =>
        Effect.sync(() => {
          authStates.push(state);
        }),
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const completedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-auth-success",
        uuid: "assistant-auth-success",
        message: {
          id: "assistant-message-auth-success",
          content: [{ type: "text", text: "Authenticated response" }],
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-auth-success",
        uuid: "result-auth-success",
      } as unknown as SDKMessage);

      yield* Fiber.join(completedFiber);
      assert.deepEqual(authStates, ["verified"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // The messages a CLI (2.1.289) sent when the Claude API refused one request
  // in the middle of a turn, usage figures trimmed.
  const API_REFUSAL_TEXT =
    "Failed to authenticate. API Error: 403 Access to this model requires an access grant your request does not have.";
  const apiErrorNote = (input: {
    readonly text: string;
    readonly error?: string;
    readonly flagged?: boolean;
  }) =>
    ({
      type: "assistant",
      message: {
        id: "0834383b-142e-40fe-b0d0-7306ecfe0112",
        model: "<synthetic>",
        role: "assistant",
        stop_reason: "stop_sequence",
        stop_sequence: "",
        type: "message",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: [{ type: "text", text: input.text }],
      },
      parent_tool_use_id: null,
      session_id: "sdk-session-api-error",
      uuid: "0375bc39-ca97-4b27-9cd1-56064d6689ad",
      ...(input.error !== undefined ? { error: input.error } : {}),
      request_id: "req_011Cfk9YTEuVxGUw3WJ4rFPz",
      ...(input.flagged === false ? {} : { is_api_error_message: true }),
    }) as unknown as SDKMessage;
  const apiErrorResult = (input: {
    readonly result: string;
    readonly status?: number;
    readonly uuid?: string;
  }) =>
    ({
      type: "result",
      subtype: "success",
      is_error: true,
      ...(input.status !== undefined ? { api_error_status: input.status } : {}),
      result: input.result,
      stop_reason: "stop_sequence",
      terminal_reason: "api_error",
      num_turns: 191,
      permission_denials: [],
      session_id: "sdk-session-api-error",
      uuid: input.uuid ?? "c0891134-a8d0-4355-951b-9b7a759260e9",
    }) as unknown as SDKMessage;

  it.effect("fails a turn the service ended with an API error, in the service's words", () => {
    const authStates: Array<"verified" | "unauthenticated"> = [];
    const harness = makeHarness({
      onChatAuthStateChanged: (state) =>
        Effect.sync(() => {
          authStates.push(state);
        }),
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const failedTurnEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const failedTurn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      // Claude was mid-work: a progress note had already been written.
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-api-error",
        uuid: "assistant-progress-note",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-progress-note",
          content: [{ type: "text", text: "Fixing a few type mismatches, then running it." }],
        },
      } as unknown as SDKMessage);
      harness.query.emit(apiErrorNote({ error: "authentication_failed", text: API_REFUSAL_TEXT }));
      harness.query.emit(apiErrorResult({ result: API_REFUSAL_TEXT, status: 403 }));

      const failedTurnEvents = Array.from(yield* Fiber.join(failedTurnEventsFiber));

      // The service's error is the turn's error, not something Claude said.
      const writtenText = failedTurnEvents.flatMap((event) =>
        event.type === "content.delta" ? [event.payload.delta] : [],
      );
      assert.deepEqual(writtenText, ["Fixing a few type mismatches, then running it."]);

      const runtimeError = failedTurnEvents.find((event) => event.type === "runtime.error");
      assert.equal(runtimeError?.type, "runtime.error");
      if (runtimeError?.type === "runtime.error") {
        // A 403 is not a lost sign-in, so nothing sends the user to sign in.
        assert.equal(runtimeError.payload.message, API_REFUSAL_TEXT);
        assert.equal(runtimeError.payload.class, "provider_error");
        // The CLI's own kind for the error names the failure.
        assert.equal(runtimeError.payload.failureCategory, "auth");
        assert.equal(String(runtimeError.turnId), String(failedTurn.turnId));
      }

      const turnCompleted = failedTurnEvents.at(-1);
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(failedTurn.turnId));
        assert.equal(turnCompleted.payload.state, "failed");
        assert.equal(turnCompleted.payload.errorMessage, API_REFUSAL_TEXT);
        assert.equal(turnCompleted.payload.failureCategory, "auth");
      }
      assert.deepEqual(authStates, ["verified"]);

      // The session is still there, and the next message runs as usual.
      const nextTurnCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);
      const nextTurn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "carry on",
        attachments: [],
      });
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-api-error",
        uuid: "result-after-api-error",
      } as unknown as SDKMessage);

      const nextTurnCompleted = yield* Fiber.join(nextTurnCompletedFiber);
      assert.equal(nextTurnCompleted._tag, "Some");
      if (nextTurnCompleted._tag === "Some" && nextTurnCompleted.value.type === "turn.completed") {
        assert.equal(String(nextTurnCompleted.value.turnId), String(nextTurn.turnId));
        assert.equal(nextTurnCompleted.value.payload.state, "completed");
      }
      assert.equal(harness.query.closeCalls, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("fails a turn on any kind of API error, even when the result has no text", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const turnCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const overloadedText = "API Error: 529 Overloaded. Try again in a moment.";
      // Marked by its error kind alone, as the SDK types describe it.
      harness.query.emit(
        apiErrorNote({ error: "overloaded", text: overloadedText, flagged: false }),
      );
      harness.query.emit(apiErrorResult({ result: "", status: 529 }));

      const turnCompleted = yield* Fiber.join(turnCompletedFiber);
      assert.equal(turnCompleted._tag, "Some");
      if (turnCompleted._tag === "Some" && turnCompleted.value.type === "turn.completed") {
        assert.equal(turnCompleted.value.payload.state, "failed");
        assert.equal(turnCompleted.value.payload.errorMessage, overloadedText);
        assert.equal(turnCompleted.value.payload.failureCategory, "overloaded");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("names a plan usage limit and its reset, and not a brief rate limit", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const nextCompletion = () =>
        Stream.filter(adapter.streamEvents, (event) => event.type === "turn.completed").pipe(
          Stream.runHead,
          Effect.forkChild,
        );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const limitedFiber = yield* nextCompletion();
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });
      const limitText = "You've hit your session limit · resets 2:20pm (America/New_York)";
      harness.query.emit({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: 1_767_268_800,
          rateLimitType: "five_hour",
        },
        session_id: "sdk-session-api-error",
        uuid: "rate-limit-1",
      } as unknown as SDKMessage);
      harness.query.emit(apiErrorNote({ error: "rate_limit", text: limitText }));
      harness.query.emit(apiErrorResult({ result: limitText, status: 429 }));
      const limited = yield* Fiber.join(limitedFiber);

      // What the CLI really sends (2.1.314): no rate-limit report, the
      // refusal and its reset on the error note itself.
      const notedFiber = yield* nextCompletion();
      yield* adapter.sendTurn({ threadId: session.threadId, input: "later", attachments: [] });
      const weeklyText = "You've hit your weekly limit · resets Oct 22 at 11pm (America/New_York)";
      harness.query.emit({
        ...(apiErrorNote({ error: "rate_limit", text: weeklyText }) as object),
        api_error: "usage_limit_reached",
        api_error_params: {
          rate_limit_info: {
            status: "rejected",
            resetsAt: 1_767_484_800,
            rateLimitType: "seven_day",
            overageStatus: "rejected",
            overageDisabledReason: "out_of_credits",
            isUsingOverage: false,
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit(
        apiErrorResult({ result: weeklyText, status: 429, uuid: "result-weekly" }),
      );
      const noted = yield* Fiber.join(notedFiber);
      assert.equal(noted._tag, "Some");
      if (noted._tag === "Some" && noted.value.type === "turn.completed") {
        assert.deepEqual(noted.value.payload.usageLimit, {
          window: "weekly",
          resetsAt: "2026-01-04T00:00:00.000Z",
        });
      }

      const briefFiber = yield* nextCompletion();
      yield* adapter.sendTurn({ threadId: session.threadId, input: "again", attachments: [] });
      const briefText = "API Error: 429 Too many requests. Try again shortly.";
      harness.query.emit(apiErrorNote({ error: "rate_limit", text: briefText }));
      harness.query.emit(apiErrorResult({ result: briefText, status: 429, uuid: "result-brief" }));
      const brief = yield* Fiber.join(briefFiber);

      // An org out of funds doesn't reset by itself.
      const fundsFiber = yield* nextCompletion();
      yield* adapter.sendTurn({ threadId: session.threadId, input: "once more", attachments: [] });
      const fundsText = "Your org is out of usage · add funds to continue";
      harness.query.emit(apiErrorNote({ error: "billing_error", text: fundsText }));
      harness.query.emit(apiErrorResult({ result: fundsText, uuid: "result-funds" }));
      const funds = yield* Fiber.join(fundsFiber);

      assert.equal(limited._tag, "Some");
      if (limited._tag === "Some" && limited.value.type === "turn.completed") {
        assert.equal(limited.value.payload.failureCategory, "rate_limit");
        assert.deepEqual(limited.value.payload.usageLimit, {
          window: "session",
          resetsAt: "2026-01-01T12:00:00.000Z",
        });
      }
      for (const ordinary of [brief, funds]) {
        assert.equal(ordinary._tag, "Some");
        if (ordinary._tag === "Some" && ordinary.value.type === "turn.completed") {
          assert.equal(ordinary.value.payload.state, "failed");
          assert.equal(ordinary.value.payload.usageLimit, undefined);
        }
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // Claude got past the API error, shown by a full reply or by streaming again,
  // then ran out of turns.
  for (const [carriedOn, message] of [
    [
      "replied again",
      {
        type: "assistant",
        session_id: "sdk-session-api-error",
        uuid: "assistant-after-retry",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-after-retry",
          content: [{ type: "text", text: "Picking up where I left off." }],
        },
      },
    ],
    [
      "streamed again",
      {
        type: "stream_event",
        session_id: "sdk-session-api-error",
        uuid: "stream-after-retry",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: { id: "assistant-message-after-retry", role: "assistant", content: [] },
        },
      },
    ],
  ] as const) {
    it.effect(`names a failure by the turn's own end once Claude ${carriedOn}`, () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const turnCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        harness.query.emit(
          apiErrorNote({ error: "rate_limit", text: "API Error: 429 rate limited" }),
        );
        harness.query.emit(message as unknown as SDKMessage);
        harness.query.emit({
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          errors: [],
          session_id: "sdk-session-api-error",
          uuid: "result-max-turns",
        } as unknown as SDKMessage);

        const turnCompleted = yield* Fiber.join(turnCompletedFiber);
        assert.equal(turnCompleted._tag, "Some");
        if (turnCompleted._tag === "Some" && turnCompleted.value.type === "turn.completed") {
          assert.equal(turnCompleted.value.payload.state, "failed");
          assert.equal(turnCompleted.value.payload.failureCategory, "execution_limit");
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  }

  // A late event of the request that failed leaves the error standing; a new
  // reply means Claude got past it, so a stream ending there only stopped.
  for (const [after, events, expected] of [
    ["nothing else", [], { state: "failed", errorMessage: API_REFUSAL_TEXT }],
    [
      "the failed request's last event",
      [{ type: "message_stop" }],
      { state: "failed", errorMessage: API_REFUSAL_TEXT },
    ],
    [
      "Claude began a new reply",
      [
        {
          type: "message_start",
          message: { id: "assistant-message-after-error", role: "assistant", content: [] },
        },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Trying" } },
      ],
      { state: "interrupted", errorMessage: "Claude runtime stream ended." },
    ],
  ] as const) {
    it.effect(`ends a turn whose stream stops after an API error, then ${after}`, () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const turnCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        harness.query.emit(
          apiErrorNote({ error: "authentication_failed", text: API_REFUSAL_TEXT }),
        );
        for (const [index, event] of events.entries()) {
          harness.query.emit({
            type: "stream_event",
            session_id: "sdk-session-api-error",
            uuid: `stream-after-error-${index}`,
            parent_tool_use_id: null,
            event,
          } as unknown as SDKMessage);
        }
        harness.query.finish();

        const turnCompleted = yield* Fiber.join(turnCompletedFiber);
        assert.equal(turnCompleted._tag, "Some");
        if (turnCompleted._tag === "Some" && turnCompleted.value.type === "turn.completed") {
          assert.equal(turnCompleted.value.payload.state, expected.state);
          assert.equal(turnCompleted.value.payload.errorMessage, expected.errorMessage);
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    });
  }

  it.effect("completes a turn that carried on after an API error", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const turnEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      // Marked by the flag alone, with no error kind.
      harness.query.emit(
        apiErrorNote({
          text: "API Error: Claude's response exceeded the 32000 output token maximum.",
        }),
      );
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-api-error",
        uuid: "assistant-after-api-error",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-after-api-error",
          content: [{ type: "text", text: "Picking up where I left off." }],
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Picking up where I left off.",
        errors: [],
        session_id: "sdk-session-api-error",
        uuid: "result-recovered",
      } as unknown as SDKMessage);

      const turnEvents = Array.from(yield* Fiber.join(turnEventsFiber));
      assert.notInclude(
        turnEvents.map((event) => event.type),
        "runtime.error",
      );
      assert.deepEqual(
        turnEvents.flatMap((event) =>
          event.type === "content.delta" ? [event.payload.delta] : [],
        ),
        ["Picking up where I left off."],
      );
      const turnCompleted = turnEvents.at(-1);
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "completed");
        assert.equal(turnCompleted.payload.errorMessage, undefined);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude reasoning deltas, streamed tool inputs, and tool results", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 13).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-thinking-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-thinking",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: "Let",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-thinking-stop",
        parent_tool_use_id: null,
        event: { type: "content_block_stop", index: 0 },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-grep-1",
            name: "Grep",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-input-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: '{"pattern":"foo","path":"src"}',
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-tool-streams",
        uuid: "stream-tool-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-tool-streams",
        uuid: "user-tool-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-grep-1",
              content: "src/example.ts:1:foo",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-tool-streams",
        uuid: "result-tool-streams",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "item.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.updated",
          "item.updated",
          "item.completed",
          "turn.completed",
        ],
      );

      // The thinking block is a reasoning item from start to stop, so the
      // working row says "Thinking" for its whole length, and its text is the
      // readable summary.
      const reasoningStarted = runtimeEvents.find(
        (event) => event.type === "item.started" && event.payload.itemType === "reasoning",
      );
      const reasoningDelta = runtimeEvents.find(
        (event) =>
          event.type === "content.delta" && event.payload.streamKind === "reasoning_summary_text",
      );
      const reasoningCompleted = runtimeEvents.find(
        (event) => event.type === "item.completed" && event.payload.itemType === "reasoning",
      );
      assert.equal(reasoningDelta?.type, "content.delta");
      if (reasoningDelta?.type === "content.delta") {
        assert.equal(reasoningDelta.payload.delta, "Let");
        assert.equal(String(reasoningDelta.turnId), String(turn.turnId));
        assert.equal(reasoningDelta.itemId, reasoningStarted?.itemId);
      }
      assert.equal(reasoningCompleted?.itemId, reasoningStarted?.itemId);
      if (reasoningCompleted?.type === "item.completed") {
        assert.deepEqual(reasoningCompleted.payload.data, { summary: "Let" });
      }

      const toolStarted = runtimeEvents.find(
        (event) => event.type === "item.started" && event.payload.itemType !== "reasoning",
      );
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "dynamic_tool_call");
      }

      const toolInputUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { input?: { pattern?: string; path?: string } } | undefined)?.input
            ?.pattern === "foo",
      );
      assert.equal(toolInputUpdated?.type, "item.updated");
      if (toolInputUpdated?.type === "item.updated") {
        assert.deepEqual(toolInputUpdated.payload.data, {
          toolName: "Grep",
          input: {
            pattern: "foo",
            path: "src",
          },
        });
      }

      const toolResultUpdated = runtimeEvents.find(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { result?: { tool_use_id?: string } } | undefined)?.result
            ?.tool_use_id === "tool-grep-1",
      );
      assert.equal(toolResultUpdated?.type, "item.updated");
      if (toolResultUpdated?.type === "item.updated") {
        assert.equal(
          (
            toolResultUpdated.payload.data as {
              result?: { content?: string };
            }
          ).result?.content,
          "src/example.ts:1:foo",
        );
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("streams estimated file-change stats while an Edit input is still streaming", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        cwd: "/repo",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-edit-live",
        uuid: "stream-edit-live-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-edit-live",
            name: "Edit",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      // The path and old_string have fully streamed; new_string is mid-flight
      // and repeats the old lines before appending two new ones.
      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-edit-live",
        uuid: "stream-edit-live-input-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json:
              '{"file_path":"/repo/src/live.ts","old_string":"a\\nb","new_string":"a\\nb\\nc\\nd',
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-edit-live",
        uuid: "stream-edit-live-input-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json: '"}',
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-edit-live",
        uuid: "stream-edit-live-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-edit-live",
        uuid: "user-edit-live-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-edit-live",
              content: "ok",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-edit-live",
        uuid: "result-edit-live",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

      const estimateIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.updated" &&
          Array.isArray((event.payload.data as { changes?: unknown } | undefined)?.changes),
      );
      assert.notEqual(estimateIndex, -1);
      const estimateEvent = runtimeEvents[estimateIndex];
      if (estimateEvent?.type === "item.updated") {
        assert.equal(estimateEvent.payload.detail, "src/live.ts");
        assert.deepEqual(estimateEvent.payload.data, {
          toolName: "Edit",
          input: { file_path: "/repo/src/live.ts" },
          changes: [{ path: "/repo/src/live.ts", kind: "update", additions: 2, deletions: 0 }],
        });
      }

      // The fully parsed input still follows as its own update.
      const parsedIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.updated" &&
          (event.payload.data as { input?: { old_string?: string } } | undefined)?.input
            ?.old_string === "a\nb",
      );
      assert.equal(parsedIndex > estimateIndex, true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("summarizes Edit calls with workspace paths and per-file diff stats", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        cwd: "/repo",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-edit",
        uuid: "stream-edit-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-edit-1",
            name: "Edit",
            input: {
              file_path: "/repo/src/app.ts",
              old_string: "a",
              new_string: "b\nc",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-edit",
        uuid: "stream-edit-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      // Replay the PostToolUse hook exactly as the SDK fires it after the
      // tool runs, before the tool_result message reaches the stream.
      const postToolUse =
        harness.getLastCreateQueryInput()?.options.hooks?.PostToolUse?.[0]?.hooks[0];
      assert.notEqual(postToolUse, undefined);
      if (postToolUse) {
        yield* Effect.promise(() =>
          postToolUse(
            {
              hook_event_name: "PostToolUse",
              tool_name: "Edit",
              tool_input: {
                file_path: "/repo/src/app.ts",
                old_string: "a",
                new_string: "b\nc",
              },
              tool_response: {
                filePath: "/repo/src/app.ts",
                oldString: "a",
                newString: "b\nc",
                originalFile: "a\n",
                structuredPatch: [
                  {
                    oldStart: 1,
                    oldLines: 1,
                    newStart: 1,
                    newLines: 2,
                    lines: ["-a", "+b", "+c"],
                  },
                ],
                userModified: false,
                replaceAll: false,
              },
              tool_use_id: "tool-edit-1",
              session_id: "sdk-session-edit",
              transcript_path: "/tmp/transcript.jsonl",
              cwd: "/repo",
            } as unknown as Parameters<NonNullable<typeof postToolUse>>[0],
            "tool-edit-1",
            { signal: new AbortController().signal },
          ),
        );
      }

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-edit",
        uuid: "user-edit-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-edit-1",
              content: "ok",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-edit",
        uuid: "result-edit",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "item.started",
          "item.updated",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "file_change");
        assert.equal(toolStarted.payload.title, "File change");
        assert.equal(toolStarted.payload.detail, "src/app.ts");
      }

      const toolCompleted = runtimeEvents.find((event) => event.type === "item.completed");
      assert.equal(toolCompleted?.type, "item.completed");
      if (toolCompleted?.type === "item.completed") {
        assert.deepEqual((toolCompleted.payload.data as { changes?: unknown }).changes, [
          { path: "/repo/src/app.ts", kind: "update", additions: 2, deletions: 1 },
        ]);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("falls back to a default plan step label for blank TodoWrite content", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo-plan",
        uuid: "stream-todo-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-todo-1",
            name: "TodoWrite",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo-plan",
        uuid: "stream-todo-input",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            partial_json:
              '{"todos":[{"content":"   ","status":"in_progress"},{"content":"Ship it","status":"completed"}]}',
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-todo-plan",
        uuid: "stream-todo-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-todo-plan",
        uuid: "result-todo-plan",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const planUpdated = runtimeEvents.find((event) => event.type === "turn.plan.updated");
      assert.equal(planUpdated?.type, "turn.plan.updated");
      if (planUpdated?.type === "turn.plan.updated") {
        assert.equal(String(planUpdated.turnId), String(turn.turnId));
        assert.deepEqual(planUpdated.payload.plan, [
          { step: "Task", status: "inProgress" },
          { step: "Ship it", status: "completed" },
        ]);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("mirrors task tracker tool calls into plan updates", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 21).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task-tracker",
        uuid: "stream-task-create-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-task-create-1",
            name: "TaskCreate",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task-tracker",
        uuid: "stream-task-create-input",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "input_json_delta",
            // The model sometimes mis-closes the subject tag and the harness
            // folds the next parameters into it; the plan step must stay clean.
            partial_json:
              '{"subject":"Investigate flaky login test</subject>\\n<parameter name=\\"description\\">Find the race in the login spec</parameter>\\n<parameter name=\\"activeForm\\">Investigating","description":"Find the race in the login spec"}',
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task-tracker",
        uuid: "stream-task-create-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-task-tracker",
        uuid: "user-task-create-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-task-create-1",
              content: "Task #1 created successfully: Investigate flaky login test",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task-tracker",
        uuid: "stream-task-update-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "tool_use",
            id: "tool-task-update-1",
            name: "TaskUpdate",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task-tracker",
        uuid: "stream-task-update-input",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 2,
          delta: {
            type: "input_json_delta",
            partial_json: '{"taskId":"1","status":"in_progress"}',
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-task-tracker",
        uuid: "user-task-update-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-task-update-1",
              content: "Updated task #1 status",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task-tracker",
        uuid: "stream-task-complete-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 3,
          content_block: {
            type: "tool_use",
            id: "tool-task-update-2",
            name: "TaskUpdate",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task-tracker",
        uuid: "stream-task-complete-input",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 3,
          delta: {
            type: "input_json_delta",
            partial_json: '{"taskId":"1","status":"completed"}',
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-task-tracker",
        uuid: "user-task-complete-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-task-update-2",
              content: "Updated task #1 status",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-task-tracker",
        uuid: "result-task-tracker",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "dynamic_tool_call");
        assert.equal(toolStarted.payload.title, "Update tasks");
      }

      const planUpdates = runtimeEvents.filter((event) => event.type === "turn.plan.updated");
      assert.equal(planUpdates.length, 3);
      const [created, started, completed] = planUpdates;
      assert.equal(created?.type, "turn.plan.updated");
      if (created?.type === "turn.plan.updated") {
        assert.equal(String(created.turnId), String(turn.turnId));
        assert.deepEqual(created.payload.plan, [
          { step: "Investigate flaky login test", status: "pending" },
        ]);
      }
      assert.equal(started?.type, "turn.plan.updated");
      if (started?.type === "turn.plan.updated") {
        assert.deepEqual(started.payload.plan, [
          { step: "Investigate flaky login test", status: "inProgress" },
        ]);
      }
      assert.equal(completed?.type, "turn.plan.updated");
      if (completed?.type === "turn.plan.updated") {
        assert.deepEqual(completed.payload.plan, [
          { step: "Investigate flaky login test", status: "completed" },
        ]);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("resyncs the plan from TaskList results", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "where are we?",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task-list",
        uuid: "stream-task-list-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-task-list-1",
            name: "TaskList",
            input: {},
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-task-list",
        uuid: "user-task-list-result",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-task-list-1",
              content:
                "#1 [completed] Wire the adapter\n#2 [in_progress] Add the tests\n#3 [pending] Update the docs",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-task-list",
        uuid: "result-task-list",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const planUpdated = runtimeEvents.find((event) => event.type === "turn.plan.updated");
      assert.equal(planUpdated?.type, "turn.plan.updated");
      if (planUpdated?.type === "turn.plan.updated") {
        assert.deepEqual(planUpdated.payload.plan, [
          { step: "Wire the adapter", status: "completed" },
          { step: "Add the tests", status: "inProgress" },
          { step: "Update the docs", status: "pending" },
        ]);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("classifies Claude Task tool invocations as collaboration agent work", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate this",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-task",
        uuid: "stream-task-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-task-1",
            name: "Task",
            input: {
              description: "Review the database layer",
              prompt: "Audit the SQL changes",
              subagent_type: "code-reviewer",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-task",
        uuid: "assistant-task-1",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-task-1",
          content: [{ type: "text", text: "Delegated" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-task",
        uuid: "result-task-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const toolStarted = runtimeEvents.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.type, "item.started");
      if (toolStarted?.type === "item.started") {
        assert.equal(toolStarted.payload.itemType, "collab_agent_tool_call");
        assert.equal(toolStarted.payload.title, "Subagent task");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "streams forwarded subagent text into the collab tool item, never the transcript",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "delegate this",
          attachments: [],
        });

        // The Task tool goes in flight; no tool_result yet — the foreground
        // agent is still running while its messages stream in.
        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-subagent-live",
          uuid: "stream-subagent-task-1",
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool-task-live",
              name: "Task",
              input: {
                description: "Review the database layer",
                prompt: "Audit the SQL changes",
                subagent_type: "code-reviewer",
              },
            },
          },
        } as unknown as SDKMessage);

        // Complete forwarded envelope -> live text on the collab item.
        harness.query.emit({
          type: "assistant",
          session_id: "sdk-session-subagent-live",
          uuid: "assistant-subagent-live-1",
          parent_tool_use_id: "tool-task-live",
          message: {
            id: "subagent-message-1",
            model: "claude-opus-5-5",
            content: [{ type: "text", text: "Scanning the database layer now." }],
          },
        } as unknown as SDKMessage);

        // Forwarded deltas, subagent-internal tool results, and messages from
        // unknown parents are all dropped without emitting anything.
        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-subagent-live",
          uuid: "stream-subagent-live-1",
          parent_tool_use_id: "tool-task-live",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "leaked-delta" },
          },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "user",
          session_id: "sdk-session-subagent-live",
          uuid: "user-subagent-live-1",
          parent_tool_use_id: "tool-task-live",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "subagent-inner-tool", content: "leaked-grep" },
            ],
          },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "assistant",
          session_id: "sdk-session-subagent-live",
          uuid: "assistant-subagent-unknown-1",
          parent_tool_use_id: "tool-task-unknown",
          message: {
            id: "subagent-message-unknown",
            content: [{ type: "text", text: "leaked-unknown-parent" }],
          },
        } as unknown as SDKMessage);

        // Oversized messages truncate to the live-text cap.
        harness.query.emit({
          type: "assistant",
          session_id: "sdk-session-subagent-live",
          uuid: "assistant-subagent-live-2",
          parent_tool_use_id: "tool-task-live",
          message: {
            id: "subagent-message-2",
            content: [{ type: "text", text: "y".repeat(5_000) }],
          },
        } as unknown as SDKMessage);

        // A message the CLI wrote itself still streams, but its placeholder
        // model is not the agent's.
        harness.query.emit({
          type: "assistant",
          session_id: "sdk-session-subagent-live",
          uuid: "assistant-subagent-live-3",
          parent_tool_use_id: "tool-task-live",
          message: {
            id: "subagent-message-3",
            model: "<synthetic>",
            content: [{ type: "text", text: "You've hit your weekly limit" }],
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-subagent-live",
          uuid: "result-subagent-live-1",
        } as unknown as SDKMessage);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

        const liveUpdates = runtimeEvents.flatMap((event) => {
          if (event.type !== "item.updated") {
            return [];
          }
          const data = (event.payload as { data?: { subagentLiveText?: unknown } }).data;
          return typeof data?.subagentLiveText === "string"
            ? [{ event, liveText: data.subagentLiveText }]
            : [];
        });
        assert.equal(liveUpdates.length, 3);
        assert.equal(liveUpdates[0]?.liveText, "Scanning the database layer now.");
        assert.equal(liveUpdates[1]?.liveText?.length, 4_000);
        assert.equal(liveUpdates[2]?.liveText, "You've hit your weekly limit");
        const subagentModels = liveUpdates.map(
          (update) =>
            (update.event.payload as { data?: { subagentModel?: unknown } }).data?.subagentModel,
        );
        assert.deepStrictEqual(subagentModels, ["claude-opus-5-5", undefined, undefined]);
        for (const update of liveUpdates) {
          assert.equal(String(update.event.itemId), "tool-task-live");
          assert.equal(
            (update.event.payload as { itemType?: unknown }).itemType,
            "collab_agent_tool_call",
          );
        }

        // The forwarded conversation must not surface as transcript items, and
        // the dropped messages must not emit at all.
        const assistantItems = runtimeEvents.filter(
          (event) =>
            event.type.startsWith("item.") &&
            (event.payload as { itemType?: unknown }).itemType === "assistant_message",
        );
        assert.deepStrictEqual(assistantItems, []);
        const leaked = runtimeEvents.filter((event) =>
          JSON.stringify(event.payload).includes("leaked-"),
        );
        assert.deepStrictEqual(leaked, []);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("follows the agent's own edits into another checkout, never a helper's", () => {
    // Real git, so the checkout lookup reads the pointers git writes: the
    // session starts in its own worktree (`home`), next to a second one.
    const dir = mkdtempSync(path.join(os.tmpdir(), "claude-edit-checkout-"));
    const repo = path.join(dir, "repo");
    const home = path.join(dir, "home");
    const other = path.join(dir, "other");
    const git = (...args: ReadonlyArray<string>) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd: repo,
        stdio: "ignore",
      });
    mkdirSync(repo);
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "init");
    git("worktree", "add", "-q", "-b", "home", home);
    git("worktree", "add", "-q", "-b", "other", other);
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        cwd: home,
      });
      yield* adapter.sendTurn({ threadId: session.threadId, input: "hello", attachments: [] });

      const ownEdit = (index: number, filePath: string) => {
        const id = `tool-own-edit-${index}`;
        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-moves",
          uuid: `stream-start-${index}`,
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index,
            content_block: {
              type: "tool_use",
              id,
              name: "Write",
              input: { file_path: filePath, content: "x" },
            },
          },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-moves",
          uuid: `stream-stop-${index}`,
          parent_tool_use_id: null,
          event: { type: "content_block_stop", index },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "user",
          session_id: "sdk-session-moves",
          uuid: `result-${index}`,
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
          },
        } as unknown as SDKMessage);
      };
      const helperEdit = (filePath: string) => {
        harness.query.emit({
          type: "assistant",
          session_id: "sdk-session-moves",
          uuid: "helper-edit",
          parent_tool_use_id: "tool-task-helper",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-helper-edit",
                name: "Write",
                input: { file_path: filePath, content: "x" },
              },
            ],
          },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "user",
          session_id: "sdk-session-moves",
          uuid: "helper-edit-result",
          parent_tool_use_id: "tool-task-helper",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-helper-edit", content: "ok" }],
          },
        } as unknown as SDKMessage);
      };

      ownEdit(1, path.join(other, "src", "a.ts"));
      ownEdit(2, path.join(other, "src", "b.ts"));
      helperEdit(path.join(home, "src", "helper.ts"));
      ownEdit(3, path.join(dir, "notes.md"));
      ownEdit(4, path.join(home, "src", "a.ts"));
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-moves",
        uuid: "result-moves",
      } as unknown as SDKMessage);

      const moves = Array.from(yield* Fiber.join(runtimeEventsFiber)).flatMap((event) =>
        event.type === "session.cwd.changed" ? [event.payload] : [],
      );
      // Out to `other` once (the second edit there is no new move), the
      // helper's edit and the file outside every checkout say nothing, then
      // back home.
      assert.deepStrictEqual(moves, [
        { cwd: realpathSync(other), reason: "file-edited" },
        { cwd: home, reason: "file-edited" },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });

  it.effect("publishes a subagent's file edits as agent-attributed file changes", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        cwd: "/repo",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate this",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-subagent-edit",
        uuid: "stream-subagent-task-edit",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-task-edit",
            name: "Task",
            input: {
              description: "Rename the helper",
              prompt: "Rename it everywhere",
              subagent_type: "code-reviewer",
            },
          },
        },
      } as unknown as SDKMessage);

      // The agent's own edit, requested inside its forwarded conversation. Its
      // tool_result never reaches this stream, so nothing else reports it.
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-subagent-edit",
        uuid: "assistant-subagent-edit",
        parent_tool_use_id: "tool-task-edit",
        message: {
          id: "subagent-message-edit",
          content: [
            {
              type: "tool_use",
              id: "sub-edit-1",
              name: "Edit",
              input: {
                file_path: "/repo/src/helper.ts",
                old_string: "oldName",
                new_string: "newName",
                replace_all: true,
              },
            },
          ],
        },
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      const postToolUse =
        harness.getLastCreateQueryInput()?.options.hooks?.PostToolUse?.[0]?.hooks[0];
      assert.notEqual(postToolUse, undefined);
      const firePostToolUse = (toolUseId: string, path: string, hunks: number) =>
        postToolUse
          ? Effect.promise(() =>
              postToolUse(
                {
                  hook_event_name: "PostToolUse",
                  tool_name: "Edit",
                  tool_input: { file_path: path },
                  tool_response: {
                    filePath: path,
                    originalFile: "oldName\n".repeat(hunks),
                    structuredPatch: Array.from({ length: hunks }, (_unused, index) => ({
                      oldStart: index + 1,
                      oldLines: hunks,
                      newStart: index + 1,
                      newLines: hunks,
                      lines: ["-oldName", "+newName"],
                    })),
                  },
                  tool_use_id: toolUseId,
                  session_id: "sdk-session-subagent-edit",
                  transcript_path: "/tmp/transcript.jsonl",
                  cwd: "/repo",
                } as unknown as Parameters<NonNullable<typeof postToolUse>>[0],
                toolUseId,
                { signal: new AbortController().signal },
              ),
            )
          : Effect.void;

      // Ordinary order: the edit was announced, so the hook knows whose it is.
      yield* firePostToolUse("sub-edit-1", "/repo/src/helper.ts", 3);

      // Reverse order: the hook wins the race against the message that says
      // which agent issued the edit. The stat waits for that message.
      yield* firePostToolUse("sub-edit-2", "/repo/src/other.ts", 2);
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-subagent-edit",
        uuid: "assistant-subagent-edit-2",
        parent_tool_use_id: "tool-task-edit",
        message: {
          id: "subagent-message-edit-2",
          content: [
            {
              type: "tool_use",
              id: "sub-edit-2",
              name: "Edit",
              input: {
                file_path: "/repo/src/other.ts",
                old_string: "oldName",
                new_string: "newName",
                replace_all: true,
              },
            },
          ],
        },
      } as unknown as SDKMessage);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-subagent-edit",
        uuid: "result-subagent-edit",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const fileChangesFor = (itemId: string) =>
        runtimeEvents
          .filter(
            (event) =>
              String(event.itemId) === itemId &&
              (event.payload as { itemType?: unknown }).itemType === "file_change",
          )
          .map((event) => ({
            event,
            data: (
              event.payload as {
                data?: {
                  changes?: unknown;
                  sourceAgentThreadId?: unknown;
                  sourceAgentLabel?: unknown;
                };
              }
            ).data,
          }));

      // Announced first: an estimate off the input (which sees one
      // replacement), then the hook's exact count on the same item.
      const firstEdit = fileChangesFor("sub-edit-1");
      assert.equal(firstEdit.length, 2);
      assert.equal(firstEdit[0]?.event.type, "item.updated");
      assert.deepEqual(firstEdit[0]?.data?.changes, [
        { path: "/repo/src/helper.ts", kind: "update", additions: 1, deletions: 1 },
      ]);
      assert.equal(firstEdit[1]?.event.type, "item.completed");
      assert.deepEqual(firstEdit[1]?.data?.changes, [
        { path: "/repo/src/helper.ts", kind: "update", additions: 3, deletions: 3 },
      ]);

      // Hook first: one event, already exact — the estimate is never needed.
      const secondEdit = fileChangesFor("sub-edit-2");
      assert.equal(secondEdit.length, 1);
      assert.equal(secondEdit[0]?.event.type, "item.completed");
      assert.deepEqual(secondEdit[0]?.data?.changes, [
        { path: "/repo/src/other.ts", kind: "update", additions: 2, deletions: 2 },
      ]);

      // Every one of them is attributed to the agent, which is what keeps it
      // out of the main transcript and inside that agent's own work log, and
      // sits on the parent's turn, which is where the turn diff accrues.
      const parentTurnId = runtimeEvents.find((event) => event.type === "turn.started")?.turnId;
      assert.notEqual(parentTurnId, undefined);
      for (const { event, data } of [...firstEdit, ...secondEdit]) {
        assert.equal(data?.sourceAgentThreadId, "tool-task-edit");
        assert.equal(data?.sourceAgentLabel, "code-reviewer");
        assert.equal(event.turnId, parentTurnId);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "attributes an agent's background task to its spawn through forwarded tool uses",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "delegate and test",
          attachments: [],
        });

        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-owned-task",
          uuid: "stream-owned-task-1",
          parent_tool_use_id: null,
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool-task-owner",
              name: "Task",
              input: {
                description: "Fix the reactor",
                prompt: "Fix it and run the tests",
                subagent_type: "claude",
              },
            },
          },
        } as unknown as SDKMessage);

        // The agent's forwarded envelope carries the tool_use that will start
        // the background task.
        harness.query.emit({
          type: "assistant",
          session_id: "sdk-session-owned-task",
          uuid: "assistant-owned-task-1",
          parent_tool_use_id: "tool-task-owner",
          message: {
            id: "subagent-message-owner",
            content: [
              { type: "text", text: "Kicking off the test suite in the background." },
              {
                type: "tool_use",
                id: "subagent-inner-bash",
                name: "Bash",
                input: { command: "vp test", run_in_background: true },
              },
            ],
          },
        } as unknown as SDKMessage);

        // The task stream names the originating tool_use but not whose
        // conversation issued it; the owners map is what attributes it.
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "task-owned-bash",
          description: "Run reactor tests",
          tool_use_id: "subagent-inner-bash",
          task_type: "local_bash",
          session_id: "sdk-session-owned-task",
          uuid: "owned-task-started",
        } as unknown as SDKMessage);

        // A task the main model started stays unowned.
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "task-main-bash",
          description: "Run dev server",
          tool_use_id: "toolu-main-bash",
          task_type: "local_bash",
          is_backgrounded: true,
          session_id: "sdk-session-owned-task",
          uuid: "main-task-started",
        } as unknown as SDKMessage);

        // The agent's own task states its nesting depth; that is the only
        // place the SDK does, and the spawn call keys the roster row.
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "task-agent",
          description: "Fix the reactor",
          tool_use_id: "tool-task-owner",
          task_type: "local_agent",
          subagent_type: "claude",
          is_backgrounded: false,
          spawn_depth: 1,
          session_id: "sdk-session-owned-task",
          uuid: "agent-task-started",
        } as unknown as SDKMessage);

        // Ambient housekeeping is reported but never counts as pending work.
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "task-watch",
          description: "Live update watcher",
          task_type: "local_bash",
          ambient: true,
          session_id: "sdk-session-owned-task",
          uuid: "watch-task-started",
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "system",
          subtype: "task_notification",
          task_id: "task-owned-bash",
          status: "completed",
          summary: 'Background command "Run reactor tests" completed (exit code 0)',
          session_id: "sdk-session-owned-task",
          uuid: "owned-task-notification",
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-owned-task",
          uuid: "result-owned-task-1",
        } as unknown as SDKMessage);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        const startedEvents = runtimeEvents.filter((event) => event.type === "task.started");
        const ownedStarted = startedEvents.find(
          (event) =>
            event.type === "task.started" && String(event.payload.taskId) === "task-owned-bash",
        );
        assert.equal(ownedStarted?.type, "task.started");
        if (ownedStarted?.type === "task.started") {
          assert.equal(ownedStarted.payload.ownerAgentToolUseId, "tool-task-owner");
        }
        const mainStarted = startedEvents.find(
          (event) =>
            event.type === "task.started" && String(event.payload.taskId) === "task-main-bash",
        );
        assert.equal(mainStarted?.type, "task.started");
        if (mainStarted?.type === "task.started") {
          assert.isUndefined(mainStarted.payload.ownerAgentToolUseId);
          assert.equal(mainStarted.payload.isBackgrounded, true);
        }
        const agentStarted = startedEvents.find(
          (event) => event.type === "task.started" && String(event.payload.taskId) === "task-agent",
        );
        assert.equal(agentStarted?.type, "task.started");
        if (agentStarted?.type === "task.started") {
          assert.equal(agentStarted.payload.isBackgrounded, false);
          assert.equal(agentStarted.payload.spawnDepth, 1);
          assert.isUndefined(agentStarted.payload.ambient);
        }
        const depthMetadata = runtimeEvents.find(
          (event) =>
            event.type === "subagent.metadata.updated" &&
            event.payload.callId === "tool-task-owner" &&
            event.payload.treeDepth !== undefined,
        );
        assert.equal(depthMetadata?.type, "subagent.metadata.updated");
        if (depthMetadata?.type === "subagent.metadata.updated") {
          assert.equal(depthMetadata.payload.treeDepth, 1);
          assert.equal(depthMetadata.payload.isBackgrounded, false);
        }
        const watchStarted = startedEvents.find(
          (event) => event.type === "task.started" && String(event.payload.taskId) === "task-watch",
        );
        assert.equal(watchStarted?.type, "task.started");
        if (watchStarted?.type === "task.started") {
          assert.equal(watchStarted.payload.ambient, true);
          assert.equal(watchStarted.payload.pendingCountManagedBySnapshot, true);
        }
        const ownedCompleted = runtimeEvents.find(
          (event) =>
            event.type === "task.completed" && String(event.payload.taskId) === "task-owned-bash",
        );
        assert.equal(ownedCompleted?.type, "task.completed");
        if (ownedCompleted?.type === "task.completed") {
          assert.equal(ownedCompleted.payload.ownerAgentToolUseId, "tool-task-owner");
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("routes nested subagent text (depth 2+) to the top-level collab tool item", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate deeply",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-subagent-nested",
        uuid: "stream-subagent-nested-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-task-nested-root",
            name: "Task",
            input: {
              description: "Audit the release",
              prompt: "Check migrations and indexes",
              subagent_type: "code-reviewer",
            },
          },
        },
      } as unknown as SDKMessage);

      // Depth-1 subagent spawns its own Agent; the spawn-only message has
      // no text, so it emits nothing but registers the nested tool_use id.
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-subagent-nested",
        uuid: "assistant-subagent-nested-1",
        parent_tool_use_id: "tool-task-nested-root",
        message: {
          id: "subagent-nested-message-1",
          content: [
            {
              type: "tool_use",
              id: "tool-task-nested-child",
              name: "Task",
              input: { description: "Check the indexes", prompt: "Verify index coverage" },
            },
          ],
        },
      } as unknown as SDKMessage);

      // Depth-2 messages are keyed by the nested spawn id, not the
      // top-level Task id; they must land on the top-level item. This one
      // also spawns depth 3.
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-subagent-nested",
        uuid: "assistant-subagent-nested-2",
        parent_tool_use_id: "tool-task-nested-child",
        message: {
          id: "subagent-nested-message-2",
          content: [
            { type: "text", text: "Nested agent checking indexes." },
            {
              type: "tool_use",
              id: "tool-task-nested-grandchild",
              name: "Task",
              input: { description: "Verify migrations", prompt: "Check migration order" },
            },
          ],
        },
      } as unknown as SDKMessage);

      // Depth-3 chains through the ancestry recorded from depth 2.
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-subagent-nested",
        uuid: "assistant-subagent-nested-3",
        parent_tool_use_id: "tool-task-nested-grandchild",
        message: {
          id: "subagent-nested-message-3",
          content: [{ type: "text", text: "Grandchild verifying migrations." }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-subagent-nested",
        uuid: "result-subagent-nested-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const liveUpdates = runtimeEvents.flatMap((event) => {
        if (event.type !== "item.updated") {
          return [];
        }
        const data = (event.payload as { data?: { subagentLiveText?: unknown } }).data;
        return typeof data?.subagentLiveText === "string"
          ? [{ event, liveText: data.subagentLiveText }]
          : [];
      });
      assert.equal(liveUpdates.length, 2);
      assert.equal(liveUpdates[0]?.liveText, "Nested agent checking indexes.");
      assert.equal(liveUpdates[1]?.liveText, "Grandchild verifying migrations.");
      for (const update of liveUpdates) {
        assert.equal(String(update.event.itemId), "tool-task-nested-root");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it("locks a side answer down to reading, whatever the normal session loads", async () => {
    const locked = lockDownClaudeQueryOptions(
      {
        mcpServers: { threadlines_browser: { type: "http", url: "http://localhost/mcp" } },
        settingSources: ["user", "project", "local"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        allowedTools: ["TodoWrite"],
        model: "claude-haiku-4-5",
        // The user's launch args: a plugin's hooks run whatever the model may do.
        extraArgs: { "plugin-dir": "/Users/me/plugin", "thinking-display": "summarized" },
        settings: { alwaysThinkingEnabled: true, ultracode: true },
      },
      { resume: "30d8aa06-ed90-469b-b864-3c4e5801581e", forkSessionId: "fork-id" },
    );
    assert.deepEqual(locked.extraArgs, { "thinking-display": "summarized" });
    // Auto-memory off: a side answer neither reads nor writes the user's memory.
    assert.deepEqual(locked.settings, { alwaysThinkingEnabled: true, autoMemoryEnabled: false });
    assert.deepEqual(locked.mcpServers, {});
    assert.equal(locked.strictMcpConfig, true);
    assert.deepEqual(locked.settingSources, []);
    assert.equal(locked.permissionMode, "default");
    assert.equal(locked.allowDangerouslySkipPermissions, undefined);
    assert.equal(locked.allowedTools, undefined);
    assert.equal(locked.forkSession, true);
    assert.equal(locked.sessionId, "fork-id");
    assert.equal(locked.persistSession, false);
    assert.equal(locked.model, "claude-haiku-4-5");

    const hook = locked.hooks?.PreToolUse?.[0]?.hooks[0];
    const decide = async (toolName: string) => {
      const output = await hook!({ tool_name: toolName } as never, undefined, {
        signal: new AbortController().signal,
      });
      return (output as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput
        .permissionDecision;
    };
    assert.equal(await decide("Read"), "allow");
    for (const forbidden of [
      "Bash",
      "Write",
      "Edit",
      "Agent",
      "mcp__claude_ai_Vercel__deploy",
      "Unknown",
    ]) {
      assert.equal(await decide(forbidden), "deny");
    }
    const prompted = await locked.canUseTool!("Write", {}, {
      signal: new AbortController().signal,
      suggestions: [],
      toolUseID: "tool-1",
    } as never);
    assert.equal(prompted?.behavior, "deny");
  });

  it.effect("stops only the turn it is aimed at when given a turn id", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      // A stop meant for a turn that already gave way to this one.
      yield* adapter.interruptTurn(session.threadId, TurnId.make("turn-woken-earlier"));
      assert.equal(harness.query.interruptCalls.length, 0);

      yield* adapter.interruptTurn(session.threadId, turn.turnId);
      assert.equal(harness.query.interruptCalls.length, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("treats user-aborted Claude results as interrupted without a runtime error", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: false,
        errors: ["Error: Request was aborted."],
        stop_reason: "tool_use",
        session_id: "sdk-session-abort",
        uuid: "result-abort",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "turn.completed",
        ],
      );

      const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Error: Request was aborted.");
        assert.equal(turnCompleted.payload.stopReason, "tool_use");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "treats an aborted terminal reason as interrupted without surfacing diagnostics",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        // Shape a current CLI reports when Stop lands after a tool result.
        harness.query.emit({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],
          stop_reason: null,
          terminal_reason: "aborted_streaming",
          session_id: "sdk-session-abort",
          uuid: "result-abort-terminal-reason",
        } as unknown as SDKMessage);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        assert.notInclude(
          runtimeEvents.map((event) => event.type),
          "runtime.error",
        );
        const turnCompleted = runtimeEvents[runtimeEvents.length - 1];
        assert.equal(turnCompleted?.type, "turn.completed");
        if (turnCompleted?.type === "turn.completed") {
          assert.equal(turnCompleted.payload.state, "interrupted");
          assert.equal(turnCompleted.payload.errorMessage, undefined);
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("closes the session when the Claude stream aborts after a turn starts", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(context);

      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.fail(new Error("All fibers interrupted without error"));

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEventsFiber.interruptUnsafe();
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "turn.completed",
          "session.exited",
        ],
      );

      const turnCompleted = runtimeEvents[4];
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Claude runtime interrupted.");
      }

      const sessionExited = runtimeEvents[5];
      assert.equal(sessionExited?.type, "session.exited");

      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.length, 0);
      assert.equal(harness.query.closeCalls, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("treats a SIGTERM child exit as an interruption instead of a runtime error", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(context);

      const adapter = yield* ClaudeAdapter;
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];

      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      // App quit (e.g. a desktop update) SIGTERMs the CLI child before the
      // adapter finalizer marks the session stopped.
      harness.query.fail(new Error("Claude Code process exited with code 143"));

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      runtimeEventsFiber.interruptUnsafe();

      assert.equal(
        runtimeEvents.some((event) => event.type === "runtime.error"),
        false,
      );

      const turnCompleted = runtimeEvents.find((event) => event.type === "turn.completed");
      assert.equal(turnCompleted?.type, "turn.completed");
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(String(turnCompleted.turnId), String(turn.turnId));
        assert.equal(turnCompleted.payload.state, "interrupted");
        assert.equal(turnCompleted.payload.errorMessage, "Claude session was stopped.");
      }

      assert.equal(
        runtimeEvents.some((event) => event.type === "session.exited"),
        true,
      );
      assert.equal(yield* adapter.hasSession(THREAD_ID), false);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("closes the previous session before replacing an existing thread session", () => {
    const queries: FakeClaudeQuery[] = [];
    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings({});
        return yield* makeClaudeAdapter(claudeConfig, {
          environment: missingClaudeConfigEnvironment(),
          createQuery: () => {
            const query = new FakeClaudeQuery();
            queries.push(query);
            return query;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const firstSession = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const secondSession = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
        resumeCursor: firstSession.resumeCursor,
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const activeSessions = yield* adapter.listSessions();

      assert.equal(queries.length, 2);
      assert.equal(queries[0]?.closeCalls, 1);
      assert.equal(queries[1]?.closeCalls, 0);
      assert.equal(yield* adapter.hasSession(THREAD_ID), true);
      assert.equal(activeSessions.length, 1);
      assert.deepEqual(activeSessions[0]?.resumeCursor, secondSession.resumeCursor);
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          // The replacement resume finds no transcript on disk in this
          // harness, so the fresh-start fallback is surfaced as a warning.
          "runtime.warning",
          "session.started",
          "session.configured",
          "session.state.changed",
        ],
      );
      assert.equal(
        runtimeEvents.some((event) => event.type === "session.exited"),
        false,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("stopSession does not throw into the SDK prompt consumer", () => {
    // The SDK consumes user messages via `for await (... of prompt)`.
    // Stopping a session must end that loop cleanly — not throw an error.
    //
    // FakeClaudeQuery.close() masks this by resolving pending iterators
    // before the shutdown propagates. Override it to match real SDK behavior
    // where close() does not resolve the prompt consumer.
    const query = new FakeClaudeQuery();
    (query as { close: () => void }).close = () => {
      query.closeCalls += 1;
    };

    let promptConsumerError: unknown = undefined;

    const layer = Layer.effect(
      ClaudeAdapter,
      Effect.gen(function* () {
        const claudeConfig = decodeClaudeSettings({});
        return yield* makeClaudeAdapter(claudeConfig, {
          createQuery: (input) => {
            // Simulate the SDK consuming the prompt iterable
            (async () => {
              try {
                for await (const _message of input.prompt) {
                  /* SDK processes user messages */
                }
              } catch (error) {
                promptConsumerError = error;
              }
            })();
            return query;
          },
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(context);

      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = runFork(
        Stream.runForEach(adapter.streamEvents, () => Effect.void),
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(THREAD_ID);

      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;

      runtimeEventsFiber.interruptUnsafe();

      assert.equal(
        promptConsumerError,
        undefined,
        `Prompt consumer should not receive a thrown error on session stop, ` +
          `but got: "${promptConsumerError instanceof Error ? promptConsumerError.message : String(promptConsumerError)}"`,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(layer),
    );
  });

  it.effect("forwards Claude task progress summaries for subagent updates", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-subagent-1",
        description: "Running background teammate",
        summary: "Code reviewer checked the migration edge cases.",
        usage: {
          total_tokens: 123,
          tool_uses: 4,
          duration_ms: 987,
        },
        session_id: "sdk-session-task-summary",
        uuid: "task-progress-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const progressEvent = runtimeEvents.find((event) => event.type === "task.progress");
      assert.equal(progressEvent?.type, "task.progress");
      if (progressEvent?.type === "task.progress") {
        assert.equal(
          progressEvent.payload.summary,
          "Code reviewer checked the migration edge cases.",
        );
        assert.equal(progressEvent.payload.description, "Running background teammate");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("drops Claude's still-running pings and keeps real tool progress", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "tool_progress",
        tool_use_id: "toolu_review-heartbeat-3",
        tool_name: "mcp__threadlines_room__room_review",
        parent_tool_use_id: null,
        elapsed_time_seconds: 90,
        heartbeat: true,
        session_id: "sdk-session-ping",
        uuid: "tool-progress-ping",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "tool_progress",
        tool_use_id: "toolu_build",
        tool_name: "Bash",
        parent_tool_use_id: null,
        elapsed_time_seconds: 12,
        session_id: "sdk-session-ping",
        uuid: "tool-progress-real",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const progress = runtimeEvents.filter((event) => event.type === "tool.progress");
      assert.deepEqual(
        progress.map((event) => event.type === "tool.progress" && event.payload.toolUseId),
        ["toolu_build"],
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude task_updated running patches to task progress", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(isSettledMarker),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-updated-running",
        patch: {
          status: "running",
          description: "Checking codebase references",
        },
        session_id: "sdk-session-task-updated-running",
        uuid: "task-updated-running-1",
      } as unknown as SDKMessage);

      emitSettledMarker(harness);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const progressEvent = runtimeEvents.find((event) => event.type === "task.progress");
      assert.equal(progressEvent?.type, "task.progress");
      if (progressEvent?.type === "task.progress") {
        assert.equal(progressEvent.payload.taskId, "task-updated-running");
        assert.equal(progressEvent.payload.description, "Checking codebase references");
      }
      assert.isUndefined(runtimeEvents.find((event) => event.type === "runtime.warning"));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("maps Claude task_updated terminal patches to task completion", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(isSettledMarker),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-updated-completed",
        description: "Reviewing implementation details",
        session_id: "sdk-session-task-updated-completed",
        uuid: "task-updated-completed-started",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-updated-completed",
        patch: {
          status: "completed",
        },
        session_id: "sdk-session-task-updated-completed",
        uuid: "task-updated-completed-1",
      } as unknown as SDKMessage);

      emitSettledMarker(harness);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const startedEvent = runtimeEvents.find((event) => event.type === "task.started");
      assert.equal(startedEvent?.type, "task.started");
      if (startedEvent?.type === "task.started") {
        assert.isUndefined(startedEvent.payload.pendingCountManagedBySnapshot);
      }
      const completedEvent = runtimeEvents.find((event) => event.type === "task.completed");
      assert.equal(completedEvent?.type, "task.completed");
      if (completedEvent?.type === "task.completed") {
        assert.equal(completedEvent.payload.taskId, "task-updated-completed");
        assert.equal(completedEvent.payload.status, "completed");
        assert.equal(completedEvent.payload.summary, "Reviewing implementation details");
        assert.isUndefined(completedEvent.payload.pendingCountManagedBySnapshot);
      }
      assert.isUndefined(runtimeEvents.find((event) => event.type === "runtime.warning"));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("settles a task once when task_notification follows a terminal task_updated", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-settled-twice",
        description: "Scan git history in the background",
        session_id: "sdk-session-task-settled-twice",
        uuid: "task-settled-twice-started",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-settled-twice",
        patch: {
          status: "completed",
        },
        session_id: "sdk-session-task-settled-twice",
        uuid: "task-settled-twice-updated",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-settled-twice",
        status: "completed",
        summary: 'Background command "Scan git history" completed (exit code 0)',
        session_id: "sdk-session-task-settled-twice",
        uuid: "task-settled-twice-notification",
      } as unknown as SDKMessage);

      // Marker after the duplicate settle: the fixed-size take only includes it
      // when the task_notification above emitted nothing.
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-settled-twice-marker",
        description: "Marker task",
        session_id: "sdk-session-task-settled-twice",
        uuid: "task-settled-twice-marker-started",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const completedEvents = runtimeEvents.filter((event) => event.type === "task.completed");
      assert.equal(completedEvents.length, 1);
      const completedEvent = completedEvents[0];
      if (completedEvent?.type === "task.completed") {
        assert.equal(completedEvent.payload.taskId, "task-settled-twice");
        assert.equal(completedEvent.payload.status, "completed");
        assert.equal(completedEvent.payload.summary, "Scan git history in the background");
      }
      const markerStarted = runtimeEvents.find(
        (event) =>
          event.type === "task.started" && event.payload.taskId === "task-settled-twice-marker",
      );
      assert.isDefined(markerStarted);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ignores task_updated patches after a task_notification settled the task", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-notified-first",
        description: "Research competitor features",
        session_id: "sdk-session-task-notified-first",
        uuid: "task-notified-first-started",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-notified-first",
        status: "completed",
        summary: 'Agent "Research competitor features" finished',
        session_id: "sdk-session-task-notified-first",
        uuid: "task-notified-first-notification",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-notified-first",
        patch: {
          status: "completed",
        },
        session_id: "sdk-session-task-notified-first",
        uuid: "task-notified-first-updated",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-notified-first",
        patch: {
          status: "running",
          description: "Stale update after completion",
        },
        session_id: "sdk-session-task-notified-first",
        uuid: "task-notified-first-stale-update",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-notified-first-marker",
        description: "Marker task",
        session_id: "sdk-session-task-notified-first",
        uuid: "task-notified-first-marker-started",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const completedEvents = runtimeEvents.filter((event) => event.type === "task.completed");
      assert.equal(completedEvents.length, 1);
      const completedEvent = completedEvents[0];
      if (completedEvent?.type === "task.completed") {
        assert.equal(completedEvent.payload.taskId, "task-notified-first");
        assert.equal(
          completedEvent.payload.summary,
          'Agent "Research competitor features" finished',
        );
      }
      assert.isUndefined(
        runtimeEvents.find(
          (event) =>
            event.type === "task.progress" && event.payload.taskId === "task-notified-first",
        ),
      );
      const markerStarted = runtimeEvents.find(
        (event) =>
          event.type === "task.started" && event.payload.taskId === "task-notified-first-marker",
      );
      assert.isDefined(markerStarted);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("reports a workflow as a run instead of task progress, and ends it once", () => {
    const harness = makeHarness();
    const sdkSession = "sdk-session-workflow";
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) => event.type === "task.started" && event.payload.taskId === "task-wf-marker",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "ultracode research providers",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: sdkSession,
        uuid: "workflow-tool-use",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_wf",
            name: "Workflow",
            input: { script: 'export const meta = { name: "provider-research" };' },
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-wf",
        tool_use_id: "toolu_wf",
        description: "Research providers",
        task_type: "local_workflow",
        workflow_name: "provider-research",
        session_id: sdkSession,
        uuid: "workflow-task-started",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "user",
        session_id: sdkSession,
        uuid: "workflow-launched",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_wf", content: "Launched." }],
        },
        tool_use_result: {
          status: "async_launched",
          taskId: "task-wf",
          taskType: "local_workflow",
          workflowName: "provider-research",
          runId: "wf_abc",
          transcriptDir: "/claude/projects/p/s/subagents/workflows/wf_abc",
          scriptPath: "/claude/projects/p/s/workflows/scripts/provider-research-wf_abc.js",
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-wf",
        description: "scan:docs",
        last_tool_name: "Read",
        usage: { total_tokens: 120, tool_uses: 3, duration_ms: 900 },
        workflow_progress: [
          { type: "workflow_phase", index: 0, title: "Research" },
          {
            type: "workflow_agent",
            index: 0,
            label: "scan:docs",
            phaseIndex: 0,
            agentId: "agent-docs",
            state: "progress",
            startedAt: 1,
            promptPreview: "Read the docs",
          },
        ],
        session_id: sdkSession,
        uuid: "workflow-progress",
      } as unknown as SDKMessage);
      // Claude reports the end twice: a terminal patch, then the notification.
      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-wf",
        patch: { status: "completed" },
        session_id: sdkSession,
        uuid: "workflow-updated",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-wf",
        status: "completed",
        summary: "Found three gaps",
        session_id: sdkSession,
        uuid: "workflow-notification",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-wf-marker",
        description: "Marker task",
        session_id: sdkSession,
        uuid: "workflow-marker",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.isUndefined(runtimeEvents.find((event) => event.type === "task.progress"));
      assert.equal(
        runtimeEvents.filter(
          (event) => event.type === "task.completed" && event.payload.taskId === "task-wf",
        ).length,
        1,
      );
      const updates = runtimeEvents.flatMap((event) =>
        event.type === "task.workflow.updated" ? [event.payload] : [],
      );
      assert.isTrue(updates.every((update) => update.taskId === "task-wf"));
      assert.deepEqual(
        updates.map((update) => update.status),
        // Live updates say the run is running; the summary after the end does not.
        ["running", "running", "running", "completed", undefined],
      );
      assert.include(updates[0], { name: "provider-research", toolCallId: "toolu_wf" });
      assert.include(updates[1], {
        runId: "wf_abc",
        transcriptDir: "/claude/projects/p/s/subagents/workflows/wf_abc",
        scriptPath: "/claude/projects/p/s/workflows/scripts/provider-research-wf_abc.js",
      });
      assert.deepEqual(updates[2]?.phases, [{ index: 0, title: "Research" }]);
      assert.deepEqual(
        updates[2]?.agents?.map((agent) => [agent.label, agent.state, agent.agentId]),
        [["scan:docs", "running", "agent-docs"]],
      );
      assert.equal(updates[2]?.totalTokens, 120);
      // The notification still brings the closing summary the patch lacked.
      assert.deepEqual(updates[4], { taskId: "task-wf", summary: "Found three gaps" });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("ends a session's live workflow runs as stopped when the session stops", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runStarted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.tap((event) =>
          event.type === "task.workflow.updated" && event.payload.status === "running"
            ? Deferred.succeed(runStarted, undefined)
            : Effect.void,
        ),
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-wf",
        description: "Research providers",
        task_type: "local_workflow",
        session_id: "sdk-session-stop-workflow",
        uuid: "stop-workflow-started",
      } as unknown as SDKMessage);
      yield* Deferred.await(runStarted);

      yield* adapter.stopSession(THREAD_ID);

      const ends = Array.from(yield* Fiber.join(runtimeEventsFiber)).flatMap((event) =>
        event.type === "task.workflow.updated" &&
        event.payload.status !== undefined &&
        event.payload.status !== "running"
          ? [event.payload]
          : [],
      );
      assert.equal(ends.length, 1);
      assert.include(ends[0], {
        taskId: "task-wf",
        status: "stopped",
        statusReason: "session-ended",
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("uses structured Agent results for async launch and completion", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 12).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate with structured results",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-structured-agent",
        uuid: "stream-structured-agent-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-structured-agent",
            name: "Agent",
            input: {
              description: "Review the provider adapter",
              prompt: "Review the adapter and report risks.",
              subagent_type: "code-reviewer",
              run_in_background: true,
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-structured-agent",
        uuid: "user-structured-agent-launch",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-structured-agent",
              content: "Background work accepted.",
            },
          ],
        },
        tool_use_result: {
          status: "async_launched",
          isAsync: true,
          agentId: "agent-structured-identity",
          description: "Review the provider adapter",
          prompt: "Review the adapter and report risks.",
          outputFile: "/tmp/tasks/agent-structured-identity.output",
          canReadOutputFile: true,
        },
      } as unknown as SDKMessage);

      // The task id is a separate SDK identity. The structured agentId above
      // must not create a phantom task lifecycle entry.
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-structured-agent",
        tool_use_id: "tool-structured-agent",
        description: "Review the provider adapter",
        subagent_type: "code-reviewer",
        task_type: "local_agent",
        session_id: "sdk-session-structured-agent",
        uuid: "structured-agent-task-started",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-structured-agent",
        uuid: "user-structured-agent-completed",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-structured-agent",
              content: "Model-facing result with an internal agent trailer.",
            },
          ],
        },
        tool_use_result: {
          status: "completed",
          agentId: "agent-structured-identity",
          agentType: "code-reviewer",
          content: [{ type: "text", text: "## Review\n\nNo correctness risks found." }],
          prompt: "Review the adapter and report risks.",
          totalToolUseCount: 4,
          totalDurationMs: 3200,
          totalTokens: 840,
          usage: {
            input_tokens: 640,
            output_tokens: 200,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            server_tool_use: null,
            service_tier: null,
            cache_creation: null,
          },
        },
      } as unknown as SDKMessage);

      // Duplicate and legacy fallbacks may arrive after the structured result;
      // neither should create a second lifecycle or item completion.
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-structured-agent",
        tool_use_id: "tool-structured-agent",
        description: "Review the provider adapter",
        task_type: "local_agent",
        session_id: "sdk-session-structured-agent",
        uuid: "structured-agent-task-started-duplicate",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-structured-agent",
        uuid: "user-structured-agent-legacy-notification",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "<task-notification>",
                "<task-id>task-structured-agent</task-id>",
                "<tool-use-id>tool-structured-agent</tool-use-id>",
                "<status>completed</status>",
                '<summary>Agent "Review the provider adapter" finished</summary>',
                "<result>Legacy duplicate result.</result>",
                "</task-notification>",
              ].join("\n"),
            },
          ],
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-structured-agent",
        tool_use_id: "tool-structured-agent",
        status: "completed",
        summary: 'Agent "Review the provider adapter" finished',
        output_file: "/tmp/tasks/agent-structured-identity.output",
        session_id: "sdk-session-structured-agent",
        uuid: "structured-agent-task-notification-duplicate",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-structured-marker",
        description: "Marker task",
        session_id: "sdk-session-structured-agent",
        uuid: "structured-agent-marker",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const taskStarts = runtimeEvents.filter(
        (event) =>
          event.type === "task.started" && event.payload.taskId === "task-structured-agent",
      );
      assert.equal(taskStarts.length, 1);
      assert.isUndefined(
        runtimeEvents.find(
          (event) =>
            event.type === "task.started" && event.payload.taskId === "agent-structured-identity",
        ),
      );
      if (taskStarts[0]?.type === "task.started") {
        assert.isUndefined(taskStarts[0].payload.pendingCountManagedBySnapshot);
        assert.equal(taskStarts[0].payload.toolUseId, "tool-structured-agent");
      }

      const taskCompletions = runtimeEvents.filter(
        (event) =>
          event.type === "task.completed" && event.payload.taskId === "task-structured-agent",
      );
      assert.equal(taskCompletions.length, 1);
      if (taskCompletions[0]?.type === "task.completed") {
        assert.isUndefined(taskCompletions[0].payload.pendingCountManagedBySnapshot);
      }

      const structuredCompletions = runtimeEvents.filter((event) => {
        if (event.type !== "item.completed") {
          return false;
        }
        const data = event.payload.data as { structuredResult?: { status?: string } } | undefined;
        return data?.structuredResult?.status === "completed";
      });
      assert.equal(structuredCompletions.length, 1);
      const structuredCompletion = structuredCompletions[0];
      if (structuredCompletion?.type === "item.completed") {
        const data = structuredCompletion.payload.data as {
          result?: { content?: Array<{ text?: string }> };
          taskNotification?: { taskId?: string };
        };
        assert.equal(data.result?.content?.[0]?.text, "## Review\n\nNo correctness risks found.");
        assert.equal(data.taskNotification?.taskId, "task-structured-agent");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("re-opens a background agent the model resumes with SendMessage", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "delegate in the background",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-resumed-agent",
        uuid: "stream-resumed-agent-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-resumed-agent",
            name: "Agent",
            input: {
              description: "Build worktree cleanup",
              prompt: "Build it and report back.",
              subagent_type: "claude",
              run_in_background: true,
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-resumed-agent",
        uuid: "user-resumed-agent-launch",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-resumed-agent",
              content: "Async agent launched successfully.",
            },
          ],
        },
        tool_use_result: {
          status: "async_launched",
          isAsync: true,
          agentId: "agent-resumed-identity",
          description: "Build worktree cleanup",
          prompt: "Build it and report back.",
          outputFile: "/tmp/tasks/agent-resumed-identity.output",
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-resumed-agent",
        tool_use_id: "tool-resumed-agent",
        description: "Build worktree cleanup",
        subagent_type: "claude",
        task_type: "local_agent",
        session_id: "sdk-session-resumed-agent",
        uuid: "resumed-agent-task-started",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-resumed-agent",
        tool_use_id: "tool-resumed-agent",
        status: "completed",
        summary: "First pass done.",
        session_id: "sdk-session-resumed-agent",
        uuid: "resumed-agent-first-notification",
      } as unknown as SDKMessage);

      // The model sends the settled agent more work. Its later runs report
      // under the resuming call, not the spawn.
      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-resumed-agent",
        uuid: "assistant-resumed-agent-send",
        parent_tool_use_id: null,
        message: {
          id: "msg-resumed-agent-send",
          role: "assistant",
          model: "claude-opus-5",
          content: [
            {
              type: "tool_use",
              id: "tool-resume-call",
              name: "SendMessage",
              input: { to: "agent-resumed-identity", summary: "Rework the dialog" },
            },
            {
              type: "tool_use",
              id: "tool-resume-unknown",
              name: "SendMessage",
              input: { to: "someone-else", summary: "Not an agent of this thread" },
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-resumed-agent",
        tool_use_id: "tool-resume-call",
        description: "Build worktree cleanup",
        subagent_type: "claude",
        task_type: "local_agent",
        session_id: "sdk-session-resumed-agent",
        uuid: "resumed-agent-second-task-started",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-resumed-agent",
        tool_use_id: "tool-resume-call",
        status: "completed",
        summary: "Rework shipped.",
        session_id: "sdk-session-resumed-agent",
        uuid: "resumed-agent-second-notification",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-resumed-agent",
        uuid: "result-resumed-agent",
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

      // Exactly one agent is revived, keyed by the spawn that owns its row.
      const revivals = runtimeEvents.filter((event) => event.type === "subagent.metadata.updated");
      assert.equal(revivals.length, 1);
      const revival = revivals[0];
      if (revival?.type === "subagent.metadata.updated") {
        assert.equal(revival.payload.callId, "tool-resumed-agent");
        assert.equal(revival.payload.agentThreadId, "tool-resumed-agent");
        assert.equal(revival.payload.status, "running");
        assert.equal(revival.payload.agentRole, "claude");
      }

      // The second run is a run of its own: it starts again and settles again.
      const starts = runtimeEvents.filter(
        (event) => event.type === "task.started" && event.payload.taskId === "task-resumed-agent",
      );
      assert.equal(starts.length, 2);
      const completions = runtimeEvents.filter(
        (event) => event.type === "task.completed" && event.payload.taskId === "task-resumed-agent",
      );
      assert.equal(completions.length, 2);
      if (completions[1]?.type === "task.completed") {
        assert.equal(completions[1].payload.summary, "Rework shipped.");
        // The spawn still owns the agent's row, so the completion links there
        // rather than to the call that resumed it.
        assert.equal(completions[1].payload.toolUseId, "tool-resumed-agent");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("runs a task again when the SDK restarts it after a synthesized stop", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "resume the agent",
        attachments: [],
      });

      // A fresh process learns of the previous session's background agent only
      // from the SDK's "no completion record" notice: no spawn, no tool_use_id.
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-restarted-agent",
        status: "stopped",
        summary:
          'No completion record was found for background agent "Build step 4a" from the previous session.',
        session_id: "sdk-session-restarted-agent",
        uuid: "restarted-agent-lost-notification",
      } as unknown as SDKMessage);

      // The model sends the agent a message. The SDK runs the same task again
      // under the resuming call and restates the spawn's flags there.
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-restarted-agent",
        tool_use_id: "tool-restart-resume-call",
        description: "Build step 4a",
        subagent_type: "general-purpose",
        task_type: "local_agent",
        spawn_depth: 1,
        is_backgrounded: true,
        session_id: "sdk-session-restarted-agent",
        uuid: "restarted-agent-task-started",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-restarted-agent",
        tool_use_id: "tool-restart-resume-call",
        description: "Reading logic test conventions",
        session_id: "sdk-session-restarted-agent",
        uuid: "restarted-agent-task-progress",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-restarted-agent",
        tool_use_id: "tool-restart-resume-call",
        status: "completed",
        summary: "Step 4a done.",
        session_id: "sdk-session-restarted-agent",
        uuid: "restarted-agent-second-notification",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-restarted-agent",
        uuid: "result-restarted-agent",
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));

      // The new run reports as a run of its own: start, progress, completion.
      const starts = runtimeEvents.filter(
        (event) => event.type === "task.started" && event.payload.taskId === "task-restarted-agent",
      );
      assert.equal(starts.length, 1);
      if (starts[0]?.type === "task.started") {
        assert.equal(starts[0].payload.toolUseId, "tool-restart-resume-call");
      }
      const progress = runtimeEvents.filter(
        (event) =>
          event.type === "task.progress" && event.payload.taskId === "task-restarted-agent",
      );
      assert.equal(progress.length, 1);
      const completions = runtimeEvents.filter(
        (event) =>
          event.type === "task.completed" && event.payload.taskId === "task-restarted-agent",
      );
      assert.equal(completions.length, 2);
      if (completions[0]?.type === "task.completed") {
        assert.equal(completions[0].payload.status, "stopped");
      }
      if (completions[1]?.type === "task.completed") {
        assert.equal(completions[1].payload.status, "completed");
        assert.equal(completions[1].payload.summary, "Step 4a done.");
      }

      // The restated flags describe a spawn this process never saw. A row
      // keyed by the resuming call would be an agent that does not exist.
      const flagUpdates = runtimeEvents.filter(
        (event) => event.type === "subagent.metadata.updated",
      );
      assert.equal(flagUpdates.length, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("marks only agents as backgrounded when a task moves to the background", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "run the suite and delegate",
        attachments: [],
      });

      // A long shell command the harness moved to the background.
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-background-command",
        tool_use_id: "tool-background-command",
        description: "Run the server suite",
        task_type: "local_bash",
        session_id: "sdk-session-backgrounded",
        uuid: "background-command-started",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-background-command",
        patch: { is_backgrounded: true },
        session_id: "sdk-session-backgrounded",
        uuid: "background-command-backgrounded",
      } as unknown as SDKMessage);

      // A foreground agent the user moved to the background.
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-backgrounded-agent",
        tool_use_id: "tool-backgrounded-agent",
        description: "Review the diff",
        subagent_type: "claude",
        task_type: "local_agent",
        session_id: "sdk-session-backgrounded",
        uuid: "backgrounded-agent-started",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-backgrounded-agent",
        patch: { is_backgrounded: true },
        session_id: "sdk-session-backgrounded",
        uuid: "backgrounded-agent-backgrounded",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-backgrounded",
        uuid: "result-backgrounded",
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const flagUpdates = runtimeEvents.filter(
        (event) => event.type === "subagent.metadata.updated",
      );
      assert.equal(flagUpdates.length, 1);
      if (flagUpdates[0]?.type === "subagent.metadata.updated") {
        assert.equal(flagUpdates[0].payload.callId, "tool-backgrounded-agent");
        assert.equal(flagUpdates[0].payload.isBackgrounded, true);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("stops one background task through the CLI, and only one it has running", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const startedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.started"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "task.completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-dev-server",
        description: "Start the web dev server",
        task_type: "local_bash",
        tool_use_id: "tool-dev-server",
        session_id: "sdk-session-stop-task",
        uuid: "task-dev-server-started",
      } as unknown as SDKMessage);

      const [started] = Array.from(yield* Fiber.join(startedFiber));
      assert.equal(started?.type === "task.started" && started.payload.stoppable, true);

      assert.equal(
        yield* adapter.stopBackgroundTask!(THREAD_ID, RuntimeTaskId.make("task-dev-server")),
        true,
      );
      assert.equal(
        yield* adapter.stopBackgroundTask!(THREAD_ID, RuntimeTaskId.make("task-never-started")),
        false,
      );
      assert.deepEqual(harness.query.stopTaskCalls, ["task-dev-server"]);

      // The CLI's answer ends it the usual way; a second Stop finds nothing.
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-dev-server",
        tool_use_id: "tool-dev-server",
        status: "stopped",
        summary: "Stopped",
        output_file: "/tmp/tasks/task-dev-server.output",
        session_id: "sdk-session-stop-task",
        uuid: "task-dev-server-stopped",
      } as unknown as SDKMessage);
      const [completed] = Array.from(yield* Fiber.join(completedFiber));
      assert.equal(completed?.type === "task.completed" && completed.payload.status, "stopped");
      assert.equal(
        yield* adapter.stopBackgroundTask!(THREAD_ID, RuntimeTaskId.make("task-dev-server")),
        false,
      );
      assert.deepEqual(harness.query.stopTaskCalls, ["task-dev-server"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("forwards authoritative background task snapshots without inferring edges", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 11).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        // The CLI reports each task's raw type here, the same one its
        // task_started edge carries.
        tasks: [
          {
            task_id: "task-snapshot-a",
            task_type: "local_agent",
            description: "Review provider logic",
          },
          {
            task_id: "task-snapshot-b",
            task_type: "local_bash",
            description: "Watch CI",
          },
          {
            task_id: "task-snapshot-a",
            task_type: "local_agent",
            description: "Review provider logic",
          },
        ],
        session_id: "sdk-session-task-snapshot",
        uuid: "task-snapshot-initial",
      } as unknown as SDKMessage);

      for (const task of [
        {
          task_id: "task-snapshot-a",
          description: "Review provider logic",
          task_type: "local_agent",
          tool_use_id: "tool-snapshot-a",
        },
        {
          task_id: "task-snapshot-b",
          description: "Watch CI",
          task_type: "local_bash",
          tool_use_id: "tool-snapshot-b",
        },
      ]) {
        harness.query.emit({
          type: "system",
          subtype: "task_started",
          ...task,
          session_id: "sdk-session-task-snapshot",
          uuid: `${task.task_id}-started`,
        } as unknown as SDKMessage);
      }

      // Edge first, level second.
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-snapshot-a",
        tool_use_id: "tool-snapshot-a",
        status: "completed",
        summary: "Review complete",
        output_file: "/tmp/tasks/task-snapshot-a.output",
        session_id: "sdk-session-task-snapshot",
        uuid: "task-snapshot-a-completed",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          {
            task_id: "task-snapshot-b",
            task_type: "local_bash",
            description: "Watch CI",
          },
        ],
        session_id: "sdk-session-task-snapshot",
        uuid: "task-snapshot-a-removed",
      } as unknown as SDKMessage);

      // Level first, edge second.
      harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [],
        session_id: "sdk-session-task-snapshot",
        uuid: "task-snapshot-b-removed",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-snapshot-b",
        tool_use_id: "tool-snapshot-b",
        status: "failed",
        summary: "CI watcher failed",
        output_file: "/tmp/tasks/task-snapshot-b.output",
        session_id: "sdk-session-task-snapshot",
        uuid: "task-snapshot-b-completed",
      } as unknown as SDKMessage);

      // Terminal duplicates and stale progress must not re-open either task.
      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-snapshot-b",
        status: "failed",
        summary: "Duplicate failure",
        output_file: "/tmp/tasks/task-snapshot-b.output",
        session_id: "sdk-session-task-snapshot",
        uuid: "task-snapshot-b-completed-duplicate",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-snapshot-b",
        patch: { status: "running", description: "Stale running update" },
        session_id: "sdk-session-task-snapshot",
        uuid: "task-snapshot-b-stale-update",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-snapshot-marker",
        description: "Marker task",
        session_id: "sdk-session-task-snapshot",
        uuid: "task-snapshot-marker-started",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const snapshots = runtimeEvents.filter((event) => event.type === "task.snapshot.updated");
      assert.equal(snapshots.length, 3);
      if (snapshots[0]?.type === "task.snapshot.updated") {
        assert.deepEqual(
          snapshots[0].payload.tasks.map((task) => task.taskId),
          ["task-snapshot-a", "task-snapshot-b"],
        );
        // Each task says what it is, so the thread can say what it waits on.
        assert.deepEqual(
          snapshots[0].payload.tasks.map((task) => task.kind),
          ["agent", "command"],
        );
      }
      if (snapshots[1]?.type === "task.snapshot.updated") {
        assert.deepEqual(
          snapshots[1].payload.tasks.map((task) => task.taskId),
          ["task-snapshot-b"],
        );
      }
      if (snapshots[2]?.type === "task.snapshot.updated") {
        assert.deepEqual(snapshots[2].payload.tasks, []);
      }

      const starts = runtimeEvents.filter(
        (event) =>
          event.type === "task.started" &&
          (event.payload.taskId === "task-snapshot-a" ||
            event.payload.taskId === "task-snapshot-b"),
      );
      assert.equal(starts.length, 2);
      assert.isTrue(
        starts.every(
          (event) =>
            event.type === "task.started" && event.payload.pendingCountManagedBySnapshot === true,
        ),
      );

      const completions = runtimeEvents.filter(
        (event) =>
          event.type === "task.completed" &&
          (event.payload.taskId === "task-snapshot-a" ||
            event.payload.taskId === "task-snapshot-b"),
      );
      assert.equal(completions.length, 2);
      assert.isTrue(
        completions.every(
          (event) =>
            event.type === "task.completed" && event.payload.pendingCountManagedBySnapshot === true,
        ),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("stops awaiting background commands the model marks or the user moves past", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const snapshots = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "task.snapshot.updated",
      ).pipe(
        Stream.runForEach((event) => Queue.offer(snapshots, event)),
        Effect.forkChild,
      );
      /** Which live tasks the next published snapshot says are awaited. */
      const nextAwaited = Effect.gen(function* () {
        const event = yield* Queue.take(snapshots);
        return event.type === "task.snapshot.updated"
          ? Object.fromEntries(
              event.payload.tasks.map((task) => [task.taskId, task.awaited !== false]),
            )
          : {};
      });
      const emitTasks = (tasks: ReadonlyArray<Record<string, string>>, uuid: string) =>
        harness.query.emit({
          type: "system",
          subtype: "background_tasks_changed",
          tasks,
          session_id: "sdk-session-long-running",
          uuid,
        } as unknown as SDKMessage);
      // What the CLI's tools/call runs: the handler registered on the
      // session's in-process MCP server.
      const markLongRunning = (taskId: string) =>
        Effect.promise(() => {
          const server = harness.getLastCreateQueryInput()?.options.mcpServers?.[
            THREADLINES_CLAUDE_MCP_SERVER_NAME
          ] as unknown as {
            readonly instance: {
              readonly _registeredTools: Record<
                string,
                {
                  readonly handler: (
                    args: { readonly task_id: string },
                    extra: unknown,
                  ) => Promise<{ readonly isError?: boolean }>;
                }
              >;
            };
          };
          return server.instance._registeredTools[MARK_LONG_RUNNING_TOOL_NAME]!.handler(
            { task_id: taskId },
            {},
          );
        });

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      assert.include(
        harness.getLastCreateQueryInput()?.options.allowedTools ?? [],
        MARK_LONG_RUNNING_TOOL_ID,
      );

      const devServer = { task_id: "dev-server", task_type: "local_bash" };
      const reviewer = { task_id: "reviewer", task_type: "local_agent" };
      emitTasks([devServer, reviewer], "tasks-started");
      assert.deepEqual(yield* nextAwaited, { "dev-server": true, reviewer: true });

      assert.notEqual((yield* markLongRunning("dev-server")).isError, true);
      assert.deepEqual(yield* nextAwaited, { "dev-server": false, reviewer: true });
      assert.equal((yield* markLongRunning("reviewer")).isError, true);
      assert.equal((yield* markLongRunning("no-such-task")).isError, true);

      // A test run started in the same turn is awaited, and the mark on the
      // dev server survives the next snapshot.
      const tests = { task_id: "tests", task_type: "local_bash" };
      emitTasks([devServer, reviewer, tests], "tests-started");
      assert.deepEqual(yield* nextAwaited, { "dev-server": false, reviewer: true, tests: true });

      // The user moved on while the test run was still going: commands still
      // running are no longer awaited, but the agent still is.
      yield* adapter.sendTurn({ threadId: session.threadId, input: "next", attachments: [] });
      assert.deepEqual(yield* nextAwaited, { "dev-server": false, reviewer: true, tests: false });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("replays structured Agent completion after a restart loses launch state", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      // A legacy replay can win the race after restart. The later structured
      // result must supersede its lower-quality output on the same item id.
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-structured-restart",
        uuid: "user-structured-restart-legacy",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "<task-notification>",
                "<task-id>task-structured-restart</task-id>",
                "<tool-use-id>tool-structured-restart</tool-use-id>",
                "<status>completed</status>",
                '<summary>Agent "Interrupted review" finished</summary>',
                "<result>Legacy duplicate.</result>",
                "</task-notification>",
              ].join("\n"),
            },
          ],
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-structured-restart",
        uuid: "user-structured-restart-completed",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-structured-restart",
              content: "Model-facing fallback result.",
            },
          ],
        },
        tool_use_result: {
          status: "completed",
          agentId: "agent-structured-restart",
          content: [{ type: "text", text: "Recovered structured final report." }],
          prompt: "Finish the interrupted review.",
          totalToolUseCount: 2,
          totalDurationMs: 1400,
          totalTokens: 420,
          usage: {
            input_tokens: 300,
            output_tokens: 120,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            server_tool_use: null,
            service_tier: null,
            cache_creation: null,
          },
        },
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-structured-restart-marker",
        description: "Marker task",
        session_id: "sdk-session-structured-restart",
        uuid: "structured-restart-marker-started",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const completedItems = runtimeEvents.filter((event) => event.type === "item.completed");
      const replay = completedItems.at(-1);
      assert.equal(replay?.type, "item.completed");
      if (replay?.type === "item.completed") {
        assert.equal(String(replay.itemId), "tool-structured-restart");
        assert.equal(replay.payload.itemType, "collab_agent_tool_call");
        const data = replay.payload.data as {
          result?: { content?: Array<{ text?: string }> };
          structuredResult?: { agentId?: string };
        };
        assert.equal(data.result?.content?.[0]?.text, "Recovered structured final report.");
        assert.equal(data.structuredResult?.agentId, "agent-structured-restart");
      }
      assert.equal(completedItems.length, 2);
      assert.isTrue(
        completedItems.every((event) => String(event.itemId) === "tool-structured-restart"),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("replays background subagent final results from task notifications", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 12).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "inventory the features in the background",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-bg-agent",
        uuid: "stream-bg-agent-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-task-bg-1",
            name: "Task",
            input: {
              description: "Inventory Threadlines features",
              prompt: "Catalog every feature thoroughly.",
              subagent_type: "Explore",
              run_in_background: true,
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-bg-agent",
        tool_use_id: "tool-task-bg-1",
        description: "explore subagent",
        subagent_type: "Explore",
        task_type: "local_agent",
        session_id: "sdk-session-bg-agent",
        uuid: "bg-agent-task-started",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-bg-agent",
        uuid: "user-bg-agent-launch-ack",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-task-bg-1",
              content:
                "Async agent launched successfully. agentId: agent-bg-1 (internal ID - do not " +
                "mention to user. Use SendMessage with to: 'agent-bg-1', summary: '<5-10 word " +
                "recap>' to continue this agent.) The agent is working in the background.",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-bg-agent",
        uuid: "result-bg-agent",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-bg-agent",
        uuid: "user-bg-agent-notification",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "<task-notification>",
                "<task-id>task-bg-agent</task-id>",
                "<tool-use-id>tool-task-bg-1</tool-use-id>",
                "<output-file>/tmp/tasks/task-bg-agent.output</output-file>",
                "<status>completed</status>",
                '<summary>Agent "Inventory Threadlines features" finished</summary>',
                "<note>The same task-id may notify more than once.</note>",
                "<result>## Feature Inventory\n\nSessions &amp; orchestration: threads spawn " +
                  "providers &lt;10ms after connect.</result>",
                "</task-notification>",
              ].join("\n"),
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-bg-agent",
        tool_use_id: "tool-task-bg-1",
        status: "completed",
        summary: 'Agent "Inventory Threadlines features" finished',
        session_id: "sdk-session-bg-agent",
        uuid: "bg-agent-task-notification",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const replayCompleted = runtimeEvents.filter(
        (event) =>
          event.type === "item.completed" &&
          (event.payload.data as { taskNotification?: unknown } | undefined)?.taskNotification !==
            undefined,
      );
      assert.equal(replayCompleted.length, 1);
      const replay = replayCompleted[0];
      assert.equal(replay?.type, "item.completed");
      if (replay?.type === "item.completed") {
        assert.equal(String(replay.itemId), "tool-task-bg-1");
        assert.equal(replay.payload.itemType, "collab_agent_tool_call");
        assert.equal(replay.payload.status, "completed");
        assert.equal(replay.payload.title, "Subagent task");
        const data = replay.payload.data as {
          toolName?: string;
          input?: { subagent_type?: string };
          result?: { content?: Array<{ text?: string }> };
          taskNotification?: { taskId?: string; status?: string; summary?: string };
        };
        assert.equal(data.toolName, "Task");
        assert.equal(data.input?.subagent_type, "Explore");
        assert.equal(
          data.result?.content?.[0]?.text,
          "## Feature Inventory\n\nSessions & orchestration: threads spawn providers <10ms after connect.",
        );
        assert.deepEqual(data.taskNotification, {
          taskId: "task-bg-agent",
          status: "completed",
          summary: 'Agent "Inventory Threadlines features" finished',
        });
      }

      const taskStarted = runtimeEvents.find(
        (event) => event.type === "task.started" && event.payload.taskId === "task-bg-agent",
      );
      assert.equal(taskStarted?.type, "task.started");
      if (taskStarted?.type === "task.started") {
        assert.equal(taskStarted.payload.taskType, "local_agent");
        assert.equal(taskStarted.payload.toolUseId, "tool-task-bg-1");
        assert.equal(taskStarted.payload.subagentType, "Explore");
      }

      const taskCompleted = runtimeEvents.find((event) => event.type === "task.completed");
      assert.equal(taskCompleted?.type, "task.completed");
      if (taskCompleted?.type === "task.completed") {
        assert.equal(taskCompleted.payload.taskId, "task-bg-agent");
        assert.equal(taskCompleted.payload.toolUseId, "tool-task-bg-1");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not mint a subagent row when a shell command is moved to the background", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "task.started" && event.payload.taskId === "task-bg-shell-marker",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      // A foreground Bash call that outlives its timeout: the SDK reports the
      // same local_bash task as started, then backgrounded, then killed.
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-bg-shell",
        tool_use_id: "tool-bash-bg-shell",
        description: "Probe the agent",
        task_type: "local_bash",
        is_backgrounded: false,
        session_id: "sdk-session-bg-shell",
        uuid: "bg-shell-started",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-bg-shell",
        patch: { is_backgrounded: true },
        session_id: "sdk-session-bg-shell",
        uuid: "bg-shell-backgrounded",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-bg-shell",
        patch: { status: "killed" },
        session_id: "sdk-session-bg-shell",
        uuid: "bg-shell-killed",
      } as unknown as SDKMessage);
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-bg-shell-marker",
        description: "Marker task",
        session_id: "sdk-session-bg-shell",
        uuid: "bg-shell-marker",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.isUndefined(runtimeEvents.find((event) => event.type === "subagent.metadata.updated"));
      const completed = runtimeEvents.find(
        (event) => event.type === "task.completed" && event.payload.taskId === "task-bg-shell",
      );
      assert.equal(completed?.type, "task.completed");
      if (completed?.type === "task.completed") {
        assert.equal(completed.payload.status, "stopped");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not replay task notifications for non-subagent background tools", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-bg-command",
        tool_use_id: "tool-bash-bg-1",
        description: "Watch CI run until completion",
        session_id: "sdk-session-bg-command",
        uuid: "bg-command-task-started",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-bg-command",
        uuid: "user-bg-command-notification",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "<task-notification>",
                "<task-id>task-bg-command</task-id>",
                "<tool-use-id>tool-bash-bg-1</tool-use-id>",
                "<status>completed</status>",
                '<summary>Background command "Watch CI run" completed (exit code 0)</summary>',
                "</task-notification>",
              ].join("\n"),
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-bg-command",
        tool_use_id: "tool-bash-bg-1",
        status: "completed",
        summary: 'Background command "Watch CI run" completed (exit code 0)',
        session_id: "sdk-session-bg-command",
        uuid: "bg-command-task-notification",
      } as unknown as SDKMessage);

      // Marker: with the fixed-size take, it only fits when the notification
      // above replayed no tool item events.
      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-bg-command-marker",
        description: "Marker task",
        session_id: "sdk-session-bg-command",
        uuid: "bg-command-marker-started",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.isUndefined(
        runtimeEvents.find(
          (event) =>
            event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed",
        ),
      );
      const taskCompleted = runtimeEvents.find((event) => event.type === "task.completed");
      assert.equal(taskCompleted?.type, "task.completed");
      if (taskCompleted?.type === "task.completed") {
        assert.equal(taskCompleted.payload.toolUseId, "tool-bash-bg-1");
      }
      const markerStarted = runtimeEvents.find(
        (event) =>
          event.type === "task.started" && event.payload.taskId === "task-bg-command-marker",
      );
      assert.isDefined(markerStarted);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("replays agent task notifications after a restart loses the launch record", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      // No tool_use or task_started preceded this notification in this
      // process: the launch happened before a restart, so the notification is
      // the only trace of the agent's output.
      harness.query.emit({
        type: "user",
        session_id: "sdk-session-restart-agent",
        uuid: "user-restart-agent-notification",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "<task-notification>",
                "<task-id>task-restart-agent</task-id>",
                "<tool-use-id>tool-task-restart-1</tool-use-id>",
                "<status>completed</status>",
                '<summary>Agent "Inventory Threadlines features" finished</summary>',
                "<result>## Feature Inventory\n\nEverything still works.</result>",
                "</task-notification>",
              ].join("\n"),
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-restart-agent-marker",
        description: "Marker task",
        session_id: "sdk-session-restart-agent",
        uuid: "restart-agent-marker-started",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const replay = runtimeEvents.find((event) => event.type === "item.completed");
      assert.equal(replay?.type, "item.completed");
      if (replay?.type === "item.completed") {
        assert.equal(String(replay.itemId), "tool-task-restart-1");
        assert.equal(replay.payload.itemType, "collab_agent_tool_call");
        assert.equal(replay.payload.status, "completed");
        assert.equal(replay.payload.title, "Subagent task");
        assert.equal(replay.payload.detail, 'Agent "Inventory Threadlines features" finished');
        const data = replay.payload.data as {
          toolName?: string;
          result?: { content?: Array<{ text?: string }> };
          taskNotification?: { taskId?: string; status?: string };
        };
        assert.equal(data.toolName, "Agent");
        assert.equal(
          data.result?.content?.[0]?.text,
          "## Feature Inventory\n\nEverything still works.",
        );
        assert.equal(data.taskNotification?.taskId, "task-restart-agent");
      }
      const markerStarted = runtimeEvents.find(
        (event) =>
          event.type === "task.started" && event.payload.taskId === "task-restart-agent-marker",
      );
      assert.isDefined(markerStarted);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not derive context usage from Claude task progress totals", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "task_progress",
        task_id: "task-usage-1",
        description: "Thinking through the patch",
        usage: {
          total_tokens: 321,
          tool_uses: 2,
          duration_ms: 654,
        },
        session_id: "sdk-session-task-usage",
        uuid: "task-usage-progress-1",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      const progressEvent = runtimeEvents.find((event) => event.type === "task.progress");
      assert.isUndefined(usageEvent);
      assert.equal(progressEvent?.type, "task.progress");
      if (progressEvent?.type === "task.progress") {
        assert.deepEqual(progressEvent.payload.usage, {
          total_tokens: 321,
          tool_uses: 2,
          duration_ms: 654,
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "ignores a category-less context usage report instead of emitting a bare snapshot",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "hello",
          attachments: [],
        });

        // A freshly resumed SDK process reports a token estimate before it has
        // rebuilt its context breakdown. Emitting that would replace the last
        // rich snapshot with a bare one, so no usage event may be produced.
        harness.query.setContextUsageResponse(
          makeContextUsageResponse({
            totalTokens: 93169,
            maxTokens: 1000000,
            categories: [],
          }),
        );
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 100,
          duration_api_ms: 90,
          num_turns: 1,
          result: "done",
          stop_reason: "end_turn",
          session_id: "sdk-session-bare-context",
        } as unknown as SDKMessage);
        harness.query.finish();

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        assert.deepEqual(
          runtimeEvents.filter((event) => event.type === "thread.token-usage.updated"),
          [],
        );
        assert.equal(harness.query.getContextUsageCalls.length, 1);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("emits Claude context window on result completion usage snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.setContextUsageResponse(
        makeContextUsageResponse({
          totalTokens: 24542,
          maxTokens: 200000,
        }),
      );
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage",
        usage: {
          input_tokens: 4,
          cache_creation_input_tokens: 2715,
          cache_read_input_tokens: 21144,
          output_tokens: 679,
        },
        modelUsage: {
          "claude-opus-4-6": {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 24542,
            lastUsedTokens: 24542,
            inputTokens: 23863,
            cachedInputTokens: 21144,
            outputTokens: 679,
            maxTokens: 200000,
            contextCategories: [{ name: "Messages", tokens: 24542 }],
            lastInputTokens: 23863,
            lastCachedInputTokens: 21144,
            lastOutputTokens: 679,
            compactsAutomatically: true,
          },
        });
      }
      assert.equal(harness.query.getContextUsageCalls.length, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("refreshes Claude context window after assistant response snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 10).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.setContextUsageResponses([
        makeContextUsageResponse({
          totalTokens: 22000,
          maxTokens: 200000,
        }),
        makeContextUsageResponse({
          totalTokens: 24000,
          maxTokens: 200000,
        }),
      ]);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-assistant-usage",
        uuid: "assistant-usage",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-usage",
          content: [{ type: "text", text: "Working on it" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-assistant-usage",
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 20,
          output_tokens: 80,
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvents = runtimeEvents.filter(
        (event) => event.type === "thread.token-usage.updated",
      );
      assert.equal(usageEvents.length, 2);

      assert.deepEqual(usageEvents[0]?.payload, {
        usage: {
          usedTokens: 22000,
          lastUsedTokens: 22000,
          maxTokens: 200000,
          contextCategories: [{ name: "Messages", tokens: 22000 }],
          compactsAutomatically: true,
        },
      });
      assert.deepEqual(usageEvents[1]?.payload, {
        usage: {
          usedTokens: 24000,
          lastUsedTokens: 24000,
          inputTokens: 120,
          cachedInputTokens: 20,
          outputTokens: 80,
          maxTokens: 200000,
          contextCategories: [{ name: "Messages", tokens: 24000 }],
          lastInputTokens: 120,
          lastCachedInputTokens: 20,
          lastOutputTokens: 80,
          compactsAutomatically: true,
        },
      });

      const firstUsageIndex = runtimeEvents.indexOf(usageEvents[0]!);
      const secondUsageIndex = runtimeEvents.indexOf(usageEvents[1]!);
      const turnCompletedIndex = runtimeEvents.findIndex(
        (event) => event.type === "turn.completed",
      );
      assert.equal(
        firstUsageIndex >= 0 &&
          secondUsageIndex > firstUsageIndex &&
          turnCompletedIndex > secondUsageIndex,
        true,
      );
      assert.equal(harness.query.getContextUsageCalls.length, 2);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("skips duplicate Claude context window snapshots at turn completion", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      // Both snapshots carry an equal-but-not-identical category array: the
      // dedupe has to compare the entries, not the array reference.
      const categories = [
        { name: "System prompt", tokens: 3000, color: "#111111", kind: "used" },
        { name: "MCP tools", tokens: 700, color: "#444444", isDeferred: true, kind: "deferred" },
        { name: "System tools (deferred)", tokens: 5000, color: "#555555", kind: "deferred" },
        { name: "Messages", tokens: 19000, color: "#222222", kind: "used" },
        { name: "Free space", tokens: 178000, color: "#333333", kind: "free" },
      ] satisfies SDKControlGetContextUsageResponse["categories"];
      harness.query.setContextUsageResponses([
        makeContextUsageResponse({
          totalTokens: 22000,
          maxTokens: 200000,
          categories: categories.map((category) => ({ ...category })),
        }),
        makeContextUsageResponse({
          totalTokens: 22000,
          maxTokens: 200000,
          categories: categories.map((category) => ({ ...category })),
        }),
      ]);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-duplicate-usage",
        uuid: "assistant-duplicate-usage",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-duplicate-usage",
          content: [{ type: "text", text: "Working on it" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-duplicate-usage",
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvents = runtimeEvents.filter(
        (event) => event.type === "thread.token-usage.updated",
      );
      assert.equal(usageEvents.length, 1);
      assert.deepEqual(usageEvents[0]?.payload, {
        usage: {
          usedTokens: 22000,
          lastUsedTokens: 22000,
          maxTokens: 200000,
          // Free space is derived client-side and deferred categories are not
          // part of the used total, so both are filtered out here.
          contextCategories: [
            { name: "System prompt", tokens: 3000 },
            { name: "Messages", tokens: 19000 },
          ],
          compactsAutomatically: true,
        },
      });
      assert.equal(harness.query.getContextUsageCalls.length, 2);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("emits Claude context window from compact boundary post tokens", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.setContextUsageResponse(
        makeContextUsageResponse({
          totalTokens: 190000,
          maxTokens: 200000,
        }),
      );

      harness.query.emit({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          trigger: "manual",
          pre_tokens: 190000,
          post_tokens: 4500,
        },
        session_id: "sdk-session-compact-usage",
        uuid: "compact-boundary-usage",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 4500,
            lastUsedTokens: 4500,
            maxTokens: 200000,
            compactsAutomatically: true,
          },
        });
      }
      assert.equal(harness.query.getContextUsageCalls.length, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("surfaces api_retry warnings only once retries escalate past attempt 1", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      // First-attempt retries are diagnostics-only and never reach the feed.
      harness.query.emit({
        type: "system",
        subtype: "api_retry",
        attempt: 1,
        max_retries: 10,
        retry_delay_ms: 1_000,
        error_status: null,
        error: "unknown",
        session_id: "sdk-session-api-retry",
        uuid: "api-retry-0",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "api_retry",
        attempt: 2,
        max_retries: 10,
        retry_delay_ms: 4_000,
        error_status: 429,
        error: { type: "rate_limit_error" },
        session_id: "sdk-session-api-retry",
        uuid: "api-retry-1",
      } as unknown as SDKMessage);

      // Internal bookkeeping subtypes stay silent.
      harness.query.emit({
        type: "system",
        subtype: "commands_changed",
        session_id: "sdk-session-api-retry",
        uuid: "commands-changed-1",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-api-retry",
        uuid: "result-api-retry",
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const warnings = runtimeEvents.filter((event) => event.type === "runtime.warning");
      assert.equal(warnings.length, 1);
      const warning = warnings[0];
      if (warning?.type === "runtime.warning") {
        assert.equal(
          warning.payload.message,
          "Claude API rate limited, retrying in 4s (attempt 2/10)",
        );
        assert.equal(warning.payload.warningKind, "api-retry");
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("warns once when the inherited environment disables session persistence", () => {
    const harness = makeHarness({
      environment: {
        ...missingClaudeConfigEnvironment(),
        CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "informational",
        content:
          "CLAUDE_CODE_SKIP_PROMPT_HISTORY is set --resume will not find this session; if unintended, unset it and restart",
        level: "warning",
        session_id: "sdk-session-persistence-disabled",
        uuid: "persistence-disabled-1",
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const warnings = runtimeEvents.filter((event) => event.type === "runtime.warning");
      assert.equal(warnings.length, 1);
      assert.include(warnings[0]?.payload.message ?? "", "CLAUDE_CODE_SKIP_PROMPT_HISTORY");
      assert.equal(warnings[0]?.payload.warningKind, "session-persistence");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("surfaces Claude transcript-write informational warnings", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "informational",
        content:
          "Transcript writes are failing (disk full); recent messages may not be saved for resume",
        level: "warning",
        session_id: "sdk-session-transcript-write-failed",
        uuid: "transcript-write-failed-1",
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const warnings = runtimeEvents.filter((event) => event.type === "runtime.warning");
      assert.equal(warnings.length, 1);
      assert.equal(
        warnings[0]?.payload.message,
        "Transcript writes are failing (disk full); recent messages may not be saved for resume",
      );
      assert.equal(warnings[0]?.payload.warningKind, "session-persistence");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "consumes command_lifecycle and unknown SDK message types without runtime warnings",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "hello",
          attachments: [],
        });

        harness.query.emit({
          type: "command_lifecycle",
          command_uuid: "command-1",
          state: "started",
          session_id: "sdk-session-command-lifecycle",
          uuid: "command-lifecycle-1",
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "command_lifecycle",
          command_uuid: "command-1",
          state: "completed",
          session_id: "sdk-session-command-lifecycle",
          uuid: "command-lifecycle-2",
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "some_future_message_type",
          session_id: "sdk-session-command-lifecycle",
          uuid: "future-message-1",
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-command-lifecycle",
          uuid: "result-command-lifecycle",
        } as unknown as SDKMessage);
        harness.query.finish();

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        assert.deepEqual(
          runtimeEvents.filter((event) => event.type === "runtime.warning"),
          [],
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("consumes Claude thinking token telemetry without surfacing runtime warnings", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "system",
        subtype: "thinking_tokens",
        estimated_tokens: 50,
        estimated_tokens_delta: 50,
        session_id: "sdk-session-thinking-tokens",
        uuid: "thinking-tokens-1",
      } as unknown as SDKMessage);

      harness.query.setContextUsageResponse(
        makeContextUsageResponse({
          totalTokens: 80,
          maxTokens: 1000000,
        }),
      );
      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-thinking-tokens",
        usage: {
          input_tokens: 10,
          output_tokens: 70,
        },
        modelUsage: {
          "claude-opus-4-6": {
            contextWindow: 1000000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.filter((event) => event.type === "runtime.warning"),
        [],
      );
      const usageEvent = runtimeEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usageEvent?.type, "thread.token-usage.updated");
      if (usageEvent?.type === "thread.token-usage.updated") {
        assert.deepEqual(usageEvent.payload, {
          usage: {
            usedTokens: 80,
            lastUsedTokens: 80,
            inputTokens: 10,
            outputTokens: 70,
            reasoningOutputTokens: 50,
            lastInputTokens: 10,
            lastOutputTokens: 70,
            lastReasoningOutputTokens: 50,
            maxTokens: 1000000,
            contextCategories: [{ name: "Messages", tokens: 80 }],
            compactsAutomatically: true,
          },
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not derive Claude context usage from accumulated result totals", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 6).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1234,
        duration_api_ms: 1200,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        session_id: "sdk-session-result-usage-clamped",
        usage: {
          total_tokens: 535000,
        },
        modelUsage: {
          "claude-opus-4-6": {
            contextWindow: 200000,
            maxOutputTokens: 64000,
          },
        },
      } as unknown as SDKMessage);
      harness.query.finish();

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.isUndefined(
        runtimeEvents.find((event) => event.type === "thread.token-usage.updated"),
      );
      assert.equal(harness.query.getContextUsageCalls.length, 0);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "ignores oversized Claude result totals after task progress totals are recorded",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "hello",
          attachments: [],
        });

        harness.query.emit({
          type: "system",
          subtype: "task_progress",
          task_id: "task-usage-clamped",
          description: "Thinking through the patch",
          usage: {
            total_tokens: 190000,
          },
          session_id: "sdk-session-task-usage-clamped",
          uuid: "task-usage-progress-clamped",
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1234,
          duration_api_ms: 1200,
          num_turns: 1,
          result: "done",
          stop_reason: "end_turn",
          session_id: "sdk-session-result-usage-clamped-after-progress",
          usage: {
            total_tokens: 535000,
          },
          modelUsage: {
            "claude-opus-4-6": {
              contextWindow: 200000,
              maxOutputTokens: 64000,
            },
          },
        } as unknown as SDKMessage);
        harness.query.finish();

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        assert.deepEqual(
          runtimeEvents.filter((event) => event.type === "thread.token-usage.updated"),
          [],
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "emits completion only after turn result when assistant frames arrive before deltas",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        harness.query.emit({
          type: "assistant",
          session_id: "sdk-session-early-assistant",
          uuid: "assistant-early",
          parent_tool_use_id: null,
          message: {
            id: "assistant-message-early",
            content: [
              { type: "tool_use", id: "tool-early", name: "Read", input: { path: "a.ts" } },
            ],
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-early-assistant",
          uuid: "stream-early",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: "Late text",
            },
          },
        } as unknown as SDKMessage);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-early-assistant",
          uuid: "result-early",
        } as unknown as SDKMessage);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        assert.deepEqual(
          runtimeEvents.map((event) => event.type),
          [
            "session.started",
            "session.configured",
            "session.state.changed",
            "turn.started",
            "thread.started",
            "content.delta",
            "item.completed",
            "turn.completed",
          ],
        );

        const deltaIndex = runtimeEvents.findIndex((event) => event.type === "content.delta");
        const completedIndex = runtimeEvents.findIndex((event) => event.type === "item.completed");
        assert.equal(deltaIndex >= 0 && completedIndex >= 0 && deltaIndex < completedIndex, true);

        const deltaEvent = runtimeEvents[deltaIndex];
        assert.equal(deltaEvent?.type, "content.delta");
        if (deltaEvent?.type === "content.delta") {
          assert.equal(deltaEvent.payload.delta, "Late text");
          assert.equal(String(deltaEvent.turnId), String(turn.turnId));
        }
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("creates a fresh assistant message when Claude reuses a text block index", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-start-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-delta-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "First",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-stop-1",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-start-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-delta-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "Second",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-reused-text-index",
        uuid: "stream-reused-stop-2",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-reused-text-index",
        uuid: "result-reused-text-index",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "content.delta",
          "item.completed",
        ],
      );

      const assistantDeltas = runtimeEvents.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.equal(assistantDeltas.length, 2);
      if (assistantDeltas.length !== 2) {
        return;
      }
      const [firstAssistantDelta, secondAssistantDelta] = assistantDeltas;
      assert.equal(firstAssistantDelta?.type, "content.delta");
      assert.equal(secondAssistantDelta?.type, "content.delta");
      if (
        firstAssistantDelta?.type !== "content.delta" ||
        secondAssistantDelta?.type !== "content.delta"
      ) {
        return;
      }
      assert.equal(firstAssistantDelta.payload.delta, "First");
      assert.equal(secondAssistantDelta.payload.delta, "Second");
      assert.notEqual(firstAssistantDelta.itemId, secondAssistantDelta.itemId);

      const assistantCompletions = runtimeEvents.filter(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      assert.equal(assistantCompletions.length, 2);
      assert.equal(String(assistantCompletions[0]?.itemId), String(firstAssistantDelta.itemId));
      assert.equal(String(assistantCompletions[1]?.itemId), String(secondAssistantDelta.itemId));
      assert.notEqual(
        String(assistantCompletions[0]?.itemId),
        String(assistantCompletions[1]?.itemId),
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("falls back to assistant payload text when stream deltas are absent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-fallback-text",
        uuid: "assistant-fallback",
        parent_tool_use_id: null,
        message: {
          id: "assistant-message-fallback",
          content: [{ type: "text", text: "Fallback hello" }],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-fallback-text",
        uuid: "result-fallback",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const deltaEvent = runtimeEvents.find((event) => event.type === "content.delta");
      assert.equal(deltaEvent?.type, "content.delta");
      if (deltaEvent?.type === "content.delta") {
        assert.equal(deltaEvent.payload.delta, "Fallback hello");
        assert.equal(String(deltaEvent.turnId), String(turn.turnId));
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("segments Claude assistant text blocks around tool calls", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 13).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-delta",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: "First message.",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-1-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 0,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-tool-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool-interleaved-1",
            name: "Grep",
            input: {
              pattern: "assistant",
              path: "src",
            },
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-tool-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 1,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "user",
        session_id: "sdk-session-interleaved",
        uuid: "user-tool-result-interleaved",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-interleaved-1",
              content: "src/example.ts:1:assistant",
            },
          ],
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-start",
        parent_tool_use_id: null,
        event: {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "text",
            text: "",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-delta",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 2,
          delta: {
            type: "text_delta",
            text: "Second message.",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-interleaved",
        uuid: "stream-text-2-stop",
        parent_tool_use_id: null,
        event: {
          type: "content_block_stop",
          index: 2,
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-interleaved",
        uuid: "result-interleaved",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
          "content.delta",
          "item.completed",
          "item.started",
          "item.updated",
          "item.completed",
          "content.delta",
          "item.completed",
          "turn.completed",
        ],
      );

      const assistantTextDeltas = runtimeEvents.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.equal(assistantTextDeltas.length, 2);
      if (assistantTextDeltas.length !== 2) {
        return;
      }
      const [firstAssistantDelta, secondAssistantDelta] = assistantTextDeltas;
      if (!firstAssistantDelta || !secondAssistantDelta) {
        return;
      }
      assert.notEqual(String(firstAssistantDelta.itemId), String(secondAssistantDelta.itemId));

      const firstAssistantCompletedIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "item.completed" &&
          event.payload.itemType === "assistant_message" &&
          String(event.itemId) === String(firstAssistantDelta.itemId),
      );
      const toolStartedIndex = runtimeEvents.findIndex((event) => event.type === "item.started");
      const secondAssistantDeltaIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "content.delta" &&
          event.payload.streamKind === "assistant_text" &&
          String(event.itemId) === String(secondAssistantDelta.itemId),
      );

      assert.equal(
        firstAssistantCompletedIndex >= 0 &&
          toolStartedIndex >= 0 &&
          secondAssistantDeltaIndex >= 0 &&
          firstAssistantCompletedIndex < toolStartedIndex &&
          toolStartedIndex < secondAssistantDeltaIndex,
        true,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not fabricate provider thread ids before first SDK session_id", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 5).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      assert.equal(session.threadId, THREAD_ID);

      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(turn.threadId, THREAD_ID);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-thread-real",
        uuid: "stream-thread-real",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-thread-real",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-thread-real",
        uuid: "result-thread-real",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "turn.started",
          "thread.started",
        ],
      );

      const sessionStarted = runtimeEvents[0];
      assert.equal(sessionStarted?.type, "session.started");
      if (sessionStarted?.type === "session.started") {
        assert.equal(sessionStarted.threadId, THREAD_ID);
      }

      const threadStarted = runtimeEvents[4];
      assert.equal(threadStarted?.type, "thread.started");
      if (threadStarted?.type === "thread.started") {
        assert.equal(threadStarted.threadId, THREAD_ID);
        assert.deepEqual(threadStarted.payload, {
          providerThreadId: "sdk-thread-real",
        });
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("bridges approval request/response lifecycle through canUseTool", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "approve this",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-approval-1",
        uuid: "stream-approval-thread",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-approval-thread",
          },
        },
      } as unknown as SDKMessage);

      const threadStarted = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(threadStarted._tag, "Some");
      if (threadStarted._tag !== "Some") {
        return;
      }
      assert.equal(threadStarted.value.type, "thread.started");
      if (threadStarted.value.type !== "thread.started") {
        return;
      }

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "Bash",
        { command: "pwd" },
        {
          signal: new AbortController().signal,
          suggestions: [
            {
              type: "setMode",
              mode: "default",
              destination: "session",
            },
          ],
          toolUseID: "tool-use-1",
          requestId: "request-use-1",
        },
      );

      const requested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requested._tag, "Some");
      if (requested._tag !== "Some") {
        return;
      }
      assert.equal(requested.value.type, "request.opened");
      if (requested.value.type !== "request.opened") {
        return;
      }
      assert.deepEqual(requested.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-use-1"),
      });
      const runtimeRequestId = requested.value.requestId;
      assert.equal(typeof runtimeRequestId, "string");
      if (runtimeRequestId === undefined) {
        return;
      }

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(runtimeRequestId),
        "accept",
      );

      const resolved = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolved._tag, "Some");
      if (resolved._tag !== "Some") {
        return;
      }
      assert.equal(resolved.value.type, "request.resolved");
      if (resolved.value.type !== "request.resolved") {
        return;
      }
      assert.equal(resolved.value.requestId, requested.value.requestId);
      assert.equal(resolved.value.payload.decision, "accept");
      assert.deepEqual(resolved.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-use-1"),
      });

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "shows Claude's own words with an approval and keeps Always allow off when it says so",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "approval-required",
        });
        yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);
        yield* adapter.sendTurn({ threadId: session.threadId, input: "read it", attachments: [] });
        yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);
        harness.query.emit({
          type: "stream_event",
          session_id: "sdk-session-approval-words",
          uuid: "stream-approval-words",
          parent_tool_use_id: null,
          event: { type: "message_start", message: { id: "msg-approval-words" } },
        } as unknown as SDKMessage);
        yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

        const canUseTool = harness.getLastCreateQueryInput()?.options.canUseTool;
        assert.equal(typeof canUseTool, "function");
        if (!canUseTool) {
          return;
        }
        const permissionPromise = canUseTool(
          "Read",
          { file_path: "/Users/me/.ssh/config" },
          {
            signal: new AbortController().signal,
            suggestions: [
              {
                type: "addRules",
                rules: [{ toolName: "Read", ruleContent: "//Users/me/**" }],
                behavior: "allow",
                destination: "session",
              },
            ],
            title: "  Claude wants to read config  ",
            decisionReason: "Path is outside the allowed working directories",
            description: "Claude will have read access to files in ~/.ssh",
            blockedPath: "/Users/me/.ssh/config",
            defaultToNo: true,
            suppressAlwaysAllowRule: true,
            toolUseID: "tool-use-words",
            requestId: "request-use-words",
          },
        );

        const requested = yield* Stream.runHead(adapter.streamEvents);
        assert.equal(requested._tag, "Some");
        if (requested._tag !== "Some" || requested.value.type !== "request.opened") {
          return;
        }
        assert.deepInclude(requested.value.payload, {
          title: "Claude wants to read config",
          reason: "Path is outside the allowed working directories",
          description: "Claude will have read access to files in ~/.ssh",
          blockedPath: "/Users/me/.ssh/config",
          defaultToNo: true,
        });
        assert.deepEqual(requested.value.payload.availableDecisions, [
          "accept",
          "decline",
          "cancel",
        ]);

        // An answer from a client that still offered it writes no lasting rule.
        yield* adapter.respondToRequest(
          session.threadId,
          ApprovalRequestId.make(requested.value.requestId!),
          "acceptForSession",
        );
        const permissionResult = (yield* Effect.promise(
          () => permissionPromise,
        )) as PermissionResult;
        assert.equal(permissionResult.behavior, "allow");
        assert.notProperty(permissionResult, "updatedPermissions");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("classifies Agent tools and read-only Claude tools correctly for approvals", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const agentPermissionPromise = canUseTool(
        "Agent",
        {},
        {
          signal: new AbortController().signal,
          toolUseID: "tool-agent-1",
          requestId: "request-agent-1",
        },
      );

      const agentRequested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(agentRequested._tag, "Some");
      if (agentRequested._tag !== "Some") {
        return;
      }
      assert.equal(agentRequested.value.type, "request.opened");
      if (agentRequested.value.type !== "request.opened") {
        return;
      }
      assert.equal(agentRequested.value.payload.requestType, "dynamic_tool_call");

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(String(agentRequested.value.requestId)),
        "accept",
      );
      yield* Stream.runHead(adapter.streamEvents);
      yield* Effect.promise(() => agentPermissionPromise);

      const grepPermissionPromise = canUseTool(
        "Grep",
        { pattern: "foo", path: "src" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-grep-approval-1",
          requestId: "request-grep-approval-1",
        },
      );

      const grepRequested = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(grepRequested._tag, "Some");
      if (grepRequested._tag !== "Some") {
        return;
      }
      assert.equal(grepRequested.value.type, "request.opened");
      if (grepRequested.value.type !== "request.opened") {
        return;
      }
      assert.equal(grepRequested.value.payload.requestType, "file_read_approval");

      yield* adapter.respondToRequest(
        session.threadId,
        ApprovalRequestId.make(String(grepRequested.value.requestId)),
        "accept",
      );
      yield* Stream.runHead(adapter.streamEvents);
      yield* Effect.promise(() => grepPermissionPromise);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("passes Claude resume ids without pinning a stale assistant checkpoint", () => {
    const seeded = seedClaudeTranscript("550e8400-e29b-41d4-a716-446655440000");
    const harness = makeHarness({ environment: seeded.environment });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: {
          threadId: "resume-thread-1",
          resume: "550e8400-e29b-41d4-a716-446655440000",
          resumeSessionAt: "assistant-99",
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, RESUME_THREAD_ID);
      assert.deepEqual(session.resumeCursor, {
        threadId: RESUME_THREAD_ID,
        resume: "550e8400-e29b-41d4-a716-446655440000",
        resumeSessionAt: "assistant-99",
        turnCount: 3,
      });

      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.resume, "550e8400-e29b-41d4-a716-446655440000");
      assert.equal(createInput?.options.sessionId, undefined);
      assert.equal(createInput?.options.resumeSessionAt, undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
      Effect.ensuring(Effect.sync(seeded.cleanup)),
    );
  });

  // A plain resume re-enters the worktree the transcript last recorded; the
  // user moved this thread back to its checkout, so the resume must fork.
  it.effect("forks the resume when the transcript's worktree is not the requested cwd", () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const recordedWorktree = path.join(process.cwd(), ".claude", "worktrees", "left-behind");
    const runResume = (cwd: string) => {
      const seeded = seedClaudeTranscript(
        sessionId,
        `${JSON.stringify({ type: "worktree-state", worktreeSession: { worktreePath: recordedWorktree }, sessionId })}\n`,
      );
      const harness = makeHarness({ environment: seeded.environment });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        yield* adapter.startSession({
          threadId: RESUME_THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          cwd,
          resumeCursor: { threadId: "resume-thread-1", resume: sessionId },
          runtimeMode: "full-access",
        });
        return harness.getLastCreateQueryInput()?.options;
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
        Effect.ensuring(Effect.sync(seeded.cleanup)),
      );
    };
    return Effect.gen(function* () {
      const movedOut = yield* runResume(process.cwd());
      assert.equal(movedOut?.resume, sessionId);
      assert.equal(movedOut?.forkSession, true);

      // Resuming inside the recorded worktree is a plain resume.
      const stayed = yield* runResume(recordedWorktree);
      assert.equal(stayed?.resume, sessionId);
      assert.equal(stayed?.forkSession, undefined);
    });
  });

  it.effect("falls back to a fresh session when the resume transcript is missing", () => {
    const missingSessionId = "0f0e0d0c-0b0a-4908-8706-050403020100";
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const warningFiber = yield* Stream.runHead(
        adapter.streamEvents.pipe(Stream.filter((event) => event.type === "runtime.warning")),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: {
          threadId: "resume-thread-1",
          resume: missingSessionId,
          resumeSessionAt: "assistant-99",
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });

      // No transcript on disk means a native resume would fail every retry;
      // the adapter starts fresh with an app-generated session id instead.
      const createInput = harness.getLastCreateQueryInput();
      assert.equal(createInput?.options.resume, undefined);
      assert.equal(typeof createInput?.options.sessionId, "string");
      assert.notEqual(createInput?.options.sessionId, missingSessionId);

      const resumeCursor = session.resumeCursor as {
        readonly resume?: string;
        readonly resumeSessionAt?: string;
        readonly turnCount?: number;
      };
      assert.equal(resumeCursor.resume, createInput?.options.sessionId);
      assert.equal(resumeCursor.resumeSessionAt, undefined);
      assert.equal(resumeCursor.turnCount, 0);

      // The degraded resume is surfaced to the user, not just server logs.
      const warning = yield* Fiber.join(warningFiber).pipe(Effect.timeout("1 second"));
      assert.equal(warning._tag, "Some");
      if (warning._tag === "Some" && warning.value.type === "runtime.warning") {
        assert.equal(warning.value.payload.warningKind, "resume-fallback");
        assert.match(warning.value.payload.message, /Starting fresh/);
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("refuses to start fresh when the conversation must be reopened", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const started = yield* adapter
        .startSession({
          threadId: RESUME_THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          resumeCursor: {
            threadId: "resume-thread-1",
            resume: "0f0e0d0c-0b0a-4908-8706-050403020100",
            turnCount: 3,
          },
          resumePolicy: "required",
          runtimeMode: "full-access",
        })
        .pipe(Effect.exit);
      assert.equal(Exit.isFailure(started), true);
      assert.equal(harness.getLastCreateQueryInput(), undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("refuses to answer on the side without the conversation it was asked to fork", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      // A fresh start here would answer as if it knew the conversation; the
      // reactor seeds the room's history instead when this fails.
      const started = yield* adapter
        .startSession({
          threadId: RESUME_THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          lockdown: "side-answer",
          forkFrom: { providerThreadId: "0f0e0d0c-0b0a-4908-8706-050403020100" },
          runtimeMode: "full-access",
        })
        .pipe(Effect.exit);
      assert.equal(Exit.isFailure(started), true);
      assert.equal(harness.getLastCreateQueryInput(), undefined);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "attaches the room tools to a room's working agent, on a credential its stop revokes",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const plain = yield* adapter.startSession({
          threadId: ThreadId.make("thread-claude-plain"),
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        // Not asked for: nothing is said either way.
        assert.equal(plain.roomTools, undefined);
        const appendOf = (options: { readonly systemPrompt?: unknown }) =>
          (options.systemPrompt as { readonly append?: string } | undefined)?.append ?? "";
        // No schedule tools, so no word about them.
        assert.notInclude(
          appendOf(harness.getLastCreateQueryInput()!.options),
          "<threadlines_schedules>",
        );

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
          roomTools: true,
          scheduleTools: true,
        });
        assert.equal(session.roomTools, true);
        const options = harness.getLastCreateQueryInput()!.options;
        const room = options.mcpServers?.["threadlines_room"] as
          | {
              readonly url: string;
              readonly headers: Record<string, string>;
              readonly timeout: number;
            }
          | undefined;
        assert.match(room!.url, /\/mcp\/room$/);
        // Claude outwaits the room's own deadline, so the deadline answers first.
        assert.isAbove(room!.timeout, Duration.toMillis(ROOM_REQUEST_DEADLINE));
        assert.include(options.allowedTools ?? [], "mcp__threadlines_room__room_ask");
        // Asked to schedule something, it uses Threadlines' scheduled tasks
        // rather than its own schedulers, which the user would never see.
        assert.include(appendOf(options), "`mcp__threadlines_room__schedule_create`");
        assert.include(appendOf(options), "CronCreate");
        assert.notInclude(
          options.allowedTools ?? [],
          "mcp__threadlines_room__scheduled_run_finish",
        );
        const token = room!.headers.Authorization!.replace("Bearer ", "");
        assert.equal(
          (yield* mcpSessionRegistry.resolve(token))?.roomTools.size,
          ROOM_TOOL_NAMES.length,
        );

        yield* adapter.stopSession(THREAD_ID);
        assert.equal(yield* mcpSessionRegistry.resolve(token), null);

        // A scheduled run's agent finishes its run without a permission
        // prompt, and with agents' schedule changes turned off it hears
        // nothing about schedule tools it can't see.
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "approval-required",
          roomTools: true,
          scheduledRunTools: true,
        });
        const runOptions = harness.getLastCreateQueryInput()!.options;
        assert.include(
          runOptions.allowedTools ?? [],
          "mcp__threadlines_room__scheduled_run_finish",
        );
        assert.notInclude(appendOf(runOptions), "<threadlines_schedules>");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("starts an independent review fresh, reading only the checkout, with no memory", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const session = yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        lockdown: "side-review",
        roomTools: true,
        // Offered a conversation anyway: a review never forks one.
        forkFrom: { providerThreadId: "0f0e0d0c-0b0a-4908-8706-050403020100" },
        runtimeMode: "full-access",
      });
      assert.equal(session.roomTools, true);
      const options = harness.getLastCreateQueryInput()!.options;
      assert.equal(options.resume, undefined);
      assert.equal(options.forkSession, undefined);
      assert.deepEqual(Object.keys(options.mcpServers ?? {}), ["threadlines_room"]);
      assert.equal(options.strictMcpConfig, true);
      assert.deepEqual(options.allowedTools, ["mcp__threadlines_room__room_diff"]);
      assert.equal(options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
      assert.equal((options.settings as { autoMemoryEnabled?: boolean }).autoMemoryEnabled, false);

      const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
      const decide = async (toolName: string) => {
        const output = await hook!({ tool_name: toolName } as never, undefined, {
          signal: new AbortController().signal,
        });
        return (output as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput
          .permissionDecision;
      };
      assert.equal(
        yield* Effect.promise(() => decide("mcp__threadlines_room__room_diff")),
        "allow",
      );
      assert.equal(
        yield* Effect.promise(() => decide("mcp__threadlines_room__room_history")),
        "deny",
      );

      const room = options.mcpServers?.["threadlines_room"] as {
        readonly headers: Record<string, string>;
      };
      const scope = yield* mcpSessionRegistry.resolve(
        room.headers.Authorization!.replace("Bearer ", ""),
      );
      assert.equal(scope?.browser, false);
      assert.deepEqual([...(scope?.roomTools ?? [])], ["room_diff"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("preserves durable resume ids across Claude resume hooks", () => {
    const seeded = seedClaudeTranscript("550e8400-e29b-41d4-a716-446655440000");
    const harness = makeHarness({ environment: seeded.environment });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const durableSessionId = "550e8400-e29b-41d4-a716-446655440000";
      const transientHookSessionId = "7368d0c7-40a3-4d8a-bcc1-ac80c49f2719";

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        resumeCursor: {
          threadId: RESUME_THREAD_ID,
          resume: durableSessionId,
          resumeSessionAt: "assistant-99",
          turnCount: 3,
        },
        runtimeMode: "full-access",
      });

      harness.query.emit({
        type: "system",
        subtype: "hook_started",
        hook_id: "resume-hook-1",
        hook_name: "SessionStart:resume",
        hook_event: "SessionStart",
        session_id: transientHookSessionId,
        uuid: "resume-hook-started",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "hook_response",
        hook_id: "resume-hook-1",
        hook_name: "SessionStart:resume",
        hook_event: "SessionStart",
        output: "",
        stdout: "",
        stderr: "",
        outcome: "success",
        session_id: transientHookSessionId,
        uuid: "resume-hook-response",
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "system",
        subtype: "init",
        apiKeySource: "none",
        claude_code_version: "test",
        cwd: "/tmp/claude-adapter-test",
        tools: [],
        mcp_servers: [],
        model: "claude-sonnet-4-5",
        permissionMode: "bypassPermissions",
        slash_commands: [],
        output_style: "default",
        skills: [],
        plugins: [],
        session_id: durableSessionId,
        uuid: "resume-init",
      } as unknown as SDKMessage);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const threadStartedEvents = runtimeEvents.filter((event) => event.type === "thread.started");
      assert.equal(threadStartedEvents.length, 1);
      const threadStarted = threadStartedEvents[0];
      assert.equal(threadStarted?.type, "thread.started");
      if (threadStarted?.type === "thread.started") {
        assert.deepEqual(threadStarted.payload, {
          providerThreadId: durableSessionId,
        });
      }

      const activeSessions = yield* adapter.listSessions();
      const resumeCursor = activeSessions[0]?.resumeCursor as
        | {
            readonly resume?: string;
          }
        | undefined;
      assert.equal(resumeCursor?.resume, durableSessionId);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
      Effect.ensuring(Effect.sync(seeded.cleanup)),
    );
  });

  it.effect("uses an app-generated Claude session id for fresh sessions", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      const createInput = harness.getLastCreateQueryInput();
      const sessionResumeCursor = session.resumeCursor as {
        threadId?: string;
        resume?: string;
        turnCount?: number;
      };
      assert.equal(sessionResumeCursor.threadId, THREAD_ID);
      assert.equal(typeof sessionResumeCursor.resume, "string");
      assert.equal(sessionResumeCursor.turnCount, 0);
      assert.match(
        sessionResumeCursor.resume ?? "",
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      assert.equal(createInput?.options.resume, undefined);
      assert.equal(createInput?.options.sessionId, sessionResumeCursor.resume);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "supports rollbackThread by trimming in-memory turns and preserving earlier turns",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        const firstUserMessageId = MessageId.make("44444444-4444-4444-8444-444444444444");
        const secondUserMessageId = MessageId.make("55555555-5555-4555-8555-555555555555");
        const firstAssistantUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const secondAssistantUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

        const firstTurn = yield* adapter.sendTurn({
          threadId: session.threadId,
          messageId: firstUserMessageId,
          input: "first",
          attachments: [],
        });

        const firstCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        harness.query.emit({
          type: "assistant",
          session_id: "sdk-session-rollback",
          uuid: firstAssistantUuid,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "first answer" }],
          },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-rollback",
          uuid: "result-first",
        } as unknown as SDKMessage);

        const firstCompleted = yield* Fiber.join(firstCompletedFiber);
        assert.equal(firstCompleted._tag, "Some");
        if (firstCompleted._tag === "Some" && firstCompleted.value.type === "turn.completed") {
          assert.equal(String(firstCompleted.value.turnId), String(firstTurn.turnId));
        }

        const secondTurn = yield* adapter.sendTurn({
          threadId: session.threadId,
          messageId: secondUserMessageId,
          input: "second",
          attachments: [],
        });

        const secondCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        harness.query.emit({
          type: "assistant",
          session_id: "sdk-session-rollback",
          uuid: secondAssistantUuid,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "second answer" }],
          },
        } as unknown as SDKMessage);
        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: "sdk-session-rollback",
          uuid: "result-second",
        } as unknown as SDKMessage);

        const secondCompleted = yield* Fiber.join(secondCompletedFiber);
        assert.equal(secondCompleted._tag, "Some");
        if (secondCompleted._tag === "Some" && secondCompleted.value.type === "turn.completed") {
          assert.equal(String(secondCompleted.value.turnId), String(secondTurn.turnId));
        }

        const threadBeforeRollback = yield* adapter.readThread(session.threadId);
        assert.equal(threadBeforeRollback.turns.length, 2);

        const rolledBack = yield* adapter.rollbackThread(session.threadId, 1, {
          targetUserMessageId: secondUserMessageId,
        });
        assert.equal(rolledBack.turns.length, 1);
        assert.equal(rolledBack.turns[0]?.id, firstTurn.turnId);
        assert.deepEqual(harness.query.rewindFilesCalls, [
          {
            userMessageId: secondUserMessageId,
          },
        ]);

        const threadAfterRollback = yield* adapter.readThread(session.threadId);
        assert.equal(threadAfterRollback.turns.length, 1);
        assert.equal(threadAfterRollback.turns[0]?.id, firstTurn.turnId);
        const activeSessions = yield* adapter.listSessions();
        const activeSession = activeSessions[0];
        const resumeCursor = activeSession?.resumeCursor as
          | {
              readonly resumeSessionAt?: string;
              readonly turnCount?: number;
            }
          | undefined;
        assert.equal(resumeCursor?.resumeSessionAt, firstAssistantUuid);
        assert.equal(resumeCursor?.turnCount, 1);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("updates model on sendTurn for the adapter's bound custom instance id", () => {
    const customInstanceId = ProviderInstanceId.make("claude_openrouter");
    const harness = makeHarness({ instanceId: customInstanceId });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: {
          instanceId: customInstanceId,
          model: "openai/gpt-5.5",
        },
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["openai/gpt-5.5"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "does not re-set the Claude model when the session already uses the same effective API model",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const modelSelection = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        };

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          modelSelection,
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello",
          modelSelection,
          attachments: [],
        });
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "hello again",
          modelSelection,
          attachments: [],
        });

        assert.deepEqual(harness.query.setModelCalls, []);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("re-sets the Claude model when the effective API model changes", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "contextWindow", value: "1m" }],
        ),
        attachments: [],
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello again",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        attachments: [],
      });

      assert.deepEqual(harness.query.setModelCalls, ["claude-opus-4-6[1m]", "claude-opus-4-6"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("applies effort changes to the running query instead of requiring a restart", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-8",
          [{ id: "effort", value: "medium" }],
        ),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-8",
          [{ id: "effort", value: "ultracode" }],
        ),
        attachments: [],
      });

      assert.deepEqual(harness.query.applyFlagSettingsCalls, [
        {
          effortLevel: "xhigh",
          alwaysThinkingEnabled: null,
          fastMode: null,
          ultracode: true,
          workflowSizeGuideline: null,
        },
      ]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("does not call applyFlagSettings when session options are unchanged", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const modelSelection = createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "effort", value: "high" }],
      );

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        modelSelection,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        modelSelection,
        attachments: [],
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello again",
        modelSelection,
        attachments: [],
      });

      assert.deepEqual(harness.query.applyFlagSettingsCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  // The CLI reads plugins and skills only at launch, so a change made in Settings reached an open
  // chat only after a restart.
  it.effect(
    "reloads plugins and skills once, before the next turn after Settings changed them",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        const send = (input: string) =>
          adapter.sendTurn({ threadId: session.threadId, input, attachments: [] });

        yield* send("hello");
        yield* adapter.noteExtensionsChanged!();
        assert.deepEqual(harness.query.reloadCalls, []);

        yield* send("use the new skill");
        assert.deepEqual(harness.query.reloadCalls, ["plugins", "skills"]);

        yield* send("and again");
        assert.deepEqual(harness.query.reloadCalls, ["plugins", "skills"]);

        // A failed reload does not count as done: the next turn tries again.
        yield* adapter.noteExtensionsChanged!();
        harness.query.failNextPluginReload = true;
        yield* send("after a failed reload");
        yield* send("retry");
        yield* send("settled");
        assert.deepEqual(harness.query.reloadCalls, [
          "plugins",
          "skills",
          "plugins",
          "skills",
          "plugins",
          "skills",
        ]);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("sets plan permission mode on sendTurn when interactionMode is plan", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this for me",
        interactionMode: "plan",
        attachments: [],
      });

      assert.deepEqual(harness.query.setPermissionModeCalls, ["plan"]);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect.each<{ runtimeMode: RuntimeMode; expectedBase: PermissionMode }>([
    { runtimeMode: "full-access", expectedBase: "bypassPermissions" },
    { runtimeMode: "approval-required", expectedBase: "default" },
    { runtimeMode: "auto-accept-edits", expectedBase: "acceptEdits" },
  ])(
    "restores $expectedBase permission mode after plan turn ($runtimeMode)",
    ({ runtimeMode, expectedBase }) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode,
        });

        // First turn in plan mode
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "plan this",
          interactionMode: "plan",
          attachments: [],
        });

        // Complete the turn so we can send another
        const turnCompletedFiber = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runHead, Effect.forkChild);

        harness.query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          errors: [],
          session_id: `sdk-session-${runtimeMode}`,
          uuid: `result-${runtimeMode}`,
        } as unknown as SDKMessage);

        yield* Fiber.join(turnCompletedFiber);

        // Second turn back to default
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "now do it",
          interactionMode: "default",
          attachments: [],
        });

        assert.deepEqual(harness.query.setPermissionModeCalls, ["plan", expectedBase]);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect(
    "moves an Auto thread's permission mode with a switch to and from a model without Auto",
    () => {
      const harness = makeHarness({
        resolveModelMetadata: (model) =>
          Effect.succeed({
            capabilities: createModelCapabilities({ optionDescriptors: [] }),
            supportedRuntimeModes:
              model === "claude-haiku-4-5" ? LEGACY_RUNTIME_MODES : RUNTIME_MODES,
          }),
      });
      const instanceId = ProviderInstanceId.make("claudeAgent");
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          modelSelection: createModelSelection(instanceId, "claude-haiku-4-5"),
          runtimeMode: "auto",
        });
        assert.equal(harness.getLastCreateQueryInput()?.options.permissionMode, "acceptEdits");

        const turnCompleted = (id: string) =>
          Effect.gen(function* () {
            const fiber = yield* Stream.filter(
              adapter.streamEvents,
              (event) => event.type === "turn.completed",
            ).pipe(Stream.runHead, Effect.forkChild);
            harness.query.emit({
              type: "result",
              subtype: "success",
              is_error: false,
              errors: [],
              session_id: "sdk-session-model-switch",
              uuid: id,
            } as unknown as SDKMessage);
            yield* Fiber.join(fiber);
          });

        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "on a model with Auto",
          modelSelection: createModelSelection(instanceId, "claude-opus-6"),
          attachments: [],
        });
        yield* turnCompleted("result-opus");
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "back without Auto",
          modelSelection: createModelSelection(instanceId, "claude-haiku-4-5"),
          attachments: [],
        });

        assert.deepEqual(harness.query.setPermissionModeCalls, ["auto", "acceptEdits"]);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("does not call setPermissionMode when interactionMode is absent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      assert.deepEqual(harness.query.setPermissionModeCalls, []);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("captures ExitPlanMode as a proposed plan and denies auto-exit", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const permissionPromise = canUseTool(
        "ExitPlanMode",
        {
          plan: "# Ship it\n\n- one\n- two",
          allowedPrompts: [{ tool: "Bash", prompt: "run tests" }],
        },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-exit-1",
          requestId: "request-exit-1",
        },
      );

      const proposedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(proposedEvent._tag, "Some");
      if (proposedEvent._tag !== "Some") {
        return;
      }
      assert.equal(proposedEvent.value.type, "turn.proposed.completed");
      if (proposedEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(proposedEvent.value.payload.planMarkdown, "# Ship it\n\n- one\n- two");
      assert.deepEqual(proposedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-exit-1"),
      });

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "deny");
      const deniedResult = permissionResult as PermissionResult & {
        message?: string;
      };
      assert.equal(deniedResult.message?.includes("captured your proposed plan"), true);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("extracts proposed plans from assistant ExitPlanMode snapshots", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "plan this",
        interactionMode: "plan",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      const proposedEventFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.proposed.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "assistant",
        session_id: "sdk-session-exit-plan",
        uuid: "assistant-exit-plan",
        parent_tool_use_id: null,
        message: {
          model: "claude-opus-4-6",
          id: "msg-exit-plan",
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool-exit-2",
              name: "ExitPlanMode",
              input: {
                plan: "# Final plan\n\n- capture it",
              },
            },
          ],
          stop_reason: null,
          stop_sequence: null,
          usage: {},
        },
      } as unknown as SDKMessage);

      const proposedEvent = yield* Fiber.join(proposedEventFiber);
      assert.equal(proposedEvent._tag, "Some");
      if (proposedEvent._tag !== "Some") {
        return;
      }
      assert.equal(proposedEvent.value.type, "turn.proposed.completed");
      if (proposedEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(proposedEvent.value.payload.planMarkdown, "# Final plan\n\n- capture it");
      assert.deepEqual(proposedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-exit-2"),
      });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("handles AskUserQuestion via user-input.requested/resolved lifecycle", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // Start session in approval-required mode so canUseTool fires.
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      // Drain the session startup events (started, configured, state.changed).
      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "question turn",
        attachments: [],
      });
      yield* Stream.take(adapter.streamEvents, 1).pipe(Stream.runDrain);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-user-input-1",
        uuid: "stream-user-input-thread",
        parent_tool_use_id: null,
        event: {
          type: "message_start",
          message: {
            id: "msg-user-input-thread",
          },
        },
      } as unknown as SDKMessage);

      const threadStarted = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(threadStarted._tag, "Some");
      if (threadStarted._tag !== "Some") {
        return;
      }
      assert.equal(threadStarted.value.type, "thread.started");
      if (threadStarted.value.type !== "thread.started") {
        return;
      }

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      // Simulate Claude calling AskUserQuestion with structured questions.
      const askInput = {
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [
              { label: "React", description: "React.js" },
              { label: "Vue", description: "Vue.js" },
            ],
            multiSelect: false,
          },
        ],
      };

      const permissionPromise = canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        toolUseID: "tool-ask-1",
        requestId: "request-ask-1",
      });

      // The adapter should emit a user-input.requested event.
      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some") {
        return;
      }
      assert.equal(requestedEvent.value.type, "user-input.requested");
      if (requestedEvent.value.type !== "user-input.requested") {
        return;
      }
      const requestId = requestedEvent.value.requestId;
      assert.equal(typeof requestId, "string");
      assert.equal(requestedEvent.value.payload.questions.length, 1);
      assert.equal(requestedEvent.value.payload.questions[0]?.question, "Which framework?");
      // Regression for #2388: `id` must equal the full question text so the
      // UI's draft-answer key matches what the SDK looks up downstream.
      assert.equal(requestedEvent.value.payload.questions[0]?.id, "Which framework?");
      assert.deepEqual(requestedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-ask-1"),
      });

      // Respond with the user's answers.
      yield* adapter.respondToUserInput(session.threadId, ApprovalRequestId.make(requestId!), {
        "Which framework?": "React",
      });

      // The adapter should emit a user-input.resolved event.
      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolvedEvent._tag, "Some");
      if (resolvedEvent._tag !== "Some") {
        return;
      }
      assert.equal(resolvedEvent.value.type, "user-input.resolved");
      if (resolvedEvent.value.type !== "user-input.resolved") {
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {
        "Which framework?": "React",
      });
      assert.deepEqual(resolvedEvent.value.providerRefs, {
        providerItemId: ProviderItemId.make("tool-ask-1"),
      });

      // The canUseTool promise should resolve with the answers in SDK format.
      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
      const updatedInput = (permissionResult as { updatedInput: Record<string, unknown> })
        .updatedInput;
      assert.deepEqual(updatedInput.answers, { "Which framework?": "React" });
      // Original questions should be passed through.
      assert.deepEqual(updatedInput.questions, askInput.questions);

      // Compatibility check for #2388: the answers shape we hand to the SDK
      // must produce a non-empty rendered tool_result on BOTH SDK iteration
      // patterns we have seen, so we don't regress the issue and we don't
      // break users still on the older Claude CLI.
      const sdkAnswers = updatedInput.answers as Record<string, unknown>;
      const sdkQuestions = updatedInput.questions as ReadonlyArray<{
        readonly question: string;
      }>;

      // Claude CLI 2.1.119 — key-agnostic Object.entries iteration. Any key
      // works here, but it must at least round-trip into a non-empty string.
      const v119Rendered = Object.entries(sdkAnswers)
        .map(([key, value]) => `"${key}"="${String(value)}"`)
        .join(", ");
      assert.equal(v119Rendered, '"Which framework?"="React"');

      // Claude CLI 2.1.121 — lookup by full question text. This is the path
      // that regressed in #2388 when the answers were keyed by `header`.
      const v121Rendered = sdkQuestions
        .map(({ question }) => {
          const answer = sdkAnswers[question];
          return answer === undefined ? null : `"${question}"="${String(answer)}"`;
        })
        .filter((entry): entry is string => entry !== null)
        .join(", ");
      assert.notEqual(v121Rendered, "", "Expected non-empty SDK 2.1.121 tool_result (#2388)");
      assert.equal(v121Rendered, '"Which framework?"="React"');
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("routes AskUserQuestion through user-input flow even in full-access mode", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      // In full-access mode, regular tools are auto-approved.
      // AskUserQuestion should still go through the user-input flow.
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const askInput = {
        questions: [
          {
            question: "Deploy to which env?",
            header: "Env",
            options: [
              { label: "Staging", description: "Staging environment" },
              { label: "Production", description: "Production environment" },
            ],
            multiSelect: false,
          },
        ],
      };

      const permissionPromise = canUseTool("AskUserQuestion", askInput, {
        signal: new AbortController().signal,
        toolUseID: "tool-ask-2",
        requestId: "request-ask-2",
      });

      // Should still get user-input.requested even in full-access mode.
      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      const requestId = requestedEvent.value.requestId;

      yield* adapter.respondToUserInput(session.threadId, ApprovalRequestId.make(requestId!), {
        "Deploy to which env?": "Staging",
      });

      // Drain the resolved event.
      yield* Stream.runHead(adapter.streamEvents);

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.equal((permissionResult as PermissionResult).behavior, "allow");
      const updatedInput = (permissionResult as { updatedInput: Record<string, unknown> })
        .updatedInput;
      assert.deepEqual(updatedInput.answers, { "Deploy to which env?": "Staging" });
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("denies AskUserQuestion when the waiting turn is aborted", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "approval-required",
      });

      yield* Stream.take(adapter.streamEvents, 3).pipe(Stream.runDrain);

      const createInput = harness.getLastCreateQueryInput();
      const canUseTool = createInput?.options.canUseTool;
      assert.equal(typeof canUseTool, "function");
      if (!canUseTool) {
        return;
      }

      const controller = new AbortController();
      const permissionPromise = canUseTool(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Continue?",
              header: "Continue",
              options: [{ label: "Yes", description: "Proceed" }],
              multiSelect: false,
            },
          ],
        },
        {
          signal: controller.signal,
          toolUseID: "tool-ask-abort",
          requestId: "request-ask-abort",
        },
      );

      const requestedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(requestedEvent._tag, "Some");
      if (requestedEvent._tag !== "Some" || requestedEvent.value.type !== "user-input.requested") {
        assert.fail("Expected user-input.requested event");
        return;
      }
      assert.equal(requestedEvent.value.threadId, session.threadId);

      controller.abort();

      const resolvedEvent = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolvedEvent._tag, "Some");
      if (resolvedEvent._tag !== "Some" || resolvedEvent.value.type !== "user-input.resolved") {
        assert.fail("Expected user-input.resolved event");
        return;
      }
      assert.deepEqual(resolvedEvent.value.payload.answers, {});

      const permissionResult = yield* Effect.promise(() => permissionPromise);
      assert.deepEqual(permissionResult, {
        behavior: "deny",
        message: "User cancelled tool execution.",
      } satisfies PermissionResult);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("writes provider-native observability records when enabled", () => {
    const nativeEvents: Array<{
      event?: {
        provider?: string;
        method?: string;
        threadId?: string;
        turnId?: string;
      };
    }> = [];
    const nativeThreadIds: Array<string | null> = [];
    const fragmentMethods: Array<string | undefined> = [];
    const harness = makeHarness({
      nativeEventLogger: {
        filePath: "memory://claude-native-events",
        write: (event, threadId, options) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          nativeThreadIds.push(threadId ?? null);
          if (options?.streamFragment === true) {
            fragmentMethods.push((event as (typeof nativeEvents)[number]).event?.method);
          }
          return Effect.void;
        },
        close: () => Effect.void,
      },
    });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const turnCompletedFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "turn.completed",
      ).pipe(Stream.runHead, Effect.forkChild);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-native-log",
        uuid: "stream-native-log-thinking",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: "hmm",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "stream_event",
        session_id: "sdk-session-native-log",
        uuid: "stream-native-log",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "text_delta",
            text: "hi",
          },
        },
      } as unknown as SDKMessage);

      harness.query.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        session_id: "sdk-session-native-log",
        uuid: "result-native-log",
      } as unknown as SDKMessage);

      const turnCompleted = yield* Fiber.join(turnCompletedFiber);
      assert.equal(turnCompleted._tag, "Some");

      assert.equal(nativeEvents.length > 0, true);
      assert.equal(
        nativeEvents.some((record) => record.event?.provider === "claudeAgent"),
        true,
      );
      assert.equal(
        nativeEvents.some(
          (record) =>
            String(
              (record.event as { readonly providerThreadId?: string } | undefined)
                ?.providerThreadId,
            ) === "sdk-session-native-log",
        ),
        true,
      );
      assert.equal(
        nativeEvents.some((record) => String(record.event?.turnId) === String(turn.turnId)),
        true,
      );
      assert.equal(
        nativeEvents.some(
          (record) => record.event?.method === "claude/stream_event/content_block_delta/text_delta",
        ),
        true,
      );
      // The thinking piece is offered as a stream fragment, which the shared
      // logger leaves out by default. Reply text is not: a reply cut off before
      // its assistant message would have no other copy in the log.
      assert.deepEqual(fragmentMethods, ["claude/stream_event/content_block_delta/thinking_delta"]);
      assert.equal(
        nativeThreadIds.every((threadId) => threadId === String(THREAD_ID)),
        true,
      );
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });
});

/**
 * A Claude thread that shells out to `codex exec` in the background is running
 * a second agent, and the panel should say so. These cover the promotion arc:
 * the row appears on the task edge, gains the rollout's identity and settings
 * once codex has written them, and settles with the task.
 */
describe("ClaudeAdapterLive codex exec promotion", () => {
  const CODEX_SESSION_ID = "019fea48-4154-7982-876b-43e4c551eb65";

  function makeCodexHome(): { readonly codexHome: string; readonly cleanup: () => void } {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "claude-adapter-codex-home-"));
    return { codexHome, cleanup: () => rmSync(codexHome, { recursive: true, force: true }) };
  }

  function seedRollout(codexHome: string, cwd: string): void {
    const now = new Date();
    const directory = path.join(
      codexHome,
      "sessions",
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, `rollout-now-${CODEX_SESSION_ID}.jsonl`),
      [
        JSON.stringify({
          // A just-started run's recorded start time; the correlation gate
          // rejects rollouts that began before the task did.
          timestamp: now.toISOString(),
          type: "session_meta",
          payload: {
            session_id: CODEX_SESSION_ID,
            cwd,
            originator: "codex_exec",
            source: "exec",
          },
        }),
        JSON.stringify({
          type: "turn_context",
          payload: { model: "gpt-5.6-sol", effort: "medium" },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "task_complete", last_agent_message: "Reviewed the adapter." },
        }),
        "",
      ].join("\n"),
    );
  }

  function emitBashToolUse(
    harness: ReturnType<typeof makeHarness>,
    input: { readonly toolUseId: string; readonly command: string },
  ): void {
    harness.query.emit({
      type: "stream_event",
      session_id: "sdk-session-codex-exec",
      uuid: `${input.toolUseId}-start`,
      parent_tool_use_id: null,
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: input.toolUseId,
          name: "Bash",
          input: { command: input.command, run_in_background: true },
        },
      },
    } as unknown as SDKMessage);
  }

  function emitMarkerTask(harness: ReturnType<typeof makeHarness>): void {
    harness.query.emit({
      type: "system",
      subtype: "task_started",
      task_id: "task-marker",
      description: "Marker task",
      session_id: "sdk-session-codex-exec",
      uuid: "task-marker-started",
    } as unknown as SDKMessage);
  }

  const subagentMetadata = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
    events.flatMap((event) => (event.type === "subagent.metadata.updated" ? [event.payload] : []));

  const collectUntilMarker = (adapter: ClaudeAdapterShape) =>
    adapter.streamEvents.pipe(
      Stream.takeUntil(
        (event) => event.type === "task.started" && event.payload.taskId === "task-marker",
      ),
      Stream.runCollect,
      Effect.forkChild,
    );

  function makeCodexExecHarness(): {
    readonly harness: ReturnType<typeof makeHarness>;
    readonly codexHome: string;
    readonly cwd: string;
    readonly cleanup: () => void;
  } {
    const { codexHome, cleanup } = makeCodexHome();
    const cwd = mkdtempSync(path.join(os.tmpdir(), "claude-adapter-codex-cwd-"));
    return {
      harness: makeHarness({
        cwd,
        environment: { ...missingClaudeConfigEnvironment(), CODEX_HOME: codexHome },
      }),
      codexHome,
      cwd,
      cleanup: () => {
        cleanup();
        rmSync(cwd, { recursive: true, force: true });
      },
    };
  }

  it.effect("promotes a background codex exec run and settles it with the task", () => {
    const fixture = makeCodexExecHarness();
    seedRollout(fixture.codexHome, fixture.cwd);
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* collectUntilMarker(adapter);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });

      emitBashToolUse(fixture.harness, {
        toolUseId: "tool-codex-exec",
        command: `codex exec -m gpt-5.6-sol "Review the adapter"`,
      });
      // The task list reaches the adapter before the edge that identifies
      // the run as codex.
      fixture.harness.query.emit({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          {
            task_id: "task-codex-exec",
            task_type: "local_bash",
            description: "Review the adapter",
          },
        ],
        session_id: "sdk-session-codex-exec",
        uuid: "task-codex-exec-listed",
      } as unknown as SDKMessage);
      fixture.harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-codex-exec",
        description: "Review the adapter",
        task_type: "local_bash",
        tool_use_id: "tool-codex-exec",
        session_id: "sdk-session-codex-exec",
        uuid: "task-codex-exec-started",
      } as unknown as SDKMessage);
      fixture.harness.query.emit({
        type: "system",
        subtype: "task_notification",
        task_id: "task-codex-exec",
        tool_use_id: "tool-codex-exec",
        status: "completed",
        summary: "codex exec finished",
        session_id: "sdk-session-codex-exec",
        uuid: "task-codex-exec-completed",
      } as unknown as SDKMessage);
      emitMarkerTask(fixture.harness);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      // Listed as a command, then relisted as the agent it turned out to be,
      // so the thread reads as waiting on an agent.
      assert.deepEqual(
        runtimeEvents.flatMap((event) =>
          event.type === "task.snapshot.updated"
            ? [event.payload.tasks.map((task) => task.kind)]
            : [],
        ),
        [["command"], ["agent"]],
      );
      const metadata = subagentMetadata(runtimeEvents);
      // Row first, identity second, settlement last. Claude reports the row;
      // Codex is named as the provider running it.
      assert.deepEqual(metadata[0], {
        callId: "tool-codex-exec",
        status: "running",
        agentRole: "codex",
        agentProvider: ProviderDriverKind.make("codex"),
        objective: "Review the adapter",
        model: "gpt-5.6-sol",
        modelSource: "explicit",
      });
      assert.deepEqual(metadata[1], {
        callId: "tool-codex-exec",
        agentThreadId: `codex-exec:${CODEX_SESSION_ID}`,
        transcriptAgentId: `codex-exec:${CODEX_SESSION_ID}`,
        agentProvider: ProviderDriverKind.make("codex"),
        status: "running",
        model: "gpt-5.6-sol",
        resolvedModel: "gpt-5.6-sol",
        modelSource: "provider",
        reasoningEffort: "medium",
        reasoningEffortSource: "provider",
      });
      assert.equal(metadata.length, 3);
      assert.equal(metadata[2]?.callId, "tool-codex-exec");
      assert.equal(metadata[2]?.status, "completed");
      assert.equal(metadata[2]?.resultBody, "Reviewed the adapter.");

      // The rollout the row was linked to also serves its transcript.
      const transcript = yield* adapter.readSubagentTranscript!(THREAD_ID, {
        threadId: THREAD_ID,
        agentId: `codex-exec:${CODEX_SESSION_ID}`,
      });
      assert.equal(transcript.agent?.model, "gpt-5.6-sol");
      assert.equal(transcript.agent?.agentType, "codex");
    }).pipe(Effect.provide(fixture.harness.layer), Effect.ensuring(Effect.sync(fixture.cleanup)));
  });

  it.effect(
    "waits on a codex exec run even when the user moved on before it was recognized",
    () => {
      const fixture = makeCodexExecHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkChild,
        );
        /** What the next published task list says each task is, and whether it is awaited. */
        const nextSnapshot = Effect.gen(function* () {
          for (;;) {
            const event = yield* Queue.take(events);
            if (event.type === "task.snapshot.updated") {
              return event.payload.tasks.map((task) => `${task.kind}:${task.awaited !== false}`);
            }
          }
        });

        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          cwd: fixture.cwd,
          runtimeMode: "full-access",
        });
        emitBashToolUse(fixture.harness, {
          toolUseId: "tool-codex-exec",
          command: `codex exec "Review the adapter"`,
        });
        fixture.harness.query.emit({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [
            {
              task_id: "task-codex-exec",
              task_type: "local_bash",
              description: "Review the adapter",
            },
          ],
          session_id: "sdk-session-codex-exec",
          uuid: "task-codex-exec-listed",
        } as unknown as SDKMessage);
        assert.deepEqual(yield* nextSnapshot, ["command:true"]);

        // The user moves on while the run still looks like a plain command.
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "next", attachments: [] });
        assert.deepEqual(yield* nextSnapshot, ["command:false"]);

        // Recognized as codex: an agent, and agents are always awaited.
        fixture.harness.query.emit({
          type: "system",
          subtype: "task_started",
          task_id: "task-codex-exec",
          description: "Review the adapter",
          task_type: "local_bash",
          tool_use_id: "tool-codex-exec",
          session_id: "sdk-session-codex-exec",
          uuid: "task-codex-exec-started",
        } as unknown as SDKMessage);
        assert.deepEqual(yield* nextSnapshot, ["agent:true"]);
      }).pipe(Effect.provide(fixture.harness.layer), Effect.ensuring(Effect.sync(fixture.cleanup)));
    },
  );

  it.effect("leaves ordinary background commands alone", () => {
    const fixture = makeCodexExecHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* collectUntilMarker(adapter);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });

      emitBashToolUse(fixture.harness, {
        toolUseId: "tool-dev-server",
        command: `echo "codex exec go" && pnpm dev`,
      });
      fixture.harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-dev-server",
        description: "Run the dev server",
        task_type: "local_bash",
        tool_use_id: "tool-dev-server",
        session_id: "sdk-session-codex-exec",
        uuid: "task-dev-server-started",
      } as unknown as SDKMessage);
      emitMarkerTask(fixture.harness);

      assert.deepEqual(subagentMetadata(Array.from(yield* Fiber.join(runtimeEventsFiber))), []);
    }).pipe(Effect.provide(fixture.harness.layer), Effect.ensuring(Effect.sync(fixture.cleanup)));
  });

  it.effect("settles a promoted row even when no rollout is ever found", () => {
    const fixture = makeCodexExecHarness();
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const runtimeEventsFiber = yield* collectUntilMarker(adapter);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        cwd: fixture.cwd,
        runtimeMode: "full-access",
      });

      emitBashToolUse(fixture.harness, {
        toolUseId: "tool-codex-exec",
        command: `codex exec "Review the adapter"`,
      });
      fixture.harness.query.emit({
        type: "system",
        subtype: "task_started",
        task_id: "task-codex-exec",
        description: "Review the adapter",
        task_type: "local_bash",
        tool_use_id: "tool-codex-exec",
        session_id: "sdk-session-codex-exec",
        uuid: "task-codex-exec-started",
      } as unknown as SDKMessage);
      fixture.harness.query.emit({
        type: "system",
        subtype: "task_updated",
        task_id: "task-codex-exec",
        patch: { status: "failed", error: "codex exited 1" },
        session_id: "sdk-session-codex-exec",
        uuid: "task-codex-exec-failed",
      } as unknown as SDKMessage);
      emitMarkerTask(fixture.harness);

      const metadata = subagentMetadata(Array.from(yield* Fiber.join(runtimeEventsFiber)));
      assert.equal(metadata.length, 2);
      assert.deepEqual(metadata[1], { callId: "tool-codex-exec", status: "failed" });
    }).pipe(Effect.provide(fixture.harness.layer), Effect.ensuring(Effect.sync(fixture.cleanup)));
  });
});

describe("ClaudeAdapterLive goals", () => {
  /** The CLI's answer to `/goal <args>`, as Claude Code 2.1.301 sends it. */
  const goalReply = (args: string, text: string) =>
    ({
      type: "assistant",
      message: {
        id: `goal-reply-${args}`,
        model: "<synthetic>",
        role: "assistant",
        content: [{ type: "text", text }],
      },
      parent_tool_use_id: null,
      local_command_run: { command: "goal", args },
      session_id: "sdk-session-goal",
      uuid: `goal-reply-${args}-${text.length}`,
    }) as unknown as SDKMessage;
  /** The zero-turn result a `/goal` answer that started no work ends with. */
  const goalResult = (uuid: string) =>
    ({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 0,
      result: "",
      local_command: "goal",
      errors: [],
      session_id: "sdk-session-goal",
      uuid,
    }) as unknown as SDKMessage;
  const turnResult = (uuid: string, sessionId = "sdk-session-goal") =>
    ({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 2,
      result: "",
      stop_reason: null,
      errors: [],
      session_id: sessionId,
      uuid,
    }) as unknown as SDKMessage;
  const goalRecord = (attachment: Record<string, unknown>, timestamp: string) =>
    JSON.stringify({
      type: "attachment",
      timestamp,
      attachment: { type: "goal_status", ...attachment },
    });

  /** Start a session, collecting every runtime event it emits. */
  const startGoalSession = (harness: ReturnType<typeof makeHarness>) =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const events: Array<ProviderRuntimeEvent> = [];
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      /** Wait until the stream has handled everything emitted so far. */
      const settle = (marker: string) =>
        Effect.gen(function* () {
          harness.query.emit({
            ...claudeInitMessage("2.1.301"),
            uuid: marker,
          } as unknown as SDKMessage);
          while (
            !events.some(
              (event) =>
                event.type === "session.configured" &&
                (event.raw?.payload as { readonly uuid?: string } | undefined)?.uuid === marker,
            )
          ) {
            yield* Effect.yieldNow;
          }
        });
      yield* settle("init-start");
      return { adapter, events, settle };
    });

  it.effect(
    "sets a goal once Claude confirms it, and lets that answer open the goal's turn",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const { adapter, events, settle } = yield* startGoalSession(harness);
        const setting = yield* adapter.setThreadGoal!({
          threadId: THREAD_ID,
          objective: "Tests pass",
          origin: "user",
        }).pipe(Effect.forkChild);
        const [sent] = yield* Effect.promise(() =>
          readPromptMessages(harness.getLastCreateQueryInput(), 1),
        );
        assert.deepEqual(promptMessageShape(sent), {
          origin: { kind: "human" },
          shouldQuery: undefined,
          text: "/goal Tests pass",
        });
        // Nothing was running, so nothing needs to be cut short.
        assert.equal((sent as { readonly priority?: string } | undefined)?.priority, undefined);

        harness.query.emit(goalReply("Tests pass", "Goal set: Tests pass"));
        const goal = yield* Fiber.join(setting);
        assert.equal(goal.objective, "Tests pass");
        assert.equal(goal.status, "active");
        assert.equal(goal.checks, 0);
        yield* settle("init-after-set");
        assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  // As Claude Code 2.1.301 answers it: the running turn's result comes first,
  // then the clear's own answer and its zero-turn result.
  it.effect(
    "clears mid-turn with send-now, keeps the cut turn's result, and hides the answer",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const { adapter, events, settle } = yield* startGoalSession(harness);
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Keep going", attachments: [] });
        const clearing = yield* adapter.clearThreadGoal!(THREAD_ID).pipe(Effect.forkChild);
        const sent = yield* Effect.promise(() =>
          readPromptMessages(harness.getLastCreateQueryInput(), 2),
        );
        assert.equal(promptMessageShape(sent[1]).text, "/goal clear");
        assert.equal((sent[1] as { readonly priority?: string } | undefined)?.priority, "now");

        harness.query.emit(turnResult("result-cut-turn"));
        harness.query.emit({
          ...claudeInitMessage("2.1.301"),
          uuid: "init-clear",
        } as unknown as SDKMessage);
        harness.query.emit(goalReply("clear", "Goal cleared: Tests pass"));
        harness.query.emit(goalResult("result-clear"));
        yield* Fiber.join(clearing);
        yield* settle("init-after-clear");

        assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
        assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
        assert.isFalse(
          events.some((event) => JSON.stringify(event.payload ?? {}).includes("Goal cleared")),
        );
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("fails with Claude's reason when it will not set the goal, and starts no turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { adapter, events, settle } = yield* startGoalSession(harness);
      const setting = yield* adapter.setThreadGoal!({
        threadId: THREAD_ID,
        objective: "Tests pass",
        origin: "user",
      }).pipe(Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => readPromptMessages(harness.getLastCreateQueryInput(), 1));
      harness.query.emit(goalReply("Tests pass", "Goals need hooks, which policy turned off."));
      harness.query.emit(goalResult("result-refused"));
      const refusal = yield* Fiber.join(setting);
      assert.include(refusal.message, "policy turned off");
      yield* settle("init-after-refusal");
      assert.equal(events.filter((event) => event.type === "turn.started").length, 0);
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 0);

      // Claude reads these words as "clear the goal".
      const refusedLocally = yield* adapter.setThreadGoal!({
        threadId: THREAD_ID,
        objective: "stop",
        origin: "user",
      }).pipe(Effect.flip);
      assert.include(refusedLocally.message, "clearing the goal");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect("keeps an answer that comes after the wait ran out from ending the next turn", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { adapter, events, settle } = yield* startGoalSession(harness);
      const setting = yield* adapter.setThreadGoal!({
        threadId: THREAD_ID,
        objective: "Tests pass",
        origin: "user",
      }).pipe(Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => readPromptMessages(harness.getLastCreateQueryInput(), 1));
      yield* TestClock.adjust("31 seconds");
      assert.include((yield* Fiber.join(setting)).message, "did not answer");

      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "Next", attachments: [] });
      harness.query.emit(goalReply("Tests pass", "Goals need hooks, which policy turned off."));
      harness.query.emit(goalResult("result-late-refusal"));
      yield* settle("init-after-late-answer");
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 0);
      assert.isFalse(
        events.some((event) => JSON.stringify(event.payload ?? {}).includes("policy turned off")),
      );

      harness.query.emit(turnResult("result-next-turn"));
      yield* settle("init-after-next-turn");
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "disarms a side answer's inherited goal ahead of its question, and keeps quiet about it",
    () => {
      const sessionId = "0f0e0d0c-0b0a-4908-8706-050403020100";
      const seeded = seedClaudeTranscript(
        sessionId,
        `${goalRecord({ met: false, sentinel: true, condition: "Tests pass" }, "2026-10-18T07:00:00.000Z")}\n`,
      );
      const harness = makeHarness({ environment: seeded.environment });
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const events: Array<ProviderRuntimeEvent> = [];
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ).pipe(Effect.forkChild);
        yield* adapter.startSession({
          threadId: RESUME_THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          cwd: process.cwd(),
          lockdown: "side-answer",
          forkFrom: { providerThreadId: sessionId },
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId: RESUME_THREAD_ID,
          input: "What changed?",
          attachments: [],
        });
        const sent = yield* Effect.promise(() =>
          readPromptMessages(harness.getLastCreateQueryInput(), 2),
        );
        assert.deepEqual(
          sent.map((message) => promptMessageShape(message).text),
          ["/goal clear", "What changed?"],
        );

        harness.query.emit(goalReply("clear", "Goal cleared: Tests pass"));
        harness.query.emit(goalResult("result-side-clear"));
        harness.query.emit(turnResult("result-side-question"));
        harness.query.emit({
          ...claudeInitMessage("2.1.301"),
          uuid: "init-side-end",
        } as unknown as SDKMessage);
        while (
          !events.some(
            (event) =>
              event.type === "session.configured" &&
              (event.raw?.payload as { readonly uuid?: string } | undefined)?.uuid ===
                "init-side-end",
          )
        ) {
          yield* Effect.yieldNow;
        }
        assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
        assert.isFalse(events.some((event) => event.type.startsWith("goal.")));
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
        Effect.ensuring(Effect.sync(seeded.cleanup)),
      );
    },
  );

  it.effect("reports a clear Claude answered after the wait ran out", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { adapter, events, settle } = yield* startGoalSession(harness);
      const setting = yield* adapter.setThreadGoal!({
        threadId: THREAD_ID,
        objective: "Tests pass",
        origin: "user",
      }).pipe(Effect.forkChild);
      yield* Effect.promise(() => readPromptMessages(harness.getLastCreateQueryInput(), 1));
      harness.query.emit(goalReply("Tests pass", "Goal set: Tests pass"));
      yield* Fiber.join(setting);
      harness.query.emit(turnResult("result-goal-turn"));

      const clearing = yield* adapter.clearThreadGoal!(THREAD_ID).pipe(
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust("31 seconds");
      assert.include((yield* Fiber.join(clearing)).message, "did not answer");
      harness.query.emit(goalReply("clear", "Goal cleared: Tests pass"));
      harness.query.emit(goalResult("result-late-clear"));
      yield* settle("init-after-late-clear");
      assert.equal(events.filter((event) => event.type === "goal.cleared").length, 1);
      assert.isNull(yield* adapter.getThreadGoal!(THREAD_ID));
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "asks for a newer Claude Code instead of sending /goal to one that can't tag its answer",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const configured = yield* Stream.filter(
          adapter.streamEvents,
          (event) => event.type === "session.configured",
        ).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        harness.query.emit(claudeInitMessage("2.1.290"));
        yield* Fiber.join(configured);
        const refusal = yield* adapter.setThreadGoal!({
          threadId: THREAD_ID,
          objective: "Tests pass",
          origin: "user",
        }).pipe(Effect.flip);
        assert.include(refusal.message, "2.1.296 or later");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
      );
    },
  );

  it.effect("restores a goal on resume and reads its verdict when the turn ends", () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const seeded = seedClaudeTranscript(
      sessionId,
      `${goalRecord({ met: false, sentinel: true, condition: "Tests pass" }, "2026-10-18T07:00:00.000Z")}\n`,
    );
    const transcriptPath = path.join(
      seeded.environment.CLAUDE_CONFIG_DIR ?? "",
      "projects",
      claudeProjectDirectoryName(process.cwd()),
      `${sessionId}.jsonl`,
    );
    const harness = makeHarness({ environment: seeded.environment });
    return Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const goalsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "goal.updated",
      ).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      yield* adapter.startSession({
        threadId: RESUME_THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        cwd: process.cwd(),
        resumeCursor: { threadId: "resume-thread-1", resume: sessionId },
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: RESUME_THREAD_ID, input: "Go on", attachments: [] });
      appendFileSync(
        transcriptPath,
        `${goalRecord(
          {
            met: true,
            condition: "Tests pass",
            reason: "The suite exits 0.",
            iterations: 2,
            durationMs: 90_000,
            tokens: 4_000,
          },
          "2026-10-18T07:01:30.000Z",
        )}\n`,
      );
      harness.query.emit(turnResult("result-goal-turn", sessionId));

      const [restored, finished] = Array.from(yield* Fiber.join(goalsFiber));
      assert.equal(restored?.type, "goal.updated");
      assert.equal(finished?.type, "goal.updated");
      if (restored?.type === "goal.updated" && finished?.type === "goal.updated") {
        assert.equal(restored.payload.goal.status, "active");
        assert.equal(restored.payload.goal.createdAt, "2026-10-18T07:00:00.000Z");
        assert.deepEqual(
          {
            status: finished.payload.goal.status,
            checks: finished.payload.goal.checks,
            lastCheck: finished.payload.goal.lastCheck,
            tokensUsed: finished.payload.goal.tokensUsed,
            timeUsedSeconds: finished.payload.goal.timeUsedSeconds,
          },
          {
            status: "complete",
            checks: 2,
            lastCheck: "The suite exits 0.",
            tokensUsed: 4_000,
            timeUsedSeconds: 90,
          },
        );
      }
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
      Effect.ensuring(Effect.sync(seeded.cleanup)),
    );
  });
});

describe("ClaudeAdapterLive MCP elicitation", () => {
  /** A form request as Claude Code 2.1.301 hands it to `onElicitation`. */
  const formRequest = {
    serverName: "elicit",
    message: "Who should the report be addressed to?",
    mode: "form" as const,
    requestedSchema: {
      type: "object",
      properties: {
        name: { type: "string", title: "Name", minLength: 2 },
        teamSize: { type: "integer", title: "Team size", minimum: 1, maximum: 50 },
        tier: { type: "string", title: "Tier", enum: ["free", "pro"], enumNames: ["Free", "Pro"] },
      },
      required: ["name"],
    },
  };

  const startElicitationSession = (harness: ReturnType<typeof makeHarness>) =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const events: Array<ProviderRuntimeEvent> = [];
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: ProviderDriverKind.make("claudeAgent"),
        runtimeMode: "full-access",
      });
      const onElicitation = harness.getLastCreateQueryInput()?.options.onElicitation;
      assert.isDefined(onElicitation);
      /** Wait until an event of `type` has been emitted. */
      const nextEvent = <T extends ProviderRuntimeEvent["type"]>(type: T) =>
        Effect.gen(function* () {
          while (!events.some((event) => event.type === type)) {
            yield* Effect.yieldNow;
          }
          return events.find((event) => event.type === type) as Extract<
            ProviderRuntimeEvent,
            { type: T }
          >;
        });
      return { adapter, events, onElicitation: onElicitation!, nextEvent };
    });

  it.effect("shows a tool server's form and answers it once the user's input fits", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { adapter, onElicitation, nextEvent } = yield* startElicitationSession(harness);
      const controller = new AbortController();
      const answered = onElicitation(formRequest, {
        signal: controller.signal,
        requestId: "elicit-1",
      });
      const requested = yield* nextEvent("user-input.requested");
      assert.deepEqual(requested.payload.elicitation, {
        mode: "form",
        serverName: "elicit",
        message: "Who should the report be addressed to?",
        fields: [
          { name: "name", title: "Name", type: "string", required: true, minLength: 2 },
          {
            name: "teamSize",
            title: "Team size",
            type: "integer",
            required: false,
            minimum: 1,
            maximum: 50,
          },
          {
            name: "tier",
            title: "Tier",
            type: "string",
            required: false,
            options: [
              { value: "free", label: "Free" },
              { value: "pro", label: "Pro" },
            ],
          },
        ],
      });

      // A name too short for the server stays open for the user to fix.
      const requestId = ApprovalRequestId.make(requested.requestId ?? "");
      const rejected = yield* adapter
        .respondToUserInput(THREAD_ID, requestId, { action: "accept", content: { name: "W" } })
        .pipe(Effect.flip);
      assert.include(rejected.message, "Name");
      yield* adapter.respondToUserInput(THREAD_ID, requestId, {
        action: "accept",
        content: { name: "Will", tier: "pro" },
      });
      assert.deepEqual(yield* Effect.promise(() => answered), {
        action: "accept",
        content: { name: "Will", tier: "pro" },
      });
      yield* nextEvent("user-input.resolved");
    }).pipe(
      Effect.provideService(Random.Random, makeDeterministicRandomService()),
      Effect.provide(harness.layer),
    );
  });

  it.effect(
    "cancels a prompt Claude gives up on, and one it can't show; a side answer never asks",
    () => {
      const harness = makeHarness();
      const sideHarness = makeHarness();
      return Effect.gen(function* () {
        const { events, onElicitation, nextEvent } = yield* startElicitationSession(harness);

        const controller = new AbortController();
        const answered = onElicitation(
          { ...formRequest, mode: "url", url: "https://example.com/oauth?state=abc" },
          { signal: controller.signal, requestId: "elicit-url" },
        );
        yield* nextEvent("user-input.requested");
        controller.abort();
        assert.deepEqual(yield* Effect.promise(() => answered), { action: "cancel" });
        yield* nextEvent("user-input.resolved");

        // Given up on before it was asked: never shown at all.
        const before = new AbortController();
        before.abort();
        assert.deepEqual(
          yield* Effect.promise(() =>
            onElicitation(formRequest, { signal: before.signal, requestId: "elicit-gone" }),
          ),
          { action: "cancel" },
        );
        assert.equal(events.filter((event) => event.type === "user-input.requested").length, 1);

        // A link that isn't a web URL can't be shown.
        assert.deepEqual(
          yield* Effect.promise(() =>
            onElicitation(
              { ...formRequest, mode: "url", url: "file:///etc/passwd" },
              { signal: new AbortController().signal, requestId: "elicit-file" },
            ),
          ),
          { action: "cancel" },
        );
        const warning = yield* nextEvent("runtime.warning");
        assert.include(warning.payload.message, "can't show");
      }).pipe(
        Effect.provideService(Random.Random, makeDeterministicRandomService()),
        Effect.provide(harness.layer),
        Effect.andThen(
          Effect.gen(function* () {
            const adapter = yield* ClaudeAdapter;
            yield* adapter.startSession({
              threadId: THREAD_ID,
              provider: ProviderDriverKind.make("claudeAgent"),
              runtimeMode: "full-access",
              lockdown: "side-answer",
            });
            // No handler: the SDK declines every request, and a side answer
            // never asks the user anything.
            assert.isUndefined(sideHarness.getLastCreateQueryInput()?.options.onElicitation);
          }).pipe(
            Effect.provideService(Random.Random, makeDeterministicRandomService()),
            Effect.provide(sideHarness.layer),
          ),
        ),
      );
    },
  );
});
