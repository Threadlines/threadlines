import { scopeThreadRef } from "@threadlines/client-runtime";
import { useNavigate } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { SidebarThreadSummary } from "../../types";
import { ProviderGlyph } from "../chat/ProviderInstanceIcon";
import { ThreadStatusText } from "../sidebar/InboxRows";
import type { FleetThreadInput } from "./fleet.logic";

/** "Started by "Fix the build"", or with the computer when it runs elsewhere. */
export function describeStartedBy(thread: FleetThreadInput): string | null {
  if (thread.startedByTitle === null) return null;
  return thread.startedByComputer === null
    ? `Started by “${thread.startedByTitle}”`
    : `Started by “${thread.startedByTitle}” on ${thread.startedByComputer}`;
}

function FleetThreadRow({
  thread,
  summary,
  modelName,
  onOpen,
}: {
  readonly thread: FleetThreadInput;
  readonly summary: SidebarThreadSummary | undefined;
  readonly modelName: string | null;
  readonly onOpen: () => void;
}) {
  const startedBy = describeStartedBy(thread);
  return (
    <li>
      <button
        type="button"
        data-testid={`fleet-thread-${thread.threadId}`}
        className="-mx-2 flex w-[calc(100%+1rem)] min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-left transition-colors select-none hover:bg-muted focus-ring"
        onClick={onOpen}
      >
        <span
          aria-label={thread.status?.label}
          className={cn("size-[7px] shrink-0 rounded-full", thread.status?.dotClass)}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-[13.5px] leading-[19px] font-medium text-foreground">
              {thread.title}
            </span>
            {thread.projectLabel ? (
              <span className="min-w-0 shrink truncate text-[12.5px] text-muted-foreground">
                {thread.projectLabel}
              </span>
            ) : null}
          </span>
          {startedBy ? (
            <span className="truncate text-[12.5px] leading-[18px] text-muted-foreground">
              {startedBy}
            </span>
          ) : null}
        </span>
        {thread.provider ? (
          <span className="hidden max-w-44 min-w-0 shrink-0 items-center gap-1.5 text-[12.5px] text-muted-foreground sm:flex">
            <ProviderGlyph
              instanceId={thread.provider.instanceId}
              driverKind={thread.provider.driverKind}
              environmentId={thread.environmentId}
              className="size-3.5 shrink-0"
            />
            {modelName ? <span className="truncate">{modelName}</span> : null}
          </span>
        ) : null}
        <span className="flex w-24 shrink-0 justify-end">
          {summary ? (
            <ThreadStatusText
              thread={summary}
              status={thread.status}
              restingClassName="text-muted-foreground"
              testId={`fleet-thread-status-${thread.threadId}`}
            />
          ) : null}
        </span>
      </button>
    </li>
  );
}

/** The threads that need the user or are working, as All computers and a computer's page list them. */
export function FleetThreadList({
  threads,
  summaryByThreadKey,
  modelNameOf,
}: {
  readonly threads: ReadonlyArray<FleetThreadInput>;
  readonly summaryByThreadKey: ReadonlyMap<string, SidebarThreadSummary>;
  readonly modelNameOf: (thread: FleetThreadInput) => string | null;
}) {
  const navigate = useNavigate();
  return (
    <ul className="mt-1.5 flex flex-col divide-y divide-border/60 px-1">
      {threads.map((thread) => (
        <FleetThreadRow
          key={thread.threadKey}
          thread={thread}
          summary={summaryByThreadKey.get(thread.threadKey)}
          modelName={modelNameOf(thread)}
          onOpen={() => {
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.threadId)),
            });
          }}
        />
      ))}
    </ul>
  );
}
