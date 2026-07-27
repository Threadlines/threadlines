/**
 * CDP control of preview tabs.
 *
 * Attaches Chrome DevTools Protocol to a preview <webview>'s WebContents. CDP
 * rather than `executeJavaScript` because it operates at the browser level
 * instead of inside the page's JavaScript sandbox: it is unaffected by
 * same-origin policy, and its input events are real ones, so hover, focus and
 * blur behave as they would for a person. Synthetic DOM events would not.
 *
 * Console and failed requests are collected here rather than on demand,
 * because by the time anyone asks, the interesting message has already been
 * printed. The buffers reset on navigation so they describe the current page.
 */

import type {
  DesktopPreviewAnnotationMode,
  DesktopPreviewDrawing,
  DesktopPreviewClickInput,
  DesktopPreviewPickedElement,
  DesktopPreviewPoint,
  DesktopPreviewPickMode,
  DesktopPreviewConsoleEntry,
  DesktopPreviewEvaluateInput,
  DesktopPreviewNetworkFailure,
  DesktopPreviewPressInput,
  DesktopPreviewScrollInput,
  DesktopPreviewSnapshot,
  DesktopPreviewScreenshot,
  DesktopPreviewStatus,
  DesktopPreviewTypeInput,
  DesktopPreviewWaitForInput,
  PreviewAutomationTarget,
} from "@threadlines/contracts";
import { webContents, type WebContents } from "electron";

import { toCdpKeyDefinition, toCdpModifierBitmask } from "./keyEvents.ts";
import {
  buildAriaSnapshotScript,
  buildInjectedRuntimeScript,
  buildLocatorQueryScript,
  INJECTED_WORLD_NAME,
} from "./injectedRuntime.ts";
import { isHostInjectedConsoleEntry } from "./previewConsoleNoise.ts";
import {
  buildDrawOverlayScript,
  DRAW_OVERLAY_BINDING,
  DRAW_OVERLAY_STASH,
  DRAW_OVERLAY_TEARDOWN_SCRIPT,
} from "./drawOverlayScript.ts";
import { buildRevealElementScript } from "./revealElementScript.ts";
import {
  buildPickOverlayScript,
  PICK_OVERLAY_BINDING,
  PICK_OVERLAY_STASH,
  PICK_OVERLAY_TEARDOWN_SCRIPT,
} from "./pickOverlayScript.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/** Enough to explain a failure without letting a chatty page grow unboundedly. */
const MAX_CONSOLE_ENTRIES = 200;
/** Long enough to choose deliberately, short enough not to strand inspect mode. */
const PICK_TIMEOUT_MS = 60_000;

const MAX_NETWORK_FAILURES = 100;

export class PreviewTargetMissingError extends Schema.TaggedErrorClass<PreviewTargetMissingError>()(
  "PreviewTargetMissingError",
  { webContentsId: Schema.Number },
) {
  override get message(): string {
    return `No live preview tab with webContents id ${this.webContentsId}.`;
  }
}

export class PreviewCommandError extends Schema.TaggedErrorClass<PreviewCommandError>()(
  "PreviewCommandError",
  { webContentsId: Schema.Number, method: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    const detail =
      this.cause instanceof Error
        ? this.cause.message
        : typeof this.cause === "string"
          ? this.cause
          : String(this.cause);
    return `Preview command ${this.method} failed for webContents ${this.webContentsId}: ${detail}`;
  }
}

export type PreviewAutomationError = PreviewTargetMissingError | PreviewCommandError;

interface AttachedTab {
  contents: WebContents;
  console: DesktopPreviewConsoleEntry[];
  networkFailures: DesktopPreviewNetworkFailure[];
  /**
   * requestId -> url, because `Network.loadingFailed` reports only the id.
   * Without this a request that fails below HTTP -- DNS, connection refused,
   * blocked -- would be reported as an opaque id instead of an address.
   */
  requestUrls: Map<string, string>;
  dispose: () => void;
}

export class PreviewAutomation extends Context.Service<
  PreviewAutomation,
  {
    readonly attach: (
      webContentsId: number,
    ) => Effect.Effect<DesktopPreviewStatus, PreviewAutomationError>;
    readonly detach: (webContentsId: number) => Effect.Effect<void>;
    readonly status: (
      webContentsId: number,
    ) => Effect.Effect<DesktopPreviewStatus, PreviewAutomationError>;
    readonly evaluate: (
      input: DesktopPreviewEvaluateInput,
    ) => Effect.Effect<unknown, PreviewAutomationError>;
    readonly snapshot: (
      webContentsId: number,
    ) => Effect.Effect<DesktopPreviewSnapshot, PreviewAutomationError>;
    readonly openDevTools: (webContentsId: number) => Effect.Effect<void, PreviewAutomationError>;
    readonly setViewport: (
      webContentsId: number,
      size: { width: number | null; height: number | null },
    ) => Effect.Effect<void, PreviewAutomationError>;
    readonly pickElement: (
      webContentsId: number,
      colorScheme: "light" | "dark",
      mode: DesktopPreviewPickMode,
    ) => Effect.Effect<ReadonlyArray<DesktopPreviewPickedElement>, PreviewAutomationError>;
    readonly cancelPick: (webContentsId: number) => Effect.Effect<void, PreviewAutomationError>;
    readonly setAnnotationMode: (
      webContentsId: number,
      mode: DesktopPreviewAnnotationMode | null,
    ) => Effect.Effect<void, PreviewAutomationError>;
    /** Resolves when the user attaches a drawing, or empty if they discard it
     *  or the mode is turned off. */
    readonly awaitDrawing: (
      webContentsId: number,
    ) => Effect.Effect<DesktopPreviewDrawing | null, PreviewAutomationError>;
    readonly revealElement: (
      webContentsId: number,
      selector: string,
    ) => Effect.Effect<boolean, PreviewAutomationError>;
    readonly setColorScheme: (
      webContentsId: number,
      colorScheme: "light" | "dark",
    ) => Effect.Effect<void, PreviewAutomationError>;
    readonly screenshot: (
      webContentsId: number,
    ) => Effect.Effect<DesktopPreviewScreenshot, PreviewAutomationError>;
    readonly click: (
      input: DesktopPreviewClickInput,
    ) => Effect.Effect<DesktopPreviewPoint, PreviewAutomationError>;
    readonly type: (
      input: DesktopPreviewTypeInput,
    ) => Effect.Effect<DesktopPreviewPoint, PreviewAutomationError>;
    readonly press: (
      input: DesktopPreviewPressInput,
    ) => Effect.Effect<void, PreviewAutomationError>;
    readonly scroll: (
      input: DesktopPreviewScrollInput,
    ) => Effect.Effect<void, PreviewAutomationError>;
    readonly waitFor: (
      input: DesktopPreviewWaitForInput,
    ) => Effect.Effect<void, PreviewAutomationError>;
  }
