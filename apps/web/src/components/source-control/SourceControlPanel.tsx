import {
  type EnvironmentId,
  type GitStackedAction,
  type ScopedThreadRef,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLinkIcon,
  FileTextIcon,
  GitCommitIcon,
  GitGraphIcon,
  GitPullRequestIcon,
  RefreshCwIcon,
  SparklesIcon,
  UploadIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import { openInPreferredEditor } from "~/editorPreferences";
import {
  gitCommitGraphQueryOptions,
  gitMutationKeys,
  gitQueryKeys,
  gitRunStackedActionMutationOptions,
} from "~/lib/gitReactQuery";
import { refreshGitStatus, useGitStatus } from "~/lib/gitStatusState";
import { cn, randomUUID } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { resolvePathLinkTarget } from "~/terminal-links";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildGeneratedCommitMessage,
  formatCommitGraphTimestamp,
} from "./SourceControlPanel.logic";

export interface SourceControlProjectTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly name: string;
  readonly environmentLabel: string | null;
}

interface SourceControlPanelProps {
  readonly target: SourceControlProjectTarget | null;
  readonly activeThreadRef: ScopedThreadRef | null;
}

function formatCommitCount(count: number): string {
  return count === 1 ? "1 commit" : `${count} commits`;
}

function splitPath(filePath: string): { readonly name: string; readonly directory: string } {
  const parts = filePath.split(/[\\/]/g).filter(Boolean);
  const name = parts.at(-1) ?? filePath;
  return {
    name,
    directory: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
  };
}

function actionDisabledReason(input: {
  readonly status: VcsStatusResult | null;
  readonly action: "commit" | "push" | "create_pr";
  readonly isBusy: boolean;
}): string | null {
  if (input.isBusy) {
    return "Git action in progress.";
  }
  const status = input.status;
  if (!status?.isRepo) {
    return "No Git repository.";
  }
  if (input.action === "commit") {
    return status.hasWorkingTreeChanges ? null : "No working tree changes.";
  }

  if (status.refName === null) {
    return "Detached HEAD.";
  }
  if (status.hasWorkingTreeChanges) {
    return "Commit changes first.";
  }
  if (status.behindCount > 0) {
    return "Branch is behind upstream.";
  }
  if (!status.hasUpstream && !status.hasPrimaryRemote) {
    return "No primary remote.";
  }
  if (input.action === "push") {
    return status.aheadCount > 0 ? null : "No local commits to push.";
  }
  if (status.pr?.state === "open") {
    return null;
  }
  return (status.aheadOfDefaultCount ?? status.aheadCount) > 0
    ? null
    : "No branch commits to include.";
}

function ActionButton({
  label,
  icon,
  disabledReason,
  onClick,
}: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly disabledReason: string | null;
  readonly onClick: () => void;
}) {
  const button = (
    <Button
      variant="outline"
      size="xs"
      disabled={disabledReason !== null}
      onClick={disabledReason === null ? onClick : undefined}
      className="min-w-0 flex-1 justify-center"
    >
      {icon}
      <span className="truncate">{label}</span>
    </Button>
  );

  if (disabledReason === null) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="min-w-0 flex-1" />}>{button}</TooltipTrigger>
      <TooltipPopup side="top">{disabledReason}</TooltipPopup>
    </Tooltip>
  );
}

