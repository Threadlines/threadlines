/**
 * Agent pages: self-contained HTML pages and Markdown documents an agent
 * shows inline in a thread with Threadlines' `show_page` tool
 * (docs/agent-pages.md).
 *
 * The server stores each version exactly as the agent wrote it. Whoever shows
 * one (the web frame, or the server's preview browser) wraps it with
 * `buildAgentPageDocument`, which puts the content policy, the theme and the
 * bridge script ahead of everything the page says. Because the wrapper is
 * applied when a page is shown, not when it is stored, a fix here reaches
 * pages published before it.
 *
 * Pages run in a sandboxed frame with an opaque origin. The bridge between a
 * page and its host speaks the MCP Apps messages (JSON-RPC over postMessage,
 * https://github.com/modelcontextprotocol/ext-apps), so the same host can one
 * day drive MCP apps as well.
 */
import type { AgentPagePublication, OrchestrationAgentPage } from "@threadlines/contracts";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

export const AGENT_PAGE_SHOW_TOOL_NAME = "show_page";
export const AGENT_PAGE_PREVIEW_TOOL_NAME = "preview_page";

export const AGENT_PAGE_MIN_HEIGHT = 80;
export const AGENT_PAGE_MAX_HEIGHT = 2000;
export const AGENT_PAGE_MAX_TITLE_LENGTH = 120;
/** A stored version, local images already inlined. */
export const AGENT_PAGE_MAX_BYTES = 16 * 1024 * 1024;
/** One local image before inlining. */
export const AGENT_PAGE_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export type AgentPageKind = "html" | "markdown";

/**
 * Frame widths the server measures a page at, from phones to a wide window.
 * Ascending.
 */
export const AGENT_PAGE_MEASURE_WIDTHS = [320, 375, 430, 520, 640, 760, 880, 1000, 1144] as const;

/**
 * The reply column's width at a normal window size. Agents preview at it, and
 * it picks the measured height when a client cannot know its width yet.
 */
export const AGENT_PAGE_COLUMN_WIDTH = 880;

/** `[width, contentHeight]` pairs measured at publish, ascending by width. */
export type AgentPageHeights = ReadonlyArray<readonly [width: number, height: number]>;

const MAX_MEASURED_HEIGHTS = 24;

export function clampAgentPageHeight(height: number): number {
  return Math.min(AGENT_PAGE_MAX_HEIGHT, Math.max(AGENT_PAGE_MIN_HEIGHT, Math.round(height)));
}

/** Measured heights from untrusted storage or the wire, or undefined when malformed. */
export function readAgentPageHeights(value: unknown): AgentPageHeights | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MEASURED_HEIGHTS) {
    return undefined;
  }
  const heights = value.flatMap((entry) =>
    Array.isArray(entry) &&
    entry.length === 2 &&
    Number.isInteger(entry[0]) &&
    entry[0] >= 1 &&
    entry[0] <= 10_000 &&
    typeof entry[1] === "number" &&
    Number.isFinite(entry[1])
      ? [[entry[0] as number, clampAgentPageHeight(entry[1])] as const]
      : [],
  );
  return heights.length === value.length
    ? heights.toSorted((left, right) => left[0] - right[0])
    : undefined;
}

// The taller of the heights measured at the nearest widths on each side: a
// breakpoint between two measured widths can make the page as tall as either.
function measuredHeightAt(heights: AgentPageHeights, width: number): number {
  const above = heights.findIndex(([measuredWidth]) => measuredWidth >= width);
  const high = above === -1 ? heights.length - 1 : above;
  const low = heights[high]![0] === width ? high : Math.max(0, high - 1);
  return Math.max(heights[low]![1], heights[high]![1]);
}

/**
 * The frame height for a page at a frame width: the page's own reported
 * height once it has one, else the server's measurement for that width.
 *
 * A page even a few pixels taller than its frame scrolls inside it and takes
 * the reader's wheel, so the frame fits the page. The agent's `height` caps
 * the frame only when it is below the page's height at the column width (the
 * agent asked for a scrolling frame) or when the page was never measured.
 */
