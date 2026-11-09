// @effect-diagnostics nodeBuiltinImport:off
/**
 * Agent pages (docs/agent-pages.md): what `show_page` and
 * `preview_page` do, and how clients read a stored page.
 *
 * A publish is tied to the agent that holds the thread and the turn it is in
 * when the call arrives, decided before anything slow happens, so a page can
 * never land on another agent's turn. The version file is written first and
 * then recorded with a `thread.page.publish` command; a file whose record
 * never commits is left for PageFileSweep rather than removed here, since an
 * interrupted call cannot know whether its command still commits.
 *
 * `adopt` is the other way a page arrives: a provider's own publishing tool
 * (a Claude artifact) put a local file online, and the chat shows that file
 * as a page of the turn that published it, with the link.
 *
 * `showTheme` and `previewTheme` are the theme tools
 * (docs/design/custom-themes.md): a theme an agent shows is a page of kind
 * `theme`, published the same way, whose version file is the theme's JSON.
 */
import { randomUUID } from "node:crypto";
import NodePath from "node:path";

import {
  AgentPageId,
  AgentPageReadError,
  type AgentPageKind,
  type AgentPageReadInput,
  type AgentPageReadResult,
  AgentPageVersionId,
  CommandId,
  type OrchestrationThread,
  type ThemeError,
  type ThemeFont,
  ThemeManifest,
  type ThreadId,
  type ThreadParticipantId,
  type TurnId,
} from "@threadlines/contracts";
import { checkThemeManifest } from "@threadlines/shared/themeManifest";
import {
  AGENT_PAGE_AUTO_HEIGHT_WIDTH,
  AGENT_PAGE_COLUMN_WIDTH,
  AGENT_PAGE_FALLBACK_THEMES,
  AGENT_PAGE_MAX_TITLE_LENGTH,
  AGENT_PAGE_MEASURE_FONTS,
  AGENT_PAGE_MEASURE_WIDTHS,
  type AgentPageHeights,
  agentPageFrameHeight,
  agentPageShareLink,
  agentPageTheme,
  clampAgentPageHeight,
  threadHasTurn,
} from "@threadlines/shared/agentPages";
import { buildAgentPageDocument } from "@threadlines/shared/agentPageDocument";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import { latchCallerTurn } from "../mcp/callerTurn.ts";
import type { McpInvocationScope } from "../mcp/McpSessionRegistry.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadPageRepository } from "../persistence/Services/ProjectionThreadPages.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { themeProblems, ThemeWorkshop } from "../themes/ThemeWorkshop.ts";
import { themeAnalyticsProperties } from "../telemetry/AnalyticsProperties.ts";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
import {
  type PageStoreError,
  ensurePageAssetsDir,
  inlinePageImages,
  isPageFileId,
  pageAssetsDir,
  pageVersionPath,
  readPageVersion,
  readPublishedPage,
  readThemeFile,
  removePageVersion,
  writePageVersion,
} from "./PageStore.ts";
import { PagePreview, type PagePreviewResult } from "./preview/PagePreview.ts";
import { THEME_PAGE_HEIGHT, themePageContent, themePreviewText } from "./themePages.ts";

/** What the agent asked to show. Exactly one of `html` and `markdown`. */
export interface ShowPageInput {
  readonly title: string;
  readonly html?: string | undefined;
  readonly markdown?: string | undefined;
  readonly height?: number | undefined;
  readonly pageId?: string | undefined;
  readonly icon?: string | undefined;
}

export type ShowPageOutcome =
  | {
      readonly outcome: "shown";
      readonly pageId: string;
      readonly version: number;
      readonly message: string;
    }
  | { readonly outcome: "off" | "not_allowed" | "refused" | "failed"; readonly detail: string };

/** A page a provider's own tool published online, to show in the turn that did it. */
export interface AdoptPageInput {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  /** The agent that published it. Null: the thread's own agent. */
  readonly participantId: ThreadParticipantId | null;
  /** The local file the provider published. */
  readonly path: string;
  /** Where the provider put it. */
  readonly shareUrl: string;
  readonly title?: string | undefined;
  readonly icon?: string | undefined;
}

