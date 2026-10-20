/**
 * MCP Apps (SEP-1865, https://github.com/modelcontextprotocol/ext-apps): an
 * MCP tool that ships a `ui://` HTML resource, which the chat shows as an
 * interactive card under the step that ran the tool (docs/mcp-apps.md).
 *
 * What the server and the web share: how servers declare a tool's app and a
 * resource's needs in `_meta.ui`, the content policy a card's frame runs
 * under, and the bridge's message names. The document a card's frame shows is
 * built by mcpAppDocument.ts; the web's host side of the bridge is
 * apps/web/src/components/chat/mcpAppHost.ts.
 */
import type { McpAppCsp, McpAppPermissions } from "@threadlines/contracts";

import type { AgentPageTheme } from "./agentPages.ts";

/** The resource type an MCP App's view is served as. */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
/** The MCP Apps protocol version Threadlines speaks. */
export const MCP_APP_PROTOCOL_VERSION = "2026-01-26";
/** Largest view document a card loads. */
export const MCP_APP_RESOURCE_MAX_BYTES = 2 * 1024 * 1024;
/** Largest tool input plus result a card keeps for its view. */
export const MCP_APP_CALL_MAX_BYTES = 512 * 1024;

export type McpAppToolVisibility = "model" | "app";

/** A tool's app, as its `_meta.ui` declares it. */
export interface McpToolUi {
  readonly resourceUri: string | null;
  /** Who may call the tool. The spec's default is both. */
  readonly visibility: ReadonlyArray<McpAppToolVisibility>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Whether `uri` names an MCP App view (`ui://server/view.html`). */
export function isMcpAppResourceUri(uri: unknown): uri is string {
  return typeof uri === "string" && /^ui:\/\/[^\s]+$/u.test(uri) && uri.length <= 2048;
}

/**
 * A tool's app from its `_meta`: `_meta.ui.resourceUri` and
 * `_meta.ui.visibility`, or the flat `_meta["ui/resourceUri"]` key of the
 * spec's earlier drafts. Null when the tool declares neither.
 */
export function mcpToolUiFromMeta(meta: unknown): McpToolUi | null {
  const record = asRecord(meta);
  if (!record) return null;
  const ui = asRecord(record.ui);
  const uri = ui?.resourceUri ?? record["ui/resourceUri"];
  const declared = Array.isArray(ui?.visibility)
    ? ui.visibility.filter(
        (entry): entry is McpAppToolVisibility => entry === "model" || entry === "app",
      )
    : null;
  if (!ui && !isMcpAppResourceUri(uri)) return null;
  return {
    resourceUri: isMcpAppResourceUri(uri) ? uri : null,
    visibility: declared ?? ["model", "app"],
  };
}

/** Whether an app may call a tool with this metadata: the spec lets a view
 *  call only tools whose visibility includes "app" (the default). A tool
 *  that declares nothing is callable. */
export function mcpToolCallableByApp(ui: McpToolUi | null): boolean {
  return ui === null || ui.visibility.includes("app");
}

// ---------------------------------------------------------------------------
// The view's needs (`_meta.ui` of its resource)

/** One item of a `resources/read` result, as a provider's MCP client gives it. */
export interface McpResourceContent {
  readonly uri: string;
  readonly mimeType?: string | undefined;
  readonly text?: string | undefined;
  readonly blob?: string | undefined;
  readonly _meta?: unknown;
}

export type { McpAppCsp, McpAppPermissions } from "@threadlines/contracts";

export interface McpAppResourceUi {
  readonly csp: McpAppCsp;
  readonly permissions: McpAppPermissions;
  /** Whether the view asks for a visible border and background; null lets the host decide. */
  readonly prefersBorder: boolean | null;
}

/** At most this many hosts of one kind; more is a mistake or an attempt. */
const MAX_SOURCES_PER_KIND = 32;

/**
 * A host as a content policy source: a scheme the spec names, a host name
 * (optionally `*.` for its subdomains, never a bare `*`), an optional port
 * and path. Anything else (a keyword, a scheme alone, a second source hidden
 * after a space or a `;`) is dropped, so a server cannot widen a policy past
 * the hosts it names.
 */
const SOURCE =
  /^(?:https?|wss?):\/\/(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::(?:\d{1,5}|\*))?(?:\/[a-z0-9._~%!$&()*+=:@/-]*)?$/iu;

function readSources(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  const sources = new Set<string>();
  for (const entry of value) {
    if (typeof entry === "string" && SOURCE.test(entry.trim())) sources.add(entry.trim());
    if (sources.size >= MAX_SOURCES_PER_KIND) break;
  }
  return [...sources];
}

/** A view resource's `_meta.ui`, with every host checked (see SOURCE). */
export function readMcpAppResourceUi(meta: unknown): McpAppResourceUi {
  const ui = asRecord(asRecord(meta)?.ui);
  const csp = asRecord(ui?.csp);
  const permissions = asRecord(ui?.permissions);
  const granted = (key: string) => asRecord(permissions?.[key]) !== undefined;
  const sources = (key: string) => {
    const list = readSources(csp?.[key]);
    return list.length > 0 ? { [key]: list } : {};
  };
  return {
    csp: {
      ...sources("connectDomains"),
      ...sources("resourceDomains"),
      ...sources("frameDomains"),
      ...sources("baseUriDomains"),
    },
    permissions: {
      ...(granted("camera") ? { camera: true } : {}),
      ...(granted("microphone") ? { microphone: true } : {}),
      ...(granted("geolocation") ? { geolocation: true } : {}),
      ...(granted("clipboardWrite") ? { clipboardWrite: true } : {}),
    },
    prefersBorder: typeof ui?.prefersBorder === "boolean" ? ui.prefersBorder : null,
  };
}

/**
 * The content policy a view runs under, mapped from the hosts its resource
 * declares as the spec lays out: nothing loads or connects unless declared.
 * Unlike the spec's own mapping there is no `'self'`: a card's frame has an
 * opaque origin with no server behind it. Forms post nowhere, so a view
 * cannot carry what it shows to an undeclared host that way.
 */
export function mcpAppContentSecurityPolicy(csp: McpAppCsp): string {
  const list = (sources: ReadonlyArray<string> | undefined) =>
    sources && sources.length > 0 ? ` ${sources.join(" ")}` : "";
  const resources = list(csp.resourceDomains);
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline'${resources}`,
    `style-src 'unsafe-inline'${resources}`,
    `connect-src${list(csp.connectDomains) || " 'none'"}`,
    `img-src data: blob:${resources}`,
    `font-src data:${resources}`,
    `media-src data: blob:${resources}`,
    `frame-src${list(csp.frameDomains) || " 'none'"}`,
    "object-src 'none'",
    `base-uri${list(csp.baseUriDomains) || " 'none'"}`,
    "form-action 'none'",
  ].join("; ");
}

