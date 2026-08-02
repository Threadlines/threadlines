import type { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { FolderGit2Icon } from "lucide-react";
import { memo, useState, useTransition } from "react";

import { stopThreadSession } from "../lib/threadSessionCommands";
import {
  checkoutSwitchChipText,
  checkoutSwitchExplanation,
  type PendingCheckoutSwitch,
} from "./BranchToolbar.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface BranchToolbarCheckoutSwitchChipProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  pendingCheckoutSwitch: PendingCheckoutSwitch;
}

export const BranchToolbarCheckoutSwitchChip = memo(function BranchToolbarCheckoutSwitchChip({
  environmentId,
  threadId,
  pendingCheckoutSwitch,
}: BranchToolbarCheckoutSwitchChipProps) {
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isStopPending, startStopTransition] = useTransition();
  const chipText = checkoutSwitchChipText(pendingCheckoutSwitch);
  const explanation = checkoutSwitchExplanation(pendingCheckoutSwitch);

  const stopAndSwitch = () => {
    setIsConfirmOpen(false);
    setIsPopoverOpen(false);
    startStopTransition(async () => {
      try {
        await stopThreadSession({ environmentId, threadId });
      } catch {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to stop the session",
            description: "The background task is still running. Try again in a moment.",
          }),
        );
      }
    });
  };

  return (
    <>
      <Tooltip>
        <Popover open={isPopoverOpen} onOpenChange={setIsPopoverOpen}>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    aria-label={chipText.long}
                    disabled={isStopPending}
                    className="ml-auto inline-flex min-w-0 max-w-[45%] shrink items-center gap-1 rounded-sm border border-border/70 bg-muted/45 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground/80 outline-none transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60"
                  />
                }
              />
            }
          >
            <FolderGit2Icon className="size-3 shrink-0 opacity-70" />
            <span className="min-w-0 truncate">
              {/* Phone widths truncate the long form to the point of hiding
                  the destination, which is the whole payload of this chip. */}
              <span className="max-sm:hidden">{chipText.long}</span>
              <span className="sm:hidden">{chipText.short}</span>
            </span>
          </TooltipTrigger>
          <TooltipPopup side="top" sideOffset={8} className="max-w-72">
            {explanation}
          </TooltipPopup>
          <PopoverPopup
            align="end"
            side="top"
            sideOffset={8}
            className="w-80 max-w-[calc(100vw-1rem)] [&_[data-slot=popover-viewport]]:py-3 [&_[data-slot=popover-viewport]]:[--viewport-inline-padding:--spacing(3)]"
          >
            <div className="space-y-2.5">
              <p className="font-medium text-sm">
                Agent still in {pendingCheckoutSwitch.fromLabel}
              </p>
              <p className="text-muted-foreground text-sm">{explanation}</p>
              {pendingCheckoutSwitch.deferred ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className="w-full"
                  onClick={() => setIsConfirmOpen(true)}
                >
                  Stop background task &amp; switch now
                </Button>
              ) : null}
            </div>
          </PopoverPopup>
        </Popover>
      </Tooltip>
      <AlertDialog
        open={isConfirmOpen}
        onOpenChange={(open) => {
          if (!open) setIsConfirmOpen(false);
        }}
      >
        <AlertDialogPopup className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Stop the background task?</AlertDialogTitle>
            <AlertDialogDescription>
              {`Stopping this session discards the background task that is still running, and its work is lost. Your next message then starts a fresh session in ${pendingCheckoutSwitch.toLabel}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" size="sm" onClick={stopAndSwitch}>
              Stop &amp; switch
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
});
