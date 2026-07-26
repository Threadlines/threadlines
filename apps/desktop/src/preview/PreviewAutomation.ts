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
  DesktopPreviewConsoleEntry,
  DesktopPreviewElement,
  DesktopPreviewNetworkFailure,
  DesktopPreviewSnapshot,
  DesktopPreviewStatus,
} from "@threadlines/contracts";
import { webContents, type WebContents } from "electron";

import { isHostInjectedConsoleEntry } from "./previewConsoleNoise.ts";
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
