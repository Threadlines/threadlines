/**
 * MCP app cards (docs/mcp-apps.md): an MCP tool call whose tool ships a
 * `ui://` view shows that view in the chat, under the step that ran it.
 *
 * Runtime ingestion records each such call (`recordCall`) with the agent and
 * session that made it. A card loads the call and its view by the call's id
 * (`load`); the view is read once, through that agent's own session, and
 * kept with the call. A view's own tool calls (`callTool`) go to the same
 * server through the same agent's session, never another's:
 *
 * - only tools the server lets apps call (visibility "app", the default);
 * - without asking only when the agent works with full access and not in
 *   plan mode, the tool's metadata could be read, and the session is known
 *   to be the one that made the call. Otherwise the reader confirms in the card first,
 *   and a call that arrives unconfirmed is refused.
 *
 * Nothing here starts a session, unless the reader asks a card to load its
 * view again (`recover`).
 */
import {
  McpAppError,
  type McpAppCallToolInput,
  type McpAppFailureReason,
  type McpAppLoadInput,
  type McpAppLoadResult,
  type McpAppToolResult,
  type McpAppView,
  type OrchestrationThreadShell,
  type ProviderInstanceId,
  type RuntimeMcpAppCall,
  type ThreadId,
  type ThreadParticipantId,
} from "@threadlines/contracts";
import {
  MCP_APP_CALL_MAX_BYTES,
  MCP_APP_MIME_TYPE,
  MCP_APP_RESOURCE_MAX_BYTES,
  type McpResourceContent,
  readMcpAppResourceUi,
} from "@threadlines/shared/mcpApps";
import { participantSessionKey } from "@threadlines/shared/threadParticipants";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  McpAppCallRepository,
  type McpAppCallRecord,
} from "../persistence/Services/McpAppCalls.ts";
import {
  ProviderService,
  type ProviderAgentSession,
} from "../provider/Services/ProviderService.ts";

export interface McpAppsShape {
  /** Keep a finished call whose tool ships an app, for its card. Never fails:
   *  a call that could not be kept shows its step without a card. */
  readonly recordCall: (input: {
    readonly threadId: ThreadId;
    readonly toolCallId: string;
    readonly participantId: ThreadParticipantId | null;
    readonly providerInstanceId: ProviderInstanceId | null;
    readonly call: RuntimeMcpAppCall;
    /** Made in a side answer, whose locked-down session is not the agent's
     *  own: the app's calls always ask first. */
    readonly fromSideAnswer: boolean;
    readonly createdAt: string;
  }) => Effect.Effect<void>;
  readonly load: (input: McpAppLoadInput) => Effect.Effect<McpAppLoadResult, McpAppError>;
  readonly callTool: (input: McpAppCallToolInput) => Effect.Effect<McpAppToolResult, McpAppError>;
}

export class McpApps extends Context.Service<McpApps, McpAppsShape>()(
  "threadlines/mcpApps/McpApps",
) {}

const fail = (reason: McpAppFailureReason, message: string, cause?: unknown) =>
  Effect.fail(new McpAppError({ reason, message, ...(cause === undefined ? {} : { cause }) }));

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * A call cut to fit MCP_APP_CALL_MAX_BYTES: first the input and the result's
 * content blocks go, then its structured content. The view still learns how
 * the call ended.
 */
export function fitMcpAppCall(call: RuntimeMcpAppCall): {
  readonly call: RuntimeMcpAppCall;
  readonly truncated: boolean;
} {
  if (byteLength(call) <= MCP_APP_CALL_MAX_BYTES) return { call, truncated: false };
  const { arguments: _arguments, ...withoutInput } = call;
  const lighter: RuntimeMcpAppCall = {
    ...withoutInput,
    result: call.result === null ? null : { ...call.result, content: [] },
  };
  if (byteLength(lighter) <= MCP_APP_CALL_MAX_BYTES) return { call: lighter, truncated: true };
  return {
    call: {
      ...lighter,
      result:
        call.result === null
          ? null
          : { content: [], ...(call.result.isError ? { isError: true } : {}) },
    },
    truncated: true,
  };
}

/** The view among a read's contents: the requested resource's HTML. */
function viewDocument(
  contents: ReadonlyArray<McpResourceContent>,
  resourceUri: string,
): McpResourceContent | undefined {
  const html = contents.filter(
    (content) =>
      (content.text !== undefined || content.blob !== undefined) &&
      (content.mimeType === undefined ||
        content.mimeType.toLowerCase().replace(/\s+/gu, "") === MCP_APP_MIME_TYPE ||
        content.mimeType.toLowerCase().startsWith("text/html")),
  );
  return html.find((content) => content.uri === resourceUri) ?? html[0];
}

/** The agent works with full access and not in plan mode. */
const runsWithoutAsking = (thread: OrchestrationThreadShell) =>
  thread.runtimeMode === "full-access" && thread.interactionMode !== "plan";

