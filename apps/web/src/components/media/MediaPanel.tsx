/**
 * The Media tab: the pictures, videos, sounds and documents agents created or
 * changed, for this thread or the whole project. Pictures show as a grid of
 * thumbnails; the rest as rows. A picture opens in the app's image viewer
 * (with Before/After when the thread changed one that was there), anything
 * else in the file viewer, and every file has the shared right-click menu.
 *
 * The server lists the files (from the turn summaries it already keeps) and
 * the panel only shapes them: see mediaPanel.logic.ts.
 */
import type {
  EnvironmentId,
  OrchestrationMediaKind,
  ProjectId,
  ThreadId,
} from "@threadlines/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  FileTextIcon,
  FilmIcon,
  ImageIcon,
  ImageOffIcon,
  MusicIcon,
  PlayIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { memo, type MouseEvent, useCallback, useMemo, useRef, useState } from "react";

import { scopeProjectRef } from "@threadlines/client-runtime";

import { ensureEnvironmentApi } from "../../environmentApi";
import { selectSidebarThreadsForProjectRef, useStore } from "../../store";
import { openFileInActiveViewer } from "../../fileViewerStore";
import { formatBytes } from "../../lib/formatBytes";
import { isImageFilePath } from "../../lib/imageFilePaths";
import { projectMediaQueryOptions, revisionFileDataUrl } from "../../lib/mediaReactQuery";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { resolvePathLinkTarget } from "../../terminal-links";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { openExpandedImagePreview } from "../chat/ExpandedImagePreview";
import {
  type FileActionTarget,
  fileActionMenuItems,
  readFileActionLaunchers,
  runFileAction,
} from "../fileActionsMenu";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import {
  Menu,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SegmentedControl, SegmentedControlItem } from "../ui/segmented-control";
import { SectionLabel } from "../ui/threadline";
import { TooltipWrapper } from "../ui/tooltip";
import {
  buildMediaGroups,
  type MediaEntry,
  mediaEntryKey,
  mediaFileName,
  mediaFolder,
  type MediaGroupBy,
  type MediaScope,
  type MediaSort,
} from "./mediaPanel.logic";
import { useMediaThumbnail, useNearViewport, videoPosterKey } from "./mediaThumbnails";

/** How often every thread's view re-reads while on screen. */
const PROJECT_REFRESH_MS = 20_000;

/** What the server sends whole; a bigger picture is never asked for. */
const MAX_PREVIEW_BYTES = 10_485_760;
/** The same for a PDF, whose first page a tile shows. */
const MAX_DOCUMENT_PREVIEW_BYTES = 20_971_520;

const SORT_LABELS: Readonly<Record<MediaSort, string>> = {
  newest: "Newest",
  oldest: "Oldest",
  name: "Name",
};

const ROW_ICONS: Readonly<Record<OrchestrationMediaKind, typeof ImageIcon>> = {
  picture: ImageIcon,
  video: FilmIcon,
  audio: MusicIcon,
  document: FileTextIcon,
};

type MediaMenuAction = "preview" | "open-viewer" | "go-to-turn";

export interface MediaPanelProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  /** Changes whenever this thread's turn summaries do, so the list follows turns. */
  readonly turnsRevision: string;
  /** False while the tab sits hidden in the strip: no listing is fetched then. */
  readonly visible: boolean;
  /** Shows the chat at the turn that last changed the file, in its own thread. */
  readonly onGoToTurn: (entry: MediaEntry) => void;
}

function absolutePath(entry: MediaEntry): string {
  return resolvePathLinkTarget(entry.relativePath, entry.cwd);
}

function describeChange(entry: MediaEntry, includeThread: boolean): string {
  const verb = entry.change === "added" ? "Added" : "Changed";
  const thread = entry.threadTitle.trim() || "Untitled thread";
  return includeThread
    ? `${verb} in turn ${entry.checkpointTurnCount} · ${thread}`
    : `${verb} in turn ${entry.checkpointTurnCount}`;
}

