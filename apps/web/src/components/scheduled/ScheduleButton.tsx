import {
  BracesIcon,
  CalendarClockIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  GlobeIcon,
  type LucideIcon,
  ZapIcon,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { DatePicker } from "../ui/date-picker";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SegmentedControl, SegmentedControlItem } from "../ui/segmented-control";
import {
  DropdownChevron,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { TimePicker } from "../ui/time-picker";
import { type TimeZoneSuggestion, TimeZonePicker } from "../ui/time-zone-picker";
import {
  CADENCE_KIND_LABELS,
  type CadenceKind,
  customCadencePatch,
  formatWhen,
  previewRuns,
  REPEAT_KINDS,
  type ScheduledTaskForm,
  scheduleSummary,
  todayIn,
  WEEKDAY_LABELS,
} from "./scheduled.logic";

const HOURLY_MINUTES = Array.from({ length: 12 }, (_, index) => index * 5);

/** Monday first, as calendars here read; values are the cadence's 0 (Sunday) to 6. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** The words the Repeat field shows for a kind it doesn't list. */
const REPEAT_LABELS: Record<CadenceKind, string> = {
  ...CADENCE_KIND_LABELS,
  custom: "Custom cron rule",
};

/** The catch-up sentence the old page header carried, now beside the times it's about. */
const CLOCK_NOTE =
  "It runs while Threadlines is running on its computer. A time missed while the computer was off or asleep gets one catch-up run.";

const ZONE_HINT =
  "Times use this zone wherever you are. When clocks skip ahead, a skipped time runs right after. When they fall back, a set time runs once and hourly tasks still run every hour.";

const CRON_HINT =
  "Five fields: minute, hour, day of month, month, day of week. Every 15 minutes is */15 * * * *.";

/** A labelled line of the popover: the label in a narrow column, the control filling the rest. */
function PopoverRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.25rem_minmax(0,1fr)] items-center gap-2">
      <span className="text-[12.5px] text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

/** A row one step further in: a choice that opens more, or switches the task to its kind. */
function MoreRow({
  icon: Icon,
  label,
  value,
  selected = false,
  opens = false,
  onClick,
  testId,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly value?: string | undefined;
  readonly selected?: boolean;
  /** It opens a page of its own (a chevron); else it picks (a check while picked). */
  readonly opens?: boolean;
  readonly onClick: () => void;
  readonly testId?: string;
}) {
  return (
    <button
      type="button"
      className="flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] text-foreground transition-colors hover:bg-accent focus-ring"
      aria-pressed={opens ? undefined : selected}
      data-testid={testId}
      onClick={onClick}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value ? (
        <span className="min-w-0 max-w-[45%] truncate text-[12px] text-muted-foreground">
          {value}
        </span>
      ) : null}
      {opens ? (
        <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      ) : selected ? (
        <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary-readable" />
      ) : null}
    </button>
  );
}

/**
 * The schedule button at the top of the task editor: the schedule in a few
 * words, opening a popover with the repeat pattern, its day and time and the
 * next runs. The time zone, a cron rule and event triggers sit one step
 * further in. Picking events closes it: their settings sit under the editor.
 */
