/**
 * The details behind an agent's Update control: what's new, the last run's
 * result, "Update now", and the command to run by hand.
 *
 * Settings opens it from the static version tag on an agent row; setup opens
 * it from the row's Update button. Progress and failures come from the
 * snapshot's `updateState`, so both surfaces show the same run. On Windows a
 * running Claude keeps its executable locked; the popover then offers to stop
 * those processes before trying again.
 *
 * @module ProviderUpdatePopover
 */
import type { ServerProvider } from "@threadlines/contracts";
import { AlertCircleIcon, CopyIcon, DownloadIcon, LoaderIcon, XIcon } from "lucide-react";
import type { ReactElement } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { getProviderVersionAdvisoryPresentation } from "./providerStatus";
import type { ProviderUpdateControls } from "./useProviderUpdateRunner";

const PROVIDER_UPDATE_OUTPUT_PREVIEW_CHARS = 700;

function truncateProviderUpdateOutput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= PROVIDER_UPDATE_OUTPUT_PREVIEW_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, PROVIDER_UPDATE_OUTPUT_PREVIEW_CHARS).trimEnd()}...`;
}

function isProviderUpdateProcessLockMessage(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("claude") &&
    normalized.includes("windows") &&
    normalized.includes("replace") &&
    normalized.includes("executable")
  );
}

export function ProviderUpdatePopover({
  liveProvider,
  displayName,
  controls,
  trigger,
}: {
  readonly liveProvider: ServerProvider | undefined;
  readonly displayName: string;
  readonly controls: ProviderUpdateControls;
  /** The element that opens the popover (a version tag or an Update button). */
  readonly trigger: ReactElement;
}) {
  const { copyToClipboard } = useCopyToClipboard<{ providerName: string }>({
    onCopy: ({ providerName }) => {
      toastManager.add({
        type: "success",
        title: `${providerName} update command copied`,
        description: "Run it in a terminal when you are ready to update.",
      });
    },
    onError: (error, { providerName }) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not copy ${providerName} update command`,
          description: error.message,
        }),
      );
    },
  });
  const versionAdvisory = getProviderVersionAdvisoryPresentation(liveProvider?.versionAdvisory);
  if (!versionAdvisory) {
    return null;
  }
  const updateCommand = versionAdvisory.updateCommand;
  const updateState = liveProvider?.updateState ?? null;
  const updateMessage = updateState?.message?.trim() ?? "";
  const updateOutput = updateState?.output?.trim() ?? "";
  const isProcessLock =
    updateState?.status === "failed" && isProviderUpdateProcessLockMessage(updateMessage);
  const panelMessage = isProcessLock
    ? "Claude is running in the background, so Windows cannot replace claude.exe. Stop those Claude processes, then run the update again."
    : updateMessage;
  const canResolveBlockers = isProcessLock && controls.resolveBlockers !== undefined;

  return (
    <Popover>
      <PopoverTrigger render={trigger} />
      <PopoverPopup
        side="bottom"
        align="start"
        className="w-[min(21rem,calc(100vw-1.5rem))] [--popup-width:min(21rem,calc(100vw-1.5rem))]"
      >
        <div className="grid min-w-0 gap-3">
          <div className="grid gap-0.5">
            <p className="text-[13px] font-semibold leading-tight text-foreground">
              Update available
            </p>
            <p
              className={cn(
                "text-xs leading-snug",
                versionAdvisory.emphasis === "strong" ? "text-warning" : "text-muted-foreground",
              )}
            >
              {versionAdvisory.detail}
            </p>
          </div>
          {updateMessage ? (
            <div
              className={cn(
                "grid gap-2 rounded-md border px-2.5 py-2 text-xs leading-snug",
                isProcessLock
                  ? "border-warning/35 bg-warning/8 text-warning"
                  : updateState?.status === "failed"
                    ? "border-destructive/35 bg-destructive/8 text-destructive"
                    : updateState?.status === "unchanged"
                      ? "border-warning/35 bg-warning/8 text-warning"
                      : "border-border/70 bg-muted/40 text-muted-foreground",
              )}
            >
              <div className="flex min-w-0 items-start gap-2">
                <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <p className="min-w-0">{panelMessage}</p>
              </div>
              {updateState?.status === "failed" && updateOutput && !isProcessLock ? (
                <ScrollArea scrollFade className="max-h-24 min-w-0 rounded-sm">
                  <code className="block whitespace-pre-wrap break-words rounded-sm bg-background/55 p-2 font-mono text-[10px] leading-snug text-foreground/80">
                    {truncateProviderUpdateOutput(updateOutput)}
                  </code>
                </ScrollArea>
              ) : null}
              {canResolveBlockers ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="w-full border-warning/35 bg-background/45 text-warning hover:bg-warning/10 hover:text-warning"
                  disabled={controls.isResolvingBlockers || controls.isUpdating}
                  onClick={controls.resolveBlockers}
                >
                  {controls.isResolvingBlockers ? (
                    <LoaderIcon className="animate-spin" />
                  ) : (
                    <XIcon />
                  )}
                  {controls.isResolvingBlockers ? "Stopping Claude" : "Stop Claude processes"}
                </Button>
              ) : null}
            </div>
          ) : null}
          {controls.runUpdate ? (
            <Button
              type="button"
              size="xs"
              variant="default"
              className="w-full"
              disabled={controls.isUpdating || controls.isResolvingBlockers}
              onClick={controls.runUpdate}
            >
              {controls.isUpdating ? <LoaderIcon className="animate-spin" /> : <DownloadIcon />}
              {controls.isUpdating ? "Updating" : "Update now"}
            </Button>
          ) : null}
          {controls.runUpdate && updateCommand ? (
            <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              <span aria-hidden className="h-px flex-1 bg-border" />
              or, update manually using
              <span aria-hidden className="h-px flex-1 bg-border" />
            </div>
          ) : null}
          {updateCommand ? (
            <div className="flex min-w-0 items-center gap-1 rounded-md border border-border/70 bg-muted/40 py-0.5 pr-0.5 pl-2">
              <ScrollArea scrollFade className="h-8 min-w-0 flex-1 rounded-none">
                <code className="flex h-full w-max items-center whitespace-nowrap pr-3 font-mono text-[11px] text-foreground">
                  {updateCommand}
                </code>
              </ScrollArea>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      className="size-6 shrink-0 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                      onClick={() => copyToClipboard(updateCommand, { providerName: displayName })}
                      aria-label="Copy update command"
                    >
                      <CopyIcon className="size-3" />
                    </Button>
                  }
                />
                <TooltipPopup side="top">Copy command</TooltipPopup>
              </Tooltip>
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
