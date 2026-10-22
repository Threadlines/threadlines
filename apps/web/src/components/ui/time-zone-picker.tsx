"use client";

import type { VariantProps } from "class-variance-authority";
import { useMemo, useState } from "react";

import {
  allTimeZones,
  formatTimeZoneLabel,
  formatTimeZoneShort,
  searchTimeZones,
  timeZoneLabel,
} from "~/lib/timeZones";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./combobox";
import { SelectButton, type selectTriggerVariants } from "./select";

/** A zone a picker leads with, and why ("This computer", "You"). */
export interface TimeZoneSuggestion {
  readonly timeZone: string;
  readonly note?: string | undefined;
}

/** Results shown at once while searching; more narrow down as the user types. */
const SEARCH_RESULT_LIMIT = 80;

/**
 * A time zone picker: a solid trigger with the zone's city and offset, and a
 * popover that leads with a few zones (the chosen one and `suggestions`) and
 * searches every zone as the user types, by city, zone name, offset or id.
 * Each zone reads "New York · Eastern Time (UTC−4)" over its IANA id, which
 * is the value.
 */
export function TimeZonePicker({
  value,
  onChange,
  suggestions,
  size = "sm",
  className,
  "aria-label": ariaLabel,
  "data-testid": testId,
}: {
  readonly value: string;
  readonly onChange: (timeZone: string) => void;
  readonly suggestions: ReadonlyArray<TimeZoneSuggestion>;
  readonly size?: VariantProps<typeof selectTriggerVariants>["size"];
  readonly className?: string;
  readonly "aria-label"?: string;
  readonly "data-testid"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Labels are read for the moment the picker opens: offsets follow the season.
  const [now, setNow] = useState(() => new Date());
  const zones = useMemo(() => allTimeZones(), []);
  const notes = useMemo(() => {
    const byZone = new Map<string, string | undefined>([[value, undefined]]);
    for (const suggestion of suggestions) {
      if (!byZone.has(suggestion.timeZone) || byZone.get(suggestion.timeZone) === undefined) {
        byZone.set(suggestion.timeZone, suggestion.note);
      }
    }
    return byZone;
  }, [suggestions, value]);
  const searching = query.trim().length > 0;
  const shown = useMemo(
    () =>
      searching
        ? searchTimeZones(query, zones, now).slice(0, SEARCH_RESULT_LIMIT)
        : [...notes.keys()],
    [notes, now, query, searching, zones],
  );

  return (
    <Combobox
      items={zones}
      filteredItems={shown}
      value={value}
      autoHighlight
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setNow(new Date());
        else setQuery("");
      }}
      onValueChange={(next) => {
        if (typeof next === "string" && next.length > 0) onChange(next);
      }}
    >
      <ComboboxTrigger
        render={
          <SelectButton
            size={size}
            className={className}
            aria-label={ariaLabel}
            data-testid={testId}
          />
        }
      >
        {formatTimeZoneShort(timeZoneLabel(value, now))}
      </ComboboxTrigger>
      <ComboboxPopup align="end" className="w-80">
        <div className="border-b p-1">
          <ComboboxInput
            className="rounded-md [&_input]:font-sans"
            inputClassName="ring-0"
            placeholder="Search time zones"
            aria-label="Search time zones"
            showTrigger={false}
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ComboboxEmpty>No time zone matches.</ComboboxEmpty>
        <ComboboxList className="max-h-72">
          {shown.map((zone, index) => {
            const label = timeZoneLabel(zone, now);
            const note = searching ? undefined : notes.get(zone);
            return (
              <ComboboxItem key={zone} index={index} value={zone}>
                <span className="flex min-w-0 flex-col py-0.5">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate">{formatTimeZoneLabel(label)}</span>
                    {note ? (
                      <span className="shrink-0 text-xs text-muted-foreground">{note}</span>
                    ) : null}
                  </span>
                  <span className="truncate font-mono text-[10.5px] leading-4 text-muted-foreground">
                    {zone}
                  </span>
                </span>
              </ComboboxItem>
            );
          })}
        </ComboboxList>
        {searching ? null : (
          <p className="border-t px-3 py-2 text-xs text-muted-foreground">
            Type a city, zone or offset to search every time zone.
          </p>
        )}
      </ComboboxPopup>
    </Combobox>
  );
}
