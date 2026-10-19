/**
 * The newest line a command printed, for the rows that show one:
 *
 * - a background run's row in the run list, while the list is open. A
 *   terminal's output already streams to the client, so its line is read
 *   from the terminal store's recent events; a command Claude sent to the
 *   background writes to a file the server can read, so the row polls the
 *   end of that file. Runs whose output never reaches Threadlines (a process
 *   found by its port, a provider task without a file) have no line.
 * - the working row, while the agent runs a command. Output a provider
 *   streams (Codex) is already on the step; Claude's is asked of the live
 *   session.
 */
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@threadlines/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { lastPrintedLine } from "../../lib/terminalText";
import {
  selectTerminalEventEntries,
  useTerminalStateStore,
  type TerminalEventEntry,
} from "../../terminalStateStore";
import type { ThreadBackgroundRunItem } from "./threadActivity";

/** How often a row on screen re-reads a command's output. */
const OUTPUT_POLL_MS = 2_000;
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

/** One read of a command's output: its text (null when there was none to
 *  read this time), or `stop` when there will never be any. */
type OutputRead = { readonly text: string | null } | "stop";

/**
 * The newest printed line from polling `read` every OUTPUT_POLL_MS, one read
 * at a time, while `source` names what is read. The line is kept with its
 * source, so a row that starts reading something else never shows the old
 * line. A read that fails keeps the last line (the client cancels one that
 * hangs, see wsRpcClient); a hidden page skips reads until it shows again.
 */
function usePolledOutputLine(
  source: string | null,
  read: (() => Promise<OutputRead>) | null,
): string | null {
  const [state, setState] = useState<{ source: string; line: string | null } | null>(null);
  // The newest read, since its closure changes every render.
  const latestRead = useEffectEvent(() => read);
  const polling = source !== null && read !== null;

  useEffect(() => {
    if (!polling || source === null) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      const current = latestRead();
      if (current && document.visibilityState !== "hidden") {
        const answer = await current().catch(() => null);
        if (cancelled) return;
        if (answer === "stop") return;
        const line = answer ? lastPrintedLine(answer.text) : null;
        setState((previous) => {
          const sameSource = previous?.source === source;
          const nextLine = line ?? (sameSource ? previous.line : null);
          // An unchanged line keeps the same state, so a quiet run doesn't re-render.
          return sameSource && previous.line === nextLine ? previous : { source, line: nextLine };
        });
      }
      if (!cancelled) {
        timer = window.setTimeout(() => void poll(), OUTPUT_POLL_MS);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [polling, source]);

  return state !== null && state.source === source ? state.line : null;
}

function useOutputFileLine(
  threadRef: ScopedThreadRef | null,
  outputFile: string | null,
): string | null {
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;
  const readOutput = environmentId
    ? readEnvironmentApi(environmentId)?.backgroundRuns?.readOutput
    : undefined;
  return usePolledOutputLine(
    environmentId && threadId && outputFile
      ? `${environmentId}\u0000${threadId}\u0000${outputFile}`
      : null,
    readOutput && threadId && outputFile
      ? // A dropped connection or an older server keeps the last line read.
        () => readOutput({ threadId, outputFile }).then((result) => ({ text: result.tail }))
      : null,
  );
}

/** The command the agent is running right now, as the working row knows it. */
export interface LiveCommandOutput {
  /** The provider tool call that started it, to ask the live session by. */
  readonly toolCallId: string | null;
  /** Output the provider streamed onto the step (Codex), when it did. */
  readonly streamedOutput: string | null;
}

/**
 * The newest line the command the agent is running now has printed. Streamed
 * output is read off the step; otherwise the row asks the thread's live
 * session, which answers until the command ends (Claude), or says at once
 * that it can't (a provider that streams, before its first output).
 */
export function useLiveCommandOutputLine(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
  command: LiveCommandOutput | null,
): string | null {
  const streamedLine = lastPrintedLine(command?.streamedOutput);
  const toolCallId = streamedLine === null ? (command?.toolCallId ?? null) : null;
  const readCommandOutput = environmentId
    ? readEnvironmentApi(environmentId)?.backgroundRuns?.readCommandOutput
    : undefined;
  const polledLine = usePolledOutputLine(
    environmentId && threadId && toolCallId
      ? `${environmentId}\u0000${threadId}\u0000${toolCallId}`
      : null,
    readCommandOutput && threadId && toolCallId
      ? () =>
          readCommandOutput({ threadId, toolCallId }).then((result): OutputRead => {
            if (result.status === "unavailable") return "stop";
            return { text: result.status === "running" ? result.tail : null };
          })
      : null,
  );
  return streamedLine ?? polledLine;
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
