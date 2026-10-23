import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { RailUpdateCard as RailUpdateCardModel } from "../desktopUpdate.logic";
import { cn } from "~/lib/utils";

/** One line of the card: every digit row is exactly this tall. */
const ROW_PX = 16;
/** How long a digit takes to land after a check, plus this much per column to its left. */
const LAND_MS = 480;
const LAND_STAGGER_MS = 150;
/** One turn of a spinning digit; the rightmost turns fastest, like a counter. */
const SPIN_MS = 300;
const SPIN_STEP_MS = 110;
const ROLL_OUT_MS = 280;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

const rowOffset = (rows: number) => `translateY(${-rows * ROW_PX}px)`;

/** A digit's strip: 0-9, four times over, so it can always roll on. */
const STRIP = Array.from({ length: 40 }, (_, row) => ({ key: `row-${row}`, digit: row % 10 }));

/**
 * One rolling digit. While `spinning` it turns over without end, starting
 * from the digit it shows (a transform animation: nothing repaints). When
 * the spin stops, or the digit changes, it rolls on from where it is, always
 * forward and past 9 when it has to, like a counter, and settles on `digit`.
 */
function DigitColumn({
  digit,
  spinning,
  position,
  count,
}: {
  readonly digit: number;
  readonly spinning: boolean;
  /** Its place from the left, among `count` digits that land in turn. */
  readonly position: number;
  readonly count: number;
}) {
  const stripRef = useRef<HTMLSpanElement>(null);
  const restingRef = useRef(digit);
  const spinRef = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (strip) strip.style.transform = rowOffset(restingRef.current);
  }, []);

  useEffect(() => () => spinRef.current?.cancel(), []);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const reduce = prefersReducedMotion();
    if (spinning && !reduce) {
      if (!spinRef.current) {
        strip.style.transition = "none";
        const from = restingRef.current;
        spinRef.current = strip.animate(
          [{ transform: rowOffset(from) }, { transform: rowOffset(from + 10) }],
          { duration: SPIN_MS + (count - 1 - position) * SPIN_STEP_MS, iterations: Infinity },
        );
      }
      return;
    }
    const spun = spinRef.current;
    const previous = restingRef.current;
    if (!spun && digit === previous) return;
    restingRef.current = digit;
    let fromY = -previous * ROW_PX;
    if (spun) {
      fromY = new DOMMatrix(getComputedStyle(strip).transform).m42;
      spun.cancel();
      spinRef.current = null;
    }
    if (reduce) {
      strip.style.transition = "none";
      strip.style.transform = rowOffset(digit);
      return;
    }
    // On from where it is: the next row showing `digit`, at least a row away.
    const fromRow = -fromY / ROW_PX;
    const target = Math.floor(fromRow) + 1 + ((digit - ((Math.floor(fromRow) + 1) % 10) + 10) % 10);
    strip.style.transition = "none";
    strip.style.transform = `translateY(${fromY}px)`;
    strip.getBoundingClientRect();
    const ms = LAND_MS + position * LAND_STAGGER_MS;
    strip.style.transition = `transform ${ms}ms cubic-bezier(0.22, 1.3, 0.42, 1)`;
    strip.style.transform = rowOffset(target);
    const settle = window.setTimeout(() => {
      strip.style.transition = "none";
      strip.style.transform = rowOffset(digit);
    }, ms + 40);
    return () => window.clearTimeout(settle);
  }, [count, digit, position, spinning]);

  return (
    <span className="inline-block h-4 overflow-hidden [mask-image:linear-gradient(transparent,#000_22%,#000_78%,transparent)]">
      <span ref={stripRef} className="flex flex-col will-change-transform">
        {STRIP.map((row) => (
          <span key={row.key} className="h-4 tabular-nums">
            {row.digit}
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * A number that rolls: its digits roll, anything else (the dots of a
 * version) stays put. A different number of digits starts it over, without
 * a roll, rather than rolling digits into the wrong places.
 */
function RollingNumber({
  value,
  spinning,
}: {
  readonly value: string;
  readonly spinning: boolean;
}) {
  // Keyed by place: the digit in a place is the one that rolls to its next value.
  let digitCount = 0;
  const places = [...value].map((char, place) => ({
    key: `place-${place}`,
    char,
    digitPlace: /\d/.test(char) ? digitCount++ : null,
  }));
  return (
    <span key={value.length} className="inline-flex items-baseline">
      {places.map((place) =>
        place.digitPlace === null ? (
          <span key={place.key}>{place.char}</span>
        ) : (
          <DigitColumn
            key={place.key}
            digit={Number(place.char)}
            spinning={spinning}
            position={place.digitPlace}
            count={digitCount}
          />
        ),
      )}
    </span>
  );
}

/**
 * Words that roll: a new `rollKey` slides the old words up and out while the
 * new ones come up from below; new words under the same key (a percent
 * ticking up) just replace the old. The newest words size the line; the
 * leaving ones float over it.
 */
function RollingText({
  text,
  rollKey = text,
  className,
}: {
  readonly text: string;
  readonly rollKey?: string;
  readonly className?: string;
}) {
  const [entries, setEntries] = useState([{ id: 0, rollKey, text, leaving: false }]);
  const latest = entries[entries.length - 1]!;
  if (latest.rollKey !== rollKey) {
    setEntries([
      ...entries.filter((entry) => !entry.leaving).map((entry) => ({ ...entry, leaving: true })),
      { id: latest.id + 1, rollKey, text, leaving: false },
    ]);
  } else if (latest.text !== text) {
    setEntries(entries.map((entry) => (entry === latest ? { ...entry, text } : entry)));
  }
  const hasLeaving = entries.some((entry) => entry.leaving);
  useEffect(() => {
    if (!hasLeaving) return;
    const timer = window.setTimeout(
      () => setEntries((current) => current.filter((entry) => !entry.leaving)),
      ROLL_OUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [hasLeaving]);

  return (
    <span className={cn("relative inline-block h-4 overflow-hidden align-top", className)}>
      {entries.map((entry) => (
        <span
          key={entry.id}
          aria-hidden={entry.leaving ? true : undefined}
          className={cn(
            "block whitespace-nowrap motion-reduce:animate-none",
            entry.leaving
              ? "absolute top-0 left-0 animate-[update-card-roll-out_260ms_cubic-bezier(0.2,0.8,0.2,1)_forwards]"
              : entry.id > 0 && "animate-[update-card-roll-in_260ms_cubic-bezier(0.2,0.8,0.2,1)]",
          )}
        >
          {entry.text}
        </span>
      ))}
    </span>
  );
}

/**
 * The rail's update card: the version as an odometer. While a check runs its
 * digits spin; the answer lands them, back on the version the user has, or
 * forward on the one an update brings, in the update color. A nightly's tag
 * rolls its build the same way.
 *
 * The card fits its words, the same space either side, and while it stays
 * open it only grows (gliding), so a shorter line never makes it shrink and
 * grow back. It fits exactly again the next time it opens.
 */
export function RailUpdateCard({ card }: { readonly card: RailUpdateCardModel }) {
  const contentRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const need = Math.ceil(content.offsetWidth);
    setWidth((current) => (current === null ? need : Math.max(current, need)));
  });

  const versionTone = card.changed.triple ? "text-primary-readable" : undefined;
  return (
    <span
      // Width can't glide from auto, so the first fit is instant.
      className="block transition-[width] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none"
      style={width === null ? undefined : { width }}
      data-testid="rail-update-card"
    >
      <span ref={contentRef} className="flex w-max flex-col gap-0.5">
        <span className="flex items-center whitespace-nowrap" data-testid="rail-update-card-title">
          <RollingText text={card.lead} className="me-1" />
          <span
            className={cn("inline-flex transition-colors duration-300", versionTone)}
            data-testid="rail-update-card-version"
            data-changed={card.changed.triple ? "" : undefined}
          >
            v<RollingNumber value={card.version.triple} spinning={card.checking} />
          </span>
          {card.channel ? (
            <span
              className={cn(
                "ms-1.5 inline-flex h-4 items-center gap-1 rounded-[4px] px-1 font-mono text-[10.5px] transition-colors duration-300",
                card.changed.build
                  ? "bg-primary-readable/14 text-primary-readable"
                  : "bg-foreground/8 text-muted-foreground",
              )}
            >
              {card.channel}
              {card.version.build ? (
                <RollingNumber value={card.version.build} spinning={card.checking} />
              ) : null}
            </span>
          ) : null}
        </span>
        <RollingText
          text={card.line}
          rollKey={card.lineKind}
          className={cn(
            "text-[11px]",
            card.lineTone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        />
      </span>
    </span>
  );
}