export function agentPageFrameHeight(
  page: { readonly height: number; readonly heights?: AgentPageHeights | undefined },
  width: number,
  contentHeight?: number,
): number {
  const heights = page.heights;
  if (heights === undefined || heights.length === 0) {
    return clampAgentPageHeight(contentHeight ?? page.height);
  }
  const cap =
    measuredHeightAt(heights, AGENT_PAGE_COLUMN_WIDTH) > page.height
      ? page.height
      : AGENT_PAGE_MAX_HEIGHT;
  return clampAgentPageHeight(Math.min(cap, contentHeight ?? measuredHeightAt(heights, width)));
}

/** A readable download name: the title without characters file systems reject. */
export function agentPageFileName(title: string, kind: AgentPageKind): string {
  const name = title
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  return `${name || "Page"}.${kind === "markdown" ? "md" : "html"}`;
}

/**
 * Whether a turn is still part of its thread: the one running, the latest, or
 * one a message is still stamped with. A turn that was taken back is none of
 * these, so a page arriving late for it is refused. Steps and checkpoints are
 * left out on purpose: a step can still arrive for a turn already taken back,
 * and neither is loaded into the command read model after a restart.
 */
export function threadHasTurn(
  thread: {
    readonly session?: { readonly activeTurnId?: string | null | undefined } | null | undefined;
    readonly latestTurn?: { readonly turnId: string } | null | undefined;
    readonly messages: ReadonlyArray<{ readonly turnId?: string | null | undefined }>;
  },
  turnId: string,
): boolean {
  return (
    thread.session?.activeTurnId === turnId ||
    thread.latestTurn?.turnId === turnId ||
    thread.messages.some((message) => message.turnId === turnId)
  );
}

/** The longest link to an online copy a page may carry. */
export const AGENT_PAGE_MAX_SHARE_URL_LENGTH = 2048;

/**
 * A page's link to the copy its provider put online (a Claude artifact),
 * checked: https only. `host` is what the chat calls the place ("claude.ai").
 * Null: no link, or not one the chat will open.
 */
