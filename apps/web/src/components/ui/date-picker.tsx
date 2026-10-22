"use client";

import type { VariantProps } from "class-variance-authority";
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { type KeyboardEvent, type RefObject, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { cn } from "~/lib/utils";
import { Button } from "./button";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover";
import { selectTriggerIconClassName, selectTriggerVariants } from "./select";

/*
 * Days here are "YYYY-MM-DD" strings: a day on the calendar, not an instant.
 * All arithmetic runs on UTC midnights and every formatter pins `timeZone:
 * "UTC"`, so no zone offset or daylight saving change can move a day, and
 * the fixed-width strings compare in calendar order.
 */

const DAY_MS = 86_400_000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isCalendarDay(day: string | undefined): day is string {
  if (day === undefined) return false;
  const match = DAY_PATTERN.exec(day);
  if (!match) return false;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const date = new Date(Date.UTC(year, monthIndex, Number(match[3])));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === monthIndex &&
    date.getUTCDate() === Number(match[3])
  );
}

function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

function dateToDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, amount: number): string {
  return dateToDay(new Date(dayToDate(day).getTime() + amount * DAY_MS));
}

/** The same day of the month `amount` months away, clamped to that month's length. */
function addMonths(day: string, amount: number): string {
  const date = dayToDate(day);
  const year = date.getUTCFullYear();
  const monthIndex = date.getUTCMonth() + amount;
  const monthLength = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return dateToDay(new Date(Date.UTC(year, monthIndex, Math.min(date.getUTCDate(), monthLength))));
}

function lastDayOfMonth(day: string): string {
  const date = dayToDate(day);
  return dateToDay(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)));
}

function startOfWeek(day: string, firstDayOfWeek: number): string {
  return addDays(day, -((dayToDate(day).getUTCDay() - firstDayOfWeek + 7) % 7));
}

function localToday(): string {
  const now = new Date();
  return dateToDay(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}

type LocaleWithWeekInfo = Intl.Locale & {
  readonly getWeekInfo?: () => { readonly firstDay: number };
  readonly weekInfo?: { readonly firstDay: number };
};

let cachedFirstDayOfWeek: number | undefined;

/**
 * The locale's first day of the week, 0 (Sunday) to 6 (Saturday). Chromium
 * exposes week data as `getWeekInfo()` (older builds: a `weekInfo` getter);
 * engines without either start on Sunday.
 */
function firstDayOfWeek(): number {
  if (cachedFirstDayOfWeek !== undefined) return cachedFirstDayOfWeek;
  let firstDay = 0;
  try {
    const locale: LocaleWithWeekInfo = new Intl.Locale(
      new Intl.DateTimeFormat().resolvedOptions().locale,
    );
    const weekInfo =
      typeof locale.getWeekInfo === "function" ? locale.getWeekInfo() : locale.weekInfo;
    if (weekInfo && Number.isInteger(weekInfo.firstDay)) firstDay = weekInfo.firstDay % 7;
  } catch {
    // Keep Sunday.
  }
  cachedFirstDayOfWeek = firstDay;
  return firstDay;
}

const triggerDayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const fullDayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const monthTitleFormat = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const shortWeekdayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  timeZone: "UTC",
});
const longWeekdayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  timeZone: "UTC",
});

export interface DatePickerProps {
  /** "YYYY-MM-DD" (a calendar day, no time zone). */
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Earliest selectable day, "YYYY-MM-DD"; days before it are disabled. */
  readonly min?: string | undefined;
  /**
   * The day marked as today, "YYYY-MM-DD"; defaults to the viewer's local
   * today. Lets callers mark "today" in another zone and keeps tests
   * deterministic.
   */
  readonly today?: string | undefined;
  readonly size?: VariantProps<typeof selectTriggerVariants>["size"];
  readonly className?: string | undefined;
  readonly disabled?: boolean | undefined;
  /** Names the field; the trigger reads as "<label>, <chosen day>". */
  readonly "aria-label"?: string | undefined;
  readonly "data-testid"?: string | undefined;
}

/**
 * A date field for forms: a solid dropdown-style trigger showing the chosen
 * day, opening a month calendar (WAI-ARIA date picker grid). Arrow keys move
 * by day and week, PageUp/PageDown by month (with Shift, by year), Home/End to
 * the week's edges; Enter or Space picks the focused day and closes, Escape
 * closes without a change. Days before `min` can't be picked or reached by
 * keyboard.
 */
export function DatePicker({
  value,
  onChange,
  min,
  today,
  size,
  className,
  disabled,
  "aria-label": ariaLabel,
  "data-testid": testId,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const activeDayRef = useRef<HTMLButtonElement>(null);
  const selected = isCalendarDay(value) ? value : null;
  const text = selected ? triggerDayFormat.format(dayToDate(selected)) : "Choose a date";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        data-testid={testId}
        aria-label={ariaLabel ? `${ariaLabel}, ${text}` : undefined}
        className={cn(selectTriggerVariants({ size }), className)}
      >
        <span className={cn("flex-1 truncate", !selected && "text-muted-foreground")}>{text}</span>
        <CalendarIcon aria-hidden="true" className={selectTriggerIconClassName} />
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        viewportClassName="p-2"
        initialFocus={activeDayRef}
        aria-label={ariaLabel ?? "Choose a date"}
      >
        <MonthCalendar
          selected={selected}
          min={isCalendarDay(min) ? min : null}
          today={isCalendarDay(today) ? today : null}
          activeDayRef={activeDayRef}
          onSelect={(day) => {
            setOpen(false);
            if (day !== value) onChange(day);
          }}
        />
      </PopoverPopup>
    </Popover>
  );
}

