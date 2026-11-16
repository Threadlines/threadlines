/**
 * Runs one tool-use case: the real adapter and the real provider program
 * (signed in from the eval folder), our real prompt and instructions, and the
 * eval tool server in place of Threadlines' own tool endpoints.
 */
import {
  ApprovalRequestId,
  ClaudeSettings,
  CodexSettings,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
} from "@threadlines/contracts";
import {
  APPROVAL_ACTIVITY_KINDS,
  collectOpenPendingRequests,
} from "@threadlines/shared/pendingRequests";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../src/config.ts";
import { makeClaudeAdapter } from "../../src/provider/Layers/ClaudeAdapter.ts";
import { makeCodexAdapter } from "../../src/provider/Layers/CodexAdapter.ts";
import {
  makeOrchestrationIntegrationHarness,
  type RealProviderAdapter,
} from "../../integration/OrchestrationEngineHarness.integration.ts";
import type { EvalRun, NativeToolUse, ToolUseCase } from "./cases.ts";
import { makeGatedCodexSpawner } from "./codexGate.ts";
import {
  claudeEvalEnvironment,
  EVAL_CODEX_HOME,
  EvalSetupError,
  makeIsolatedClaudeQuery,
  subscriptionOnlyEnvironment,
} from "./isolation.ts";
import { startEvalToolServer } from "./toolServer.ts";

export type EvalProvider = "claude" | "codex";

const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);
const decodeCodexSettings = Schema.decodeEffect(CodexSettings);

/**
 * Production defaults, except what would differ between runs or isn't served
 * here: Codex's next-message suggestions, agent pages and command requests
 * (their endpoints and instructions are both left out).
 */
export const EVAL_SERVER_SETTINGS = {
  codexSuggestions: false,
  enableAgentPages: false,
  enableCommandRequests: false,
} as const;

const PROJECT_ID = ProjectId.make("project-eval");
const THREAD_ID = ThreadId.make("thread-eval");

function evalAdapter(
  provider: EvalProvider,
  port: number,
  onBlocked: (reason: string) => void,
): RealProviderAdapter {
  const withPort = <A, E, R>(make: Effect.Effect<A, E, R>) =>
    Effect.flatMap(Effect.service(ServerConfig), (config) =>
      make.pipe(Effect.provideService(ServerConfig, { ...config, port })),
    );
  if (provider === "claude") {
    return {
      kind: ProviderDriverKind.make("claudeAgent"),
      make: Effect.gen(function* () {
        const { query } = yield* Effect.promise(() => import("@anthropic-ai/claude-agent-sdk"));
        const settings = yield* decodeClaudeSettings({});
        return yield* withPort(
          makeClaudeAdapter(settings, {
            // The adapter reads Claude's folder too (transcripts, approvals): the eval one.
            environment: claudeEvalEnvironment(),
            createQuery: makeIsolatedClaudeQuery(
              (input) => query(input as Parameters<typeof query>[0]) as never,
              onBlocked,
            ),
          }),
        );
      }).pipe(Effect.orDie),
    };
  }
  return {
    kind: ProviderDriverKind.make("codex"),
    make: Effect.gen(function* () {
      const settings = yield* decodeCodexSettings({ homePath: EVAL_CODEX_HOME });
      const real = yield* ChildProcessSpawner.ChildProcessSpawner;
      return yield* withPort(
        makeCodexAdapter(settings, { environment: subscriptionOnlyEnvironment() }),
      ).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          makeGatedCodexSpawner(real, onBlocked),
        ),
      );
    }).pipe(Effect.orDie),
  };
}

/** The agent's own tool calls, from the thread's tool activities (one per call). */
function nativeToolsOf(thread: OrchestrationThread): ReadonlyArray<NativeToolUse> {
  const byCall = new Map<string, NativeToolUse>();
  for (const activity of thread.activities) {
    if (!activity.kind.startsWith("tool.")) continue;
    const payload = activity.payload as {
      readonly toolCallId?: string;
      readonly detail?: string;
      readonly itemType?: string;
      readonly data?: {
        readonly toolName?: string;
        readonly input?: unknown;
        readonly item?: unknown;
      };
    };
    // The tool itself, never its display text (a subagent's detail is its prompt).
    const item = payload.data?.item as { readonly tool?: unknown } | undefined;
    const name =
      payload.data?.toolName ??
      (typeof item?.tool === "string" ? item.tool : undefined) ??
      payload.itemType ??
      "unknown";
    // Threadlines' own tools are graded from the tool server's log.
    if (name.startsWith("mcp__threadlines_") || payload.itemType === "mcp_tool_call") continue;
    const key = payload.toolCallId ?? activity.id;
    byCall.set(key, { name, input: payload.data?.input ?? payload.data?.item ?? null });
  }
  return [...byCall.values()];
}

