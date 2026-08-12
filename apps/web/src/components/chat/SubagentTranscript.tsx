import {
  type EnvironmentId,
  type ProviderSubagentTranscriptEntry,
  type ProviderSubagentTranscriptResult,
  type ThreadId,
  type TimestampFormat,
} from "@threadlines/contracts";
import {
  type CSSProperties,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ChevronRightIcon } from "lucide-react";

import { useSettings } from "../../hooks/useSettings";
import { formatShortTimestamp } from "../../timestampFormat";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { LiveNode, SectionLabel, SpineRow, spineAccentRowStyle } from "../ui/threadline";
import { readSubagentTranscriptPage } from "./subagentTranscriptClient";
import {
  buildSubagentTranscriptView,
  formatSubagentToolLabel,
  formatSubagentToolPreview,
  formatSubagentToolRunActions,
  groupSubagentTranscriptSteps,
  isSameSubagentTranscriptItem,
  shouldShowSubagentLiveTail,
  splitSubagentTranscriptLead,
  subagentStepNodeOffsetPx,
  type SubagentTranscriptProseItem,
  type SubagentTranscriptStep,
  type SubagentTranscriptToolRun,
  type SubagentTranscriptViewItem,
} from "./SubagentTranscript.logic";
import { formatSubagentDuration } from "./subagentMeta";

const TRANSCRIPT_PAGE_SIZE = 60;
const LIVE_REFRESH_INTERVAL_MS = 1_000;
/** Generous enough that ordinary momentum scrolling near the end keeps
 *  following, small enough that a deliberate scroll up releases. */
const BOTTOM_STICK_THRESHOLD_PX = 48;

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
  /** Working directory used to resolve file references in agent prose. */
  cwd?: string | undefined;
  /** Shown when the provider has no transcript yet, so a just-spawned agent
   *  still says something useful. */
  fallbackBody?: string | null;
  /** Reports the provider's own record of the agent (its id, type and model),
   *  which the spawning tool call does not always carry. */
  onAgentResolved?: (agent: ProviderSubagentTranscriptResult["agent"]) => void;
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
  direction: "refresh" | "earlier" = "refresh",
): ProviderSubagentTranscriptResult {
  const currentOffset = transcriptPageOffset(current);
  const incomingOffset = transcriptPageOffset(incoming);
  if (currentOffset === null || incomingOffset === null) {
    const hasStableIds = [...current.entries, ...incoming.entries].every(
      (entry) => entry.id !== undefined,
    );
    if (!hasStableIds) {
      return incoming;
    }
    // A normal live refresh replaces its bounded newest-page window. Once the
    // user has loaded earlier pages, the current window is larger and must be
    // retained while overlapping newest items are refreshed in place.
    if (direction === "refresh" && current.entries.length <= incoming.entries.length) {
      return incoming;
    }

    const orderedEntries =
      direction === "earlier"
        ? [...incoming.entries, ...current.entries]
        : [...current.entries, ...incoming.entries];
    const entriesById = new Map<string, ProviderSubagentTranscriptEntry>();
    for (const entry of orderedEntries) {
      entriesById.set(entry.id!, entry);
    }
    const nextCursor = direction === "earlier" ? incoming.nextCursor : current.nextCursor;
    return {
      entries: [...entriesById.values()],
      truncated: nextCursor !== undefined,
      ...((current.agent ?? incoming.agent) ? { agent: current.agent ?? incoming.agent } : {}),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
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
    ...((current.agent ?? incoming.agent) ? { agent: current.agent ?? incoming.agent } : {}),
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
        section.result.nextCursor ?? "",
        lastEntry?.id ?? "",
        lastEntry?.role ?? "",
        lastEntry?.text ?? "",
        lastEntry?.outputPreview ?? "",
        lastEntry?.toolUses.map((toolUse) => `${toolUse.name}:${toolUse.summary}`).join("|") ?? "",
      ].join("\u0000");
    })
    .join("\u0001");
}

/** Lazily reads the provider-owned, read-only conversation for one or more
 * spawned agents. The server validates that every agent belongs to threadId. */