export function agentPageShareLink(
  shareUrl: string | undefined,
): { readonly url: string; readonly host: string } | null {
  if (shareUrl === undefined || shareUrl.length > AGENT_PAGE_MAX_SHARE_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(shareUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return null;
  return { url: parsed.href, host: parsed.hostname.replace(/^www\./, "") };
}

// ---------------------------------------------------------------------------
// What a page may load

/**
 * The only hosts a page may load from: public script and style CDNs and font
 * services, whose request logs nobody who writes a page can read. jsDelivr is
 * limited to its npm paths, since its GitHub paths fetch whatever a repository
 * holds. The server's preview browser reaches nothing else either.
 */
export const AGENT_PAGE_ALLOWED_HOSTS = [
  "cdnjs.cloudflare.com",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "esm.sh",
  "cdn.tailwindcss.com",
  "code.jquery.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "fonts.bunny.net",
] as const;

const SCRIPT_SOURCES = [
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net/npm/",
  "https://unpkg.com",
  "https://esm.sh",
  "https://cdn.tailwindcss.com",
  "https://code.jquery.com",
].join(" ");
const FONT_SOURCES = "https://fonts.gstatic.com https://fonts.bunny.net";
const STYLESHEET_FONT_SOURCES = "https://fonts.googleapis.com https://fonts.bunny.net";

/**
 * The content policy every page runs under. No remote images, media or
 * frames, and no requests beyond the CDNs, so a page cannot carry what it
 * shows to a server of its own. A page that needs a picture gets it inlined.
 */
export const AGENT_PAGE_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' blob: ${SCRIPT_SOURCES}`,
  `style-src 'unsafe-inline' ${SCRIPT_SOURCES} ${STYLESHEET_FONT_SOURCES}`,
  `font-src data: ${FONT_SOURCES} ${SCRIPT_SOURCES}`,
  "img-src data: blob:",
  "media-src data: blob:",
  `connect-src ${SCRIPT_SOURCES}`,
  "worker-src blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** The sandbox flags of every frame that shows a page, in the app and in previews. */
export const AGENT_PAGE_FRAME_SANDBOX = "allow-scripts allow-forms";

// ---------------------------------------------------------------------------
// Theme

export type AgentPageAppearance = "light" | "dark";

/** The resolved theme a host hands a page: CSS custom properties by name. */
export interface AgentPageTheme {
  readonly appearance: AgentPageAppearance;
  readonly variables: Readonly<Record<string, string>>;
}

/**
 * Page variable → the app token it takes its value from. The web reads each
 * token's live value and hands the page a hex color, since some chart
 * libraries reject newer color syntax such as oklch().
 */
export const AGENT_PAGE_THEME_TOKENS = {
  "--background": "--background",
  "--foreground": "--foreground",
  "--muted": "--muted",
  "--muted-foreground": "--muted-foreground",
  "--card": "--card",
  "--card-foreground": "--card-foreground",
  "--popover": "--popover",
  "--popover-foreground": "--popover-foreground",
  "--primary": "--primary",
  "--primary-foreground": "--primary-foreground",
  "--secondary": "--secondary",
  "--secondary-foreground": "--secondary-foreground",
  "--accent": "--accent",
  "--accent-foreground": "--accent-foreground",
  "--border": "--border",
  "--input": "--input",
  "--ring": "--ring",
  "--destructive": "--destructive",
  "--destructive-foreground": "--destructive-foreground",
  "--info": "--info",
  "--info-foreground": "--info-foreground",
  "--success": "--success",
  "--success-foreground": "--success-foreground",
  "--warning": "--warning",
  "--warning-foreground": "--warning-foreground",
  "--chart-1": "--usage-model-2",
  "--chart-2": "--usage-model-1",
  "--chart-3": "--usage-model-5",
  "--chart-4": "--usage-model-4",
  "--chart-5": "--usage-model-6",
  "--chart-6": "--usage-model-3",
} as const;

export interface AgentPageFonts {
  readonly sans: string;
  readonly mono: string;
}

/** The app's own faces are bundled with it; a page falls back to the system's. */
export const AGENT_PAGE_DEFAULT_FONTS: AgentPageFonts = {
  sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
};

/**
 * Faces the server's headless browser lays pages out with. Arial-metric
 * stand-ins for the system faces readers see, so measured heights wrap close
 * to how a client will.
 */
export const AGENT_PAGE_MEASURE_FONTS: AgentPageFonts = {
  sans: '"Liberation Sans", Arimo, Arial, Helvetica, sans-serif',
  mono: '"Liberation Mono", Cousine, Menlo, Consolas, monospace',
};

const SHARED_VARIABLES = { "--radius": "8px" } as const;

/** Hex approximations of the app's palettes, for hosts with no live tokens to read. */
export const AGENT_PAGE_FALLBACK_THEMES: Record<AgentPageAppearance, AgentPageTheme> = {
  dark: {
    appearance: "dark",
    variables: {
      "--background": "#1c1c1c",
      "--foreground": "#e8e8e8",
      "--muted": "#ffffff17",
      "--muted-foreground": "#989898",
      "--card": "#2c2c2c",
      "--card-foreground": "#e8e8e8",
      "--popover": "#313131",
      "--popover-foreground": "#e8e8e8",
      "--primary": "#00347d",
      "--primary-foreground": "#ffffff",
      "--secondary": "#ffffff14",
      "--secondary-foreground": "#e8e8e8",
      "--accent": "#ffffff17",
      "--accent-foreground": "#e8e8e8",
      "--border": "#ffffff24",
      "--input": "#ffffff21",
      "--ring": "#00347d",
      "--destructive": "#f04a50",
      "--destructive-foreground": "#ff6467",
      "--info": "#00347d",
      "--info-foreground": "#1447e6",
      "--success": "#00bc7d",
      "--success-foreground": "#00d492",
      "--warning": "#fe9a00",
      "--warning-foreground": "#ffb900",
      "--chart-1": "#3987e5",
      "--chart-2": "#d95926",
      "--chart-3": "#199e70",
      "--chart-4": "#c98500",
      "--chart-5": "#9085e9",
      "--chart-6": "#d55181",
      ...SHARED_VARIABLES,
    },
  },
  light: {
    appearance: "light",
    variables: {
      "--background": "#f8f8f8",
      "--foreground": "#2a2a2a",
      "--muted": "#0000000a",
      "--muted-foreground": "#636363",
      "--card": "#ffffff",
      "--card-foreground": "#2a2a2a",
      "--popover": "#ffffff",
      "--popover-foreground": "#2a2a2a",
      "--primary": "#00347d",
      "--primary-foreground": "#ffffff",
      "--secondary": "#0000000a",
      "--secondary-foreground": "#2a2a2a",
      "--accent": "#0000000a",
      "--accent-foreground": "#2a2a2a",
      "--border": "#00000014",
      "--input": "#0000001a",
      "--ring": "#00347d",
      "--destructive": "#fb2c36",
      "--destructive-foreground": "#c10007",
      "--info": "#00347d",
      "--info-foreground": "#1447e6",
      "--success": "#00bc7d",
      "--success-foreground": "#007a55",
      "--warning": "#fe9a00",
      "--warning-foreground": "#bb4d00",
      "--chart-1": "#2a78d6",
      "--chart-2": "#eb6834",
      "--chart-3": "#1baf7a",
      "--chart-4": "#eda100",
      "--chart-5": "#4a3aa7",
      "--chart-6": "#e87ba4",
      ...SHARED_VARIABLES,
    },
  },
};

/** A theme with the fonts filled in, as the page's `:root` sees it. */
export function agentPageTheme(
  theme: AgentPageTheme,
  fonts: AgentPageFonts = AGENT_PAGE_DEFAULT_FONTS,
): AgentPageTheme {
  return {
    appearance: theme.appearance,
    variables: {
      ...SHARED_VARIABLES,
      ...theme.variables,
      "--font-sans": fonts.sans,
      "--font-mono": fonts.mono,
    },
  };
}

// Variable names and values reach a `<style>` element, so nothing that could
// end the rule, the declaration, or the element gets through.
const VARIABLE_NAME = /^--[a-z0-9-]+$/;
const cleanVariableValue = (value: string) => value.replace(/[;{}<>\\]/g, "");

function themeRule(theme: AgentPageTheme): string {
  const declarations = Object.entries(theme.variables)
    .filter(([name]) => VARIABLE_NAME.test(name))
    .map(([name, value]) => `${name}:${cleanVariableValue(value)};`)
    .join("");
  return `:root{color-scheme:${theme.appearance === "light" ? "light" : "dark"};${declarations}}`;
}

// ---------------------------------------------------------------------------
// Agent-facing guidance (tool descriptions)

/** Which variables a page can style with, for the agent. */
export const AGENT_PAGE_THEME_GUIDE = [
  "Threadlines puts its theme on :root as CSS custom properties, and they follow the reader's light and dark mode live:",
  "--background (identical to the thread around the page), --foreground, --muted, --muted-foreground, --card, --card-foreground,",
  "--popover, --popover-foreground, --primary, --primary-foreground, --secondary, --secondary-foreground, --accent, --accent-foreground,",
  "--border, --input, --ring, --destructive, --destructive-foreground, --info, --info-foreground, --success, --success-foreground,",
  "--warning, --warning-foreground, --chart-1 … --chart-6 (categorical series for charts), --radius, --font-sans, --font-mono.",
  "Colors are hex values, so chart libraries can use them directly. A base stylesheet sets html background, color and font from them and body margin to 0; your CSS overrides it.",
].join(" ");

/** How a page should sit in a reply, for the agent. */
export const AGENT_PAGE_LAYOUT_GUIDE = [
  `The page sits borderless in the reply column, on the thread's own background: about ${AGENT_PAGE_COLUMN_WIDTH}px wide on desktop, about 360px on phones.`,
  "Leave html, body and the outermost element without a background color, border, card or banner title: the page is part of your reply. This overrides any general style preference such as a black page background.",
  "The title you give the page shows right above it, so do not repeat it as the page's first heading.",
  "Use a fluid width with no horizontal padding on the outermost element.",
  "The look is dense and flat: structure from type and spacing, quiet fills to group things, thin borders only where needed, no shadows except on things that float. Body text 13-14px, small headings, no hero sizes.",
  "If a box needs its own background (a mock of a specific screen, a panel that must stand apart), give it at least 16px of padding and var(--radius) corners.",
  "Give charts fixed pixel heights rather than heights that scale with width.",
  "Let content set the page's height. Never use 100vh or height:100% on html or body: the frame grows to fit the page, and viewport heights make it grow again and again.",
].join(" ");

/** What a page can and cannot load, for the agent. */
export const AGENT_PAGE_NETWORK_GUIDE = [
  "Write one self-contained page with inline <style> and <script>.",
  "Scripts, stylesheets and fonts load only from cdnjs.cloudflare.com, cdn.jsdelivr.net/npm/, unpkg.com, esm.sh, cdn.tailwindcss.com, code.jquery.com, fonts.googleapis.com, fonts.gstatic.com and fonts.bunny.net; everything else, including fetch() to other hosts, remote images, iframes and forms, is blocked and fails silently.",
  'Put data inline. For a picture, save the image file in this thread\'s page assets folder (named in your Threadlines instructions, and in the error when an image is anywhere else) and reference it by its absolute path (src="/abs/path.png", CSS url(/abs/path.png), Markdown ![](/abs/path.png) or a JS string); Threadlines inlines it when the page is published.',
].join(" ");

// ---------------------------------------------------------------------------
// Bridge messages (MCP Apps names)

const SIZE_CHANGED_METHOD = "ui/notifications/size-changed";
const OPEN_LINK_METHOD = "ui/open-link";
const HOST_CONTEXT_CHANGED_METHOD = "ui/notifications/host-context-changed";
// Threadlines' own: the page's document is going away (it navigated itself).
const PAGE_LEFT_METHOD = "threadlines/page-left";

/** The content height in a framed page's `size-changed` notification. */
export function readAgentPageContentHeight(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== SIZE_CHANGED_METHOD) return undefined;
  const height =
    typeof params === "object" && params !== null
      ? (params as { height?: unknown }).height
      : undefined;
  return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : undefined;
}

/** A page's `ui/open-link` request, if `data` is one with an http(s) URL. */
export function readAgentPageLinkRequest(
  data: unknown,
): { readonly id: string | number; readonly url: string } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, id, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== OPEN_LINK_METHOD) return undefined;
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  const url =
    typeof params === "object" && params !== null ? (params as { url?: unknown }).url : undefined;
  return typeof url === "string" && /^https?:\/\//i.test(url) ? { id, url } : undefined;
}

