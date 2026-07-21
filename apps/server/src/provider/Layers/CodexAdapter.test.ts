// @effect-diagnostics nodeBuiltinImport:off
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ApprovalRequestId,
  CodexSettings,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderStartReviewResult,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { createModelSelection } from "@threadlines/shared/model";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, vi } from "@effect/vitest";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as CodexErrors from "effect-codex-app-server/errors";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import type { CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeSendTurnInput,
  type CodexSessionRuntimeSetGoalInput,
  type CodexSessionRuntimeShape,
  type CodexSessionRuntimeStartReviewInput,
  type CodexSessionRuntimeSteerTurnInput,
  type CodexThreadGoal,
  type CodexThreadSnapshot,
} from "./CodexSessionRuntime.ts";
import { makeCodexAdapter } from "./CodexAdapter.ts";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

// Test-local service tag so the rest of the file can keep using `yield* CodexAdapter`.
class CodexAdapter extends Context.Service<CodexAdapter, CodexAdapterShape>()(
  "test/CodexAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);

class FakeCodexRuntime implements CodexSessionRuntimeShape {
  private readonly eventQueue = Effect.runSync(Queue.unbounded<ProviderEvent>());
  private readonly now = "2026-01-01T00:00:00.000Z";

  public readonly startImpl = vi.fn(() =>
    Promise.resolve({
      provider: ProviderDriverKind.make("codex"),
      status: "ready" as const,
      runtimeMode: this.options.runtimeMode,
      threadId: this.options.threadId,
      cwd: this.options.cwd,
      ...(this.options.model ? { model: this.options.model } : {}),
      createdAt: this.now,
      updatedAt: this.now,
    } satisfies ProviderSession),
  );

  public readonly sendTurnImpl = vi.fn(
    (_input: CodexSessionRuntimeSendTurnInput): Promise<ProviderTurnStartResult> =>
      Promise.resolve({
        threadId: this.options.threadId,
        turnId: asTurnId("turn-1"),
      }),
  );

  public readonly steerTurnImpl = vi.fn(
    (input: CodexSessionRuntimeSteerTurnInput): Promise<ProviderTurnStartResult> =>
      Promise.resolve({
        threadId: this.options.threadId,
        turnId: input.expectedTurnId,
      }),
  );

  public readonly startReviewImpl = vi.fn(
    (_input: CodexSessionRuntimeStartReviewInput): Promise<ProviderStartReviewResult> =>
      Promise.resolve({
        threadId: this.options.threadId,
        turnId: asTurnId("review-turn-1"),
        reviewThreadId: "provider-thread-1",
        delivery: "inline",
      }),
  );

  public readonly interruptTurnImpl = vi.fn(
    (_turnId?: TurnId): Promise<void> => Promise.resolve(undefined),
  );

  public readonly compactContextImpl = vi.fn((): Promise<void> => Promise.resolve(undefined));

  public goalState: CodexThreadGoal | null = null;

  public readonly setGoalImpl = vi.fn(
    (input: CodexSessionRuntimeSetGoalInput): Promise<CodexThreadGoal> => {
      const updated: CodexThreadGoal = {
        createdAt: this.goalState?.createdAt ?? 1_760_000_000_000,
        objective: input.objective ?? this.goalState?.objective ?? "default objective",
        status: input.status ?? this.goalState?.status ?? "active",
        threadId: "provider-thread-1",
        timeUsedSeconds: this.goalState?.timeUsedSeconds ?? 0,
        tokenBudget:
          input.tokenBudget !== undefined
            ? input.tokenBudget
            : (this.goalState?.tokenBudget ?? null),
        tokensUsed: this.goalState?.tokensUsed ?? 0,
        updatedAt: 1_760_000_000_000,
      };
      this.goalState = updated;
      return Promise.resolve(updated);
    },
  );

  public readonly clearGoalImpl = vi.fn((): Promise<void> => {
    this.goalState = null;
    return Promise.resolve(undefined);
  });

  public readonly readThreadImpl = vi.fn(
    (): Promise<CodexThreadSnapshot> =>
      Promise.resolve({
        threadId: "provider-thread-1",
        turns: [],
      }),
  );

  public readonly rollbackThreadImpl = vi.fn(
    (_numTurns: number): Promise<CodexThreadSnapshot> =>
      Promise.resolve({
        threadId: "provider-thread-1",
        turns: [],
      }),
  );

  public readonly deleteThreadImpl = vi.fn((): Promise<void> => Promise.resolve(undefined));

  public readonly respondToRequestImpl = vi.fn(
    (_requestId: ApprovalRequestId, _decision: ProviderApprovalDecision): Promise<void> =>
      Promise.resolve(undefined),
  );

  public readonly respondToUserInputImpl = vi.fn(
    (_requestId: ApprovalRequestId, _answers: ProviderUserInputAnswers): Promise<void> =>
      Promise.resolve(undefined),
  );

  public readonly closeImpl = vi.fn(() => Promise.resolve(undefined));

  readonly options: CodexSessionRuntimeOptions;

  constructor(options: CodexSessionRuntimeOptions) {
    this.options = options;
  }

  start() {
    return Effect.promise(() => this.startImpl());
  }

  getSession = Effect.promise(() => this.startImpl());

  sendTurn(input: CodexSessionRuntimeSendTurnInput) {
    return Effect.promise(() => this.sendTurnImpl(input));
  }

  steerTurn(input: CodexSessionRuntimeSteerTurnInput) {
    return Effect.promise(() => this.steerTurnImpl(input));
  }

  startReview(input: CodexSessionRuntimeStartReviewInput) {
    return Effect.promise(() => this.startReviewImpl(input));
  }

  interruptTurn(turnId?: TurnId) {
    return Effect.promise(() => this.interruptTurnImpl(turnId));
  }

  compactContext = Effect.promise(() => this.compactContextImpl());

  setGoal = (input: CodexSessionRuntimeSetGoalInput) =>
    Effect.promise(() => this.setGoalImpl(input));

  getGoal = Effect.sync(() => this.goalState);

  clearGoal = Effect.promise(() => this.clearGoalImpl());

  readThread = Effect.promise(() => this.readThreadImpl());

  rollbackThread(numTurns: number) {
    return Effect.promise(() => this.rollbackThreadImpl(numTurns));
  }

  deleteThread = Effect.promise(() => this.deleteThreadImpl());

  respondToRequest(requestId: ApprovalRequestId, decision: ProviderApprovalDecision) {
    return Effect.promise(() => this.respondToRequestImpl(requestId, decision));
  }

  respondToUserInput(requestId: ApprovalRequestId, answers: ProviderUserInputAnswers) {
    return Effect.promise(() => this.respondToUserInputImpl(requestId, answers));
  }

  get events() {
    return Stream.fromQueue(this.eventQueue);
  }

  close = Effect.promise(() => this.closeImpl());

  emit(event: ProviderEvent) {
    return Queue.offer(this.eventQueue, event).pipe(Effect.asVoid);
  }
}

function makeRuntimeFactory() {
  const runtimes: Array<FakeCodexRuntime> = [];
  const factory = vi.fn((options: CodexSessionRuntimeOptions) => {
    const runtime = new FakeCodexRuntime(options);
    runtimes.push(runtime);
    return Effect.succeed(runtime);
  });

  return {
    factory,
    get lastRuntime(): FakeCodexRuntime | undefined {
      return runtimes.at(-1);
    },
  };
}

function makeScopedRuntimeFactory(options?: { readonly failConstruction?: boolean }) {
  const runtimes: Array<FakeCodexRuntime> = [];
  const releasedThreadIds: Array<ThreadId> = [];

  const factory = vi.fn((runtimeOptions: CodexSessionRuntimeOptions) =>
    Effect.gen(function* () {
      yield* Scope.Scope;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          releasedThreadIds.push(runtimeOptions.threadId);
        }),
      );

      if (options?.failConstruction) {
        return yield* new CodexErrors.CodexAppServerSpawnError({
          command: `${runtimeOptions.binaryPath} app-server`,
          cause: new Error("runtime construction failed"),
        });
      }

      const runtime = new FakeCodexRuntime(runtimeOptions);
      runtimes.push(runtime);
      return runtime;
    }),
  );

  return {
    factory,
    releasedThreadIds,
    get lastRuntime(): FakeCodexRuntime | undefined {
      return runtimes.at(-1);
    },
  };
}

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
  deleteBinding: () => Effect.void,
});