>()("@threadlines/desktop/preview/PreviewAutomation") {}

/** What the overlay reports: how many elements it left behind, and what the
 *  user said about them. */
interface PickResult {
  count: number;
  note: string | null;
  styleChanges: ReadonlyArray<{ property: string; from: string; to: string }>;
}

export const make = Effect.sync(function PreviewAutomationMake() {
  const attached = new Map<number, AttachedTab>();
  /**
   * The pick a page is currently waiting on, if any.
   *
   * Only one can be armed at a time, so starting another -- or cancelling --
   * has to settle the previous one now. Left to time out on its own it would
   * eventually run its teardown, which by then would be tearing down the
   * overlay belonging to whatever replaced it.
   */
  const pendingPicks = new Map<number, { supersede: () => void }>();
  /** Whoever is waiting for a drawing to be attached, so turning the mode off
   *  can release them. */
  const drawWaiters = new Map<number, () => void>();

  const resolve = (webContentsId: number) =>
    Effect.suspend(() => {
      const contents = webContents.fromId(webContentsId);
      return contents === undefined || contents.isDestroyed()
        ? Effect.fail(new PreviewTargetMissingError({ webContentsId }))
        : Effect.succeed(contents);
    });

  const sendCommand = (contents: WebContents, method: string, params?: Record<string, unknown>) =>
    Effect.tryPromise({
      try: () => contents.debugger.sendCommand(method, params ?? {}),
      catch: (cause) => new PreviewCommandError({ webContentsId: contents.id, method, cause }),
    });

  const failCommand = (contents: WebContents, method: string, cause: string) =>
    Effect.fail(new PreviewCommandError({ webContentsId: contents.id, method, cause }));

  const targetDescription = (target: PreviewAutomationTarget): string =>
    "ref" in target
      ? `ref ${target.ref}`
      : "locator" in target
        ? `locator ${JSON.stringify(target.locator)}`
        : "selector" in target
          ? `selector ${JSON.stringify(target.selector)}`
          : `text ${JSON.stringify(target.text)}`;

  /**
   * The isolated world our element engine lives in, created if it is not there.
   *
   * Asked for on every use rather than tracked: Chrome returns the existing
   * world for a name it already knows, and a navigation quietly destroys the
   * old one. Tracking it ourselves would mean holding an id that goes stale
   * exactly when a page changes, which is the moment this gets used.
   */
  const injectedWorld = Effect.fn("PreviewAutomation.injectedWorld")(function* (
    contents: WebContents,
  ) {
    yield* sendCommand(contents, "Page.enable", {});
    const tree = (yield* sendCommand(contents, "Page.getFrameTree", {})) as {
      frameTree?: { frame?: { id?: string } };
    };
    const frameId = tree.frameTree?.frame?.id;
    if (frameId === undefined) {
      return yield* failCommand(contents, "Page.getFrameTree", "the page has no main frame");
    }
    const world = (yield* sendCommand(contents, "Page.createIsolatedWorld", {
      frameId,
      worldName: INJECTED_WORLD_NAME,
      grantUniveralAccess: false,
    })) as { executionContextId?: number };
    const contextId = world.executionContextId;
    if (contextId === undefined) {
      return yield* failCommand(
        contents,
        "Page.createIsolatedWorld",
        "could not create an isolated world for the element engine",
      );
    }
    yield* sendCommand(contents, "Runtime.evaluate", {
      expression: buildInjectedRuntimeScript(),
      contextId,
      returnByValue: true,
    });
    return contextId;
  });

  /** Runs an expression in the engine's world, surfacing a page-side throw. */
  const evaluateInjected = Effect.fn("PreviewAutomation.evaluateInjected")(function* (
    contents: WebContents,
    expression: string,
    options?: { readonly returnByValue?: boolean },
  ) {
    const contextId = yield* injectedWorld(contents);
    const result = (yield* sendCommand(contents, "Runtime.evaluate", {
      expression,
      contextId,
      returnByValue: options?.returnByValue ?? false,
      awaitPromise: true,
    })) as {
      result?: { objectId?: string; value?: unknown };
      exceptionDetails?: { exception?: { description?: string; value?: unknown }; text?: string };
    };
    if (result.exceptionDetails !== undefined) {
      const exception = result.exceptionDetails.exception;
      // The engine's own messages say what to do differently, so they are
      // carried through rather than replaced with something generic.
      const detail =
        (typeof exception?.value === "string" ? exception.value : undefined) ??
        exception?.description?.split("\n")[0] ??
        result.exceptionDetails.text ??
        "the element engine failed";
      return yield* failCommand(contents, "injected.evaluate", detail);
    }
    return result.result ?? {};
  });

  const resolveTarget = Effect.fn("PreviewAutomation.resolveTarget")(function* (
    contents: WebContents,
    target: PreviewAutomationTarget,
  ) {
    if ("locator" in target) {
      const handle = yield* evaluateInjected(contents, buildLocatorQueryScript(target.locator));
      const objectId = handle.objectId;
      if (objectId === undefined) {
        return yield* failCommand(
          contents,
          "resolveTarget",
          `the locator ${JSON.stringify(target.locator)} did not resolve to an element`,
        );
      }
      const described = (yield* sendCommand(contents, "DOM.describeNode", { objectId })) as {
        node?: { backendNodeId?: number };
      };
      yield* sendCommand(contents, "Runtime.releaseObject", { objectId }).pipe(Effect.ignore);
      const backendNodeId = described.node?.backendNodeId;
      if (backendNodeId === undefined) {
        return yield* failCommand(
          contents,
          "resolveTarget",
          `the element matching ${JSON.stringify(target.locator)} disappeared; take a new snapshot`,
        );
      }
      return backendNodeId;
    }

    if ("ref" in target) {
      // A ref is the `eN` from the aria snapshot, and Playwright's own
      // `aria-ref=` engine is what resolves it against the tree that issued it.
      // Resolving it as anything else -- a node id, an index -- would work
      // right up until the page re-rendered.
      const handle = yield* evaluateInjected(
        contents,
        buildLocatorQueryScript(`aria-ref=${target.ref}`),
      );
      const objectId = handle.objectId;
      if (objectId === undefined) {
        return yield* failCommand(
          contents,
          "resolveTarget",
          `ref ${target.ref} no longer resolves; take a new snapshot and use its refs`,
        );
      }
      const described = (yield* sendCommand(contents, "DOM.describeNode", { objectId })) as {
        node?: { backendNodeId?: number };
      };
      yield* sendCommand(contents, "Runtime.releaseObject", { objectId }).pipe(Effect.ignore);
      const backendNodeId = described.node?.backendNodeId;
      if (backendNodeId === undefined) {
        return yield* failCommand(
          contents,
          "resolveTarget",
          `the element at ref ${target.ref} disappeared; take a new snapshot and try again`,
        );
      }
      return backendNodeId;
    }

    if ("selector" in target) {
      const document = (yield* sendCommand(contents, "DOM.getDocument", {})) as {
        root?: { nodeId?: number };
      };
      const nodeId = document.root?.nodeId;
      if (nodeId === undefined) {
        return yield* failCommand(
          contents,
          "resolveTarget",
          `no element matches selector ${JSON.stringify(target.selector)}; take a new snapshot or use a different selector`,
        );
      }

      const match = (yield* sendCommand(contents, "DOM.querySelector", {
        nodeId,
        selector: target.selector,
      }).pipe(
        Effect.catch(() =>
          failCommand(
            contents,
            "resolveTarget",
            `no element matches selector ${JSON.stringify(target.selector)}; use a valid selector or take a new snapshot`,
          ),
        ),
      )) as { nodeId?: number };
      if (match.nodeId === undefined || match.nodeId === 0) {
        return yield* failCommand(
          contents,
          "resolveTarget",
          `no element matches selector ${JSON.stringify(target.selector)}; take a new snapshot or use a different selector`,
        );
      }

      const described = (yield* sendCommand(contents, "DOM.describeNode", {
        nodeId: match.nodeId,
      }).pipe(
        Effect.catch(() =>
          failCommand(
            contents,
            "resolveTarget",
            `the element matching selector ${JSON.stringify(target.selector)} disappeared; take a new snapshot and try again`,
          ),
        ),
      )) as { node?: { backendNodeId?: number } };
      const backendNodeId = described.node?.backendNodeId;
      if (backendNodeId === undefined) {
        return yield* failCommand(
          contents,
          "resolveTarget",
          `no element matches selector ${JSON.stringify(target.selector)}; take a new snapshot or use a different selector`,
        );
      }
      return backendNodeId;
    }

    if (target.text.trim() === "") {
      return yield* failCommand(
        contents,
        "resolveTarget",
        "an empty text target cannot identify an element; provide visible text, a selector, or a snapshot ref",
      );
    }

    const evaluated = (yield* sendCommand(contents, "Runtime.evaluate", {
      expression: `(() => {
        const wanted = ${JSON.stringify(target.text)};
        const clickableSelector = 'button, a, [role="button"], input, summary';
        const depth = (element) => {
          let value = 0;
          for (let current = element; current.parentElement; current = current.parentElement) {
            value += 1;
          }
          return value;
        };
        const visible = (element) => {
          const style = getComputedStyle(element);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            Number(style.opacity) === 0
          ) {
            return false;
          }
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const candidates = [...document.querySelectorAll('*')]
          .filter(visible)
          .map((element) => ({ element, text: (element.innerText || '').trim() }))
          .filter((candidate) => candidate.text !== '');
        const rank = (left, right) => {
          const clickable =
            Number(right.element.matches(clickableSelector)) -
            Number(left.element.matches(clickableSelector));
          return clickable !== 0 ? clickable : depth(left.element) - depth(right.element);
        };
        const exact = candidates.filter((candidate) => candidate.text === wanted).sort(rank);
        if (exact.length > 0) {
          return exact[0].element;
        }
        const containing = candidates
          .filter((candidate) => candidate.text.includes(wanted))
          .sort(rank);
        return containing.length > 0 ? containing[0].element : null;
      })()`,
    })) as {
      result?: { objectId?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    const objectId = evaluated.result?.objectId;
    if (objectId === undefined) {
      return yield* failCommand(
        contents,
        "resolveTarget",
        `no visible element has text ${JSON.stringify(target.text)}; take a new snapshot, use a selector, or try a shorter text`,
      );
    }

    const described = (yield* sendCommand(contents, "DOM.describeNode", { objectId }).pipe(
      Effect.ensuring(
        sendCommand(contents, "Runtime.releaseObject", { objectId }).pipe(Effect.ignore),
      ),
      Effect.catch(() =>
        failCommand(
          contents,
          "resolveTarget",
          `the element with text ${JSON.stringify(target.text)} disappeared; take a new snapshot and try again`,
        ),
      ),
    )) as { node?: { backendNodeId?: number } };
    const backendNodeId = described.node?.backendNodeId;
    if (backendNodeId === undefined) {
      return yield* failCommand(
        contents,
        "resolveTarget",
        `no visible element has text ${JSON.stringify(target.text)}; take a new snapshot or use a selector`,
      );
    }
    return backendNodeId;
  });

  /**
   * Turns a picked node into something that still means something later.
   *
   * Everything is read in one page-side evaluation so the description matches a
   * single moment: reading the tag, then the text, then the box across separate
   * round trips would let the page change underneath and produce a description
   * that never existed.
   */
  const describePickedNode = (send: typeof sendCommand) =>
    Effect.fn("PreviewAutomation.describePickedNode")(function* (
      contents: WebContents,
      backendNodeId: number,
    ) {
      const resolved = yield* send(contents, "DOM.resolveNode", { backendNodeId });
      const objectId = (resolved as { object?: { objectId?: string } }).object?.objectId;
      if (objectId === undefined) {
        return null;
      }

      const description = yield* send(contents, "Runtime.callFunctionOn", {
        objectId,
        returnByValue: true,
        functionDeclaration: `function () {
      const element = this;
      const rect = element.getBoundingClientRect();
      // A path that a person could paste into the console: id when it is
      // unique, otherwise tag plus nth-of-type up to a sensible depth.
      const path = (node) => {
        const parts = [];
        let current = node;
        while (current && current.nodeType === 1 && parts.length < 5) {
          if (current.id) {
            parts.unshift('#' + CSS.escape(current.id));
            break;
          }
          const tag = current.tagName.toLowerCase();
          const parent = current.parentElement;
          if (!parent) {
            parts.unshift(tag);
            break;
          }
          const siblings = [...parent.children].filter((c) => c.tagName === current.tagName);
          parts.unshift(
            siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')' : tag,
          );
          current = parent;
        }
        return parts.join(' > ');
      };
      // Spaces collapse but line breaks survive: a heading and the paragraph
      // after it are different lines, and squashing them together reads as one
      // run-on sentence wherever this is shown.
      const text = (element.innerText || element.textContent || '')
        .replace(/[^\\S\\n]+/g, ' ')
        .replace(/\\n{2,}/g, '\\n')
        .trim();
      return {
        tagName: element.tagName.toLowerCase(),
        selector: path(element),
        text: text === '' ? null : text.slice(0, 200),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        url: location.href,
      };
    }`,
      });

      yield* send(contents, "Runtime.releaseObject", { objectId }).pipe(Effect.ignore);

      const value = (description as { result?: { value?: Record<string, unknown> } }).result?.value;
      if (value === undefined) {
        return null;
      }

      // Role and name come from the accessibility tree, which is how the agent
      // identifies elements everywhere else in this feature.
      const axNode = yield* send(contents, "Accessibility.getPartialAXTree", {
        backendNodeId,
        fetchRelatives: false,
      }).pipe(Effect.orElseSucceed(() => ({}) as Record<string, unknown>));
      const nodes = (axNode as { nodes?: ReadonlyArray<Record<string, unknown>> }).nodes ?? [];
      const first = nodes[0];
      // An AX property is { type, value } -- the string sits one level down,
      // not two. Reading it a level too deep yielded undefined for every
      // element, which the fallback below then reported as "no role", silently.
      const readValue = (field: unknown): string | null => {
        const raw = (field as { value?: unknown } | undefined)?.value;
        return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
      };

      return {
        // Both come from the user rather than the DOM; the caller attaches them.
        note: null,
        styleChanges: [],
        tagName: String(value.tagName ?? "element"),
        role: first === undefined ? null : readValue(first.role),
        name: first === undefined ? null : readValue(first.name),
        selector: String(value.selector ?? ""),
        text: (value.text as string | null) ?? null,
        rect: value.rect as { x: number; y: number; width: number; height: number },
        url: String(value.url ?? ""),
      } satisfies DesktopPreviewPickedElement;
    });

  /**
   * Describes the elements an overlay left behind for us.
   *
   * Read back by identity rather than by hit-testing a point again: the second
   * test can land on a different element than the one the user watched light
   * up, and for a region or a circled group no single point names the set at
   * all. Must run before the overlay is torn down, since the teardown is what
   * drops the handles.
   */
  const describeStashed = Effect.fn("PreviewAutomation.describeStashed")(function* (
    contents: WebContents,
    stash: string,
    count: number,
  ) {
    const described: DesktopPreviewPickedElement[] = [];
    for (let index = 0; index < count; index += 1) {
      const handle = (yield* sendCommand(contents, "Runtime.evaluate", {
        expression: `window[${JSON.stringify(stash)}][${index}]`,
      })) as { result?: { objectId?: string } };
      const objectId = handle.result?.objectId;
      if (objectId === undefined) {
        continue;
      }
      const node = (yield* sendCommand(contents, "DOM.describeNode", { objectId })) as {
        node?: { backendNodeId?: number };
      };
      yield* sendCommand(contents, "Runtime.releaseObject", { objectId }).pipe(Effect.ignore);
      const backendNodeId = node.node?.backendNodeId;
      if (backendNodeId === undefined) {
        continue;
      }
      const element = yield* describePickedNode(sendCommand)(contents, backendNodeId);
      if (element !== null) {
        described.push(element);
      }
    }
    return described;
  });

  const buildStatus = (webContentsId: number, contents: WebContents): DesktopPreviewStatus => {
    const tab = attached.get(webContentsId);
    return {
      webContentsId,
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      attached: contents.debugger.isAttached(),
      console: tab?.console ?? [],
      networkFailures: tab?.networkFailures ?? [],
    };
  };

  /**
   * Attaches the debugger, or re-attaches one that has gone.
   *
   * The bookkeeping map is not the question: it records that we set a tab up,
   * not that the debugger is still on it. Only one client may attach at a time,
   * so opening DevTools on the page takes it away from us, and a crashed or
   * reloaded guest drops it too. Asking the map alone meant that once the
   * attachment was lost it never came back, and every command after that failed
   * with "No target available" -- which reads as the whole browser being broken
   * rather than as one thing to redo.
   */
  const attach = Effect.fn("PreviewAutomation.attach")(function* (webContentsId: number) {
    const contents = yield* resolve(webContentsId);
    if (attached.has(webContentsId) && contents.debugger.isAttached()) {
      return buildStatus(webContentsId, contents);
    }
    // Set up once before, but not attached now: the old listeners belong to an
    // attachment that no longer exists, and leaving them would double every
    // console entry once a new one is made.
    const stale = attached.get(webContentsId);
    if (stale !== undefined) {
      stale.dispose();
      attached.delete(webContentsId);
    }

    const tab: AttachedTab = {
      contents,
      console: [],
      networkFailures: [],
      requestUrls: new Map(),
      dispose: () => {},
    };

    if (!contents.debugger.isAttached()) {
      yield* Effect.try({
        try: () => contents.debugger.attach("1.3"),
        catch: (cause) =>
          new PreviewCommandError({ webContentsId, method: "debugger.attach", cause }),
      });
    }

    const pushConsole = (entry: DesktopPreviewConsoleEntry) => {
      if (isHostInjectedConsoleEntry(entry)) {
        return;
      }
      tab.console.push(entry);
      if (tab.console.length > MAX_CONSOLE_ENTRIES) tab.console.shift();
    };

    const onMessage = (_event: unknown, method: string, params: Record<string, unknown>) => {
      if (method === "Runtime.consoleAPICalled") {
        const args = (params.args as ReadonlyArray<{ value?: unknown }> | undefined) ?? [];
        pushConsole({
          level: String(params.type ?? "log"),
          text: args
            .map((arg) => (arg.value === undefined ? "" : String(arg.value)))
            .join(" ")
            .trim(),
          at: new Date().toISOString(),
        });
        return;
      }
      if (method === "Runtime.exceptionThrown") {
        const details = params.exceptionDetails as { text?: string } | undefined;
        pushConsole({
          level: "error",
          text: details?.text ?? "Uncaught exception",
          at: new Date().toISOString(),
        });
        return;
      }
      if (method === "Network.requestWillBeSent") {
        const requestId = String(params.requestId ?? "");
        const request = params.request as { url?: string } | undefined;
        if (requestId !== "" && request?.url !== undefined) {
          tab.requestUrls.set(requestId, request.url);
        }
        return;
      }
      if (method === "Network.loadingFailed") {
        const requestId = String(params.requestId ?? "");
        tab.networkFailures.push({
          url: tab.requestUrls.get(requestId) ?? "",
          status: null,
          errorText: String(params.errorText ?? "request failed"),
          at: new Date().toISOString(),
        });
        tab.requestUrls.delete(requestId);
        if (tab.networkFailures.length > MAX_NETWORK_FAILURES) tab.networkFailures.shift();
        return;
      }
      if (method === "Log.entryAdded") {
        // Browser-level messages the page never printed itself: CSP violations,
        // CORS refusals, mixed content. Exactly the failures a developer asks
        // an agent about, and invisible to Runtime.consoleAPICalled.
        const entry = params.entry as { level?: string; text?: string } | undefined;
        pushConsole({
          level: entry?.level ?? "info",
          text: entry?.text ?? "",
          at: new Date().toISOString(),
        });
        return;
      }
      if (method === "Network.responseReceived") {
        const response = params.response as { url?: string; status?: number } | undefined;
        if (response?.status !== undefined && response.status >= 400) {
          tab.networkFailures.push({
            url: response.url ?? "",
            status: response.status,
            errorText: null,
            at: new Date().toISOString(),
          });
          if (tab.networkFailures.length > MAX_NETWORK_FAILURES) tab.networkFailures.shift();
        }
        return;
      }
      if (method === "Page.frameNavigated") {
        const frame = params.frame as { parentId?: string } | undefined;
        // Only the main frame: an iframe navigating is not a new page, and
        // clearing on it would discard the diagnostics being asked about.
        if (frame?.parentId === undefined) {
          tab.console.length = 0;
          tab.networkFailures.length = 0;
          tab.requestUrls.clear();
        }
      }
    };

    contents.debugger.on("message", onMessage);
    const onDestroyed = () => {
      attached.delete(webContentsId);
    };
    // Electron tells us when the attachment goes -- DevTools opening, the guest
    // crashing, someone calling detach. Dropping the record here is what lets
    // the next command notice and rebuild rather than fail.
    const onDetach = () => {
      attached.get(webContentsId)?.dispose();
      attached.delete(webContentsId);
    };
    contents.once("destroyed", onDestroyed);
    contents.debugger.on("detach", onDetach);
    tab.dispose = () => {
      contents.debugger.off("message", onMessage);
      contents.debugger.off("detach", onDetach);
      contents.off("destroyed", onDestroyed);
    };
    attached.set(webContentsId, tab);

    for (const method of [
      "Runtime.enable",
      "Page.enable",
      "Network.enable",
      "Log.enable",
      "Accessibility.enable",
    ]) {
      yield* sendCommand(contents, method);
    }

    return buildStatus(webContentsId, contents);
  });

  /**
   * The tab, with a debugger certainly on it.
   *
   * Every operation goes through this rather than through `resolve`, because
   * the attachment can be taken away at any moment -- DevTools opening on the
   * page is enough -- and the alternative is a browser that works until it
   * quietly does not. Attaching is cheap when it is already attached.
   */
  const resolveAttached = Effect.fn("PreviewAutomation.resolveAttached")(function* (
    webContentsId: number,
  ) {
    yield* attach(webContentsId);
    return yield* resolve(webContentsId);
  });

  const centerOf = Effect.fn("PreviewAutomation.centerOf")(function* (
    contents: WebContents,
    backendNodeId: number,
  ) {
    const box = (yield* sendCommand(contents, "DOM.getBoxModel", { backendNodeId })) as {
      model?: { content?: ReadonlyArray<number> };
    };
    const quad = box.model?.content;
    if (quad === undefined || quad.length < 8) {
      return yield* Effect.fail(
        new PreviewCommandError({
          webContentsId: contents.id,
          method: "DOM.getBoxModel",
          cause: `element ${backendNodeId} has no layout box`,
        }),
      );
    }
    // Centre of the border box: the quad is four corner pairs, clockwise.
    return {
      x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4,
      y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4,
    };
  });

  return PreviewAutomation.of({
    attach,
    detach: (webContentsId: number) =>
      Effect.sync(() => {
        const tab = attached.get(webContentsId);
        if (tab === undefined) return;
        tab.dispose();
        attached.delete(webContentsId);
        if (!tab.contents.isDestroyed() && tab.contents.debugger.isAttached()) {
          tab.contents.debugger.detach();
        }
      }),
    status: Effect.fn("PreviewAutomation.status")(function* (webContentsId: number) {
      const contents = yield* resolveAttached(webContentsId);
      return buildStatus(webContentsId, contents);
    }),
    snapshot: Effect.fn("PreviewAutomation.snapshot")(function* (webContentsId: number) {
      const contents = yield* resolveAttached(webContentsId);
      // Playwright's aria snapshot rather than our own walk of the CDP tree.
      // Ours kept actionable and landmark nodes that had an accessible name,
      // which meant an agent could see every button on a page and not one word
      // of what the page said -- asked what a paragraph read, it had to fall
      // back to running JavaScript. This carries the text, the structure and a
      // ref on everything, in one string that costs less than the array did.
      const result = yield* evaluateInjected(contents, buildAriaSnapshotScript(), {
        returnByValue: true,
      });
      const page = typeof result.value === "string" ? result.value : "";
      return { ...buildStatus(webContentsId, contents), page };
    }),
    setViewport: Effect.fn("PreviewAutomation.setViewport")(function* (
      webContentsId: number,
      size: { width: number | null; height: number | null },
    ) {
      const contents = yield* resolveAttached(webContentsId);
      // Resizing the element alone leaves the page believing it is still the
      // old size: media queries do not re-evaluate and innerWidth is unchanged,
      // so a narrow frame just clips a desktop layout instead of showing the
      // mobile one. Overriding the metrics is what device mode actually is.
      if (size.width === null || size.height === null) {
        yield* sendCommand(contents, "Emulation.clearDeviceMetricsOverride", {});
        return;
      }
      yield* sendCommand(contents, "Emulation.setDeviceMetricsOverride", {
        width: size.width,
        height: size.height,
        // Zero means "use the host's", which keeps text crisp on a retina
        // display rather than rendering the page at 1x.
        deviceScaleFactor: 0,
        mobile: false,
      });
    }),
    /**
     * Uses DevTools' own element picker rather than injecting a script into the
     * page. The guest keeps its preload stripped and context isolation intact,
     * and the highlight the user sees while choosing is Chromium's, so it
     * behaves exactly as it does in DevTools.
     */
    pickElement: Effect.fn("PreviewAutomation.pickElement")(function* (
      webContentsId: number,
      colorScheme: "light" | "dark",
      mode: DesktopPreviewPickMode,
    ) {
      const contents = yield* resolveAttached(webContentsId);
      let supersede = () => {};
      const token = { supersede: () => supersede() };
      pendingPicks.get(webContentsId)?.supersede();
      pendingPicks.set(webContentsId, token);

      yield* sendCommand(contents, "DOM.enable", {});
      yield* sendCommand(contents, "Runtime.enable", {});
      // The binding is how the injected overlay reports back. Adding it twice
      // is harmless, and it must exist before the script that calls it runs.
      yield* sendCommand(contents, "Runtime.addBinding", {
        name: PICK_OVERLAY_BINDING,
      }).pipe(Effect.ignore);

      yield* sendCommand(contents, "Runtime.evaluate", {
        expression: buildPickOverlayScript(colorScheme, mode),
      });

      const picked = yield* Effect.tryPromise({
        try: () =>
          new Promise<PickResult | null>((resolve) => {
            let done = false;
            const finish = (value: PickResult | null) => {
              if (done) return;
              done = true;
              contents.debugger.off("message", onMessage);
              clearTimeout(timer);
              resolve(value);
            };
            const onMessage = (
              _event: unknown,
              method: string,
              params: Record<string, unknown>,
            ) => {
              if (method !== "Runtime.bindingCalled" || params.name !== PICK_OVERLAY_BINDING) {
                return;
              }
              try {
                const payload = JSON.parse(String(params.payload ?? "{}")) as {
                  count?: number;
                  note?: string | null;
                  styleChanges?: ReadonlyArray<{ property: string; from: string; to: string }>;
                  cancelled?: boolean;
                };
                finish(
                  payload.cancelled === true || payload.count === undefined || payload.count < 1
                    ? null
                    : {
                        count: payload.count,
                        note: payload.note ?? null,
                        styleChanges: payload.styleChanges ?? [],
                      },
                );
              } catch {
                finish(null);
              }
            };
            contents.debugger.on("message", onMessage);
            // Reaching for another tool settles this one, rather than leaving
            // it waiting on a binding that will never be called.
            supersede = () => {
              pendingPicks.delete(webContentsId);
              finish(null);
            };
            // Picking is a deliberate act; if the user wanders off, stop
            // waiting rather than leaving the overlay armed forever.
            const timer = setTimeout(() => finish(null), PICK_TIMEOUT_MS);
          }),
        catch: (cause) =>
          new PreviewCommandError({ webContentsId, method: "Runtime.bindingCalled", cause }),
      });

      // A superseded pick owns nothing on the page any more: its overlay was
      // replaced, and tearing down would take its replacement with it.
      const current = pendingPicks.get(webContentsId) === token;
      if (current) {
        pendingPicks.delete(webContentsId);
      }

      // Described before the teardown runs, because the teardown is what drops
      // the overlay's handles on the elements it chose.
      const described: DesktopPreviewPickedElement[] = [];
      if (current && picked !== null) {
        const elements = yield* describeStashed(contents, PICK_OVERLAY_STASH, picked.count);
        for (const element of elements) {
          described.push({
            ...element,
            note: picked.note,
            // Attached to the element they were made on. A region shares one
            // note but tweaks only ever apply to a lone element, so this is
            // never spread across a set.
            styleChanges: picked.styleChanges,
          });
        }
      }

      if (current) {
        yield* sendCommand(contents, "Runtime.evaluate", {
          expression: PICK_OVERLAY_TEARDOWN_SCRIPT,
        }).pipe(Effect.ignore);
      }

      return described;
    }),
    awaitDrawing: Effect.fn("PreviewAutomation.awaitDrawing")(function* (webContentsId: number) {
      const contents = yield* resolveAttached(webContentsId);
      yield* sendCommand(contents, "DOM.enable", {});
      yield* sendCommand(contents, "Runtime.enable", {});
      yield* sendCommand(contents, "Runtime.addBinding", {
        name: DRAW_OVERLAY_BINDING,
      }).pipe(Effect.ignore);

      const attached = yield* Effect.tryPromise({
        try: () =>
          new Promise<{ note: string | null; count: number } | null>((settle) => {
            let done = false;
            const finish = (value: { note: string | null; count: number } | null) => {
              if (done) return;
              done = true;
              contents.debugger.off("message", onMessage);
              settle(value);
            };
            const onMessage = (
              _event: unknown,
              method: string,
              params: Record<string, unknown>,
            ) => {
              if (method !== "Runtime.bindingCalled" || params.name !== DRAW_OVERLAY_BINDING) {
                return;
              }
              try {
                const payload = JSON.parse(String(params.payload ?? "{}")) as {
                  note?: string | null;
                  count?: number;
                  cancelled?: boolean;
                };
                finish(
                  payload.cancelled === true
                    ? null
                    : { note: payload.note ?? null, count: payload.count ?? 0 },
                );
              } catch {
                finish(null);
              }
            };
            contents.debugger.on("message", onMessage);
            // No timeout: unlike a pick, drawing is not a question waiting on an
            // answer. The mode stays armed until the user puts the pen down,
            // and turning it off is what cancels this.
            drawWaiters.set(webContentsId, () => finish(null));
          }),
        catch: (cause) =>
          new PreviewCommandError({ webContentsId, method: "Runtime.bindingCalled", cause }),
      });
      drawWaiters.delete(webContentsId);
      if (attached === null) {
        return null;
      }

      // Described while the ink is still up, because the caller photographs the
      // page next and the strokes have to be in the picture.
      const elements = yield* describeStashed(contents, DRAW_OVERLAY_STASH, attached.count);
      return {
        note: attached.note,
        elements: elements.map((element) => ({ ...element, note: attached.note })),
      } satisfies DesktopPreviewDrawing;
    }),
    setAnnotationMode: Effect.fn("PreviewAutomation.setAnnotationMode")(function* (
      webContentsId: number,
      mode: DesktopPreviewAnnotationMode | null,
    ) {
      const contents = yield* resolveAttached(webContentsId);
      if (mode === null || mode === "idle") {
        // Clearing the marks is how a drawing is abandoned and parking them is
        // how it is set aside; either way whoever is waiting on one has to stop
        // waiting rather than outlive the pen. Coming back to it starts a new
        // wait, and the ink is still there to attach.
        drawWaiters.get(webContentsId)?.();
      }
      // Nothing is read back, so this is a plain evaluation rather than the
      // binding round trip picking needs.
      yield* sendCommand(contents, "Runtime.evaluate", {
        expression: mode === null ? DRAW_OVERLAY_TEARDOWN_SCRIPT : buildDrawOverlayScript(mode),
      });
    }),
    revealElement: Effect.fn("PreviewAutomation.revealElement")(function* (
      webContentsId: number,
      selector: string,
    ) {
      const contents = yield* resolveAttached(webContentsId);
      const result = (yield* sendCommand(contents, "Runtime.evaluate", {
        expression: buildRevealElementScript(selector),
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      return result.result?.value === true;
    }),
    cancelPick: Effect.fn("PreviewAutomation.cancelPick")(function* (webContentsId: number) {
      const contents = yield* resolveAttached(webContentsId);
      pendingPicks.get(webContentsId)?.supersede();
      yield* sendCommand(contents, "Runtime.evaluate", {
        expression: PICK_OVERLAY_TEARDOWN_SCRIPT,
      }).pipe(Effect.ignore);
    }),
    setColorScheme: Effect.fn("PreviewAutomation.setColorScheme")(function* (
      webContentsId: number,
      colorScheme: "light" | "dark",
    ) {
      const contents = yield* resolveAttached(webContentsId);
      // Emulated rather than set on the guest: the page decides what to do with
      // prefers-color-scheme, and pages that ignore it are left alone.
      yield* sendCommand(contents, "Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: colorScheme }],
      });
    }),
    openDevTools: Effect.fn("PreviewAutomation.openDevTools")(function* (webContentsId: number) {
      const contents = yield* resolveAttached(webContentsId);
      // Undocked: the guest is a small pane inside our layout, and devtools
      // docked into it would leave almost nothing of the page visible.
      yield* Effect.sync(() => {
        contents.openDevTools({ mode: "detach" });
      });
    }),
    screenshot: Effect.fn("PreviewAutomation.screenshot")(function* (webContentsId: number) {
      const contents = yield* resolveAttached(webContentsId);
      // Captured through CDP rather than capturePage so the image is the page
      // itself, unaffected by the window being occluded or offscreen.
      const shot = (yield* sendCommand(contents, "Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      })) as { data?: string };
      const metrics = (yield* sendCommand(contents, "Page.getLayoutMetrics", {})) as {
        cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
      };
      return {
        dataUrl: `data:image/png;base64,${shot.data ?? ""}`,
        width: Math.round(metrics.cssVisualViewport?.clientWidth ?? 0),
        height: Math.round(metrics.cssVisualViewport?.clientHeight ?? 0),
      };
    }),
    click: Effect.fn("PreviewAutomation.click")(function* (input: DesktopPreviewClickInput) {
      const contents = yield* resolveAttached(input.webContentsId);
      const backendNodeId = yield* resolveTarget(contents, input.target);
      const point = yield* centerOf(contents, backendNodeId);
      // Real input events rather than element.click(): hover, focus and blur
      // fire as they would for a person, and a handler that checks isTrusted
      // behaves the same way too.
      yield* sendCommand(contents, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
      yield* sendCommand(contents, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
      return point;
    }),
    type: Effect.fn("PreviewAutomation.type")(function* (input: DesktopPreviewTypeInput) {
      const contents = yield* resolveAttached(input.webContentsId);
      const backendNodeId = yield* resolveTarget(contents, input.target);
      const point = yield* centerOf(contents, backendNodeId);
      yield* sendCommand(contents, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
      yield* sendCommand(contents, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
      });
      if (input.clear === true) {
        // `commands` invokes the editing command directly, which is what a
        // modifier chord ultimately triggers. Dispatching Meta+A as a raw key
        // does not: the browser resolves shortcuts to editing commands above
        // the layer CDP injects at, so the keypress arrives and selects
        // nothing, and the insert below lands wherever the caret happened to
        // be -- mid-word, since a click centres it.
        yield* sendCommand(contents, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "a",
          code: "KeyA",
          windowsVirtualKeyCode: 65,
          commands: ["selectAll"],
        });
        yield* sendCommand(contents, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "a",
          code: "KeyA",
          windowsVirtualKeyCode: 65,
        });
      }
      yield* sendCommand(contents, "Input.insertText", { text: input.text });
      // The caret is where the agent is. Returned so the pointer travels to the
      // field it is typing into rather than sitting on the last thing clicked.
      return point;
    }),
    press: Effect.fn("PreviewAutomation.press")(function* (input: DesktopPreviewPressInput) {
      const contents = yield* resolveAttached(input.webContentsId);
      const definition = toCdpKeyDefinition(input.key);
      const modifiers = toCdpModifierBitmask(input.modifiers);
      yield* sendCommand(contents, "Input.dispatchKeyEvent", {
        type: "keyDown",
        ...definition,
        modifiers,
      });
      const { text: _text, ...releasedDefinition } = definition;
      yield* sendCommand(contents, "Input.dispatchKeyEvent", {
        type: "keyUp",
        ...releasedDefinition,
        modifiers,
      });
    }),
    scroll: Effect.fn("PreviewAutomation.scroll")(function* (input: DesktopPreviewScrollInput) {
      const contents = yield* resolveAttached(input.webContentsId);
      if (input.target !== undefined) {
        const backendNodeId = yield* resolveTarget(contents, input.target);
        yield* sendCommand(contents, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
        return;
      }

      const metrics = (yield* sendCommand(contents, "Page.getLayoutMetrics", {})) as {
        cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
      };
      yield* sendCommand(contents, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: (metrics.cssVisualViewport?.clientWidth ?? 0) / 2,
        y: (metrics.cssVisualViewport?.clientHeight ?? 0) / 2,
        deltaX: input.deltaX ?? 0,
        deltaY: input.deltaY ?? 0,
      });
    }),
    evaluate: Effect.fn("PreviewAutomation.evaluate")(function* (
      input: DesktopPreviewEvaluateInput,
    ) {
      const contents = yield* resolveAttached(input.webContentsId);
      const result = (yield* sendCommand(contents, "Runtime.evaluate", {
        expression: input.expression,
        returnByValue: true,
        awaitPromise: true,
      })) as {
        result?: { value?: unknown };
        exceptionDetails?: {
          text?: string;
          exception?: { description?: string; value?: unknown };
        };
      };
      if (result.exceptionDetails !== undefined) {
        const exception = result.exceptionDetails.exception;
        const detail =
          exception?.description ??
          (exception?.value === undefined ? undefined : String(exception.value)) ??
          result.exceptionDetails.text ??
          "the expression threw an exception";
        return yield* failCommand(contents, "Runtime.evaluate", detail);
      }
      return result.result?.value;
    }),
    waitFor: Effect.fn("PreviewAutomation.waitFor")(function* (input: DesktopPreviewWaitForInput) {
      const contents = yield* resolveAttached(input.webContentsId);
      const timeoutMs = Math.max(0, input.timeoutMs ?? 10_000);
      const startedAt = Date.now();
      let unmet: string[] = [];

      while (true) {
        unmet = [];

        if (input.target !== undefined) {
          const found = yield* resolveTarget(contents, input.target).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (!found) {
            unmet.push(`target ${targetDescription(input.target)}`);
          }
        }

        if (input.text !== undefined) {
          const textResult = (yield* sendCommand(contents, "Runtime.evaluate", {
            expression: `Boolean(document.body?.innerText.includes(${JSON.stringify(input.text)}))`,
            returnByValue: true,
          }).pipe(Effect.orElseSucceed(() => ({ result: { value: false } })))) as {
            result?: { value?: unknown };
          };
          if (textResult.result?.value !== true) {
            unmet.push(`page text ${JSON.stringify(input.text)}`);
          }
        }

        if (input.urlContains !== undefined && !contents.getURL().includes(input.urlContains)) {
          unmet.push(`URL containing ${JSON.stringify(input.urlContains)}`);
        }

        if (unmet.length === 0) {
          return;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          return yield* failCommand(
            contents,
            "waitFor",
            `timed out after ${timeoutMs}ms; these conditions never became true together: ${unmet.join(", ")}`,
          );
        }

        yield* Effect.sleep("150 millis");
      }
    }),
  });
}).pipe(Effect.withSpan("PreviewAutomation.make"));

export const layer = Layer.effect(PreviewAutomation, make);
