/**
 * A changed picture in the Diff tab: its Before and After side by side, where
 * a text file would show its lines. The two sides come from the same
 * snapshots the patch above compares (one turn, all of the thread's changes,
 * or the last commit against the disk), so they never disagree with it.
 *
 * Both boxes have their size before anything loads, so a picture arriving
 * late never moves the files below it while the panel scrolls to one.
 */
import type {
  EnvironmentId,
  OrchestrationTurnFileRange,
  ProjectRevisionFileResult,
  ThreadId,
} from "@threadlines/contracts";
import { ImageIcon } from "lucide-react";
import { memo, useRef } from "react";

import { ensureEnvironmentApi } from "../../environmentApi";
import { formatBytes } from "../../lib/formatBytes";
import { revisionFileDataUrl } from "../../lib/mediaReactQuery";
import { openExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { type MediaThumbnail, useMediaThumbnail, useNearViewport } from "../media/mediaThumbnails";

/** Where the two sides of the picture come from. */
export type DiffPictureSource =
  | {
      readonly kind: "turns";
      readonly threadId: ThreadId;
      readonly range: OrchestrationTurnFileRange;
    }
  | {
      readonly kind: "workingTree";
      readonly cwd: string;
      /** Names the working tree state the diff was read at. */
      readonly revision: string;
    };

type Side = "before" | "after";

function sideKey(
  environmentId: EnvironmentId,
  source: DiffPictureSource,
  side: Side,
  path: string,
): string {
  return source.kind === "turns"
    ? `diff-turn|${environmentId}|${source.threadId}|${source.range.kind}|${
        source.range.kind === "turn" ? source.range.turnCount : source.range.toTurnCount
      }|${side}|${path}`
    : `diff-tree|${environmentId}|${source.cwd}|${source.revision}|${side}|${path}`;
}

function readSide(
  environmentId: EnvironmentId,
  source: DiffPictureSource,
  side: Side,
  path: string,
  previousPath: string | undefined,
): Promise<ProjectRevisionFileResult> {
  const api = ensureEnvironmentApi(environmentId);
  if (source.kind === "turns") {
    return api.orchestration.getTurnFile({
      threadId: source.threadId,
      range: source.range,
      side,
      path,
      // The server follows renames it recorded; older turns need the patch's word.
      ...(side === "before" && previousPath !== undefined ? { previousPath } : {}),
    });
  }
  return api.vcs.readRepositoryFile({
    cwd: source.cwd,
    path: side === "before" ? (previousPath ?? path) : path,
    source: side === "before" ? "head" : "worktree",
  });
}

function describeSide(label: string, thumbnail: MediaThumbnail): string {
  const parts = [label];
  if (thumbnail.width && thumbnail.height) {
    parts.push(`${thumbnail.width}×${thumbnail.height}`);
  }
  if (thumbnail.size !== undefined) {
    parts.push(formatBytes(thumbnail.size));
  }
  return parts.join(" · ");
}

export const DiffPictureCompare = memo(function DiffPictureCompare(props: {
  readonly environmentId: EnvironmentId;
  /** Repository-root-relative, as the patch names it. */
  readonly path: string;
  /** The picture's name before a rename in this change. */
  readonly previousPath?: string | undefined;
  /** What the patch did to the file. */
  readonly change: "new" | "deleted" | "changed";
  readonly source: DiffPictureSource;
}) {
  const { environmentId, path, previousPath, change, source } = props;
  const ref = useRef<HTMLDivElement>(null);
  const near = useNearViewport(ref);
  const hasBefore = change !== "new";
  const hasAfter = change !== "deleted";

  const before = useMediaThumbnail({
    key: hasBefore ? sideKey(environmentId, source, "before", previousPath ?? path) : null,
    read: () => readSide(environmentId, source, "before", path, previousPath),
    enabled: near,
  });
  const after = useMediaThumbnail({
    key: hasAfter ? sideKey(environmentId, source, "after", path) : null,
    read: () => readSide(environmentId, source, "after", path, undefined),
    enabled: near,
  });

  // Straight from the server, held only by the viewer (see MediaPanel).
  const fullRead = (side: Side) =>
    readSide(environmentId, source, side, path, previousPath).then(revisionFileDataUrl);

  const open = (side: Side) => {
    const name = path.split("/").at(-1) ?? path;
    // A new or deleted picture has one side, which the viewer shows alone;
    // a changed one opens on the side that was clicked, with the switch.
    const both = hasBefore && hasAfter;
    openExpandedImagePreview({
      images: [
        {
          name,
          detail: path,
          load: () => fullRead(hasAfter ? "after" : "before"),
          ...(both ? { before: { load: () => fullRead("before") }, startOn: side } : {}),
        },
      ],
      index: 0,
    });
  };

  return (
    <div ref={ref} className="grid grid-cols-2 gap-2 px-3 py-2.5" data-diff-picture-compare={path}>
      <PictureSide
        label="Before"
        present={hasBefore}
        absentLabel="New file"
        thumbnail={before}
        onOpen={() => open("before")}
      />
      <PictureSide
        label="After"
        present={hasAfter}
        absentLabel="Deleted"
        thumbnail={after}
        onOpen={() => open("after")}
      />
    </div>
  );
});

function PictureSide(props: {
  readonly label: string;
  readonly present: boolean;
  readonly absentLabel: string;
  readonly thumbnail: MediaThumbnail;
  readonly onOpen: () => void;
}) {
  const { label, present, absentLabel, thumbnail, onOpen } = props;
  const ready = present && thumbnail.status === "ready" && thumbnail.url;
  return (
    <div className="min-w-0">
      {ready ? (
        <button
          type="button"
          aria-label={`Open the picture ${label.toLowerCase()} the change`}
          className="block aspect-[16/10] w-full cursor-zoom-in overflow-hidden rounded-md border border-border/70 bg-muted/40 focus-ring"
          onClick={onOpen}
        >
          <img src={thumbnail.url} alt="" className="size-full object-contain" draggable={false} />
        </button>
      ) : (
        <div className="flex aspect-[16/10] w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border/70 text-[11px] text-muted-foreground">
          {present && (thumbnail.status === "idle" || thumbnail.status === "loading") ? null : (
            <>
              <ImageIcon className="size-3.5" aria-hidden="true" />
              {present
                ? thumbnail.status === "missing"
                  ? "Not in this version"
                  : "No preview"
                : absentLabel}
            </>
          )}
        </div>
      )}
      <p className="mt-1 truncate text-[11px] text-muted-foreground">
        {present ? describeSide(label, thumbnail) : label}
      </p>
    </div>
  );
}
