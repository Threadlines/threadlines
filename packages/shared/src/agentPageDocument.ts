/**
 * The document an agent page is shown in: the content policy, the theme and
 * the bridge script, then the page as the agent wrote it (Markdown rendered
 * first). See agentPages.ts for the page model and the bridge messages.
 *
 * Kept apart from agentPages.ts, which the web app's store loads at startup:
 * the Markdown renderer here is only needed once a page is on screen.
 */
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

import {
  AGENT_PAGE_COLUMN_WIDTH,
  AGENT_PAGE_CONTENT_SECURITY_POLICY,
  type AgentPageKind,
  type AgentPageTheme,
  agentPageThemeRule,
  HOST_CONTEXT_CHANGED_METHOD,
  MAX_OPEN_IMAGES,
  OPEN_IMAGE_METHOD,
  OPEN_LINK_METHOD,
  PAGE_LEFT_METHOD,
  SCROLL_EDGES_METHOD,
  SIZE_CHANGED_METHOD,
} from "./agentPages.ts";
import { scriptLiteral, wrapHtmlDocument } from "./framedDocument.ts";

// A scrollbar inside the reply reads as a box within the thread, so a page
// taller than its frame scrolls without one. Focus rings paint inward so the
// frame's edge never clips them.
// The page paints `--tl-surface`, the host's exact paint around it (a color,
// or a translucent fill laid over one), when the host gives one: a hex copy
// can round a shade off the surface around it, and the page then reads as a
// box. A picture the reader can open bigger shows a zoom cursor.
const BASE_CSS =
  "html{background:var(--tl-surface,var(--background));color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}" +
  "html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}" +
  ":focus-visible{outline:2px solid var(--ring);outline-offset:-2px}[data-tl-zoom]{cursor:zoom-in!important}";

// Markdown documents: the chat's own reading styles, dense and flat. A
// document fills its panel in the chat, as the reply around it does; a wider
// frame (full size) keeps it at the chat's width, centered.
const DOCUMENT_CSS =
  `.tl-document{max-width:${AGENT_PAGE_COLUMN_WIDTH}px;margin-inline:auto;font-size:14px;line-height:1.6;overflow-wrap:anywhere}` +
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
// clicks to the host instead of navigating the frame; offers the page's inline
// pictures to the host's image viewer once the click has run through the
// page's own handlers (one the page made clickable itself, by a link, a
// control, its own pointer cursor or a handled click, stays the page's), at
// most the viewer's limit around the one clicked; reports the page's
// height so the host can fit the frame to it (watching the body's own
// children too, which can outgrow a body held at the frame's height), and
// whether the page had
// finished loading (before that, pictures still coming in can leave it
// shorter than it ends up), the first loaded report waiting for the page's
// own load handlers to lay it out; reports whether the page has more to
// scroll to above or below its frame, once as it starts and on every change,
// so the host can show it; and tells the host when the document goes away,
// which for a page only happens when it navigates itself, even before it has
// finished loading.
const BOOTSTRAP_SCRIPT = `(function(){var w=window,d=document,p=w.parent,n=0;["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCSessionDescription","RTCIceCandidate"].forEach(function(k){try{Object.defineProperty(w,k,{value:void 0,writable:false,configurable:false});}catch(e){}});var s=d.getElementById("tl-page-theme"),b=${scriptLiteral(BASE_CSS)};function a(t){if(!s||!t||typeof t!=="object"||!t.variables||typeof t.variables!=="object")return;var c=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";for(var k in t.variables){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(t.variables[k]).replace(/[;{}<>\\\\]/g,"")+";";}s.textContent=c+"}"+b;}w.addEventListener("message",function(e){if(e.source!==p)return;var m=e.data,q=m&&m.params;if(m&&m.jsonrpc==="2.0"&&m.method===${scriptLiteral(HOST_CONTEXT_CHANGED_METHOD)}&&q&&q.styles)a({appearance:q.theme,variables:q.styles.variables});});function g(t){var r,c;if(!t||t.tagName!=="IMG"||!t.complete||!t.naturalWidth||!/^data:image\\//i.test(t.currentSrc||t.src)||t.closest("a[href],button,label,summary,[role=button],[onclick]"))return false;r=t.getBoundingClientRect();if(r.width<48||r.height<48)return false;if(t.hasAttribute("data-tl-zoom"))return true;c=w.getComputedStyle(t).cursor;return c==="auto"||c==="default";}d.addEventListener("pointerover",function(e){if(g(e.target))e.target.setAttribute("data-tl-zoom","");});d.addEventListener("click",function(e){if(!e.isTrusted||e.defaultPrevented)return;var l=e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}),h,u,m,i;if(!l){if(!g(e.target))return;w.setTimeout(function(){var t=e.target,k;if(e.defaultPrevented||!g(t))return;m=[].filter.call(d.images,g);i=m.indexOf(t);if(i<0)return;k=Math.max(0,Math.min(i-${MAX_OPEN_IMAGES / 2},m.length-${MAX_OPEN_IMAGES}));m=m.slice(k,k+${MAX_OPEN_IMAGES});p.postMessage({jsonrpc:"2.0",method:${scriptLiteral(OPEN_IMAGE_METHOD)},params:{images:m.map(function(x){return{src:x.currentSrc||x.src,alt:x.alt||x.title||""};}),index:i-k}},"*");},0);return;}h=l.getAttribute("href")||"";if(h.charAt(0)==="#")return;e.preventDefault();try{u=new URL(h,d.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol))return;p.postMessage({jsonrpc:"2.0",id:"tl-link-"+(++n),method:${scriptLiteral(OPEN_LINK_METHOD)},params:{url:u.href}},"*");});var z,y,o,ea,eb,f=function(){var e=d.documentElement,t=w.scrollY,i=t>1,j=t+e.clientHeight<e.scrollHeight-1;if(i===ea&&j===eb)return;ea=i;eb=j;p.postMessage({jsonrpc:"2.0",method:${scriptLiteral(SCROLL_EDGES_METHOD)},params:{above:i,below:j}},"*");},r=function(){var e=d.documentElement,v=Math.ceil(e.scrollHeight>e.clientHeight?e.scrollHeight:e.getBoundingClientRect().height),l=d.readyState==="complete";f();if(v===z&&l===y)return;z=v;y=l;p.postMessage({jsonrpc:"2.0",method:${scriptLiteral(SIZE_CHANGED_METHOD)},params:{height:v,loaded:l}},"*");};if(w.ResizeObserver){o=new ResizeObserver(r);o.observe(d.documentElement);}d.addEventListener("DOMContentLoaded",function(){var c=function(e){if(e.nodeType===1)o.observe(e);};if(o&&d.body){o.observe(d.body);[].forEach.call(d.body.children,c);if(w.MutationObserver)new MutationObserver(function(m){m.forEach(function(x){[].forEach.call(x.addedNodes,c);});}).observe(d.body,{childList:true});}r();});w.addEventListener("load",function(){w.setTimeout(r,0);});w.addEventListener("scroll",f,{passive:true});w.addEventListener("resize",f);w.addEventListener("pagehide",function(){p.postMessage({jsonrpc:"2.0",method:${scriptLiteral(PAGE_LEFT_METHOD)}},"*");});})();`;