export const make = Effect.gen(function* () {
  const calls = yield* McpAppCallRepository;
  const providers = yield* ProviderService;
  const snapshots = yield* ProjectionSnapshotQuery;

  const sessionOf = (record: McpAppCallRecord, recover: boolean) =>
    providers
      .agentSession({
        sessionKey: participantSessionKey(record.threadId, record.participantId),
        providerInstanceId: record.providerInstanceId,
        recover,
      })
      .pipe(Effect.orElseSucceed(() => null));

  const requireRecord = (threadId: ThreadId, toolCallId: string) =>
    calls.get({ threadId, toolCallId }).pipe(
      Effect.orElseSucceed(() => Option.none<McpAppCallRecord>()),
      Effect.flatMap((record) =>
        Option.isSome(record)
          ? Effect.succeed(record.value)
          : fail("not-found", "This app's tool call is no longer available."),
      ),
    );

  const requireThread = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(
      Effect.orElseSucceed(() => Option.none<OrchestrationThreadShell>()),
      Effect.flatMap((thread) =>
        Option.isSome(thread)
          ? Effect.succeed(thread.value)
          : fail("not-found", "This thread is no longer available."),
      ),
    );

  const requireSession = (record: McpAppCallRecord, recover: boolean) =>
    sessionOf(record, recover).pipe(
      Effect.flatMap((session) =>
        session === null
          ? fail("session-ended", "The agent that ran this app is no longer running.")
          : Effect.succeed(session),
      ),
    );

  const readView = (record: McpAppCallRecord, session: ProviderAgentSession) =>
    Effect.gen(function* () {
      const read = session.adapter.readMcpResource;
      if (read === undefined) {
        return yield* fail("unsupported", "This agent can't show MCP apps.");
      }
      const contents = yield* read(session.sessionKey, {
        server: record.call.server,
        uri: record.call.resourceUri,
      }).pipe(
        Effect.catch((cause) =>
          fail("failed", `Couldn't load the app from ${record.call.server}.`, cause),
        ),
      );
      const document = viewDocument(contents, record.call.resourceUri);
      const html =
        document?.text ??
        (document?.blob !== undefined ? Buffer.from(document.blob, "base64").toString("utf8") : "");
      if (html.trim().length === 0) {
        return yield* fail("invalid-view", "The app's server sent no page to show.");
      }
      if (new TextEncoder().encode(html).length > MCP_APP_RESOURCE_MAX_BYTES) {
        return yield* fail("invalid-view", "The app's page is too large to show.");
      }
      const ui = readMcpAppResourceUi(document?._meta);
      const view: McpAppView = {
        html,
        csp: ui.csp,
        permissions: ui.permissions,
        prefersBorder: ui.prefersBorder,
      };
      yield* calls
        .setView({ threadId: record.threadId, toolCallId: record.toolCallId }, view)
        .pipe(Effect.ignoreCause({ log: true }));
      return view;
    });

  const recordCall: McpAppsShape["recordCall"] = (input) =>
    Effect.gen(function* () {
      const session = yield* providers
        .agentSession({
          sessionKey: participantSessionKey(input.threadId, input.participantId),
          providerInstanceId: input.providerInstanceId,
          recover: false,
        })
        .pipe(Effect.orElseSucceed(() => null));
      const fitted = fitMcpAppCall(input.call);
      yield* calls.upsert({
        threadId: input.threadId,
        toolCallId: input.toolCallId,
        participantId: input.participantId,
        providerInstanceId: input.providerInstanceId,
        providerThreadId: input.fromSideAnswer ? null : (session?.providerThreadId ?? null),
        call: fitted.call,
        truncated: fitted.truncated,
        createdAt: input.createdAt,
      });
    }).pipe(Effect.ignoreCause({ log: true }));

  const load: McpAppsShape["load"] = Effect.fn("McpApps.load")(function* (input) {
    const record = yield* requireRecord(input.threadId, input.toolCallId);
    const thread = yield* requireThread(input.threadId);
    const view =
      record.view ??
      (yield* readView(record, yield* requireSession(record, input.recover === true)));
    return {
      server: record.call.server,
      tool: record.call.tool,
      resourceUri: record.call.resourceUri,
      arguments: record.call.arguments ?? {},
      result: record.call.result,
      truncated: record.truncated,
      view,
      callsAllowed: runsWithoutAsking(thread),
    };
  });

  const callTool: McpAppsShape["callTool"] = Effect.fn("McpApps.callTool")(function* (input) {
    const record = yield* requireRecord(input.threadId, input.toolCallId);
    const thread = yield* requireThread(input.threadId);
    const session = yield* requireSession(record, false);
    const server = record.call.server;
    const ui =
      session.adapter.readMcpToolUi === undefined
        ? undefined
        : yield* session.adapter
            .readMcpToolUi(session.sessionKey, { server, tool: input.tool })
            .pipe(Effect.orElseSucceed(() => undefined));
    if (ui !== undefined && ui !== null && !ui.visibility.includes("app")) {
      return yield* fail("not-allowed", `${server} doesn't let apps run ${input.tool}.`);
    }
    // Unknown metadata, or a session not known to be the one that made the
    // call, is the reader's call, whatever the agent's access.
    const sameSession =
      record.providerThreadId !== null && record.providerThreadId === session.providerThreadId;
    const needsConfirmation = !runsWithoutAsking(thread) || ui === undefined || !sameSession;
    if (needsConfirmation && !input.confirmed) {
      return yield* fail("needs-confirmation", `Allow the app to run ${input.tool}?`);
    }
    const call = session.adapter.callMcpTool;
    if (call === undefined) {
      return yield* fail("unsupported", "This agent can't run an MCP app's tool calls.");
    }
    return yield* call(session.sessionKey, {
      server,
      tool: input.tool,
      arguments: input.arguments ?? {},
    }).pipe(Effect.catch((cause) => fail("failed", `${input.tool} failed.`, cause)));
  });

  return { recordCall, load, callTool } satisfies McpAppsShape;
});

export const layer = Layer.effect(McpApps, make);
