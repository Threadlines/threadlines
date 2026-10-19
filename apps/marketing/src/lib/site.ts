export const SITE_URL = "https://www.threadlines.dev";

export const SITE_NAME = "Threadlines";

export const DEFAULT_SITE_DESCRIPTION =
  "Threadlines is a free, open-source ADE (agentic development environment) for Claude Code, Codex, OpenCode, Cursor, and other coding agents. Run them in one desktop app, with pull requests, a live browser, and Git beside the chat.";

export const SITE_SOCIAL_IMAGE = "/og.png";

export const SITE_TWITTER_HANDLE = "@threadlinesdev";

export const SITE_GITHUB_URL = "https://github.com/Threadlines/threadlines";

export const SITE_X_URL = "https://x.com/threadlinesdev";

export function absoluteSiteUrl(path: string): string {
  return new URL(path, SITE_URL).toString();
}

/** The schema.org id every page's structured data uses to point at the publisher. */
export const ORGANIZATION_ID = absoluteSiteUrl("/#organization");

/** The schema.org id of the app itself, so agent pages can say what they are about. */
export const APPLICATION_ID = absoluteSiteUrl("/#application");
