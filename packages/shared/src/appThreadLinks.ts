/**
 * Links that open a thread in the desktop app: `<scheme>://open/<environmentId>/<threadId>`.
 *
 * The hosted app offers one on its "This browser isn't paired" screen, so a
 * thread link opened in a browser on the computer that runs Threadlines can
 * go straight to the app. Each release channel answers its own scheme, so a
 * nightly link never opens the stable app, nor the other way round.
 *
 * Whoever hands the app a link (any page, any program) chooses what is in it,
 * so a link only ever names a thread: two ids of plain characters, nothing
 * else. Anything that does not match exactly is not a link.
 */

export type AppLinkChannel = "latest" | "nightly" | "dev";

export const APP_THREAD_LINK_SCHEMES = {
  latest: "threadlines",
  nightly: "threadlines-nightly",
  dev: "threadlines-dev",
} as const satisfies Record<AppLinkChannel, string>;

export interface AppThreadLinkTarget {
  readonly environmentId: string;
  readonly threadId: string;
}

const LINK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Whether `value` can stand as an environment or thread id in a link. */
export function isAppThreadLinkId(value: string): boolean {
  return LINK_ID_PATTERN.test(value);
}

/** The link that opens this thread in the channel's desktop app, or null for ids a link can't carry. */
export function appThreadLink(channel: AppLinkChannel, target: AppThreadLinkTarget): string | null {
  if (!isAppThreadLinkId(target.environmentId) || !isAppThreadLinkId(target.threadId)) {
    return null;
  }
  return `${APP_THREAD_LINK_SCHEMES[channel]}://open/${target.environmentId}/${target.threadId}`;
}

/**
 * The thread a link for this channel names, or null when `raw` is anything
 * else: another channel's link, another scheme, extra path parts, a query, or
 * ids with characters a link never carries.
 */
export function parseAppThreadLink(
  raw: string,
  channel: AppLinkChannel,
): AppThreadLinkTarget | null {
  const prefix = `${APP_THREAD_LINK_SCHEMES[channel]}://open/`;
  // Schemes and hosts compare without case; the ids keep theirs.
  if (raw.slice(0, prefix.length).toLowerCase() !== prefix) {
    return null;
  }
  // Windows and some browsers add a trailing slash to a link they hand over.
  const path = raw.slice(prefix.length).replace(/\/$/, "");
  const [environmentId, threadId, ...rest] = path.split("/");
  if (
    environmentId === undefined ||
    threadId === undefined ||
    rest.length > 0 ||
    !isAppThreadLinkId(environmentId) ||
    !isAppThreadLinkId(threadId)
  ) {
    return null;
  }
  return { environmentId, threadId };
}
