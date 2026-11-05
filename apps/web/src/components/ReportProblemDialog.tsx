/**
 * "Report a problem": a bug report written here and posted to GitHub from the
 * person's own GitHub account (ReportProblemDialogContent.tsx, a chunk of its
 * own). Every entry point asks through openReportProblemDialog: Settings ›
 * General, the command palette, the new-thread screen and the desktop Help
 * menu. The host mounted once at the root shows it. The "Something went wrong"
 * screen replaces the root, so it shows its own ReportProblemDialog.
 */
import { Suspense, useEffect } from "react";
import { create } from "zustand";

import { lazyWithPreload } from "../lib/lazyWithPreload";
import { Dialog } from "./ui/dialog";

const ReportProblemDialogContent = lazyWithPreload(() =>
  import("./ReportProblemDialogContent").then((module) => module.ReportProblemDialogContent),
);

/** Fetches the dialog's body ahead of its first open. */
export const preloadReportProblemDialog = ReportProblemDialogContent.preload;

/** The desktop Help menu's "Report a Problem" (DesktopWindow.OPEN_REPORT_PROBLEM_MENU_ACTION). */
const REPORT_PROBLEM_MENU_ACTION = "open-report-problem";

const useReportProblemDialogStore = create<{ readonly open: boolean }>(() => ({ open: false }));

export function openReportProblemDialog(): void {
  useReportProblemDialogStore.setState({ open: true });
}

/** Calls `open` when the desktop app's Help › Report a Problem is picked. */
export function useReportProblemMenuAction(open: () => void): void {
  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") return;
    return onMenuAction((action) => {
      if (action === REPORT_PROBLEM_MENU_ACTION) open();
    });
  }, [open]);
}

/** The receipt lives in the dialog's chunk, which is loaded by the time it's closed. */
function dismissReportReceipt(): void {
  void import("./ReportProblemDialogContent").then((module) => module.dismissReportReceipt());
}

export function ReportProblemDialog({
  open,
  onOpenChange,
  errorText,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Fills in "Error text" when the report is empty, as the crash screen does. */
  readonly errorText?: string;
}) {
  const changeOpen = (next: boolean) => {
    if (!next) dismissReportReceipt();
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      {open ? (
        <Suspense fallback={null}>
          <ReportProblemDialogContent.Component
            {...(errorText === undefined ? {} : { errorText })}
            onClose={() => changeOpen(false)}
          />
        </Suspense>
      ) : null}
    </Dialog>
  );
}

/** Mounted once at the root, over setup and the app alike. */
export function ReportProblemDialogHost() {
  const open = useReportProblemDialogStore((state) => state.open);
  useReportProblemMenuAction(openReportProblemDialog);
  return (
    <ReportProblemDialog
      open={open}
      onOpenChange={(next) => useReportProblemDialogStore.setState({ open: next })}
    />
  );
}
