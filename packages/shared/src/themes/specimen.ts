/**
 * The theme specimen (docs/design/custom-themes.md, "Agent tools"): a small
 * self-contained mock of the app wearing a theme, rendered by `preview_theme`
 * in the preview browser so an agent can see its theme. Visual feedback for
 * the agent, not a safety check.
 *
 * With live art the backdrop frame (themes/backdropFrame.ts) runs behind the
 * mock: the specimen posts it the theme, the layout's zones (from the mock's
 * own element boxes) and steady running conditions, and the frame paints
 * frost and tint. The frame owns the tint; the specimen never computes one.
 * What the frame reports back lands on the root element as data attributes
 * (THEME_SPECIMEN_ATTRIBUTES), where the preview browser reads it: the art
 * can't write there, since it never reaches this document.
 */
import type { ThemeFont, ThemeManifest } from "@threadlines/contracts";

import { BACKDROP_FRAME_SANDBOX, buildBackdropFrameDocument } from "./backdropFrame.ts";
import { color } from "./color.ts";
import { glassTextColors } from "./contrast.ts";
import { resolveThemeTokens, type ThemeTokens, themeTokensCss } from "./tokens.ts";

export type ThemeSpecimenLayout = "thread" | "new-thread";

/** How the specimen shows a theme's art: running, its captured still, or not at all. */
export type ThemeSpecimenArt = "live" | "still" | "none";

/** Root-element attributes the specimen sets from the backdrop frame's messages. */
export const THEME_SPECIMEN_ATTRIBUTES = {
  /** `ready` once the frame said so. */
  art: "data-tl-art",
  /** The frame's last heartbeat frame number. */
  frame: "data-tl-frame",
  /** The frame's last `stats` message, as JSON. */
  stats: "data-tl-stats",
  /** The frame's `failure` message, as JSON. */
  failure: "data-tl-failure",
} as const;

const STILL_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;
const BASE64 = /^[A-Za-z0-9+/]+=*$/;
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "cursive",
]);
const SANS_FALLBACK = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
const MONO_FALLBACK = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

/** JSON safe inside a `<script>` element. */
const scriptJson = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028|\u2029/g, " ");

