/**
 * TerminalManager - Terminal session orchestration service interface.
 *
 * Owns terminal lifecycle operations, output fanout, and session state
 * transitions for thread-scoped terminals.
 *
 * @module TerminalManager
 */
import {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalCwdError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalSessionLookupError,
  TerminalSessionStatus,
  TerminalWriteInput,
} from "@threadlines/contracts";
import type { TerminalCommandInputState } from "@threadlines/shared/terminalCommandTracker";
import type { PtyProcess } from "./PTY.ts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

export {
  TerminalCwdError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalSessionLookupError,
};

export interface TerminalSessionState {
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  pid: number | null;
  history: string;
  pendingHistoryControlSequence: string;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  cols: number;
  rows: number;
  process: PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  runningSubprocessCommand: string | null;
  submittedCommand: string | null;
  subprocessPollingArmed: boolean;
  consecutiveSubprocessIdlePolls: number;
  commandCompletionMarkersEnabled: boolean;
  terminalCommandInputState: TerminalCommandInputState;
  runtimeEnv: Record<string, string> | null;
}

export interface ShellCandidate {
  shell: string;
  args?: string[];
}

export interface TerminalStartInput extends TerminalOpenInput {
  cols: number;
  rows: number;
}

/** Why a suggested command could not start in a new terminal tab. */
export class TerminalCommandRunError extends Schema.TaggedError<TerminalCommandRunError>()(
  "TerminalCommandRunError",
  {
    message: Schema.String,
  },
) {}

/**
 * A suggested command for a new terminal tab (docs/terminal-command-runs.md).
 * `run` spawns it as its own tracked process; `insert` types it at the prompt
 * of a fresh shell and leaves Enter to the user.
 */
export interface TerminalCommandRunInput {
  readonly threadId: string;
  readonly terminalId: string;
  readonly runId: string;
  readonly mode: "run" | "insert";
  readonly dialect: "posix" | "powershell";
  readonly command: string;
  readonly cwd: string;
  readonly worktreePath?: string | null;
  readonly env?: Record<string, string>;
  readonly cols?: number;
  readonly rows?: number;
}

/**
 * How a run moved on. `output` is the rendered text (redraws collapsed, end
 * kept) a `run` left when it stopped.
 */
export type TerminalCommandRunUpdate =
  | { readonly type: "running"; readonly runId: string; readonly at: string }
  | { readonly type: "waiting"; readonly runId: string; readonly at: string }
  | { readonly type: "submitted"; readonly runId: string; readonly at: string }
  | { readonly type: "cancelled"; readonly runId: string; readonly at: string }
  | {
      readonly type: "finished";
      readonly runId: string;
      readonly at: string;
      /** When its process started; the "running" update may come after this one. */
      readonly startedAt: string | null;
      readonly exitCode: number | null;
      readonly output: string;
    }
  | {
      readonly type: "interrupted";
      readonly runId: string;
      readonly at: string;
      readonly startedAt: string | null;
      readonly output: string | null;
    }
  | {
      readonly type: "failed";
      readonly runId: string;
      readonly at: string;
      readonly error: string;
    };

/**
 * TerminalManagerShape - Service API for terminal session lifecycle operations.
 */
export interface TerminalManagerShape {
  /**
   * Open or attach to a terminal session.
   *
   * Reuses an existing session for the same thread/terminal id and restores
   * persisted history on first open.
   */
  readonly open: (
    input: TerminalOpenInput,
  ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

  /**
   * Write input bytes to a terminal session.
   */
  readonly write: (input: TerminalWriteInput) => Effect.Effect<void, TerminalError>;

  /**
   * Resize the PTY backing a terminal session.
   */
  readonly resize: (input: TerminalResizeInput) => Effect.Effect<void, TerminalError>;

  /**
   * Clear terminal output history.
   */
  readonly clear: (input: TerminalClearInput) => Effect.Effect<void, TerminalError>;

  /**
   * Restart a terminal session in place.
   *
   * Always resets history before spawning the new process.
   */
  readonly restart: (
    input: TerminalRestartInput,
  ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

  /**
   * Close an active terminal session.
   *
   * When `terminalId` is omitted, closes all sessions for the thread.
   */
  readonly close: (input: TerminalCloseInput) => Effect.Effect<void, TerminalError>;

  /**
   * Subscribe to terminal runtime events with a direct callback.
   *
   * Replays the manager's current per-terminal activity state before live
   * events so reconnecting clients can reconstruct running indicators.
   *
   * Returns an unsubscribe function.
   */
  readonly subscribe: (
    listener: (event: TerminalEvent) => Effect.Effect<void>,
  ) => Effect.Effect<() => void>;

  /**
   * Open a new terminal tab for a suggested command. Returns once the shell is
   * spawned; how the run goes arrives through `subscribeCommandRuns`. Fails
   * when the tab id is taken or the shell can't run commands this way.
   */
  readonly startCommandRun: (
    input: TerminalCommandRunInput,
  ) => Effect.Effect<void, TerminalCommandRunError | TerminalCwdError>;

  /**
   * The output a run has so far, while its tab is open: a `run` still going,
   * or everything an `insert`'s tab printed since the command went in.
   * Null once the tab is gone.
   */
  readonly readCommandRunOutput: (runId: string) => Effect.Effect<string | null>;

  /** Subscribe to run updates. Returns an unsubscribe function. */
  readonly subscribeCommandRuns: (
    listener: (update: TerminalCommandRunUpdate) => Effect.Effect<void>,
  ) => Effect.Effect<() => void>;
}

/**
 * TerminalManager - Service tag for terminal session orchestration.
 */
export class TerminalManager extends Context.Service<TerminalManager, TerminalManagerShape>()(
  "threadlines/terminal/Services/Manager/TerminalManager",
) {}
