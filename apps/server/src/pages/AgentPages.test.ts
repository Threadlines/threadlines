// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type OrchestrationAgentPage,
  type OrchestrationCommand,
  type OrchestrationThread,
  ThreadId,
  ThreadParticipantId,
  TurnId,
} from "@threadlines/contracts";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import type { McpInvocationScope } from "../mcp/McpSessionRegistry.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadPageRepository } from "../persistence/Services/ProjectionThreadPages.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AgentPages, layer as AgentPagesLayer } from "./AgentPages.ts";
import * as PagePreview from "./preview/PagePreview.ts";

const THREAD = ThreadId.make("thread-pages");
const TURN = TurnId.make("turn-1");
const NEXT_TURN = TurnId.make("turn-2");
const OTHER = ThreadParticipantId.make("participant-other");

const caller = (overrides: Partial<McpInvocationScope> = {}): McpInvocationScope => ({
  threadId: THREAD,
  sessionKey: THREAD,
  participantId: null,
  generation: 1,
  agentId: "agent-test",
  browser: true,
  pages: true,
  roomTools: new Set(),
  ...overrides,
});

const threadWith = (
  session: {
    readonly participantId: ThreadParticipantId | null;
    readonly activeTurnId: TurnId | null;
  },
  rest: {
    readonly latestTurnId?: TurnId;
    /** Turns that messages already in the thread are stamped with. */
    readonly messageTurnIds?: ReadonlyArray<TurnId>;
    readonly pages?: ReadonlyArray<Partial<OrchestrationAgentPage>>;
  } = {},
): OrchestrationThread =>
  ({
    id: THREAD,
    deletedAt: null,
    pages: rest.pages ?? [],
    messages: (rest.messageTurnIds ?? []).map((turnId) => ({ turnId })),
    latestTurn: rest.latestTurnId !== undefined ? { turnId: rest.latestTurnId } : null,
    session: { ...session, status: "running" },
  }) as unknown as OrchestrationThread;

let readCount = 0;
const makeLayer = (options: {
  /** The thread each read sees, in order; the last one repeats. */
  readonly thread: OrchestrationThread | ReadonlyArray<OrchestrationThread>;
  readonly dispatched: Array<OrchestrationCommand>;
  readonly enabled?: boolean;
}) =>
  AgentPagesLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadDetailById: () => {
            const reads = Array.isArray(options.thread) ? options.thread : [options.thread];
            const thread = reads[Math.min(readCount++, reads.length - 1)]!;
            return Effect.succeed(Option.some(thread));
          },
        }),
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.sync(() => {
              options.dispatched.push(command);
              return { sequence: options.dispatched.length };
            }),
        }),
        Layer.mock(ProjectionThreadPageRepository)({}),
        ServerSettingsService.layerTest({ enableAgentPages: options.enabled ?? true }),
        Layer.mock(PagePreview.PagePreview)({
          measure: () => Effect.succeed(Option.none()),
        }),
        ServerConfig.layerTest(process.cwd(), { prefix: "tl-agent-pages-test-" }),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

it.layer(NodeServices.layer)("AgentPages.show", (it) => {
  it.effect("shows nothing when the turn ends while the page is being prepared", () => {
    readCount = 0;
    const dispatched: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      const pages = yield* AgentPages;
      const outcome = yield* pages.show(caller(), { title: "Funnel", html: "<p>chart</p>" });
      assert.strictEqual(outcome.outcome, "not_allowed");
      assert.strictEqual(dispatched.length, 0);
    }).pipe(
      Effect.provide(
        makeLayer({
          thread: [
            threadWith({ participantId: null, activeTurnId: TURN }),
            threadWith({ participantId: null, activeTurnId: null }),
          ],
          dispatched,
        }),
      ),
    );
  });

  it.effect("records the page on the turn the calling agent is working on", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      const pages = yield* AgentPages;
      const outcome = yield* pages.show(caller(), { title: "Funnel", html: "<p>chart</p>" });
      assert.strictEqual(outcome.outcome, "shown");
      assert.strictEqual(dispatched.length, 1);
      const command = dispatched[0];
      assert.strictEqual(command?.type, "thread.page.publish");
      if (command?.type === "thread.page.publish") {
        assert.strictEqual(command.page.turnId, TURN);
        assert.strictEqual(command.page.version, 1);
        assert.strictEqual(command.page.participantId, null);
      }
    }).pipe(
      Effect.provide(
        makeLayer({
          thread: threadWith({ participantId: null, activeTurnId: TURN }),
          dispatched,
        }),
      ),
    );
  });

  it.effect(
    "refuses an agent that does not hold the thread, so a page never lands on another's turn",
    () => {
      const dispatched: Array<OrchestrationCommand> = [];
      return Effect.gen(function* () {
        const pages = yield* AgentPages;
        // It waits a moment for a turn a provider has not reported yet, then gives up.
        const pending = yield* Effect.forkChild(
          pages.show(caller(), { title: "Funnel", html: "<p>chart</p>" }),
        );
        yield* TestClock.adjust(Duration.seconds(4));
        const outcome = yield* Fiber.join(pending);
        assert.strictEqual(outcome.outcome, "not_allowed");
        assert.strictEqual(dispatched.length, 0);
      }).pipe(
        Effect.provide(
          makeLayer({
            thread: threadWith({ participantId: OTHER, activeTurnId: TURN }),
            dispatched,
          }),
        ),
      );
    },
  );

  it.effect("refuses while pages are switched off", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      const pages = yield* AgentPages;
      const outcome = yield* pages.show(caller(), { title: "Funnel", html: "<p>chart</p>" });
      assert.strictEqual(outcome.outcome, "off");
      assert.strictEqual(dispatched.length, 0);
    }).pipe(
      Effect.provide(
        makeLayer({
          thread: threadWith({ participantId: null, activeTurnId: TURN }),
          dispatched,
          enabled: false,
        }),
      ),
    );
  });

  it.effect("refuses an update to a page this thread never showed", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      const pages = yield* AgentPages;
      const outcome = yield* pages.show(caller(), {
        title: "Funnel",
        html: "<p>chart</p>",
        pageId: "11111111-1111-4111-8111-111111111111",
      });
      assert.strictEqual(outcome.outcome, "refused");
      assert.strictEqual(dispatched.length, 0);
    }).pipe(
      Effect.provide(
        makeLayer({
          thread: threadWith({ participantId: null, activeTurnId: TURN }),
          dispatched,
        }),
      ),
    );
  });
});