/** What the agent asked to preview. Exactly one of `html` and `markdown`. */
export interface PreviewPageInput {
  readonly html?: string | undefined;
  readonly markdown?: string | undefined;
  readonly width?: number | undefined;
  readonly appearance?: "light" | "dark" | undefined;
}

export type PreviewPageOutcome =
  | { readonly outcome: "previewed"; readonly preview: PagePreviewResult }
  | { readonly outcome: "off" | "not_allowed" | "refused" | "failed"; readonly detail: string };

/** A theme for the theme tools: exactly one of the object and a file in the assets folder. */
export interface ThemeToolInput {
  readonly theme?: unknown;
  readonly path?: string | undefined;
}

export interface ShowThemeInput extends ThemeToolInput {
  readonly pageId?: string | undefined;
}

export type PreviewThemeOutcome =
  | {
      readonly outcome: "previewed";
      /** The checks, the art's cost and the console, worded for the agent. */
      readonly text: string;
      readonly shots: ReadonlyArray<{ readonly layout: string; readonly png: string }>;
    }
  | { readonly outcome: "off" | "not_allowed" | "refused" | "failed"; readonly detail: string };

export interface AgentPagesShape {
  readonly show: (
    scope: McpInvocationScope,
    input: ShowPageInput,
  ) => Effect.Effect<ShowPageOutcome>;
  readonly preview: (
    scope: McpInvocationScope,
    input: PreviewPageInput,
  ) => Effect.Effect<PreviewPageOutcome>;
  /**
   * `show_theme` (docs/design/custom-themes.md): checks the theme, embeds its
   * fonts, captures a still of its art, and shows it as a page of kind
   * `theme` under the same turn rules as every page.
   */
  readonly showTheme: (
    scope: McpInvocationScope,
    input: ShowThemeInput,
  ) => Effect.Effect<ShowPageOutcome>;
  /** `preview_theme`: the specimen's screenshots and a report. */
  readonly previewTheme: (
    scope: McpInvocationScope,
    input: ThemeToolInput,
  ) => Effect.Effect<PreviewThemeOutcome>;
  /**
   * Shows the local copy of a page a provider's own tool published (a Claude
   * artifact). Publishing it again updates the page already showing it.
   */
  readonly adopt: (input: AdoptPageInput) => Effect.Effect<ShowPageOutcome>;
  /** One stored version, for clients (`pages.read`). */
  readonly read: (
    input: AgentPageReadInput,
  ) => Effect.Effect<AgentPageReadResult, AgentPageReadError>;
  /** Version ids whose publish is still running, which the sweep leaves alone. */
  readonly pendingVersionIds: Effect.Effect<ReadonlySet<string>>;
  /** The folder an agent saves a thread's page images in. */
  readonly assetsDirOf: (threadId: ThreadId) => string | null;
}

export class AgentPages extends Context.Service<AgentPages, AgentPagesShape>()(
  "threadlines/pages/AgentPages",
) {}

const SHOWN_MESSAGE =
  "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.";
const OFF_DETAIL =
  "Pages are turned off in this Threadlines. Answer in text instead, and don't try again.";
const SIDE_DETAIL = "A side answer cannot show pages.";
const GONE_DETAIL = "This thread is gone.";
const NOT_YOUR_TURN_DETAIL =
  "Pages show in the turn that published them, and you are not working on a turn of this thread right now. Show it during your next turn.";
const TURN_ENDED_DETAIL =
  "The turn ended before the page could be shown, so it was not. Show it again in your next turn if it is still needed.";
const ONE_PAGE_DETAIL = "Give the page as exactly one of html or markdown.";
const ONE_THEME_DETAIL = "Give the theme as exactly one of theme or path.";
const THEME_SHOWN_MESSAGE =
  "Offered to the user above your reply, with Try it. Don't describe the theme again; reply with only what the row doesn't say.";
const DEFAULT_HEIGHT = 480;
const MIN_PREVIEW_WIDTH = 240;
const MAX_PREVIEW_WIDTH = 1600;

/** The page a show or preview call gave, or null unless it gave exactly one of html and markdown. */
const pageOf = (input: {
  readonly html?: string | undefined;
  readonly markdown?: string | undefined;
}): { readonly content: string; readonly kind: AgentPageKind } | null => {
  if (input.html !== undefined && input.markdown === undefined) {
    return { content: input.html, kind: "html" };
  }
  if (input.markdown !== undefined && input.html === undefined) {
    return { content: input.markdown, kind: "markdown" };
  }
  return null;
};

