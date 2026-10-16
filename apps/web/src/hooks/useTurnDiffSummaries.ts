import { useMemo } from "react";
import { keyedMemo } from "../lib/derivationMemo";
import { inferCheckpointTurnCountByTurnId } from "../session-logic";
import type { Thread } from "../types";

/** Remembered per thread's summary list, so a chat opened again reuses its counts. */
const inferRememberedCheckpointTurnCounts = keyedMemo((summaries: Thread["turnDiffSummaries"]) =>
  inferCheckpointTurnCountByTurnId(summaries),
);

export function useTurnDiffSummaries(activeThread: Thread | undefined) {
  const turnDiffSummaries = useMemo(() => {
    if (!activeThread) {
      return [];
    }
    return activeThread.turnDiffSummaries;
  }, [activeThread]);

  const inferredCheckpointTurnCountByTurnId = useMemo(
    () => inferRememberedCheckpointTurnCounts(turnDiffSummaries),
    [turnDiffSummaries],
  );

  return { turnDiffSummaries, inferredCheckpointTurnCountByTurnId };
}
