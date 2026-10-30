import type { RelayAssistantClientIdentity } from "@threadlines/contracts/relayAssistants";
import { randomBytes, toBase64Url } from "@threadlines/shared/relaySecure";

/**
 * The sign-in page an assistant opens (`GET /authorize`), and the error page
 * for a sign-in link that can't start. Self-contained: inline style and
 * script under a per-response nonce, nothing else allowed to load, no form
 * posts, no framing, no referrer. The page's secret is in the page only (no
 * cookies); it proves to the relay that a typed code came from this page.
 */

const INSTRUCTION =
  "Open Threadlines on your computer and choose Settings › Assistants › Connect an assistant. Type the code it shows here.";

export function identityLine(clientName: string, identity: RelayAssistantClientIdentity): string {
  return identity.kind === "cimd"
    ? `Signs in from ${identity.host}`
    : `Says it's ${clientName}. Sign-in returns to ${identity.host}`;
}

export function signInPageResponse(input: {
  readonly clientName: string;
  readonly identity: RelayAssistantClientIdentity;
  readonly signInId: string;
  readonly pageSecret: string;
}): Response {
  const nonce = newNonce();
  const title = `Connect ${input.clientName} to Threadlines`;
  const data = scriptJson({
    signInId: input.signInId,
    pageSecret: input.pageSecret,
    clientName: input.clientName,
  });
  const body = `<main>
<p class="brand">Threadlines</p>
<h1>${escapeHtml(title)}</h1>
<p class="identity">${escapeHtml(identityLine(input.clientName, input.identity))}</p>
<form id="form" novalidate>
<p>${escapeHtml(INSTRUCTION)}</p>
<label for="code">Code</label>
<div class="row">
<input id="code" name="code" autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="16" placeholder="K4D8-2PQX" aria-describedby="message" required>
<button id="continue" type="submit">Continue</button>
</div>
</form>
<p id="message" role="status" aria-live="polite"></p>
</main>
<script nonce="${nonce}">${PAGE_SCRIPT.replace("__DATA__", () => data)}</script>`;
  return htmlResponse(document(title, nonce, body), 200, nonce, true);
}

/** A sign-in link that can't start: shown, never redirected (a bad client or return address could be anyone's). */
export function errorPageResponse(status: number, message: string): Response {
  const nonce = newNonce();
  const title = "This sign-in can't start";
  const body = `<main>
<p class="brand">Threadlines</p>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p class="hint">Start again from your assistant. If it keeps happening, the assistant may not support Threadlines yet.</p>
</main>`;
  return htmlResponse(document(title, nonce, body), status, nonce, false);
}

function document(title: string, nonce: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">${PAGE_STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}

function htmlResponse(html: string, status: number, nonce: string, script: boolean): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": [
        "default-src 'none'",
        `style-src 'nonce-${nonce}'`,
        script ? `script-src 'nonce-${nonce}'` : "script-src 'none'",
        "connect-src 'self'",
        "form-action 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "cross-origin-opener-policy": "same-origin",
    },
  });
}

function newNonce(): string {
  return toBase64Url(randomBytes(18));
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

/** JSON safe inside a `<script>`: nothing in it can close the element (U+2028 is fine in ES2019+ strings). */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, "\\u003c")
    .replace(/>/gu, "\\u003e")
    .replace(/&/gu, "\\u0026");
}

