/**
 * What tells a user what a lead chat is (docs/design/lead-chat.md, "Saying
 * what a lead is"): the crown's card, which explains a lead where its crown
 * shows, and the suggestion under the family tabs, which offers one the first
 * time a thread in a project with no lead starts threads of its own.
 * Nothing here makes a lead without the user asking.
 */
import { scopedProjectKey, scopeProjectRef } from "@threadlines/client-runtime";
import type { ScopedThreadRef } from "@threadlines/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { CrownIcon, XIcon } from "lucide-react";
import { type ReactElement, useCallback, useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { LEAD_CHAT_EXPLANATION, readLeadMenuState, setProjectLead } from "../../leadChat";
import { useComputerConfig } from "../../newThreadDefaults";
import { projectBriefLocation, useProjectBriefSupport } from "../../projectBrief";
import { selectProjectByRef, selectSidebarThreadSummaryByRef, useStore } from "../../store";
import { Button } from "../ui/button";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/previewCard";

/** How long the pointer rests on a crown before its card opens: tabs are crossed often. */
const LEAD_CARD_DELAY_MS = 400;

/** The thread's project, while the thread is in view. */
function useThreadProject(threadRef: ScopedThreadRef) {
  return useStore((state) => selectSidebarThreadSummaryByRef(state, threadRef)?.projectId ?? null);
}

/**
 * The crown's card: what a lead chat does, and the way out. Opens on hover,
 * and on a press of the trigger (`renderTrigger` gets `showCard` for that),
 * which is how a phone, which never hovers, reaches it.
 */
export function LeadChatCard({
  threadRef,
  renderTrigger,
}: {
  threadRef: ScopedThreadRef;
  renderTrigger: (showCard: () => void) => ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const projectId = useThreadProject(threadRef);
  const showCard = useCallback(() => setOpen(true), []);
  const navigate = useNavigate();
  // The lead's project's brief, where its computer keeps one.
  const projectCwd = useStore((state) =>
    projectId === null
      ? null
      : (selectProjectByRef(state, scopeProjectRef(threadRef.environmentId, projectId))?.cwd ??
        null),
  );
  const briefSupported = useProjectBriefSupport()(threadRef.environmentId);
  return (
    <PreviewCard open={open} onOpenChange={setOpen}>
      <PreviewCardTrigger
        delay={LEAD_CARD_DELAY_MS}
        closeDelay={120}
        render={renderTrigger(showCard)}
      />
      <PreviewCardPopup
        side="bottom"
        align="start"
        sideOffset={6}
        className="w-72 px-3.5 py-3"
        data-testid="lead-chat-card"
      >
        <div className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
          <CrownIcon aria-hidden="true" className="size-3.5 shrink-0" />
          Lead chat
        </div>
        <p className="mt-1 text-xs leading-normal text-muted-foreground">{LEAD_CHAT_EXPLANATION}</p>
        {projectId !== null ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {projectCwd !== null && briefSupported ? (
              <button
                type="button"
                data-testid="lead-chat-card-brief"
                className="rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground focus-ring"
                onClick={() => {
                  setOpen(false);
                  void navigate(
                    projectBriefLocation({
                      environmentId: threadRef.environmentId,
                      cwd: projectCwd,
                    }),
                  );
                }}
              >
                Brief and notes
              </button>
            ) : null}
            <button
              type="button"
              data-testid="lead-chat-card-stop"
              className="rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground focus-ring"
              onClick={() => {
                setOpen(false);
                void setProjectLead({
                  environmentId: threadRef.environmentId,
                  projectId,
                  threadId: null,
                });
              }}
            >
              Stop using as lead chat
            </button>
          </div>
        ) : null}
      </PreviewCardPopup>
    </PreviewCard>
  );
}

/** One key per project, so two windows closing it for different projects can't undo each other. */
const leadSuggestionDismissedKey = (projectKey: string | null) =>
  `threadlines:lead-chat-suggestion-dismissed:v1:${projectKey ?? ""}`;

/**
 * The line under the family tabs that offers to make their parent the lead
 * chat: shown on the parent, while its project has no lead and it could be
 * one. Closing it (or taking it) keeps it away from that project on this
 * device for good.
 */
export function LeadChatSuggestion({ parentRef }: { parentRef: ScopedThreadRef }) {
  const projectId = useThreadProject(parentRef);
  const projectKey =
    projectId === null
      ? null
      : scopedProjectKey(scopeProjectRef(parentRef.environmentId, projectId));
  const [dismissed, setDismissed] = useLocalStorage(
    leadSuggestionDismissedKey(projectKey),
    false,
    Schema.Boolean,
  );
  // The computer's settings can refuse a lead ("Agents can start threads"
  // off); they live outside the thread store, so a change there redraws this.
  useComputerConfig(parentRef.environmentId);
  // Only a project with no lead, and only a thread that could lead it now.
  const offered = useStore((state) => {
    const thread = selectSidebarThreadSummaryByRef(state, parentRef);
    if (thread === undefined || thread === null) return false;
    const lead = readLeadMenuState(state, thread);
    return lead?.kind === "make" && lead.replacingTitle === null && lead.refusal === null;
  });
  if (!offered || projectKey === null || projectId === null || dismissed) {
    return null;
  }
  const dismiss = () => setDismissed(true);
  return (
    <div
      data-testid="lead-chat-suggestion"
      className="mx-3 mt-1.5 mb-1 flex items-center gap-2.5 rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground sm:mx-5"
    >
      <CrownIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        This thread is running other threads. Make it the lead chat and it stays on top and hands
        out new work by itself.
      </span>
      <Button
        size="xs"
        variant="outline"
        data-testid="lead-chat-suggestion-make"
        onClick={() => {
          dismiss();
          void setProjectLead({
            environmentId: parentRef.environmentId,
            projectId,
            threadId: parentRef.threadId,
          });
        }}
      >
        Make lead chat
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Don't suggest a lead chat for this project again"
        data-testid="lead-chat-suggestion-dismiss"
        className="text-muted-foreground"
        onClick={dismiss}
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
}