export function SourceControlPanel({ target, activeThreadRef }: SourceControlPanelProps) {
  const queryClient = useQueryClient();
  const [commitMessage, setCommitMessage] = useState("");
  const environmentId = target?.environmentId ?? null;
  const cwd = target?.cwd ?? null;
  const threadToastData = useMemo(
    () => (activeThreadRef ? { threadRef: activeThreadRef } : undefined),
    [activeThreadRef],
  );
  const gitStatus = useGitStatus({ environmentId, cwd });
  const status = gitStatus.data;
  const graphQuery = useQuery(
    gitCommitGraphQueryOptions({
      environmentId,
      cwd,
      limit: 18,
      enabled: Boolean(status?.isRepo),
    }),
  );
  const actionMutation = useMutation(
    gitRunStackedActionMutationOptions({
      environmentId,
      cwd,
      queryClient,
    }),
  );
  const isGitActionRunning =
    useIsMutating({
      mutationKey: gitMutationKeys.runStackedAction(environmentId, cwd),
    }) > 0 || actionMutation.isPending;
  const changedFiles = status?.workingTree.files ?? [];
  const sourceControlPresentation = getSourceControlPresentation(status?.sourceControlProvider);
  const changeRequestLabel = sourceControlPresentation.terminology.shortLabel;
  const openPullRequest = status?.pr?.state === "open" ? status.pr : null;
  const commitDisabledReason = actionDisabledReason({
    status,
    action: "commit",
    isBusy: isGitActionRunning,
  });
  const pushDisabledReason = actionDisabledReason({
    status,
    action: "push",
    isBusy: isGitActionRunning,
  });
  const prDisabledReason = actionDisabledReason({
    status,
    action: "create_pr",
    isBusy: isGitActionRunning,
  });
  const changeRequestDisabledReason = openPullRequest
    ? isGitActionRunning
      ? "Git action in progress."
      : null
    : prDisabledReason;

  const refreshPanel = useCallback(() => {
    if (!environmentId || !cwd) {
      return;
    }
    void refreshGitStatus({ environmentId, cwd }).catch(() => undefined);
    void queryClient.invalidateQueries({
      queryKey: gitQueryKeys.commitGraph(environmentId, cwd, 18),
    });
  }, [cwd, environmentId, queryClient]);

  const runAction = useCallback(
    async (action: GitStackedAction) => {
      if (!environmentId || !cwd) {
        return;
      }
      const actionId = randomUUID();
      const trimmedMessage = commitMessage.trim();
      const toastId = toastManager.add({
        type: "loading",
        title:
          action === "commit"
            ? "Committing..."
            : action === "push"
              ? "Pushing..."
              : `Creating ${changeRequestLabel}...`,
        timeout: 0,
        data: threadToastData,
      });

      try {
        const result = await actionMutation.mutateAsync({
          actionId,
          action,
          ...(action === "commit" && trimmedMessage.length > 0
            ? { commitMessage: trimmedMessage }
            : {}),
        });
        if (action === "commit") {
          setCommitMessage("");
        }
        toastManager.update(toastId, {
          type: "success",
          title: result.toast.title,
          description: result.toast.description,
          timeout: 0,
          data: {
            ...threadToastData,
            dismissAfterVisibleMs: 10_000,
          },
        });
        void refreshGitStatus({ environmentId, cwd }).catch(() => undefined);
        void queryClient.invalidateQueries({
          queryKey: gitQueryKeys.commitGraph(environmentId, cwd, 18),
        });
      } catch (error) {
        toastManager.update(
          toastId,
          stackedThreadToast({
            type: "error",
            title: "Action failed",
            description: error instanceof Error ? error.message : "An error occurred.",
            ...(threadToastData !== undefined ? { data: threadToastData } : {}),
          }),
        );
      }
    },
    [
      actionMutation,
      changeRequestLabel,
      commitMessage,
      cwd,
      environmentId,
      queryClient,
      threadToastData,
    ],
  );

  const openChangedFile = useCallback(
    (filePath: string) => {
      const api = readLocalApi();
      if (!api || !cwd) {
        return;
      }
      void openInPreferredEditor(api, resolvePathLinkTarget(filePath, cwd)).catch(() => undefined);
    },
    [cwd],
  );

  const openExistingPr = useCallback(() => {
    const api = readLocalApi();
    if (!api || !openPullRequest) {
      return;
    }
    void api.shell.openExternal(openPullRequest.url).catch(() => undefined);
  }, [openPullRequest]);

  if (!target) {
    return null;
  }

  return (
    <div className="flex min-h-0 flex-col gap-3 border-t border-border/70 px-3 py-3">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <GitGraphIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
            <h2 className="truncate text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
              Source Control
            </h2>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground/60">
            {target.name}
            {status?.refName ? ` · ${status.refName}` : ""}
          </p>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                aria-label="Refresh source control"
                variant="ghost"
                size="icon-xs"
                onClick={refreshPanel}
              />
            }
          >
            <RefreshCwIcon className={cn("size-3.5", gitStatus.isPending && "animate-spin")} />
          </TooltipTrigger>
          <TooltipPopup side="top">Refresh</TooltipPopup>
        </Tooltip>
      </div>

      <section className="min-h-0 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-foreground">Changes</h3>
          <span className="font-mono text-[11px] text-muted-foreground">
            <span className="text-success">+{status?.workingTree.insertions ?? 0}</span>
            <span className="px-1 text-muted-foreground/60">/</span>
            <span className="text-destructive">-{status?.workingTree.deletions ?? 0}</span>
          </span>
        </div>
        {changedFiles.length === 0 ? (
          <div className="rounded-md border border-border/70 bg-background/40 px-2.5 py-2 text-xs text-muted-foreground/70">
            No working tree changes
          </div>
        ) : (
          <ScrollArea className="max-h-44 rounded-md border border-border/70 bg-background/35">
            <div className="divide-y divide-border/45">
              {changedFiles.map((file) => {
                const pathParts = splitPath(file.path);
                return (
                  <button
                    key={file.path}
                    type="button"
                    className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 px-2.5 py-2 text-left transition-colors hover:bg-accent/60"
                    onClick={() => openChangedFile(file.path)}
                  >
                    <span className="min-w-0">
                      <span className="flex min-w-0 items-center gap-1.5 text-xs text-foreground">
                        <FileTextIcon className="size-3 shrink-0 text-muted-foreground/60" />
                        <span className="truncate">{pathParts.name}</span>
                      </span>
                      {pathParts.directory ? (
                        <span className="block truncate pl-4.5 font-mono text-[10px] text-muted-foreground/55">
                          {pathParts.directory}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 self-center font-mono text-[11px]">
                      <span className="text-success">+{file.insertions}</span>
                      <span className="px-1 text-muted-foreground/60">/</span>
                      <span className="text-destructive">-{file.deletions}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </section>

      <section className="space-y-2">
        <Textarea
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
          placeholder="Commit message"
          size="sm"
          className="min-h-[4.5rem] resize-none text-xs"
        />
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={changedFiles.length === 0}
            onClick={() => setCommitMessage(buildGeneratedCommitMessage(changedFiles))}
          >
            <SparklesIcon className="size-3" />
            Generate
          </Button>
          <ActionButton
            label="Commit"
            icon={<GitCommitIcon className="size-3" />}
            disabledReason={commitDisabledReason}
            onClick={() => void runAction("commit")}
          />
          <ActionButton
            label="Push"
            icon={<UploadIcon className="size-3" />}
            disabledReason={pushDisabledReason}
            onClick={() => void runAction("push")}
          />
          <ActionButton
            label={openPullRequest ? `Open ${changeRequestLabel}` : `Create ${changeRequestLabel}`}
            icon={
              openPullRequest ? (
                <ExternalLinkIcon className="size-3" />
              ) : (
                <GitPullRequestIcon className="size-3" />
              )
            }
            disabledReason={changeRequestDisabledReason}
            onClick={openPullRequest ? openExistingPr : () => void runAction("create_pr")}
          />
        </div>
      </section>

      <section className="min-h-0 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-foreground">Graph</h3>
          <span className="text-[11px] text-muted-foreground/60">
            {formatCommitCount(graphQuery.data?.commits.length ?? 0)}
          </span>
        </div>
        <div className="rounded-md border border-border/70 bg-background/35">
          {(graphQuery.data?.commits.length ?? 0) === 0 ? (
            <div className="px-2.5 py-2 text-xs text-muted-foreground/70">No commits yet</div>
          ) : (
            <div className="divide-y divide-border/45">
              {graphQuery.data?.commits.map((commit) => (
                <div
                  key={commit.sha}
                  className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2 px-2.5 py-2"
                >
                  <span className="relative flex justify-center pt-1">
                    <span className="absolute bottom-[-0.5rem] top-3 w-px bg-border/70" />
                    <span
                      className={cn(
                        "z-10 size-2 rounded-full border bg-background",
                        commit.parents.length > 1
                          ? "border-warning"
                          : commit.refs.length > 0
                            ? "border-primary"
                            : "border-muted-foreground/50",
                      )}
                    />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs text-foreground">{commit.subject}</span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground/60">
                      <span>{commit.shortSha}</span>
                      <span>{formatCommitGraphTimestamp(commit.committedAt)}</span>
                    </span>
                    {commit.refs.length > 0 ? (
                      <span className="mt-1 flex min-w-0 flex-wrap gap-1">
                        {commit.refs.slice(0, 3).map((ref) => (
                          <span
                            key={ref}
                            className="max-w-full truncate rounded-sm border border-border/70 px-1 py-0.5 text-[10px] text-muted-foreground"
                          >
                            {ref}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