/** Whether `data` says the page's document is going away. */
export function isAgentPageLeftMessage(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const { jsonrpc, method } = data as Record<string, unknown>;
  return jsonrpc === "2.0" && method === PAGE_LEFT_METHOD;
}

/** The empty result a host sends back for a page's request. */
export function agentPageResult(id: string | number) {
  return { jsonrpc: "2.0", id, result: {} } as const;
}

/** The notification a host posts into a mounted page when the theme changes. */
export function agentPageThemeMessage(theme: AgentPageTheme) {
  return {
    jsonrpc: "2.0",
    method: HOST_CONTEXT_CHANGED_METHOD,
    params: { theme: theme.appearance, styles: { variables: theme.variables } },
  } as const;
}

// ---------------------------------------------------------------------------
// The wrapper

// A scrollbar inside the reply reads as a box within the thread, so a page
// taller than its frame scrolls without one. Focus rings paint inward so the
// frame's edge never clips them.
// The page paints `--tl-surface`, the host's exact background color, when the
// host gives one: a hex copy can round a shade off the thread around it, and
// the page then reads as a box.
const BASE_CSS =
  "html{background:var(--tl-surface,var(--background));color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}" +
  "html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}" +
  ":focus-visible{outline:2px solid var(--ring);outline-offset:-2px}";

