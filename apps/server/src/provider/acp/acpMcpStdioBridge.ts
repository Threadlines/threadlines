/**
 * Lightweight stdio-to-HTTP MCP bridge for ACP agents that do not advertise
 * `mcpCapabilities.http` (and do not declare `assumeHttpMcp`).
 *
 * Every ACP agent supports stdio MCP servers as the protocol's baseline
 * transport. When an agent omits HTTP MCP support, Threadlines translates its
 * loopback `/mcp*` HTTP server entries into stdio entries that spawn Node with
 * this bridge script. The endpoint URL and Bearer credential travel exclusively
 * through the child's environment (`THREADLINES_MCP_URL`,
 * `THREADLINES_MCP_AUTHORIZATION`) so the token never appears in process
 * listings (`ps` / argv).
 *
 * @module provider/acp/acpMcpStdioBridge
 */
import type * as EffectAcpSchema from "effect-acp/schema";

/** Loopback URL of the Threadlines MCP HTTP endpoint. */
export const ACP_MCP_BRIDGE_URL_ENV = "THREADLINES_MCP_URL";
/** Authorization header value (`Bearer <token>`), passed via env so it stays out of argv. */
export const ACP_MCP_BRIDGE_AUTH_ENV = "THREADLINES_MCP_AUTHORIZATION";
/** Optional JSON object of any additional HTTP headers. */
export const ACP_MCP_BRIDGE_HEADERS_ENV = "THREADLINES_MCP_HEADERS";

/**
 * Self-contained Node script that forwards newline-delimited JSON-RPC messages
 * on stdio to a Streamable HTTP MCP endpoint. Supports concurrent requests (so
 * long-running calls like `room_ask` do not stall other calls), tracks
 * `Mcp-Session-Id` and the negotiated `Mcp-Protocol-Version`, handles 202/204
 * notification acks and SSE responses, and aborts in-flight HTTP calls when
 * stdin closes.
 */
