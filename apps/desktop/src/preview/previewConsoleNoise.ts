/**
 * Console output the host injected into the guest, rather than the page's own.
 *
 * Electron writes security warnings straight into an unpackaged renderer's
 * console. They are about how Electron is hosting the page, not about the page,
 * so they are noise in a buffer whose entire purpose is to tell an agent what
 * the page under development is doing wrong.
 *
 * Filtered rather than suppressed with ELECTRON_DISABLE_SECURITY_WARNINGS,
 * because that variable is process-wide: it would also silence the warnings for
 * Threadlines' own renderer, losing a real safety net on our own code to clean
 * up someone else's console.
 *
 * Matching on the warning's brand string is deliberate. It is stable across
 * Electron versions, and if it ever changes the failure mode is that a warning
 * reappears in the buffer -- the behaviour we have today -- rather than
 * anything breaking.
 */

const ELECTRON_WARNING_MARKER = "Electron Security Warning";

export function isHostInjectedConsoleEntry(entry: {
  readonly level: string;
  readonly text: string;
}): boolean {
  return entry.level === "warning" && entry.text.includes(ELECTRON_WARNING_MARKER);
}