// Markdown documents: the chat's own reading styles, dense and flat.
const DOCUMENT_CSS =
  ".tl-document{max-width:72ch;font-size:14px;line-height:1.6;overflow-wrap:anywhere}" +
  ".tl-document>:first-child{margin-top:0}.tl-document>:last-child{margin-bottom:0}" +
  ".tl-document h1{font-size:18px;line-height:1.3;font-weight:600;margin:0 0 10px}" +
  ".tl-document h2{font-size:15.5px;line-height:1.35;font-weight:600;margin:20px 0 6px}" +
  ".tl-document h3,.tl-document h4,.tl-document h5,.tl-document h6{font-size:14px;line-height:1.4;font-weight:600;margin:16px 0 4px}" +
  ".tl-document p,.tl-document ul,.tl-document ol,.tl-document blockquote,.tl-document pre,.tl-document table{margin:0 0 12px}" +
  ".tl-document ul,.tl-document ol{padding-left:22px}.tl-document li+li{margin-top:2px}" +
  // A task list item is its checkbox: no bullet beside it.
  ".tl-document li:has(>input[type=checkbox]){list-style:none;margin-left:-22px}" +
  ".tl-document a{color:var(--info-foreground);text-underline-offset:3px}" +
  ".tl-document blockquote{padding-left:12px;border-left:2px solid var(--border);color:var(--muted-foreground)}" +
  ".tl-document code{font-size:0.92em;padding:1px 4px;border-radius:4px;background:var(--muted)}" +
  ".tl-document pre{padding:10px 12px;border-radius:var(--radius);background:var(--muted);overflow-x:auto;font-size:12.5px;line-height:1.5}" +
  ".tl-document pre code{padding:0;background:none;font-size:inherit}" +
  ".tl-document table{border-collapse:collapse;display:block;overflow-x:auto}" +
  ".tl-document th,.tl-document td{padding:6px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}" +
  ".tl-document th{font-weight:600}.tl-document hr{border:0;border-top:1px solid var(--border);margin:20px 0}" +
  ".tl-document img{max-width:100%}.tl-document input[type=checkbox]{margin:0 6px 0 0}";

