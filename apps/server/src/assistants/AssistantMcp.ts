/**
 * The assistants door's MCP endpoint (docs/design/assistants.md, "The MCP
 * endpoint on the computer"): a small stateless JSON-RPC handler,
 * (credential, headers, body) -> (status, headers, body), not Effect's
 * McpServer, which speaks only 2025-06-18, keeps every session in memory,
 * and takes no custom methods.
 *
 * Every request is authenticated first; a refused credential gets 401 with
 * `WWW-Authenticate` pointing at the resource metadata. One JSON-RPC message
 * per request: a batch is refused. Notifications get 202 with no body.
 *
 * Two generations of the protocol:
 * - **Before 2026-07-28** (an `initialize` lifecycle): `initialize`
 *   negotiates 2025-06-18 whatever the client offers, and returns an opaque
 *   `mcp-session-id`; any session id is taken afterwards and nothing is kept.
 *   `ping`, `tools/list`, `tools/call`.
 * - **2026-07-28** (the version in each request's `_meta`): `server/discover`,
 *   `tools/list` and `tools/call`. An unknown version gets
 *   UnsupportedProtocolVersion (-32022), never for an `initialize`; the
 *   `MCP-Protocol-Version`, `Mcp-Method` and (for `tools/call`) `Mcp-Name`
 *   headers must match the body (HeaderMismatch, -32020); every result
 *   carries `resultType: "complete"`; `tools/list` is in a fixed order with
 *   `ttlMs` and `cacheScope: "private"`.
 *
 * `tools/list` shows what the caller's live grant allows, as the local door
 * does (`listOnlyGrantedTools`); each tool checks the grant again anyway. A
 * tool result too large for the relay's frame becomes a tool error saying so.
 */
// @effect-diagnostics nodeBuiltinImport:off
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Tool } from "effect/unstable/ai";

import type { OutsideAgentCaller } from "../outsideAgents/OutsideAgentConnections.ts";
import type {
  AssistantHttpRequest,
  AssistantHttpResponse,
  AssistantMcpHandler,
  AssistantsShape,
} from "./Assistants.ts";

export const ASSISTANT_MCP_LEGACY_VERSION = "2025-06-18";
export const ASSISTANT_MCP_MODERN_VERSION = "2026-07-28";
const SUPPORTED_VERSIONS = [ASSISTANT_MCP_MODERN_VERSION, ASSISTANT_MCP_LEGACY_VERSION];
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
/** How long a client may keep a tool list: the grant can change in Settings meanwhile. */
const TOOLS_TTL_MS = 5 * 60_000;
const DISCOVER_TTL_MS = 60 * 60_000;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** One tool on this door: its Effect definition, this door's listing changes, and how to run it. */
export interface AssistantMcpTool {
  readonly tool: Tool.Any;
  /** This door's description, when it differs from the tool's own. */
  readonly description?: string;
  /** Parameters this door requires beyond the tool's own required ones. */
  readonly required?: ReadonlyArray<string>;
  /** Runs it for `caller` with its decoded parameters: its success value. */
  readonly run: (caller: OutsideAgentCaller, parameters: unknown) => Effect.Effect<unknown>;
}

export interface AssistantMcpOptions {
  readonly authenticate: AssistantsShape["authenticate"];
  /** The tools the caller's live grant lists now. */
  readonly listed: (caller: OutsideAgentCaller) => Effect.Effect<ReadonlySet<string>>;
  /** Every tool, in the order `tools/list` shows them. */
  readonly tools: ReadonlyArray<AssistantMcpTool>;
  readonly serverInfo: {
    readonly name: string;
    readonly title: string;
    readonly version: string;
  };
  readonly instructions?: string;
  /** Whether an answer fits the relay's frame. */
  readonly fits: (response: AssistantHttpResponse) => boolean;
}

type JsonObject = Record<string, unknown>;
type RpcId = string | number;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): AssistantHttpResponse => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const rpcError = (
  status: number,
  id: RpcId | null,
  code: number,
  message: string,
  data?: unknown,
): AssistantHttpResponse =>
  jsonResponse(status, {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });

const accepted: AssistantHttpResponse = { status: 202, headers: {}, body: "" };

/** `Mcp-Name` and friends: plain, or the `=?base64?…?=` sentinel for values unsafe in a header. */
const decodeHeaderValue = (value: string): string => {
  const match = /^=\?base64\?(.*)\?=$/su.exec(value);
  if (match === null) return value;
  return Buffer.from(match[1] ?? "", "base64").toString("utf8");
};

