// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type OrchestrationAgentPage,
  type OrchestrationCommand,
  type OrchestrationThread,
  THEME_FILE_FORMAT,
  type ThemeManifest,
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

import {
  makeSecretScrubber,
  SecretScrubber,
  type SecretScrubberShape,
} from "../secrets/SecretScrubber.ts";
import { ServerConfig } from "../config.ts";
import type { McpInvocationScope } from "../mcp/McpSessionRegistry.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadPageRepository } from "../persistence/Services/ProjectionThreadPages.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
import { ThemeVsCode } from "../themes/ThemeVsCode.ts";
import { ThemeWorkshop } from "../themes/ThemeWorkshop.ts";
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
  commands: false,
  device: false,
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

const VSCODE_EXTENSION = {
  namespace: "someone",
  name: "night",
  version: "1.0.0",
  displayName: "Night",
  publisher: "someone",
  description: "",
  downloads: 10,
  license: "MIT",
  themeCount: 1,
};
const VSCODE_THEME: ThemeManifest = {
  format: THEME_FILE_FORMAT,
  name: "Night Storm",
  base: "dark",
  colors: {
    background: "#0a1029",
    foreground: "#e7ecff",
    mutedForeground: "#a3aed2",
    accent: "#2fd6b0",
    accentForeground: "#03231c",
  },
  credits: { author: "Someone", license: "MIT" },
  createdBy: { kind: "imported", vscode: { theme: "Night Storm", extension: "someone.night" } },
};

