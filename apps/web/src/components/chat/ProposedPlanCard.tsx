import { memo, useState, useId } from "react";
import type { EnvironmentId } from "@threadlines/contracts";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildProposedPlanMarkdownFilename,
  downloadPlanAsTextFile,
  normalizePlanMarkdownForExport,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "../../proposedPlan";
import ChatMarkdown from "../ChatMarkdown";
import { ArrowUpRightIcon, CheckIcon, EllipsisIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { readEnvironmentApi } from "~/environmentApi";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

export type ProposedPlanCardStatus = "actionable" | "implemented" | "superseded" | "dismissed";

function PlanStatusChip({
  status,
  onOpenImplementationThread,
}: {
  status: ProposedPlanCardStatus;
  onOpenImplementationThread: (() => void) | undefined;
}) {
  if (status === "implemented") {
    const label = (
      <>
        <CheckIcon aria-hidden="true" className="size-3" />
        <span>Implemented</span>
        {onOpenImplementationThread ? (
          <ArrowUpRightIcon aria-hidden="true" className="size-3" />
        ) : null}
      </>
    );
    if (onOpenImplementationThread) {
      return (
        <button
          type="button"
          className="inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-[var(--app-radius-badge)] bg-success/15 px-1.5 text-[11px] leading-none font-medium text-success transition-colors hover:bg-success/25"
          onClick={onOpenImplementationThread}
          title="Open implementation thread"
        >
          {label}
        </button>
      );
    }
    return (
      <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-[var(--app-radius-badge)] bg-success/15 px-1.5 text-[11px] leading-none font-medium text-success">
        {label}
      </span>
    );
  }

  if (status === "superseded" || status === "dismissed") {
    return (
      <span className="inline-flex h-5 shrink-0 items-center rounded-[var(--app-radius-badge)] border border-border/60 bg-muted/40 px-1.5 text-[11px] leading-none text-muted-foreground/75">
        {status === "superseded" ? "Superseded" : "Dismissed"}
      </span>
    );
  }

  return (
    <span className="inline-flex h-5 shrink-0 items-center rounded-[var(--app-radius-badge)] bg-amber-500/15 px-1.5 text-[11px] leading-none font-medium text-amber-600 dark:text-amber-400">
      Ready
    </span>
  );
}

export const ProposedPlanCard = memo(function ProposedPlanCard({
  planMarkdown,
  environmentId,
  cwd,
  workspaceRoot,
  status = "actionable",
  onImplement,
  onImplementInNewThread,
  onOpenImplementationThread,
  onDismiss,
}: {
  planMarkdown: string;
  environmentId: EnvironmentId;
  cwd: string | undefined;
  workspaceRoot: string | undefined;
  status?: ProposedPlanCardStatus;
  onImplement?: (() => void) | undefined;
  onImplementInNewThread?: (() => void) | undefined;
  onOpenImplementationThread?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [savePath, setSavePath] = useState("");
  const [isSavingToWorkspace, setIsSavingToWorkspace] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy plan",
          description: error instanceof Error ? error.message : "An error occurred while copying.",
        }),
      );
    },
  });
  const savePathInputId = useId();
  const title = proposedPlanTitle(planMarkdown) ?? "Proposed plan";
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const collapsedPreview = canCollapse
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 })
    : null;
  const downloadFilename = buildProposedPlanMarkdownFilename(planMarkdown);
  const saveContents = normalizePlanMarkdownForExport(planMarkdown);

  const handleDownload = () => {
    downloadPlanAsTextFile(downloadFilename, saveContents);
  };

  const handleCopyPlan = () => {
    copyToClipboard(saveContents);
  };

  const openSaveDialog = () => {
    if (!workspaceRoot) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Workspace path is unavailable",
          description: "This thread does not have a workspace path to save into.",
        }),
      );
      return;
    }
    setSavePath((existing) => (existing.length > 0 ? existing : downloadFilename));
    setIsSaveDialogOpen(true);
  };

  const handleSaveToWorkspace = () => {
    const api = readEnvironmentApi(environmentId);
    const relativePath = savePath.trim();
    if (!api || !workspaceRoot) {
      return;
    }
    if (!relativePath) {
      toastManager.add({
        type: "warning",
        title: "Enter a workspace path",
      });
      return;
    }

    setIsSavingToWorkspace(true);
    void api.projects
      .writeFile({
        cwd: workspaceRoot,
        relativePath,
        contents: saveContents,
      })
      .then((result) => {
        setIsSaveDialogOpen(false);
        toastManager.add({
          type: "success",
          title: "Plan saved to workspace",
          description: result.relativePath,
        });
      })
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save plan",
            description: error instanceof Error ? error.message : "An error occurred while saving.",
          }),
        );
      })
      .then(
        () => {
          setIsSavingToWorkspace(false);
        },
        () => {
          setIsSavingToWorkspace(false);
        },
      );
  };

  return (
    <div
      className={cn(
        "rounded-2xl border border-border/80 bg-card/70 p-4 sm:p-5",
        status === "superseded" && "border-border/50 opacity-80",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">Plan</Badge>
          <p className="min-w-0 truncate text-sm font-medium text-foreground">{title}</p>
          <PlanStatusChip status={status} onOpenImplementationThread={onOpenImplementationThread} />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {onImplement ? (
            <Button size="xs" onClick={onImplement}>
              Implement
            </Button>
          ) : null}
          <Menu>
            <MenuTrigger
              render={<Button aria-label="Plan actions" size="icon-xs" variant="outline" />}
            >
              <EllipsisIcon aria-hidden="true" className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              {onImplementInNewThread ? (
                <MenuItem onClick={onImplementInNewThread}>Implement in new thread</MenuItem>
              ) : null}
              <MenuItem onClick={handleCopyPlan}>
                {isCopied ? "Copied!" : "Copy to clipboard"}
              </MenuItem>
              <MenuItem onClick={handleDownload}>Download as markdown</MenuItem>
              <MenuItem onClick={openSaveDialog} disabled={!workspaceRoot || isSavingToWorkspace}>
                Save to workspace
              </MenuItem>
              {onDismiss ? (
                <MenuItem onClick={onDismiss} className="text-destructive">
                  Dismiss plan
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        </div>
      </div>
      <div className="mt-4">
        <div className={cn("relative", canCollapse && !expanded && "max-h-104 overflow-hidden")}>
          {canCollapse && !expanded ? (
            <ChatMarkdown
              text={collapsedPreview ?? ""}
              cwd={cwd}
              environmentId={environmentId}
              isStreaming={false}
            />
          ) : (
            <ChatMarkdown
              text={displayedPlanMarkdown}
              cwd={cwd}
              environmentId={environmentId}
              isStreaming={false}
            />
          )}
          {canCollapse && !expanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-card/95 via-card/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-4 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Collapse plan" : "Expand plan"}
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog
        open={isSaveDialogOpen}
        onOpenChange={(open) => {
          if (!isSavingToWorkspace) {
            setIsSaveDialogOpen(open);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Save plan to workspace</DialogTitle>
            <DialogDescription>
              Enter a path relative to <code>{workspaceRoot ?? "the workspace"}</code>.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <label htmlFor={savePathInputId} className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Workspace path</span>
              <Input
                id={savePathInputId}
                value={savePath}
                onChange={(event) => setSavePath(event.target.value)}
                placeholder={downloadFilename}
                spellCheck={false}
                disabled={isSavingToWorkspace}
              />
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsSaveDialogOpen(false)}
              disabled={isSavingToWorkspace}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void handleSaveToWorkspace()}
              disabled={isSavingToWorkspace}
            >
              {isSavingToWorkspace ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});