const validationRuntimeFactory = makeRuntimeFactory();
const validationLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: validationRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

validationLayer("CodexAdapterLive validation", (it) => {
  it.effect("returns validation error for non-codex provider on startSession", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("claudeAgent"),
          threadId: asThreadId("thread-1"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.deepStrictEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: ProviderDriverKind.make("codex"),
          operation: "startSession",
          issue: "Expected provider 'codex' but received 'claudeAgent'.",
        }),
      );
      assert.equal(validationRuntimeFactory.factory.mock.calls.length, 0);
    }),
  );
  it.effect("maps codex model options before starting a session", () =>
    Effect.gen(function* () {
      validationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "serviceTier", value: "priority" },
        ]),
        runtimeMode: "full-access",
      });

      assert.deepStrictEqual(validationRuntimeFactory.factory.mock.calls[0]?.[0], {
        binaryPath: "codex",
        cwd: process.cwd(),
        model: "gpt-5.3-codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        serviceTier: "priority",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
    }),
  );
  it.effect("passes forkFrom through to the session runtime", () =>
    Effect.gen(function* () {
      validationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-fork"),
        runtimeMode: "full-access",
        forkFrom: { providerThreadId: "source-thread", lastTurnId: "turn-3" },
      });

      assert.deepStrictEqual(validationRuntimeFactory.factory.mock.calls[0]?.[0]?.forkFrom, {
        providerThreadId: "source-thread",
        lastTurnId: "turn-3",
      });
    }),
  );
});