/**
 * The frame's `allow` attribute for the features a view asked for. Only
 * clipboard writes are passed on: the desktop app grants a page's camera,
 * microphone and location requests without asking (the composer's dictation
 * relies on that), so a view never gets them.
 */
export function mcpAppFrameAllow(permissions: McpAppPermissions): string | undefined {
  return permissions.clipboardWrite ? "clipboard-write *" : undefined;
}

/** The sandbox flags of a card's frame: scripts and forms (which post
 *  nowhere, see the policy), an opaque origin, no pop-ups, no top navigation. */
export const MCP_APP_FRAME_SANDBOX = "allow-scripts allow-forms";

// ---------------------------------------------------------------------------
// Theme

/**
 * The spec's style variables from the app's theme, so a view that styles
 * itself with them matches the chat around it. Only what the app has an
 * equivalent for; a view falls back to its own for the rest.
 */
export function mcpAppStyleVariables(theme: AgentPageTheme): Record<string, string> {
  const from = (token: string) => theme.variables[token];
  const pairs: ReadonlyArray<readonly [string, string | undefined]> = [
    ["--color-background-primary", from("--background")],
    ["--color-background-secondary", from("--muted")],
    ["--color-background-tertiary", from("--card")],
    ["--color-background-inverse", from("--foreground")],
    ["--color-background-info", from("--info")],
    ["--color-background-danger", from("--destructive")],
    ["--color-background-success", from("--success")],
    ["--color-background-warning", from("--warning")],
    ["--color-text-primary", from("--foreground")],
    ["--color-text-secondary", from("--muted-foreground")],
    ["--color-text-tertiary", from("--muted-foreground")],
    ["--color-text-inverse", from("--background")],
    ["--color-text-info", from("--info-foreground")],
    ["--color-text-danger", from("--destructive-foreground")],
    ["--color-text-success", from("--success-foreground")],
    ["--color-text-warning", from("--warning-foreground")],
    ["--color-border-primary", from("--border")],
    ["--color-border-secondary", from("--input")],
    ["--color-ring-primary", from("--ring")],
    ["--font-sans", from("--font-sans")],
    ["--font-mono", from("--font-mono")],
    ["--border-radius-md", from("--radius")],
  ];
  return Object.fromEntries(
    pairs.filter((pair): pair is readonly [string, string] => typeof pair[1] === "string"),
  );
}