export const MediaPanel = memo(function MediaPanel(props: MediaPanelProps) {
  const { environmentId, projectId, threadId, turnsRevision, visible, onGoToTurn } = props;
  const [scope, setScope] = useState<MediaScope>("thread");
  const [sort, setSort] = useState<MediaSort>("newest");
  const [groupBy, setGroupBy] = useState<MediaGroupBy>("type");
  const [query, setQuery] = useState("");

  // Every thread's view follows the project's threads: a turn finishing in
  // any of them changes this. A turn can finish a moment before its files are
  // recorded, so the view also re-reads now and then while it is on screen.
  const projectRevision = useStore((state) =>
    scope === "project" && visible
      ? selectSidebarThreadsForProjectRef(state, scopeProjectRef(environmentId, projectId))
          .map(
            (thread) =>
              `${thread.id}:${thread.latestTurn?.turnId ?? ""}:${thread.latestTurn?.completedAt ?? ""}`,
          )
          .join("|")
      : "",
  );
  const listing = useQuery(
    projectMediaQueryOptions({
      environmentId,
      projectId,
      threadId: scope === "thread" ? threadId : null,
      revision: scope === "thread" ? turnsRevision : `${turnsRevision}|${projectRevision}`,
      enabled: visible,
      ...(scope === "project" ? { refetchInterval: PROJECT_REFRESH_MS } : {}),
    }),
  );
  const entries = listing.data?.entries;
  const groups = useMemo(
    () =>
      entries
        ? buildMediaGroups({
            entries,
            query,
            sort,
            // One thread's files have nothing to group by thread.
            groupBy: scope === "thread" ? "type" : groupBy,
          })
        : [],
    [entries, groupBy, query, scope, sort],
  );
  // Every picture on screen, in the order shown, for the viewer's arrows.
  const pictures = useMemo(
    () =>
      groups.flatMap((group) =>
        group.tiles.filter(
          (entry) => entry.mediaKind === "picture" && isImageFilePath(entry.relativePath),
        ),
      ),
    [groups],
  );
  const showThread = scope === "project";

  // Full pictures are read straight from the server, fresh each time and
  // kept only by the viewer, never in the shared query cache: a walk through
  // fifty of them must not leave fifty in memory.
  const readCurrent = useCallback(
    (entry: MediaEntry) =>
      ensureEnvironmentApi(environmentId)
        .projects.readFile({ cwd: entry.cwd, relativePath: entry.relativePath })
        .then((result) =>
          result.kind === "image" ? `data:${result.mimeType};base64,${result.base64}` : null,
        ),
    [environmentId],
  );

  const openInFileViewer = useCallback((entry: MediaEntry) => {
    openFileInActiveViewer({ path: absolutePath(entry) });
  }, []);

  const openPicture = useCallback(
    (entry: MediaEntry) => {
      const index = pictures.findIndex(
        (picture) => mediaEntryKey(picture) === mediaEntryKey(entry),
      );
      const opened = openExpandedImagePreview({
        images: pictures.map((picture) => ({
          name: mediaFileName(picture),
          detail: describeChange(picture, true),
          load: () => readCurrent(picture),
          ...(picture.change === "modified"
            ? {
                before: {
                  // As it was before this thread first touched it.
                  load: () =>
                    ensureEnvironmentApi(environmentId)
                      .orchestration.getTurnFile({
                        threadId: picture.threadId,
                        range: { kind: "thread", toTurnCount: picture.checkpointTurnCount },
                        side: "before",
                        path: picture.repositoryPath,
                      })
                      .then(revisionFileDataUrl),
                },
              }
            : {}),
        })),
        index: Math.max(0, index),
      });
      if (!opened) {
        openInFileViewer(entry);
      }
    },
    [environmentId, openInFileViewer, pictures, readCurrent],
  );

  const openEntry = useCallback(
    (entry: MediaEntry) => {
      if (entry.mediaKind === "picture" && isImageFilePath(entry.relativePath)) {
        openPicture(entry);
        return;
      }
      openInFileViewer(entry);
    },
    [openInFileViewer, openPicture],
  );

  const showContextMenu = useCallback(
    async (entry: MediaEntry, position: { readonly x: number; readonly y: number }) => {
      const api = readLocalApi();
      if (!api) {
        return;
      }
      const target: FileActionTarget = {
        path: absolutePath(entry),
        kind: "file",
        relativePath: entry.relativePath,
        workspaceRoot: entry.cwd,
      };
      const launchers = readFileActionLaunchers(environmentId);
      const otherThread = entry.threadId !== threadId;
      const openItems: Array<{ id: MediaMenuAction; label: string }> = [
        ...(entry.mediaKind === "picture" && isImageFilePath(entry.relativePath)
          ? [{ id: "preview" as const, label: "Preview" }]
          : []),
        { id: "open-viewer", label: "Open in file viewer" },
        {
          id: "go-to-turn",
          label: otherThread
            ? `Go to turn ${entry.checkpointTurnCount} in "${entry.threadTitle.trim() || "Untitled thread"}"`
            : `Go to turn ${entry.checkpointTurnCount} in chat`,
        },
      ];
      const clicked = await api.contextMenu.show(
        fileActionMenuItems(target, launchers, openItems),
        position,
      );
      if (runFileAction(clicked, target, launchers)) {
        return;
      }
      switch (clicked) {
        case "preview":
          openPicture(entry);
          return;
        case "open-viewer":
          openInFileViewer(entry);
          return;
        case "go-to-turn":
          onGoToTurn(entry);
          return;
        default:
          return;
      }
    },
    [environmentId, onGoToTurn, openInFileViewer, openPicture, threadId],
  );

  const onEntryContextMenu = useCallback(
    (entry: MediaEntry, event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      void showContextMenu(entry, { x: event.clientX, y: event.clientY });
    },
    [showContextMenu],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-media-panel="true">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-2.5 pb-1.5">
        <SegmentedControl
          size="sm"
          value={scope}
          onValueChange={setScope}
          aria-label="Whose media to show"
        >
          <SegmentedControlItem value="thread">This thread</SegmentedControlItem>
          <SegmentedControlItem value="project">All threads</SegmentedControlItem>
        </SegmentedControl>
        <span className="flex-1" />
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="gap-1 text-muted-foreground hover:text-foreground"
              />
            }
          >
            {SORT_LABELS[sort]}
            <ChevronDownIcon className="size-3" aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-40">
            <MenuRadioGroup value={sort} onValueChange={(value) => setSort(value as MediaSort)}>
              <MenuRadioItem value="newest">Newest first</MenuRadioItem>
              <MenuRadioItem value="oldest">Oldest first</MenuRadioItem>
              <MenuRadioItem value="name">Name</MenuRadioItem>
            </MenuRadioGroup>
            {scope === "project" ? (
              <>
                <MenuSeparator />
                <MenuGroupLabel>Group by</MenuGroupLabel>
                <MenuRadioGroup
                  value={groupBy}
                  onValueChange={(value) => setGroupBy(value as MediaGroupBy)}
                >
                  <MenuRadioItem value="type">Type</MenuRadioItem>
                  <MenuRadioItem value="thread">Thread</MenuRadioItem>
                </MenuRadioGroup>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>
      <div className="shrink-0 px-3 pb-1">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            size="sm"
            type="text"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query.length > 0) {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Search media"
            aria-label="Search media"
          />
          {query.length > 0 ? (
            <InputGroupAddon align="inline-end">
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
                onClick={() => setQuery("")}
              >
                <XIcon className="size-3" />
              </Button>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {entries === undefined ? (
          listing.isError ? (
            <div className="flex flex-col items-start gap-2 px-3 py-3">
              <p className="text-xs text-muted-foreground">Couldn't load media.</p>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void listing.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : (
            <p className="px-3 py-3 text-xs text-muted-foreground">Loading media…</p>
          )
        ) : groups.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            {query.trim().length > 0
              ? `Nothing matches "${query.trim()}".`
              : scope === "thread"
                ? "No pictures or files from this thread yet."
                : "No pictures or files in this project yet."}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.key} aria-label={group.label || undefined}>
              {group.label ? (
                <SectionLabel className="px-3 pt-3 pb-1.5">
                  {group.label}
                  <span className="ml-1.5 font-mono tracking-normal normal-case">
                    {group.tiles.length + group.rows.length}
                  </span>
                </SectionLabel>
              ) : null}
              {group.tiles.length > 0 ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(136px,1fr))] gap-x-2 gap-y-3 px-3">
                  {group.tiles.map((entry) => (
                    <MediaTile
                      key={mediaEntryKey(entry)}
                      entry={entry}
                      environmentId={environmentId}
                      showThread={showThread}
                      onOpen={openEntry}
                      onContextMenu={onEntryContextMenu}
                    />
                  ))}
                </div>
              ) : null}
              {group.rows.length > 0 ? (
                <div className={group.tiles.length > 0 ? "mt-2" : undefined}>
                  {group.rows.map((entry) => (
                    <MediaRow
                      key={mediaEntryKey(entry)}
                      entry={entry}
                      showThread={showThread}
                      onOpen={openEntry}
                      onContextMenu={onEntryContextMenu}
                    />
                  ))}
                </div>
              ) : null}
            </section>
          ))
        )}
        {entries !== undefined ? (
          <p className="mx-3 mt-4 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
            {listing.data?.truncated ? "Showing the newest 2,000 files. " : ""}
            Files saved outside the project's folder, or in folders git ignores, don't show here.
          </p>
        ) : null}
      </div>
    </div>
  );
});

