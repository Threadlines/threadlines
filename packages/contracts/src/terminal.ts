import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DEFAULT_TERMINAL_ID = "default";
/** At most this many tabs are offered for a command to go into (`TerminalReuseIds`). */
export const MAX_TERMINAL_REUSE_IDS = 64;

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const TerminalColsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(1000),
);
const TerminalRowsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(500),
);
const TerminalIdSchema = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(128));
const TERMINAL_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TerminalEnvValueSchema = Schema.String.check(Schema.isMaxLength(8_192));
// Schema.Record silently drops keys that fail the key schema (effect
// 4.0.0-beta.97), but this is a validation boundary: a request with a
// malformed env key must be rejected, not quietly stripped.
const TerminalEnvSchema = Schema.Record(Schema.String, TerminalEnvValueSchema)
  .check(Schema.isMaxProperties(128))
  .check(
    Schema.makeFilter((env: Readonly<Record<string, string>>) =>
      Object.keys(env).every((key) => TERMINAL_ENV_KEY_PATTERN.test(key) && key.length <= 128),
    ),
  );

const TerminalIdWithDefaultSchema = TerminalIdSchema.pipe(
  Schema.withDecodingDefault(Effect.succeed(DEFAULT_TERMINAL_ID)),
);

/**
 * Tabs a command may go into instead of opening a new one, in the order the
 * drawer lists them: the first free one (nothing typed in it, nothing running)
 * is used (docs/terminal-command-runs.md).
 */
export const TerminalReuseIds = Schema.Array(TerminalIdSchema).check(
  Schema.isMaxLength(MAX_TERMINAL_REUSE_IDS),
);

export const TerminalThreadInput = Schema.Struct({
  threadId: TrimmedNonEmptyStringSchema,
});
export type TerminalThreadInput = typeof TerminalThreadInput.Type;

const TerminalSessionInput = Schema.Struct({
  ...TerminalThreadInput.fields,
  terminalId: TerminalIdWithDefaultSchema,
});
export type TerminalSessionInput = Schema.Codec.Encoded<typeof TerminalSessionInput>;

export const TerminalOpenInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: TrimmedNonEmptyStringSchema,
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: Schema.optional(TerminalColsSchema),
  rows: Schema.optional(TerminalRowsSchema),
  env: Schema.optional(TerminalEnvSchema),
  /**
   * For a caller about to type a script: open the first of these tabs that is
   * free and in this folder and environment, instead of `terminalId`. The tab
   * it returns is held for that script (a write with `origin: "script"`).
   */
  reuseTerminalIds: Schema.optional(TerminalReuseIds),
  /**
   * Show a tab that already exists instead of making one: fails with
   * `TerminalSessionLookupError` when the thread has no such tab, returns an
   * exited shell as it is (the user restarts it), and starts the shell of a
   * listed tab that has none (after the server restarted). Old servers ignore
   * it and open as before.
   */
  attach: Schema.optional(Schema.Boolean),
});
export type TerminalOpenInput = Schema.Codec.Encoded<typeof TerminalOpenInput>;

export const TerminalWriteInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  data: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
  /**
   * `script`: a command Threadlines types for the user (a project script), not
   * their keys. Once it finishes, the tab is free for the next command again.
   */
  origin: Schema.optional(Schema.Literal("script")),
});
export type TerminalWriteInput = Schema.Codec.Encoded<typeof TerminalWriteInput>;

export const TerminalResizeInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
  /**
   * The person is using the tab on this device (they focused it or typed in
   * it): its size wins, and only this device answers the terminal's queries
   * until another device claims the tab. Unclaimed resizes from other devices
   * are ignored while one holds it.
   */
  claim: Schema.optional(Schema.Boolean),
});
export type TerminalResizeInput = Schema.Codec.Encoded<typeof TerminalResizeInput>;

export const TerminalClearInput = TerminalSessionInput;
export type TerminalClearInput = Schema.Codec.Encoded<typeof TerminalClearInput>;

