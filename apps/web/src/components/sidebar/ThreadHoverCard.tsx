import { scopeProjectRef, scopeThreadRef } from "@threadlines/client-runtime";
import { GitBranchIcon, LaptopIcon, ServerIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { PROVIDER_OPTIONS } from "../../session-logic";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { selectProjectByRef, useStore } from "../../store";
import { useGitStatus } from "../../lib/gitStatusState";
import { resolveThreadWorkingCwd } from "@threadlines/shared/threadCwd";
import { createThreadSelectorByRef } from "../../storeSelectors";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { SidebarThreadSummary } from "../../types";
import type { ThreadStatusPill } from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  HOVER_CARD_POPUP_CLASS_NAME,
  HoverCardDetailRow,
  HoverCardDetails,
  HoverCardStatusLine,
  HoverCardTitle,
} from "./hoverCard";

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
  const backingProject = useStore((state) => selectProjectByRef(state, projectRef));
  // General chats are backed by a hidden project. Surfacing it here would put
  // "General Chats" in front of the user as though they had chosen it.
  const project = backingProject?.kind === "general-chat" ? undefined : backingProject;
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
  // The machine the work runs on, named whenever we know its name -- local
  // included. "Which box is this on" is the question a hover card exists for.
  const environmentLabel = runtimeLabel ?? savedLabel ?? (isRemote ? "Remote" : null);

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
  // The row prints only a pinned branch; here there is room to answer the
  // question a branchless thread leaves open -- which ref its checkout is on.
  const gitStatus = useGitStatus({
    environmentId: thread.environmentId,
    cwd: resolveThreadWorkingCwd({
      projectCwd: backingProject?.cwd ?? null,
      worktreePath: thread.worktreePath,
      effectiveCwd: thread.effectiveCwd,
    }),
  });
  const checkoutRef = gitStatus.data?.refName ?? null;
  const branch = thread.branch ?? checkoutRef;
  // Two different facts share one row, so the row says which one it is: a
  // pinned branch belongs to the thread, a checkout ref just happens to be
  // where its working copy sits right now.
  const isCheckoutRef = thread.branch === null && checkoutRef !== null;

  return (
    <Tooltip>
      <TooltipTrigger render={children as never} />
      <TooltipPopup
        side={side}
        sideOffset={8}
        align="start"
        className={HOVER_CARD_POPUP_CLASS_NAME}
        data-testid="thread-hover-card"
      >
        <HoverCardTitle>{thread.title}</HoverCardTitle>
        <HoverCardStatusLine status={status} timestamp={formatRelativeTimeLabel(activityAt)} />
        <HoverCardDetails>
          {project ? (
            <HoverCardDetailRow
              icon={<ProjectFavicon cwd={project.cwd} environmentId={project.environmentId} />}
            >
              {project.name}
            </HoverCardDetailRow>
          ) : null}
          {environmentLabel ? (
            <HoverCardDetailRow
              icon={
                isRemote ? <ServerIcon className="size-3.5" /> : <LaptopIcon className="size-3.5" />
              }
            >
              {environmentLabel}
            </HoverCardDetailRow>
          ) : null}
          {branch || worktreeName ? (
            <HoverCardDetailRow
              className="font-mono text-[11px]"
              icon={<GitBranchIcon className="size-3.5" />}
            >
              {branch ?? worktreeName}
              {/* A real space, not a margin: the annotation has to read as
                  part of the sentence to a screen reader too. */}
              {isCheckoutRef ? (
                <span className="font-sans text-muted-foreground/50">{" · checkout"}</span>
              ) : null}
              {worktreeName && branch ? (
                <span className="font-sans text-muted-foreground/50">{" · worktree"}</span>
              ) : null}
            </HoverCardDetailRow>
          ) : null}
          {ProviderIcon || modelLabel || providerLabel ? (
            <HoverCardDetailRow icon={ProviderIcon ? <ProviderIcon className="size-3.5" /> : null}>
              {modelLabel ?? providerLabel}
            </HoverCardDetailRow>
          ) : null}
        </HoverCardDetails>
      </TooltipPopup>
    </Tooltip>
  );
}
