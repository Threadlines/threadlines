import {
  AGENT_WARM_UP_DEBOUNCE_MS,
  nextAgentWarmUp,
  type AgentWarmUpInput,
  type AgentWarmUpSent,
} from "@threadlines/client-runtime";
import type { EnvironmentId } from "@threadlines/contracts";
import { useEffect, useRef } from "react";

import { readEnvironmentApi } from "../environmentApi";

/**
 * Starts the thread's stopped agent while the user types, once typing pauses
 * (docs/early-agent-start.md). `text` is the composer's text: every change
 * waits for the next pause, and the warm-up is renewed while typing goes on.
 * Once the composer empties (the message went out, or was cleared), the next
 * message gets its own warm-up: the agent may have stopped in between.
 */
export function useAgentWarmUp(
  environmentId: EnvironmentId,
  input: Omit<AgentWarmUpInput, "hasText">,
  text: string,
) {
  const lastSentRef = useRef<AgentWarmUpSent | null>(null);
  const inputRef = useRef(input);
  useEffect(() => {
    inputRef.current = input;
  });
  const { enabled, threadId, serverThreadExists, turnActive, participantId, runtimeMode } = input;
  const { instanceId, model } = input.modelSelection;
  useEffect(() => {
    const hasText = text.trim().length > 0;
    if (!hasText) {
      lastSentRef.current = null;
    }
    if (!enabled || threadId === null || !serverThreadExists || !hasText || turnActive) {
      return;
    }
    const timer = window.setTimeout(() => {
      const next = nextAgentWarmUp(
        { ...inputRef.current, hasText },
        lastSentRef.current,
        Date.now(),
      );
      if (next === null) {
        return;
      }
      lastSentRef.current = next.sent;
      void readEnvironmentApi(environmentId)
        ?.orchestration.warmUpTurn(next.request)
        .catch(() => undefined);
    }, AGENT_WARM_UP_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [
    environmentId,
    enabled,
    threadId,
    serverThreadExists,
    turnActive,
    // Read through `inputRef`, listed so a new target (agent, model, access
    // level) waits for its own pause and goes out without more typing.
    participantId,
    instanceId,
    model,
    runtimeMode,
    text,
  ]);
}
