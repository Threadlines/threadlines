/**
 * Where Claude sends the output of a command it runs in the background. Its
 * reply to the launch names the file ("…Output is being written to:
 * /tmp/…/tasks/b1.output"), and nothing streams it. The client reads the path
 * off that reply; the server reads only a path a thread's own activity names
 * the same way.
 */

const OUTPUT_FILE_MARKER = "Output is being written to:";
const OUTPUT_FILE_EXTENSION = ".output";

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && char.trim() === "";
}

/** Whether a path that reaches `index` ends there: at the end of its line,
 *  before whitespace or a closing quote or bracket, or before sentence
 *  punctuation that itself ends the line or is followed by whitespace. So a
 *  name like `b1.output.bak` is never cut short to `b1.output`. */
function pathEndsAt(text: string, index: number, lineEnd: number): boolean {
  if (index >= lineEnd) return true;
  const char = text[index]!;
  if (isWhitespace(char) || "\"'`)]".includes(char)) return true;
  return ".,;:".includes(char) && (index + 1 >= lineEnd || isWhitespace(text[index + 1]));
}

/**
 * Every output file a piece of reply text names, in order. A plain scan
 * rather than a regular expression: the text is agent output of any size,
 * and a pattern that can backtrack would make a crafted reply slow to read.
 */
export function backgroundOutputFilesInText(text: string | null | undefined): string[] {
  if (!text) return [];
  const files: string[] = [];
  let markerAt = text.indexOf(OUTPUT_FILE_MARKER);
  while (markerAt >= 0) {
    let start = markerAt + OUTPUT_FILE_MARKER.length;
    while (start < text.length && isWhitespace(text[start]) && text[start] !== "\n") start += 1;
    const newline = text.indexOf("\n", start);
    const lineEnd = newline < 0 ? text.length : newline;
    // Where the next marker is looked for. A line with no path that ends
    // properly has none for a later marker either, so the scan moves past it;
    // every character is visited a bounded number of times.
    let resumeAt = lineEnd;
    let extensionAt = text.indexOf(OUTPUT_FILE_EXTENSION, start);
    while (extensionAt >= 0 && extensionAt < lineEnd) {
      const pathEnd = extensionAt + OUTPUT_FILE_EXTENSION.length;
      if (pathEnd <= lineEnd && pathEndsAt(text, pathEnd, lineEnd)) {
        const file = text.slice(start, pathEnd).trim();
        if (file.length > OUTPUT_FILE_EXTENSION.length) files.push(file);
        resumeAt = pathEnd;
        break;
      }
      extensionAt = text.indexOf(OUTPUT_FILE_EXTENSION, extensionAt + 1);
    }
    markerAt = text.indexOf(OUTPUT_FILE_MARKER, resumeAt);
  }
  return files;
}

/** The output file a reply names, when it names one. */
export function backgroundOutputFileFromText(text: string | null | undefined): string | null {
  return backgroundOutputFilesInText(text)[0] ?? null;
}

/** Claude's background output files: an absolute `…/tasks/<id>.output` path
 *  with no `..` segment. */
export function isBackgroundRunOutputPath(file: string): boolean {
  const absolute = file.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(file) || file.startsWith("\\\\");
  if (!absolute || file.includes("\0")) return false;
  const segments = file.split(/[\\/]/u);
  if (segments.includes("..") || segments.includes(".")) return false;
  return /^[\w-]+\.output$/u.test(segments.at(-1) ?? "") && segments.at(-2) === "tasks";
}
