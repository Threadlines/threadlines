/**
 * The calls the subagent inspector makes to a provider. Keeping them behind
 * this module keeps the rendering components off the environment runtime
 * service, whose module graph is far larger than a transcript page needs.
 */
import type {
  EnvironmentId,
  ProviderSubagentInputResult,
  ProviderSubagentTranscriptResult,
  ThreadId,
} from "@threadlines/contracts";

import { requireEnvironmentConnection } from "../../environments/runtime/service";

export async function readSubagentTranscriptPage(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly agentId: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly cursor?: string;
  /** Read the newest entries instead of paging from `offset`. */
  readonly fromEnd?: boolean;
}): Promise<ProviderSubagentTranscriptResult> {
  const connection = requireEnvironmentConnection(input.environmentId);
  return await connection.client.server.readSubagentTranscript({
    threadId: input.threadId,
    agentId: input.agentId,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    ...(input.fromEnd !== undefined ? { fromEnd: input.fromEnd } : {}),
  });
}

/** Sends a user message straight to a spawned agent (Codex only today). */
export async function sendSubagentInput(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly agentId: string;
  readonly text: string;
}): Promise<ProviderSubagentInputResult> {
  const connection = requireEnvironmentConnection(input.environmentId);
  return await connection.client.server.sendSubagentInput({
    threadId: input.threadId,
    agentId: input.agentId,
    text: input.text,
  });
}
