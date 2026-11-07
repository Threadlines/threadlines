import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "~/lib/utils";

export interface EffortMeterOption {
  readonly id: string;
  readonly label: string;
}

/** Stagger between segments as a level charges up (or drains), per segment. */
const CHARGE_STEP_MS = 55;
const DRAIN_STEP_MS = 45;
/** Stagger of the hover preview's see-through fill. */
const GHOST_STEP_MS = 35;
/** How long a segment that a model no longer offers takes to fold away. */
const SEGMENT_LEAVE_MS = 300;
const POP_KEYFRAMES: Keyframe[] = [
  { transform: "scaleY(1)" },
  { transform: "scaleY(1.9)", offset: 0.45 },
  { transform: "scaleY(1)" },
];

interface ShownSegment {
  readonly option: EffortMeterOption;
  /** Dropped by the options: folding away. */
  readonly leaving: boolean;
  /** New since the meter first showed: growing in. */
  readonly entering: boolean;
}

/**
 * Keeps a segment the options dropped on screen for a moment, so switching
 * to a model with fewer levels folds the extra ones away instead of jumping,
 * and grows in the ones a model with more levels adds. Segments present when
 * the meter first shows never animate.
 */
function useShownSegments(options: ReadonlyArray<EffortMeterOption>): ReadonlyArray<ShownSegment> {
  const [leaving, setLeaving] = useState<ReadonlyArray<{ option: EffortMeterOption; at: number }>>(
    [],
  );
  const [entering, setEntering] = useState<ReadonlySet<string>>(() => new Set());
  const previousRef = useRef(options);
  useLayoutEffect(() => {
    const previous = previousRef.current;
    previousRef.current = options;
    if (previous === options) return;
    const kept = new Set(options.map((option) => option.id));
    const before = new Set(previous.map((option) => option.id));
    const dropped = previous
      .map((option, at) => ({ option, at }))
      .filter((entry) => !kept.has(entry.option.id));
    const added = options.filter((option) => !before.has(option.id)).map((option) => option.id);
    if (dropped.length === 0 && added.length === 0) return;
    setLeaving((current) => [...current.filter((entry) => !kept.has(entry.option.id)), ...dropped]);
    setEntering(new Set(added));
    const timer = window.setTimeout(() => {
      setLeaving((current) => current.filter((entry) => !dropped.includes(entry)));
      setEntering(new Set());
    }, SEGMENT_LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [options]);
  const shown: ShownSegment[] = options.map((option) => ({
    option,
    leaving: false,
    entering: entering.has(option.id),
  }));
  for (const entry of [...leaving].sort((a, b) => a.at - b.at)) {
    if (shown.some((segment) => segment.option.id === entry.option.id)) continue;
    shown.splice(Math.min(entry.at, shown.length), 0, {
      option: entry.option,
      leaving: true,
      entering: false,
    });
  }
  return shown;
}

interface RollEntry {
  readonly id: number;
  readonly text: string;
  readonly preview: boolean;
  readonly up: boolean;
  readonly leaving: boolean;
}

/**
 * The level's name beside the meter, rolling like the rail update card's
 * numbers: up for a higher level, down for a lower one. A previewed level
 * (under the pointer) reads grey with an arrow; the chosen one reads full.
 */
function RollingLevelName(props: { text: string; preview: boolean; up: boolean }) {
  const { text, preview, up } = props;
  const [entries, setEntries] = useState<ReadonlyArray<RollEntry>>(() => [
    { id: 0, text, preview, up, leaving: false },
  ]);
  const latest = entries.at(-1);
  if (latest && (latest.text !== text || latest.preview !== preview)) {
    setEntries([
      ...entries
        .filter((entry) => !entry.leaving)
        .map((entry) => ({ ...entry, up, leaving: true })),
      { id: latest.id + 1, text, preview, up, leaving: false },
    ]);
  }
  const hasLeaving = entries.some((entry) => entry.leaving);
  useEffect(() => {
    if (!hasLeaving) return;
    const timer = window.setTimeout(
      () => setEntries((current) => current.filter((entry) => !entry.leaving)),
      220,
    );
    return () => window.clearTimeout(timer);
  }, [hasLeaving]);
  return (
    <span
      aria-hidden="true"
      className="relative block h-4 w-22 shrink-0 overflow-hidden text-right text-xs leading-4"
    >
      {entries.map((entry) => (
        <span
          key={entry.id}
          className={cn(
            "absolute inset-x-0 top-0 block truncate whitespace-nowrap motion-reduce:animate-none",
            entry.preview ? "text-muted-foreground" : "font-medium text-foreground",
            entry.leaving
              ? entry.up
                ? "animate-[update-card-roll-out_200ms_cubic-bezier(0.2,0.8,0.2,1)_forwards]"
                : "animate-[effort-roll-out-down_200ms_cubic-bezier(0.2,0.8,0.2,1)_forwards]"
              : entry.id > 0 &&
                  (entry.up
                    ? "animate-[update-card-roll-in_200ms_cubic-bezier(0.2,0.8,0.2,1)]"
                    : "animate-[effort-roll-in-down_200ms_cubic-bezier(0.2,0.8,0.2,1)]"),
          )}
        >
          {entry.preview ? <span className="me-1 opacity-70">→</span> : null}
          {entry.text}
        </span>
      ))}
    </span>
  );
}

/**
 * An agent's reasoning level as a row of segments filled up to the chosen
 * one. Choosing a higher level charges the new segments one after another
 * with a small pop; a lower one drains them. Pointing at a segment previews
 * it: the segments it would add fill see-through, the ones it would drop
 * fade, and the name rolls to the pointed-at level in grey. The chosen
 * level's name comes back when the pointer leaves.
 *
 * Every effect moves or fades the segments only, runs once per change, and
 * stays still under reduced motion. Keyboard: a radio group, where the arrow
 * keys step the level and focus follows it.
 */
export const EffortMeter = memo(function EffortMeter(props: {
  options: ReadonlyArray<EffortMeterOption>;
  /** The chosen option's id; null when the agent picks for itself. */
  value: string | null;
  onChange: (id: string) => void;
  /** Names the group for assistive tech, e.g. "Effort". */
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const { options, value, onChange, label, disabled = false } = props;
  const selectedIndex = options.findIndex((option) => option.id === value);
  const shown = useShownSegments(options);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const hoverIndex = hoverId === null ? -1 : options.findIndex((option) => option.id === hoverId);
  const segmentRefs = useRef(new Map<string, HTMLButtonElement>());
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });
  // Where the last change came from, so the fill can charge or drain in order.
  const [change, setChange] = useState({ from: selectedIndex, to: selectedIndex });
  if (change.to !== selectedIndex) {
    setChange({ from: change.to, to: selectedIndex });
  }
  const charging = change.to > change.from;

  useEffect(() => {
    if (change.from === change.to || change.to <= change.from) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animations: Animation[] = [];
    for (let index = Math.max(0, change.from + 1); index <= change.to; index += 1) {
      const option = optionsRef.current[index];
      const element = option ? segmentRefs.current.get(option.id) : undefined;
      animations.push(
        ...(element
          ? [
              element.animate(POP_KEYFRAMES, {
                duration: 260,
                delay: (index - change.from - 1) * CHARGE_STEP_MS,
                easing: "cubic-bezier(0.3, 1.6, 0.5, 1)",
              }),
            ]
          : []),
      );
    }
    return () => {
      for (const animation of animations) animation.cancel();
    };
  }, [change]);

  const choose = (index: number, focus: boolean) => {
    const option = options[index];
    if (!option || disabled) return;
    if (option.id !== value) onChange(option.id);
    if (focus) segmentRefs.current.get(option.id)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const from = selectedIndex < 0 ? 0 : selectedIndex;
    const next =
      event.key === "ArrowRight" || event.key === "ArrowUp"
        ? Math.min(options.length - 1, from + 1)
        : event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? Math.max(0, from - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? options.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    setHoverId(null);
    choose(next, true);
  };

  const previewing = hoverIndex >= 0 && hoverIndex !== selectedIndex;
  const shownName = previewing
    ? (options[hoverIndex]?.label ?? "")
    : (options[selectedIndex]?.label ?? "Default");

  return (
    <div className={cn("flex min-w-0 flex-1 items-center gap-2.5", props.className)}>
      <div
        role="radiogroup"
        aria-label={label}
        aria-disabled={disabled || undefined}
        data-effort-meter="true"
        className="flex min-w-0 flex-1 items-center gap-[3px] py-1.5"
        onPointerLeave={() => setHoverId(null)}
      >
        {shown.map(({ option, leaving, entering }) => {
          const index = options.indexOf(option);
          const on = !leaving && index <= selectedIndex;
          const adds =
            previewing &&
            hoverIndex > selectedIndex &&
            index > selectedIndex &&
            index <= hoverIndex;
          const drops =
            previewing &&
            hoverIndex < selectedIndex &&
            index > hoverIndex &&
            index <= selectedIndex;
          const fillDelay = !leaving
            ? charging
              ? index > change.from && index <= change.to
                ? (index - change.from - 1) * CHARGE_STEP_MS
                : 0
              : index > change.to && index <= change.from
                ? (change.from - index) * DRAIN_STEP_MS
                : drops
                  ? (selectedIndex - index) * 30
                  : 0
            : 0;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={index === selectedIndex}
              aria-label={option.label}
              tabIndex={leaving ? -1 : index === (selectedIndex < 0 ? 0 : selectedIndex) ? 0 : -1}
              disabled={disabled || leaving}
              data-effort-level={option.id}
              ref={(element) => {
                if (element) segmentRefs.current.set(option.id, element);
                else segmentRefs.current.delete(option.id);
              }}
              className={cn(
                "relative h-2 min-w-0 flex-1 basis-0 cursor-pointer rounded-full bg-foreground/13 outline-none transition-transform duration-150 hover:bg-foreground/20 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-popover disabled:cursor-default motion-reduce:transition-none",
                leaving &&
                  "pointer-events-none animate-[effort-segment-out_300ms_ease_forwards] motion-reduce:animate-none",
                entering && "animate-[effort-segment-in_300ms_ease] motion-reduce:animate-none",
                index === hoverIndex && !leaving && "scale-y-[1.35]",
              )}
              onPointerEnter={() => {
                if (!leaving && !disabled) setHoverId(option.id);
              }}
              onClick={() => choose(index, false)}
              onKeyDown={onKeyDown}
            >
              {/* The preview's see-through fill, under the real one. */}
              <span
                aria-hidden="true"
                className={cn(
                  "absolute inset-0 origin-left rounded-full bg-primary-graph/40 transition-transform duration-150 ease-out motion-reduce:transition-none",
                  adds ? "scale-x-100" : "scale-x-0",
                )}
                style={{
                  transitionDelay: adds
                    ? `${(index - selectedIndex - 1) * GHOST_STEP_MS}ms`
                    : "0ms",
                }}
              />
              <span
                aria-hidden="true"
                className={cn(
                  "absolute inset-0 origin-left rounded-full bg-primary-graph transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none",
                  on ? "scale-x-100" : "scale-x-0",
                  drops && "opacity-30",
                )}
                style={{ transitionDelay: `${fillDelay}ms` }}
              />
            </button>
          );
        })}
      </div>
      <RollingLevelName
        text={shownName}
        preview={previewing}
        up={previewing ? hoverIndex > selectedIndex : charging}
      />
    </div>
  );
});
