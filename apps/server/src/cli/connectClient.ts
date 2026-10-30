/**
 * The `threadlines` command's MCP client for `/mcp/connect`
 * (docs/design/outside-agents.md, "The MCP client"): plain JSON-RPC over
 * HTTP POST, the Streamable HTTP transport at protocol 2025-06-18, with no
 * MCP library.
 *
 * - `initialize`, then `notifications/initialized`, then `tools/call`.
 * - It keeps the `mcp-session-id` the server gives, and takes a JSON or an
 *   SSE reply (read only up to the event that answers).
 * - A 404 on its session (the server restarted) means it initializes again,
 *   once per call. The call is sent again: a 404 comes before the server
 *   looks at it.
 * - A 401 is `signed_out`; nothing answering is `not_running`.
 * - Results are decoded with the tool's own schema from connectTools.ts.
 *   Refusals are outcomes in those results, never errors.
 */
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

import { ConnectError, NOT_RUNNING_MESSAGE, SIGNED_OUT_MESSAGE } from "./connectExit.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const SESSION_HEADER = "mcp-session-id";

const NOT_AN_AGENT_ADDRESS = "This Threadlines doesn't take agents. Update it, then try again.";

const JsonRpcReply = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
});
type JsonRpcReply = typeof JsonRpcReply.Type;
const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(JsonRpcReply));

const CallToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
  content: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
  ),
});
const decodeCallToolResult = Schema.decodeUnknownEffect(CallToolResult);

/** Each tool's result decoder, compiled the first time the tool is called. */
const resultDecoders = new Map<
  string,
  (input: unknown) => Effect.Effect<unknown, Schema.SchemaError>
>();
const resultDecoderFor = (tool: Tool.Any) => {
  let decoder = resultDecoders.get(tool.name);
  if (decoder === undefined) {
    decoder = Schema.decodeUnknownEffect(tool.successSchema as Schema.Codec<unknown>);
    resultDecoders.set(tool.name, decoder);
  }
  return decoder;
};

/** The server no longer knows our session: initialize again. */
class SessionLost extends Data.TaggedError("SessionLost")<{}> {}

const failed = (message: string) => new ConnectError({ reason: "failed", message });

/** The JSON-RPC reply to request `id` in one message (a JSON body, or an SSE event's data). */
const replyTo = (message: string, id: number): JsonRpcReply | null => {
  const reply = decodeReply(message);
  if (reply._tag === "None" || reply.value.id !== id) return null;
  return reply.value.result !== undefined || reply.value.error !== undefined ? reply.value : null;
};

/** One server-sent event's data: its `data:` lines, joined. */
const sseEventData = (event: string) =>
  event
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).replace(/^ /u, ""))
    .join("\n");

/**
 * Server-sent events' data, each as soon as its event is complete; the last
 * one too when the stream ends without a blank line after it.
 */
export const sseEventsData = <E, R>(text: Stream.Stream<string, E, R>) =>
  text.pipe(
    Stream.mapAccum(
      () => "",
      (buffer, chunk) => {
        const events = `${buffer}${chunk}`.split(/\r?\n\r?\n/u);
        const rest = events.pop() ?? "";
        return [rest, events.map(sseEventData)] as const;
      },
      { onHalt: (rest) => [sseEventData(rest)] },
    ),
    Stream.filter((data) => data.length > 0),
  );

/**
 * The reply to request `id`: a JSON body, read whole, or server-sent events,
 * read until the one that answers it. A server may keep an event stream open
 * after its reply (to send more), and the call must not wait for it to close.
 */
const readReply = (response: HttpClientResponse.HttpClientResponse, id: number) =>
  (response.headers["content-type"] ?? "").includes("text/event-stream")
    ? sseEventsData(response.stream.pipe(Stream.decodeText())).pipe(
        Stream.map((data) => replyTo(data, id)),
        Stream.filter((reply): reply is JsonRpcReply => reply !== null),
        Stream.runHead,
        Effect.map(Option.getOrNull),
      )
    : response.text.pipe(Effect.map((body) => replyTo(body, id)));

export interface ConnectClient {
  /** Calls one of connectTools.ts's tools and decodes its result. */
  readonly call: <T extends Tool.Any>(
    tool: T,
    parameters: Tool.ParametersEncoded<T>,
  ) => Effect.Effect<Tool.Success<T>, ConnectError>;
}

/**
 * How long one call may take, request and whole reply: a start sets up a
 * worktree and runs the setup script first, a wait holds for up to 50 s by
 * design, and everything else answers at once.
 */
const callDeadline = (toolName: string): Duration.Duration =>
  toolName === "thread_start"
    ? Duration.minutes(5)
    : toolName === "thread_wait"
      ? Duration.seconds(75)
      : Duration.seconds(60);
const INITIALIZE_DEADLINE = Duration.seconds(15);
/** Tools that change something: when one times out, it may still have happened. */
const CHANGES = new Set(["thread_start", "thread_send", "thread_stop"]);

