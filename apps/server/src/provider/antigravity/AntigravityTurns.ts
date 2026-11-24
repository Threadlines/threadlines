/**
 * How an Antigravity turn runs on `agy acp` 1.5, for the generic ACP core:
 * the work that outlives a prompt, steering with a second prompt, the
 * failures a normal-looking end hides, and the turn's tokens.
 *
 * What `agy acp` does, from Google's changelog (google-antigravity/antigravity-cli):
 * - 1.5.0 takes a prompt sent while one runs as a steer: it answers the
 *   running prompt and carries the turn on under the new one.
 * - 1.5.8 sends `usage_update` after each model call.
 * - 1.5.9 fails a turn with its real error (model, quota) instead of a
 *   generic one.
 * - 1.5.10 sends what the agent does after a prompt ended (a background
 *   command or subagent finished and woke it) at once, and `session/cancel`
 *   stops those commands and subagents.
 * Wire shapes and the upstream error text follow T3 Code's Antigravity
 * adapter (AntigravityProtocol.ts, AntigravityTurnOutcome.ts).
 *
 * @module provider/antigravity/AntigravityTurns
 */
import type { RuntimeUsageLimit, UsageTokenTotals } from "@threadlines/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";

import { httpStatusFailureCategory } from "../providerFailureCategory.ts";
import type {
  AcpPromptFailure,
  AcpPromptOutcome,
  AcpPromptOutcomeWatch,
  AcpProviderDescriptor,
  AcpProviderSettings,
  AcpWorkAfterPrompt,
} from "../acp/AcpProviderDescriptor.ts";
import type { AcpToolCallState } from "../acp/AcpRuntimeModel.ts";
import { antigravityVerificationUrl } from "./AntigravityAuth.ts";
import { antigravityLogPosition, antigravityTurnSteps } from "./AntigravitySessionLog.ts";
import { antigravityChildLaunches } from "./AntigravityChildRecords.ts";
import { isAntigravitySubagentLaunch } from "./AntigravitySubagents.ts";

/** `schedule` stays in progress until its wake fires; the agent then replies by itself. */
const SCHEDULE_TITLES = new Set(["Run schedule", "Running schedule"]);
/**
 * A command that has said nothing this long no longer holds its turn: the
 * agent sometimes loses a command's end or its wake (T3 Code found the same
 * and settled on 30 minutes, which still leaves long builds room).
 */
export const ANTIGRAVITY_SILENT_WORK_LIMIT = Duration.minutes(30);
/**
 * Whether a message sent mid-turn steers the running turn (a second
 * `session/prompt`, 1.5.0+). Off, it waits for the turn to end.
 */
export const ANTIGRAVITY_STEERS = true;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What a tool call goes on with after the prompt answers: a command the
 * agent awaits (a daemon such as a dev server may never end, so it doesn't
 * hold the turn), a scheduled wake-up, or a subagent it launched.
 */
export function antigravityWorkAfterPrompt(
  toolCall: AcpToolCallState,
): AcpWorkAfterPrompt | undefined {
  if (toolCall.title !== undefined && SCHEDULE_TITLES.has(toolCall.title)) {
    return { kind: "timer" };
  }
  const input = toolCall.data.rawInput;
  if (toolCall.kind === "execute") {
    return isRecord(input) && input.IsDaemon === true ? undefined : { kind: "command" };
  }
  // The same launches the subagent view shows (auto-approved titles too),
  // a batch counting each subagent in it.
  const count = isAntigravitySubagentLaunch(toolCall)
    ? (antigravityChildLaunches(input)?.length ?? 0)
    : 0;
  if (count > 0) return { kind: "subagents", count };
  return undefined;
}

/**
 * A turn's tokens from its `session/prompt` answer. Antigravity 1.5 leaves
 * cached reads out of `inputTokens` and already counts thinking inside
 * `outputTokens` (T3 Code 602e5b32f5), unlike the fx reading the generic
 * conversion makes.
 */
