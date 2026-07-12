export const SITE_URL = "https://www.threadlines.dev";

export const SITE_NAME = "Threadlines";

export const DEFAULT_SITE_DESCRIPTION =
  "Threadlines is a free, open-source desktop workspace for Claude Code and Codex: parallel agent threads with real source control, a file editor, and full visibility into every task, subagent, and background run.";

export const SITE_SOCIAL_IMAGE = "/og.png";

export const SITE_TWITTER_HANDLE = "@threadlinesdev";

export function absoluteSiteUrl(path: string): string {
  return new URL(path, SITE_URL).toString();
}