function ChangeBadge(props: { readonly change: MediaEntry["change"] }) {
  const label = props.change === "added" ? "Added by this thread" : "Changed by this thread";
  return (
    <TooltipWrapper tooltip={label}>
      <span
        aria-label={label}
        className={cn(
          "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded border px-1 font-mono text-[10px] leading-none",
          props.change === "added"
            ? "border-success/25 bg-success/8 text-success-foreground"
            : "border-warning/25 bg-warning/8 text-warning-foreground",
        )}
      >
        {props.change === "added" ? "A" : "M"}
      </span>
    </TooltipWrapper>
  );
}

function EntryMeta(props: { readonly entry: MediaEntry; readonly showThread: boolean }) {
  const { entry, showThread } = props;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
      <ChangeBadge change={entry.change} />
      <span className="min-w-0 truncate">
        {showThread
          ? entry.threadTitle.trim() || "Untitled thread"
          : `Turn ${entry.checkpointTurnCount} · ${formatRelativeTimeLabel(entry.changedAt)}`}
      </span>
    </span>
  );
}

/** What a tile shows and how it gets it. */
function tileSource(entry: MediaEntry, environmentId: EnvironmentId) {
  if (entry.mediaKind === "video") {
    // Only the first frame kept from playing it: a tile never downloads a
    // whole video just to draw itself.
    return {
      kind: "video" as const,
      key: videoPosterKey(
        environmentId,
        resolvePathLinkTarget(entry.relativePath, entry.cwd),
        entry.version,
      ),
      read: null,
      tooBig: false,
    };
  }
  const isPdf = entry.mediaKind === "document";
  const tooBig = entry.size > (isPdf ? MAX_DOCUMENT_PREVIEW_BYTES : MAX_PREVIEW_BYTES);
  const previewable = !tooBig && (isPdf || isImageFilePath(entry.relativePath));
  return {
    kind: isPdf ? ("pdf" as const) : ("picture" as const),
    // The version changes with every write, so a rewritten file reads again.
    key: previewable
      ? `media|${environmentId}|${entry.cwd}|${entry.relativePath}|${entry.version}`
      : null,
    read: () =>
      ensureEnvironmentApi(environmentId).projects.readFile({
        cwd: entry.cwd,
        relativePath: entry.relativePath,
        ...(isPdf ? { documents: true } : {}),
      }),
    tooBig,
  };
}

