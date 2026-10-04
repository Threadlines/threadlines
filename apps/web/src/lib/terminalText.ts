/**
 * Reading what a terminal printed as plain text: control sequences out, and
 * the newest line as a person would see it on screen.
 */

// Built from the escape and bell characters so the pattern itself holds no
// control codes. Covers OSC strings (titles, hyperlinks), CSI sequences
// (colours, cursor moves) and the two-character escapes.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const TERMINAL_CONTROL_SEQUENCE_PATTERN = new RegExp(
  `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}[@-Z\\\\-_]`,
  "gu",
);
// Whatever control characters remain once the sequences are gone (a stray
// bell, a backspace), except tab and the line breaks the caller splits on.
// oxlint-disable-next-line no-control-regex -- stripping control characters is the point
const LEFTOVER_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

export function stripTerminalControlSequences(text: string): string {
  return text.replace(TERMINAL_CONTROL_SEQUENCE_PATTERN, "");
}

const MAX_LINE_CHARS = 240;

/**
 * The newest non-empty line of terminal output. A carriage return redraws its
 * line in place (progress bars, spinners), so only the text after the last
 * one is what the screen shows.
 */
export function lastPrintedLine(text: string | null | undefined): string | null {
  if (!text) return null;
  const lines = stripTerminalControlSequences(text).split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const shown = (lines[index] ?? "")
      .split("\r")
      .map((segment) => segment.replace(LEFTOVER_CONTROL_PATTERN, "").trim())
      .findLast((segment) => segment.length > 0);
    if (shown) {
      return shown.length > MAX_LINE_CHARS ? `${shown.slice(0, MAX_LINE_CHARS - 1)}…` : shown;
    }
  }
  return null;
}