/** What `tools/list` shows of one tool, built the way McpServer builds it. */
const listingOf = (entry: AssistantMcpTool): JsonObject => {
  const { tool } = entry;
  const inputSchema = Tool.getJsonSchema(tool) as JsonObject;
  const ownRequired = Array.isArray(inputSchema.required)
    ? (inputSchema.required as ReadonlyArray<string>)
    : [];
  const required =
    entry.required === undefined ? ownRequired : [...new Set([...ownRequired, ...entry.required])];
  const outputSchema = Tool.getJsonSchemaFromSchema(tool.successSchema) as JsonObject;
  const title = Option.getOrUndefined(Context.getOption(tool.annotations, Tool.Title));
  return {
    name: tool.name,
    ...(title !== undefined ? { title } : {}),
    description: entry.description ?? Tool.getDescription(tool) ?? "",
    inputSchema: { ...inputSchema, ...(required.length > 0 ? { required } : {}) },
    ...(outputSchema.type === "object" ? { outputSchema } : {}),
    annotations: {
      ...(title !== undefined ? { title } : {}),
      readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
      destructiveHint: Context.get(tool.annotations, Tool.Destructive),
      idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
      openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
    },
  };
};

const toolError = (text: string) => ({ isError: true, content: [{ type: "text", text }] });

