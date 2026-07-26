import { scopeProjectRef, scopeThreadRef } from "@threadlines/client-runtime";
import { GitBranchIcon, ServerIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { PROVIDER_OPTIONS } from "../../session-logic";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { selectProjectByRef, useStore } from "../../store";
import { createThreadSelectorByRef } from "../../storeSelectors";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { SidebarThreadSummary } from "../../types";
import type { ThreadStatusPill } from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { ThreadStatusDot } from "../ThreadStatusIndicators";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

function DetailRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground/70">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </div>
  );
}

/**
 * The details a truncated row had to drop.
 *
 * Deck rows shorten the title and the rail keeps only a status dot, so the
 * thread's identity — which project, which branch, which machine — is exactly
 * what a hover has to restore. Everything here is derived from data the
 * sidebar already holds, except the model, which is only known once the
 * thread's shell has loaded and is otherwise reported as the provider.
 */
export function ThreadHoverCard({
  thread,
  status,
  side = "right",
  children,
}: {
  thread: SidebarThreadSummary;
  status: ThreadStatusPill | null;
  side?: "right" | "left" | "top" | "bottom";
  children: ReactNode;
}) {
  const projectRef = useMemo(
    () => scopeProjectRef(thread.environmentId, thread.projectId),
    [thread.environmentId, thread.projectId],
  );
  const project = useStore((state) => selectProjectByRef(state, projectRef));
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const loadedThread = useStore(useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]));

  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemote = primaryEnvironmentId !== null && thread.environmentId !== primaryEnvironmentId;
  const runtimeLabel = useSavedEnvironmentRuntimeStore(
    (state) => state.byId[thread.environmentId]?.descriptor?.label ?? null,
  );
  const savedLabel = useSavedEnvironmentRegistryStore(
    (state) => state.byId[thread.environmentId]?.label ?? null,
  );
  const environmentLabel = isRemote ? (runtimeLabel ?? savedLabel ?? "Remote") : null;

  const provider = thread.session?.provider ?? null;
  const ProviderIcon = provider ? (PROVIDER_ICON_BY_PROVIDER[provider] ?? null) : null;
  // The driver kind is an internal identifier ("claudeAgent"); show what the
  // model picker shows. The model itself is only known once the thread's shell
  // has loaded, so the provider is the fallback rather than the default.
  const providerLabel = provider
    ? (PROVIDER_OPTIONS.find((option) => option.value === provider)?.label ?? provider)
    : null;
  const modelLabel = loadedThread?.modelSelection?.model ?? null;
  const activityAt = thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt;
  // A worktree is the more specific fact when present: it implies the branch
  // and tells you the checkout is isolated.
  const worktreeName = thread.worktreePath ? thread.worktreePath.split("/").pop() : null;

  return (
    <Tooltip>
      <TooltipTrigger render={children as never} />
      <TooltipPopup
        side={side}
        sideOffset={8}
        align="start"
        className="w-64 rounded-lg p-3 text-left text-popover-foreground text-sm shadow-none elevate-popover"
        data-testid="thread-hover-card"
      >
        <p className="mb-2 line-clamp-3 text-sm font-medium leading-snug text-foreground">
          {thread.title}
        </p>
        <div className="mb-2 flex items-center gap-2 border-b border-border/60 pb-2 text-xs">
          <ThreadStatusDot status={status} />
          <span className="min-w-0 flex-1 truncate text-foreground/80">
            {status ? status.label : "Idle"}
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground/60">
            {formatRelativeTimeLabel(activityAt)}
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          {project ? (
            <DetailRow
              icon={<ProjectFavicon cwd={project.cwd} environmentId={project.environmentId} />}
            >
              {project.name}
            </DetailRow>
          ) : null}
          {environmentLabel ? (
            <DetailRow icon={<ServerIcon className="size-3.5" />}>{environmentLabel}</DetailRow>
          ) : null}
          {thread.branch || worktreeName ? (
            <DetailRow icon={<GitBranchIcon className="size-3.5" />}>
              {thread.branch ?? worktreeName}
              {worktreeName && thread.branch ? (
                <span className="ml-1.5 text-muted-foreground/50">worktree</span>
              ) : null}
            </DetailRow>
          ) : null}
          {ProviderIcon || modelLabel || providerLabel ? (
            <DetailRow icon={ProviderIcon ? <ProviderIcon className="size-3.5" /> : null}>
              {modelLabel ?? providerLabel}
            </DetailRow>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Groups thread hover cards so a list behaves like one surface.
 *
 * The delay is there to stop a card firing while the pointer is only crossing
 * the list on its way elsewhere. Once one card is open that intent is no longer
 * in doubt, so neighbouring rows swap instantly, and `timeout` keeps the group
 * warm briefly after the last one closes.
 */
export function ThreadHoverCardGroup({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delay={280} closeDelay={120} timeout={600}>
      {children}
    </TooltipProvider>
  );
}