const MediaTile = memo(function MediaTile(props: {
  readonly entry: MediaEntry;
  readonly environmentId: EnvironmentId;
  readonly showThread: boolean;
  readonly onOpen: (entry: MediaEntry) => void;
  readonly onContextMenu: (entry: MediaEntry, event: MouseEvent) => void;
}) {
  const { entry, environmentId, showThread, onOpen, onContextMenu } = props;
  const ref = useRef<HTMLButtonElement>(null);
  const near = useNearViewport(ref);
  const source = tileSource(entry, environmentId);
  const thumbnail = useMediaThumbnail({ key: source.key, read: source.read, enabled: near });
  const name = mediaFileName(entry);
  const folder = mediaFolder(entry);
  const ready = thumbnail.status === "ready" && thumbnail.url;

  return (
    <div className="min-w-0" data-media-tile={entry.relativePath}>
      <button
        ref={ref}
        type="button"
        aria-label={
          source.kind === "video"
            ? `Play ${name}`
            : source.kind === "pdf"
              ? `Open ${name}`
              : `Preview ${name}`
        }
        title={folder ? `${folder}/${name}` : name}
        className={cn(
          "relative block aspect-[4/3] w-full overflow-hidden rounded-md border border-border/70 bg-muted/40 focus-ring",
          source.kind === "picture" ? "cursor-zoom-in" : "cursor-pointer",
        )}
        onClick={() => onOpen(entry)}
        onContextMenu={(event) => onContextMenu(entry, event)}
      >
        {ready ? (
          <img
            src={thumbnail.url}
            alt=""
            className={cn(
              "size-full",
              // A page or a screenshot reads from the top; a frame from its middle.
              source.kind === "video" ? "object-cover" : "object-cover object-top",
              source.kind === "pdf" && "bg-white",
            )}
            draggable={false}
          />
        ) : source.kind === "video" ? (
          <span className="flex size-full flex-col items-center justify-center gap-1 text-[11px] text-muted-foreground">
            <FilmIcon className="size-4" aria-hidden="true" />
            {formatBytes(entry.size)}
          </span>
        ) : thumbnail.status === "missing" ||
          thumbnail.status === "unavailable" ||
          source.key === null ? (
          <span className="flex size-full flex-col items-center justify-center gap-1 text-[11px] text-muted-foreground">
            {thumbnail.status === "missing" ? (
              <ImageOffIcon className="size-4" aria-hidden="true" />
            ) : source.kind === "pdf" ? (
              <FileTextIcon className="size-4" aria-hidden="true" />
            ) : (
              <ImageIcon className="size-4" aria-hidden="true" />
            )}
            {thumbnail.status === "missing"
              ? "No longer on disk"
              : source.tooBig
                ? "Too big to preview"
                : "No preview"}
          </span>
        ) : null}
        {source.kind === "video" ? (
          <span
            aria-hidden="true"
            className="absolute right-1.5 bottom-1.5 flex size-6 items-center justify-center rounded-full bg-black/60 text-white"
          >
            <PlayIcon className="size-3 fill-current" />
          </span>
        ) : null}
      </button>
      <span className="mt-1 block truncate text-xs text-foreground" title={name}>
        {name}
      </span>
      <EntryMeta entry={entry} showThread={showThread} />
    </div>
  );
});

const MediaRow = memo(function MediaRow(props: {
  readonly entry: MediaEntry;
  readonly showThread: boolean;
  readonly onOpen: (entry: MediaEntry) => void;
  readonly onContextMenu: (entry: MediaEntry, event: MouseEvent) => void;
}) {
  const { entry, showThread, onOpen, onContextMenu } = props;
  const Icon = ROW_ICONS[entry.mediaKind];
  const folder = mediaFolder(entry);
  return (
    <button
      type="button"
      data-media-row={entry.relativePath}
      className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-accent/60 focus-ring"
      onClick={() => onOpen(entry)}
      onContextMenu={(event) => onContextMenu(entry, event)}
    >
      <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block truncate text-xs text-foreground">{mediaFileName(entry)}</span>
        <span className="flex min-w-0 items-center gap-1.5">
          <EntryMeta entry={entry} showThread={showThread} />
          {folder ? (
            <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
              {folder}
            </span>
          ) : null}
        </span>
      </span>
      <span className="font-mono text-[10px] text-muted-foreground">{formatBytes(entry.size)}</span>
    </button>
  );
});
