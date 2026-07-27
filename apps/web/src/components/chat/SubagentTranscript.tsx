import {
  type EnvironmentId,
  type ProviderSubagentTranscriptEntry,
  type ProviderSubagentTranscriptResult,
  type ThreadId,
} from "@threadlines/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { requireEnvironmentConnection } from "../../environments/runtime/service";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

const TRANSCRIPT_PAGE_SIZE = 80;
const LIVE_REFRESH_INTERVAL_MS = 2_000;
const BOTTOM_STICK_THRESHOLD_PX = 24;

type SubagentTranscriptFetchState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "loaded";
      readonly sections: ReadonlyArray<{
        readonly agentId: string;
        readonly result: ProviderSubagentTranscriptResult;
      }>;
    };

interface SubagentTranscriptProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  agentIds: ReadonlyArray<string>;
  follow?: boolean;
  scrollable?: boolean;
  className?: string;
}

function transcriptPageOffset(result: ProviderSubagentTranscriptResult): number | null {
  return result.offset ?? null;
}

function transcriptPageTotal(result: ProviderSubagentTranscriptResult): number | null {
  return result.totalEntries ?? null;
}

function mergeTranscriptPages(
  current: ProviderSubagentTranscriptResult,
  incoming: ProviderSubagentTranscriptResult,
): ProviderSubagentTranscriptResult {
  const currentOffset = transcriptPageOffset(current);
  const incomingOffset = transcriptPageOffset(incoming);
  if (currentOffset === null || incomingOffset === null) {
    return incoming;
  }

  const currentEnd = currentOffset + current.entries.length;
  const incomingEnd = incomingOffset + incoming.entries.length;
  if (incomingOffset > currentEnd || currentOffset > incomingEnd) {
    return incoming;
  }

  const offset = Math.min(currentOffset, incomingOffset);
  const end = Math.max(currentEnd, incomingEnd);
  const entries: Array<ProviderSubagentTranscriptEntry | undefined> = Array.from({
    length: end - offset,
  });
  current.entries.forEach((entry, index) => {
    entries[currentOffset - offset + index] = entry;
  });
  incoming.entries.forEach((entry, index) => {
    entries[incomingOffset - offset + index] = entry;
  });
  if (entries.some((entry) => entry === undefined)) {
    return incoming;
  }

  const totalEntries = Math.max(
    transcriptPageTotal(current) ?? currentEnd,
    transcriptPageTotal(incoming) ?? incomingEnd,
  );
  return {
    entries: entries as ProviderSubagentTranscriptEntry[],
    truncated: offset > 0 || end < totalEntries,
    offset,
    totalEntries,
  };
}

function mergeTranscriptSections(
  current: ReadonlyArray<{
    readonly agentId: string;
    readonly result: ProviderSubagentTranscriptResult;
  }>,
  incoming: ReadonlyArray<{
    readonly agentId: string;
    readonly result: ProviderSubagentTranscriptResult;
  }>,
) {
  const currentByAgentId = new Map(current.map((section) => [section.agentId, section]));
  return incoming.map((section) => {
    const existing = currentByAgentId.get(section.agentId);
    return existing
      ? { ...section, result: mergeTranscriptPages(existing.result, section.result) }
      : section;
  });
}

function transcriptRevision(
  sections: ReadonlyArray<{
    readonly agentId: string;
    readonly result: ProviderSubagentTranscriptResult;
  }>,
): string {
  return sections
    .map((section) => {
      const lastEntry = section.result.entries.at(-1);
      return [
        section.agentId,
        section.result.offset ?? 0,
        section.result.totalEntries ?? section.result.entries.length,
        lastEntry?.role ?? "",
        lastEntry?.text ?? "",
        lastEntry?.outputPreview ?? "",
        lastEntry?.toolUses.map((toolUse) => `${toolUse.name}:${toolUse.summary}`).join("|") ?? "",
      ].join("\u0000");
    })
    .join("\u0001");
}

function keyedTranscriptToolUses(
  toolUses: ProviderSubagentTranscriptEntry["toolUses"],
): ReadonlyArray<{
  readonly key: string;
  readonly toolUse: ProviderSubagentTranscriptEntry["toolUses"][number];
}> {
  const occurrences = new Map<string, number>();
  return toolUses.map((toolUse) => {
    const contentKey = `${toolUse.name}\u0000${toolUse.summary}`;
    const occurrence = occurrences.get(contentKey) ?? 0;
    occurrences.set(contentKey, occurrence + 1);
    return {
      key: `${contentKey}\u0000${occurrence}`,
      toolUse,
    };
  });
}

/** Lazily reads the provider-owned, read-only conversation for one or more
 * spawned agents. The server validates that every agent belongs to threadId. */
