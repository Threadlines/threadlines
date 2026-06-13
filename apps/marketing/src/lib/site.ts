export const SITE_URL = "https://www.threadlines.dev";

export const SITE_NAME = "Threadlines";

export const DEFAULT_SITE_DESCRIPTION =
  "Threadlines is a source-control-first desktop workspace for coding agents. Every thread leaves a line. In private development.";

export const SITE_SOCIAL_IMAGE = "/icon.png";

export function absoluteSiteUrl(path: string): string {
  return new URL(path, SITE_URL).toString();
}