/**
 * Settle the command a restart stopped in a tab (`TerminalTab.interruptedCommand`):
 * run it again in the tab's shell, or forget it. Running it fails with
 * `TerminalLineBusyError` while something is typed or running there.
 */
export const TerminalResolveInterruptedInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  run: Schema.Boolean,
});
export type TerminalResolveInterruptedInput = Schema.Codec.Encoded<
  typeof TerminalResolveInterruptedInput
>;

export const TerminalRestartInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  cwd: TrimmedNonEmptyStringSchema,
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  cols: TerminalColsSchema,
  rows: TerminalRowsSchema,
  env: Schema.optional(TerminalEnvSchema),
});
export type TerminalRestartInput = Schema.Codec.Encoded<typeof TerminalRestartInput>;

export const TerminalCloseInput = Schema.Struct({
  ...TerminalThreadInput.fields,
  terminalId: Schema.optional(TerminalIdSchema),
  deleteHistory: Schema.optional(Schema.Boolean),
});
export type TerminalCloseInput = typeof TerminalCloseInput.Type;

export const TerminalSessionStatus = Schema.Literals(["starting", "running", "exited", "error"]);
export type TerminalSessionStatus = typeof TerminalSessionStatus.Type;

export const TerminalSessionSnapshot = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  cwd: Schema.String.check(Schema.isNonEmpty()),
  worktreePath: Schema.NullOr(TrimmedNonEmptyStringSchema),
  status: TerminalSessionStatus,
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  history: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  updatedAt: Schema.String,
});
export type TerminalSessionSnapshot = typeof TerminalSessionSnapshot.Type;

const TerminalEventBaseSchema = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  createdAt: Schema.String,
});

const TerminalStartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("started"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalOutputEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("output"),
  data: Schema.String,
});

const TerminalExitedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("exited"),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
});

const TerminalErrorEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("error"),
  message: Schema.String.check(Schema.isNonEmpty()),
});

const TerminalClearedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("cleared"),
});

const TerminalRestartedEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("restarted"),
  snapshot: TerminalSessionSnapshot,
});

const TerminalActivityEvent = Schema.Struct({
  ...TerminalEventBaseSchema.fields,
  type: Schema.Literal("activity"),
  hasRunningSubprocess: Schema.Boolean,
  command: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  /** When the running subprocess was first seen; absent from older servers. */
  startedAt: Schema.optional(Schema.NullOr(Schema.String)),
  /**
   * A command was entered at the prompt and the server hasn't yet seen it
   * start or finish: treat the tab as busy before stopping it.
   */
  commandPending: Schema.optional(Schema.Boolean),
});

export const TerminalEvent = Schema.Union([
  TerminalStartedEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent,
]);
export type TerminalEvent = typeof TerminalEvent.Type;

/**
 * Who listens on a port a tab's command found taken: a terminal tab of this
 * server (perhaps the same one), a process an agent started, Threadlines
 * itself, or another program. `name` is the listening program's file name
 * and `command` its job as typed ("npm run dev"), when known.
 */
export const TerminalPortHolder = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("terminal"),
    threadId: Schema.String.check(Schema.isNonEmpty()),
    terminalId: Schema.String.check(Schema.isNonEmpty()),
    pid: Schema.Int,
    name: Schema.NullOr(Schema.String),
    command: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    pid: Schema.Int,
    name: Schema.NullOr(Schema.String),
    command: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("threadlines"),
    pid: Schema.Int,
  }),
  Schema.Struct({
    kind: Schema.Literal("process"),
    pid: Schema.Int,
    name: Schema.NullOr(Schema.String),
    command: Schema.NullOr(Schema.String),
  }),
]);
export type TerminalPortHolder = typeof TerminalPortHolder.Type;

