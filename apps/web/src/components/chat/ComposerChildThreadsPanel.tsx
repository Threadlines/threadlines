import type { ScopedThreadRef } from "@threadlines/contracts";
import { ChevronRightIcon } from "lucide-react";
import { memo, useState } from "react";

import type { PendingChildThreads } from "~/childThreads";
import { readEnvironmentApi } from "~/environmentApi";
import { cn, newCommandId } from "~/lib/utils";
import { formatChildThreadCount } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { failureNotice, toastManager } from "../ui/toast";
import { addComputerNotConnectedNotice } from "../computerConnectionNotices";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

/**
 * Where a thread that gets no worktree of its own would work: another
 * thread's checkout, or the asking thread's (`title` null). A long title is
 * cut short, never the words around it, so the line always says "checkout".
 */
function ChildThreadCheckoutLabel(props: { title: string | null }) {
  if (props.title === null) {
    return <span data-child-thread-checkout>in this thread's checkout</span>;
  }
  return (
    <span className="flex min-w-0 items-baseline" data-child-thread-checkout>
      <span className="shrink-0">in&nbsp;</span>
      <span className="max-w-28 truncate" title={props.title}>
        {props.title}
      </span>
      <span className="shrink-0">'s checkout</span>
    </span>
  );
}

/**
 * An agent asks to start threads of its own (child threads, "Ask me first").
 * Docked above the message box like an invite: the box stays usable, so the
 * user can answer or write something else first. Each line names the thread,
 * the agent it runs on and at what reasoning, and where it works.
 */
export const ComposerChildThreadsPanel = memo(function ComposerChildThreadsPanel(props: {
  threadRef: ScopedThreadRef;
  request: PendingChildThreads;
}) {
  const { request } = props;
  const [responding, setResponding] = useState(false);
  const [showPrompts, setShowPrompts] = useState(false);

  const respond = async (choice: "start" | "decline") => {
    const api = readEnvironmentApi(props.threadRef.environmentId);
    if (!api) {
      addComputerNotConnectedNotice({
        environmentId: props.threadRef.environmentId,
        fallbackLabel: "This computer",
      });
      return;
    }
    setResponding(true);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.child-request.respond",
        commandId: newCommandId(),
        threadId: props.threadRef.threadId,
        batchId: request.batchId,
        choice,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      toastManager.add(
        failureNotice({
          title: choice === "start" ? "Couldn't start the threads" : "Couldn't answer the agent",
          error,
        }),
      );
    } finally {
      setResponding(false);
    }
  };

  const count = formatChildThreadCount(request.threads.length);
  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4" data-testid="child-threads-panel">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm tracking-[0.2em] uppercase">Agent request</span>
          <span className="text-sm font-medium" data-testid="child-threads-panel-heading">
            {request.fromName} wants to start {count}
          </span>
        </div>
        <ul className="space-y-1">
          {request.threads.map((thread) => (
            <li
              key={thread.requestId}
              className={cn(
                "flex min-w-0 items-center gap-x-2 gap-y-0.5 text-sm",
                // Whose checkout it shares is a longer line: where the two
                // don't fit side by side (a phone), it goes under the title.
                thread.checkout !== null && "flex-wrap",
              )}
              data-testid="child-threads-panel-thread"
            >
              <span className="min-w-0 truncate text-foreground">{thread.title}</span>
              <span
                className={cn(
                  "ms-auto flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground",
                  thread.checkout !== null ? "max-w-full min-w-0" : "shrink-0",
                )}
              >
                {thread.entry ? (
                  <ProviderInstanceIcon
                    instanceId={thread.entry.instanceId}
                    driverKind={thread.entry.driverKind}
                    displayName={thread.entry.displayName}
                    accentColor={thread.entry.accentColor}
                    showBadge={false}
                    className="size-3"
                    iconClassName="size-3"
                  />
                ) : null}
                <span className="max-w-40 shrink-0 truncate">{thread.modelName}</span>
                {thread.reasoning !== null ? (
                  <>
                    <span className="text-muted-foreground/50">·</span>
                    <span data-child-thread-reasoning>{thread.reasoning}</span>
                  </>
                ) : null}
                {thread.access !== null ? (
                  <>
                    <span className="text-muted-foreground/50">·</span>
                    <span className="shrink-0" data-child-thread-access>
                      {thread.access}
                    </span>
                  </>
                ) : null}
                <span className="text-muted-foreground/50">·</span>
                {thread.computer !== null ? (
                  <span>on {thread.computer}</span>
                ) : thread.checkout !== null ? (
                  <ChildThreadCheckoutLabel title={thread.checkout.title} />
                ) : (
                  <span>{thread.ownWorktree ? "own worktree" : "shares this folder"}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={showPrompts}
          onClick={() => setShowPrompts((shown) => !shown)}
        >
          <ChevronRightIcon
            className={cn("size-3.5 transition-transform", showPrompts && "rotate-90")}
          />
          What each will be asked
        </button>
        {showPrompts ? (
          <div className="max-h-48 space-y-2 overflow-y-auto border-l border-border pl-3">
            {request.threads.map((thread) => (
              <div key={thread.requestId}>
                <p className="text-xs font-medium text-foreground/85">{thread.title}</p>
                <p className="text-sm whitespace-pre-wrap break-words text-muted-foreground">
                  {thread.prompt}
                </p>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={responding}
          onClick={() => void respond("decline")}
        >
          Not now
        </Button>
        <Button
          size="sm"
          variant="default"
          disabled={responding}
          onClick={() => void respond("start")}
        >
          Start
        </Button>
      </div>
    </div>
  );
});