/**
 * The popover body. It mounts on each open, so the focused day starts on the
 * chosen day (or today) every time, and "today" is read fresh.
 */
function MonthCalendar({
  selected,
  min,
  today: todayProp,
  activeDayRef,
  onSelect,
}: {
  readonly selected: string | null;
  readonly min: string | null;
  readonly today: string | null;
  readonly activeDayRef: RefObject<HTMLButtonElement | null>;
  readonly onSelect: (day: string) => void;
}) {
  const clampToMin = (day: string) => (min !== null && day < min ? min : day);
  const [localDay] = useState(localToday);
  const today = todayProp ?? localDay;
  // Focus decides the visible month: arrowing past the month's edge turns the page.
  const [focusedDay, setFocusedDay] = useState(() => clampToMin(selected ?? today));
  const titleId = useId();

  // The month buttons turn the page but leave focus on themselves (focusDay false).
  const moveTo = (day: string, focusDay: boolean) => {
    const next = clampToMin(day);
    if (next === focusedDay) return;
    if (!focusDay) {
      setFocusedDay(next);
      return;
    }
    // Render the new day now so focus can land on its button, which may only
    // exist once the page has turned.
    flushSync(() => setFocusedDay(next));
    activeDayRef.current?.focus();
  };

  const weekStart = firstDayOfWeek();
  const visibleMonth = focusedDay.slice(0, 7);
  const monthStart = `${visibleMonth}-01`;
  const gridStart = startOfWeek(monthStart, weekStart);
  const weeks = Array.from({ length: 6 }, (_, week) =>
    Array.from({ length: 7 }, (_, weekday) => addDays(gridStart, week * 7 + weekday)),
  );
  const weekdays = Array.from({ length: 7 }, (_, weekday) => {
    const date = dayToDate(addDays(gridStart, weekday));
    return { short: shortWeekdayFormat.format(date), long: longWeekdayFormat.format(date) };
  });
  const previousMonth = addMonths(focusedDay, -1);
  const previousMonthDisabled = min !== null && lastDayOfMonth(previousMonth) < min;

  const onGridKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    let next: string;
    switch (event.key) {
      case "ArrowLeft":
        next = addDays(focusedDay, -1);
        break;
      case "ArrowRight":
        next = addDays(focusedDay, 1);
        break;
      case "ArrowUp":
        next = addDays(focusedDay, -7);
        break;
      case "ArrowDown":
        next = addDays(focusedDay, 7);
        break;
      case "PageUp":
        next = addMonths(focusedDay, event.shiftKey ? -12 : -1);
        break;
      case "PageDown":
        next = addMonths(focusedDay, event.shiftKey ? 12 : 1);
        break;
      case "Home":
        next = startOfWeek(focusedDay, weekStart);
        break;
      case "End":
        next = addDays(startOfWeek(focusedDay, weekStart), 6);
        break;
      default:
        return;
    }
    event.preventDefault();
    moveTo(next, true);
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 ps-2">
        <div id={titleId} aria-live="polite" className="font-semibold text-[13px]">
          {monthTitleFormat.format(dayToDate(monthStart))}
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Previous month"
            disabled={previousMonthDisabled}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => moveTo(previousMonth, false)}
          >
            <ChevronLeftIcon aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Next month"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => moveTo(addMonths(focusedDay, 1), false)}
          >
            <ChevronRightIcon aria-hidden="true" />
          </Button>
        </div>
      </div>
      <table
        role="grid"
        aria-labelledby={titleId}
        className="border-collapse"
        onKeyDown={onGridKeyDown}
      >
        <thead>
          <tr>
            {weekdays.map((weekday) => (
              <th
                key={weekday.long}
                scope="col"
                abbr={weekday.long}
                className="h-7 w-8 p-0 text-center font-normal text-[11px] text-muted-foreground"
              >
                {weekday.short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((day) => {
                const isSelected = day === selected;
                const isToday = day === today;
                const isDisabled = min !== null && day < min;
                const isFocused = day === focusedDay;
                return (
                  <td key={day} role="gridcell" aria-selected={isSelected} className="p-0">
                    <button
                      type="button"
                      ref={isFocused ? activeDayRef : undefined}
                      tabIndex={isFocused ? 0 : -1}
                      aria-label={fullDayFormat.format(dayToDate(day))}
                      aria-current={isToday ? "date" : undefined}
                      aria-disabled={isDisabled || undefined}
                      onClick={() => {
                        if (!isDisabled) onSelect(day);
                      }}
                      className={cn(
                        "flex size-8 cursor-pointer items-center justify-center rounded-md text-[13px] tabular-nums outline-none focus-ring",
                        isSelected
                          ? "bg-primary font-medium text-primary-foreground hover:bg-primary-hover"
                          : isDisabled
                            ? "cursor-default text-muted-foreground"
                            : cn(
                                "hover:bg-accent",
                                isToday
                                  ? "text-primary-readable"
                                  : day.startsWith(visibleMonth)
                                    ? "text-foreground"
                                    : "text-muted-foreground",
                              ),
                        isToday && "font-semibold",
                        isDisabled && "opacity-64",
                      )}
                    >
                      {Number(day.slice(8))}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
