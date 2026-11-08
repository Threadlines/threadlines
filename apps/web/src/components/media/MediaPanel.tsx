/**
 * The Media tab: the pictures, videos, sounds and documents agents created or
 * changed, for this thread or the whole project, then "Shared in chat": the
 * pictures the chat showed and the pictures and PDFs you attached. Pictures
 * show as a grid of thumbnails; the rest as rows. A picture opens in the app's
 * image viewer (with Before/After when the thread changed one that was there),
 * anything else in the file viewer, and every file has the shared right-click
 * menu.
 *
 * The server lists both (from the turn summaries and the chat's media it
 * keeps) and the panel only shapes them: see mediaPanel.logic.ts.
 */
import type {
  EnvironmentId,
  OrchestrationMediaKind,
  ProjectId,
  ProjectReadFileResult,
  ProjectRevisionFileResult,
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
import {
  memo,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";

import { scopeProjectRef } from "@threadlines/client-runtime";

import { ensureEnvironmentApi } from "../../environmentApi";
import { selectSidebarThreadsForProjectRef, useStore } from "../../store";
import { openFileInActiveViewer, relativePathWithinCwd } from "../../fileViewerStore";
import { formatBytes } from "../../lib/formatBytes";
import { isImageFilePath } from "../../lib/imageFilePaths";
import { loadChatAttachmentBlob } from "../../lib/attachmentPreviewQuery";
import {
  projectMediaQueryOptions,
  readChatMediaFile,
  revisionFileDataUrl,
} from "../../lib/mediaReactQuery";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { resolvePathLinkTarget } from "../../terminal-links";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { openExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { FilePreviewDialog, type FilePreviewRequest } from "../chat/FilePreviewDialog";
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
  CHAT_MEDIA_ORIGIN_LABELS,
  type ChatMediaEntry,
  chatMediaKey,
  type MediaChatTarget,
  filterChatMedia,
  type MediaEntry,
  mediaEntryKey,
  mediaFileName,
  mediaFolder,
  type MediaGroupBy,
  type MediaScope,
  type MediaSort,
} from "./mediaPanel.logic";
import { useMediaThumbnail, useNearViewport, videoPosterKey } from "./mediaThumbnails";

/**
 * How often the tab re-reads while on screen, for what no revision announces:
 * a file recorded a moment after its turn, a screenshot mid-turn, older chats
 * still being looked through.
 */
const REFRESH_MS = 20_000;

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

type MediaMenuAction = "preview" | "open-viewer" | "go-to-chat";

export interface MediaPanelProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  /** Changes whenever this thread's turn summaries do, so the list follows turns. */
  readonly turnsRevision: string;
  /** False while the tab sits hidden in the strip: no listing is fetched then. */
  readonly visible: boolean;
  /** Shows a file's turn, or where a picture was shared, in its own thread's chat. */
  readonly onGoToChat: (target: MediaChatTarget) => void;
}

/** One picture the viewer can step to, and how to find it again. */
interface ViewerPicture {
  readonly key: string;
  readonly name: string;
  readonly detail: string;
  readonly load: () => Promise<string | null>;
  readonly before?: { readonly load: () => Promise<string | null> };
}

function absolutePath(entry: MediaEntry): string {
  return resolvePathLinkTarget(entry.relativePath, entry.cwd);
}

function describeShared(entry: ChatMediaEntry, includeThread: boolean): string {
  const origin = CHAT_MEDIA_ORIGIN_LABELS[entry.origin];
  return includeThread ? `${origin} · ${entry.threadTitle.trim() || "Untitled thread"}` : origin;
}

/** A read as something an `<img>` can show, or null. */
function readResultDataUrl(result: ProjectReadFileResult | null): string | null {
  return result?.kind === "image" ? `data:${result.mimeType};base64,${result.base64}` : null;
}

function describeChange(entry: MediaEntry, includeThread: boolean): string {
  const verb = entry.change === "added" ? "Added" : "Changed";
  const thread = entry.threadTitle.trim() || "Untitled thread";
  return includeThread
    ? `${verb} in turn ${entry.checkpointTurnCount} · ${thread}`
    : `${verb} in turn ${entry.checkpointTurnCount}`;
}

export const MediaPanel = memo(function MediaPanel(props: MediaPanelProps) {
  const { environmentId, projectId, threadId, turnsRevision, visible, onGoToChat } = props;
  const [scope, setScope] = useState<MediaScope>("thread");
  const [sort, setSort] = useState<MediaSort>("newest");
  const [groupBy, setGroupBy] = useState<MediaGroupBy>("type");
  const [query, setQuery] = useState("");
  const [previewedFile, setPreviewedFile] = useState<FilePreviewRequest | null>(null);

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
      refetchInterval: REFRESH_MS,
    }),
  );
  const entries = listing.data?.entries;
  const chatIndexing = listing.data?.chatIndexing === true;
  const chatEntries = listing.data?.chat;
  const chatVisible = useMemo(
    () => (chatEntries ? filterChatMedia({ entries: chatEntries, query, sort }) : []),
    [chatEntries, query, sort],
  );
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

  // Every picture on screen, in the order shown, for the viewer's arrows:
  // the files, then what was shared in chat.
  const pictures = useMemo<ReadonlyArray<ViewerPicture>>(
    () => [
      ...groups.flatMap((group) =>
        group.tiles
          .filter((entry) => entry.mediaKind === "picture" && isImageFilePath(entry.relativePath))
          .map((picture) => ({
            key: mediaEntryKey(picture),
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
      ),
      ...chatVisible
        .filter((entry) => entry.mediaKind === "picture")
        .map((picture) => ({
          key: chatMediaKey(picture),
          name: picture.name,
          detail: describeShared(picture, true),
          load: () =>
            picture.source.kind === "remote"
              ? Promise.resolve(picture.source.url)
              : readChatMediaFile(environmentId, picture).then(readResultDataUrl),
        })),
    ],
    [chatVisible, environmentId, groups, readCurrent],
  );

  /** Open the viewer at one picture; false when the viewer could not open. */
  const openPictureAt = useCallback(
    (key: string): boolean =>
      openExpandedImagePreview({
        images: pictures.map(({ key: _key, ...picture }) => picture),
        index: Math.max(
          0,
          pictures.findIndex((picture) => picture.key === key),
        ),
      }),
    [pictures],
  );

  const openPicture = useCallback(
    (entry: MediaEntry) => {
      if (!openPictureAt(mediaEntryKey(entry))) {
        openInFileViewer(entry);
      }
    },
    [openInFileViewer, openPictureAt],
  );

  const openChatEntry = useCallback(
    (entry: ChatMediaEntry) => {
      if (entry.mediaKind === "picture") {
        openPictureAt(chatMediaKey(entry));
        return;
      }
      if (entry.source.kind === "attachment" && entry.source.attachment.type === "file") {
        const attachment = entry.source.attachment;
        setPreviewedFile({
          name: attachment.name,
          kind: attachment.kind,
          loadBlob: () => loadChatAttachmentBlob({ environmentId, attachmentId: attachment.id }),
        });
        return;
      }
      if (entry.source.kind === "file") {
        openFileInActiveViewer({ path: entry.source.path });
      }
    },
    [environmentId, openPictureAt],
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
          id: "go-to-chat",
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
        case "go-to-chat":
          onGoToChat({ threadId: entry.threadId, messageId: entry.assistantMessageId });
          return;
        default:
          return;
      }
    },
    [environmentId, onGoToChat, openInFileViewer, openPicture, threadId],
  );

  const showChatContextMenu = useCallback(
    async (entry: ChatMediaEntry, position: { readonly x: number; readonly y: number }) => {
      const api = readLocalApi();
      if (!api) {
        return;
      }
      const otherThread = entry.threadId !== threadId;
      const openItems: Array<{ id: MediaMenuAction; label: string }> = [
        { id: "preview", label: entry.mediaKind === "picture" ? "Preview" : "Open" },
        ...(entry.source.kind === "file"
          ? [{ id: "open-viewer" as const, label: "Open in file viewer" }]
          : []),
        ...(entry.messageId !== null
          ? [
              {
                id: "go-to-chat" as const,
                label: otherThread
                  ? `Go to message in "${entry.threadTitle.trim() || "Untitled thread"}"`
                  : "Go to message in chat",
              },
            ]
          : []),
      ];
      // A picture on disk gets the file's own actions; one that lives only in
      // the chat (an attachment, a screenshot, a web picture) has none.
      const filePath = entry.source.kind === "file" ? entry.source.path : null;
      const launchers = readFileActionLaunchers(environmentId);
      const target: FileActionTarget | null =
        filePath === null
          ? null
          : {
              path: filePath,
              kind: "file",
              relativePath: relativePathWithinCwd(filePath, entry.cwd),
              workspaceRoot: entry.cwd,
            };
      const clicked = await api.contextMenu.show(
        target === null ? openItems : fileActionMenuItems(target, launchers, openItems),
        position,
      );
      if (target !== null && runFileAction(clicked, target, launchers)) {
        return;
      }
      switch (clicked) {
        case "preview":
          openChatEntry(entry);
          return;
        case "open-viewer":
          if (filePath !== null) openFileInActiveViewer({ path: filePath });
          return;
        case "go-to-chat":
          onGoToChat({ threadId: entry.threadId, messageId: entry.messageId });
          return;
        default:
          return;
      }
    },
    [environmentId, onGoToChat, openChatEntry, threadId],
  );

  const onChatEntryContextMenu = useCallback(
    (entry: ChatMediaEntry, event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      void showChatContextMenu(entry, { x: event.clientX, y: event.clientY });
    },
    [showChatContextMenu],
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
        ) : groups.length === 0 && chatVisible.length === 0 && !chatIndexing ? (
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
        {entries !== undefined && (chatVisible.length > 0 || chatIndexing) ? (
          <section aria-label="Shared in chat">
            <SectionLabel className="px-3 pt-3 pb-1.5">
              Shared in chat
              <span className="ml-1.5 font-mono tracking-normal normal-case">
                {chatVisible.length}
              </span>
            </SectionLabel>
            {chatIndexing ? (
              <p className="px-3 pb-1.5 text-[11px] text-muted-foreground">
                Still looking through older chats.
              </p>
            ) : null}
            {chatVisible.length > 0 ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(136px,1fr))] gap-x-2 gap-y-3 px-3">
                {chatVisible.map((entry) => (
                  <ChatMediaTile
                    key={chatMediaKey(entry)}
                    entry={entry}
                    environmentId={environmentId}
                    showThread={showThread}
                    onOpen={openChatEntry}
                    onContextMenu={onChatEntryContextMenu}
                  />
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
        {entries !== undefined ? (
          <p className="mx-3 mt-4 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
            {listing.data?.truncated || listing.data?.chatTruncated
              ? "Showing the newest 2,000. "
              : ""}
            Files outside the project's folder, or in folders git ignores, show here only if the
            chat showed them.
          </p>
        ) : null}
      </div>
      {previewedFile ? (
        <FilePreviewDialog request={previewedFile} onClose={() => setPreviewedFile(null)} />
      ) : null}
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
interface TileSource {
  readonly kind: "picture" | "pdf" | "video";
  /** The thumbnail cache's key, or null when there is nothing to read. */
  readonly key: string | null;
  readonly read: (() => Promise<ProjectReadFileResult | ProjectRevisionFileResult>) | null;
  readonly tooBig: boolean;
  /** A web picture, shown from its address as the chat shows it. */
  readonly url?: string;
  readonly size: number;
}

function tileSource(entry: MediaEntry, environmentId: EnvironmentId): TileSource {
  if (entry.mediaKind === "video") {
    // Only the first frame kept from playing it: a tile never downloads a
    // whole video just to draw itself.
    return {
      kind: "video",
      key: videoPosterKey(
        environmentId,
        resolvePathLinkTarget(entry.relativePath, entry.cwd),
        entry.version,
      ),
      read: null,
      tooBig: false,
      size: entry.size,
    };
  }
  const isPdf = entry.mediaKind === "document";
  const tooBig = entry.size > (isPdf ? MAX_DOCUMENT_PREVIEW_BYTES : MAX_PREVIEW_BYTES);
  const previewable = !tooBig && (isPdf || isImageFilePath(entry.relativePath));
  return {
    kind: isPdf ? "pdf" : "picture",
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
    size: entry.size,
  };
}

function chatTileSource(entry: ChatMediaEntry, environmentId: EnvironmentId): TileSource {
  const isPdf = entry.mediaKind === "document";
  if (entry.source.kind === "remote") {
    return {
      kind: "picture",
      key: null,
      read: null,
      tooBig: false,
      url: entry.source.url,
      size: 0,
    };
  }
  const tooBig = entry.size > (isPdf ? MAX_DOCUMENT_PREVIEW_BYTES : MAX_PREVIEW_BYTES);
  return {
    kind: isPdf ? "pdf" : "picture",
    key: tooBig ? null : `chat|${environmentId}|${entry.id}|${entry.version}`,
    read: () =>
      readChatMediaFile(environmentId, entry).then(
        (result) => result ?? { kind: "missing" as const, relativePath: entry.name },
      ),
    tooBig,
    size: entry.size,
  };
}

/** A tile: the thumbnail, the name under it, and a line about it. */
function MediaTileView(props: {
  readonly tileKey: string;
  readonly name: string;
  readonly title: string;
  readonly source: TileSource;
  readonly meta: ReactNode;
  readonly onOpen: () => void;
  readonly onContextMenu: (event: MouseEvent) => void;
}) {
  const { source, name } = props;
  const ref = useRef<HTMLButtonElement>(null);
  const near = useNearViewport(ref);
  const thumbnail = useMediaThumbnail({ key: source.key, read: source.read, enabled: near });
  const [remoteFailed, setRemoteFailed] = useState(false);
  const url = source.url ?? (thumbnail.status === "ready" ? thumbnail.url : undefined);
  const ready = url !== undefined && !(source.url !== undefined && remoteFailed);
  const failed =
    source.url !== undefined
      ? remoteFailed
      : thumbnail.status === "missing" || thumbnail.status === "unavailable" || source.key === null;

  return (
    <div className="min-w-0" data-media-tile={props.tileKey}>
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
        title={props.title}
        className={cn(
          "relative block aspect-[4/3] w-full overflow-hidden rounded-md border border-border/70 bg-muted/40 focus-ring",
          source.kind === "picture" ? "cursor-zoom-in" : "cursor-pointer",
        )}
        onClick={props.onOpen}
        onContextMenu={props.onContextMenu}
      >
        {ready ? (
          <img
            src={url}
            alt=""
            className={cn(
              "size-full",
              source.kind === "video" ? "object-cover" : "object-cover object-top",
              source.kind === "pdf" && "bg-white",
            )}
            draggable={false}
            {...(source.url !== undefined
              ? {
                  loading: "lazy" as const,
                  referrerPolicy: "no-referrer" as const,
                  onError: () => setRemoteFailed(true),
                }
              : {})}
          />
        ) : source.kind === "video" ? (
          <span className="flex size-full flex-col items-center justify-center gap-1 text-[11px] text-muted-foreground">
            <FilmIcon className="size-4" aria-hidden="true" />
            {formatBytes(source.size)}
          </span>
        ) : failed ? (
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
      {props.meta}
    </div>
  );
}

const MediaTile = memo(function MediaTile(props: {
  readonly entry: MediaEntry;
  readonly environmentId: EnvironmentId;
  readonly showThread: boolean;
  readonly onOpen: (entry: MediaEntry) => void;
  readonly onContextMenu: (entry: MediaEntry, event: MouseEvent) => void;
}) {
  const { entry, onOpen, onContextMenu } = props;
  const name = mediaFileName(entry);
  const folder = mediaFolder(entry);
  return (
    <MediaTileView
      tileKey={entry.relativePath}
      name={name}
      title={folder ? `${folder}/${name}` : name}
      source={tileSource(entry, props.environmentId)}
      meta={<EntryMeta entry={entry} showThread={props.showThread} />}
      onOpen={() => onOpen(entry)}
      onContextMenu={(event) => onContextMenu(entry, event)}
    />
  );
});

const ChatMediaTile = memo(function ChatMediaTile(props: {
  readonly entry: ChatMediaEntry;
  readonly environmentId: EnvironmentId;
  readonly showThread: boolean;
  readonly onOpen: (entry: ChatMediaEntry) => void;
  readonly onContextMenu: (entry: ChatMediaEntry, event: MouseEvent) => void;
}) {
  const { entry, onOpen, onContextMenu } = props;
  return (
    <MediaTileView
      tileKey={entry.name}
      name={entry.name}
      title={entry.source.kind === "file" ? entry.source.path : entry.name}
      source={chatTileSource(entry, props.environmentId)}
      meta={
        <span className="block min-w-0 truncate text-[11px] text-muted-foreground">
          {props.showThread
            ? entry.threadTitle.trim() || "Untitled thread"
            : `${CHAT_MEDIA_ORIGIN_LABELS[entry.origin]} · ${formatRelativeTimeLabel(entry.sharedAt)}`}
        </span>
      }
      onOpen={() => onOpen(entry)}
      onContextMenu={(event) => onContextMenu(entry, event)}
    />
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