// micromark's own lists of the protocols a link and an image may use.
const LINK_PROTOCOL = /^(?:https?|ircs?|mailto|xmpp)$/i;
const IMAGE_PROTOCOL = /^https?$/i;
// The one kind of image the content policy loads, and the form PageStore
// inlines a page's local images into.
const DATA_IMAGE = /^data:image\//i;
// With raw HTML escaped, every one of these in the output is a tag micromark wrote.
const MEDIA_URL = /<(a href|img src)="([^"]*)"/g;

/** micromark's own test: a URL with no scheme before its first `/`, `?` or `#` is relative. */
const hasAllowedProtocol = (url: string, allowed: RegExp) => {
  const colon = url.indexOf(":");
  if (colon === -1) return true;
  const beforeColon = url.slice(0, colon);
  return /[/?#]/.test(beforeColon) || allowed.test(beforeColon);
};

/**
 * The page's own markup for a Markdown document: GitHub-flavored, raw HTML
 * escaped. micromark would blank every image that is not http(s), and so
 * every image a page can load. It renders with all protocols kept instead,
 * and then each URL it wrote is held to micromark's own list for its tag,
 * with `data:image/` added for images.
 */
export function renderAgentPageMarkdown(markdown: string): string {
  const body = micromark(markdown, {
    allowDangerousProtocol: true,
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
  }).replace(MEDIA_URL, (tag, attribute: string, url: string) => {
    const allowed =
      attribute === "img src"
        ? DATA_IMAGE.test(url) || hasAllowedProtocol(url, IMAGE_PROTOCOL)
        : hasAllowedProtocol(url, LINK_PROTOCOL);
    return allowed ? tag : `<${attribute}=""`;
  });
  return `<style>${DOCUMENT_CSS}</style><article class="tl-document">${body}</article>`;
}

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
    `<style id="tl-page-theme">${agentPageThemeRule(input.theme)}${BASE_CSS}</style>` +
    `<script>${BOOTSTRAP_SCRIPT}</script>`;
  if (input.kind === "markdown") {
    return `<!doctype html><html><head>${wrapper}</head><body>${renderAgentPageMarkdown(input.content)}</body></html>`;
  }
  return wrapHtmlDocument(input.content, wrapper);
}