const decodeThemeManifest = Schema.decodeUnknownOption(ThemeManifest);

/** A theme with the hosted fonts it couldn't get left out, so it can still be previewed. */
const withoutHostedFonts = (manifest: ThemeManifest): ThemeManifest => {
  const keep = (font: ThemeFont | undefined) =>
    font !== undefined && (font.source === "system" || font.data !== undefined) ? font : undefined;
  const ui = keep(manifest.fonts?.ui);
  const mono = keep(manifest.fonts?.mono);
  return {
    ...manifest,
    fonts: { ...(ui !== undefined ? { ui } : {}), ...(mono !== undefined ? { mono } : {}) },
  };
};

/**
 * The page a show call publishes to: a new one, or the page `requested`
 * names when the thread has it and it is the same sort (a page or a theme).
 */
const pageIdFor = (
  thread: OrchestrationThread,
  requested: string | undefined,
  sort: "page" | "theme",
): { readonly pageId: AgentPageId } | { readonly refused: string } => {
  const tool = sort === "theme" ? "show_theme" : "show_page";
  const id = requested?.trim();
  if (id === undefined || id.length === 0) return { pageId: AgentPageId.make(randomUUID()) };
  if (!isPageFileId(id)) {
    return {
      refused: `'${id}' is not a page id. Use the pageId an earlier ${tool} returned, or leave it out to show a new ${sort}.`,
    };
  }
  const shown = (thread.pages ?? []).find((page) => page.pageId === id.toLowerCase());
  if (shown === undefined) {
    return {
      refused: `This thread has no ${sort} '${id}'. Leave pageId out to show a new ${sort}.`,
    };
  }
  if ((shown.kind === "theme") !== (sort === "theme")) {
    return {
      refused:
        sort === "theme"
          ? `'${id}' is a page, not a theme. Leave pageId out to show a new theme.`
          : `'${id}' is a theme; update it with show_theme, or leave pageId out to show a new page.`,
    };
  }
  return { pageId: AgentPageId.make(id.toLowerCase()) };
};

