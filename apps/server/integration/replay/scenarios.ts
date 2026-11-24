/**
 * Replay scenarios: what to do in a thread, and what the thread must show
 * after. The same script drives a recording (real provider) and every replay,
 * so the prompts below are what the agent actually saw.
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";

import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
  type ProviderApprovalDecision,
  type RuntimeMode,
} from "@threadlines/contracts";
import {
  APPROVAL_ACTIVITY_KINDS,
  collectOpenPendingRequests,
} from "@threadlines/shared/pendingRequests";
import * as Effect from "effect/Effect";

import type { OrchestrationIntegrationHarness } from "../OrchestrationEngineHarness.integration.ts";

export type ReplayProvider = "codex" | "claude";

/** The model each provider's recordings use: a fast one, to keep recording cheap. */
export const RECORDING_MODELS: Record<ReplayProvider, string> = {
  codex: "gpt-6-astra",
  claude: "claude-haiku-5-5",
};

export const PROJECT_ID = ProjectId.make("project-replay");
export const THREAD_ID = ThreadId.make("thread-replay");

export interface ScenarioContext {
  readonly provider: ReplayProvider;
  readonly workspaceDir: string;
  /** Sends a message and starts a turn. Message ids are fixed per scenario, so recordings match. */
  readonly send: (text: string) => Effect.Effect<void>;
  readonly waitFor: (
    description: string,
    predicate: (thread: OrchestrationThread) => boolean,
  ) => Effect.Effect<OrchestrationThread>;
  /** Waits for the turn that `send` number `turnCount` started to finish. */
  readonly waitForTurn: (turnCount: number) => Effect.Effect<OrchestrationThread>;
  readonly interrupt: Effect.Effect<void>;
  /** Waits for the agent to ask for an approval, then answers it. */
  readonly answerApproval: (decision: ProviderApprovalDecision) => Effect.Effect<void>;
  readonly revertTo: (turnCount: number) => Effect.Effect<void>;
  readonly readFile: (path: string) => string | null;
}

export interface ReplayScenario {
  readonly name: string;
  readonly providers: ReadonlyArray<ReplayProvider>;
  readonly runtimeMode: RuntimeMode;
  readonly run: (context: ScenarioContext) => Effect.Effect<void>;
  /** Checks the thread once the run is over; throw to fail. */
  readonly check: (thread: OrchestrationThread, context: ScenarioContext) => void;
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const assistantText = (thread: OrchestrationThread) =>
  thread.messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.text)
    .join("\n");

export const REPLAY_SCENARIOS: ReadonlyArray<ReplayScenario> = [
  {
    name: "simple-turn",
    providers: ["codex", "claude"],
    runtimeMode: "full-access",
    run: (context) =>
      Effect.gen(function* () {
        yield* context.send("Reply with exactly the word PONG and nothing else.");
        yield* context.waitForTurn(1);
      }),
    check: (thread) => {
      expect(thread.latestTurn?.state === "completed", `turn ended ${thread.latestTurn?.state}`);
      expect(assistantText(thread).includes("PONG"), "the reply says PONG");
      expect(thread.session?.status === "ready", `session is ${thread.session?.status}`);
    },
  },
  {
    name: "command-approval",
    providers: ["codex", "claude"],
    runtimeMode: "approval-required",
    run: (context) =>
      Effect.gen(function* () {
        yield* context.send(
          "Run this exact shell command: echo approved > approved.txt\nThen reply with exactly DONE.",
        );
        yield* context.answerApproval("accept");
        yield* context.waitForTurn(1);
      }),
    check: (thread, context) => {
      expect(thread.latestTurn?.state === "completed", `turn ended ${thread.latestTurn?.state}`);
      expect(
        thread.activities.some((activity) => activity.kind === APPROVAL_ACTIVITY_KINDS.resolved),
        "the approval was answered",
      );
      expect(context.readFile("approved.txt")?.trim() === "approved", "the approved command ran");
    },
  },
  {
    name: "interrupt-mid-turn",
    providers: ["codex", "claude"],
    runtimeMode: "full-access",
    run: (context) =>
      Effect.gen(function* () {
        yield* context.send(
          "Run this exact shell command: sleep 30\nThen reply with exactly FINISHED.",
        );
        yield* context.waitFor("the sleep command started", (thread) =>
          thread.activities.some((activity) => activity.kind === "tool.started"),
        );
        yield* context.interrupt;
        yield* context.waitForTurn(1);
      }),
    check: (thread) => {
      expect(thread.latestTurn?.state === "interrupted", `turn ended ${thread.latestTurn?.state}`);
      expect(!assistantText(thread).includes("FINISHED"), "the agent did not finish");
    },
  },
  {
    name: "revert-turn",
    providers: ["codex", "claude"],
    runtimeMode: "full-access",
    run: (context) =>
      Effect.gen(function* () {
        yield* context.send(
          "Create a file named notes.txt whose only content is the line: one\nThen reply with exactly OK.",
        );
        yield* context.waitForTurn(1);
        yield* context.send(
          "Add a second line to notes.txt with the text: two\nThen reply with exactly OK.",
        );
        yield* context.waitForTurn(2);
        yield* context.revertTo(1);
        yield* context.waitFor(
          "the thread reverted to its first turn",
          (thread) => thread.messages.filter((message) => message.role === "user").length === 1,
        );
      }),
    check: (_thread, context) => {
      expect(
        context.readFile("notes.txt")?.trim() === "one",
        "notes.txt is back to its first turn",
      );
    },
  },
  {
    name: "subagent",
    providers: ["codex", "claude"],
    runtimeMode: "full-access",
    run: (context) =>
      Effect.gen(function* () {
        yield* context.send(
          "Start exactly one sub-agent and ask it: what is 6 times 7? Wait for its answer, then reply with exactly ANSWER: followed by the number it gave.",
        );
        yield* context.waitForTurn(1);
      }),
    check: (thread) => {
      expect(thread.latestTurn?.state === "completed", `turn ended ${thread.latestTurn?.state}`);
      expect((thread.subagents ?? []).length >= 1, "the subagent is on the roster");
      expect(assistantText(thread).includes("42"), "the reply has the subagent's answer");
    },
  },
];