it.layer(NodeServices.layer)("AgentPages.adopt", (it) => {
  const LINK = "https://claude.ai/artifact/abc123";
  const publishedFile = (name: string, content: string) => {
    const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "tl-adopt-page-test-"));
    const path = NodePath.join(dir, name);
    NodeFs.writeFileSync(path, content);
    return path;
  };

  it.effect(
    "shows the file a provider published with its link, though the next turn has already started",
    () => {
      readCount = 0;
      const dispatched: Array<OrchestrationCommand> = [];
      return Effect.gen(function* () {
        const pages = yield* AgentPages;
        const outcome = yield* pages.adopt({
          threadId: THREAD,
          turnId: TURN,
          participantId: null,
          path: publishedFile("sales-report.html", "<h1>Sales</h1>"),
          shareUrl: LINK,
          icon: "chart",
        });
        assert.strictEqual(outcome.outcome, "shown");
        const command = dispatched[0];
        assert.strictEqual(command?.type, "thread.page.publish");
        if (command?.type === "thread.page.publish") {
          assert.strictEqual(command.page.turnId, TURN);
          assert.strictEqual(command.page.kind, "html");
          assert.strictEqual(command.page.shareUrl, LINK);
          // No title from the provider: the file's own name.
          assert.strictEqual(command.page.title, "sales-report");
        }
      }).pipe(
        Effect.provide(
          makeLayer({
            thread: [
              threadWith({ participantId: null, activeTurnId: TURN }),
              // The agent answered and a queued message started the next
              // turn while the page was being read.
              threadWith(
                { participantId: null, activeTurnId: NEXT_TURN },
                { latestTurnId: NEXT_TURN, messageTurnIds: [TURN] },
              ),
            ],
            dispatched,
          }),
        ),
      );
    },
  );

  it.effect("updates the page already showing a link that is published again", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    const shown = { pageId: "22222222-2222-4222-8222-222222222222", version: 3, shareUrl: LINK };
    return Effect.gen(function* () {
      const pages = yield* AgentPages;
      yield* pages.adopt({
        threadId: THREAD,
        turnId: TURN,
        participantId: null,
        path: publishedFile("notes.md", "# Notes"),
        shareUrl: LINK,
        title: "Notes",
      });
      const command = dispatched[0];
      assert.strictEqual(command?.type, "thread.page.publish");
      if (command?.type === "thread.page.publish") {
        assert.strictEqual(command.page.pageId, shown.pageId);
        assert.strictEqual(command.page.version, 4);
        assert.strictEqual(command.page.kind, "markdown");
      }
    }).pipe(
      Effect.provide(
        makeLayer({
          thread: threadWith(
            { participantId: null, activeTurnId: TURN },
            { pages: [shown as Partial<OrchestrationAgentPage>] },
          ),
          dispatched,
        }),
      ),
    );
  });

  it.effect(
    "shows nothing for a turn taken back, a link that is not https, or a file that is no page",
    () => {
      const dispatched: Array<OrchestrationCommand> = [];
      const publish = { threadId: THREAD, turnId: TURN, participantId: null } as const;
      return Effect.gen(function* () {
        const pages = yield* AgentPages;
        const takenBack = yield* pages.adopt({
          ...publish,
          turnId: TurnId.make("turn-taken-back"),
          path: publishedFile("report.html", "<p>report</p>"),
          shareUrl: LINK,
        });
        assert.strictEqual(takenBack.outcome, "not_allowed");
        const plainLink = yield* pages.adopt({
          ...publish,
          path: publishedFile("report.html", "<p>report</p>"),
          shareUrl: "http://claude.ai/artifact/abc123",
        });
        assert.strictEqual(plainLink.outcome, "refused");
        const notAPage = yield* pages.adopt({
          ...publish,
          path: publishedFile("secrets.env", "TOKEN=1"),
          shareUrl: LINK,
        });
        assert.strictEqual(notAPage.outcome, "refused");
        assert.strictEqual(dispatched.length, 0);
      }).pipe(
        Effect.provide(
          makeLayer({
            thread: threadWith({ participantId: null, activeTurnId: TURN }, { latestTurnId: TURN }),
            dispatched,
          }),
        ),
      );
    },
  );
});