const sessionRuntimeFactory = makeRuntimeFactory();
const sessionErrorLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: sessionRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

sessionErrorLayer("CodexAdapterLive session errors", (it) => {
  it.effect("maps missing adapter sessions to ProviderAdapterSessionNotFoundError", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          attachments: [],
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      assert.equal(result.failure.provider, "codex");
      assert.equal(result.failure.threadId, "sess-missing");
    }),
  );

  it.effect("maps codex model options before sending a turn", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-missing"),
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-missing"),
          messageId: asMessageId("message-codex-options"),
          input: "hello",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "priority" },
          ]),
          skills: [
            {
              name: "review",
              path: "/tmp/project/.codex/skills/review/SKILL.md",
            },
          ],
          attachments: [],
        }),
      );

      assert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        clientUserMessageId: "message-codex-options",
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "priority",
        skills: [
          {
            type: "skill",
            name: "review",
            path: "/tmp/project/.codex/skills/review/SKILL.md",
          },
        ],
      });
    }),
  );

  it.effect("sends file attachments as staged-path text notes", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const { attachmentsDir } = yield* ServerConfig;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-missing"),
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      const attachment = {
        type: "file" as const,
        kind: "pdf" as const,
        id: "sess-missing-12345678-1234-1234-1234-123456789abc",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 13,
      };
      const attachmentPath = path.join(attachmentsDir, attachmentRelativePath(attachment));
      fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
      fs.writeFileSync(attachmentPath, "%PDF-1.4 fake");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => fs.rmSync(attachmentPath, { force: true })),
      );

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "Summarize this file.",
          attachments: [attachment],
        }),
      );

      const sentInput = runtime.sendTurnImpl.mock.calls[0]?.[0];
      assert.ok(sentInput);
      assert.equal(sentInput.input, "Summarize this file.");
      assert.equal(sentInput.attachments?.length, 1);
      const note = sentInput.attachments?.[0];
      assert.equal(note?.type, "text");
      assert.ok(note?.type === "text" && note.text.includes('"report.pdf"'));
      assert.ok(note?.type === "text" && note.text.includes(attachmentPath));
      assert.ok(note?.type === "text" && note.text.includes("PDF"));
    }),
  );

  it.effect("starts Codex reviews through the active runtime session", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("sess-review");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      runtime.startReviewImpl.mockClear();
      assert.ok(adapter.startReview);

      const result = yield* adapter.startReview({
        threadId,
        target: {
          type: "commit",
          sha: "abc123",
          title: "Review target",
        },
        delivery: "inline",
      });

      assert.equal(result?.turnId, asTurnId("review-turn-1"));
      assert.deepStrictEqual(runtime.startReviewImpl.mock.calls[0]?.[0], {
        target: {
          type: "commit",
          sha: "abc123",
          title: "Review target",
        },
        delivery: "inline",
      });
    }),
  );

  it.effect("keeps legacy fastMode selections working for Codex turns", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-legacy-fast"),
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-legacy-fast"),
          input: "hello",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
            { id: "fastMode", value: true },
          ]),
          attachments: [],
        }),
      );

      assert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: "hello",
        model: "gpt-5.4",
        serviceTier: "fast",
      });
    }),
  );

  it.effect("retains a cross-driver context seed when the first send fails", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("sess-seed-retry");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
        contextSeed: {
          version: 1,
          fromProvider: ProviderDriverKind.make("claudeAgent"),
          entries: [{ kind: "message", role: "user", text: "prior context" }],
        },
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      runtime.sendTurnImpl.mockRejectedValueOnce(new Error("send failed"));

      const firstExit = yield* adapter
        .sendTurn({
          threadId,
          input: "retry me",
          attachments: [],
        })
        .pipe(Effect.exit);
      assert.equal(Exit.isFailure(firstExit), true);

      runtime.sendTurnImpl.mockResolvedValueOnce({
        threadId,
        turnId: asTurnId("turn-2"),
      });
      yield* adapter.sendTurn({
        threadId,
        input: "retry me",
        attachments: [],
      });

      const retriedInput = runtime.sendTurnImpl.mock.calls[1]?.[0]?.input ?? "";
      assert.match(retriedInput, /This conversation was started/);
      assert.match(retriedInput, /prior context/);
      assert.match(retriedInput, /retry me/);
    }),
  );

  it.effect("deletes the provider Codex thread and closes the runtime", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("sess-delete-provider-thread");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      assert.ok(runtime);

      assert.ok(adapter.deleteThread);
      yield* adapter.deleteThread(threadId);

      assert.equal(runtime.deleteThreadImpl.mock.calls.length, 1);
      assert.equal(runtime.closeImpl.mock.calls.length, 1);
      assert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("starts provider Codex context compaction", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("sess-compact-provider-thread");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      assert.ok(runtime);

      assert.ok(adapter.compactContext);
      yield* adapter.compactContext(threadId);

      assert.equal(runtime.compactContextImpl.mock.calls.length, 1);
    }),
  );

  it.effect("maps codex model options for the adapter's bound custom instance id", () => {
    const customInstanceId = ProviderInstanceId.make("codex_personal");
    const customRuntimeFactory = makeRuntimeFactory();
    const customLayer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({});
        return yield* makeCodexAdapter(codexConfig, {
          instanceId: customInstanceId,
          makeRuntime: customRuntimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-custom-instance"),
        runtimeMode: "full-access",
      });
      const runtime = customRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-custom-instance"),
          input: "hello",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("codex_personal"),
            "gpt-5.3-codex",
            [
              { id: "reasoningEffort", value: "high" },
              { id: "serviceTier", value: "priority" },
            ],
          ),
          attachments: [],
        }),
      );

      assert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "priority",
      });
    }).pipe(Effect.provide(customLayer));
  });
});