// Runs first, before anything the page says. It removes WebRTC, which no
// content policy governs; rewrites its own theme <style> when the host's theme
// changes (so a page's later `:root` rules still win); sends links the reader
// clicks to the host instead of navigating the frame; reports the page's
// height so the host can fit the frame to it; and tells the host when the
// document goes away, which for a page only happens when it navigates itself,
// even before it has finished loading.
const BOOTSTRAP_SCRIPT = `(function(){var w=window,d=document,p=w.parent,n=0;["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCSessionDescription","RTCIceCandidate"].forEach(function(k){try{Object.defineProperty(w,k,{value:void 0,writable:false,configurable:false});}catch(e){}});var s=d.getElementById("tl-page-theme"),b=${JSON.stringify(BASE_CSS)};function a(t){if(!s||!t||typeof t!=="object"||!t.variables||typeof t.variables!=="object")return;var c=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";for(var k in t.variables){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(t.variables[k]).replace(/[;{}<>\\\\]/g,"")+";";}s.textContent=c+"}"+b;}w.addEventListener("message",function(e){if(e.source!==p)return;var m=e.data,q=m&&m.params;if(m&&m.jsonrpc==="2.0"&&m.method===${JSON.stringify(HOST_CONTEXT_CHANGED_METHOD)}&&q&&q.styles)a({appearance:q.theme,variables:q.styles.variables});});d.addEventListener("click",function(e){if(!e.isTrusted||e.defaultPrevented)return;var l=e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}),h,u;if(!l)return;h=l.getAttribute("href")||"";if(h.charAt(0)==="#")return;e.preventDefault();try{u=new URL(h,d.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol))return;p.postMessage({jsonrpc:"2.0",id:"tl-link-"+(++n),method:${JSON.stringify(OPEN_LINK_METHOD)},params:{url:u.href}},"*");});var z,o,r=function(){var e=d.documentElement,v=Math.ceil(e.scrollHeight>e.clientHeight?e.scrollHeight:e.getBoundingClientRect().height);if(v===z)return;z=v;p.postMessage({jsonrpc:"2.0",method:${JSON.stringify(SIZE_CHANGED_METHOD)},params:{height:v}},"*");};if(w.ResizeObserver){o=new ResizeObserver(r);o.observe(d.documentElement);}d.addEventListener("DOMContentLoaded",function(){if(o&&d.body)o.observe(d.body);r();});w.addEventListener("load",r);w.addEventListener("pagehide",function(){p.postMessage({jsonrpc:"2.0",method:${JSON.stringify(PAGE_LEFT_METHOD)}},"*");});})();`;

