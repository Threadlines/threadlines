import type {
  AgentPageReadResult,
  EnvironmentId,
  OrchestrationAgentPage,
  ThreadId,
} from "@threadlines/contracts";
import {
  AGENT_PAGE_COLUMN_WIDTH,
  agentPageFileName,
  agentPageFrameHeight,
  agentPageShareLink,
} from "@threadlines/shared/agentPages";
import {
  AppWindowIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CodeIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileTextIcon,
  LinkIcon,
  Maximize2Icon,
} from "lucide-react";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { openExternalUrl } from "../../lib/externalLinks";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentPageFrame } from "./AgentPageFrame";

// Which pages the reader minimized, for this app session. Held outside the
// row: the timeline unmounts rows that scroll away, and a page must stay as
// the reader left it when it comes back.
const minimizedPages = new Set<string>();
const minimizedListeners = new Set<() => void>();
const subscribeMinimized = (listener: () => void) => {
  minimizedListeners.add(listener);
  return () => minimizedListeners.delete(listener);
};
const setMinimized = (key: string, minimized: boolean) => {
  if (minimized) minimizedPages.add(key);
  else minimizedPages.delete(key);
  for (const listener of minimizedListeners) listener();
};

/** The id of the timeline row for a page as one turn left it. */
export const agentPageRowId = (page: Pick<OrchestrationAgentPage, "pageId" | "turnId">) =>
  `page:${page.pageId}:${page.turnId}`;

/** The chrome above a page: its one title line. */
export const AGENT_PAGE_ROW_CHROME_PX = 28;

// The row's actions are plain until the row is hovered, as row actions are.
const ROW_ACTION_CLASS =
  "opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/page:opacity-100 pointer-coarse:opacity-100";

/**
 * An agent page in the chat (docs/agent-pages.md): a title line and the page
 * itself on the thread's own background, fitted to its height. The page is
 * part of the answer, so its title reads as content (a row title with the
 * page's glyph), not as one of the agent's steps; clicking it folds the page
 * to that line. The frame keeps the server's measured height until the page
 * reports its own, so nothing below it moves while it loads. A page its
 * provider also put online (a Claude artifact) says where, and opens there.
 */
export function AgentPageRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly page: OrchestrationAgentPage;
  /** A later turn's version of a page an earlier turn showed. */
  readonly updated: boolean;
}) {
  const { page } = props;
  const key = `${props.environmentId}/${props.threadId}/${agentPageRowId(page)}`;
  const minimized = useSyncExternalStore(subscribeMinimized, () => minimizedPages.has(key));
  const [fullSize, setFullSize] = useState(false);
  const version = useMemo(
    () => ({
      environmentId: props.environmentId,
      threadId: props.threadId,
      pageId: page.pageId,
      versionId: page.versionId,
    }),
    [page.pageId, page.versionId, props.environmentId, props.threadId],
  );
  const share = useMemo(() => agentPageShareLink(page.shareUrl), [page.shareUrl]);
  const PageGlyph = page.kind === "markdown" ? FileTextIcon : AppWindowIcon;
  const notes = [
    ...(props.updated ? ["Updated"] : []),
    ...(share ? [`On ${share.host}`] : []),
  ].join(" · ");

  return (
    <div className="group/page min-w-0" data-agent-page-row={page.pageId}>
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          className="group/title flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={!minimized}
          onClick={() => setMinimized(key, !minimized)}
        >
          <PageGlyph
            className="size-3.5 shrink-0 text-muted-foreground transition-colors duration-150 group-hover/title:text-foreground"
            aria-hidden="true"
          />
          <span className="min-w-0 truncate text-[13.5px] leading-5 font-medium text-foreground">
            {page.title}
          </span>
          {notes.length > 0 ? (
            <span className="shrink-0 text-[12.5px] leading-5 text-muted-foreground">{notes}</span>
          ) : null}
        </button>
        {share ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Open ${page.title} on ${share.host}`}
                  className={ROW_ACTION_CLASS}
                  onClick={() => openExternalUrl(share.url)}
                />
              }
            >
              <ExternalLinkIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="left">Open on {share.host}</TooltipPopup>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Open ${page.title} full size`}
                className={ROW_ACTION_CLASS}
                onClick={() => setFullSize(true)}
              />
            }
          >
            <Maximize2Icon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="left">Open full size</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={minimized ? `Show ${page.title}` : `Minimize ${page.title}`}
                // A folded page keeps its way back in view.
                className={minimized ? undefined : ROW_ACTION_CLASS}
                onClick={() => setMinimized(key, !minimized)}
              />
            }
          >
            {minimized ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronUpIcon className="size-3.5" />
            )}
          </TooltipTrigger>
          <TooltipPopup side="left">{minimized ? "Show page" : "Minimize"}</TooltipPopup>
        </Tooltip>
      </div>
      {minimized ? null : <InlinePage version={version} page={page} />}
      {fullSize ? (
        <FullSizePage
          version={version}
          page={page}
          share={share}
          onClose={() => setFullSize(false)}
        />
      ) : null}
    </div>
  );
}

