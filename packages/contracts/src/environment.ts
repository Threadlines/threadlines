import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ExecutionEnvironmentPlatformOs = Schema.Literals([
  "darwin",
  "linux",
  "windows",
  "unknown",
]);
export type ExecutionEnvironmentPlatformOs = typeof ExecutionEnvironmentPlatformOs.Type;

export const ExecutionEnvironmentPlatformArch = Schema.Literals(["arm64", "x64", "other"]);
export type ExecutionEnvironmentPlatformArch = typeof ExecutionEnvironmentPlatformArch.Type;

export const ExecutionEnvironmentPlatform = Schema.Struct({
  os: ExecutionEnvironmentPlatformOs,
  arch: ExecutionEnvironmentPlatformArch,
});
export type ExecutionEnvironmentPlatform = typeof ExecutionEnvironmentPlatform.Type;

export const ExecutionEnvironmentCapabilities = Schema.Struct({
  repositoryIdentity: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Older servers omit the key; clients read an absent value as unsupported. */
  pullRequests: Schema.optionalKey(Schema.Boolean),
  /**
   * The server lets a browser request wait for the user's answer (see
   * `PreviewAutomationProgressSchema`). Absent on older servers, whose clients
   * refuse an unapproved site straight away instead.
   */
  browserApprovalWait: Schema.optionalKey(Schema.Boolean),
  /**
   * The server routes browser requests to one client-wide host per client
   * (`PreviewAutomationClientHostSchema`), so a thread's browser works while
   * nobody is looking at it. Older servers only reach the thread on screen.
   */
  browserClientHosts: Schema.optionalKey(Schema.Boolean),
  /**
   * The server labels a browser screenshot with the image type the client
   * says it is (`PreviewAutomationScreenshotSchema.mimeType`). Older servers
   * call every screenshot a PNG, so clients send them nothing else.
   */
  browserScreenshotTypes: Schema.optionalKey(Schema.Boolean),
  /**
   * The server carries a client's browser traffic for `localhost` to its own
   * loopback (`previewTunnel.ts`), lists the web servers on its machine, and
   * sends a thread's browser to the computer the user is using. Older servers
   * keep it on their own machine, where `localhost` is the agent's.
   */
  browserLoopbackTunnel: Schema.optionalKey(Schema.Boolean),
  /**
   * The server runs suggested shell commands from the chat
   * (`commandRuns.start`). Older servers omit it; clients then show no run
   * buttons.
   */
  commandRuns: Schema.optionalKey(Schema.Boolean),
  /**
   * The server follows a command put in the terminal past the user's Enter
   * to its end, and a request card's output then goes back to its agent by
   * itself (docs/terminal-command-runs.md). Older servers stop at Enter, and
   * the user sends it.
   */
  followsInsertedCommands: Schema.optionalKey(Schema.Boolean),
  /**
   * The server links to other computers' servers and runs agents' threads on
   * them (`links.*`, docs/design/fleet.md). Older servers omit it; clients
   * then hide link UI for them.
   */
  computerLinks: Schema.optionalKey(Schema.Boolean),
  /** The server runs scheduled tasks. Absent until a server ships them. */
  scheduledTasks: Schema.optionalKey(Schema.Boolean),
  /** The server moves threads to linked computers. Absent until a server ships it. */
  threadMove: Schema.optionalKey(Schema.Boolean),
  /** The server sets up projects copied from another computer (`projectSetups.*`). */
  projectSetup: Schema.optionalKey(Schema.Boolean),
  /** The server reports when it froze (`subscribeServerStalls`). */
  stallReports: Schema.optionalKey(Schema.Boolean),
  /**
   * The server sends what it last heard from the host about each pull request
   * (`pullRequests.subscribeObservations`). Older servers omit it; clients
   * then go by each surface's own reads.
   */
  pullRequestObservations: Schema.optionalKey(Schema.Boolean),
  /**
   * The server runs event tasks: scheduled tasks started by a webhook
   * (docs/design/event-tasks.md). Without it, clients offer clock tasks only.
   */
  eventTasks: Schema.optionalKey(Schema.Boolean),
  /** Takes phone alert registrations (`push.register`, `presence.setViewing`). */
  pushAlerts: Schema.optionalKey(Schema.Boolean),
  /**
   * The server keeps each thread's terminal tabs and streams their output per
   * thread (`TerminalSubscribeInput`, docs/terminal.md). Older servers omit
   * it and send every terminal event on one stream.
   */
  terminalTabLists: Schema.optionalKey(Schema.Boolean),
  /**
   * The server takes the address a terminal sign-in's page ended on in a
   * browser elsewhere and replays it itself (`ProviderAuthWriteInput.redirect`).
   * Older servers omit it and would type the address into the command.
   */
  signInAddressReplay: Schema.optionalKey(Schema.Boolean),
  /**
   * Agents outside Threadlines can sign in to this server's `/mcp/connect`
   * (`outsideAgents.*`, docs/design/outside-agents.md). Older servers omit
   * it; clients then hide Settings' Agents group for them.
   */
  outsideAgents: Schema.optionalKey(Schema.Boolean),
});
export type ExecutionEnvironmentCapabilities = typeof ExecutionEnvironmentCapabilities.Type;

export const ExecutionEnvironmentDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  serverVersion: TrimmedNonEmptyString,
  capabilities: ExecutionEnvironmentCapabilities,
});
export type ExecutionEnvironmentDescriptor = typeof ExecutionEnvironmentDescriptor.Type;

export const EnvironmentConnectionState = Schema.Literals([
  "connecting",
  "connected",
  "disconnected",
  "error",
]);
export type EnvironmentConnectionState = typeof EnvironmentConnectionState.Type;

export const RepositoryIdentityLocator = Schema.Struct({
  source: Schema.Literal("git-remote"),
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
});
export type RepositoryIdentityLocator = typeof RepositoryIdentityLocator.Type;

export const RepositoryIdentity = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  locator: RepositoryIdentityLocator,
  rootPath: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  provider: Schema.optionalKey(TrimmedNonEmptyString),
  owner: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RepositoryIdentity = typeof RepositoryIdentity.Type;

export const ScopedProjectRef = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
});
export type ScopedProjectRef = typeof ScopedProjectRef.Type;

export const ScopedThreadRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ScopedThreadRef = typeof ScopedThreadRef.Type;

export const ScopedThreadSessionRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ScopedThreadSessionRef = typeof ScopedThreadSessionRef.Type;