export const makeConnectClient = Effect.fn("cli.connect.makeClient")(function* (input: {
  readonly resource: string;
  readonly token: string;
  readonly clientVersion: string;
  /** A session an earlier command opened with this token; tried before opening another. */
  readonly sessionId?: string | null | undefined;
  /** Told about each session this client opens, to keep for the next command. */
  readonly onSession?: ((sessionId: string) => Effect.Effect<void>) | undefined;
}) {
  const httpClient = yield* HttpClient.HttpClient;
  const session = yield* Ref.make<string | null>(input.sessionId ?? null);
  const nextId = yield* Ref.make(1);

  const post = (message: unknown, sessionId: string | null) =>
    httpClient
      .execute(
        HttpClientRequest.post(input.resource).pipe(
          HttpClientRequest.setHeaders({
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${input.token}`,
            "mcp-protocol-version": MCP_PROTOCOL_VERSION,
            ...(sessionId === null ? {} : { [SESSION_HEADER]: sessionId }),
          }),
          HttpClientRequest.bodyJsonUnsafe(message),
        ),
      )
      .pipe(
        Effect.mapError(
          () => new ConnectError({ reason: "not_running", message: NOT_RUNNING_MESSAGE }),
        ),
      );

  /** Checks the status every answer shares. */
  const checkStatus = (response: HttpClientResponse.HttpClientResponse, sessionId: string | null) =>
    Effect.gen(function* () {
      if (response.status === 401) {
        return yield* new ConnectError({ reason: "signed_out", message: SIGNED_OUT_MESSAGE });
      }
      if (response.status === 404) {
        // With a session, the server forgot it; without one, nothing here
        // takes agents (an older Threadlines, or something else on the port).
        return yield* sessionId === null
          ? new ConnectError({ reason: "not_running", message: NOT_AN_AGENT_ADDRESS })
          : new SessionLost();
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* failed(`Threadlines answered with HTTP ${response.status}.`);
      }
    });

  /** One request, answered: its JSON-RPC result. */
  const request = (method: string, params: unknown) =>
    Effect.gen(function* () {
      const id = yield* Ref.getAndUpdate(nextId, (value) => value + 1);
      const sessionId = yield* Ref.get(session);
      const response = yield* post({ jsonrpc: "2.0", id, method, params }, sessionId);
      yield* checkStatus(response, sessionId);
      const reply = yield* readReply(response, id).pipe(
        Effect.mapError(() => failed("Threadlines stopped answering in the middle of a reply.")),
      );
      if (reply === null) {
        return yield* failed(`Threadlines sent no answer to ${method}.`);
      }
      if (reply.error !== undefined) {
        return yield* failed(reply.error.message);
      }
      return { result: reply.result, response };
    });

  const initialize = Effect.gen(function* () {
    yield* Ref.set(session, null);
    const { response } = yield* request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "threadlines-cli", version: input.clientVersion },
    });
    const sessionId = response.headers[SESSION_HEADER] ?? null;
    yield* Ref.set(session, sessionId);
    const initialized = yield* post(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      sessionId,
    );
    yield* checkStatus(initialized, sessionId);
    if (sessionId !== null && input.onSession !== undefined) yield* input.onSession(sessionId);
  }).pipe(
    Effect.catchTag("SessionLost", () =>
      Effect.fail(failed("Threadlines dropped the session as it began.")),
    ),
    Effect.timeoutOrElse({
      duration: INITIALIZE_DEADLINE,
      orElse: () => Effect.fail(failed("Threadlines didn't answer in time. Is it busy or stuck?")),
    }),
  );

  const callTool = (name: string, args: unknown) =>
    request("tools/call", { name, arguments: args }).pipe(
      Effect.map(({ result }) => result),
      Effect.timeoutOrElse({
        duration: callDeadline(name),
        orElse: () =>
          Effect.fail(
            failed(
              CHANGES.has(name)
                ? "Threadlines didn't answer in time. It may still have done it: check with threadlines thread list --mine before trying again."
                : "Threadlines didn't answer in time. Is it busy or stuck?",
            ),
          ),
      }),
    );

  const call = <T extends Tool.Any>(tool: T, parameters: Tool.ParametersEncoded<T>) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(session)) === null) yield* initialize;
      const raw = yield* callTool(tool.name, parameters).pipe(
        Effect.catchTag("SessionLost", () =>
          initialize.pipe(
            Effect.andThen(callTool(tool.name, parameters)),
            Effect.catchTag("SessionLost", () =>
              Effect.fail(failed("Threadlines keeps dropping this command's session.")),
            ),
          ),
        ),
      );
      const unreadable = () =>
        failed(
          `Threadlines sent an answer to ${tool.name} this command can't read. Update Threadlines, then try again.`,
        );
      const result = yield* decodeCallToolResult(raw).pipe(Effect.mapError(unreadable));
      if (result.isError === true) {
        const text = result.content
          ?.map((part) => part.text ?? "")
          .join("\n")
          .trim();
        return yield* failed(text || `${tool.name} failed in Threadlines.`);
      }
      return (yield* resultDecoderFor(tool)(result.structuredContent).pipe(
        Effect.mapError(unreadable),
      )) as Tool.Success<T>;
    });

  return { call } satisfies ConnectClient;
});
