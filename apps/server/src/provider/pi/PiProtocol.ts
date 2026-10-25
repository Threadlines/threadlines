/**
 * The Pi RPC payloads the driver acts on, decoded at the wire boundary.
 *
 * Shapes follow Pi 1.3's `rpc-types.ts`, `json.md` and `message-types.md`,
 * checked against recorded traffic. Pi adds fields freely, and unknown
 * fields are ignored, so these schemas hold only what the adapter reads.
 *
 * @module provider/pi/PiProtocol
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Count = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

export const PiUsage = Schema.Struct({
  input: Schema.optional(Count),
  output: Schema.optional(Count),
  cacheRead: Schema.optional(Count),
  cacheWrite: Schema.optional(Count),
  reasoning: Schema.optional(Count),
  totalTokens: Schema.optional(Count),
  cost: Schema.optional(Schema.Struct({ total: Schema.optional(Schema.Number) })),
});
export type PiUsage = typeof PiUsage.Type;

export const PiTextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
export const PiThinkingBlock = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.optional(Schema.String),
});
export const PiToolCallBlock = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.optional(Schema.Unknown),
});

/** One message as Pi records it. `content` stays loose: its blocks vary by role. */
export const PiMessage = Schema.Struct({
  role: Schema.String,
  content: Schema.optional(Schema.Unknown),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  usage: Schema.optional(PiUsage),
  /** `pending`, `stop`, `length`, `toolUse`, `error`, `aborted`, `deferred`. */
  stopReason: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
  toolCallId: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  isError: Schema.optional(Schema.Boolean),
  timestamp: Schema.optional(Schema.Number),
});
export type PiMessage = typeof PiMessage.Type;

export const PiAssistantMessageEvent = Schema.Struct({
  /** `text_*`, `thinking_*`, `toolcall_*`, `start`, `done`, `error`. */
  type: Schema.String,
  contentIndex: Schema.optional(Schema.Number),
  delta: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
});

export const PiMessageEvent = Schema.Struct({
  type: Schema.Literals(["message_start", "message_end"]),
  message: PiMessage,
});
export type PiMessageEvent = typeof PiMessageEvent.Type;

export const PiMessageUpdate = Schema.Struct({
  type: Schema.Literal("message_update"),
  usage: Schema.optional(PiUsage),
  assistantMessageEvent: PiAssistantMessageEvent,
});
export type PiMessageUpdate = typeof PiMessageUpdate.Type;

export const PiToolResult = Schema.Struct({
  content: Schema.optional(Schema.Unknown),
  details: Schema.optional(Schema.Unknown),
  structuredContent: Schema.optional(Schema.Unknown),
});

export const PiToolExecution = Schema.Struct({
  type: Schema.Literals(["tool_execution_start", "tool_execution_update", "tool_execution_end"]),
  toolCallId: Schema.String,
  toolName: Schema.String,
  /** Set for calls another tool made (codemode); the id is `<parent>/<n>`. */
  parentToolCallId: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Unknown),
  partialResult: Schema.optional(PiToolResult),
  result: Schema.optional(PiToolResult),
  isError: Schema.optional(Schema.Boolean),
  durationMs: Schema.optional(Schema.Number),
});
export type PiToolExecution = typeof PiToolExecution.Type;

export const PiAgentSettled = Schema.Struct({
  type: Schema.Literal("agent_settled"),
  aborted: Schema.optional(Schema.Boolean),
});

export const PiQueueUpdate = Schema.Struct({
  type: Schema.Literal("queue_update"),
  steering: Schema.optional(Schema.Array(Schema.String)),
  followUp: Schema.optional(Schema.Array(Schema.String)),
});

export const PiCompactionStart = Schema.Struct({
  type: Schema.Literal("compaction_start"),
  reason: Schema.optional(Schema.String),
});

export const PiCompactionEnd = Schema.Struct({
  type: Schema.Literal("compaction_end"),
  reason: Schema.optional(Schema.String),
  aborted: Schema.optional(Schema.Boolean),
  willRetry: Schema.optional(Schema.Boolean),
  errorMessage: Schema.optional(Schema.String),
  result: Schema.optional(
    Schema.Struct({
      summary: Schema.optional(Schema.String),
      tokensBefore: Schema.optional(Count),
      estimatedTokensAfter: Schema.optional(Count),
    }),
  ),
});
export type PiCompactionEnd = typeof PiCompactionEnd.Type;