const measureDocument = (content: string, kind: AgentPageKind) =>
  buildAgentPageDocument({
    content,
    kind,
    theme: agentPageTheme(AGENT_PAGE_FALLBACK_THEMES.dark, AGENT_PAGE_MEASURE_FONTS),
  });

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const pageRows = yield* ProjectionThreadPageRepository;
  const settings = yield* ServerSettingsService;
  const previews = yield* PagePreview;
  const workshop = yield* ThemeWorkshop;
  const analytics = yield* AnalyticsService;

  const pending = new Set<string>();
  // One publish at a time per page, so versions are numbered in the order
  // they are stored.
  const pageLocks = new Map<string, Semaphore.Semaphore>();
  const lockFor = (key: string) =>
    Effect.gen(function* () {
      const existing = pageLocks.get(key);
      if (existing !== undefined) return existing;
      const created = yield* Semaphore.make(1);
      pageLocks.set(key, created);
      return created;
    });

  const enabled = settings.getSettings.pipe(
    Effect.map((current) => current.enableAgentPages),
    Effect.orElseSucceed(() => false),
  );

  const readThread = (threadId: ThreadId) =>
    snapshots.getThreadDetailById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );

  const callerTurn = (scope: McpInvocationScope) => latchCallerTurn(readThread, scope);

  const show: AgentPagesShape["show"] = (scope, input) =>
    Effect.gen(function* () {
      if (!(yield* enabled)) return { outcome: "off" as const, detail: OFF_DETAIL };
      if (scope.side !== undefined) return { outcome: "not_allowed" as const, detail: SIDE_DETAIL };
      const page = pageOf(input);
      if (page === null) return { outcome: "refused" as const, detail: ONE_PAGE_DETAIL };
      const { content, kind } = page;
      const title = input.title.trim();
      if (title.length === 0) {
        return { outcome: "refused" as const, detail: "Give the page a short title." };
      }

      // Latched now, before anything slow: the page belongs to this turn.
      const latched = yield* callerTurn(scope);
      if ("gone" in latched) return { outcome: "refused" as const, detail: GONE_DETAIL };
      if ("notYours" in latched) {
        return { outcome: "not_allowed" as const, detail: NOT_YOUR_TURN_DETAIL };
      }
      const { thread, turnId } = latched;

      const target = pageIdFor(thread, input.pageId, "page");
      if ("refused" in target) return { outcome: "refused" as const, detail: target.refused };
      const { pageId } = target;
      const participantId = scope.participantId;
      const lock = yield* lockFor(`${scope.threadId}\u0000${pageId}`);
      return yield* lock.withPermits(1)(
        publish({
          threadId: scope.threadId,
          participantId,
          thread,
          turnId,
          pageId,
          kind,
          title,
          content: ensurePageAssetsDir(scope.threadId).pipe(
            Effect.flatMap((assetsRoot) => inlinePageImages({ content, assetsRoot })),
          ),
          height: input.height,
          icon: input.icon,
          // Its own turn, still running, and still this agent's.
          stillStands: (still) =>
            (still.session?.participantId ?? null) === participantId &&
            still.session?.activeTurnId === turnId,
        }),
      );
    });

  const publish = (args: {
    readonly threadId: ThreadId;
    readonly participantId: ThreadParticipantId | null;
    readonly thread: OrchestrationThread;
    readonly turnId: TurnId;
    readonly pageId: AgentPageId;
    readonly kind: AgentPageKind;
    readonly title: string;
    /** The page as it will be stored. */
    readonly content: Effect.Effect<string, PageStoreError | ThemeError>;
    readonly height?: number | undefined;
    readonly icon?: string | undefined;
    readonly shareUrl?: string | undefined;
    /** What the agent is told once it shows. Default: SHOWN_MESSAGE. */
    readonly message?: Effect.Effect<string> | undefined;
    /** Whether the page still has its turn to show in, asked right before it is stored. */
    readonly stillStands: (thread: OrchestrationThread) => boolean;
  }): Effect.Effect<ShowPageOutcome> =>
    Effect.gen(function* () {
      const { threadId, pageId, kind } = args;
      // The latest version, re-read under the page's lock.
      const current = yield* readThread(threadId);
      const version =
        1 +
        Math.max(
          0,
          ...(current?.pages ?? args.thread.pages ?? [])
            .filter((page) => page.pageId === pageId)
            .map((page) => page.version),
        );

      const prepared = yield* args.content;

      // A theme shows as a row of one height; there is nothing to measure.
      const measured =
        kind === "theme"
          ? undefined
          : yield* previews
              .measure({
                document: measureDocument(prepared, kind),
                widths: AGENT_PAGE_MEASURE_WIDTHS,
              })
              .pipe(Effect.map(Option.getOrUndefined));
      const heights: AgentPageHeights | undefined =
        measured !== undefined && measured.length > 0 ? measured : undefined;
      const height =
        kind === "theme"
          ? THEME_PAGE_HEIGHT
          : clampAgentPageHeight(
              args.height ??
                (heights !== undefined
                  ? agentPageFrameHeight(
                      { height: Number.MAX_SAFE_INTEGER, heights },
                      AGENT_PAGE_AUTO_HEIGHT_WIDTH,
                    )
                  : DEFAULT_HEIGHT),
            );

      // Measuring takes a moment: if the turn ended meanwhile (stopped, or
      // taken back), the page has no turn to show in any more.
      const still = yield* readThread(threadId);
      if (still === undefined || still.deletedAt !== null || !args.stillStands(still)) {
        return { outcome: "not_allowed" as const, detail: TURN_ENDED_DETAIL };
      }

      const versionId = AgentPageVersionId.make(randomUUID());
      const path = pageVersionPath({
        pagesDir: config.pagesDir,
        threadId,
        pageId,
        versionId,
        kind,
      });
      if (path === null) {
        return { outcome: "failed" as const, detail: "The page could not be saved." };
      }

      pending.add(versionId);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const dispatched = yield* writePageVersion({ path, content: prepared }).pipe(
        Effect.andThen(
          engine.dispatch({
            type: "thread.page.publish",
            commandId: CommandId.make(`server:page-publish:${versionId}`),
            threadId,
            page: {
              pageId,
              versionId,
              version,
              turnId: args.turnId,
              participantId: args.participantId,
              title: args.title,
              kind,
              height,
              ...(heights !== undefined ? { heights } : {}),
              ...(args.icon !== undefined && args.icon.trim().length > 0
                ? { icon: args.icon.trim() }
                : {}),
              ...(args.shareUrl !== undefined ? { shareUrl: args.shareUrl } : {}),
            },
            createdAt,
          }),
        ),
        Effect.ensuring(Effect.sync(() => pending.delete(versionId))),
        Effect.result,
      );
      if (dispatched._tag === "Failure") {
        // Refused or failed outright: nothing will ever name this file.
        // (An interruption never gets here; the sweep handles that file.)
        yield* removePageVersion(path);
        const error = dispatched.failure;
        return {
          outcome: "failed" as const,
          detail:
            "detail" in error && typeof error.detail === "string"
              ? error.detail
              : "The page could not be recorded.",
        };
      }
      const message = args.message === undefined ? SHOWN_MESSAGE : yield* args.message;
      return { outcome: "shown" as const, pageId, version, message };
    }).pipe(
      Effect.catchTags({
        PageStoreError: (error) =>
          Effect.succeed({ outcome: "refused" as const, detail: error.message }),
        ThemeError: (error) =>
          Effect.succeed({ outcome: "refused" as const, detail: error.detail }),
      }),
    );

  const adopt: AgentPagesShape["adopt"] = (input) =>
    Effect.gen(function* () {
      if (!(yield* enabled)) return { outcome: "off" as const, detail: OFF_DETAIL };
      const link = agentPageShareLink(input.shareUrl.trim());
      if (link === null) {
        return { outcome: "refused" as const, detail: "The published page has no usable link." };
      }
      // One at a time per link: a second publish must find the page the
      // first one made, or the chat would show the same link twice.
      const linkLock = yield* lockFor(`${input.threadId}\u0000link\u0000${link.url}`);
      return yield* linkLock.withPermits(1)(adoptLink(input, link.url));
    }).pipe(
      Effect.catchTag("PageStoreError", (error) =>
        Effect.succeed({ outcome: "refused" as const, detail: error.message }),
      ),
    );

  const adoptLink = (input: AdoptPageInput, shareUrl: string) =>
    Effect.gen(function* () {
      const thread = yield* readThread(input.threadId);
      if (thread === undefined || thread.deletedAt !== null) {
        return { outcome: "refused" as const, detail: GONE_DETAIL };
      }
      // The agent hears of its publish at once and may end the turn, and the
      // next may start, while this page is still being measured. The page
      // still belongs to its turn for as long as that turn is in the thread;
      // a turn taken back is not.
      const stillStands = (still: OrchestrationThread) => threadHasTurn(still, input.turnId);
      if (!stillStands(thread)) {
        return { outcome: "not_allowed" as const, detail: TURN_ENDED_DETAIL };
      }
      const published = yield* readPublishedPage(input.path);
      const title = (
        input.title?.trim() || NodePath.basename(input.path, NodePath.extname(input.path))
      )
        .slice(0, AGENT_PAGE_MAX_TITLE_LENGTH)
        .trim();
      // Published again to the same link: a new version of the page showing it.
      const shown = (thread.pages ?? []).findLast((page) => page.shareUrl === shareUrl);
      const pageId = shown?.pageId ?? AgentPageId.make(randomUUID());
      const lock = yield* lockFor(`${input.threadId}\u0000${pageId}`);
      return yield* lock.withPermits(1)(
        publish({
          threadId: input.threadId,
          participantId: input.participantId,
          thread,
          turnId: input.turnId,
          pageId,
          kind: published.kind,
          title: title.length > 0 ? title : "Page",
          content: Effect.succeed(published.content),
          icon: input.icon,
          shareUrl,
          stillStands,
        }),
      );
    });

  const preview: AgentPagesShape["preview"] = (scope, input) =>
    Effect.gen(function* () {
      if (!(yield* enabled)) return { outcome: "off" as const, detail: OFF_DETAIL };
      if (scope.side !== undefined) return { outcome: "not_allowed" as const, detail: SIDE_DETAIL };
      const page = pageOf(input);
      if (page === null) return { outcome: "refused" as const, detail: ONE_PAGE_DETAIL };
      const width = Math.min(
        MAX_PREVIEW_WIDTH,
        Math.max(MIN_PREVIEW_WIDTH, Math.round(input.width ?? AGENT_PAGE_COLUMN_WIDTH)),
      );
      const assetsRoot = yield* ensurePageAssetsDir(scope.threadId);
      const prepared = yield* inlinePageImages({ content: page.content, assetsRoot });
      const document = buildAgentPageDocument({
        content: prepared,
        kind: page.kind,
        theme: agentPageTheme(
          AGENT_PAGE_FALLBACK_THEMES[input.appearance ?? "dark"],
          AGENT_PAGE_MEASURE_FONTS,
        ),
      });
      return yield* previews.preview({ document, width }).pipe(
        Effect.map((result) => ({ outcome: "previewed" as const, preview: result })),
        Effect.catch((error) =>
          Effect.succeed({ outcome: "failed" as const, detail: error.message }),
        ),
      );
    }).pipe(
      Effect.catchTag("PageStoreError", (error) =>
        Effect.succeed({ outcome: "refused" as const, detail: error.message }),
      ),
    );

  /** The theme a theme tool was given: the object, or a file in the thread's assets folder. */
  const themeArgument = (scope: McpInvocationScope, input: ThemeToolInput) =>
    Effect.gen(function* () {
      const hasTheme = input.theme !== undefined;
      const path = input.path?.trim();
      const hasPath = path !== undefined && path.length > 0;
      if (hasTheme === hasPath) return { refused: ONE_THEME_DETAIL } as const;
      if (hasTheme) return { value: input.theme } as const;
      const assetsRoot = yield* ensurePageAssetsDir(scope.threadId);
      return { value: yield* readThemeFile({ assetsRoot, path: path! }) } as const;
    });

  const showTheme: AgentPagesShape["showTheme"] = (scope, input) =>
    Effect.gen(function* () {
      if (!(yield* enabled)) return { outcome: "off" as const, detail: OFF_DETAIL };
      if (scope.side !== undefined) return { outcome: "not_allowed" as const, detail: SIDE_DETAIL };
      const argument = yield* themeArgument(scope, input);
      if ("refused" in argument) return { outcome: "refused" as const, detail: argument.refused };
      const check = checkThemeManifest(argument.value, { authoring: true });
      if (!check.ok) {
        return {
          outcome: "refused" as const,
          detail: `${themeProblems(check.errors).detail}\nFix them (preview_theme shows the same checks), then show the theme again.`,
        };
      }

      // Latched now, before fonts and the still: the theme belongs to this turn.
      const latched = yield* callerTurn(scope);
      if ("gone" in latched) return { outcome: "refused" as const, detail: GONE_DETAIL };
      if ("notYours" in latched) {
        return { outcome: "not_allowed" as const, detail: NOT_YOUR_TURN_DETAIL };
      }
      const { thread, turnId } = latched;
      const target = pageIdFor(thread, input.pageId, "theme");
      if ("refused" in target) return { outcome: "refused" as const, detail: target.refused };
      const { pageId } = target;
      const participantId = scope.participantId;
      let note: string | undefined;
      // Every version shown on this page carries the same offer, so keeping a
      // later one updates the copy kept from an earlier one.
      const manifest: ThemeManifest = {
        ...check.manifest,
        createdBy: {
          ...(check.manifest.createdBy ?? { kind: "agent", threadId: scope.threadId }),
          offer: { threadId: scope.threadId, pageId },
        },
      };
      const lock = yield* lockFor(`${scope.threadId}\u0000${pageId}`);
      return yield* lock.withPermits(1)(
        publish({
          threadId: scope.threadId,
          participantId,
          thread,
          turnId,
          pageId,
          kind: "theme",
          title: manifest.name,
          content: workshop.embedFonts(manifest).pipe(
            Effect.flatMap(workshop.withStill),
            Effect.flatMap((prepared) => {
              // Fonts and the still add up to a couple of megabytes: the offer as
              // shown must still pass, or the app it's offered to refuses it.
              const shown = checkThemeManifest(prepared.manifest);
              if (!shown.ok) return Effect.fail(themeProblems(shown.errors));
              note = prepared.note;
              return Effect.succeed(themePageContent(shown.manifest));
            }),
          ),
          message: Effect.sync(() =>
            note === undefined ? THEME_SHOWN_MESSAGE : `${THEME_SHOWN_MESSAGE} ${note}`,
          ),
          stillStands: (still) =>
            (still.session?.participantId ?? null) === participantId &&
            still.session?.activeTurnId === turnId,
        }).pipe(
          // Counted once it is in the chat; a new version of one already shown says so.
          Effect.tap((result) =>
            result.outcome === "shown"
              ? analytics.record("theme.offered", {
                  ...themeAnalyticsProperties(manifest),
                  // A blank page id asks for a new page, as pageIdFor reads it.
                  revised: (input.pageId?.trim() ?? "") !== "",
                })
              : Effect.void,
          ),
        ),
      );
    }).pipe(
      Effect.catchTag("PageStoreError", (error) =>
        Effect.succeed({ outcome: "refused" as const, detail: error.message }),
      ),
    );

  const previewTheme: AgentPagesShape["previewTheme"] = (scope, input) =>
    Effect.gen(function* () {
      if (!(yield* enabled)) return { outcome: "off" as const, detail: OFF_DETAIL };
      if (scope.side !== undefined) return { outcome: "not_allowed" as const, detail: SIDE_DETAIL };
      const argument = yield* themeArgument(scope, input);
      if ("refused" in argument) return { outcome: "refused" as const, detail: argument.refused };
      const check = checkThemeManifest(argument.value, { authoring: true });
      // A theme that only fails rules past its shape (contrast, sizes) still
      // renders, so the agent sees what it is fixing.
      const decoded = check.ok ? Option.some(check.manifest) : decodeThemeManifest(argument.value);
      if (Option.isNone(decoded)) {
        return {
          outcome: "refused" as const,
          detail: themeProblems(check.ok ? [] : check.errors).detail,
        };
      }
      const embedded = yield* workshop.embedFonts(decoded.value).pipe(Effect.result);
      const manifest =
        embedded._tag === "Success" ? embedded.success : withoutHostedFonts(decoded.value);
      return yield* workshop.preview(manifest).pipe(
        Effect.map((report) => ({
          outcome: "previewed" as const,
          text: themePreviewText({
            manifest,
            problems: check.ok ? [] : check.errors,
            fontProblem: embedded._tag === "Failure" ? embedded.failure.detail : null,
            report,
          }),
          shots: report.shots,
        })),
        Effect.catch((error) =>
          Effect.succeed({ outcome: "failed" as const, detail: error.message }),
        ),
      );
    }).pipe(
      Effect.catchTag("PageStoreError", (error) =>
        Effect.succeed({ outcome: "refused" as const, detail: error.message }),
      ),
    );

  const read: AgentPagesShape["read"] = (input) =>
    Effect.gen(function* () {
      const thread = yield* snapshots.getThreadShellById(input.threadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      const row =
        thread === undefined
          ? undefined
          : yield* pageRows.getVersion(input).pipe(Effect.orElseSucceed(() => undefined));
      if (row === undefined) {
        return yield* new AgentPageReadError({ message: "This page is no longer available." });
      }
      const path = pageVersionPath({
        pagesDir: config.pagesDir,
        threadId: input.threadId,
        pageId: input.pageId,
        versionId: input.versionId,
        kind: row.kind,
      });
      if (path === null) {
        return yield* new AgentPageReadError({ message: "This page is no longer available." });
      }
      const content = yield* readPageVersion(path).pipe(
        Effect.mapError(
          (error) =>
            new AgentPageReadError({ message: "This page could not be read.", cause: error }),
        ),
      );
      return { kind: row.kind, content };
    });

  return AgentPages.of({
    show,
    adopt,
    preview,
    showTheme,
    previewTheme,
    read,
    pendingVersionIds: Effect.sync(() => new Set(pending)),
    assetsDirOf: (threadId) => pageAssetsDir(threadId),
  });
});

export const layer = Layer.effect(AgentPages, make);