// ---------------------------------------------------------------------------
// Bridge messages (JSON-RPC 2.0 over postMessage)

export const MCP_APP_METHODS = {
  initialize: "ui/initialize",
  initialized: "ui/notifications/initialized",
  toolInput: "ui/notifications/tool-input",
  toolResult: "ui/notifications/tool-result",
  toolCancelled: "ui/notifications/tool-cancelled",
  hostContextChanged: "ui/notifications/host-context-changed",
  sizeChanged: "ui/notifications/size-changed",
  requestTeardown: "ui/notifications/request-teardown",
  resourceTeardown: "ui/resource-teardown",
  openLink: "ui/open-link",
  message: "ui/message",
  requestDisplayMode: "ui/request-display-mode",
  updateModelContext: "ui/update-model-context",
  toolsCall: "tools/call",
  ping: "ping",
  log: "notifications/message",
  /** Threadlines' own: a link the reader clicked in the view (the document's
   *  bootstrap sends it, so a plain link opens in the browser instead of
   *  navigating the card away). */
  linkClicked: "threadlines/link-clicked",
  /** Threadlines' own: the view's document is going away (it navigated). */
  viewLeft: "threadlines/view-left",
} as const;

export type McpAppJsonRpcId = string | number;

export type McpAppMessage =
  | {
      readonly kind: "request";
      readonly id: McpAppJsonRpcId;
      readonly method: string;
      readonly params: Record<string, unknown>;
    }
  | {
      readonly kind: "notification";
      readonly method: string;
      readonly params: Record<string, unknown>;
    }
  | {
      readonly kind: "response";
      readonly id: McpAppJsonRpcId;
      readonly result?: unknown;
      readonly error?: unknown;
    };

/** A JSON-RPC message a view posted, or undefined for anything else. */
export function readMcpAppMessage(data: unknown): McpAppMessage | undefined {
  const message = asRecord(data);
  if (!message || message.jsonrpc !== "2.0") return undefined;
  const id = message.id;
  const hasId = typeof id === "string" || typeof id === "number";
  if (typeof message.method === "string") {
    const params = asRecord(message.params) ?? {};
    return hasId
      ? { kind: "request", id, method: message.method, params }
      : { kind: "notification", method: message.method, params };
  }
  if (hasId && ("result" in message || "error" in message)) {
    return { kind: "response", id, result: message.result, error: message.error };
  }
  return undefined;
}

/** A view's `size-changed` height, if usable. */
export function readMcpAppHeight(params: Record<string, unknown>): number | undefined {
  const height = params.height;
  return typeof height === "number" && Number.isFinite(height) && height > 0
    ? Math.ceil(height)
    : undefined;
}

/** An http(s) URL a view asked to open, if that is what it is. */
export function readMcpAppLink(params: Record<string, unknown>): string | undefined {
  const url = params.url;
  if (typeof url !== "string" || url.length > 8192) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** The text of a `ui/message` request's content blocks, joined. */
export function readMcpAppMessageText(params: Record<string, unknown>): string | undefined {
  if (!Array.isArray(params.content)) return undefined;
  const text = params.content
    .flatMap((block) => {
      const record = asRecord(block);
      return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n\n")
    .trim();
  return text.length > 0 ? text : undefined;
}