const lifecycleRuntimeFactory = makeRuntimeFactory();
const lifecycleLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: lifecycleRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

function startLifecycleRuntime() {
  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      runtimeMode: "full-access",
    });
    const runtime = lifecycleRuntimeFactory.lastRuntime;
    assert.ok(runtime);
    return { adapter, runtime };
  });
}

lifecycleLayer("CodexAdapterLive lifecycle", (it) => {
  it.effect("keeps consuming runtime events after the session-start fiber completes", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-session-lifetime");
      const startupFiber = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Fiber.join(startupFiber);

      const runtime = lifecycleRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      const eventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-after-session-start"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-07-10T00:00:00.000Z",
        method: "turn/completed",
        threadId,
        turnId: asTurnId("turn-after-session-start"),
        payload: {
          threadId: "provider-thread-session-lifetime",
          turn: {
            id: "turn-after-session-start",
            items: [],
            status: "interrupted",
          },
        },
      } satisfies ProviderEvent);

      const event = yield* Fiber.join(eventFiber).pipe(Effect.timeout("1 second"));
      assert.equal(event._tag, "Some");
      if (event._tag === "Some") {
        assert.equal(event.value.type, "turn.completed");
        assert.equal(event.value.turnId, "turn-after-session-start");
      }
    }),
  );

  it.effect("removes the session from the map when the codex child exits unexpectedly", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-dead-child");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = lifecycleRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      assert.equal(yield* adapter.hasSession(threadId), true);
      const exitEventFiber = yield* Stream.runHead(
        adapter.streamEvents.pipe(Stream.filter((event) => event.type === "session.exited")),
      ).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-child-died"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-07-10T00:00:00.000Z",
        method: "session/exited",
        threadId,
        payload: {
          message: "Codex App Server exited with code 1.",
        },
      } satisfies ProviderEvent);

      const exitEvent = yield* Fiber.join(exitEventFiber).pipe(Effect.timeout("1 second"));
      assert.equal(exitEvent._tag, "Some");

      // Cleanup runs just after the exit event is offered downstream.
      let stillHasSession = true;
      for (let attempt = 0; attempt < 100 && stillHasSession; attempt += 1) {
        yield* Effect.yieldNow;
        stillHasSession = yield* adapter.hasSession(threadId);
      }
      assert.equal(stillHasSession, false);
    }),
  );

  it.effect("maps thread goal notifications into goal runtime events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const goalEventFiber = yield* Stream.runHead(
        adapter.streamEvents.pipe(Stream.filter((event) => event.type === "goal.updated")),
      ).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-goal-updated"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-07-10T00:00:00.000Z",
        method: "thread/goal/updated",
        threadId: asThreadId("thread-1"),
        payload: {
          threadId: "provider-thread-1",
          goal: {
            // Mixed epoch units on purpose: seconds and milliseconds both
            // normalize to the same ISO timeline.
            createdAt: 1_760_000_000,
            objective: "Ship goal support",
            status: "active",
            threadId: "provider-thread-1",
            timeUsedSeconds: 42,
            tokenBudget: 5_000_000,
            tokensUsed: 1_200_000,
            updatedAt: 1_760_000_400_000,
          },
        },
      } satisfies ProviderEvent);

      const goalEvent = yield* Fiber.join(goalEventFiber).pipe(Effect.timeout("1 second"));
      assert.equal(goalEvent._tag, "Some");
      if (goalEvent._tag === "Some" && goalEvent.value.type === "goal.updated") {
        assert.deepEqual(goalEvent.value.payload.goal, {
          objective: "Ship goal support",
          status: "active",
          tokenBudget: 5_000_000,
          tokensUsed: 1_200_000,
          timeUsedSeconds: 42,
          createdAt: new Date(1_760_000_000_000).toISOString(),
          updatedAt: new Date(1_760_000_400_000).toISOString(),
        });
      }
    }),
  );

  it.effect("sets and clears a thread goal through the session runtime", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      assert.ok(adapter.setThreadGoal);
      assert.ok(adapter.clearThreadGoal);

      const goal = yield* adapter.setThreadGoal({
        threadId: asThreadId("thread-1"),
        objective: "Ship goal support",
        tokenBudget: 1_000,
      });
      assert.equal(goal.objective, "Ship goal support");
      assert.equal(goal.status, "active");
      assert.equal(goal.tokenBudget, 1_000);
      assert.equal(runtime.setGoalImpl.mock.calls.length, 1);

      yield* adapter.clearThreadGoal(asThreadId("thread-1"));
      assert.equal(runtime.clearGoalImpl.mock.calls.length, 1);
      assert.equal(runtime.goalState, null);
    }),
  );

  it.effect("maps safety-buffering updates and preserves a remapped parent turn", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-safety-buffering"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-07-09T00:00:00.000Z",
        method: "model/safetyBuffering/updated",
        threadId: asThreadId("thread-1"),
        providerThreadId: "provider-child-thread-1",
        turnId: asTurnId("parent-turn-1"),
        payload: {
          threadId: "provider-child-thread-1",
          turnId: "provider-child-turn-1",
          model: "gpt-5.6-sol",
          useCases: ["cyber"],
          reasons: ["additional-review"],
          showBufferingUi: true,
          fasterModel: "gpt-5.5",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.deepStrictEqual(firstEvent.value, {
        type: "model.safety-buffering.updated",
        eventId: "evt-safety-buffering",
        provider: "codex",
        threadId: "thread-1",
        createdAt: "2026-07-09T00:00:00.000Z",
        turnId: "parent-turn-1",
        providerRefs: {
          providerThreadId: "provider-child-thread-1",
          providerTurnId: "parent-turn-1",
        },
        raw: {
          source: "codex.app-server.notification",
          method: "model/safetyBuffering/updated",
          payload: {
            threadId: "provider-child-thread-1",
            turnId: "provider-child-turn-1",
            model: "gpt-5.6-sol",
            useCases: ["cyber"],
            reasons: ["additional-review"],
            showBufferingUi: true,
            fasterModel: "gpt-5.5",
          },
        },
        payload: {
          model: "gpt-5.6-sol",
          useCases: ["cyber"],
          reasons: ["additional-review"],
          showBufferingUi: true,
          fasterModel: "gpt-5.5",
        },
      });
    }),
  );

  it.effect("uses item startedAtMs for canonical item.started timestamps", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-msg-started"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("msg_1"),
        payload: {
          startedAtMs: 1_778_000_001_234,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "msg_1",
            text: "draft",
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.started");
      if (firstEvent.value.type !== "item.started") {
        return;
      }
      assert.equal(firstEvent.value.createdAt, "2026-05-05T16:53:21.234Z");
      assert.equal(firstEvent.value.itemId, "msg_1");
      assert.equal(firstEvent.value.payload.itemType, "assistant_message");
    }),
  );

  it.effect("maps completed agent message items to canonical item.completed events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-msg-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("msg_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "msg_1",
            text: "done",
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.createdAt, "2026-05-05T16:53:20.000Z");
      assert.equal(firstEvent.value.itemId, "msg_1");
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.itemType, "assistant_message");
    }),
  );

  it.effect("maps completed Codex review items with their final review text", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-review-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-review"),
        itemId: asItemId("review_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-review",
          item: {
            type: "exitedReviewMode",
            id: "review_1",
            review: "Found one correctness issue in the reconnect path.",
          },
        },
      });
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.payload.itemType, "review_exited");
      assert.equal(firstEvent.value.payload.title, "Review completed");
      assert.equal(
        firstEvent.value.payload.detail,
        "Found one correctness issue in the reconnect path.",
      );
    }),
  );

  it.effect("maps context compaction items to canonical lifecycle events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-context-compaction-started"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("compact_1"),
        payload: {
          startedAtMs: 1_778_000_001_234,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "contextCompaction",
            id: "compact_1",
            summary: "Summarizing earlier context",
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.started");
      if (firstEvent.value.type !== "item.started") {
        return;
      }
      assert.equal(firstEvent.value.payload.itemType, "context_compaction");
      assert.equal(firstEvent.value.payload.status, "inProgress");
      assert.equal(firstEvent.value.payload.detail, "Summarizing earlier context");
    }),
  );

  it.effect("maps completed plan items to canonical proposed-plan completion events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-plan-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "plan",
            id: "plan_1",
            text: "## Final plan\n\n- one\n- two",
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.proposed.completed");
      if (firstEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.planMarkdown, "## Final plan\n\n- one\n- two");
    }),
  );

  it.effect("maps Codex thread/deleted notifications to canonical thread state events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-thread-deleted"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/deleted",
        threadId: asThreadId("thread-1"),
        payload: {
          threadId: "provider-thread-1",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "thread.state.changed");
      if (firstEvent.value.type !== "thread.state.changed") {
        return;
      }
      assert.equal(firstEvent.value.payload.state, "deleted");
      assert.deepEqual(firstEvent.value.payload.detail, {
        threadId: "provider-thread-1",
      });
    }),
  );

  it.effect("maps raw response web search completions to canonical completed tool events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-raw-web-search-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "rawResponseItem/completed",
        threadId: asThreadId("thread-1"),
        payload: {
          threadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "web_search_call",
            id: "ws_1",
            status: "completed",
            action: {
              type: "search",
              query: "activity feed stale",
            },
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.itemId, "ws_1");
      assert.equal(firstEvent.value.payload.itemType, "web_search");
      assert.equal(firstEvent.value.payload.status, "completed");
      assert.equal(firstEvent.value.payload.detail, "activity feed stale");
    }),
  );

  it.effect("maps plan deltas to canonical proposed-plan delta events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-plan-delta"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/plan/delta",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "plan_1",
          delta: "## Final plan",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.proposed.delta");
      if (firstEvent.value.type !== "turn.proposed.delta") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.delta, "## Final plan");
    }),
  );

  it.effect("maps session/closed lifecycle events to canonical session.exited runtime events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-session-closed"),
        kind: "session",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "session/closed",
        message: "Session stopped",
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "session.exited");
      if (firstEvent.value.type !== "session.exited") {
        return;
      }
      assert.equal(firstEvent.value.threadId, "thread-1");
      assert.equal(firstEvent.value.payload.reason, "Session stopped");
    }),
  );

  it.effect("maps retryable Codex error notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-retryable-error"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "error",
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          error: {
            message: "Reconnecting... 2/5",
          },
          willRetry: true,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.message, "Reconnecting... 2/5");
      assert.equal(firstEvent.value.payload.warningKind, "api-retry");
    }),
  );

  it.effect("maps process stderr notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-process-stderr"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message: "The filename or extension is too long. (os error 206)",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(
        firstEvent.value.payload.message,
        "The filename or extension is too long. (os error 206)",
      );
    }),
  );

  it.effect("maps realtime started notifications with upstream realtime session ids", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-realtime-started"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/realtime/started",
        payload: {
          threadId: "thread-1",
          realtimeSessionId: "realtime-session-1",
          version: "v2",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "thread.realtime.started");
      if (firstEvent.value.type !== "thread.realtime.started") {
        return;
      }
      assert.equal(firstEvent.value.threadId, "thread-1");
      assert.equal(firstEvent.value.payload.realtimeSessionId, "realtime-session-1");
    }),
  );

  it.effect("maps fatal websocket stderr notifications to runtime.error", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-process-stderr-websocket"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message:
          "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.error");
      if (firstEvent.value.type !== "runtime.error") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.class, "provider_error");
      assert.equal(
        firstEvent.value.payload.message,
        "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      );
    }),
  );

  it.effect("adds login guidance to Codex authentication runtime errors", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const authRecoveryEventsFiber = yield* Stream.filter(
        adapter.streamEvents,
        (event) => event.type === "runtime.error" || event.type === "session.exited",
      ).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-codex-auth-error"),
        kind: "error",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "error",
        message: "Not logged in",
      } satisfies ProviderEvent);

      const authRecoveryEvents = Array.from(yield* Fiber.join(authRecoveryEventsFiber));
      const runtimeError = authRecoveryEvents.find((event) => event.type === "runtime.error");
      const sessionExited = authRecoveryEvents.find((event) => event.type === "session.exited");

      assert.equal(runtimeError?.type, "runtime.error");
      if (runtimeError?.type !== "runtime.error") {
        return;
      }
      assert.equal(
        runtimeError.payload.message,
        "Not logged in Run `codex login` in a terminal, then retry.",
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
      assert.equal(runtime.closeImpl.mock.calls.length, 1);
    }),
  );

  it.effect("preserves Codex permission approval environment identity", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-permission-request"),
        kind: "request",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-06-04T00:00:00.000Z",
        method: "item/permissions/requestApproval",
        requestKind: "permissions",
        requestId: ApprovalRequestId.make("req-permissions-1"),
        payload: {
          cwd: "/tmp/project",
          environmentId: "environment-remote",
          itemId: "item-permissions-1",
          permissions: {
            network: {
              enabled: true,
            },
          },
          startedAtMs: 1_800_000_000_000,
          threadId: "provider-thread-1",
          turnId: "turn-1",
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.opened");
      if (firstEvent.value.type !== "request.opened") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "permissions_approval");
      assert.equal(firstEvent.value.payload.environmentId, "environment-remote");
      assert.equal(firstEvent.value.payload.detail, "Requesting network access");
    }),
  );

  it.effect("preserves request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-request-resolved"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "serverRequest/resolved",
        requestKind: "command",
        requestId: ApprovalRequestId.make("req-1"),
        payload: {
          threadId: "thread-1",
          requestId: "req-1",
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "command_execution_approval");
    }),
  );

  it.effect("preserves file-read request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-file-read-request-resolved"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "serverRequest/resolved",
        requestKind: "file-read",
        requestId: ApprovalRequestId.make("req-file-read-1"),
        payload: {
          threadId: "thread-1",
          requestId: "req-file-read-1",
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "file_read_approval");
    }),
  );

  it.effect("preserves explicit empty multi-select user-input answers", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-user-input-empty"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/tool/requestUserInput/answered",
        payload: {
          answers: {
            scope: {
              answers: [],
            },
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "user-input.resolved");
      if (firstEvent.value.type !== "user-input.resolved") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload.answers, {
        scope: [],
      });
    }),
  );

  it.effect("maps windowsSandbox/setupCompleted to session state and warning on failure", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      const event: ProviderEvent = {
        id: asEventId("evt-windows-sandbox-failed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "windowsSandbox/setupCompleted",
        message: "Sandbox setup failed",
        payload: {
          mode: "unelevated",
          success: false,
          error: "unsupported environment",
        },
      };

      yield* runtime.emit(event);
      const events = Array.from(yield* Fiber.join(eventsFiber));

      assert.equal(events.length, 2);

      const firstEvent = events[0];
      const secondEvent = events[1];

      assert.equal(firstEvent?.type, "session.state.changed");
      if (firstEvent?.type === "session.state.changed") {
        assert.equal(firstEvent.payload.state, "error");
        assert.equal(firstEvent.payload.reason, "Sandbox setup failed");
      }

      assert.equal(secondEvent?.type, "runtime.warning");
      if (secondEvent?.type === "runtime.warning") {
        assert.equal(secondEvent.payload.message, "Sandbox setup failed");
      }
    }),
  );

  it.effect(
    "maps requestUserInput requests and answered notifications to canonical user-input events",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
          Effect.forkChild,
        );

        yield* runtime.emit({
          id: asEventId("evt-user-input-requested"),
          kind: "request",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/tool/requestUserInput",
          requestId: ApprovalRequestId.make("req-user-input-1"),
          payload: {
            itemId: "item-user-input-1",
            threadId: "thread-1",
            turnId: "turn-1",
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
        } satisfies ProviderEvent);
        yield* runtime.emit({
          id: asEventId("evt-user-input-resolved"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/tool/requestUserInput/answered",
          requestId: ApprovalRequestId.make("req-user-input-1"),
          payload: {
            answers: {
              sandbox_mode: {
                answers: ["workspace-write"],
              },
            },
          },
        } satisfies ProviderEvent);

        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.equal(events[0]?.type, "user-input.requested");
        if (events[0]?.type === "user-input.requested") {
          assert.equal(events[0].requestId, "req-user-input-1");
          assert.equal(events[0].payload.questions[0]?.id, "sandbox_mode");
          assert.equal(events[0].payload.questions[0]?.multiSelect, false);
        }

        assert.equal(events[1]?.type, "user-input.resolved");
        if (events[1]?.type === "user-input.resolved") {
          assert.equal(events[1].requestId, "req-user-input-1");
          assert.deepEqual(events[1].payload.answers, {
            sandbox_mode: "workspace-write",
          });
        }
      }),
  );

  it.effect("unwraps Codex token usage payloads for context window events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-codex-thread-token-usage-updated"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/tokenUsage/updated",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              inputTokens: 11_833,
              cachedInputTokens: 3456,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 11_839,
            },
            last: {
              inputTokens: 120,
              cachedInputTokens: 0,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 126,
            },
            modelContextWindow: 258_400,
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "thread.token-usage.updated");
      if (firstEvent.value.type !== "thread.token-usage.updated") {
        return;
      }

      assert.deepEqual(firstEvent.value.payload.usage, {
        usedTokens: 126,
        totalProcessedTokens: 11_839,
        maxTokens: 258_400,
        inputTokens: 120,
        cachedInputTokens: 0,
        outputTokens: 6,
        reasoningOutputTokens: 0,
        lastUsedTokens: 126,
        lastInputTokens: 120,
        lastCachedInputTokens: 0,
        lastOutputTokens: 6,
        lastReasoningOutputTokens: 0,
        compactsAutomatically: true,
      });
    }),
  );
});