let readCount = 0;
/** What the pages counted, as PostHog would get it. */
const recordedEvents: Array<{ event: string; properties: unknown }> = [];
const makeLayer = (options: {
  /** The thread each read sees, in order; the last one repeats. */
  readonly thread: OrchestrationThread | ReadonlyArray<OrchestrationThread>;
  readonly dispatched: Array<OrchestrationCommand>;
  readonly enabled?: boolean;
  /** Each document handed to the preview browser. */
  readonly previewed?: Array<string>;
  /** Each document measured for its height. */
  readonly measured?: Array<string>;
  /** The watched keys; none by default. */
  readonly secretScrubber?: SecretScrubberShape;
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
          getThreadShellById: () => Effect.succeed(Option.some({} as never)),
        }),
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.sync(() => {
              options.dispatched.push(command);
              return { sequence: options.dispatched.length };
            }),
        }),
        // Every stored version reads back as the kind its publish recorded.
        Layer.mock(ProjectionThreadPageRepository)({
          getVersion: () =>
            Effect.sync(() => {
              const published = options.dispatched.findLast(
                (command) => command.type === "thread.page.publish",
              );
              return published?.type === "thread.page.publish"
                ? ({ kind: published.page.kind } as never)
                : undefined;
            }),
        }),
        ServerSettingsService.layerTest({ enableAgentPages: options.enabled ?? true }),
        Layer.succeed(SecretScrubber, options.secretScrubber ?? makeSecretScrubber()),
        Layer.mock(PagePreview.PagePreview)({
          measure: ({ document }) =>
            Effect.sync(() => {
              options.measured?.push(document);
              return Option.none();
            }),
          preview: ({ document, width }) =>
            Effect.sync(() => {
              options.previewed?.push(document);
              return { png: "", width, contentHeight: 0, capturedHeight: 0, consoleMessages: [] };
            }),
        }),
        ServerConfig.layerTest(process.cwd(), { prefix: "tl-agent-pages-test-" }),
        // Fonts are already embedded and a still is "captured": no network, no browser.
        Layer.mock(ThemeWorkshop)({
          embedFonts: (manifest) => Effect.succeed(manifest),
          withStill: (manifest) => Effect.succeed({ manifest }),
        }),
        // One extension with one theme, as the store would give it.
        Layer.mock(ThemeVsCode)({
          search: () => Effect.succeed({ extensions: [VSCODE_EXTENSION], nextOffset: null }),
          read: () =>
            Effect.succeed({
              extension: VSCODE_EXTENSION,
              themes: [
                {
                  label: "Night Storm",
                  file: "extension/themes/storm.json",
                  base: "dark" as const,
                  colors: { background: "#0a1029", foreground: "#e7ecff", accent: "#2fd6b0" },
                  manifest: VSCODE_THEME,
                  adjusted: 2,
                },
              ],
              skipped: [],
            }),
        }),
        Layer.succeed(AnalyticsService, {
          record: (event, properties) =>
            Effect.sync(() => recordedEvents.push({ event, properties })),
          flush: Effect.void,
        }),
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

  it.effect("refuses a page that holds a saved key, and records nothing", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    const secretScrubber = makeSecretScrubber();
    secretScrubber.watch("STRIPE_SECRET_KEY", "sk_test_51Hq9xYz");
    return Effect.gen(function* () {
      const pages = yield* AgentPages;
      const outcome = yield* pages.show(caller(), {
        title: "Setup",
        html: "<p>Your key: sk_test_51Hq9xYz</p>",
      });
      assert.deepStrictEqual(outcome, {
        outcome: "refused",
        detail:
          "Your page contains STRIPE_SECRET_KEY. Don't put a key on a page; name the file it is in instead.",
      });
      assert.strictEqual(dispatched.length, 0);
    }).pipe(
      Effect.provide(
        makeLayer({
          thread: threadWith({ participantId: null, activeTurnId: TURN }),
          dispatched,
          secretScrubber,
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

it.layer(NodeServices.layer)("AgentPages.preview", (it) => {
  it.effect("renders a Markdown page as the chat shows it, and refuses one given both ways", () => {
    const previewed: Array<string> = [];
    return Effect.gen(function* () {
      const pages = yield* AgentPages;
      const outcome = yield* pages.preview(caller(), { markdown: "# Plan\n\n- ship it" });
      assert.strictEqual(outcome.outcome, "previewed");
      assert.include(previewed[0], '<article class="tl-document"><h1>Plan</h1>');
      const both = yield* pages.preview(caller(), { html: "<p>plan</p>", markdown: "# Plan" });
      assert.strictEqual(both.outcome, "refused");
      assert.strictEqual(previewed.length, 1);
    }).pipe(
      Effect.provide(
        makeLayer({
          thread: threadWith({ participantId: null, activeTurnId: TURN }),
          dispatched: [],
          previewed,
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

  it.effect("hides a saved key in a page it adopts, since that call can't be refused", () => {
    readCount = 0;
    const dispatched: Array<OrchestrationCommand> = [];
    const measured: Array<string> = [];
    const secretScrubber = makeSecretScrubber();
    secretScrubber.watch("STRIPE_SECRET_KEY", "sk_test_51Hq9xYz");
    return Effect.gen(function* () {
      const pages = yield* AgentPages;
      const outcome = yield* pages.adopt({
        threadId: THREAD,
        turnId: TURN,
        participantId: null,
        path: publishedFile("keys.html", "<p>Your key: sk_test_51Hq9xYz</p>"),
        title: "Key sk_test_51Hq9xYz",
        shareUrl: LINK,
      });
      assert.strictEqual(outcome.outcome, "shown");
      const command = dispatched[0];
      assert.strictEqual(command?.type, "thread.page.publish");
      if (command?.type === "thread.page.publish") {
        assert.strictEqual(command.page.title, "Key [STRIPE_SECRET_KEY hidden]");
      }
      assert.ok(measured[0]?.includes("Your key: [STRIPE_SECRET_KEY hidden]"));
      assert.ok(!measured.some((document) => document.includes("sk_test_51Hq9xYz")));
    }).pipe(
      Effect.provide(
        makeLayer({
          thread: threadWith({ participantId: null, activeTurnId: TURN }),
          dispatched,
          measured,
          secretScrubber,
        }),
      ),
    );
  });

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

it.layer(NodeServices.layer)("AgentPages.showTheme", (it) => {
  const aurora: ThemeManifest = {
    format: THEME_FILE_FORMAT,
    name: "Aurora",
    base: "dark",
    colors: {
      background: "#0a1029",
      foreground: "#e7ecff",
      mutedForeground: "#a3aed2",
      accent: "#2fd6b0",
      accentForeground: "#03231c",
    },
  };

  it.effect(
    "shows a theme as a page of kind theme whose stored version is the theme, without measuring",
    () => {
      const dispatched: Array<OrchestrationCommand> = [];
      const measured: Array<string> = [];
      return Effect.gen(function* () {
        const pages = yield* AgentPages;
        recordedEvents.length = 0;
        const outcome = yield* pages.showTheme(caller(), { theme: aurora });
        assert.strictEqual(outcome.outcome, "shown");
        assert.deepStrictEqual(recordedEvents, [
          {
            event: "theme.offered",
            properties: {
              origin: "agent",
              base: "dark",
              art: "none",
              customFonts: false,
              revised: false,
            },
          },
        ]);
        const command = dispatched[0];
        if (command?.type !== "thread.page.publish") return assert.fail("no publish");
        assert.strictEqual(command.page.kind, "theme");
        assert.strictEqual(command.page.title, "Aurora");
        assert.strictEqual(command.page.turnId, TURN);
        assert.strictEqual(command.page.height, 72);
        assert.strictEqual(command.page.heights, undefined);
        assert.deepStrictEqual(measured, []);
        // Clients read the stored version back as the theme itself.
        const read = yield* pages.read({
          threadId: THREAD,
          pageId: command.page.pageId,
          versionId: command.page.versionId,
        });
        assert.strictEqual(read.kind, "theme");
        // It says which offer it is, so a later version kept updates the earlier copy.
        assert.deepStrictEqual(JSON.parse(read.content), {
          ...aurora,
          createdBy: {
            kind: "agent",
            threadId: THREAD,
            offer: { threadId: THREAD, pageId: command.page.pageId },
          },
        });
      }).pipe(
        Effect.provide(
          makeLayer({
            thread: threadWith({ participantId: null, activeTurnId: TURN }),
            dispatched,
            measured,
          }),
        ),
      );
    },
  );

  it.effect(
    "finds a VS Code theme as a file show_theme offers, still saying where it came from",
    () => {
      const dispatched: Array<OrchestrationCommand> = [];
      return Effect.gen(function* () {
        const pages = yield* AgentPages;
        const found = yield* pages.findVsCodeTheme(caller(), { query: "night" });
        if (found.outcome !== "found") return assert.fail(`not found: ${JSON.stringify(found)}`);
        const [theme] = found.extensions[0]!.themes;
        assert.strictEqual(theme?.label, "Night Storm");
        assert.match(
          theme?.path ?? "",
          /vscode-someone-night-night-storm-[0-9a-f]{8}\.threadlines-theme$/,
        );
        // Found again, it's a new file: nothing already in the folder is written over.
        const again = yield* pages.findVsCodeTheme(caller(), { query: "night" });
        if (again.outcome !== "found") return assert.fail("not found again");
        assert.notStrictEqual(again.extensions[0]!.themes[0]!.path, theme?.path);
        const shown = yield* pages.showTheme(caller(), { path: theme!.path });
        assert.strictEqual(shown.outcome, "shown");
        const command = dispatched[0];
        if (command?.type !== "thread.page.publish") return assert.fail("no publish");
        const read = yield* pages.read({
          threadId: THREAD,
          pageId: command.page.pageId,
          versionId: command.page.versionId,
        });
        assert.deepStrictEqual(JSON.parse(read.content).createdBy, {
          kind: "imported",
          vscode: { theme: "Night Storm", extension: "someone.night" },
          offer: { threadId: THREAD, pageId: command.page.pageId },
        });
      }).pipe(
        Effect.provide(
          makeLayer({
            thread: threadWith({ participantId: null, activeTurnId: TURN }),
            dispatched,
          }),
        ),
      );
    },
  );

  it.effect("shows a theme again in its turn as the next version of the same row", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    const shown = {
      pageId: "33333333-3333-4333-8333-333333333333",
      version: 1,
      kind: "theme",
      turnId: TURN,
    } as const;
    return Effect.gen(function* () {
      const pages = yield* AgentPages;
      const outcome = yield* pages.showTheme(caller(), {
        theme: { ...aurora, name: "Aurora II" },
        pageId: shown.pageId,
      });
      assert.strictEqual(outcome.outcome, "shown");
      const command = dispatched[0];
      if (command?.type !== "thread.page.publish") return assert.fail("no publish");
      assert.strictEqual<string>(command.page.pageId, shown.pageId);
      assert.strictEqual(command.page.version, 2);
      assert.strictEqual(command.page.turnId, TURN);
      assert.strictEqual(command.page.title, "Aurora II");
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
    "refuses a theme that fails the readability checks, and a page id that isn't a theme",
    () => {
      const dispatched: Array<OrchestrationCommand> = [];
      const page = { pageId: "44444444-4444-4444-8444-444444444444", version: 1, kind: "html" };
      return Effect.gen(function* () {
        const pages = yield* AgentPages;
        const unreadable = yield* pages.showTheme(caller(), {
          theme: { ...aurora, colors: { ...aurora.colors, mutedForeground: "#11182f" } },
        });
        assert.strictEqual(unreadable.outcome, "refused");
        if (unreadable.outcome === "refused") assert.include(unreadable.detail, "muted-foreground");
        const notATheme = yield* pages.showTheme(caller(), { theme: aurora, pageId: page.pageId });
        assert.strictEqual(notATheme.outcome, "refused");
        const both = yield* pages.showTheme(caller(), { theme: aurora, path: "/tmp/a.json" });
        assert.strictEqual(both.outcome, "refused");
        assert.strictEqual(dispatched.length, 0);
      }).pipe(
        Effect.provide(
          makeLayer({
            thread: threadWith(
              { participantId: null, activeTurnId: TURN },
              { pages: [page as Partial<OrchestrationAgentPage>] },
            ),
            dispatched,
          }),
        ),
      );
    },
  );
});
