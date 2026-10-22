/**
 * Time zones as people read them: "New York · Eastern Time (UTC−4)" for the
 * IANA id "America/New_York", which stays the value saved. Pickers lead with
 * a few zones and search the rest by city, zone name, offset or id.
 */

/** A time zone's friendly parts, worked out for one moment (offsets change with the seasons). */
export interface TimeZoneLabel {
  /** The IANA id, the value a picker saves: "America/New_York". */
  readonly id: string;
  /** "New York" (the id's last part), or "UTC". */
  readonly city: string;
  /** "Eastern Time"; null when the runtime has no name for it, or it only repeats the offset. */
  readonly name: string | null;
  /** "UTC−4", "UTC+5:30", or "UTC" at no offset. */
  readonly offset: string;
}

const MINUS = "−";

/**
 * Cities a runtime still lists under an old name (Chromium's ICU keeps
 * "Asia/Calcutta"), shown and found by the name people use now. The old
 * name stays searchable through the id.
 */
const CURRENT_CITY_NAMES: Readonly<Record<string, string>> = {
  "Asia/Calcutta": "Kolkata",
  "Asia/Katmandu": "Kathmandu",
  "Asia/Rangoon": "Yangon",
  "Asia/Saigon": "Ho Chi Minh City",
  "Atlantic/Faeroe": "Faroe",
  "America/Godthab": "Nuuk",
  "Europe/Kiev": "Kyiv",
  "Pacific/Enderbury": "Kanton",
  "Pacific/Ponape": "Pohnpei",
  "Pacific/Truk": "Chuuk",
};

/** Every zone this runtime knows, UTC included. */
export function allTimeZones(): readonly string[] {
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  return zones.includes("UTC") ? zones : ["UTC", ...zones];
}

/** The zone this browser runs in. */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function zoneNamePart(id: string, at: Date, style: "longGeneric" | "shortOffset"): string | null {
  try {
    return (
      new Intl.DateTimeFormat("en-US", { timeZone: id, timeZoneName: style })
        .formatToParts(at)
        .find((part) => part.type === "timeZoneName")?.value ?? null
    );
  } catch {
    return null;
  }
}

/** "GMT-4" as "UTC−4" (a real minus sign); "GMT" as "UTC". */
function offsetLabel(gmt: string | null): string {
  if (gmt === null || gmt === "GMT" || gmt === "UTC") return "UTC";
  return gmt.replace(/^GMT/u, "UTC").replace("-", MINUS);
}

const labels = new Map<string, TimeZoneLabel>();

/**
 * The zone's friendly parts at `at`, cached per hour (an offset only changes
 * on the hour or half hour, and a picker asks for every zone at once).
 */
export function timeZoneLabel(id: string, at: Date = new Date()): TimeZoneLabel {
  const hour = Math.floor(at.getTime() / 3_600_000);
  const key = `${id}@${hour}`;
  const cached = labels.get(key);
  if (cached !== undefined) return cached;
  const offset = offsetLabel(zoneNamePart(id, at, "shortOffset"));
  const generic = zoneNamePart(id, at, "longGeneric");
  const label: TimeZoneLabel =
    id === "UTC" || id === "Etc/UTC"
      ? { id, city: "UTC", name: "Coordinated Universal Time", offset: "UTC" }
      : {
          id,
          city: CURRENT_CITY_NAMES[id] ?? (id.split("/").at(-1) ?? id).replaceAll("_", " "),
          // A runtime without a name for the zone falls back to "GMT-4": the offset says that.
          name: generic === null || /^GMT|^UTC/u.test(generic) ? null : generic,
          offset,
        };
  if (labels.size > 2_000) labels.clear();
  labels.set(key, label);
  return label;
}

/** "New York · Eastern Time (UTC−4)". */
export function formatTimeZoneLabel(label: TimeZoneLabel): string {
  if (label.city === "UTC") return "UTC";
  return label.name === null
    ? `${label.city} (${label.offset})`
    : `${label.city} · ${label.name} (${label.offset})`;
}

/** "New York (UTC−4)": short enough for a trigger. */
export function formatTimeZoneShort(label: TimeZoneLabel): string {
  return label.city === "UTC" ? "UTC" : `${label.city} (${label.offset})`;
}

/**
 * The zones matching `query`, in the runtime's order: every word must
 * appear in the city, the zone's name, its offset ("utc-4" finds UTC−4) or
 * its id.
 */
export function searchTimeZones(
  query: string,
  zones: readonly string[],
  at: Date = new Date(),
): readonly string[] {
  const words = query
    .toLowerCase()
    .replaceAll(MINUS, "-")
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  if (words.length === 0) return [];
  return zones.filter((id) => {
    const label = timeZoneLabel(id, at);
    const haystack = `${label.city} ${label.name ?? ""} ${label.offset} ${id}`
      .toLowerCase()
      .replaceAll(MINUS, "-")
      .replaceAll("_", " ");
    return words.every((word) => haystack.includes(word));
  });
}