export function antigravityTurnUsageTotals(
  usage: EffectAcpSchema.Usage | null | undefined,
): UsageTokenTotals | null {
  if (!usage) return null;
  const count = (value: number | null | undefined) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
  const outputTokens = count(usage.outputTokens);
  const totals: UsageTokenTotals = {
    uncachedInputTokens: count(usage.inputTokens),
    cachedInputTokens: count(usage.cachedReadTokens),
    cacheCreationTokens: count(usage.cachedWriteTokens),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, count(usage.thoughtTokens)),
  };
  return totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens >
    0
    ? totals
    : null;
}

// ── Failures ─────────────────────────────────────────────────────────

/**
 * The Go harness's rendering of a Google API error. Status is a gRPC code or
 * an HTTP status line ("502 Bad Gateway"). A message stops at the next
 * error, so the match stays linear.
 */
const API_ERROR =
  /Error (\d{3}), Message: ((?:(?!, Status: |Error \d{3}, Message: ).)+), Status: ([A-Z_]+|\d{3}[^,\n]*)/su;
/** Canonical gRPC status codes, so a preceding protobuf length byte isn't swallowed into the name. */
const GRPC_STATUS_NAMES =
  "CANCELLED|UNKNOWN|INVALID_ARGUMENT|DEADLINE_EXCEEDED|NOT_FOUND|ALREADY_EXISTS|PERMISSION_DENIED|RESOURCE_EXHAUSTED|FAILED_PRECONDITION|ABORTED|OUT_OF_RANGE|UNIMPLEMENTED|INTERNAL|UNAVAILABLE|DATA_LOSS|UNAUTHENTICATED";
/** 1.5 with a Google account: "STATUS (code NNN): message". */
const STATUS_ERROR = new RegExp(`(${GRPC_STATUS_NAMES}) \\(code (\\d{3})\\): (\\P{Cc}+)`, "u");
/** Go map (`reason:QUOTA_EXHAUSTED`) or 1.5 JSON (`"reason": "QUOTA_EXHAUSTED"`). */
const QUOTA_EXHAUSTED = /(?:\breason:QUOTA_EXHAUSTED\b|"reason"\s*:\s*"QUOTA_EXHAUSTED")/u;
const VALIDATION_REQUIRED = /\bVALIDATION_REQUIRED\b|verify your account/iu;
/**
 * A saved thinking block the model refuses (its signature is gone): it sits
 * in the agent's history, so every later prompt to the session fails alike.
 */
const LOST_THINKING_SIGNATURE =
  /\bmessages\.\d+\.content\.\d+(?:\.thinking\.signature: Field required|: Invalid `signature` in `thinking` block)/u;
