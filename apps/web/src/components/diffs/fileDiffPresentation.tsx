/**
 * How one file reads at the top of a diff, shared by every surface that
 * renders `@pierre/diffs` files: the working tree and turn diffs in the Diff
 * panel, and a pull request's patch in the Pull request panel.
 *
 * The two differ only in what they hang off the end of the row — the Diff
 * panel opens the file in an editor, a pull request's files may not exist on
 * this machine at all — so that is a slot rather than a fork.
 */
import type { FileDiffMetadata } from "@pierre/diffs/react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import { TooltipWrapper } from "../ui/tooltip";

/** The displayed path, with the patch's `a/` or `b/` prefix taken off. */
export function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

/** Rename source path, only when it differs from the displayed path. */
export function resolveFileDiffPrevPath(fileDiff: FileDiffMetadata): string | null {
  const raw = fileDiff.prevName;
  if (!raw) return null;
  const stripped = raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
  return stripped === resolveFileDiffPath(fileDiff) ? null : stripped;
}

/** Matches workingTreeFileStatusClassName in SourceControlPanel: green added,
 * red deleted, amber modified, so the tree and the diff cards speak one
 * color language. */
export function getFileDiffStatusBadge(fileDiff: FileDiffMetadata): {
  readonly label: string;
  readonly className: string;
} {
  switch (fileDiff.type) {
    case "new":
      return { label: "A", className: "border-success/25 bg-success/8 text-success-foreground" };
    case "deleted":
      return {
        label: "D",
        className: "border-destructive/25 bg-destructive/8 text-destructive-foreground",
      };
    case "rename-pure":
    case "rename-changed":
      return { label: "R", className: "border-warning/25 bg-warning/8 text-warning-foreground" };
    default:
      return { label: "M", className: "border-warning/25 bg-warning/8 text-warning-foreground" };
  }
}

export interface FileDiffHeaderStat {
  readonly additions: number;
  readonly deletions: number;
}

/**
 * The custom header a `FileDiff` renders: collapse control, status badge,
 * path, diff stat, then whatever the surface adds.
 *
 * `interactiveTitle` marks the path with `data-title` and styles it as a
 * target. The Diff panel watches for that attribute on click capture to open
 * the file in an editor; surfaces with nothing to open leave it off rather
 * than offering a target that does nothing.
 */
export function FileDiffHeader({
  fileDiff,
  filePath,
  collapsed,
  onToggleCollapsed,
  stat,
  interactiveTitle = false,
  trailing,
}: {
  readonly fileDiff: FileDiffMetadata;
  readonly filePath: string;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  readonly stat: FileDiffHeaderStat | null;
  readonly interactiveTitle?: boolean;
  readonly trailing?: ReactNode;
}) {
  const badge = getFileDiffStatusBadge(fileDiff);
  const pathSegments = filePath.split("/");
  const fileName = pathSegments.at(-1) ?? filePath;
  const fileDirectory = pathSegments.slice(0, -1).join("/");
  const prevPath = resolveFileDiffPrevPath(fileDiff);
  const prevFileName = prevPath ? (prevPath.split("/").at(-1) ?? prevPath) : null;

  return (
    <div className="flex h-9 min-w-0 items-center gap-1.5 pl-1.5 pr-2">
      <TooltipWrapper tooltip={collapsed ? "Expand diff" : "Collapse diff"}>
        <button
          type="button"
          // A coarse pointer gets the whole header's height to aim at; the
          // chevron inside it stays the same size.
          className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-muted-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground focus-ring pointer-coarse:size-8"
          aria-label={collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
          aria-expanded={!collapsed}
          onClick={(event) => {
            event.stopPropagation();
            onToggleCollapsed();
          }}
        >
          {collapsed ? (
            <ChevronRightIcon className="size-4" />
          ) : (
            <ChevronDownIcon className="size-4" />
          )}
        </button>
      </TooltipWrapper>
      <span
        className={cn(
          "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded border px-1 font-mono text-[10px] leading-none",
          badge.className,
        )}
      >
        {badge.label}
      </span>
      <span
        {...(interactiveTitle ? { "data-title": "" } : {})}
        title={prevPath ? `${prevPath} → ${filePath}` : filePath}
        className={cn(
          "group/diff-title flex min-w-0 flex-1 items-baseline font-mono text-[11px] leading-none text-foreground/90",
          interactiveTitle && "cursor-pointer",
        )}
      >
        {prevFileName && prevFileName !== fileName ? (
          <span className="mr-1.5 min-w-0 shrink-[99] truncate text-muted-foreground/55">
            {prevFileName} →
          </span>
        ) : null}
        {fileDirectory ? (
          <span
            className={cn(
              "min-w-0 shrink-[99] truncate text-muted-foreground/55 transition-colors",
              interactiveTitle && "group-hover/diff-title:text-muted-foreground/80",
            )}
          >
            {fileDirectory}/
          </span>
        ) : null}
        <span
          className={cn(
            "min-w-0 max-w-full shrink-0 truncate [direction:rtl] underline-offset-2 transition-colors",
            interactiveTitle &&
              "group-hover/diff-title:text-foreground group-hover/diff-title:underline group-hover/diff-title:decoration-foreground/35",
          )}
        >
          <bdi>{fileName}</bdi>
        </span>
      </span>
      {stat ? (
        <span className="shrink-0 pl-1 font-mono text-[10px] leading-none">
          <DiffStatLabel additions={stat.additions} deletions={stat.deletions} />
        </span>
      ) : null}
      {trailing}
    </div>
  );
}
