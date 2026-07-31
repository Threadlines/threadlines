export const SITE_URL = "https://www.threadlines.dev";

export const SITE_NAME = "Threadlines";

export const DEFAULT_SITE_DESCRIPTION =
  "Threadlines is a free, open-source desktop workspace for Claude Code and Codex, combining agent threads, a live browser, project files, and real source control in one local workspace.";

export const SITE_SOCIAL_IMAGE = "/og.png";

export const SITE_TWITTER_HANDLE = "@threadlinesdev";

export function absoluteSiteUrl(path: string): string {
  return new URL(path, SITE_URL).toString();
}