export const PiAutoRetryStart = Schema.Struct({
  type: Schema.Literal("auto_retry_start"),
  attempt: Schema.optional(Schema.Number),
  maxAttempts: Schema.optional(Schema.Number),
  delayMs: Schema.optional(Schema.Number),
  errorMessage: Schema.optional(Schema.String),
});

export const PiAutoRetryEnd = Schema.Struct({
  type: Schema.Literal("auto_retry_end"),
  success: Schema.optional(Schema.Boolean),
  attempt: Schema.optional(Schema.Number),
  finalError: Schema.optional(Schema.String),
});

/** A dialog or notice from an extension. Dialogs block until answered. */
export const PiExtensionUiRequest = Schema.Struct({
  type: Schema.Literal("extension_ui_request"),
  id: Schema.String,
  /** Dialogs: `select`, `confirm`, `input`, `editor`. Notices: `notify`, `setStatus`, … */
  method: Schema.String,
  title: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(Schema.String)),
  placeholder: Schema.optional(Schema.String),
  prefill: Schema.optional(Schema.String),
  /** Milliseconds; Pi resolves the dialog itself with its default when it runs out. */
  timeout: Schema.optional(Schema.Number),
  notifyType: Schema.optional(Schema.String),
});
export type PiExtensionUiRequest = typeof PiExtensionUiRequest.Type;

export const PI_DIALOG_METHODS: ReadonlySet<string> = new Set([
  "select",
  "confirm",
  "input",
  "editor",
]);

export const PiExtensionError = Schema.Struct({
  type: Schema.Literal("extension_error"),
  extensionPath: Schema.optional(Schema.String),
  event: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});

// ── Replies ──────────────────────────────────────────────────────────

export const PiModel = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  provider: Schema.String,
  api: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Boolean),
  input: Schema.optional(Schema.Array(Schema.String)),
  contextWindow: Schema.optional(Count),
  maxTokens: Schema.optional(Count),
  /** Pi thinking level → the provider's value, or null when unsupported. */
  thinkingLevelMap: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.Unknown))),
});
export type PiModel = typeof PiModel.Type;

export const PiState = Schema.Struct({
  model: Schema.optional(Schema.NullOr(PiModel)),
  thinkingLevel: Schema.optional(Schema.String),
  isStreaming: Schema.Boolean,
  isCompacting: Schema.optional(Schema.Boolean),
  sessionFile: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  sessionName: Schema.optional(Schema.String),
  messageCount: Schema.optional(Count),
  pendingMessageCount: Schema.optional(Count),
});
export type PiState = typeof PiState.Type;

export const PiAvailableModels = Schema.Struct({ models: Schema.Array(PiModel) });

export const PiThinkingLevels = Schema.Struct({ levels: Schema.Array(Schema.String) });

/** `prompt`, `steer` and `follow_up` acks. Pi before 0.99 sends no data. */
export const PiPromptAck = Schema.Struct({
  disposition: Schema.optional(Schema.Literals(["started", "queued", "handled"])),
});

/** One session entry. Only message entries carry `message`. */
export const PiSessionEntry = Schema.Struct({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  type: Schema.String,
  message: Schema.optional(PiMessage),
  /** Custom entries (Threadlines' turn markers among them). */
  customType: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
  /** Present on `usage` entries and summaries that record spending. */
  usage: Schema.optional(PiUsage),
  timestamp: Schema.optional(Schema.String),
});
export type PiSessionEntry = typeof PiSessionEntry.Type;

export const PiEntries = Schema.Struct({
  entries: Schema.Array(PiSessionEntry),
  leafId: Schema.NullOr(Schema.String),
});
export type PiEntries = typeof PiEntries.Type;

export const PiSessionStats = Schema.Struct({
  sessionFile: Schema.optional(Schema.String),
  tokens: Schema.optional(
    Schema.Struct({
      input: Schema.optional(Count),
      output: Schema.optional(Count),
      cacheRead: Schema.optional(Count),
      cacheWrite: Schema.optional(Count),
      total: Schema.optional(Count),
    }),
  ),
  cost: Schema.optional(Schema.Number),
  contextUsage: Schema.optional(
    Schema.Struct({
      tokens: Schema.NullOr(Count),
      contextWindow: Count,
      percent: Schema.NullOr(Schema.Number),
    }),
  ),
});
export type PiSessionStats = typeof PiSessionStats.Type;