const RESET_TIMESTAMP =
  /(?:\bquotaResetTimeStamp:([^\s\]",]+)|"quotaResetTimeStamp"\s*:\s*"([^"]+)")/u;
const RESET_DELAY =
  /(?:\bquotaResetDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]",])|"quotaResetDelay"\s*:\s*"((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)")/u;
const RETRY_DELAY =
  /(?:\bretryDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]",])|"retryDelay"\s*:\s*"((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)")/u;
const GO_DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/gu;
const GO_DURATION_UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

const QUOTA_MESSAGE = "You've reached your Antigravity quota for now.";
const LOST_SESSION_MESSAGE =
  "Antigravity's saved conversation can no longer be sent to the model. The next message starts a new Antigravity session with this thread's history.";
const UNKNOWN_ERROR_MESSAGE = "Antigravity stopped this turn because of an error.";

function parseGoDurationMs(delay: string): number {
  let delayMs = 0;
  for (const [, amount, unit] of delay.matchAll(GO_DURATION_PART)) {
    delayMs += Number(amount) * (GO_DURATION_UNIT_MS[unit!] ?? 0);
  }
  return delayMs;
}

/**
 * When an exhausted quota resets, as the error says, in ISO time. Prefers a
 * future `quotaResetTimeStamp`, else a positive `quotaResetDelay` or
 * `retryDelay`, else a valid past timestamp when no delay was given.
 */
function quotaResetAt(text: string, nowMs: number): string | undefined {
  const stampMatch = RESET_TIMESTAMP.exec(text);
  const stamp = stampMatch?.[1] ?? stampMatch?.[2];
  const stampMs = stamp !== undefined ? Date.parse(stamp) : Number.NaN;
  if (Number.isFinite(stampMs) && stampMs > nowMs) {
    return new Date(stampMs).toISOString();
  }
  const delayMatch = RESET_DELAY.exec(text) ?? RETRY_DELAY.exec(text);
  const delay = delayMatch?.[1] ?? delayMatch?.[2];
  if (delay !== undefined) {
    const delayMs = parseGoDurationMs(delay);
    if (delayMs > 0) return new Date(nowMs + Math.ceil(delayMs)).toISOString();
  }
  return Number.isFinite(stampMs) ? new Date(stampMs).toISOString() : undefined;
}

/** HTTP status, message and status name, from either rendering. */
function parseApiError(
  text: string,
): { readonly httpStatus: number; readonly message: string; readonly status: string } | undefined {
  const api = API_ERROR.exec(text);
  if (api !== null) {
    return { httpStatus: Number(api[1]), message: api[2]!.trim(), status: api[3]!.trim() };
  }
  const status = STATUS_ERROR.exec(text);
  if (status !== null) {
    return { httpStatus: Number(status[2]), message: status[3]!.trim(), status: status[1]! };
  }
  return undefined;
}

/**
 * What an Antigravity failure was, from the error text the agent gave
 * (its JSON-RPC error, or the error step in its log). `refusal` is the stop
 * reason the agent gives an exhausted quota. `reachedModel` tells a 404 for
 * a model the account can't use (before any reply) from a passing one.
 */
export function antigravityFailure(input: {
  readonly errorText: string | undefined;
  readonly stopReason?: string | undefined;
  readonly reachedModel?: boolean;
  readonly nowMs: number;
}): AcpPromptFailure | undefined {
  const text = input.errorText ?? "";
  if (input.errorText === undefined && input.stopReason !== "refusal") return undefined;
  if (input.stopReason === "refusal" || QUOTA_EXHAUSTED.test(text)) {
    const resetsAt = quotaResetAt(text, input.nowMs);
    return {
      errorMessage: QUOTA_MESSAGE,
      failureCategory: "rate_limit",
      usageLimit: resetsAt !== undefined ? { resetsAt } : {},
    };
  }
  if (LOST_THINKING_SIGNATURE.test(text)) {
    return { errorMessage: LOST_SESSION_MESSAGE, sessionLost: true };
  }
  if (VALIDATION_REQUIRED.test(text)) {
    const url = antigravityVerificationUrl(text);
    return {
      errorMessage: url
        ? `Google needs you to verify this account before Antigravity can continue. Verify it at ${url}, then try again.`
        : "Google needs you to verify this account before Antigravity can continue. Sign in to Google in your browser to verify it, then try again.",
      failureCategory: "auth",
    };
  }
  const api = parseApiError(text);
  if (api === undefined) return { errorMessage: UNKNOWN_ERROR_MESSAGE };
  const rateLimited = api.httpStatus === 429 || api.status === "RESOURCE_EXHAUSTED";
  const resetsAt = rateLimited ? quotaResetAt(text, input.nowMs) : undefined;
  const failureCategory = rateLimited
    ? "rate_limit"
    : api.httpStatus === 404
      ? input.reachedModel === true
        ? "server_error"
        : "model_unavailable"
      : api.httpStatus === 401 || api.status === "UNAUTHENTICATED"
        ? input.reachedModel === true
          ? "server_error"
          : "auth"
        : httpStatusFailureCategory(api.httpStatus);
  return {
    errorMessage: `Antigravity: ${api.message} (${api.status.startsWith(String(api.httpStatus)) ? api.status : `${api.httpStatus} ${api.status}`})`,
    ...(failureCategory !== undefined ? { failureCategory } : {}),
    ...(resetsAt !== undefined ? { usageLimit: { resetsAt } } : {}),
  };
}

/** The error text an ACP error carries: its message and any data the agent attached. */
function acpErrorText(error: unknown): string | undefined {
  if (!isRecord(error) || error._tag !== "AcpRequestError") return undefined;
  const message = typeof error.errorMessage === "string" ? error.errorMessage : "";
  const data = error.data;
  const dataText =
    data === undefined ? "" : typeof data === "string" ? data : (JSON.stringify(data) ?? "");
  const text = `${message}\n${dataText}`.trim();
  return text.length > 0 ? text : undefined;
}

/**
 * The descriptor hooks for an Antigravity turn, with the instance's profile
 * (where the CLI keeps its session logs). `readUsageLimit` gives a quota
 * failure the agent gave no reset time the one the plan meter knows for the
 * turn's model.
 */
export function antigravityTurnBehavior<Settings extends AcpProviderSettings>(
  profileDir: string,
  readUsageLimit?: (model: string) => Effect.Effect<RuntimeUsageLimit | undefined>,
  onPromptSettled?: Effect.Effect<void>,
): Pick<AcpProviderDescriptor<Settings>, "turnMachine" | "usageLedger" | "turnUsageTotals"> {
  return {
    // Turns outlive their prompt (1.5.10 sends what the agent does after a
    // prompt ends at once) and a second prompt steers (1.5.0). Subagent
    // holds follow the CLI's records (the descriptor's `subagents`).
    turnMachine: {
      workAfterPrompt: antigravityWorkAfterPrompt,
      steer: ANTIGRAVITY_STEERS,
      silentLimit: ANTIGRAVITY_SILENT_WORK_LIMIT,
      outcome: antigravityPromptOutcome(profileDir, readUsageLimit, onPromptSettled),
    },
    usageLedger: { provider: "antigravity" },
    turnUsageTotals: antigravityTurnUsageTotals,
  };
}

/**
 * Reads how an Antigravity prompt really ended: the JSON-RPC error it failed
 * with (1.5.9+), or, for a normal end, an error step in the CLI's session log.
 *
 * The log names no prompt, so a step counts for the newest prompt if it is
 * the log's last step and was written after that prompt went out. That
 * never hides the newest prompt's own failure. What it costs: an older
 * prompt's error written after a steer went out, with nothing after it,
 * fails the turn although the steer was answered (the CLI writes the
 * steer's reply after it, so this needs a steer that wrote no step). When
 * the log can't be read the prompt's own answer stands: the turn completes
 * and the agent's own words about the error stay in its reply.
 */
function antigravityPromptOutcome(
  profileDir: string,
  readUsageLimit?: (model: string) => Effect.Effect<RuntimeUsageLimit | undefined>,
  onPromptSettled?: Effect.Effect<void>,
): AcpPromptOutcome {
  return {
    watch: (sessionId, model) =>
      Effect.gen(function* () {
        const before = yield* antigravityLogPosition(profileDir, sessionId);
        const withMeterReset = (failure: AcpPromptFailure | undefined) =>
          failure?.usageLimit !== undefined &&
          failure.usageLimit.resetsAt === undefined &&
          readUsageLimit !== undefined &&
          model !== undefined
            ? readUsageLimit(model).pipe(
                Effect.map((limit) => (limit ? { ...failure, usageLimit: limit } : failure)),
              )
            : Effect.succeed(failure);
        const check: AcpPromptOutcomeWatch["check"] = (answer) =>
          Effect.gen(function* () {
            // The CLI may have just renewed its OAuth token or consumed quota;
            // poke the usage reader off the critical path.
            if (onPromptSettled) yield* onPromptSettled.pipe(Effect.ignore);
            const nowMs = yield* Clock.currentTimeMillis;
            // 1.5.9+ fails the prompt with the real error.
            // Words it doesn't recognize keep the core's own reading.
            if ("error" in answer) {
              const errorText = acpErrorText(answer.error);
              const recognized =
                errorText !== undefined &&
                (parseApiError(errorText) !== undefined ||
                  QUOTA_EXHAUSTED.test(errorText) ||
                  VALIDATION_REQUIRED.test(errorText) ||
                  LOST_THINKING_SIGNATURE.test(errorText));
              return recognized
                ? yield* withMeterReset(antigravityFailure({ errorText, nowMs }))
                : undefined;
            }
            // A normal end can hide an upstream error that only the
            // agent's own log records.
            const stopReason = answer.response.stopReason;
            const steps =
              before === undefined
                ? undefined
                : yield* antigravityTurnSteps(profileDir, sessionId, before);
            return yield* withMeterReset(
              antigravityFailure({
                errorText: steps?.errorText,
                stopReason,
                ...(steps !== undefined ? { reachedModel: steps.reachedModel } : {}),
                nowMs,
              }),
            );
          });
        return { check };
      }),
  };
}