export function ScheduleButton({
  form,
  onChange,
  eventsOffered,
  problem,
  computerTimeZone,
  timeZoneSuggestions,
  hour12,
  nowMs,
}: {
  readonly form: ScheduledTaskForm;
  readonly onChange: (patch: Partial<ScheduledTaskForm>) => void;
  /** The computer runs event tasks, or the task already is one. */
  readonly eventsOffered: boolean;
  /** Why the schedule can't be saved, once a save was tried. */
  readonly problem: string | undefined;
  readonly computerTimeZone: string | undefined;
  readonly timeZoneSuggestions: ReadonlyArray<TimeZoneSuggestion>;
  readonly hour12: boolean;
  readonly nowMs: number;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<"main" | "timeZone">("main");
  const cronRef = useRef<HTMLInputElement>(null);
  const kind = form.cadenceKind;
  const isEvent = kind === "webhook";
  const clock = !isEvent && kind !== "manual";
  const upcoming = clock ? previewRuns(form, new Date(nowMs), 3) : [];
  const timed = kind === "daily" || kind === "weekdays" || kind === "weekly" || kind === "once";
  const zoneLabel =
    computerTimeZone !== undefined && form.timeZone === computerTimeZone
      ? "This computer"
      : form.timeZone;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setPage("main");
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-invalid={problem !== undefined ? true : undefined}
            data-testid="scheduled-schedule-button"
            className={cn(
              "max-w-full min-w-0 shrink gap-1.5 px-2 font-medium text-foreground/90 hover:text-foreground data-popup-open:bg-accent",
              problem !== undefined &&
                "text-destructive-foreground hover:text-destructive-foreground",
            )}
          />
        }
      >
        <CalendarClockIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{scheduleSummary(form)}</span>
        <DropdownChevron solid={false} />
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        className="w-[min(20rem,calc(100vw-1.5rem))]"
        viewportClassName="py-2.5 [--viewport-inline-padding:--spacing(2.5)]"
        data-testid="scheduled-schedule-popover"
      >
        {page === "timeZone" ? (
          <div className="flex flex-col gap-2.5">
            <button
              type="button"
              className="flex w-fit cursor-pointer items-center gap-1 rounded-md pe-1.5 text-[13px] font-medium text-foreground focus-ring"
              data-testid="scheduled-schedule-back"
              onClick={() => setPage("main")}
            >
              <ChevronLeftIcon aria-hidden="true" className="size-4 text-muted-foreground" />
              Time zone
            </button>
            <TimeZonePicker
              value={form.timeZone}
              onChange={(timeZone) => onChange({ timeZone, timeZoneChosen: true })}
              suggestions={timeZoneSuggestions}
              className="w-full"
              aria-label="Time zone"
              data-testid="scheduled-form-time-zone"
            />
            <p className="text-[12px] leading-4 text-muted-foreground">{ZONE_HINT}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <PopoverRow label="Repeat">
              <Select
                value={kind}
                onValueChange={(value) => {
                  if (value) onChange({ cadenceKind: value as CadenceKind });
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full min-w-0"
                  aria-label="Repeat"
                  data-testid="scheduled-form-runs"
                >
                  <SelectValue>{REPEAT_LABELS[kind]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  {REPEAT_KINDS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {CADENCE_KIND_LABELS[option]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </PopoverRow>

            {kind === "weekly" ? (
              <SegmentedControl
                className="w-full"
                value={String(form.weekday)}
                onValueChange={(value) => onChange({ weekday: Number(value) })}
                aria-label="Day"
              >
                {WEEK_ORDER.map((day) => (
                  <SegmentedControlItem
                    key={day}
                    value={String(day)}
                    className="flex-1 px-0"
                    aria-label={WEEKDAY_LABELS[day]}
                    data-testid={`scheduled-form-day-${day}`}
                  >
                    {WEEKDAY_LABELS[day].slice(0, 3)}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
            ) : null}

            {kind === "once" ? (
              <PopoverRow label="Date">
                <DatePicker
                  size="sm"
                  className="w-full min-w-0"
                  aria-label="Date"
                  value={form.date}
                  // Days are the task's own: today and earlier are as its zone sees them.
                  today={todayIn(form.timeZone)}
                  min={todayIn(form.timeZone)}
                  onChange={(date) => onChange({ date })}
                  data-testid="scheduled-form-date"
                />
              </PopoverRow>
            ) : null}

            {kind === "hourly" ? (
              <PopoverRow label="Minute">
                <Select
                  value={String(form.minute)}
                  onValueChange={(value) => {
                    if (value !== null) onChange({ minute: Number(value) });
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full min-w-0"
                    aria-label="Minute past the hour"
                  >
                    <SelectValue>{`at :${String(form.minute).padStart(2, "0")}`}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {[...new Set([...HOURLY_MINUTES, form.minute])]
                      .toSorted((a, b) => a - b)
                      .map((minute) => (
                        <SelectItem key={minute} value={String(minute)}>
                          {`at :${String(minute).padStart(2, "0")}`}
                        </SelectItem>
                      ))}
                  </SelectPopup>
                </Select>
              </PopoverRow>
            ) : null}

            {timed ? (
              <PopoverRow label="Time">
                <TimePicker
                  size="sm"
                  className="w-full min-w-0"
                  aria-label="Time"
                  value={form.time}
                  hour12={hour12}
                  onChange={(time) => onChange({ time })}
                  data-testid="scheduled-form-time"
                />
              </PopoverRow>
            ) : null}

            {kind === "custom" ? (
              <div className="flex flex-col gap-1.5">
                <Input
                  ref={cronRef}
                  size="sm"
                  className="font-mono"
                  value={form.cron}
                  placeholder="0 9 * * 1-5"
                  aria-label="Cron expression"
                  data-testid="scheduled-form-cron"
                  onChange={(event) => onChange({ cron: event.target.value, cronChosen: true })}
                />
                <p className="text-[12px] leading-4 text-muted-foreground">{CRON_HINT}</p>
              </div>
            ) : null}

            {kind === "manual" ? (
              <p className="text-[12.5px] leading-[18px] text-muted-foreground">
                It runs only when you press Run now.
              </p>
            ) : null}
            {isEvent ? (
              <p className="text-[12.5px] leading-[18px] text-muted-foreground">
                It runs when an event arrives. Set up which events under the editor.
              </p>
            ) : null}

            {upcoming.length > 0 ? (
              <p
                className="font-mono text-[11px] leading-4 text-muted-foreground"
                data-testid="scheduled-form-preview"
              >
                {kind === "once" ? "Your time: " : "Next, your time: "}
                {upcoming.map((slot) => formatWhen(slot.toISOString(), nowMs)).join(", ")}
              </p>
            ) : null}
            {problem !== undefined && !isEvent ? (
              <p className="text-[12px] text-destructive-foreground">{problem}</p>
            ) : null}
            {isEvent ? null : (
              <p className="text-[12px] leading-4 text-muted-foreground">{CLOCK_NOTE}</p>
            )}

            <div className="-mx-(--viewport-inline-padding) h-px bg-border" />
            <div className="-mx-1 flex flex-col">
              {clock ? (
                <MoreRow
                  icon={GlobeIcon}
                  label="Time zone"
                  value={zoneLabel}
                  opens
                  testId="scheduled-schedule-time-zone"
                  onClick={() => setPage("timeZone")}
                />
              ) : null}
              <MoreRow
                icon={BracesIcon}
                label="Custom cron rule"
                selected={kind === "custom"}
                testId="scheduled-schedule-cron"
                onClick={() => {
                  if (kind !== "custom") onChange(customCadencePatch(form));
                  requestAnimationFrame(() => cronRef.current?.focus());
                }}
              />
              {eventsOffered ? (
                <MoreRow
                  icon={ZapIcon}
                  label={CADENCE_KIND_LABELS.webhook}
                  selected={isEvent}
                  testId="scheduled-schedule-events"
                  onClick={() => {
                    onChange({ cadenceKind: "webhook" });
                    setOpen(false);
                  }}
                />
              ) : null}
            </div>
          </div>
        )}
      </PopoverPopup>
    </Popover>
  );
}