export const PiForkResult = Schema.Struct({
  text: Schema.optional(Schema.String),
  cancelled: Schema.Boolean,
});

export const PiCloneResult = Schema.Struct({ cancelled: Schema.Boolean });

export const PiCommandInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  /** `extension`, `prompt` or `skill`. */
  source: Schema.String,
  sourceInfo: Schema.optional(
    Schema.Struct({
      path: Schema.optional(Schema.String),
      source: Schema.optional(Schema.String),
      scope: Schema.optional(Schema.String),
    }),
  ),
});
export type PiCommandInfo = typeof PiCommandInfo.Type;

export const PiCommands = Schema.Struct({ commands: Schema.Array(PiCommandInfo) });

export const PiCompactResult = Schema.Struct({
  summary: Schema.optional(Schema.String),
  tokensBefore: Schema.optional(Count),
  estimatedTokensAfter: Schema.optional(Count),
});

/** The output of `pi auth check --provider <p> --json`. */
export const PiAuthCheck = Schema.Struct({
  status: Schema.Literals(["ready", "not_ready", "invalid"]),
  provider: Schema.String,
  reason: Schema.optional(Schema.String),
  authType: Schema.optional(Schema.String),
});
export type PiAuthCheck = typeof PiAuthCheck.Type;

export const decodePi =
  <S extends Schema.Top>(schema: S) =>
  (value: unknown): Option.Option<S["Type"]> =>
    Schema.decodeUnknownOption(schema as never)(value) as Option.Option<S["Type"]>;

// ── Content ──────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The text of a message's content: a string, or its text blocks joined. */
export function piContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        isRecord(block) && block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("");
}

/**
 * Pi's names for its built-in providers (from pi-ai's provider list). A
 * provider an extension or `models.json` adds shows by its id.
 */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  "amazon-bedrock": "Amazon Bedrock",
  "ant-ling": "Ant Ling",
  anthropic: "Anthropic",
  azure: "Azure",
  baseten: "Baseten",
  cerebras: "Cerebras",
  "cloudflare-ai-gateway": "Cloudflare AI Gateway",
  "cloudflare-workers-ai": "Cloudflare Workers AI",
  deepseek: "DeepSeek",
  fireworks: "Fireworks",
  "github-copilot": "GitHub Copilot",
  google: "Google",
  "google-vertex": "Google Vertex AI",
  groq: "Groq",
  huggingface: "Hugging Face",
  "kimi-coding": "Kimi For Coding",
  meta: "Meta",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax CN",
  mistral: "Mistral",
  moonshotai: "Moonshot AI",
  "moonshotai-cn": "Moonshot AI CN",
  nvidia: "NVIDIA",
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  openrouter: "OpenRouter",
  "qwen-token-plan": "Qwen Token Plan",
  "qwen-token-plan-cn": "Qwen Token Plan CN",
  "qwen-token-plan-individual": "Qwen Token Plan Individual",
  together: "Together",
  typesafe: "TypeSafe",
  "vercel-ai-gateway": "Vercel AI Gateway",
  xai: "xAI",
  xiaomi: "Xiaomi",
  "xiaomi-token-plan-ams": "Xiaomi Token Plan AMS",
  "xiaomi-token-plan-cn": "Xiaomi Token Plan CN",
  "xiaomi-token-plan-sgp": "Xiaomi Token Plan SGP",
  zai: "Z.AI",
  "zai-coding-cn": "Z.AI Coding CN",
};

export const piProviderName = (providerId: string) => PROVIDER_NAMES[providerId] ?? providerId;

/** A Pi model's slug in Threadlines: `provider/id`, which a picker splits at the first `/`. */
export const piModelSlug = (model: { readonly provider: string; readonly id: string }) =>
  `${model.provider}/${model.id}`;

/** Splits a slug at the first `/`: ids such as `openrouter/deepseek/x` keep their own slashes. */
export function parsePiModelSlug(
  slug: string,
): { readonly provider: string; readonly modelId: string } | undefined {
  const slash = slug.indexOf("/");
  if (slash <= 0 || slash === slug.length - 1) return undefined;
  return { provider: slug.slice(0, slash), modelId: slug.slice(slash + 1) };
}
