/**
 * The composer notice for a thread an assistant's or outside agent's work
 * reached (docs/design/assistants.md, "Build plan: step 3"). While the thread
 * has outside work (OrchestrationOutsideWork), the agents it reached keep
 * read-only Threadlines tools and no browser panel, until they start fresh.
 * The notice says whose work it was and offers Start fresh, which stops the
 * thread's session; the server clears the mark once the agents are gone, and
 * the notice leaves with it.
 *
 * @module outsideWorkNotice
 */
import { scopeThreadRef } from "@threadlines/client-runtime";
import type { ThreadId, ThreadParticipantId } from "@threadlines/contracts";
import { useCallback, useMemo, useState } from "react";

import { describeOutsideWork } from "../../environments/outsideAgents/outsideAgents.logic";
import { stopThreadSession } from "../../lib/threadSessionCommands";
import type { Thread } from "../../types";
import { Button } from "../ui/button";
import { failureNotice, toastManager } from "../ui/toast";
import type { ComposerNotice } from "./composerNotices";

/**
 * The notice for the open thread, or null while no outside work marks it.
 * `agentName` names a room's agents; null while the thread has only its own.
 */
export function useOutsideWorkNotice(input: {
  readonly thread: Pick<Thread, "id" | "environmentId" | "outsideWork"> | undefined;
  readonly agentName: ((participantId: ThreadParticipantId | null) => string) | null;
}): ComposerNotice | null {
  const { thread, agentName } = input;
  const [stoppingThreadId, setStoppingThreadId] = useState<ThreadId | null>(null);
  const work = thread?.outsideWork;
  const environmentId = thread?.environmentId;
  const threadId = thread?.id;

  const onStartFresh = useCallback(() => {
    if (environmentId === undefined || threadId === undefined) return;
    setStoppingThreadId(threadId);
    void (async () => {
      try {
        await stopThreadSession(scopeThreadRef(environmentId, threadId));
      } catch (error) {
        toastManager.add(failureNotice({ title: "Couldn't start the agent fresh", error }));
      } finally {
        setStoppingThreadId((current) => (current === threadId ? null : current));
      }
    })();
  }, [environmentId, threadId]);

  const stopping = threadId !== undefined && stoppingThreadId === threadId;
  const inRoom = agentName !== null;
  // The words, as strings: a room's names are rebuilt as the thread streams,
  // and the notice should keep its identity while they read the same.
  const words = describeOutsideWork(work ?? [], agentName);
  const lead = words?.lead ?? null;
  const detail = words?.detail ?? null;
  return useMemo(() => {
    if (lead === null || detail === null || threadId === undefined) return null;
    return {
      id: `outside-work:${threadId}`,
      severity: "info",
      lead,
      detail,
      actions: (
        <Button
          size="xs"
          variant="outline"
          disabled={stopping}
          onClick={onStartFresh}
          tooltip={
            inRoom
              ? "Stops this thread's agents and anything they left running. Your next message starts them fresh."
              : "Stops this agent and anything it left running. Your next message starts it fresh."
          }
        >
          {stopping ? "Starting fresh…" : "Start fresh"}
        </Button>
      ),
    };
  }, [detail, inRoom, lead, onStartFresh, stopping, threadId]);
}