export interface CaseResult {
  readonly case: string;
  readonly provider: EvalProvider;
  readonly model: string;
  readonly passed: boolean;
  readonly failures: ReadonlyArray<string>;
  readonly run: EvalRun;
}

export const runToolUseCase = (input: {
  readonly provider: EvalProvider;
  readonly model: string;
  readonly testCase: ToolUseCase;
  readonly timeoutMs: number;
}) =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startEvalToolServer({
          ...(input.testCase.answers ? { answers: input.testCase.answers } : {}),
          runtimeMode: input.testCase.runtimeMode ?? "full-access",
          serverSettings: EVAL_SERVER_SETTINGS,
        }),
      ),
      (started) => Effect.promise(() => started.close()),
    );
    let blocked: string | null = null;
    const harness = yield* makeOrchestrationIntegrationHarness({
      provider: ProviderDriverKind.make(input.provider === "claude" ? "claudeAgent" : "codex"),
      serverSettings: EVAL_SERVER_SETTINGS,
      realAdapter: () =>
        evalAdapter(input.provider, server.port, (reason) => {
          blocked = reason;
        }),
    });
    const outcome = yield* Effect.gen(function* () {
      const modelSelection = {
        instanceId: ProviderInstanceId.make(input.provider === "claude" ? "claudeAgent" : "codex"),
        model: input.model,
      };
      const runtimeMode = input.testCase.runtimeMode ?? "full-access";
      const createdAt = new Date().toISOString();
      yield* harness.engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-eval-project"),
        projectId: PROJECT_ID,
        title: "Eval",
        workspaceRoot: harness.workspaceDir,
        defaultModelSelection: modelSelection,
        createdAt,
      });
      yield* harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-eval-thread"),
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        title: `Eval ${input.testCase.name}`,
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode,
        branch: null,
        worktreePath: harness.workspaceDir,
        createdAt,
      });
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-eval-turn"),
        threadId: THREAD_ID,
        message: {
          messageId: MessageId.make("00000000-0000-4000-8000-0000000e7a11"),
          role: "user",
          text: input.testCase.message,
          attachments: [],
        },
        composer: "typed",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode,
        createdAt: new Date().toISOString(),
      });
      // An approval the agent asks for is declined, as a careful user might,
      // so a run never waits on a person; the checks see it was asked.
      const declined = new Set<string>();
      const deadline = Date.now() + input.timeoutMs;
      while (true) {
        if (blocked !== null) return yield* Effect.die(new EvalSetupError(blocked));
        const snapshot = yield* harness.snapshotQuery.getSnapshot().pipe(Effect.orDie);
        const entry = snapshot.threads.find((candidate) => candidate.id === THREAD_ID);
        const turn = entry?.latestTurn ?? null;
        if (
          entry !== undefined &&
          turn !== null &&
          (turn.state === "completed" || turn.state === "interrupted" || turn.state === "error") &&
          entry.session?.status !== "running" &&
          entry.session?.status !== "starting"
        ) {
          return { thread: entry, declined: [...declined] };
        }
        for (const open of collectOpenPendingRequests(
          entry?.activities ?? [],
          APPROVAL_ACTIVITY_KINDS,
        )) {
          if (declined.has(open.requestId)) continue;
          declined.add(open.requestId);
          yield* harness.engine
            .dispatch({
              type: "thread.approval.respond",
              commandId: CommandId.make(`cmd-eval-decline-${declined.size}`),
              threadId: THREAD_ID,
              requestId: ApprovalRequestId.make(open.requestId),
              decision: "decline",
              createdAt: new Date().toISOString(),
            })
            .pipe(Effect.orDie);
        }
        if (Date.now() > deadline) {
          return yield* Effect.die(new Error(`timed out after ${input.timeoutMs / 1000}s`));
        }
        yield* Effect.sleep("500 millis");
      }
    }).pipe(Effect.orDie, Effect.ensuring(harness.dispose));
    if (blocked !== null) return yield* Effect.die(new EvalSetupError(blocked));
    const run: EvalRun = {
      calls: [...server.calls],
      native: nativeToolsOf(outcome.thread),
      declinedApprovals: outcome.declined.length,
      reply: outcome.thread.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.text)
        .join("\n"),
    };
    const failures = [
      ...(outcome.thread.latestTurn?.state === "completed"
        ? []
        : [`turn ended ${outcome.thread.latestTurn?.state}`]),
      ...input.testCase.checks.flatMap((check) => {
        const failure = check(run);
        return failure === null ? [] : [failure];
      }),
    ];
    return {
      case: input.testCase.name,
      provider: input.provider,
      model: input.model,
      passed: failures.length === 0,
      failures,
      run,
    } satisfies CaseResult;
  });
