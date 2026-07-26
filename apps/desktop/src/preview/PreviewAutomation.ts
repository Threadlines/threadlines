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
  DesktopPreviewPickedElement,
  DesktopPreviewConsoleEntry,
  DesktopPreviewElement,
  DesktopPreviewNetworkFailure,
  DesktopPreviewSnapshot,
  DesktopPreviewScreenshot,
  DesktopPreviewStatus,
} from "@threadlines/contracts";
import { webContents, type WebContents } from "electron";

import { isHostInjectedConsoleEntry } from "./previewConsoleNoise.ts";
import {
  PICK_OVERLAY_BINDING,
  PICK_OVERLAY_SCRIPT,
  PICK_OVERLAY_TEARDOWN_SCRIPT,
} from "./pickOverlayScript.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/**
 * Roles worth handing to an agent. The full accessibility tree of a real page
 * runs to thousands of nodes, most of them generic containers and text, which
 * would bury the handful of things that can actually be acted on.
 */
const ACTIONABLE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textarea",
]);

/** Kept for orientation: they tell the agent where it is, not what to press. */
const LANDMARK_ROLES: ReadonlySet<string> = new Set([
  "heading",
  "alert",
  "status",
  "dialog",
  "navigation",
  "main",
]);

const MAX_SNAPSHOT_ELEMENTS = 200;

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
    return `Preview command ${this.method} failed for webContents ${this.webContentsId}.`;
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
      webContentsId: number,
      expression: string,
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
    ) => Effect.Effect<DesktopPreviewPickedElement | null, PreviewAutomationError>;
    readonly cancelPick: (webContentsId: number) => Effect.Effect<void, PreviewAutomationError>;
    readonly setColorScheme: (
      webContentsId: number,
      colorScheme: "light" | "dark",
    ) => Effect.Effect<void, PreviewAutomationError>;
    readonly screenshot: (
      webContentsId: number,
    ) => Effect.Effect<DesktopPreviewScreenshot, PreviewAutomationError>;
    readonly click: (
      webContentsId: number,
      ref: number,
    ) => Effect.Effect<void, PreviewAutomationError>;
    readonly type: (input: {
      webContentsId: number;
      ref: number;
      text: string;
      clear?: boolean | undefined;
    }) => Effect.Effect<void, PreviewAutomationError>;
  }
>()("@threadlines/desktop/preview/PreviewAutomation") {}

