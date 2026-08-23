/**
 * DesktopStartupFailurePrompt - the visible end of a failed startup.
 *
 * When the backend cannot start, the desktop shell has no window to show, so
 * without this dialog the app sits in Task Manager doing nothing the user can
 * see. The prompt offers the three exits a stuck user needs: try again, look
 * at the logs, or quit cleanly so the single-instance lock is released. The
 * anonymous crash report is sent concurrently (bounded, best effort), and any
 * defect in the dialog itself falls back to a plain error box plus quit —
 * this path must never fail back into invisibility.
 */

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopCrashReport from "../app/DesktopCrashReport.ts";
import type { DesktopDatabaseRecoveryResult } from "../backend/DesktopDatabaseRecovery.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const CRASH_REPORT_TIMEOUT = Duration.seconds(3);
const DETAIL_REASON_MAX_CHARS = 300;

const TRY_AGAIN_BUTTON_INDEX = 0;
const OPEN_LOGS_BUTTON_INDEX = 1;
const QUIT_BUTTON_INDEX = 2;
const OPEN_RECOVERY_FOLDER_BUTTON_INDEX = 1;

export type DesktopStartupFailureAction = "retry" | "quit";

export interface DesktopStartupFailurePromptShape {
  /**
   * Reports the failure, shows the dialog until the user picks a way out, and
   * quits the app itself when they choose to. "retry" asks the caller to
   * reset its failure budget and start the backend again. Never fails.
   */
  readonly handle: (
    report: DesktopCrashReport.DesktopStartupFailureReport,
  ) => Effect.Effect<DesktopStartupFailureAction>;
  /** Shows where the damaged database was preserved after startup recovers. */
  readonly notifyDatabaseRecovery: (result: DesktopDatabaseRecoveryResult) => Effect.Effect<void>;
}

export class DesktopStartupFailurePrompt extends Context.Service<
  DesktopStartupFailurePrompt,
  DesktopStartupFailurePromptShape
>()("threadlines/desktop/StartupFailurePrompt") {}

function extractStartupFailureCause(outputTail: string): string | undefined {
  const normalized = outputTail.replaceAll("\u001b", "").replace(/\[[0-9;]*m/g, "");
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines.toReversed()) {
    const causeMatch = line.match(/\[cause\]:\s*(?:[\w./-]*Error:\s*)?(.+)/i);
    const cause = causeMatch?.[1]?.trim();
    if (cause) return cause;
  }

  for (const line of lines.toReversed()) {
    const errorMatch = line.match(/(?:^|\s)[\w./-]*Error:\s*(.+)$/i);
    const error = errorMatch?.[1]?.trim();
    if (error) return error;
  }

  return undefined;
}

export function describeStartupFailure(input: {
  readonly displayName: string;
  readonly report: DesktopCrashReport.DesktopStartupFailureReport;
  readonly logDir: string;
  readonly homeDirectory: string;
}): { readonly message: string; readonly detail: string } {
  const { displayName, report, logDir, homeDirectory } = input;
  const attemptsText = report.attempts === 1 ? "1 attempt" : `${report.attempts} attempts`;
  const kindText =
    report.failureKind === "readiness-timeout"
      ? `The ${displayName} background service started but never responded.`
      : `The ${displayName} background service stopped unexpectedly while starting (${attemptsText}).`;
  const sanitize = (text: string) =>
    DesktopCrashReport.redactSecrets(DesktopCrashReport.scrubUserPaths(text, homeDirectory));
  const reason = sanitize(
    extractStartupFailureCause(report.outputTail) ?? report.lastReason,
  ).trim();
  const exitCodeText = Option.match(report.lastExitCode, {
    onNone: () => "",
    onSome: (exitCode) => ` (exit code ${exitCode})`,
  });
  const reasonText =
    reason.length === 0
      ? ""
      : `\n\nLast error: ${
          reason.length <= DETAIL_REASON_MAX_CHARS
            ? reason
            : `${reason.slice(0, DETAIL_REASON_MAX_CHARS)}…`
        }${exitCodeText}`;
  return {
    message: `${displayName} couldn't start`,
    detail: `${kindText} You can try again, or open the logs folder to see what happened.${reasonText}\n\nLogs: ${logDir}`,
  };
}

const makeDesktopStartupFailurePrompt = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const electronShell = yield* ElectronShell.ElectronShell;
  const crashReport = yield* DesktopCrashReport.DesktopCrashReport;

  const askUser = (report: DesktopCrashReport.DesktopStartupFailureReport) =>
    Effect.gen(function* () {
      const { message, detail } = describeStartupFailure({
        displayName: environment.displayName,
        report,
        logDir: environment.logDir,
        homeDirectory: environment.homeDirectory,
      });

      while (true) {
        const result = yield* electronDialog.showMessageBox({
          type: "error",
          title: message,
          message,
          detail,
          buttons: ["Try Again", "Open Logs Folder", "Quit"],
          defaultId: TRY_AGAIN_BUTTON_INDEX,
          cancelId: QUIT_BUTTON_INDEX,
          noLink: true,
        });

        if (result.response === OPEN_LOGS_BUTTON_INDEX) {
          yield* electronShell.openPath(environment.logDir);
          continue;
        }
        return result.response === TRY_AGAIN_BUTTON_INDEX ? ("retry" as const) : ("quit" as const);
      }
    });

  const handle: DesktopStartupFailurePromptShape["handle"] = Effect.fn(
    "desktop.startupFailurePrompt.handle",
  )(function* (report) {
    // Concurrent with the dialog: the user should never wait on telemetry.
    const reportFiber = yield* Effect.forkChild(
      crashReport
        .reportStartupFailure(report)
        .pipe(Effect.timeoutOption(CRASH_REPORT_TIMEOUT), Effect.asVoid),
    );

    const action = yield* askUser(report).pipe(
      Effect.catchCause(() =>
        // The rich dialog itself failed; a plain error box and a clean quit
        // beat an invisible process holding the single-instance lock.
        electronDialog
          .showErrorBox(
            `${environment.displayName} couldn't start`,
            `The background service failed to start and the recovery dialog could not be shown. See logs: ${environment.logDir}`,
          )
          .pipe(Effect.as("quit" as const)),
      ),
    );

    yield* Fiber.await(reportFiber);
    if (action === "quit") {
      yield* electronApp.quit;
    }
    return action;
  });

  const notifyDatabaseRecovery: DesktopStartupFailurePromptShape["notifyDatabaseRecovery"] =
    Effect.fn("desktop.startupFailurePrompt.notifyDatabaseRecovery")((result) =>
      Effect.gen(function* () {
        const response = yield* electronDialog.showMessageBox({
          type: "warning",
          title: `${environment.displayName} repaired its local data`,
          message: `${environment.displayName} recovered and started`,
          detail: `A damaged local database prevented startup. It was preserved here:\n\n${result.backupDir}\n\n${environment.displayName} started with a new database. Your old database files are preserved in that folder.`,
          buttons: ["OK", "Open Recovery Folder"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (response.response === OPEN_RECOVERY_FOLDER_BUTTON_INDEX) {
          yield* electronShell.openPath(result.backupDir);
        }
      }).pipe(Effect.catchCause(() => Effect.void)),
    );

  return DesktopStartupFailurePrompt.of({ handle, notifyDatabaseRecovery });
});

export const layer = Layer.effect(DesktopStartupFailurePrompt, makeDesktopStartupFailurePrompt);

export type { DesktopStartupFailureReport } from "../app/DesktopCrashReport.ts";
