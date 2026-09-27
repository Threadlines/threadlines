import { planCliSpawn } from "../cliSpawn.ts";

/**
 * Shared argv for spawning `codex app-server`.
 *
 * `default_mode_request_user_input` is an upstream feature flag (off by
 * default) that exposes the `request_user_input` tool outside Plan mode, so
 * Codex can ask structured questions during build turns.
 * `apply_patch_streaming_events` (also off by default) streams
 * `item/fileChange/patchUpdated` notifications while the model is still
 * generating an apply_patch call, which drives the live +/- badge on
 * in-flight edit rows. Both are passed as `-c` config overrides rather than
 * `--enable` so codex versions that do not know a feature ignore it instead
 * of failing to start.
 *
 * Threadlines opts into these features deliberately, so suppress the generic
 * unstable-feature warning Codex otherwise emits when each thread starts.
 * Codex 0.145.0 does not expose a supported session-source override for
 * app-server, so external-history de-duplication uses native thread IDs.
 */
export const CODEX_APP_SERVER_ARGS: ReadonlyArray<string> = [
  "app-server",
  "-c",
  "features.default_mode_request_user_input=true",
  "-c",
  "features.apply_patch_streaming_events=true",
  "-c",
  "suppress_unstable_features_warning=true",
];

/**
 * Argv for a room's side-answer app server: no browser tools, no questions
 * to the user, no hooks or app connectors, no memories, read-only with no
 * approvals. Its home holds the same values in config.toml (see
 * codexSideAnswerHome.ts); both are set so neither alone has to be trusted.
 */
export const CODEX_SIDE_ANSWER_APP_SERVER_ARGS: ReadonlyArray<string> = [
  "app-server",
  "-c",
  "features.default_mode_request_user_input=false",
  "-c",
  "features.apply_patch_streaming_events=true",
  "-c",
  "features.hooks=false",
  "-c",
  "features.apps=false",
  "-c",
  "features.memories=false",
  "-c",
  "memories.generate_memories=false",
  "-c",
  "memories.use_memories=false",
  "-c",
  'sandbox_mode="read-only"',
  "-c",
  'approval_policy="never"',
  "-c",
  "suppress_unstable_features_warning=true",
];

/** The env var the spawned app server reads its MCP credential from. */
export const CODEX_BROWSER_TOKEN_ENV_VAR = "THREADLINES_MCP_BEARER_TOKEN";

/**
 * How long Codex waits on one room tool call. An ask or review waits up to
 * ten minutes for its answer (Codex's own default is 60s), so a little more
 * than that, and the Threadlines deadline always answers first.
 */
export const CODEX_ROOM_TOOL_TIMEOUT_SEC = 660;

/** An MCP server over streamable HTTP, its credential from the environment. */
const httpMcpServerArgs = (serverName: string, url: string): ReadonlyArray<string> => [
  "-c",
  `mcp_servers.${serverName}.url=${url}`,
  "-c",
  `mcp_servers.${serverName}.bearer_token_env_var="${CODEX_BROWSER_TOKEN_ENV_VAR}"`,
];

export interface CodexRoomServer {
  readonly url: string;
  readonly serverName: string;
  /** Only these tools are listed. Absent: every room tool. */
  readonly tools?: ReadonlyArray<string>;
}

/**
 * The room tools (McpRoomServer). They never ask for approval: whether an
 * agent may make a request is the decider's call, and a prompt would put a
 * question to the user in the middle of someone else's work.
 */
function codexRoomServerArgs(room: CodexRoomServer): ReadonlyArray<string> {
  return [
    ...httpMcpServerArgs(room.serverName, room.url),
    "-c",
    `mcp_servers.${room.serverName}.tool_timeout_sec=${CODEX_ROOM_TOOL_TIMEOUT_SEC}`,
    "-c",
    `mcp_servers.${room.serverName}.default_tools_approval_mode="approve"`,
    ...(room.tools !== undefined
      ? ["-c", `mcp_servers.${room.serverName}.enabled_tools=${JSON.stringify(room.tools)}`]
      : []),
  ];
}

/**
 * Argv for one thread's app server, including the browser tools and, in a
 * room, the room tools.
 *
 * MCP servers are read when the app server starts, the same as plugins, so a
 * `thread/start` config overlay naming one arrives far too late -- the thread
 * begins with no such server and the model is told the browser is unavailable.
 * We spawn one app server per thread, so the server can be named here, where it
 * is early enough to matter.
 *
 * The credential goes through the environment rather than into argv, because
 * argv is readable by anything that can run `ps`. Both servers take the same
 * one: it is this runtime's credential, and it says what it may reach.
 */
export function codexAppServerArgs(servers?: {
  readonly browser?: { readonly url: string; readonly serverName: string };
  readonly room?: CodexRoomServer;
}): ReadonlyArray<string> {
  return [
    ...CODEX_APP_SERVER_ARGS,
    ...(servers?.browser !== undefined
      ? httpMcpServerArgs(servers.browser.serverName, servers.browser.url)
      : []),
    ...(servers?.room !== undefined ? codexRoomServerArgs(servers.room) : []),
  ];
}

/**
 * Argv for a side answer's app server. With the room endpoint it is listed
 * only the read tools its kind allows. A review loads no project instruction
 * files (`project_doc_max_bytes = 0`): it gets its request and the captured
 * diff, nothing else.
 */
export function codexSideAnswerAppServerArgs(input: {
  readonly kind: "ask" | "review";
  readonly room?: CodexRoomServer & { readonly tools: ReadonlyArray<string> };
}): ReadonlyArray<string> {
  return [
    ...CODEX_SIDE_ANSWER_APP_SERVER_ARGS,
    ...(input.kind === "review" ? ["-c", "project_doc_max_bytes=0"] : []),
    ...(input.room !== undefined ? codexRoomServerArgs(input.room) : []),
  ];
}

/**
 * Spawn fields for `CodexClient.layerCommand`, planned so argv survives every
 * platform: native executables spawn shell-less; Windows batch shims get a
 * pre-quoted single-string command line with `shell` set.
 */
export function codexAppServerCommandOptions(
  binaryPath: string,
  env?: NodeJS.ProcessEnv,
): { command: string; args: ReadonlyArray<string>; shell?: boolean } {
  const plan = planCliSpawn(binaryPath, CODEX_APP_SERVER_ARGS, { ...process.env, ...env });
  return { command: plan.command, args: plan.args, ...plan.options };
}
