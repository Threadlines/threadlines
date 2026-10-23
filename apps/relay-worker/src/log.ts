// @effect-diagnostics globalDate:off globalConsole:off

/**
 * The path as the relay may log it. An event task's address ends in a mac
 * that is the only credential of a task without a signature check, so
 * anything from `/v2/hooks` on is cut. Every logger that records a path goes
 * through this; invocation logs (which record whole URLs) are off in
 * wrangler.jsonc for the same reason.
 */
export function loggedPath(pathname: string): string {
  const index = pathname.toLowerCase().indexOf("/v2/hooks");
  return index === -1 ? pathname : `${pathname.slice(0, index)}/v2/hooks/…`;
}

/** One JSON line per entry, the shape Workers Logs indexes. */
export function log(
  level: "info" | "warn" | "error",
  message: string,
  data?: Record<string, unknown>,
): void {
  const entry = JSON.stringify({ level, message, timestamp: new Date().toISOString(), ...data });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}
