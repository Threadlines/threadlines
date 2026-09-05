interface TranscriptOrder {
  readonly eventSequence?: number | undefined;
  readonly createdAt: string;
  readonly id?: string | undefined;
}

/** Persisted event order survives clock corrections and provider restarts.
 * Legacy entries without an event remain before the sequenced history. */
export function compareTranscriptOrder(left: TranscriptOrder, right: TranscriptOrder): number {
  return compareTranscriptPosition(left, right) || (left.id ?? "").localeCompare(right.id ?? "");
}

/** Timeline rows retain their existing stable order when positions tie. */
export function compareTranscriptPosition(left: TranscriptOrder, right: TranscriptOrder): number {
  return (
    (left.eventSequence ?? -1) - (right.eventSequence ?? -1) ||
    left.createdAt.localeCompare(right.createdAt)
  );
}