/**
 * A port a tab's command said is taken, and who holds it now
 * (`TerminalTab.portInUse`). `id` changes whenever the holders do, so a
 * click on what a device showed never acts on something else.
 */
export const TerminalPortInUse = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty()),
  port: Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(65_535)),
  /** Everyone listening on it (one per address family at most), a terminal tab first. */
  holders: Schema.Array(TerminalPortHolder).check(Schema.isMinLength(1)),
  /** One job of one other tab holds it all, so Stop can interrupt that job. */
  canStop: Schema.Boolean,
  /** When the command said so. */
  seenAt: Schema.String,
});
export type TerminalPortInUse = typeof TerminalPortInUse.Type;

/**
 * Settle a tab's `portInUse` notice `noticeId`: stop the job holding the
 * port (as Ctrl+C would, in the tab running it), or dismiss the notice. Does
 * nothing once the tab shows another notice or none. Stopping fails with
 * `TerminalPortStillInUseError` when the port is still taken a few seconds
 * later.
 */
export const TerminalResolvePortInUseInput = Schema.Struct({
  ...TerminalSessionInput.fields,
  noticeId: Schema.String.check(Schema.isNonEmpty()),
  stop: Schema.Boolean,
});
export type TerminalResolvePortInUseInput = Schema.Codec.Encoded<
  typeof TerminalResolvePortInUseInput
>;

/** Whether a tab's shell runs; `stopped` is a listed tab with none (the server restarted). */
export const TerminalTabStatus = Schema.Literals([
  "starting",
  "running",
  "exited",
  "error",
  "stopped",
]);
export type TerminalTabStatus = typeof TerminalTabStatus.Type;

/**
 * A terminal tab of a thread as the server keeps it, the same for every
 * device. `number` names it ("Terminal 2") and never changes while it exists.
 */
export const TerminalTab = Schema.Struct({
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  /** The folder its shell started in. */
  cwd: Schema.NullOr(Schema.String),
  status: TerminalTabStatus,
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  createdAt: Schema.String,
  /**
   * The command line typed at the prompt that was still running when the
   * server last stopped (an update, a crash, a quit), so it can be run again.
   * Kept until a line is entered in the tab or it is dismissed. Absent from
   * older servers.
   */
  interruptedCommand: Schema.optional(Schema.NullOr(Schema.String)),
  /**
   * A port the tab's last command said is taken, while something still
   * listens on it. Gone once a line is entered in the tab, the shell ends or
   * restarts, the port is free, or it is dismissed. Absent from older servers.
   */
  portInUse: Schema.optional(Schema.NullOr(TerminalPortInUse)),
});
export type TerminalTab = typeof TerminalTab.Type;

export const TerminalThreadTabs = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  tabs: Schema.Array(TerminalTab),
});
export type TerminalThreadTabs = typeof TerminalThreadTabs.Type;

/**
 * What a subscription gets. Without a mode it is the legacy stream: every
 * event of every terminal (old clients). `metadata` leaves out output and
 * the history in snapshots, and starts with the tab list of every thread.
 * `thread` is everything for one thread, starting with `subscribed`.
 */
