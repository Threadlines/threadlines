/**
 * The document an MCP app card's frame shows: the content policy mapped from
 * the hosts the view declared, the color scheme and a bootstrap script, then
 * the view exactly as its MCP server served it. See mcpApps.ts.
 */
import type { AgentPageAppearance } from "./agentPages.ts";
import { scriptLiteral, wrapHtmlDocument } from "./framedDocument.ts";
import { MCP_APP_METHODS, type McpAppCsp, mcpAppContentSecurityPolicy } from "./mcpApps.ts";

const colorSchemeRule = (appearance: AgentPageAppearance) =>
  `:root{color-scheme:${appearance === "light" ? "light" : "dark"}}`;

// Runs first, before anything the view says. It removes WebRTC, which no
// content policy governs; keeps the frame's color scheme on the host's (a
// frame whose scheme differs from the page around it paints an opaque
// background); sends links the reader clicks to the host instead of
// navigating the frame; and tells the host when the document goes away,
// which for a view only happens when it navigates itself.
const BOOTSTRAP_SCRIPT = `(function(){var w=window,d=document,p=w.parent;["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCSessionDescription","RTCIceCandidate"].forEach(function(k){try{Object.defineProperty(w,k,{value:void 0,writable:false,configurable:false});}catch(e){}});var s=d.getElementById("tl-app-scheme");w.addEventListener("message",function(e){if(e.source!==p)return;var m=e.data,q=m&&m.params;if(s&&m&&m.jsonrpc==="2.0"&&m.method===${scriptLiteral(MCP_APP_METHODS.hostContextChanged)}&&q&&(q.theme==="light"||q.theme==="dark"))s.textContent=":root{color-scheme:"+q.theme+"}";});d.addEventListener("click",function(e){if(!e.isTrusted||e.defaultPrevented)return;var l=e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}),h,u;if(!l)return;h=l.getAttribute("href")||"";if(h.charAt(0)==="#")return;e.preventDefault();try{u=new URL(h,d.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol))return;p.postMessage({jsonrpc:"2.0",method:${scriptLiteral(MCP_APP_METHODS.linkClicked)},params:{url:u.href}},"*");});w.addEventListener("pagehide",function(){p.postMessage({jsonrpc:"2.0",method:${scriptLiteral(MCP_APP_METHODS.viewLeft)}},"*");});})();`;

/**
 * The whole document a host puts into a card's frame. Nothing the view says
 * comes before the wrapper (wrapHtmlDocument), so no script of the view's
 * runs outside the policy.
 */
export function buildMcpAppDocument(input: {
  readonly html: string;
  readonly csp: McpAppCsp;
  readonly appearance: AgentPageAppearance;
}): string {
  const policy = mcpAppContentSecurityPolicy(input.csp).replaceAll('"', "&quot;");
  const wrapper =
    `<meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${policy}">` +
    `<style id="tl-app-scheme">${colorSchemeRule(input.appearance)}</style>` +
    `<script>${BOOTSTRAP_SCRIPT}</script>`;
  return wrapHtmlDocument(input.html, wrapper);
}
