import type { EnvironmentId, SourceControlToolVersionAdvisory } from "@threadlines/contracts";
import {
  AlertCircleIcon,
  ArrowUpCircleIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  LoaderIcon,
} from "lucide-react";
import { useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { updateSourceControlTool } from "../../lib/sourceControlDiscoveryState";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";

interface CompactVersionAdvisoryProps {
  readonly advisory: SourceControlToolVersionAdvisory;
  readonly environmentId: EnvironmentId | null | undefined;
  readonly label: string;
}

function openExternalUrl(url: string): void {
  const api = readLocalApi();
  if (!api) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }

  void api.shell.openExternal(url).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
}

function advisoryTitle(advisory: SourceControlToolVersionAdvisory): string {
  if (advisory.status === "current") return "Up to date";
  return advisory.status === "install_available" ? "Install available" : "Update available";
}

function packageManagerLabel(copyLabel: string | undefined): string {
  if (copyLabel?.toLowerCase().includes("homebrew")) return "Homebrew";
  if (copyLabel?.toLowerCase().includes("winget")) return "WinGet";
  return "package manager";
}

export function CompactVersionAdvisory({
  advisory,
  environmentId,
  label,
}: CompactVersionAdvisoryProps) {
  const [isUpdating, setIsUpdating] = useState(false);
  const updateAction = advisory.actions.find((action) => action.kind === "runUpdate");
  const copyActionCandidate = advisory.actions.find((action) => action.kind === "copyCommand");
  const copyAction = copyActionCandidate?.kind === "copyCommand" ? copyActionCandidate : undefined;
  const openActionCandidate = advisory.actions.find((action) => action.kind === "openUrl");
  const openAction = openActionCandidate?.kind === "openUrl" ? openActionCandidate : undefined;
  const { copyToClipboard } = useCopyToClipboard<{ readonly label: string }>({
    onCopy: ({ label: actionLabel }) => {
      toastManager.add({
        type: "success",
        title: "Command copied",
        description: actionLabel,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy command",
          description: error.message,
        }),
      );
    },
  });
  const runUpdate = () => {
    if (!updateAction || isUpdating) return;
    setIsUpdating(true);
    void updateSourceControlTool({
      ...(environmentId === undefined ? {} : { environmentId }),
      target: updateAction.target,
      ...(updateAction.operation ? { operation: updateAction.operation } : {}),
    })
      .then((result) => {
        toastManager.add({
          type: result.status === "succeeded" ? "success" : "info",
          title:
            result.status === "succeeded"
              ? result.operation === "install"
                ? `${label} installed`
                : `${label} updated`
              : `${label} is unchanged`,
          description:
            result.status === "succeeded"
              ? result.operation === "install"
                ? result.currentVersion
                  ? `Installed ${result.currentVersion}`
                  : "Installed successfully."
                : `${result.previousVersion ?? "Previous version"} to ${result.currentVersion ?? "updated"}`
              : `${packageManagerLabel(copyAction?.label)} completed, but the detected version did not change.`,
        });
      })
      .catch((error: unknown) => {
        const operation = updateAction.operation ?? "update";
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not ${operation === "install" ? "install" : "update"} ${label}`,
            description:
              error instanceof Error ? error.message : "The verified update command failed.",
          }),
        );
      })
      .finally(() => setIsUpdating(false));
  };

  if (advisory.status === "install_available" && updateAction) {
    return (
      <Button
        type="button"
        size="xs"
        variant="default"
        className="h-6 px-2 text-[11px]"
        disabled={isUpdating}
        onClick={runUpdate}
        aria-label={`Install ${label}`}
      >
        {isUpdating ? <LoaderIcon className="size-3 animate-spin" aria-hidden /> : null}
        {isUpdating ? "Installing" : "Install"}
      </Button>
    );
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className={cn(
              "size-5 rounded-sm p-0",
              advisory.severity === "warning"
                ? "text-warning hover:text-warning"
                : "text-primary-readable hover:text-primary-readable",
            )}
            aria-label={`${label} ${advisory.status === "install_available" ? "install" : "update"} advisory`}
          >
            <ArrowUpCircleIcon className="size-3.5" aria-hidden />
          </Button>
        }
      />
      <PopoverPopup
        side="bottom"
        align="start"
        className="w-[min(21rem,calc(100vw-1.5rem))] [--popup-width:min(21rem,calc(100vw-1.5rem))]"
      >
        <div className="grid min-w-0 gap-3">
          <div className="grid gap-0.5">
            <p className="text-[13px] font-semibold leading-tight text-foreground">
              {advisoryTitle(advisory)}
            </p>
            <div className="grid gap-1 text-xs text-muted-foreground">
              {advisory.currentVersion ? (
                <p className="flex items-center justify-between gap-3">
                  <span>Current</span>
                  <code className="truncate text-foreground">{advisory.currentVersion}</code>
                </p>
              ) : null}
              {advisory.latestVersion ? (
                <p className="flex items-center justify-between gap-3">
                  <span>Latest</span>
                  <code className="truncate text-foreground">{advisory.latestVersion}</code>
                </p>
              ) : null}
              {advisory.recommendedVersion &&
              advisory.recommendedVersion !== advisory.latestVersion ? (
                <p className="flex items-center justify-between gap-3">
                  <span>Security baseline</span>
                  <code className="truncate text-foreground">{advisory.recommendedVersion}</code>
                </p>
              ) : null}
            </div>
            {advisory.message ? (
              <p
                className={cn(
                  "mt-1 text-xs leading-snug",
                  advisory.severity === "warning" ? "text-warning" : "text-muted-foreground",
                )}
              >
                {advisory.message}
              </p>
            ) : null}
          </div>

          {updateAction ? (
            <Button
              type="button"
              size="xs"
              variant="default"
              className="w-full"
              disabled={isUpdating}
              onClick={runUpdate}
            >
              {isUpdating ? (
                <LoaderIcon className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <DownloadIcon className="size-3.5" aria-hidden />
              )}
              {isUpdating ? "Updating" : updateAction.label}
            </Button>
          ) : null}

          {copyAction ? (
            <div className="flex min-w-0 items-center gap-1 rounded-md border border-border/70 bg-muted/40 py-0.5 pr-0.5 pl-2">
              <ScrollArea scrollFade className="h-8 min-w-0 flex-1 rounded-none">
                <code className="flex h-full w-max items-center whitespace-nowrap pr-3 font-mono text-[11px] text-foreground">
                  {copyAction.value}
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
                      onClick={() => copyToClipboard(copyAction.value, { label: copyAction.label })}
                      aria-label={`Copy ${label} update command`}
                    >
                      <CopyIcon className="size-3" aria-hidden />
                    </Button>
                  }
                />
                <TooltipPopup side="top">Copy command</TooltipPopup>
              </Tooltip>
            </div>
          ) : null}

          {openAction ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="w-full"
              onClick={() => openExternalUrl(openAction.value)}
            >
              <ExternalLinkIcon className="size-3.5" aria-hidden />
              {openAction.label}
            </Button>
          ) : null}

          <p
            className={cn(
              "flex items-start gap-1.5 text-[11px] leading-snug",
              advisory.severity === "warning" ? "text-warning" : "text-muted-foreground",
            )}
          >
            <AlertCircleIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
            {updateAction
              ? packageManagerLabel(copyAction?.label) === "WinGet" &&
                (updateAction.operation ?? "update") === "update"
                ? "Threadlines runs only the verified WinGet package shown above after you click Update now. Windows may ask for permission."
                : `Threadlines runs only the verified ${packageManagerLabel(copyAction?.label)} ${updateAction.operation === "install" ? "install" : "update"} recipe shown above after you click ${updateAction.label}.`
              : copyAction
                ? "Threadlines cannot run this automatically. Use the copied command on this environment's host."
                : advisory.status === "current"
                  ? "This tool is up to date."
                  : advisory.status === "install_available"
                    ? "Threadlines cannot run this install automatically yet. Use the official install guide on this environment's host."
                    : "Threadlines cannot run this update automatically yet. Use the official release link or check again after WinGet publishes it."}
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