export function SubagentTranscript({
  environmentId,
  threadId,
  agentIds,
  follow = false,
  scrollable = false,
  className,
}: SubagentTranscriptProps) {
  const [state, setState] = useState<SubagentTranscriptFetchState>({ status: "loading" });
  const [loadingEarlierAgentId, setLoadingEarlierAgentId] = useState<string | null>(null);
  const [earlierLoadError, setEarlierLoadError] = useState<string | null>(null);
  const [hasUnseenUpdates, setHasUnseenUpdates] = useState(false);
  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const sticksToBottomRef = useRef(true);
  const previousRevisionRef = useRef<string | null>(null);
  const prependScrollHeightRef = useRef<number | null>(null);
  const agentIdsKey = agentIds.join("\u0000");

  useEffect(() => {
    const requestedAgentIds = agentIdsKey.split("\u0000").filter((agentId) => agentId.length > 0);
    let cancelled = false;
    let refreshTimeoutId: ReturnType<typeof setTimeout> | null = null;
    setState({ status: "loading" });

    const readLatestSections = async () => {
      const connection = requireEnvironmentConnection(environmentId);
      const sections: Array<{ agentId: string; result: ProviderSubagentTranscriptResult }> = [];
      for (const agentId of requestedAgentIds) {
        const result = await connection.client.server.readSubagentTranscript({
          threadId,
          agentId,
          limit: TRANSCRIPT_PAGE_SIZE,
          fromEnd: true,
        });
        sections.push({ agentId, result });
      }
      return sections;
    };

    const scheduleRefresh = () => {
      if (!follow || cancelled) {
        return;
      }
      refreshTimeoutId = setTimeout(() => {
        if (typeof document !== "undefined" && document.visibilityState === "hidden") {
          scheduleRefresh();
          return;
        }
        void readLatestSections()
          .then((sections) => {
            if (cancelled) {
              return;
            }
            setState((current) =>
              current.status === "loaded"
                ? {
                    status: "loaded",
                    sections: mergeTranscriptSections(current.sections, sections),
                  }
                : { status: "loaded", sections },
            );
          })
          .catch((cause: unknown) => {
            if (!cancelled) {
              setState((current) =>
                current.status === "loaded"
                  ? current
                  : {
                      status: "error",
                      message:
                        cause instanceof Error && cause.message.trim().length > 0
                          ? cause.message
                          : "Failed to load the subagent transcript.",
                    },
              );
            }
          })
          .finally(scheduleRefresh);
      }, LIVE_REFRESH_INTERVAL_MS);
    };

    void (async () => {
      try {
        const sections = await readLatestSections();
        if (!cancelled) {
          setState({ status: "loaded", sections });
        }
      } catch (cause) {
        if (!cancelled) {
          setState({
            status: "error",
            message:
              cause instanceof Error && cause.message.trim().length > 0
                ? cause.message
                : "Failed to load the subagent transcript.",
          });
        }
      } finally {
        scheduleRefresh();
      }
    })();
    return () => {
      cancelled = true;
      if (refreshTimeoutId !== null) {
        clearTimeout(refreshTimeoutId);
      }
    };
  }, [agentIdsKey, environmentId, follow, threadId]);

  const revision = useMemo(
    () => (state.status === "loaded" ? transcriptRevision(state.sections) : state.status),
    [state],
  );

  useLayoutEffect(() => {
    if (!scrollable) {
      return;
    }
    const element = scrollElementRef.current;
    if (!element) {
      return;
    }
    const previousRevision = previousRevisionRef.current;
    previousRevisionRef.current = revision;
    if (prependScrollHeightRef.current !== null) {
      element.scrollTop += element.scrollHeight - prependScrollHeightRef.current;
      prependScrollHeightRef.current = null;
    } else if (sticksToBottomRef.current) {
      element.scrollTop = element.scrollHeight;
      setHasUnseenUpdates(false);
    } else if (previousRevision !== null && previousRevision !== revision) {
      setHasUnseenUpdates(true);
    }
  }, [revision, scrollable]);

  const handleTranscriptScroll = useCallback(() => {
    const element = scrollElementRef.current;
    if (!element) {
      return;
    }
    const sticksToBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_STICK_THRESHOLD_PX;
    sticksToBottomRef.current = sticksToBottom;
    if (sticksToBottom) {
      setHasUnseenUpdates(false);
    }
  }, []);

  const jumpToLatest = useCallback(() => {
    const element = scrollElementRef.current;
    if (!element) {
      return;
    }
    sticksToBottomRef.current = true;
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    setHasUnseenUpdates(false);
  }, []);

  const loadEarlier = useCallback(
    async (agentId: string, result: ProviderSubagentTranscriptResult) => {
      const currentOffset = transcriptPageOffset(result);
      if (currentOffset === null || currentOffset === 0 || loadingEarlierAgentId !== null) {
        return;
      }
      const offset = Math.max(0, currentOffset - TRANSCRIPT_PAGE_SIZE);
      prependScrollHeightRef.current = scrollElementRef.current?.scrollHeight ?? null;
      setLoadingEarlierAgentId(agentId);
      setEarlierLoadError(null);
      try {
        const connection = requireEnvironmentConnection(environmentId);
        const earlierResult = await connection.client.server.readSubagentTranscript({
          threadId,
          agentId,
          offset,
          limit: currentOffset - offset,
        });
        setState((current) =>
          current.status !== "loaded"
            ? current
            : {
                status: "loaded",
                sections: current.sections.map((section) =>
                  section.agentId === agentId
                    ? {
                        ...section,
                        result: mergeTranscriptPages(section.result, earlierResult),
                      }
                    : section,
                ),
              },
        );
      } catch (cause) {
        prependScrollHeightRef.current = null;
        setEarlierLoadError(
          cause instanceof Error && cause.message.trim().length > 0
            ? cause.message
            : "Failed to load earlier transcript entries.",
        );
      } finally {
        setLoadingEarlierAgentId(null);
      }
    },
    [environmentId, loadingEarlierAgentId, threadId],
  );

  return (
    <div className={cn("relative", scrollable && "flex min-h-0 flex-1 flex-col", className)}>
      <div
        ref={scrollElementRef}
        className={cn(scrollable && "min-h-0 flex-1 overflow-y-auto px-3 py-2.5")}
        data-subagent-transcript="true"
        onScroll={scrollable ? handleTranscriptScroll : undefined}
      >
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="text-[10px] font-medium tracking-[0.08em] text-muted-foreground/55 uppercase">
            Read-only transcript
          </p>
          {follow ? (
            <span
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/60"
              data-subagent-transcript-following="true"
            >
              <span className="size-1.5 animate-pulse rounded-full bg-primary/70 motion-reduce:animate-none" />
              Following live
            </span>
          ) : null}
        </div>
        {state.status === "loading" ? (
          <p className="text-[11px] text-muted-foreground/60">Loading transcript...</p>
        ) : state.status === "error" ? (
          <p className="text-[11px] text-muted-foreground/60" data-subagent-transcript-error="true">
            {state.message}
          </p>
        ) : (
          state.sections.map((section) => (
            <div key={section.agentId} className="space-y-1.5">
              {(section.result.offset ?? 0) > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="h-6 px-1.5 text-[10px] text-muted-foreground/70"
                  disabled={loadingEarlierAgentId !== null}
                  onClick={() => void loadEarlier(section.agentId, section.result)}
                >
                  {loadingEarlierAgentId === section.agentId ? "Loading earlier…" : "Load earlier"}
                </Button>
              ) : null}
              {earlierLoadError ? (
                <p className="text-[10px] text-destructive/80">{earlierLoadError}</p>
              ) : null}
              {state.sections.length > 1 ? (
                <p className="font-mono text-[10px] text-muted-foreground/50">
                  Agent {section.agentId}
                </p>
              ) : null}
              {section.result.entries.map((entry, entryIndex) => {
                const entryPosition = (section.result.offset ?? 0) + entryIndex;
                return (
                  <div
                    key={`${section.agentId}:${entryPosition}`}
                    data-subagent-transcript-entry={entry.role}
                  >
                    {entry.role === "thinking" ? (
                      <p className="text-[11px] leading-4 text-muted-foreground/50 italic">
                        {entry.text}
                      </p>
                    ) : entry.text.length > 0 ? (
                      <p className="text-[11px] leading-4 whitespace-pre-wrap wrap-break-word">
                        <span className="mr-1 text-[9px] tracking-[0.08em] text-muted-foreground/50 uppercase">
                          {entry.role}
                        </span>
                        {entry.text}
                      </p>
                    ) : null}
                    {entry.toolUses.length > 0 ? (
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {keyedTranscriptToolUses(entry.toolUses).map(({ key, toolUse }) => (
                          <span
                            key={`${section.agentId}:${entryPosition}:${key}`}
                            className="inline-flex max-w-full items-center rounded border border-border/55 bg-background/60 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground/75"
                            title={toolUse.summary || toolUse.name}
                          >
                            <span className="min-w-0 truncate">
                              {toolUse.summary
                                ? `${toolUse.name}: ${toolUse.summary}`
                                : toolUse.name}
                            </span>
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {entry.outputPreview ? (
                      <pre className="mt-0.5 max-h-40 overflow-y-auto rounded-md border border-border/45 bg-background/70 px-2 py-1 font-mono text-[10px] leading-4 whitespace-pre-wrap wrap-break-word text-muted-foreground/70">
                        {entry.outputPreview}
                      </pre>
                    ) : null}
                  </div>
                );
              })}
              {section.result.truncated && section.result.offset === undefined ? (
                <p className="text-[10px] text-muted-foreground/50">
                  Transcript truncated to {section.result.entries.length} entries.
                </p>
              ) : null}
              {section.result.entries.length === 0 ? (
                <p className="text-[11px] text-muted-foreground/60">
                  No transcript entries available yet.
                </p>
              ) : null}
            </div>
          ))
        )}
        {hasUnseenUpdates ? (
          <div className="sticky bottom-2 mt-2 flex justify-center">
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="h-7 bg-popover px-2 text-[10px]"
              onClick={jumpToLatest}
            >
              Jump to latest
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
