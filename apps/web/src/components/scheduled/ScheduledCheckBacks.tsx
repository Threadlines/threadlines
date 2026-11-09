import { scopeThreadRef } from "@threadlines/client-runtime";
import { ChevronRightIcon, Clock3Icon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { SidebarThreadSummary } from "../../types";
import { cancelCheckBack } from "../chat/cancelCheckBack";
import { describeCheckBack } from "../chat/checkBacks";
import { SETTINGS_GROUP_ROW_CLASS, SettingsSection } from "../settings/settingsLayout";
import { ThreadEnvironmentBadge } from "../sidebar/InboxRows";
import { Button } from "../ui/button";
import { useCloseSidebarSheet } from "../ui/sidebar";
import { failureNotice, toastManager } from "../ui/toast";
import type { CheckBackThread } from "./scheduled.logic";
import { useCheckBackAgentName, useCheckBackThreads, useProjectNames } from "./useScheduledPage";

type ListedCheckBack = CheckBackThread<SidebarThreadSummary>;

const CANCEL_TOOLTIP =
  "Stops this agent's session, which ends every check-back it set. It starts again when you send a message.";

/** Opens the thread a check-back will come back to. */
function useOpenThread(): (thread: SidebarThreadSummary) => void {
  const navigate = useNavigate();
  return useCallback(
    (thread) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
      }),
    [navigate],
  );
}

const checkBackKey = ({ thread }: ListedCheckBack) => `${thread.environmentId}:${thread.id}`;

function CheckBackOverviewRow({
  entry,
  nowMs,
}: {
  readonly entry: ListedCheckBack;
  readonly nowMs: number;
}) {
  const { thread, soonest, more } = entry;
  const projectName = useProjectNames();
  const openThread = useOpenThread();
  const agentName = useCheckBackAgentName(thread.environmentId, thread.id, soonest.participantId);
  const [pending, setPending] = useState(false);
  const { label, when } = describeCheckBack(soonest, nowMs);
  const meta = [
    projectName(thread.environmentId, thread.projectId),
    agentName,
    more > 0 ? `and ${more} more` : null,
  ].filter((part) => part !== null);
  return (
    <div
      className={cn(SETTINGS_GROUP_ROW_CLASS, "flex items-center gap-3 px-3.5 py-2.5")}
      data-testid={`scheduled-check-back-${thread.id}`}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md text-left focus-ring"
        onClick={() => openThread(thread)}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-[13.5px] leading-[19px] font-medium text-foreground">
              {thread.title}
            </span>
            <span className="min-w-0 truncate text-[12.5px] text-muted-foreground">{label}</span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] leading-[18px] text-muted-foreground">
            <ThreadEnvironmentBadge thread={thread} />
            <span className="min-w-0 truncate">{meta.join(" · ")}</span>
          </span>
          {soonest.description ? (
            <span className="truncate text-[12px] leading-[17px] text-muted-foreground">
              {soonest.description}
            </span>
          ) : null}
          <span className="truncate font-mono text-[11px] text-muted-foreground sm:hidden">
            {when}
          </span>
        </span>
        <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground sm:block">
          {when}
        </span>
        <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {/* One saved to the project outlives the agent's session, so stopping
          the session can't end it: no Cancel, as in the chat. */}
      {soonest.durable ? null : (
        <Button
          size="xs"
          variant="outline"
          disabled={pending}
          tooltip={CANCEL_TOOLTIP}
          aria-label={`Cancel the check-back in ${thread.title}`}
          data-testid={`scheduled-check-back-cancel-${thread.id}`}
          onClick={() => {
            setPending(true);
            void cancelCheckBack({
              environmentId: thread.environmentId,
              threadId: thread.id,
              session: thread.session,
              checkBack: soonest,
            })
              .catch((error: unknown) => {
                toastManager.add(failureNotice({ title: "Couldn't cancel the check-back", error }));
              })
              .finally(() => setPending(false));
          }}
        >
          Cancel
        </Button>
      )}
    </div>
  );
}

/**
 * The Scheduled page's other half: threads an agent set itself to come back
 * to (check-backs), soonest first, on every connected computer. A row opens
 * its thread; Cancel ends it as the chat's line does. Nothing shows while
 * there are none.
 */
export function CheckBacksSection({ className }: { readonly className?: string }) {
  const nowMs = useRelativeTimeTick(30_000);
  const entries = useCheckBackThreads();
  if (entries.length === 0) return null;
  return (
    <SettingsSection
      title="Check-backs"
      description="Threads an agent will come back to by itself, while Threadlines is running."
      className={className}
      data-testid="scheduled-check-backs"
    >
      {entries.map((entry) => (
        <CheckBackOverviewRow key={checkBackKey(entry)} entry={entry} nowMs={nowMs} />
      ))}
    </SettingsSection>
  );
}

/** The list beside the rail: each thread an agent will come back to, and when. */
export function CheckBacksListSection() {
  const nowMs = useRelativeTimeTick(30_000);
  const entries = useCheckBackThreads();
  const openThread = useOpenThread();
  // On a phone the list is a sheet over the page: choosing a thread closes it.
  const closeSheet = useCloseSidebarSheet();
  if (entries.length === 0) return null;
  return (
    <section className="flex flex-col" data-testid="scheduled-list-check-backs">
      <h3 className="truncate px-2 pt-2.5 pb-1 text-[11px] font-medium text-muted-foreground">
        Check-backs
      </h3>
      <ul className="flex flex-col gap-0.5">
        {entries.map((entry) => {
          const { thread, soonest, more } = entry;
          const { label, when } = describeCheckBack(soonest, nowMs);
          return (
            <li key={checkBackKey(entry)}>
              <button
                type="button"
                data-testid={`scheduled-list-check-back-${thread.id}`}
                className="flex w-full min-w-0 cursor-pointer flex-col rounded-lg px-2 py-1.5 text-left transition-colors select-none focus-ring hover:bg-sidebar-accent/60 active:bg-sidebar-accent/80"
                onClick={() => {
                  closeSheet();
                  openThread(thread);
                }}
              >
                <span className="min-w-0 truncate text-[13.5px] leading-[19px] font-medium text-foreground">
                  {thread.title}
                </span>
                <span className="truncate text-[12px] leading-[17px] text-muted-foreground">
                  {label}
                </span>
                <span className="flex min-w-0 items-center gap-1 font-mono text-[10.5px] leading-4 text-muted-foreground">
                  <Clock3Icon aria-hidden="true" className="size-2.5 shrink-0" />
                  <span className="truncate">{more > 0 ? `${when} · and ${more} more` : when}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