/** Builds a scenario's context on a harness. `failure` reports a replay mismatch. */
export function makeScenarioContext(input: {
  readonly harness: OrchestrationIntegrationHarness;
  readonly provider: ReplayProvider;
  readonly scenario: ReplayScenario;
  readonly failure: () => Error | null;
  readonly timeoutMs: number;
}): ScenarioContext {
  const { harness, provider, scenario } = input;
  let sent = 0;
  const now = () => new Date().toISOString();
  const waitFor = (description: string, predicate: (thread: OrchestrationThread) => boolean) =>
    harness
      .waitForThread(
        THREAD_ID,
        (thread) => {
          const failure = input.failure();
          if (failure !== null) throw failure;
          return predicate(thread);
        },
        input.timeoutMs,
      )
      .pipe(Effect.withSpan(`replay.waitFor ${description}`));
  const dispatch = (
    command: Parameters<OrchestrationIntegrationHarness["engine"]["dispatch"]>[0],
  ) => harness.engine.dispatch(command).pipe(Effect.orDie, Effect.asVoid);
  return {
    provider,
    workspaceDir: harness.workspaceDir,
    send: (text) => {
      sent += 1;
      return dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`cmd-replay-send-${sent}`),
        threadId: THREAD_ID,
        message: {
          messageId: MessageId.make(`00000000-0000-4000-8000-${String(sent).padStart(12, "0")}`),
          role: "user",
          text,
          attachments: [],
        },
        composer: "typed",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: scenario.runtimeMode,
        createdAt: now(),
      });
    },
    waitFor,
    waitForTurn: (turnCount) =>
      waitFor(`turn ${turnCount} finished`, (thread) => {
        const turn = thread.latestTurn;
        return (
          thread.messages.filter((message) => message.role === "user").length >= turnCount &&
          turn !== null &&
          (turn.state === "completed" || turn.state === "interrupted" || turn.state === "error") &&
          thread.session?.status !== "running" &&
          thread.session?.status !== "starting"
        );
      }),
    interrupt: dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.make("cmd-replay-interrupt"),
      threadId: THREAD_ID,
      createdAt: now(),
    }),
    answerApproval: (decision) =>
      Effect.gen(function* () {
        const thread = yield* waitFor(
          "an approval request",
          (entry) =>
            collectOpenPendingRequests(entry.activities, APPROVAL_ACTIVITY_KINDS).length > 0,
        );
        const [open] = collectOpenPendingRequests(thread.activities, APPROVAL_ACTIVITY_KINDS);
        yield* dispatch({
          type: "thread.approval.respond",
          commandId: CommandId.make("cmd-replay-approval"),
          threadId: THREAD_ID,
          requestId: ApprovalRequestId.make(open!.requestId),
          decision,
          createdAt: now(),
        });
      }),
    revertTo: (turnCount) =>
      dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make(`cmd-replay-revert-${turnCount}`),
        threadId: THREAD_ID,
        turnCount,
        createdAt: now(),
      }),
    readFile: (path) => {
      try {
        return fs.readFileSync(nodePath.join(harness.workspaceDir, path), "utf8");
      } catch {
        return null;
      }
    },
  };
}

/** Creates the project and thread a scenario runs in. */
export function setUpScenarioThread(
  harness: OrchestrationIntegrationHarness,
  provider: ReplayProvider,
  scenario: ReplayScenario,
) {
  const instanceId = ProviderInstanceId.make(provider === "codex" ? "codex" : "claudeAgent");
  const modelSelection = { instanceId, model: RECORDING_MODELS[provider] };
  const createdAt = new Date().toISOString();
  return Effect.gen(function* () {
    yield* harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-replay-project"),
      projectId: PROJECT_ID,
      title: "Replay",
      workspaceRoot: harness.workspaceDir,
      defaultModelSelection: modelSelection,
      createdAt,
    });
    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-replay-thread"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: `Replay ${scenario.name}`,
      modelSelection,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: scenario.runtimeMode,
      branch: null,
      worktreePath: harness.workspaceDir,
      createdAt,
    });
  }).pipe(Effect.orDie);
}

export const FIXTURES_DIR = nodePath.join(import.meta.dirname, "fixtures");

export const fixturePath = (scenario: string, provider: ReplayProvider) =>
  nodePath.join(FIXTURES_DIR, scenario, `${provider}.ndjson`);