export function SubagentTranscript({
  environmentId,
  threadId,
  agentIds,
  follow = false,
  scrollable = false,
  cwd,
  fallbackBody = null,
  onAgentResolved,
  className,
}: SubagentTranscriptProps) {
  const [state, setState] = useState<SubagentTranscriptFetchState>({ status: "loading" });
  const [loadingEarlierAgentId, setLoadingEarlierAgentId] = useState<string | null>(null);
  const [earlierLoadError, setEarlierLoadError] = useState<string | null>(null);
  const [hasUnseenUpdates, setHasUnseenUpdates] = useState(false);
  const scrollElementRef = useRef<HTMLDivElement | null>(null);
  const contentElementRef = useRef<HTMLDivElement | null>(null);
  const sticksToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const previousRevisionRef = useRef<string | null>(null);
  const prependScrollHeightRef = useRef<number | null>(null);
  const agentIdsKey = agentIds.join("\u0000");

  useEffect(() => {
    const requestedAgentIds = agentIdsKey.split("\u0000").filter((agentId) => agentId.length > 0);
    let cancelled = false;
    let refreshTimeoutId: ReturnType<typeof setTimeout> | null = null;
    setState({ status: "loading" });

    const readLatestSections = async () => {
      return await Promise.all(
        requestedAgentIds.map(async (agentId) => ({
          agentId,
          result: await readSubagentTranscriptPage({
            environmentId,
            threadId,
            agentId,
            limit: TRANSCRIPT_PAGE_SIZE,
            fromEnd: true,
          }),
        })),
      );
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

  const resolvedAgent = state.status === "loaded" ? state.sections[0]?.result.agent : undefined;
  const reportedAgentRef = useRef<string | null>(null);
  useEffect(() => {
    const serialized = resolvedAgent ? JSON.stringify(resolvedAgent) : null;
    if (serialized === reportedAgentRef.current) {
      return;
    }
    reportedAgentRef.current = serialized;
    onAgentResolved?.(resolvedAgent);
  }, [onAgentResolved, resolvedAgent]);

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

  useEffect(() => {
    const element = scrollElementRef.current;
    const content = contentElementRef.current;
    if (!scrollable || !element || !content || typeof ResizeObserver === "undefined") {
      return;
    }
    // Markdown blocks highlight asynchronously, so the transcript keeps growing
    // after a refresh renders. Re-pin on every growth rather than once.
    const observer = new ResizeObserver(() => {
      if (sticksToBottomRef.current) {
        element.scrollTop = element.scrollHeight;
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollable]);

  const handleTranscriptScroll = useCallback(() => {
    const element = scrollElementRef.current;
    if (!element) {
      return;
    }
    const previousTop = lastScrollTopRef.current;
    lastScrollTopRef.current = element.scrollTop;
    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_STICK_THRESHOLD_PX;
    // Reading back through the transcript releases the follow; returning to the
    // end resumes it. Anything else would yank the reader around mid-scroll.
    if (atBottom) {
      sticksToBottomRef.current = true;
      setHasUnseenUpdates(false);
    } else if (element.scrollTop < previousTop - 1) {
      sticksToBottomRef.current = false;
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
      const cursor = result.nextCursor;
      if (
        (cursor === undefined && (currentOffset === null || currentOffset === 0)) ||
        loadingEarlierAgentId !== null
      ) {
        return;
      }
      const offset =
        currentOffset === null ? undefined : Math.max(0, currentOffset - TRANSCRIPT_PAGE_SIZE);
      prependScrollHeightRef.current = scrollElementRef.current?.scrollHeight ?? null;
      setLoadingEarlierAgentId(agentId);
      setEarlierLoadError(null);
      try {
        const earlierResult = await readSubagentTranscriptPage({
          environmentId,
          threadId,
          agentId,
          ...(cursor !== undefined ? { cursor, limit: TRANSCRIPT_PAGE_SIZE } : {}),
          ...(cursor === undefined && offset !== undefined && currentOffset !== null
            ? { offset, limit: currentOffset - offset }
            : {}),
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
                        result: mergeTranscriptPages(section.result, earlierResult, "earlier"),
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

  const timestampFormat = useSettings().timestampFormat;

  return (
    <div className={cn("relative", scrollable && "flex min-h-0 flex-1 flex-col", className)}>
      <div
        className={cn(
          "flex items-center justify-between gap-2",
          // The panel's one gutter, and the same section label as Earlier: two
          // labels in one panel should not be assembled from two systems.
          scrollable ? "shrink-0 border-b border-border/45 px-3 py-1.5" : "mb-1",
        )}
      >
        <SectionLabel tick={false}>Read-only transcript</SectionLabel>
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
      <div
        ref={scrollElementRef}
        className={cn(scrollable && "min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3")}
        data-subagent-transcript="true"
        onScroll={scrollable ? handleTranscriptScroll : undefined}
      >
        <div ref={contentElementRef}>
          {state.status === "loading" ? (
            // A flat line at panel text size, on the panel's gutter. A framed or
            // centred loader would put more on screen while waiting than the
            // transcript itself does once it arrives.
            <p
              className="text-[12px] text-muted-foreground/55"
              role="status"
              aria-live="polite"
              data-subagent-transcript-loading="true"
            >
              Loading transcript…
            </p>
          ) : state.status === "error" ? (
            <TranscriptUnavailable
              message={state.message}
              fallbackBody={fallbackBody}
              follow={follow}
            />
          ) : (
            state.sections.map((section, sectionIndex) => {
              const items = buildSubagentTranscriptView(
                section.result.entries,
                section.result.offset ?? 0,
              );
              const { lead, steps } = splitSubagentTranscriptLead(
                items,
                section.result.nextCursor === undefined && (section.result.offset ?? 0) === 0,
              );
              const showLiveTail =
                follow &&
                sectionIndex === state.sections.length - 1 &&
                shouldShowSubagentLiveTail(items, fallbackBody);
              return (
                <div key={section.agentId} className="space-y-2">
                  {section.result.nextCursor !== undefined || (section.result.offset ?? 0) > 0 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="h-6 px-1.5 text-[10px] text-muted-foreground/70"
                      disabled={loadingEarlierAgentId !== null}
                      onClick={() => void loadEarlier(section.agentId, section.result)}
                    >
                      {loadingEarlierAgentId === section.agentId
                        ? "Loading earlier\u2026"
                        : "Load earlier"}
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
                  {lead ? (
                    <TranscriptInstruction
                      item={lead}
                      environmentId={environmentId}
                      threadId={threadId}
                      cwd={cwd}
                      timestampFormat={timestampFormat}
                    />
                  ) : null}
                  <div style={TRANSCRIPT_SPINE_STYLE}>
                    {groupSubagentTranscriptSteps(steps).map((step, stepIndex, groupedSteps) => {
                      const lastItem = stepIndex === groupedSteps.length - 1;
                      // One live terminus per surface: the newest row, and only
                      // while the agent is still working.
                      const live = follow && lastItem && !showLiveTail;
                      return (
                        <SpineRow
                          key={`${section.agentId}:${step.id}`}
                          node={<TranscriptSpineNode step={step} live={live} />}
                          // The dot belongs to what the step says, so it lands on
                          // the step's first line of text.
                          nodeOffset={subagentStepNodeOffsetPx(step)}
                          connectTop={stepIndex > 0}
                          connectBottom={!lastItem || showLiveTail}
                          style={
                            follow
                              ? spineAccentRowStyle(
                                  groupedSteps.length - 1 - stepIndex + (showLiveTail ? 1 : 0),
                                )
                              : undefined
                          }
                        >
                          {/* Padding lives on the content, not the row: the
                              spine gutter stretches to the row's content box,
                              so row padding would break the line. */}
                          <div className="py-1">
                            {step.kind === "tool-run" ? (
                              <ToolRunReceipt
                                run={step}
                                // The run the agent is still adding to stays
                                // open: collapsing it would hide the very thing
                                // "following live" is for.
                                openByDefault={follow && lastItem}
                                timestampFormat={timestampFormat}
                              />
                            ) : (
                              <TranscriptItem
                                item={step.item}
                                environmentId={environmentId}
                                threadId={threadId}
                                cwd={cwd}
                                timestampFormat={timestampFormat}
                              />
                            )}
                          </div>
                        </SpineRow>
                      );
                    })}
                    {showLiveTail && fallbackBody ? (
                      <SpineRow
                        node={<LiveNode className="size-1.5 [--thread-halo-delay:0.2s]" />}
                        connectTop={steps.length > 0}
                        connectBottom={false}
                        style={spineAccentRowStyle(0)}
                      >
                        <div className="py-1">
                          <LiveTail body={fallbackBody} />
                        </div>
                      </SpineRow>
                    ) : null}
                  </div>
                  {section.result.truncated &&
                  section.result.offset === undefined &&
                  section.result.nextCursor === undefined ? (
                    <p className="text-[10px] text-muted-foreground/50">
                      Transcript truncated to {section.result.entries.length} entries.
                    </p>
                  ) : null}
                  {section.result.entries.length === 0 && !showLiveTail ? (
                    <TranscriptUnavailable
                      message={null}
                      fallbackBody={fallbackBody}
                      follow={follow}
                    />
                  ) : null}
                </div>
              );
            })
          )}
        </div>
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

function TranscriptTimestamp({
  at,
  timestampFormat,
  float = false,
}: {
  at: string | null;
  timestampFormat: TimestampFormat;
  /** Rides the top-right of an entry's prose, on the prose's own first line,
   *  rather than sitting in a meta row of its own. Floated rather than absolute
   *  so a long first line wraps around it instead of running under it. */
  float?: boolean;
}) {
  if (!at) {
    return null;
  }
  return (
    <span
      className={cn(
        "font-mono text-[10px] text-muted-foreground/40 tabular-nums",
        float ? "float-right ml-2 h-[18px] leading-[18px]" : "shrink-0 leading-5",
      )}
      data-subagent-transcript-time="true"
    >
      {formatShortTimestamp(at, timestampFormat)}
    </span>
  );
}

function DisclosureButton({
  expanded,
  label,
  onToggle,
}: {
  expanded: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="shrink-0 text-[9px] font-medium tracking-[0.12em] text-muted-foreground/50 uppercase transition-colors duration-150 hover:text-foreground/75"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {expanded ? "Hide" : label}
    </button>
  );
}

/** Indented body under a row, matching the timeline's detail rail. */
function DetailRail({ children }: { children: ReactNode }) {
  return (
    <div className="mt-1 ml-1 border-l border-border/45 pl-3 text-muted-foreground/70">
      {children}
    </div>
  );
}

const ToolGroup = memo(function ToolGroup({
  item,
  timestampFormat,
}: {
  item: Extract<SubagentTranscriptViewItem, { kind: "tools" }>;
  timestampFormat: TimestampFormat;
}) {
  const [expanded, setExpanded] = useState(false);
  const outputLines = item.output ? item.output.split("\n").length : 0;

  return (
    <div className="min-w-0" data-subagent-transcript-entry="tool">
      {item.tools.map((toolUse, toolIndex) => {
        const preview = formatSubagentToolPreview(toolUse);
        const first = toolIndex === 0;
        return (
          <div
            key={toolUse.id}
            className="flex min-w-0 items-center gap-1.5 leading-5"
            title={formatSubagentToolLabel(toolUse)}
          >
            <span className="shrink-0 text-[11px] leading-5 text-foreground/80">
              {toolUse.name}
            </span>
            {preview ? (
              <>
                <span className="shrink-0 text-muted-foreground/40">-</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-5 text-muted-foreground/55">
                  {preview}
                </span>
              </>
            ) : (
              <span className="flex-1" />
            )}
            {first ? <TranscriptTimestamp at={item.at} timestampFormat={timestampFormat} /> : null}
            {first && item.output ? (
              <DisclosureButton
                expanded={expanded}
                label={outputLines > 1 ? `${outputLines} lines` : "Output"}
                onToggle={() => setExpanded((value) => !value)}
              />
            ) : null}
          </div>
        );
      })}
      {item.output && (expanded || item.tools.length === 0) ? (
        <DetailRail>
          <pre className="max-h-64 overflow-y-auto font-mono text-[10px] leading-4 whitespace-pre-wrap wrap-break-word text-muted-foreground/65">
            {item.output}
          </pre>
        </DetailRail>
      ) : null}
    </div>
  );
});

/**
 * A run of tool calls as one line, in the same language as the conversation's
 * activity receipt: what happened, how much of it, how long it took, and a way
 * to open it. Expanding renders the same rows that would have been there.
 */
function ToolRunReceipt({
  run,
  openByDefault,
  timestampFormat,
}: {
  run: SubagentTranscriptToolRun;
  openByDefault: boolean;
  timestampFormat: TimestampFormat;
}) {
  // Null means "no opinion yet", so a run that opens itself because it is live
  // still collapses when the agent moves on, while a run the reader opened by
  // hand stays open.
  const [overrideExpanded, setOverrideExpanded] = useState<boolean | null>(null);
  const expanded = overrideExpanded ?? openByDefault;
  const duration = run.durationMs === null ? null : formatSubagentDuration(run.durationMs);

  return (
    <div className="min-w-0" data-subagent-transcript-entry="tool-run">
      <div className="flex min-w-0 items-center gap-1.5 leading-5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left transition-colors duration-150 hover:text-foreground/75"
          aria-expanded={expanded}
          data-subagent-transcript-tool-run-toggle="true"
          onClick={() => setOverrideExpanded(!expanded)}
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-3 shrink-0 text-muted-foreground/45 transition-transform duration-150",
              expanded && "rotate-90",
            )}
          />
          <span className="shrink-0 text-[11px] leading-5 text-foreground/80">
            {formatSubagentToolRunActions(run)}
          </span>
          {run.toolSummary ? (
            <>
              <span aria-hidden="true" className="shrink-0 text-muted-foreground/30">
                ·
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-5 text-muted-foreground/55">
                {run.toolSummary}
              </span>
            </>
          ) : (
            <span className="flex-1" />
          )}
          {duration ? (
            <span className="shrink-0 font-mono text-[10px] leading-5 text-muted-foreground/45 tabular-nums">
              {duration}
            </span>
          ) : null}
        </button>
      </div>
      {expanded ? (
        <div className="mt-0.5 space-y-0.5">
          {run.items.map((item) => (
            <ToolGroup key={item.id} item={item} timestampFormat={timestampFormat} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const ThinkingBlock = memo(function ThinkingBlock({
  item,
  timestampFormat,
}: {
  item: Extract<SubagentTranscriptViewItem, { kind: "thinking" }>;
  timestampFormat: TimestampFormat;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="min-w-0" data-subagent-transcript-entry="thinking">
      <div className="flex min-w-0 items-center gap-1.5 leading-5">
        <span className="min-w-0 flex-1 truncate text-[11px] leading-5 text-muted-foreground/45 italic">
          {item.text}
        </span>
        <TranscriptTimestamp at={item.at} timestampFormat={timestampFormat} />
        <DisclosureButton
          expanded={expanded}
          label="Reasoning"
          onToggle={() => setExpanded((value) => !value)}
        />
      </div>
      {expanded ? (
        <DetailRail>
          <p className="text-[11px] leading-4 whitespace-pre-wrap wrap-break-word text-muted-foreground/60 italic">
            {item.text}
          </p>
        </DetailRail>
      ) : null}
    </div>
  );
});

/** Agent prose is authored for a chat column. `chat-markdown-dense` (index.css)
 *  brings the whole block -- body, headings, lists, inline code -- down to
 *  12px/18px, so the drill-in reads at the size of the rows around it. */
const TRANSCRIPT_MARKDOWN_CLASS = "chat-markdown-dense text-[12px] leading-[18px]";

const TranscriptMessage = memo(function TranscriptMessage({
  item,
  environmentId,
  threadId,
  cwd,
  timestampFormat,
}: {
  item: Extract<SubagentTranscriptViewItem, { kind: "message" }>;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  cwd: string | undefined;
  timestampFormat: TimestampFormat;
}) {
  // The agent is the default voice here, so only the other roles are labelled.
  const label = item.role === "user" ? "Instruction" : item.role === "system" ? "System" : null;
  // A spawn prompt runs to dozens of lines and is the least interesting thing
  // in a running transcript, so it opens folded to its first line.
  const foldable = item.role !== "assistant";
  const [expanded, setExpanded] = useState(false);
  const folded = foldable && !expanded;

  return (
    <div className="min-w-0" data-subagent-transcript-entry={item.role}>
      {/* A labelled role keeps its meta row: the label is the row's first line,
          and the time sits at the end of it. The agent's own prose has no label,
          so the time rides the first line of the prose instead of taking a line
          of its own above it -- which is what put the spine's node on the time. */}
      {label ? (
        <div className="flex min-w-0 items-baseline gap-2">
          <button
            type="button"
            className={cn(
              "shrink-0 text-[9px] font-medium tracking-[0.12em] uppercase",
              foldable
                ? "text-muted-foreground/50 transition-colors duration-150 hover:text-foreground/75"
                : "pointer-events-none text-muted-foreground/45",
            )}
            aria-expanded={foldable ? expanded : undefined}
            onClick={() => setExpanded((value) => !value)}
          >
            {label}
          </button>
          {folded ? (
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-[11px] leading-5 text-muted-foreground/55 transition-colors duration-150 hover:text-muted-foreground/80"
              aria-expanded={expanded}
              onClick={() => setExpanded(true)}
              title={item.text}
            >
              {firstLine(item.text)}
            </button>
          ) : (
            <span className="flex-1" />
          )}
          <TranscriptTimestamp at={item.at} timestampFormat={timestampFormat} />
        </div>
      ) : null}
      {folded ? null : (
        <div
          className={cn(TRANSCRIPT_MARKDOWN_CLASS, "subagent-transcript-prose")}
          data-subagent-transcript-message="true"
        >
          {label ? null : (
            <TranscriptTimestamp at={item.at} timestampFormat={timestampFormat} float />
          )}
          <ChatMarkdown
            text={item.text}
            cwd={cwd}
            environmentId={environmentId}
            threadId={threadId}
          />
        </div>
      )}
    </div>
  );
});

function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  return line ?? text.trim();
}

const TranscriptItem = memo(
  function TranscriptItem({
    item,
    environmentId,
    threadId,
    cwd,
    timestampFormat,
  }: {
    item: SubagentTranscriptProseItem;
    environmentId: EnvironmentId;
    threadId: ThreadId;
    cwd: string | undefined;
    timestampFormat: TimestampFormat;
  }) {
    if (item.kind === "thinking") {
      return <ThinkingBlock item={item} timestampFormat={timestampFormat} />;
    }
    return (
      <TranscriptMessage
        item={item}
        environmentId={environmentId}
        threadId={threadId}
        cwd={cwd}
        timestampFormat={timestampFormat}
      />
    );
  },
  (previous, next) =>
    previous.environmentId === next.environmentId &&
    previous.threadId === next.threadId &&
    previous.cwd === next.cwd &&
    previous.timestampFormat === next.timestampFormat &&
    isSameSubagentTranscriptItem(previous.item, next.item),
);

/** Past this, an instruction is long enough to be worth folding. */
const INSTRUCTION_COLLAPSED_LINES = 4;
const INSTRUCTION_FOLD_CHARS = 220;

/** The prompt the agent was spawned with. It sits above the thread rather than
 *  on it: it is the setup for every step below, not a step of its own. */
const TranscriptInstruction = memo(function TranscriptInstruction({
  item,
  environmentId,
  threadId,
  cwd,
  timestampFormat,
}: {
  item: Extract<SubagentTranscriptViewItem, { kind: "message" }>;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  cwd: string | undefined;
  timestampFormat: TimestampFormat;
}) {
  const [expanded, setExpanded] = useState(false);
  const foldable =
    item.text.length > INSTRUCTION_FOLD_CHARS ||
    item.text.split("\n").length > INSTRUCTION_COLLAPSED_LINES;
  const folded = foldable && !expanded;

  return (
    <div
      className="min-w-0 border-b border-border/45 pb-2.5"
      data-subagent-transcript-instruction="true"
      data-subagent-transcript-entry={item.role}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 text-[9px] font-medium tracking-[0.12em] text-muted-foreground/45 uppercase">
          {item.role === "user" ? "Instruction" : "System"}
        </span>
        <span className="flex-1" />
        <TranscriptTimestamp at={item.at} timestampFormat={timestampFormat} />
        {foldable ? (
          <DisclosureButton
            expanded={expanded}
            label="Show all"
            onToggle={() => setExpanded((value) => !value)}
          />
        ) : null}
      </div>
      {folded ? (
        <p className="mt-1 line-clamp-4 text-[11.5px] leading-5 whitespace-pre-wrap wrap-break-word text-muted-foreground/70">
          {item.text}
        </p>
      ) : (
        <div
          className={cn(TRANSCRIPT_MARKDOWN_CLASS, "mt-1 text-muted-foreground/80")}
          data-subagent-transcript-message="true"
        >
          <ChatMarkdown
            text={item.text}
            cwd={cwd}
            environmentId={environmentId}
            threadId={threadId}
          />
        </div>
      )}
    </div>
  );
});

/** The spine reads as one unbroken thread, so its own colour stays neutral and
 *  only the rows near the live terminus warm toward accent. */
const TRANSCRIPT_SPINE_STYLE = { ["--spine"]: "var(--border)" } as CSSProperties;

/** Settled steps are quiet dots, foldable rows are hollow rings (same family,
 *  reads as openable), and the one live row carries the halo. */
function TranscriptSpineNode({ step, live }: { step: SubagentTranscriptStep; live: boolean }) {
  if (live) {
    return (
      <LiveNode
        className="size-1.5 [--thread-halo-delay:0.2s]"
        data-subagent-transcript-node="true"
      />
    );
  }
  const openable =
    step.kind === "tool-run" ||
    step.item.kind === "thinking" ||
    (step.item.kind === "message" && step.item.role !== "assistant");
  if (openable) {
    return (
      <span
        aria-hidden="true"
        data-subagent-transcript-node="true"
        className="size-[7px] rounded-full border border-muted-foreground/45 bg-background"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      data-subagent-transcript-node="true"
      className="size-[5px] rounded-full bg-[color-mix(in_oklab,var(--muted-foreground)_42%,var(--background))]"
    />
  );
}

/** The agent's newest words, streamed ahead of the written transcript.
 *  `leading-5` pins the label's line box to the meta line every other row leads
 *  with, which is where the spine puts its node. */
const LiveTail = memo(function LiveTail({ body }: { body: string }) {
  return (
    <div className="min-w-0 leading-5" data-subagent-transcript-live="true">
      {/* The spine already carries the live halo for this row. */}
      <span className="text-[9px] font-medium tracking-[0.12em] text-muted-foreground/45 uppercase">
        Writing
      </span>
      <p className="mt-0.5 text-[12px] leading-5 whitespace-pre-wrap wrap-break-word text-foreground/70">
        {body}
      </p>
    </div>
  );
});

/** A transcript can be legitimately absent: the provider may not have flushed
 *  the agent's first message yet. Lead with what the agent is doing and keep
 *  the provider's own wording available rather than in the reader's face. */
function TranscriptUnavailable({
  message,
  fallbackBody,
  follow,
}: {
  message: string | null;
  fallbackBody: string | null;
  follow: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="space-y-1.5" data-subagent-transcript-error="true">
      <p className="text-[11px] leading-4 text-muted-foreground/60">
        {follow
          ? "Waiting for the agent's first transcript entry."
          : "No transcript is available for this agent."}
      </p>
      {fallbackBody ? (
        <p className="border-l border-border/45 pl-3 text-[11px] leading-4 whitespace-pre-wrap wrap-break-word text-muted-foreground/75">
          {fallbackBody}
        </p>
      ) : null}
      {message ? (
        <div>
          <DisclosureButton
            expanded={expanded}
            label="Details"
            onToggle={() => setExpanded((value) => !value)}
          />
          {expanded ? (
            <p className="mt-1 text-[10px] leading-4 text-muted-foreground/55">{message}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