export const make = Effect.gen(function* PreviewAutomationMake() {
  const attached = new Map<number, AttachedTab>();

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
        tagName: String(value.tagName ?? "element"),
        role: first === undefined ? null : readValue(first.role),
        name: first === undefined ? null : readValue(first.name),
        selector: String(value.selector ?? ""),
        text: (value.text as string | null) ?? null,
        rect: value.rect as { x: number; y: number; width: number; height: number },
        url: String(value.url ?? ""),
      } satisfies DesktopPreviewPickedElement;
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

  const attach = Effect.fn("PreviewAutomation.attach")(function* (webContentsId: number) {
    const contents = yield* resolve(webContentsId);
    if (attached.has(webContentsId)) {
      return buildStatus(webContentsId, contents);
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
    contents.once("destroyed", onDestroyed);
    tab.dispose = () => {
      contents.debugger.off("message", onMessage);
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
      const contents = yield* resolve(webContentsId);
      return buildStatus(webContentsId, contents);
    }),
    snapshot: Effect.fn("PreviewAutomation.snapshot")(function* (webContentsId: number) {
      const contents = yield* resolve(webContentsId);
      const tree = (yield* sendCommand(contents, "Accessibility.getFullAXTree", {})) as {
        nodes?: ReadonlyArray<Record<string, unknown>>;
      };
      const elements: DesktopPreviewElement[] = [];
      for (const node of tree.nodes ?? []) {
        if (elements.length >= MAX_SNAPSHOT_ELEMENTS) break;
        if (node.ignored === true) continue;
        const role = String((node.role as { value?: unknown } | undefined)?.value ?? "");
        const isActionable = ACTIONABLE_ROLES.has(role);
        if (!isActionable && !LANDMARK_ROLES.has(role)) continue;
        const name = String((node.name as { value?: unknown } | undefined)?.value ?? "").trim();
        // An actionable control with no accessible name cannot be described to
        // an agent, and is usually decorative; a landmark without one is noise.
        if (name === "") continue;
        const backendNodeId = node.backendDOMNodeId;
        if (typeof backendNodeId !== "number") continue;
        const properties =
          (node.properties as ReadonlyArray<{ name?: string; value?: { value?: unknown } }>) ?? [];
        const disabled = properties.some(
          (property) => property.name === "disabled" && property.value?.value === true,
        );
        const rawValue = (node.value as { value?: unknown } | undefined)?.value;
        elements.push({
          ref: backendNodeId,
          role,
          name,
          value: rawValue === undefined || rawValue === null ? null : String(rawValue),
          disabled,
        });
      }
      return { ...buildStatus(webContentsId, contents), elements };
    }),
    setViewport: Effect.fn("PreviewAutomation.setViewport")(function* (
      webContentsId: number,
      size: { width: number | null; height: number | null },
    ) {
      const contents = yield* resolve(webContentsId);
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
    pickElement: Effect.fn("PreviewAutomation.pickElement")(function* (webContentsId: number) {
      const contents = yield* resolve(webContentsId);
      yield* sendCommand(contents, "DOM.enable", {});
      yield* sendCommand(contents, "Runtime.enable", {});
      // The binding is how the injected overlay reports back. Adding it twice
      // is harmless, and it must exist before the script that calls it runs.
      yield* sendCommand(contents, "Runtime.addBinding", {
        name: PICK_OVERLAY_BINDING,
      }).pipe(Effect.ignore);

      yield* sendCommand(contents, "Runtime.evaluate", {
        expression: PICK_OVERLAY_SCRIPT,
      });

      const pickedPoint = yield* Effect.tryPromise({
        try: () =>
          new Promise<{ x: number; y: number } | null>((resolve) => {
            let done = false;
            const finish = (value: { x: number; y: number } | null) => {
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
                  x?: number;
                  y?: number;
                  cancelled?: boolean;
                };
                finish(
                  payload.cancelled === true || payload.x === undefined || payload.y === undefined
                    ? null
                    : { x: payload.x, y: payload.y },
                );
              } catch {
                finish(null);
              }
            };
            contents.debugger.on("message", onMessage);
            // Picking is a deliberate act; if the user wanders off, stop
            // waiting rather than leaving the overlay armed forever.
            const timer = setTimeout(() => finish(null), PICK_TIMEOUT_MS);
          }),
        catch: (cause) =>
          new PreviewCommandError({ webContentsId, method: "Runtime.bindingCalled", cause }),
      });

      yield* sendCommand(contents, "Runtime.evaluate", {
        expression: PICK_OVERLAY_TEARDOWN_SCRIPT,
      }).pipe(Effect.ignore);

      if (pickedPoint === null) {
        return null;
      }

      // The click point rather than the page's own idea of the element: this
      // resolves through the same accessibility tree the agent reads, so a
      // picked element is described exactly as a snapshotted one is.
      const located = (yield* sendCommand(contents, "DOM.getNodeForLocation", {
        x: Math.round(pickedPoint.x),
        y: Math.round(pickedPoint.y),
        includeUserAgentShadowDOM: false,
      })) as { backendNodeId?: number };
      if (located.backendNodeId === undefined) {
        return null;
      }
      return yield* describePickedNode(sendCommand)(contents, located.backendNodeId);
    }),
    cancelPick: Effect.fn("PreviewAutomation.cancelPick")(function* (webContentsId: number) {
      const contents = yield* resolve(webContentsId);
      yield* sendCommand(contents, "Runtime.evaluate", {
        expression: PICK_OVERLAY_TEARDOWN_SCRIPT,
      }).pipe(Effect.ignore);
    }),
    setColorScheme: Effect.fn("PreviewAutomation.setColorScheme")(function* (
      webContentsId: number,
      colorScheme: "light" | "dark",
    ) {
      const contents = yield* resolve(webContentsId);
      // Emulated rather than set on the guest: the page decides what to do with
      // prefers-color-scheme, and pages that ignore it are left alone.
      yield* sendCommand(contents, "Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: colorScheme }],
      });
    }),
    openDevTools: Effect.fn("PreviewAutomation.openDevTools")(function* (webContentsId: number) {
      const contents = yield* resolve(webContentsId);
      // Undocked: the guest is a small pane inside our layout, and devtools
      // docked into it would leave almost nothing of the page visible.
      yield* Effect.sync(() => {
        contents.openDevTools({ mode: "detach" });
      });
    }),
    screenshot: Effect.fn("PreviewAutomation.screenshot")(function* (webContentsId: number) {
      const contents = yield* resolve(webContentsId);
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
    click: Effect.fn("PreviewAutomation.click")(function* (webContentsId: number, ref: number) {
      const contents = yield* resolve(webContentsId);
      const point = yield* centerOf(contents, ref);
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
    }),
    type: Effect.fn("PreviewAutomation.type")(function* (input: {
      webContentsId: number;
      ref: number;
      text: string;
      clear?: boolean | undefined;
    }) {
      const contents = yield* resolve(input.webContentsId);
      const point = yield* centerOf(contents, input.ref);
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
    }),
    evaluate: Effect.fn("PreviewAutomation.evaluate")(function* (
      webContentsId: number,
      expression: string,
    ) {
      const contents = yield* resolve(webContentsId);
      const result = (yield* sendCommand(contents, "Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })) as { result?: { value?: unknown } };
      return result.result?.value ?? null;
    }),
  });
}).pipe(Effect.withSpan("PreviewAutomation.make"));

export const layer = Layer.effect(PreviewAutomation, make);
