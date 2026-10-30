import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_PLACES, isPlaceId } from "@threadlines/shared/appPlaces";
import { describe, expect, it } from "vite-plus/test";

/**
 * The drift check for app places (docs/design/app-guide.md, "Testing"): the
 * settings screens take their words from the catalog, so every settings row
 * and section the catalog names must be on screen as a place, and no settings
 * row or section may write its own title instead of naming its place.
 */

const SRC = fileURLToPath(new URL("../../", import.meta.url));

/** Settings rows and sections that write their own title, and why they are not places. */
const UNPLACED: ReadonlyArray<readonly [file: string, title: string, why: string]> = [
  ["components/settings/DiagnosticsSettings.tsx", "*", "Diagnostics readings, not settings"],
  ["components/scheduled/ScheduledTaskForm.tsx", "*", "a scheduled task's form, not settings"],
  ["components/scheduled/ScheduledTaskDetail.tsx", "*", "a scheduled task's details, not settings"],
  ["components/scheduled/EventTaskPanels.tsx", "*", "an event task's panels, not settings"],
  ["components/settings/SourceControlSettings.tsx", "Server environment", "empty scan result"],
  ["components/settings/ConnectionsSettings.tsx", "Phone links changed", "one-time notice"],
  ["components/settings/ConnectionsSettings.tsx", "Connect your phone again", "one-time notice"],
  ["components/settings/ConnectionsSettings.tsx", "Owner only", "status for non-owners"],
  ["components/fleet/FleetComputerView.tsx", "Not connected to this app", "Fleet status row"],
  [
    "components/outsideAgents/AssistantsSection.tsx",
    "This code expired.",
    "a sign-in code's state",
  ],
];

const sourceFiles = (readdirSync(SRC, { recursive: true }) as string[])
  .map((file) => file.replaceAll("\\", "/"))
  .filter((file) => /\.tsx?$/.test(file) && !/\.(test|browser)\.tsx?$/.test(file));

/** An opening tag's attributes outside any `{...}`, so JSX nested in a prop doesn't count. */
function topLevelAttributes(source: string, start: number): string {
  let depth = 0;
  let attributes = "";
  for (let index = start; index < source.length; index++) {
    const char = source[index]!;
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (depth === 0 && char === ">") return attributes;
    else if (depth === 0 && char === '"') {
      const end = source.indexOf('"', index + 1);
      attributes += source.slice(index, end + 1);
      index = end;
    } else if (depth === 0) attributes += char;
  }
  return attributes;
}

describe("settings places", () => {
  const sources = sourceFiles.map((file) => ({
    file,
    source: readFileSync(join(SRC, file), "utf8"),
  }));

  it("puts every catalogued settings row and section on screen", () => {
    const used = new Set<string>();
    for (const { source } of sources) {
      for (const match of source.matchAll(/[\s-]place=(?:"([\w.]+)"|\{"([\w.]+)"\})/g)) {
        used.add(match[1] ?? match[2]!);
      }
    }
    expect([...used].filter((id) => !isPlaceId(id))).toEqual([]);
    const missing = APP_PLACES.filter((place) => place.kind !== "page" && !used.has(place.id));
    expect(missing.map((place) => place.id)).toEqual([]);
  });

  it("names a place instead of writing a title", () => {
    const written: string[] = [];
    for (const { file, source } of sources) {
      for (const match of source.matchAll(/<Settings(?:Row|Section)\b/g)) {
        const title = /(?:^|\s)title="([^"]*)"/.exec(topLevelAttributes(source, match.index))?.[1];
        if (title === undefined) continue;
        const excused = UNPLACED.some(([f, t]) => f === file && (t === "*" || t === title));
        if (!excused) written.push(`${file}: ${title}`);
      }
    }
    expect(written).toEqual([]);
  });
});
