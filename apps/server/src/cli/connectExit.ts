/**
 * How the `threadlines` command ends (docs/design/outside-agents.md, "Exit
 * codes"). A command prints its own message, then fails with CommandExit;
 * runMain exits with its code and prints nothing more.
 */
import * as Data from "effect/Data";
import * as Runtime from "effect/Runtime";

export const EXIT = {
  /** The call worked, or the thread's newest turn completed. */
  done: 0,
  /** The newest turn was stopped or ended in an error, the thread failed, or the call failed. */
  failed: 1,
  /** The thread needs the user: an approval, a question or a plan. */
  needsUser: 2,
  /** `--timeout` ran out. */
  timedOut: 3,
  /** Threadlines refused the call. */
  refused: 4,
  /** Not connected, or Threadlines isn't running. */
  notConnected: 5,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CommandExit extends Data.TaggedError("CommandExit")<{ readonly code: ExitCode }> {
  override get [Runtime.errorExitCode](): number {
    return this.code;
  }
  override readonly [Runtime.errorReported] = false;
}

/** Why a call never got an answer from Threadlines. */
export class ConnectError extends Data.TaggedError("ConnectError")<{
  /**
   * `not_running`: nothing answered, or not a Threadlines that takes agents.
   * `signed_out`: the sign-in is gone (a 401); sign in again.
   * `failed`: anything else; `message` says what.
   */
  readonly reason: "not_running" | "signed_out" | "failed";
  readonly message: string;
}> {}

export const NOT_RUNNING_MESSAGE = "Threadlines isn't running. Open it and try again.";
export const SIGNED_OUT_MESSAGE = "This command isn't connected. Run threadlines connect.";

export const exitCodeForConnectError = (error: ConnectError): ExitCode =>
  error.reason === "failed" ? EXIT.failed : EXIT.notConnected;