function InlinePage(props: {
  readonly version: Parameters<typeof AgentPageFrame>[0]["version"];
  readonly page: OrchestrationAgentPage;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(AGENT_PAGE_COLUMN_WIDTH);
  // Read before first paint, so the reserved box is already the right size.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setWidth(box.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  const [contentHeight, setContentHeight] = useState<number>();
  const height = agentPageFrameHeight(props.page, width, contentHeight);
  return (
    <div ref={boxRef} className="mt-1 w-full" style={{ height }}>
      {/* A new version of the page is a new document: a fresh frame loads it. */}
      <AgentPageFrame
        key={props.version.versionId}
        version={props.version}
        title={props.page.title}
        className="size-full"
        onContentHeight={setContentHeight}
      />
    </div>
  );
}

function FullSizePage(props: {
  readonly version: Parameters<typeof AgentPageFrame>[0]["version"];
  readonly page: OrchestrationAgentPage;
  readonly share: ReturnType<typeof agentPageShareLink>;
  readonly onClose: () => void;
}) {
  const { share } = props;
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const [loaded, setLoaded] = useState<AgentPageReadResult | null>(null);
  const [showSource, setShowSource] = useState(false);
  const onLoaded = useCallback((page: AgentPageReadResult) => setLoaded(page), []);
  const save = () => {
    if (loaded === null) return;
    const blob = new Blob([loaded.content], {
      type: loaded.kind === "markdown" ? "text/markdown" : "text/html",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = agentPageFileName(props.page.title, loaded.kind);
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup
        className="h-[min(88vh,1100px)] max-w-[min(1200px,94vw)] gap-0 overflow-hidden"
        bottomStickOnMobile={false}
      >
        <div className="flex min-w-0 items-center gap-1 py-2 ps-5 pe-12">
          <DialogTitle className="min-w-0 flex-1 truncate text-[15px] font-medium">
            {props.page.title}
          </DialogTitle>
          {share ? (
            <>
              <Button size="xs" variant="ghost" onClick={() => openExternalUrl(share.url)}>
                <ExternalLinkIcon aria-hidden />
                Open on {share.host}
              </Button>
              <Button size="xs" variant="ghost" onClick={() => copyToClipboard(share.url)}>
                {isCopied ? <CheckIcon aria-hidden /> : <LinkIcon aria-hidden />}
                {isCopied ? "Copied" : "Copy link"}
              </Button>
            </>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            aria-pressed={showSource}
            disabled={loaded === null}
            onClick={() => setShowSource((value) => !value)}
          >
            <CodeIcon aria-hidden />
            Source
          </Button>
          <Button size="xs" variant="ghost" disabled={loaded === null} onClick={save}>
            <DownloadIcon aria-hidden />
            Save
          </Button>
        </div>
        {showSource && loaded !== null ? (
          <pre className="min-h-0 flex-1 overflow-auto px-5 pb-5 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground">
            {loaded.content}
          </pre>
        ) : (
          // The page has no side padding of its own, so full size gives it the
          // column's gutter, painted in the page's own background.
          <AgentPageFrame
            key={props.version.versionId}
            version={props.version}
            title={props.page.title}
            className="min-h-0 flex-1 bg-background px-4 pb-4"
            onLoaded={onLoaded}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}
