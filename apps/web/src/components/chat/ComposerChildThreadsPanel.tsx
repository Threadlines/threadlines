import type { ScopedThreadRef } from "@threadlines/contracts";
import { ChevronRightIcon } from "lucide-react";
import { memo, useState } from "react";

import type { PendingChildThreads } from "~/childThreads";
import { readEnvironmentApi } from "~/environmentApi";
import { cn, newCommandId } from "~/lib/utils";
import { formatChildThreadCount } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

/**
 * An agent asks to start threads of its own (child threads, "Ask me first").
 * Docked above the message box like an invite: the box stays usable, so the
 * user can answer or write something else first. Each line names the thread,
 * the agent it runs on, and where it works.
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
      toastManager.add({ type: "error", title: "This computer is not connected." });
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
      toastManager.add({
        type: "error",
        title: choice === "start" ? "Could not start the threads" : "Could not answer the agent",
        description: error instanceof Error ? error.message : String(error),
      });
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
              className="flex min-w-0 items-center gap-2 text-sm"
              data-testid="child-threads-panel-thread"
            >
              <span className="min-w-0 truncate text-foreground">{thread.title}</span>
              <span className="ms-auto flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                {thread.entry ? (
                  <ProviderInstanceIcon
                    driverKind={thread.entry.driverKind}
                    displayName={thread.entry.displayName}
                    accentColor={thread.entry.accentColor}
                    showBadge={false}
                    className="size-3"
                    iconClassName="size-3"
                  />
                ) : null}
                <span className="max-w-40 truncate">{thread.modelName}</span>
                <span className="text-muted-foreground/50">·</span>
                <span>{thread.ownWorktree ? "own worktree" : "shares this folder"}</span>
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
