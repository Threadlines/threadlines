/**
 * The newest line a background run printed, for its row in the run list.
 * Each row asks only while it is on screen:
 *
 * - a terminal's output already streams to the client, so the line is read
 *   from the terminal store's recent events;
 * - a command Claude sent to the background writes to a file the server can
 *   read, so the row polls the end of that file.
 *
 * Runs whose output never reaches Threadlines (a process found by its port,
 * a provider task without a file) have no line.
 */
import type { ScopedThreadRef } from "@threadlines/contracts";
import { useEffect, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { lastPrintedLine } from "../../lib/terminalText";
import {
  selectTerminalEventEntries,
  useTerminalStateStore,
  type TerminalEventEntry,
} from "../../terminalStateStore";
import type { ThreadBackgroundRunItem } from "./threadActivity";

/** How often an open run list re-reads a background command's output file. */
const OUTPUT_FILE_POLL_MS = 2_000;
/** How many recent output chunks a terminal's line is read from. */
const TERMINAL_OUTPUT_LOOKBACK = 24;

/** The newest printed line among a terminal's recent events. Output from
 *  before the screen was last cleared or the shell restarted doesn't count. */
export function lastTerminalOutputLine(entries: ReadonlyArray<TerminalEventEntry>): string | null {
  const chunks: string[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const event = entries[index]!.event;
    if (event.type === "cleared" || event.type === "started" || event.type === "restarted") {
      break;
    }
    if (event.type !== "output") continue;
    chunks.unshift(event.data);
    if (chunks.length >= TERMINAL_OUTPUT_LOOKBACK) break;
  }
  return chunks.length > 0 ? lastPrintedLine(chunks.join("")) : null;
}

function useTerminalOutputLine(
  threadRef: ScopedThreadRef | null,
  terminalId: string | null,
): string | null {
  return useTerminalStateStore((state) =>
    threadRef && terminalId
      ? lastTerminalOutputLine(
          selectTerminalEventEntries(state.terminalEventEntriesByKey, threadRef, terminalId),
        )
      : null,
  );
}

function useOutputFileLine(
  threadRef: ScopedThreadRef | null,
  outputFile: string | null,
): string | null {
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;
  const source =
    environmentId && threadId && outputFile
      ? `${environmentId}\u0000${threadId}\u0000${outputFile}`
      : null;
  // The line is kept with the file it came from, so a row that starts
  // reading another file never shows the old file's line.
  const [read, setRead] = useState<{ source: string; line: string | null } | null>(null);

  useEffect(() => {
    const readOutput =
      environmentId && threadId && outputFile && source
        ? readEnvironmentApi(environmentId)?.backgroundRuns?.readOutput
        : undefined;
    if (!readOutput || !threadId || !outputFile || !source) {
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const result = await readOutput({ threadId, outputFile });
        if (!cancelled) {
          const line = lastPrintedLine(result.tail);
          setRead((current) => {
            const sameSource = current?.source === source;
            const nextLine = line ?? (sameSource ? current.line : null);
            // An unchanged line keeps the same state, so a quiet run doesn't re-render.
            return sameSource && current.line === nextLine ? current : { source, line: nextLine };
          });
        }
      } catch {
        // A dropped connection or an older server: keep the last line read.
      }
      if (!cancelled) {
        timer = window.setTimeout(() => void poll(), OUTPUT_FILE_POLL_MS);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [environmentId, outputFile, source, threadId]);

  return read !== null && read.source === source ? read.line : null;
}

export function useBackgroundRunOutputLine(
  run: ThreadBackgroundRunItem,
  threadRef: ScopedThreadRef | null,
): string | null {
  const terminalLine = useTerminalOutputLine(
    threadRef,
    run.source === "terminal" ? run.terminalId : null,
  );
  const fileLine = useOutputFileLine(threadRef, run.outputFile ?? null);
  return run.outputLine ?? terminalLine ?? fileLine;
}