export const ACP_MCP_STDIO_BRIDGE_SCRIPT = [
  'const readline = require("node:readline");',
  `const url = process.env[${JSON.stringify(ACP_MCP_BRIDGE_URL_ENV)}];`,
  'if (!url) { process.stderr.write("Missing THREADLINES_MCP_URL\\n"); process.exit(1); }',
  "const baseHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };",
  `const rawExtra = process.env[${JSON.stringify(ACP_MCP_BRIDGE_HEADERS_ENV)}];`,
  "if (rawExtra) { try { Object.assign(baseHeaders, JSON.parse(rawExtra)); } catch {} }",
  `const auth = process.env[${JSON.stringify(ACP_MCP_BRIDGE_AUTH_ENV)}];`,
  "if (auth) baseHeaders.authorization = auth;",
  "let sessionId;",
  "let protocolVersion;",
  "const active = new Set();",
  "let closing = false;",
  'process.stdout.on("error", () => process.exit(0));',
  'const send = (msg) => { if (!process.stdout.destroyed) process.stdout.write(msg + "\\n"); };',
  'const sendError = (id, message) => send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }));',
  "const handlePayload = (raw, method) => {",
  "  const text = raw.trim();",
  "  if (!text) return;",
  "  try {",
  "    const parsed = JSON.parse(text);",
  '    if (method === "initialize" && parsed && parsed.result && typeof parsed.result.protocolVersion === "string") {',
  "      protocolVersion = parsed.result.protocolVersion;",
  "    }",
  "    send(JSON.stringify(parsed));",
  "  } catch {",
  '    send(text.replace(/\\r?\\n/g, " "));',
  "  }",
  "};",
  "const forward = async (line) => {",
  "  let parsed;",
  "  try { parsed = JSON.parse(line); } catch { return; }",
  '  const id = parsed && typeof parsed === "object" ? parsed.id : undefined;',
  '  const method = parsed && typeof parsed === "object" ? parsed.method : undefined;',
  "  const headers = { ...baseHeaders };",
  '  if (sessionId) headers["mcp-session-id"] = sessionId;',
  '  if (protocolVersion && method !== "initialize" && method !== "server/discover") headers["mcp-protocol-version"] = protocolVersion;',
  "  const ac = new AbortController();",
  "  active.add(ac);",
  "  try {",
  '    const res = await fetch(url, { method: "POST", headers, body: line, signal: ac.signal });',
  '    const nextSession = res.headers.get("mcp-session-id");',
  "    if (nextSession) sessionId = nextSession;",
  "    if (res.status === 202 || res.status === 204) return;",
  '    const ct = (res.headers.get("content-type") || "").toLowerCase();',
  '    if (ct.includes("text/event-stream") && res.body) {',
  "      const reader = res.body.getReader();",
  "      const dec = new TextDecoder();",
  '      let buf = "";',
  "      let dataLines = [];",
  "      const flush = () => {",
  "        if (dataLines.length === 0) return;",
  '        const payload = dataLines.join("\\n");',
  "        dataLines = [];",
  "        handlePayload(payload, method);",
  "      };",
  "      for (;;) {",
  "        const { value, done } = await reader.read();",
  "        if (done) break;",
  "        buf += dec.decode(value, { stream: true });",
  "        let nl;",
  '        while ((nl = buf.indexOf("\\n")) !== -1) {',
  '          const ln = buf.slice(0, nl).replace(/\\r$/, "");',
  "          buf = buf.slice(nl + 1);",
  '          if (ln === "") flush();',
  '          else if (ln.startsWith("data:")) dataLines.push(ln.slice(5).trimStart());',
  "        }",
  "      }",
  "      flush();",
  "      return;",
  "    }",
  "    const text = (await res.text()).trim();",
  "    if (!text) {",
  "      if (!res.ok && id !== undefined) sendError(id, `HTTP ${res.status}`);",
  "      return;",
  "    }",
  "    try {",
  "      const json = JSON.parse(text);",
  '      if (method === "initialize" && json && json.result && typeof json.result.protocolVersion === "string") {',
  "        protocolVersion = json.result.protocolVersion;",
  "      }",
  "      send(JSON.stringify(json));",
  "    } catch {",
  "      if (id !== undefined) sendError(id, `HTTP ${res.status}: ${text.slice(0, 500)}`);",
  "    }",
  "  } catch (err) {",
  "    if (!closing && !ac.signal.aborted && id !== undefined) {",
  "      sendError(id, err && err.message ? String(err.message) : String(err));",
  "    }",
  "  } finally {",
  "    active.delete(ac);",
  "    if (closing && active.size === 0) process.exit(0);",
  "  }",
  "};",
  "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
  'rl.on("line", (line) => { const trimmed = line.trim(); if (trimmed) void forward(trimmed); });',
  'rl.on("close", () => {',
  "  closing = true;",
  "  for (const ac of active) ac.abort();",
  "  if (active.size === 0) process.exit(0);",
  "});",
].join("\n");

export type HttpMcpServer = Extract<EffectAcpSchema.McpServer, { readonly type: "http" }>;
export type StdioMcpServer = Exclude<EffectAcpSchema.McpServer, { readonly type: string }>;

/**
 * Converts a Threadlines HTTP MCP server entry into an ACP stdio MCP server
 * entry backed by `ACP_MCP_STDIO_BRIDGE_SCRIPT`.
 */
export function httpMcpServerToStdioBridge(
  server: HttpMcpServer,
  options?: {
    readonly nodePath?: string;
    readonly isElectron?: boolean;
  },
): StdioMcpServer {
  let authorization: string | undefined;
  const extraHeaders: Record<string, string> = {};
  for (const header of server.headers) {
    if (header.name.toLowerCase() === "authorization") {
      authorization = header.value;
    } else {
      extraHeaders[header.name] = header.value;
    }
  }
  const env: Array<{ readonly name: string; readonly value: string }> = [
    { name: ACP_MCP_BRIDGE_URL_ENV, value: server.url },
    ...(authorization !== undefined
      ? [{ name: ACP_MCP_BRIDGE_AUTH_ENV, value: authorization }]
      : []),
    ...(Object.keys(extraHeaders).length > 0
      ? [{ name: ACP_MCP_BRIDGE_HEADERS_ENV, value: JSON.stringify(extraHeaders) }]
      : []),
    // In desktop Electron builds, process.execPath is the Electron binary,
    // which behaves like Node only when ELECTRON_RUN_AS_NODE=1 is set.
    ...((options?.isElectron ?? Boolean(process.versions.electron))
      ? [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }]
      : []),
  ];
  return {
    name: server.name,
    command: options?.nodePath ?? process.execPath,
    args: ["-e", ACP_MCP_STDIO_BRIDGE_SCRIPT],
    env,
  };
}
