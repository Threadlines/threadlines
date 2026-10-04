/**
 * Where Claude sends the output of a command it runs in the background. Its
 * reply to the launch names the file ("…Output is being written to:
 * /tmp/…/tasks/b1.output"), and nothing streams it. The client reads the path
 * off that reply; the server reads only a path a thread's own activity names
 * the same way.
 */

// The path ends at `.output` followed by whitespace, a closing quote or
// bracket, sentence punctuation that ends the text or a line, or the end of
// the text, so a name like `b1.output.bak` is never cut short to `b1.output`.
const BACKGROUND_OUTPUT_FILE_PATTERN =
  /Output is being written to:\s*(.+?\.output)(?=$|[\s"'`)\]]|[.,;:](?:\s|$))/gu;

/** Every output file a piece of reply text names, in order. */
export function backgroundOutputFilesInText(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...text.matchAll(BACKGROUND_OUTPUT_FILE_PATTERN)].flatMap((match) => {
    const file = match[1]?.trim();
    return file ? [file] : [];
  });
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
