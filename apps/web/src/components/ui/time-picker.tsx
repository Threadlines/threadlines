"use client";

import type { VariantProps } from "class-variance-authority";
import { ClockIcon } from "lucide-react";
import { type KeyboardEvent, type RefObject, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover";
import { selectTriggerIconClassName, selectTriggerVariants } from "./select";

/** A time of day on the 24-hour clock. */
export interface TimeOfDay {
  readonly hour: number;
  readonly minute: number;
}

export interface TimePickerProps {
  readonly value: TimeOfDay;
  readonly onChange: (value: TimeOfDay) => void;
  /** 12-hour (with an AM/PM column) or 24-hour. Callers pass what the user's time format says. */
  readonly hour12: boolean;
  /** Minute choices step; default 1 (all 60 minutes). */
  readonly minuteStep?: number | undefined;
  readonly size?: VariantProps<typeof selectTriggerVariants>["size"];
  readonly className?: string | undefined;
  readonly disabled?: boolean | undefined;
  /** Names the field; the trigger reads as "<label>, <chosen time>". */
  readonly "aria-label"?: string | undefined;
  readonly "data-testid"?: string | undefined;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function clampInteger(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min;
}

/** "9:05 AM" on the 12-hour clock, "09:05" on the 24-hour clock. */
function formatTime({ hour, minute }: TimeOfDay, hour12: boolean): string {
  if (!hour12) return `${pad2(hour)}:${pad2(minute)}`;
  return `${hour % 12 === 0 ? 12 : hour % 12}:${pad2(minute)} ${hour < 12 ? "AM" : "PM"}`;
}

interface TimeColumn {
  /** The listbox's accessible name. */
  readonly name: string;
  readonly labels: readonly string[];
  /** The option matching the value, or -1 when the minute falls between steps. */
  readonly selectedIndex: number;
  /** The option that takes focus: the chosen one, else the step just before the value. */
  readonly focusIndex: number;
  readonly valueAt: (index: number) => TimeOfDay;
}

function timeColumns(value: TimeOfDay, hour12: boolean, minuteStep: number): TimeColumn[] {
  const { hour, minute } = value;
  const minutes = Array.from({ length: Math.ceil(60 / minuteStep) }, (_, index) => {
    return index * minuteStep;
  });
  const minuteIndex = minutes.indexOf(minute);
  const minuteColumn: TimeColumn = {
    name: "Minute",
    labels: minutes.map(pad2),
    selectedIndex: minuteIndex,
    focusIndex: minuteIndex >= 0 ? minuteIndex : Math.floor(minute / minuteStep),
    valueAt: (index) => ({ hour, minute: minutes[index] ?? minute }),
  };

  if (!hour12) {
    return [
      {
        name: "Hour",
        labels: Array.from({ length: 24 }, (_, index) => pad2(index)),
        selectedIndex: hour,
        focusIndex: hour,
        valueAt: (index) => ({ hour: index, minute }),
      },
      minuteColumn,
    ];
  }

  const isPm = hour >= 12;
  // Hours read 1 to 12; option i is hour i + 1, and 12 is 0 on the 24-hour clock.
  const hourIndex = (hour % 12 === 0 ? 12 : hour % 12) - 1;
  const periodIndex = isPm ? 1 : 0;
  return [
    {
      name: "Hour",
      labels: Array.from({ length: 12 }, (_, index) => String(index + 1)),
      selectedIndex: hourIndex,
      focusIndex: hourIndex,
      valueAt: (index) => ({ hour: ((index + 1) % 12) + (isPm ? 12 : 0), minute }),
    },
    minuteColumn,
    {
      name: "AM or PM",
      labels: ["AM", "PM"],
      selectedIndex: periodIndex,
      focusIndex: periodIndex,
      // Switching AM and PM keeps the hour on the clock face.
      valueAt: (index) => ({ hour: (hour % 12) + (index === 1 ? 12 : 0), minute }),
    },
  ];
}

/** Scrolls `option` into view inside its column without moving the page. */
function revealOption(list: HTMLElement, option: HTMLElement, align: "center" | "nearest") {
  const top = option.offsetTop;
  const bottom = top + option.offsetHeight;
  if (align === "center") {
    list.scrollTop = top - (list.clientHeight - option.offsetHeight) / 2;
  } else if (top < list.scrollTop) {
    list.scrollTop = top;
  } else if (bottom > list.scrollTop + list.clientHeight) {
    list.scrollTop = bottom - list.clientHeight;
  }
}

/**
 * A time field for forms, modeled on Chromium's time input: a solid
 * dropdown-style trigger opening columns for hour, minute and (12-hour)
 * AM/PM. Every pick applies at once and the popover stays open. Up/Down move
 * within a column and change the value (wrapping), Left/Right move between
 * columns, Home/End jump to a column's ends, Enter or Escape closes.
 */
export function TimePicker({
  value,
  onChange,
  hour12,
  minuteStep = 1,
  size,
  className,
  disabled,
  "aria-label": ariaLabel,
  "data-testid": testId,
}: TimePickerProps) {
  const [open, setOpen] = useState(false);
  const hourOptionRef = useRef<HTMLDivElement>(null);
  const time = { hour: clampInteger(value.hour, 0, 23), minute: clampInteger(value.minute, 0, 59) };
  const text = formatTime(time, hour12);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        data-testid={testId}
        aria-label={ariaLabel ? `${ariaLabel}, ${text}` : undefined}
        className={cn(selectTriggerVariants({ size }), className)}
      >
        <span className="flex-1 truncate tabular-nums">{text}</span>
        <ClockIcon aria-hidden="true" className={selectTriggerIconClassName} />
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        viewportClassName="p-2"
        initialFocus={hourOptionRef}
        aria-label={ariaLabel ?? "Choose a time"}
      >
        <TimeColumns
          value={time}
          hour12={hour12}
          minuteStep={clampInteger(minuteStep, 1, 60)}
          hourOptionRef={hourOptionRef}
          onChange={onChange}
          onDone={() => setOpen(false)}
        />
      </PopoverPopup>
    </Popover>
  );
}

function TimeColumns({
  value,
  hour12,
  minuteStep,
  hourOptionRef,
  onChange,
  onDone,
}: {
  readonly value: TimeOfDay;
  readonly hour12: boolean;
  readonly minuteStep: number;
  readonly hourOptionRef: RefObject<HTMLDivElement | null>;
  readonly onChange: (value: TimeOfDay) => void;
  readonly onDone: () => void;
}) {
  const columns = timeColumns(value, hour12, minuteStep);
  const listRefs = useRef<(HTMLDivElement | null)[]>([]);
  // Where each column stood when the popover opened; this panel mounts per open.
  const [openingOptions] = useState(() => columns.map((column) => column.focusIndex));

  // Open with each column's choice centered, jumping there rather than
  // animating the scroll.
  useLayoutEffect(() => {
    for (const [columnIndex, optionIndex] of openingOptions.entries()) {
      const list = listRefs.current[columnIndex];
      const option = list?.children[optionIndex];
      if (list && option instanceof HTMLElement) revealOption(list, option, "center");
    }
  }, [openingOptions]);

  const focusOption = (columnIndex: number, optionIndex: number) => {
    const list = listRefs.current[columnIndex];
    const option = list?.children[optionIndex];
    if (!list || !(option instanceof HTMLElement)) return;
    option.focus({ preventScroll: true });
    revealOption(list, option, "nearest");
  };

  const pick = (columnIndex: number, optionIndex: number) => {
    const column = columns[columnIndex];
    if (!column || optionIndex === column.selectedIndex) return;
    onChange(column.valueAt(optionIndex));
  };

  // Escape is left to the popover, which closes and returns focus to the
  // trigger. Picks apply as they happen, so closing keeps them, as Chromium's
  // time picker does: there is no draft to throw away.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const option = event.target instanceof HTMLElement ? event.target : null;
    const columnIndex = Number(option?.dataset.column);
    const optionIndex = Number(option?.dataset.option);
    const column = columns[columnIndex];
    if (!column || !Number.isInteger(optionIndex)) return;
    const count = column.labels.length;

    let nextOption: number;
    switch (event.key) {
      case "ArrowUp":
        nextOption = (optionIndex - 1 + count) % count;
        break;
      case "ArrowDown":
        nextOption = (optionIndex + 1) % count;
        break;
      case "Home":
        nextOption = 0;
        break;
      case "End":
        nextOption = count - 1;
        break;
      case "ArrowLeft":
      case "ArrowRight": {
        event.preventDefault();
        const nextColumn = columns[columnIndex + (event.key === "ArrowLeft" ? -1 : 1)];
        if (nextColumn) {
          focusOption(columnIndex + (event.key === "ArrowLeft" ? -1 : 1), nextColumn.focusIndex);
        }
        return;
      }
      case "Enter":
        event.preventDefault();
        onDone();
        return;
      case " ":
        // The option is already chosen; keep Space from scrolling the column.
        event.preventDefault();
        return;
      default:
        return;
    }
    event.preventDefault();
    focusOption(columnIndex, nextOption);
    pick(columnIndex, nextOption);
  };

  // Keys are handled here, delegated from the focused option. A column's
  // chosen option is accent-filled while the column has focus and grey
  // otherwise, the way macOS draws an unfocused list's selection, so it shows
  // which column the arrow keys will change.
  return (
    <div className="flex gap-1" onKeyDown={onKeyDown}>
      {columns.map((column, columnIndex) => (
        <div
          key={column.name}
          ref={(element) => {
            listRefs.current[columnIndex] = element;
          }}
          role="listbox"
          aria-label={column.name}
          className="group/column relative flex h-48 w-11 shrink-0 flex-col gap-px overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {column.labels.map((label, optionIndex) => {
            const isSelected = optionIndex === column.selectedIndex;
            const isFocusTarget = optionIndex === column.focusIndex;
            return (
              <div
                key={label}
                ref={columnIndex === 0 && isFocusTarget ? hourOptionRef : undefined}
                role="option"
                aria-selected={isSelected}
                tabIndex={isFocusTarget ? 0 : -1}
                data-column={columnIndex}
                data-option={optionIndex}
                onClick={() => pick(columnIndex, optionIndex)}
                className={cn(
                  "flex h-7 shrink-0 cursor-pointer select-none items-center justify-center rounded-md text-[13px] tabular-nums outline-none focus-ring",
                  isSelected
                    ? "bg-control-active font-medium text-foreground group-focus-within/column:bg-primary group-focus-within/column:text-primary-foreground group-focus-within/column:hover:bg-primary-hover"
                    : "text-foreground hover:bg-accent",
                )}
              >
                {label}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