const PAGE_STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#16181d;--muted:#5d6370;--line:#d9dce1;--field:#f4f5f7;--accent:#2f5bd3;--accent-fg:#fff;--error:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--fg:#e8eaee;--muted:#9aa1ad;--line:#2c3038;--field:#1b1e24;--accent:#6d8ff0;--accent-fg:#0b0d12;--error:#f07a6e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:440px;margin:0 auto;padding:48px 20px}
.brand{margin:0 0 20px;font-size:13px;font-weight:600;color:var(--muted)}
h1{margin:0 0 6px;font-size:20px;line-height:1.3;font-weight:600}
.identity{margin:0 0 20px;color:var(--muted)}
p{margin:0 0 14px}
label{display:block;margin:0 0 6px;font-size:13px;font-weight:600}
.row{display:flex;gap:8px}
input{flex:1;min-width:0;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--field);color:var(--fg);font:16px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.08em;text-transform:uppercase}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{padding:8px 14px;border:0;border-radius:6px;background:var(--accent);color:var(--accent-fg);font:600 14px/1.4 inherit;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
#message{margin-top:14px;min-height:1.5em}
#message[data-tone=error]{color:var(--error)}
.hint{color:var(--muted)}
`;

/** The page's whole behaviour: check the typed code's shape, send it, then wait for the computer's decision. */
const PAGE_SCRIPT = `(() => {
const data = __DATA__;
const form = document.getElementById("form");
const input = document.getElementById("code");
const button = document.getElementById("continue");
const message = document.getElementById("message");
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let polling = false;
function normalize(value) {
  const code = value.toUpperCase().replace(/[\\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (code.length !== 8) return null;
  for (const char of code) if (!ALPHABET.includes(char)) return null;
  return code;
}
function show(text, tone) {
  message.textContent = text;
  if (tone) message.dataset.tone = tone; else delete message.dataset.tone;
}
function ready(on) { input.disabled = !on; button.disabled = !on; }
function end(text) { form.hidden = true; show(text); }
function tries(count) { return count === 1 ? "1 try left." : count + " tries left."; }
function apply(answer) {
  const status = answer.status || { state: "unknown" };
  switch (status.state) {
    case "waiting-for-code":
      ready(true);
      if (answer.mismatch) show("That code didn't match. Check it and try again. " + tries(status.triesLeft), "error");
      else if (answer.busy) show("Still checking the last code. Try again in a moment.");
      else if (answer.unavailable) show("Threadlines couldn't check the code just now. Try again.", "error");
      input.focus();
      return;
    case "waiting-for-approval":
      form.hidden = true;
      show("Allow it in Threadlines on your computer.");
      if (!polling) { polling = true; setTimeout(poll, 2000); }
      return;
    case "done":
      form.hidden = true;
      show("Done. Taking you back to " + data.clientName + ".");
      location.replace(status.redirectUrl);
      return;
    case "over": end("That was the last try. Start again from your assistant."); return;
    case "expired": end("This sign-in timed out. Start again from your assistant."); return;
    case "failed": end("Something went wrong on the relay. Start again from your assistant."); return;
    default: end("This sign-in isn't valid anymore. Start again from your assistant.");
  }
}
async function poll() {
  const query = "signInId=" + encodeURIComponent(data.signInId) + "&pageSecret=" + encodeURIComponent(data.pageSecret);
  let wait = 2000;
  try {
    const response = await fetch("/authorize/status?" + query, { cache: "no-store" });
    if (response.ok) {
      const answer = await response.json();
      if (answer.status && answer.status.state !== "waiting-for-approval") { polling = false; apply(answer); return; }
    } else {
      wait = 10000;
    }
  } catch {
    wait = 5000;
  }
  setTimeout(poll, wait);
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = normalize(input.value);
  if (!code) { show("Codes have 8 letters and numbers, like K4D8-2PQX.", "error"); input.focus(); return; }
  ready(false);
  show("Checking the code…");
  try {
    const response = await fetch("/authorize/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signInId: data.signInId, pageSecret: data.pageSecret, code }),
    });
    if (response.status === 429) { ready(true); show("Too many tries from your network. Wait a minute, then try again.", "error"); return; }
    if (!response.ok) { ready(true); show("Threadlines couldn't check the code just now. Try again.", "error"); return; }
    apply(await response.json());
  } catch {
    ready(true);
    show("Couldn't reach Threadlines. Check your connection and try again.", "error");
  }
});
input.focus();
})();`;