export const makeAssistantMcp = (options: AssistantMcpOptions): AssistantMcpHandler => {
  const tools = options.tools.map((entry) => ({
    entry,
    listing: listingOf(entry),
    decode: Schema.decodeUnknownEffect(entry.tool.parametersSchema as Schema.Codec<unknown>),
    encode: Schema.encodeEffect(entry.tool.successSchema as Schema.Codec<unknown>),
  }));
  const byName = new Map(tools.map((tool) => [tool.entry.tool.name, tool]));
  const serverInfo = options.serverInfo;
  const resultMeta = { [META_SERVER_INFO]: { name: serverInfo.name, version: serverInfo.version } };

  const unauthorized = (resource: string): AssistantHttpResponse => {
    let origin = resource;
    try {
      origin = new URL(resource).origin;
    } catch {
      // The relay sends a URL; keep what it sent otherwise.
    }
    return jsonResponse(
      401,
      {
        error: "invalid_token",
        error_description: "Sign in to Threadlines from your assistant again.",
      },
      {
        "cache-control": "no-store",
        "www-authenticate": `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      },
    );
  };

  const listFor = (caller: OutsideAgentCaller) =>
    Effect.map(options.listed(caller), (granted) =>
      tools.filter((tool) => granted.has(tool.entry.tool.name)).map((tool) => tool.listing),
    );

  /** `tools/call`'s result, or an InvalidParams message. */
  const callTool = (
    caller: OutsideAgentCaller,
    params: JsonObject | undefined,
  ): Effect.Effect<{ readonly result: JsonObject } | { readonly invalid: string }> =>
    Effect.gen(function* () {
      const name = params?.name;
      if (typeof name !== "string") return { invalid: "tools/call needs the tool's name." };
      const tool = byName.get(name);
      if (tool === undefined) return { invalid: `There is no tool called ${name}.` };
      const decoded = yield* tool.decode(params?.arguments ?? {}).pipe(Effect.result);
      if (decoded._tag === "Failure") {
        return {
          invalid: `The arguments for ${name} don't fit its input schema: ${decoded.failure.message}`,
        };
      }
      const value = yield* tool.entry.run(caller, decoded.success);
      const encoded = yield* tool.encode(value);
      return {
        result: {
          isError: false,
          structuredContent: encoded,
          content: [{ type: "text", text: JSON.stringify(encoded) }],
        },
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("assistants: a tool failed", { cause }).pipe(
          Effect.as({ result: toolError("Threadlines couldn't run that tool. Try again.") }),
        ),
      ),
    );

  /** A result, or the too-large tool error when it wouldn't fit the relay's frame. */
  const answerCall = (id: RpcId, result: JsonObject, extra: JsonObject): AssistantHttpResponse => {
    const full = jsonResponse(200, { jsonrpc: "2.0", id, result: { ...result, ...extra } });
    if (options.fits(full)) return full;
    const kib = Math.ceil(Buffer.byteLength(full.body, "utf8") / 1024);
    return jsonResponse(200, {
      jsonrpc: "2.0",
      id,
      result: {
        ...toolError(
          `The result was too large to send (${kib} KiB; the most is 768 KiB). Ask for less: a smaller limit, or read a thread in pages with after.`,
        ),
        ...extra,
      },
    });
  };

  const legacy = (
    caller: OutsideAgentCaller,
    id: RpcId,
    method: string,
    params: JsonObject | undefined,
  ): Effect.Effect<AssistantHttpResponse> =>
    Effect.gen(function* () {
      const answer = (result: unknown, headers: Record<string, string> = {}) =>
        jsonResponse(200, { jsonrpc: "2.0", id, result }, headers);
      switch (method) {
        case "initialize":
          // We speak 2025-06-18; a client offering anything else gets it back and decides.
          return answer(
            {
              protocolVersion: ASSISTANT_MCP_LEGACY_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo,
              ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
            },
            // Opaque, and never kept: any session id is taken afterwards.
            { "mcp-session-id": randomUUID() },
          );
        case "ping":
          return answer({});
        case "tools/list":
          return answer({ tools: yield* listFor(caller) });
        case "tools/call": {
          const called = yield* callTool(caller, params);
          return "invalid" in called
            ? rpcError(200, id, INVALID_PARAMS, called.invalid)
            : answerCall(id, called.result, {});
        }
        default:
          return rpcError(200, id, METHOD_NOT_FOUND, `Method not found: ${method}`);
      }
    });

  const modern = (
    caller: OutsideAgentCaller,
    id: RpcId,
    method: string,
    params: JsonObject | undefined,
    headers: Readonly<Record<string, string>>,
    version: string | undefined,
  ): Effect.Effect<AssistantHttpResponse> =>
    Effect.gen(function* () {
      if (version !== undefined && version !== ASSISTANT_MCP_MODERN_VERSION) {
        return rpcError(400, id, UNSUPPORTED_PROTOCOL_VERSION, "Unsupported protocol version", {
          supported: SUPPORTED_VERSIONS,
          requested: version,
        });
      }
      const mismatch = (detail: string) =>
        rpcError(400, id, HEADER_MISMATCH, `Header mismatch: ${detail}`);
      if (version !== undefined && headers["mcp-protocol-version"] !== version) {
        return mismatch(
          `MCP-Protocol-Version header value '${headers["mcp-protocol-version"] ?? ""}' does not match body value '${version}'`,
        );
      }
      if (headers["mcp-method"] !== method) {
        return mismatch(
          `Mcp-Method header value '${headers["mcp-method"] ?? ""}' does not match body value '${method}'`,
        );
      }
      const complete = { resultType: "complete", _meta: resultMeta };
      const answer = (result: JsonObject) =>
        jsonResponse(200, { jsonrpc: "2.0", id, result: { ...result, ...complete } });
      switch (method) {
        case "server/discover":
          return answer({
            supportedVersions: SUPPORTED_VERSIONS,
            capabilities: { tools: {} },
            ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
            ttlMs: DISCOVER_TTL_MS,
            cacheScope: "public",
          });
        case "tools/list":
          return answer({
            tools: yield* listFor(caller),
            ttlMs: TOOLS_TTL_MS,
            cacheScope: "private",
          });
        case "tools/call": {
          const name = params?.name;
          const header = headers["mcp-name"];
          if (
            typeof name === "string" &&
            (header === undefined || decodeHeaderValue(header) !== name)
          ) {
            return mismatch(
              `Mcp-Name header value '${header ?? ""}' does not match body value '${name}'`,
            );
          }
          const called = yield* callTool(caller, params);
          return "invalid" in called
            ? rpcError(400, id, INVALID_PARAMS, called.invalid)
            : answerCall(id, called.result, complete);
        }
        default:
          return rpcError(404, id, METHOD_NOT_FOUND, `Method not found: ${method}`);
      }
    });

  return (request: AssistantHttpRequest) =>
    Effect.gen(function* () {
      const checked = yield* options
        .authenticate({ credential: request.credential, resource: request.resource })
        .pipe(Effect.result);
      if (checked._tag === "Failure") {
        return {
          ...rpcError(
            503,
            null,
            INTERNAL_ERROR,
            "Threadlines couldn't check the credential just now. Try again.",
          ),
          headers: { "content-type": "application/json", "retry-after": "5" },
        };
      }
      const caller = checked.success;
      if (caller === null) return unauthorized(request.resource);

      let message: unknown;
      try {
        message = JSON.parse(request.body);
      } catch {
        return rpcError(400, null, PARSE_ERROR, "The body isn't JSON.");
      }
      if (Array.isArray(message)) {
        return rpcError(
          400,
          null,
          INVALID_REQUEST,
          "Send one JSON-RPC message per request: batches aren't supported.",
        );
      }
      if (!isObject(message) || message.jsonrpc !== "2.0") {
        return rpcError(400, null, INVALID_REQUEST, "The body isn't a JSON-RPC 2.0 message.");
      }
      const method = message.method;
      // A response to a server request (none are sent) or a notification: nothing to answer.
      if (typeof method !== "string") {
        return "id" in message && ("result" in message || "error" in message)
          ? accepted
          : rpcError(400, null, INVALID_REQUEST, "The message has no method.");
      }
      if (!("id" in message) || message.id === undefined) return accepted;
      const id = message.id;
      if (typeof id !== "string" && typeof id !== "number") {
        return rpcError(
          400,
          null,
          INVALID_REQUEST,
          "The request's id must be a string or a number.",
        );
      }
      const params = isObject(message.params) ? message.params : undefined;
      const meta = isObject(params?._meta) ? params._meta : undefined;
      const metaVersion = meta?.[META_PROTOCOL_VERSION];
      if (method === "initialize") return yield* legacy(caller, id, method, params);
      if (typeof metaVersion === "string" || method === "server/discover") {
        return yield* modern(
          caller,
          id,
          method,
          params,
          request.headers,
          typeof metaVersion === "string" ? metaVersion : undefined,
        );
      }
      return yield* legacy(caller, id, method, params);
    });
};
