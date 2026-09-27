/**
 * What an independent review is sent (room tools, `room_review`): a fixed
 * preamble, the asking agent's request, and the basis the server captured.
 * Nothing from the room's conversation goes in; that is the point of the
 * review. The chat shows the same request and basis (RoomReviewInput), so
 * the user can see exactly what the reviewer had.
 */
import type { RoomReviewInput } from "@threadlines/contracts";

const PREAMBLE = [
  "You are doing an independent review for a Threadlines room.",
  "You were not shown the conversation that led here, on purpose: judge the work on its own.",
  "You can read the checkout and use room_diff, but you cannot change anything or ask questions.",
  "Report concrete findings with evidence (file and line). Keep defects apart from preferences.",
  "Say plainly if you find nothing wrong.",
].join(" ");

/** The basis in words: which changes, how many files, and when they were captured. */
export function describeReviewBasis(input: RoomReviewInput): string {
  const { basis } = input;
  const files = `${basis.files} file${basis.files === 1 ? "" : "s"}`;
  const what =
    basis.kind === "uncommitted"
      ? `the uncommitted changes in the checkout (${files})`
      : `the changes from ${basis.base ?? "the base"} to ${basis.head ?? "HEAD"} (${files})`;
  return `${what}, captured at ${basis.capturedAt}${basis.truncated ? ", cut to fit" : ""}`;
}

export function buildIndependentReviewPrompt(
  request: string,
  input: RoomReviewInput | undefined,
): string {
  const basis =
    input === undefined
      ? "No changes were captured for this review; read the checkout as it is."
      : `What to review: ${describeReviewBasis(input)}.\n\n${input.diff}`;
  return [PREAMBLE, `The request:\n${request}`, basis].join("\n\n");
}