/** The page's own markup for a Markdown document: GitHub-flavored, raw HTML escaped. */
export function renderAgentPageMarkdown(markdown: string): string {
  const body = micromark(markdown, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
  return `<style>${DOCUMENT_CSS}</style><article class="tl-document">${body}</article>`;
}

// A doctype (with anything a parser skips before it) must stay first, or the
// page drops into quirks mode; everything else goes after the wrapper.
const LEADING_DOCTYPE = /^﻿?(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i;

/**
 * The whole document a host puts into a page's frame: the content policy,
 * the theme and the bootstrap script first, then the page exactly as stored.
 *
 * Nothing the page says can come before the wrapper, so no page script runs
 * outside the policy. A page's own `<html>` and `<head>` tags after it are
 * merged by the parser as usual; a second content policy of its own can only
 * narrow this one.
 */
export function buildAgentPageDocument(input: {
  readonly content: string;
  readonly kind: AgentPageKind;
  readonly theme: AgentPageTheme;
}): string {
  const wrapper =
    `<meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${AGENT_PAGE_CONTENT_SECURITY_POLICY}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<style id="tl-page-theme">${themeRule(input.theme)}${BASE_CSS}</style>` +
    `<script>${BOOTSTRAP_SCRIPT}</script>`;
  if (input.kind === "markdown") {
    return `<!doctype html><html><head>${wrapper}</head><body>${renderAgentPageMarkdown(input.content)}</body></html>`;
  }
  const doctype = LEADING_DOCTYPE.exec(input.content);
  return doctype
    ? `${doctype[0]}${wrapper}${input.content.slice(doctype[0].length)}`
    : `<!doctype html>${wrapper}${input.content}`;
}

// ---------------------------------------------------------------------------
// A thread's pages (the server's read model, its SQL projection and the web
// store all apply publications through this)

/** Pages a thread keeps, oldest dropped first. */
export const MAX_THREAD_AGENT_PAGES = 200;

/**
 * Whether a publication is older than what the thread already shows for its
 * page. Versions count up per page across the thread, so a slow publish that
 * lands after a newer one never replaces it.
 */
export function isStaleAgentPagePublication(
  pages: ReadonlyArray<Pick<OrchestrationAgentPage, "pageId" | "version">>,
  publication: Pick<AgentPagePublication, "pageId" | "version">,
): boolean {
  return pages.some(
    (page) => page.pageId === publication.pageId && page.version >= publication.version,
  );
}

/**
 * A thread's pages after one publication. Publishing a page again in the turn
 * that showed it replaces it where it stands; a page first shown in an earlier
 * turn gets an entry of its own in this turn. Stale publications change nothing.
 */
export function applyAgentPagePublication(
  pages: ReadonlyArray<OrchestrationAgentPage>,
  publication: AgentPagePublication,
  event: { readonly sequence: number; readonly occurredAt: string },
): ReadonlyArray<OrchestrationAgentPage> {
  if (isStaleAgentPagePublication(pages, publication)) return pages;
  const existing = pages.find(
    (page) => page.pageId === publication.pageId && page.turnId === publication.turnId,
  );
  const next: OrchestrationAgentPage = {
    ...publication,
    placementSequence: existing?.placementSequence ?? event.sequence,
    eventSequence: event.sequence,
    createdAt: existing?.createdAt ?? event.occurredAt,
    updatedAt: event.occurredAt,
  };
  return [...pages.filter((page) => page !== existing), next]
    .toSorted(compareAgentPagePlacement)
    .slice(-MAX_THREAD_AGENT_PAGES);
}

/** Where a page stands in its thread: where it was first shown in its turn. */
export function compareAgentPagePlacement(
  left: Pick<OrchestrationAgentPage, "placementSequence" | "createdAt" | "versionId">,
  right: Pick<OrchestrationAgentPage, "placementSequence" | "createdAt" | "versionId">,
): number {
  return (
    (left.placementSequence ?? -1) - (right.placementSequence ?? -1) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.versionId.localeCompare(right.versionId)
  );
}