/** A font family list from a manifest, quoted and stripped to safe characters. */
const familyList = (family: string) =>
  family
    .split(",")
    .map((name) => name.replace(/["'\\]/g, "").trim())
    .filter((name) => /^[\w .-]+$/.test(name))
    .map((name) => (GENERIC_FAMILIES.has(name) ? name : `"${name}"`))
    .join(", ");

/** The `@font-face` rule (embedded fonts only) and the stack for one font slot. */
const fontFor = (font: ThemeFont | undefined, slot: "ui" | "mono", fallback: string) => {
  if (font === undefined) return { face: "", stack: fallback };
  const embedded = font.data !== undefined && BASE64.test(font.data);
  const face = embedded
    ? `@font-face{font-family:"tl-theme-${slot}";src:url(data:font/woff2;base64,${font.data}) format("woff2");font-weight:${font.weight ?? 400};}`
    : "";
  const named = familyList(font.family);
  const stack = [embedded ? `"tl-theme-${slot}"` : "", named, fallback]
    .filter((part) => part.length > 0)
    .join(", ");
  return { face, stack };
};

/** `#rrggbb` as `rgba()` at `alpha`. */
const rgba = (hex: string, alpha: number) => {
  const value = color(hex);
  const channel = (part: number) => Math.round(part * 255);
  return `rgba(${channel(value.r)}, ${channel(value.g)}, ${channel(value.b)}, ${alpha})`;
};

/** Code colors when a theme names none: close to the base's built-in highlighting. */
const CODE_FALLBACK = {
  dark: {
    comment: "#8b949e",
    keyword: "#ff7b72",
    string: "#a5d6ff",
    number: "#79c0ff",
    function: "#d2a8ff",
  },
  light: {
    comment: "#6e7781",
    keyword: "#cf222e",
    string: "#0a3069",
    number: "#0550ae",
    function: "#8250df",
  },
} as const;

const css = (input: {
  readonly manifest: ThemeManifest;
  readonly tokens: ThemeTokens;
  readonly art: ThemeSpecimenArt;
}) => {
  const { manifest, tokens, art } = input;
  const ui = fontFor(manifest.fonts?.ui, "ui", SANS_FALLBACK);
  const mono = fontFor(manifest.fonts?.mono, "mono", MONO_FALLBACK);
  const code = { ...CODE_FALLBACK[manifest.base], ...manifest.code };
  const glass = manifest.glass;
  const solid = tokens["surface-solid"];
  // Live: the frame paints every tint, so glass surfaces are clear. Still:
  // the theme's own floors over the still. No art: the theme's surfaces.
  const surface = (token: keyof ThemeTokens, tint: number | undefined) =>
    art === "live" ? "transparent" : art === "still" ? rgba(solid, tint ?? 1) : tokens[token];
  const still = manifest.backdrop?.still;
  const stillLayer =
    art === "still" && still !== undefined && STILL_DATA_URL.test(still)
      ? `background-image:url(${still});background-size:cover;background-position:center;`
      : "";
  return `${ui.face}${mono.face}
:root{${themeTokensCss(tokens)} --font-sans:${ui.stack}; --font-mono:${mono.stack};
--code-fg:${manifest.code?.foreground ?? tokens.foreground}; --code-comment:${code.comment}; --code-keyword:${code.keyword}; --code-string:${code.string}; --code-number:${code.number}; --code-function:${code.function};
--s-frame:${surface("frame", glass?.frame)}; --s-rail:${surface("rail", glass?.frame)}; --s-list:${surface("sidebar", glass?.list)}; --s-main:${surface("background", glass?.column)}; --s-composer:${surface("card", glass?.composer)};}
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden}
body{background:${solid};${stillLayer}color:var(--foreground);font:13.5px/1.5 var(--font-sans);-webkit-font-smoothing:antialiased}
#art{position:fixed;inset:0;width:100%;height:100%;border:0;z-index:0;pointer-events:none}
.app{position:relative;z-index:1;display:grid;grid-template:38px 1fr/52px 272px 1fr;height:100vh}
.title{grid-column:1/-1;display:flex;align-items:center;gap:8px;padding:0 14px;background:var(--s-frame);color:var(--muted-foreground);font-size:12.5px}
.dot{width:12px;height:12px;border-radius:50%;background:var(--switch-off)}
.title .name{margin:0 auto}
.rail{background:var(--s-rail);display:flex;flex-direction:column;align-items:center;gap:14px;padding-top:12px;color:var(--muted-foreground);font-size:16px}
.rail .on{color:var(--foreground)}
.list{background:var(--s-list);color:var(--sidebar-foreground);padding:10px 8px;border-right:1px solid var(--sidebar-border)}
.list h4{margin:4px 8px 8px;font-size:12px;font-weight:600;color:var(--muted-foreground)}
.row{display:flex;align-items:center;gap:8px;height:30px;padding:0 8px;border-radius:7px;white-space:nowrap;overflow:hidden}
.row.sel{background:var(--sidebar-accent);color:var(--sidebar-accent-foreground)}
.row .t{flex:1;overflow:hidden;text-overflow:ellipsis}
.row .m{color:var(--muted-foreground);font-size:12px}
.pulse{width:7px;height:7px;border-radius:50%;background:var(--primary)}
.main{background:var(--s-main);display:flex;flex-direction:column;min-width:0}
.head{height:44px;display:flex;align-items:center;justify-content:space-between;padding:0 20px;font-weight:600}
.head .m{font-weight:400;color:var(--muted-foreground);font:12px var(--font-mono)}
.scroll{flex:1;overflow:hidden;display:flex;justify-content:center}
.column{width:min(720px,100% - 48px);height:100%;display:flex;flex-direction:column;gap:14px;padding:18px 0 20px}
.reply{flex:1}
.user{align-self:flex-end;max-width:80%;background:var(--secondary);color:var(--secondary-foreground);padding:8px 12px;border-radius:14px}
.reply h3{margin:0 0 6px;font-size:15px}
.reply p{margin:0 0 8px}
.reply ul{margin:0 0 10px;padding-left:20px}
pre{margin:0 0 10px;padding:12px 14px;border-radius:10px;background:var(--code-background);color:var(--code-fg);font:12.5px/1.55 var(--font-mono);overflow:hidden}
.c{color:var(--code-comment)} .k{color:var(--code-keyword)} .s{color:var(--code-string)} .n{color:var(--code-number)} .f{color:var(--code-function)}
.warn{color:var(--warning-foreground)}
.meta{color:var(--muted-foreground);font:12px var(--font-mono)}
a{color:var(--primary-readable);text-decoration:none}
.composer{background:var(--s-composer);color:var(--card-foreground);border:1px solid var(--border);border-radius:16px;padding:12px 12px 10px;width:100%}
.composer .ph{color:var(--placeholder);min-height:40px}
.chips{display:flex;align-items:center;gap:14px;color:var(--muted-foreground);font-size:12.5px}
.send{margin-left:auto;width:28px;height:28px;border-radius:50%;background:var(--primary);color:var(--primary-foreground);display:grid;place-items:center;font-weight:700}
.fresh{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding-bottom:60px}
.fresh .stack{width:min(720px,100% - 48px);display:flex;flex-direction:column;align-items:center;gap:12px}
.fresh h1{margin:0 0 6px;font-size:22px;font-weight:600}
.fresh .under{color:var(--muted-foreground)}
.fresh .links{display:flex;gap:18px;color:var(--muted-foreground);font-size:12.5px}`;
};

const THREADS = [
  ["A theme for long days", "now"],
  ["Fix the flaky upload test", "working"],
  ["Release notes for 0.9", "2h"],
  ["Refactor settings search", "1d"],
  ["Phone alerts copy", "3d"],
] as const;

const composer = (placeholder: string) => `<div class="composer" data-zone="composer">
<div class="ph">${placeholder}</div>
<div class="chips"><span>✳ Claude</span><span>◔ High</span><span>⛨ Full access</span><span class="send">↑</span></div></div>`;

const frameMarkup = (
  title: string,
) => `<header class="title" data-zone="frame"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="name">${title}</span></header>
<nav class="rail" data-zone="frame"><span class="on">◧</span><span>⌕</span><span>◷</span><span>⚙</span></nav>
<aside class="list" data-zone="list"><h4>Threads</h4>${THREADS.map(
  ([name, meta], index) =>
    `<div class="row${index === 0 ? " sel" : ""}">${meta === "working" ? '<span class="pulse"></span>' : ""}<span class="t">${escapeHtml(name)}</span><span class="m">${meta === "working" ? "Working" : meta}</span></div>`,
).join("")}</aside>`;

const threadMarkup = (name: string) => `<main class="main">
<div class="head" data-zone="frame"><span>A theme for long days</span><span class="m">main</span></div>
<div class="scroll"><div class="column" data-zone="column">
<div class="user">Make me a theme I'd like to look at all day.</div>
<div class="reply"><h3>${name}</h3>
<p>Colors, fonts and art for the whole app. Text sits on glass in front of the art, so it stays easy to read.</p>
<ul><li>The accent marks what's selected, on, and the send button.</li><li>Code blocks use the theme's own syntax colors.</li><li>The art moves a little faster while an agent works.</li></ul>
<pre><span class="c">// Snow drifts one cell down per frame</span>
<span class="k">export function</span> <span class="f">draw</span>(grid, { t, state }) {
  <span class="k">const</span> speed = state.working &gt; <span class="n">0</span> ? <span class="n">2</span> : <span class="n">1</span>;
  <span class="k">return</span> <span class="f">paint</span>(grid, <span class="s">"snow"</span>, <span class="n">0.42</span> * speed);
}</pre>
<div class="warn">⚠ The art goes still on battery when it gets heavy.</div>
<div class="meta">Worked for 2m 14s · 3 files changed</div></div>
${composer("Ask for a change…")}
</div></div></main>`;

const newThreadMarkup =
  () => `<main class="main"><div class="fresh"><div class="stack" data-zone="patch">
<h1>What's next?</h1>
${composer("Describe a task or ask a question")}
<div class="under">Working in ~/projects/aurora on main</div>
<div class="links"><a>Settings</a><span>Shortcuts</span><span>What's new</span></div>
</div></div></main>`;

/**
 * The host side of the backdrop bridge, as the app runs it: makes the frame,
 * and once it is ready posts the theme, the viewport, steady conditions, one
 * agent working, and the zones measured from `[data-zone]` elements.
 */
const hostScript = (input: {
  readonly init: unknown;
  readonly tints: Readonly<Record<string, number>>;
  readonly tintColor: string;
}) => `(() => {
  const ATTR = ${scriptJson(THEME_SPECIMEN_ATTRIBUTES)};
  const init = ${scriptJson(input.init)};
  const tints = ${scriptJson(input.tints)};
  const root = document.documentElement;
  const frame = document.createElement("iframe");
  frame.id = "art";
  frame.setAttribute("sandbox", ${scriptJson(BACKDROP_FRAME_SANDBOX)});
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("tabindex", "-1");
  frame.inert = true;
  const post = (message) => frame.contentWindow && frame.contentWindow.postMessage(message, "*");
  const box = (rect, pad) => ({ x: rect.x - pad, y: rect.y - pad, w: rect.width + 2 * pad, h: rect.height + 2 * pad });
  const zones = () => Array.from(document.querySelectorAll("[data-zone]")).map((element, index) => {
    const kind = element.getAttribute("data-zone");
    const rect = element.getBoundingClientRect();
    const soft = kind === "column" || kind === "patch";
    const core = box(rect, 0);
    return { id: kind + "-" + index, edge: soft ? "soft" : "hard", shape: kind === "patch" ? "ellipse" : "rect",
      rect: soft ? box(rect, kind === "patch" ? 96 : 32) : core, core, tint: tints[kind] ?? 1, tintColor: ${scriptJson(input.tintColor)} };
  });
  const send = () => {
    post({ type: "viewport", width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1 });
    post({ type: "zones", zones: zones() });
  };
  addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    const data = event.data;
    if (data === null || typeof data !== "object") return;
    if (data.type === "ready") {
      root.setAttribute(ATTR.art, "ready");
      post(init);
      post({ type: "conditions", conditions: { motion: "live", visible: true, busy: false, idle: false, focused: true, power: "ac", thermal: "nominal", slowdown: 0 } });
      post({ type: "activity", activity: ${scriptJson({ working: 1, waiting: 0 })} });
      document.fonts.ready.then(send);
    } else if (data.type === "heartbeat") root.setAttribute(ATTR.frame, String(data.frame));
    else if (data.type === "stats") root.setAttribute(ATTR.stats, JSON.stringify(data));
    else if (data.type === "failure") root.setAttribute(ATTR.failure, JSON.stringify(data));
  });
  addEventListener("resize", send);
  frame.srcdoc = ${scriptJson(buildBackdropFrameDocument())};
  document.body.prepend(frame);
})();`;

const page = (input: {
  readonly manifest: ThemeManifest;
  readonly art: ThemeSpecimenArt;
  readonly body: string;
  /** Overrides the zones' tint floors (the art document wants none). */
  readonly tints?: Readonly<Record<string, number>>;
}) => {
  const { manifest } = input;
  const tokens = resolveThemeTokens(manifest);
  const backdrop = manifest.backdrop;
  const art = backdrop === undefined ? "none" : input.art;
  const glass = manifest.glass;
  const texts = glassTextColors(tokens);
  const script =
    art === "live" && backdrop !== undefined
      ? `<script>${hostScript({
          init: {
            type: "init",
            mode: backdrop.mode,
            script: backdrop.script,
            maxFps: backdrop.maxFps,
            base: manifest.base,
            palette: { ...tokens },
            textColors: texts.map((text) => text.color),
            textRatios: texts.map((text) => text.ratio),
            blur: glass?.blur ?? 16,
          },
          tints: input.tints ?? {
            frame: glass?.frame ?? 1,
            list: glass?.list ?? 1,
            column: glass?.column ?? 1,
            patch: glass?.column ?? 1,
            composer: glass?.composer ?? 1,
          },
          tintColor: tokens["surface-solid"],
        })}</script>`
      : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(manifest.name)}</title><style>${css({ manifest, tokens, art })}</style></head><body>${input.body}${script}</body></html>`;
};

/** The specimen in one layout, for a viewport of `width` × `height` CSS px. */
export function buildThemeSpecimenDocument(input: {
  readonly manifest: ThemeManifest;
  readonly layout: ThemeSpecimenLayout;
  readonly width: number;
  readonly height: number;
  /** Default `live` when the theme has art. */
  readonly art?: ThemeSpecimenArt;
}): string {
  const name = escapeHtml(input.manifest.name);
  return page({
    manifest: input.manifest,
    art: input.art ?? "live",
    body: `<div class="app" style="min-width:${Math.round(input.width)}px">${frameMarkup(name)}${
      input.layout === "thread" ? threadMarkup(name) : newThreadMarkup()
    }</div>`,
  });
}

/** The theme's art alone, live, with nothing frosted: what a still is captured from. */
export function buildThemeArtDocument(input: { readonly manifest: ThemeManifest }): string {
  return page({ manifest: input.manifest, art: "live", body: "", tints: {} });
}