const scopedLifecycleRuntimeFactory = makeScopedRuntimeFactory();
const scopedLifecycleLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: scopedLifecycleRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

scopedLifecycleLayer("CodexAdapterLive scoped lifecycle", (it) => {
  it.effect("closes the externally owned session scope on stopSession", () =>
    Effect.gen(function* () {
      scopedLifecycleRuntimeFactory.releasedThreadIds.length = 0;
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-stop"),
        runtimeMode: "full-access",
      });

      const runtime = scopedLifecycleRuntimeFactory.lastRuntime;
      assert.ok(runtime);

      yield* adapter.stopSession(asThreadId("thread-stop"));

      assert.equal(runtime.closeImpl.mock.calls.length, 1);
      assert.deepStrictEqual(scopedLifecycleRuntimeFactory.releasedThreadIds, [
        asThreadId("thread-stop"),
      ]);
      assert.equal(yield* adapter.hasSession(asThreadId("thread-stop")), false);
    }),
  );
});

const scopedFailureRuntimeFactory = makeScopedRuntimeFactory({ failConstruction: true });
const scopedFailureLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: scopedFailureRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

scopedFailureLayer("CodexAdapterLive scoped startup failure", (it) => {
  it.effect("closes the externally owned session scope when startSession fails", () =>
    Effect.gen(function* () {
      scopedFailureRuntimeFactory.releasedThreadIds.length = 0;
      const adapter = yield* CodexAdapter;

      const result = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-fail"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.equal(result.failure._tag, "ProviderAdapterProcessError");
      assert.deepStrictEqual(scopedFailureRuntimeFactory.releasedThreadIds, [
        asThreadId("thread-fail"),
      ]);
      assert.equal(yield* adapter.hasSession(asThreadId("thread-fail")), false);
    }),
  );
});

