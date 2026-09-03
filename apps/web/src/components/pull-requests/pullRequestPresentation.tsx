/**
 * The words and the classes every pull request surface shares, so a section
 * heading, a separator dot or a verdict reads the same in the header, the
 * Summary tab, the Code tab and the Timeline.
 */
import { getChangeRequestTerminologyForKind } from "@threadlines/shared/sourceControl";

import { useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { TooltipWrapper } from "../ui/tooltip";
import type {
  PullRequestActor,
  PullRequestChecksState,
  PullRequestReviewDecision,
  PullRequestReviewerState,
  SourceControlProviderKind,
} from "@threadlines/contracts";
import {
  ArrowLeftIcon,
  CheckIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleXIcon,
  MinusIcon,
  UserRoundCheckIcon,
  UserRoundIcon,
  UserRoundXIcon,
  XIcon,
} from "lucide-react";

import { resolveChangeRequestPresentationForKind } from "../../sourceControlPresentation";
import { pullRequestLabelColor } from "./pullRequests.logic";

export const SECTION_LABEL_CLASS =
  "mb-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/55 select-none";

export const META_SEPARATOR_CLASS = "shrink-0 text-muted-foreground/30";

export const TEXT_BUTTON_CLASS =
  "cursor-pointer rounded-sm text-muted-foreground/70 transition-colors hover:text-foreground focus-ring";

/** Reviewer and review verdicts as words, the wire values being kebab-case. */
export const REVIEW_STATE_WORDS: Readonly<Record<PullRequestReviewerState, string>> = {
  approved: "Approved",
  "changes-requested": "Changes requested",
  commented: "Commented",
  dismissed: "Dismissed",
  pending: "Pending",
};

export const CHECK_TONES = {
  success: { Icon: CheckIcon, className: "text-success" },
  failure: { Icon: XIcon, className: "text-destructive" },
  // A still glyph rather than a spinner: a long check run would repaint for
  // minutes, and the row already says it is pending.
  pending: { Icon: CircleDashedIcon, className: "text-muted-foreground/70" },
  skipped: { Icon: MinusIcon, className: "text-muted-foreground/50" },
} as const;

/**
 * The host by name, as an "Open on …" reads it. A remote we do not recognise
 * has no name to give, so it stays "the host".
 */
export function pullRequestHostName(provider: SourceControlProviderKind): string {
  return provider === "unknown"
    ? "the host"
    : resolveChangeRequestPresentationForKind(provider).providerName;
}

/**
 * A person as the host draws them: their picture, or the first letter of their
 * login while there is none. A picture that never arrives falls back to the
 * same letter rather than leaving a broken image in the row.
 */
export function PullRequestActorAvatar({
  actor,
  className,
}: {
  readonly actor: PullRequestActor | null;
  readonly className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const login = actor?.login ?? "ghost";
  const avatarUrl = actor?.avatarUrl ?? null;

  if (avatarUrl === null || failed) {
    return (
      <span
        aria-hidden
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[8px] font-medium text-muted-foreground",
          className,
        )}
      >
        {login.slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      aria-hidden
      alt=""
      src={avatarUrl}
      loading="lazy"
      className={cn("size-4 shrink-0 rounded-full bg-muted object-cover", className)}
      onError={() => setFailed(true)}
    />
  );
}

/** The avatar and the login together, as a row or a header names an author. */
export function PullRequestActorLabel({
  actor,
  className,
}: {
  readonly actor: PullRequestActor | null;
  readonly className?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <PullRequestActorAvatar actor={actor} />
      <span className="truncate">{actor?.login ?? "ghost"}</span>
    </span>
  );
}

/**
 * One label as the host paints it: a hairline pill with the label's own colour
 * in the dot and nowhere else, so a row of them stays as quiet as the rest of
 * the meta line. The pills are the page's one exception to the flat rule, and
 * they earn it by naming what a colour alone cannot.
 */
export function PullRequestLabelPill({
  name,
  color,
  className,
}: {
  readonly name: string;
  readonly color: string | null;
  /** The Summary's rows carry them at the surrounding `text-xs`. */
  readonly className?: string;
}) {
  const dot = pullRequestLabelColor(color);
  return (
    <span
      className={cn(
        "inline-flex max-w-40 min-w-0 items-center gap-1 rounded-full border border-border/70 bg-muted/40 py-0 pl-1 pr-1.5 text-[10px] leading-3.5 text-muted-foreground",
        className,
      )}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full bg-muted-foreground"
        {...(dot ? { style: { backgroundColor: dot } } : {})}
      />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** The check rollup as a glyph: a colour and a word, no room for a sentence. */
const CHECKS_STATE_PRESENTATION = {
  success: {
    label: "All checks passed",
    Icon: CircleCheckIcon,
    className: "text-emerald-600 dark:text-emerald-300/90",
  },
  failure: {
    label: "Some checks failed",
    Icon: CircleXIcon,
    className: "text-destructive",
  },
  // A still glyph rather than a spinner: a check run takes minutes, and a
  // repainting list row is not worth the frames.
  pending: {
    label: "Checks running",
    Icon: CircleDotIcon,
    className: "text-amber-600/90 dark:text-amber-400/80",
  },
} as const satisfies Record<
  PullRequestChecksState,
  { label: string; Icon: typeof CircleCheckIcon; className: string }
>;

/**
 * The glyph and words for a check rollup, for a surface that draws them itself
 * rather than taking {@link PullRequestChecksGlyph} whole (the detail header,
 * whose glyph sits inside a button of its own and must not carry a second
 * tooltip). Null where the host reported no checks at all.
 */
export function pullRequestChecksTone(
  state: PullRequestChecksState | "none" | undefined,
): (typeof CHECKS_STATE_PRESENTATION)[PullRequestChecksState] | null {
  return state === undefined || state === "none" ? null : CHECKS_STATE_PRESENTATION[state];
}

/**
 * Where a list row would otherwise spend its meta line on the words "Checks
 * failing". The word itself stays for anyone who cannot see the colour, and
 * for everyone else it is a tooltip away.
 */
export function PullRequestChecksGlyph({
  state,
  className,
}: {
  readonly state: PullRequestChecksState | undefined;
  readonly className?: string;
}) {
  const presentation = pullRequestChecksTone(state);
  if (presentation === null) {
    return null;
  }
  return (
    <TooltipWrapper tooltip={presentation.label}>
      <span
        className={cn(
          "pointer-events-auto inline-flex shrink-0 items-center",
          presentation.className,
          className,
        )}
      >
        <presentation.Icon aria-hidden className="size-3.5" />
        <span className="sr-only">{presentation.label}</span>
      </span>
    </TooltipWrapper>
  );
}

/**
 * Where the reviewers stand, as a glyph: the same three words the Review filter
 * uses, in the tones the checks glyph beside it already spends.
 */
const REVIEW_STATE_PRESENTATION = {
  approved: {
    label: "Approved",
    Icon: UserRoundCheckIcon,
    className: "text-emerald-600 dark:text-emerald-300/90",
  },
  "changes-requested": {
    label: "Changes requested",
    Icon: UserRoundXIcon,
    className: "text-amber-600/90 dark:text-amber-400/80",
  },
  // Nobody has answered yet, which is a fact about the row rather than news:
  // muted, the way the meta line around it is.
  "review-required": {
    label: "Review required",
    Icon: UserRoundIcon,
    className: "text-muted-foreground/70",
  },
} as const satisfies Record<
  PullRequestReviewDecision,
  { label: string; Icon: typeof UserRoundIcon; className: string }
>;

/**
 * How a row's reviews read, or null when there is nothing to say. A review the
 * host is waiting on from the viewer is review required whatever else it
 * reports, since that is the part the viewer can act on.
 */
export function pullRequestReviewTone(input: {
  readonly decision: PullRequestReviewDecision | undefined;
  readonly reviewRequested: boolean | undefined;
}): (typeof REVIEW_STATE_PRESENTATION)[PullRequestReviewDecision] | null {
  if (input.reviewRequested === true) {
    return REVIEW_STATE_PRESENTATION["review-required"];
  }
  return input.decision === undefined ? null : REVIEW_STATE_PRESENTATION[input.decision];
}

/**
 * Where a list row would otherwise spend its meta line on a coloured word. The
 * word stays for anyone who cannot see the colour, and is a tooltip away for
 * everyone else, exactly as {@link PullRequestChecksGlyph} does beside it.
 */
export function PullRequestReviewGlyph({
  decision,
  reviewRequested,
  className,
}: {
  readonly decision: PullRequestReviewDecision | undefined;
  /** Whether the host is waiting on the viewer's own review of this row. */
  readonly reviewRequested?: boolean;
  readonly className?: string;
}) {
  const presentation = pullRequestReviewTone({ decision, reviewRequested });
  if (presentation === null) {
    return null;
  }
  return (
    <TooltipWrapper tooltip={presentation.label}>
      <span
        className={cn(
          "pointer-events-auto inline-flex shrink-0 items-center",
          presentation.className,
          className,
        )}
      >
        <presentation.Icon aria-hidden className="size-3.5" />
        <span className="sr-only">{presentation.label}</span>
      </span>
    </TooltipWrapper>
  );
}

/**
 * Scrolls the Summary tab so `target` sits at its top. Only the Summary's own
 * scroll box moves: `scrollIntoView` would also scroll every scrolling
 * ancestor, which on the page shoved the whole shell up and left a blank band
 * under it that nothing could scroll back from.
 */
export function scrollPullRequestSummaryTo(target: HTMLElement | null): void {
  const scroller = target?.closest<HTMLElement>("[data-pull-request-summary-scroll]");
  if (!target || !scroller) {
    return;
  }
  const top =
    scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.scrollTo({ top, behavior: "smooth" });
}

/** The dot that separates two facts on a meta line. */
export function MetaSeparator() {
  return (
    <span aria-hidden className={META_SEPARATOR_CLASS}>
      ·
    </span>
  );
}

/** "pull request" on GitHub, "merge request" on GitLab: the host's own word for the thing. */
export function changeRequestWord(provider: SourceControlProviderKind): string {
  return getChangeRequestTerminologyForKind(provider).singular;
}

/**
 * One choice out of a few, as plain words: the chosen one in the foreground,
 * the rest muted, no box around any of them. This is the app's answer to a
 * segmented control, which it does not use.
 */
export function TextChoice<Value extends string>({
  label,
  value,
  options,
  onChange,
  className,
  testIdPrefix,
}: {
  readonly label: string;
  readonly value: Value;
  readonly options: readonly { readonly value: Value; readonly label: string }[];
  readonly onChange: (value: Value) => void;
  readonly className?: string;
  /** Gives each option `${testIdPrefix}-${value}` for tests. */
  readonly testIdPrefix?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-xs", className)}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            data-testid={testIdPrefix ? `${testIdPrefix}-${option.value}` : undefined}
            className={cn(
              "group/choice inline-flex cursor-pointer items-center gap-1.5 rounded-sm transition-colors focus-ring",
              checked ? "text-foreground" : "text-muted-foreground/70 hover:text-foreground",
            )}
            onClick={() => onChange(option.value)}
          >
            {/* A radio dot, so a row of plain words reads as a choice to make
                rather than a caption. Hairline ring, filled when chosen. The
                fill is a gradient on the ring itself rather than a child: a
                nested box lands off-centre by a device pixel on fractional
                display scales, a gradient is drawn dead centre. */}
            <span
              aria-hidden
              className={cn(
                "size-3 shrink-0 rounded-full border transition-colors",
                checked
                  ? "border-foreground bg-[radial-gradient(circle,var(--foreground)_3px,transparent_3.5px)]"
                  : "border-muted-foreground/50 group-hover/choice:border-foreground",
              )}
            />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The way back on a phone. Below the two-column width the pull request detail
 * stands in for the list, so leaving it is a step back rather than a close.
 * Drawn by the panel and by the skeleton that stands in for it.
 */
export function BackToListButton({ onClick }: { readonly onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="lg:hidden"
      tooltip="Back"
      aria-label="Back to pull requests"
      onClick={onClick}
    >
      <ArrowLeftIcon className="size-3.5" />
    </Button>
  );
}

/** The close beside a list wide enough to stay on screen; the phone has the back arrow instead. */
export function CloseDetailButton({
  className,
  onClick,
}: {
  readonly className?: string;
  readonly onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn("max-lg:hidden", className)}
      tooltip="Close"
      aria-label="Close pull request details"
      onClick={onClick}
    >
      <XIcon className="size-3.5" />
    </Button>
  );
}

/**
 * The detail before it is read, laid out as the header, tab strip and
 * description it is about to become, so nothing moves when the words arrive.
 * The way out is real rather than drawn: on a phone this is the whole screen.
 */
export function PullRequestDetailSkeleton({ onClose }: { readonly onClose?: () => void }) {
  return (
    <div className="flex h-full min-h-0 flex-col" role="status" aria-label="Loading pull request">
      <div className="shrink-0 px-4 pt-2 pb-3">
        {/* Row 1: the repository line, with the way out where the header keeps it. */}
        <div className="flex min-h-7 min-w-0 items-center gap-2">
          <Skeleton className="size-4 shrink-0 rounded-full" />
          <Skeleton className="h-3 w-40 shrink-0 rounded-full" />
          <span className="ml-auto flex shrink-0 items-center">
            {onClose ? <BackToListButton onClick={onClose} /> : null}
            {onClose ? <CloseDetailButton onClick={onClose} /> : null}
          </span>
        </div>
        {/* Row 2: the title. */}
        <Skeleton className="mt-1 h-4 w-full max-w-96 rounded-full" />
        {/* Row 3: the author and when it last moved. */}
        <div className="mt-2 flex items-center gap-1.5">
          <Skeleton className="size-4 shrink-0 rounded-full" />
          <Skeleton className="h-2.5 w-16 rounded-full" />
          <Skeleton className="h-2.5 w-20 rounded-full" />
        </div>
        {/* Row 4: base ← head, with the file count at the far end. */}
        <div className="mt-3 flex items-center gap-1.5">
          <Skeleton className="h-2.5 w-14 rounded-full" />
          <Skeleton className="h-2.5 w-3 rounded-full" />
          <Skeleton className="h-2.5 w-32 rounded-full" />
          <Skeleton className="ml-auto h-2.5 w-20 rounded-full" />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-5 border-b border-border px-4 pt-1 pb-3">
        <Skeleton className="h-3.5 w-16 rounded-full" />
        <Skeleton className="h-3.5 w-12 rounded-full" />
        <Skeleton className="h-3.5 w-14 rounded-full" />
      </div>
      <div className="px-4 py-4">
        <Skeleton className="h-2.5 w-20 rounded-full" />
        <Skeleton className="mt-3 h-2.5 w-full rounded-full" />
        <Skeleton className="mt-2 h-2.5 w-11/12 rounded-full" />
        <Skeleton className="mt-2 h-2.5 w-2/3 rounded-full" />
      </div>
    </div>
  );
}

/** Line widths for the placeholder diff, uneven the way code is. */
const DIFF_SKELETON_FILES: readonly (readonly string[])[] = [
  ["w-2/5", "w-3/5", "w-1/3", "w-4/5", "w-1/2", "w-2/3"],
  ["w-1/2", "w-1/4", "w-3/5"],
];

/**
 * The Code tab before its diff can be drawn: file headers and code lines at
 * the real heights, so the wait reads as the diff arriving rather than an
 * empty pane. Stands in both for the patch being read and for the viewer's
 * worker still loading, which on a slow connection is the longer of the two.
 */
export function PullRequestDiffSkeleton({ label }: { readonly label: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-hidden" role="status" aria-label={label}>
      {DIFF_SKELETON_FILES.map((lines, fileIndex) => (
        <div key={fileIndex} className="mt-2 first:mt-2">
          <div className="flex h-9 items-center gap-1.5 border-y border-border pr-3 pl-1.5">
            <span className="flex size-5 shrink-0 items-center justify-center">
              <Skeleton className="size-3 rounded-sm" />
            </span>
            <Skeleton className={cn("h-3 rounded-full", fileIndex === 0 ? "w-56" : "w-40")} />
            <span className="ml-auto flex items-center gap-1.5">
              <Skeleton className="h-2.5 w-6 rounded-full" />
              <Skeleton className="h-2.5 w-6 rounded-full" />
            </span>
          </div>
          <div className="py-1.5">
            {lines.map((width, lineIndex) => (
              <div key={lineIndex} className="flex h-5 items-center gap-4 px-3">
                <Skeleton className="h-2.5 w-5 shrink-0 rounded-full" />
                <Skeleton className={cn("h-2.5 rounded-full", width)} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
