/**
 * Themes as pages (docs/design/custom-themes.md, "Agent tools"): what
 * `preview_theme` tells an agent, and how a theme row is stored. A theme an
 * agent shows is a page of kind `theme` whose version file is the theme's
 * JSON, published through the same path as every page.
 */
import { THEME_MAX_FPS, type ThemeManifest } from "@threadlines/contracts";

import type { ThemePreviewReport } from "../themes/ThemeWorkshop.ts";

/** The chat row a theme shows as, in CSS px: no measuring, every theme the same. */
export const THEME_PAGE_HEIGHT = 72;

/** A theme's version file: the theme, as it was offered. */
export const themePageContent = (manifest: ThemeManifest) => JSON.stringify(manifest);

const round = (value: number, digits: number) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

/** What `preview_theme` says beside its screenshots. */
export function themePreviewText(input: {
  readonly manifest: ThemeManifest;
  readonly problems: ReadonlyArray<string>;
  readonly fontProblem: string | null;
  readonly report: ThemePreviewReport;
}): string {
  const { manifest, problems, report } = input;
  const lines: Array<string> = [];
  lines.push(
    problems.length === 0
      ? "Checks: every readability check passes."
      : `Checks: ${problems.length === 1 ? "1 problem" : `${problems.length} problems`}; show_theme refuses the theme until they are fixed. A contrast problem names the derived token: change the seed color that sets it (colors.foreground, colors.mutedForeground, colors.accent, colors.accentForeground, a status seed, colors.border, colors.background) or give an override.\n- ${problems.join("\n- ")}`,
  );
  if (input.fontProblem !== null) {
    lines.push(`Fonts: ${input.fontProblem} The screenshots use a system font instead.`);
  }
  const backdrop = manifest.backdrop;
  if (backdrop === undefined) {
    lines.push("Art: none (no backdrop).");
  } else if (report.failure !== null) {
    lines.push(
      `Art: it failed (${report.failure.reason}${report.failure.detail ? `: ${report.failure.detail}` : ""}). Users would see its still, or the plain background, instead.`,
    );
  } else if (report.stats === null) {
    lines.push(
      `Art: ${backdrop.mode} mode, up to ${backdrop.maxFps} fps. It reported no measurements in time, so its cost is unknown.`,
    );
  } else {
    const { stats } = report;
    lines.push(
      `Art: ${backdrop.mode} mode, up to ${Math.min(backdrop.maxFps, THEME_MAX_FPS)} fps. Measured ${round(stats.fps, 1)} fps and ${round(stats.msPerSecond, 1)} ms of work a second: ${stats.energy}.${stats.throttled ? " The runtime slowed it down to keep it in budget; make each frame cheaper." : ""}${stats.energy === "light" ? "" : " Aim for light: heavy art steps itself down and then goes still."}`,
    );
  }
  lines.push(
    report.consoleMessages.length === 0
      ? "Console: nothing."
      : `Console:\n${report.consoleMessages.map((entry) => `[${entry.level}] ${entry.text}`).join("\n")}`,
  );
  lines.push(
    `Screenshots: ${report.shots.map((shot) => (shot.layout === "thread" ? "a thread" : "the new-thread screen")).join(", then ")}, at 1440×900.`,
  );
  return lines.join("\n");
}