it.effect("flushes managed native logs when the adapter layer shuts down", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-codex-adapter-native-log-"));
    const basePath = path.join(tempDir, "provider-native.ndjson");
    const runtimeFactory = makeRuntimeFactory();
    const scope = yield* Scope.make("sequential");
    let scopeClosed = false;

    try {
      const layer = Layer.effect(
        CodexAdapter,
        Effect.gen(function* () {
          const codexConfig = decodeCodexSettings({});
          return yield* makeCodexAdapter(codexConfig, {
            makeRuntime: runtimeFactory.factory,
            nativeEventLogPath: basePath,
          });
        }),
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );
      const context = yield* Layer.buildWithScope(layer, scope);
      const adapter = yield* Effect.service(CodexAdapter).pipe(Effect.provide(context));

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        runtimeMode: "full-access",
      });

      const runtime = runtimeFactory.lastRuntime;
      assert.ok(runtime);

      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* runtime.emit({
        id: asEventId("evt-native-log"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        message: "native flush test",
      } satisfies ProviderEvent);
      yield* Fiber.join(firstEventFiber);

      yield* Scope.close(scope, Exit.void);
      scopeClosed = true;

      const threadLogPath = path.join(tempDir, "thread-logger.log");
      assert.equal(fs.existsSync(threadLogPath), true);
      const contents = fs.readFileSync(threadLogPath, "utf8");
      assert.match(contents, /NTIVE: .*"message":"native flush test"/);
    } finally {
      if (!scopeClosed) {
        yield* Scope.close(scope, Exit.void);
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }),
);
