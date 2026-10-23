/**
 * The browser page an outside agent opens to sign in
 * (docs/design/outside-agents.md, "What the user does"). One self-contained
 * page with no external loads: it shows the code to match in Threadlines,
 * polls the sign-in's status, and hands the answer to the agent by going to
 * the callback it is given. Every way a sign-in ends has its own line.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as Crypto from "node:crypto";

/** How a sign-in page starts out; `waiting` polls until it becomes one of the others. */
export type SignInPageState =
  | "waiting"
  | "approved"
  | "denied"
  | "expired"
  | "replaced"
  | "restarted"
  | "gone"
  | "quiet"
  | "full"
  | "limited"
  | "invalid"
  | "cross-site";

/** What the page says in each state. Plain words; the user reads it in a hurry. */
const LINES: Record<SignInPageState, { readonly title: string; readonly body: string }> = {
  waiting: {
    title: "Approve this agent in Threadlines",
    body: "Waiting for you to allow it in Threadlines.",
  },
  approved: { title: "Connected", body: "You can close this tab." },
  denied: {
    title: "Not allowed",
    body: "This agent wasn't allowed in Threadlines. You can close this tab.",
  },
  expired: {
    title: "This sign-in timed out",
    body: "Nobody approved it within 5 minutes. Start the sign-in again from your agent.",
  },
  replaced: {
    title: "A newer sign-in took over",
    body: "This agent started signing in again. You can close this tab.",
  },
  restarted: {
    title: "Threadlines restarted",
    body: "This sign-in stopped. Start the sign-in again from your agent.",
  },
  gone: {
    title: "This sign-in isn't waiting anymore",
    body: "Start the sign-in again from your agent.",
  },
  quiet: {
    title: "Threadlines isn't taking new agents right now",
    body: "New agent requests are paused for a few minutes. To take them again now, open Threadlines, then Settings, Connections.",
  },
  full: {
    title: "Too many agents are waiting",
    body: "Allow or deny the ones waiting in Threadlines, then start the sign-in again from your agent.",
  },
  limited: {
    title: "Too many sign-ins",
    body: "Wait a minute, then start the sign-in again from your agent.",
  },
  invalid: {
    title: "This sign-in link doesn't work",
    body: "Threadlines didn't recognize the agent or where to send it back. Start the sign-in again from your agent.",
  },
  "cross-site": {
    title: "Start this from your agent",
    body: "A web page can't start an agent sign-in. Start it from your agent instead.",
  },
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/** JSON that is safe inside a `<script>` element. */
const scriptJson = (value: unknown): string =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");

const STYLE = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1d1d1f; --muted: #6e6e73; --fill: #f2f2f4; }
@media (prefers-color-scheme: dark) { :root { --bg: #1c1c1e; --fg: #f2f2f4; --muted: #a1a1a6; --fill: #2c2c30; } }
html { background: var(--bg); }
body { margin: 0; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 420px; margin: 18vh auto 0; padding: 0 24px; }
h1 { font-size: 17px; font-weight: 600; margin: 0 0 6px; }
p { margin: 0 0 10px; color: var(--muted); }
.agent { color: var(--fg); }
.code { display: inline-block; margin: 6px 0 14px; padding: 8px 14px; border-radius: 8px; background: var(--fill); font: 600 22px/1.2 ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing: 0.08em; }
[hidden] { display: none !important; }
`;

/**
 * The poll loop: asks for the status every 1.5 seconds (through restarts),
 * shows the line for how the sign-in ended, and hands the answer to the
 * agent. An approval goes at once; a refusal waits a moment so the line can
 * be read first.
 */
const SCRIPT = `
(() => {
  const config = JSON.parse(document.getElementById("sign-in-config").textContent);
  const show = (state) => {
    for (const section of document.querySelectorAll("[data-state]")) {
      section.hidden = section.dataset.state !== state;
      if (!section.hidden) document.title = section.querySelector("h1").textContent;
    }
  };
  const answer = (redirect, delay) => {
    if (redirect) setTimeout(() => window.location.replace(redirect), delay);
  };
  if (config.state !== "waiting") {
    answer(config.redirect, 2500);
    return;
  }
  const poll = async () => {
    try {
      const response = await fetch(config.status, { cache: "no-store", credentials: "omit" });
      if (response.ok) {
        const status = await response.json();
        if (status.state !== "waiting") {
          show(status.state);
          const redirect = status.state === "restarted" ? config.redirect : status.redirect;
          answer(redirect, status.state === "approved" ? 0 : 2500);
          return;
        }
      }
    } catch {
      // Threadlines may be restarting; keep asking.
    }
    setTimeout(poll, 1500);
  };
  setTimeout(poll, 1000);
})();
`;

export interface SignInPage {
  readonly html: string;
  /** The page's Content-Security-Policy: its own inline script and style, fetches to itself, never framed. */
  readonly contentSecurityPolicy: string;
}

/**
 * The page in `state`. A waiting page carries its code, the status URL to
 * poll and the answer to hand back if Threadlines restarts meanwhile; a page
 * that starts out refused carries the answer to hand back at once.
 */
export const renderSignInPage = (input: {
  readonly state: SignInPageState;
  readonly name?: string;
  readonly code?: string;
  readonly status?: string;
  readonly redirect?: string;
}): SignInPage => {
  const nonce = Crypto.randomBytes(16).toString("base64");
  const states = (Object.keys(LINES) as Array<SignInPageState>).filter(
    (state) => state === input.state || input.state === "waiting",
  );
  const sections = states
    .map((state) => {
      const line = LINES[state];
      const waiting =
        state === "waiting"
          ? `${input.name === undefined ? "" : `<p class="agent">${escapeHtml(input.name)} wants to use Threadlines on this computer.</p>`}<p>Check that Threadlines shows this code:</p><div class="code">${escapeHtml(input.code ?? "")}</div>`
          : "";
      const hidden = state === input.state ? "" : " hidden";
      return `<section data-state="${state}"${hidden}><h1>${escapeHtml(line.title)}</h1>${waiting}<p>${escapeHtml(line.body)}</p></section>`;
    })
    .join("");
  const config = scriptJson({
    state: input.state,
    status: input.status ?? null,
    redirect: input.redirect ?? null,
  });
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(LINES[input.state].title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>${sections}</main>
<script type="application/json" id="sign-in-config">${config}</script>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`;
  return {
    html,
    contentSecurityPolicy: [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  };
};