export const TerminalSubscribeInput = Schema.Struct({
  mode: Schema.optional(Schema.Literals(["metadata", "thread"])),
  threadId: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TerminalSubscribeInput = typeof TerminalSubscribeInput.Type;

/** First on a `metadata` stream: every thread's tabs. */
const TerminalCatalogEvent = Schema.Struct({
  type: Schema.Literal("catalog"),
  createdAt: Schema.String,
  threads: Schema.Array(TerminalThreadTabs),
});

/** A thread's tabs changed (opened, closed, started, exited). */
const TerminalTabsEvent = Schema.Struct({
  type: Schema.Literal("tabs"),
  threadId: Schema.String.check(Schema.isNonEmpty()),
  createdAt: Schema.String,
  tabs: Schema.Array(TerminalTab),
});

/**
 * First on a `thread` stream, once nothing the thread's terminals print can
 * be missed: open tabs after it, and again after every new one (a reconnect).
 */
const TerminalSubscribedEvent = Schema.Struct({
  type: Schema.Literal("subscribed"),
  threadId: Schema.String.check(Schema.isNonEmpty()),
  createdAt: Schema.String,
});

/**
 * A `thread` stream fell behind and dropped output: open its tabs again to
 * draw them from the server's copy.
 */
const TerminalResyncEvent = Schema.Struct({
  type: Schema.Literal("resync"),
  threadId: Schema.String.check(Schema.isNonEmpty()),
  createdAt: Schema.String,
});

export const TerminalStreamEvent = Schema.Union([
  TerminalStartedEvent,
  TerminalOutputEvent,
  TerminalExitedEvent,
  TerminalErrorEvent,
  TerminalClearedEvent,
  TerminalRestartedEvent,
  TerminalActivityEvent,
  TerminalCatalogEvent,
  TerminalTabsEvent,
  TerminalSubscribedEvent,
  TerminalResyncEvent,
]);
export type TerminalStreamEvent = typeof TerminalStreamEvent.Type;

export class TerminalCwdError extends Schema.TaggedError<TerminalCwdError>()("TerminalCwdError", {
  cwd: Schema.String,
  reason: Schema.Literals(["notFound", "notDirectory", "statFailed"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    if (this.reason === "notDirectory") {
      return `Terminal cwd is not a directory: ${this.cwd}`;
    }
    if (this.reason === "notFound") {
      return `Terminal cwd does not exist: ${this.cwd}`;
    }
    const causeMessage =
      this.cause !== undefined &&
      this.cause !== null &&
      typeof this.cause === "object" &&
      "message" in this.cause
        ? this.cause.message
        : undefined;
    return typeof causeMessage === "string" && causeMessage.length > 0
      ? `Failed to access terminal cwd: ${this.cwd} (${causeMessage})`
      : `Failed to access terminal cwd: ${this.cwd}`;
  }
}

export class TerminalHistoryError extends Schema.TaggedError<TerminalHistoryError>()(
  "TerminalHistoryError",
  {
    operation: Schema.Literals(["read", "truncate", "migrate"]),
    threadId: Schema.String,
    terminalId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Failed to ${this.operation} terminal history for thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalSessionLookupError extends Schema.TaggedError<TerminalSessionLookupError>()(
  "TerminalSessionLookupError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `Unknown terminal thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class TerminalNotRunningError extends Schema.TaggedError<TerminalNotRunningError>()(
  "TerminalNotRunningError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `Terminal is not running for thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

/** The tab's shell is busy with something typed or running, so nothing is typed into it. */
export class TerminalLineBusyError extends Schema.TaggedError<TerminalLineBusyError>()(
  "TerminalLineBusyError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
    reason: Schema.Literals(["typing", "running"]),
  },
) {
  override get message() {
    return this.reason === "typing"
      ? "Clear what's typed in the terminal first."
      : "Something is still running in the terminal.";
  }
}

/**
 * Stop left a tab's port taken: the job kept listening (`stillListening`),
 * or what holds the port couldn't be checked, so nothing was stopped
 * (`unverified`).
 */
export class TerminalPortStillInUseError extends Schema.TaggedError<TerminalPortStillInUseError>()(
  "TerminalPortStillInUseError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
    port: Schema.Int,
    reason: Schema.Literals(["stillListening", "unverified"]),
  },
) {
  override get message() {
    return this.reason === "unverified"
      ? `Couldn't check what holds port ${this.port}, so nothing was stopped.`
      : `Port ${this.port} is still in use.`;
  }
}

export const TerminalError = Schema.Union([
  TerminalCwdError,
  TerminalHistoryError,
  TerminalSessionLookupError,
  TerminalNotRunningError,
  TerminalLineBusyError,
  TerminalPortStillInUseError,
]);
export type TerminalError = typeof TerminalError.Type;
