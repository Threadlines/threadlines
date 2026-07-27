/**
 * The one call the subagent inspector makes to a provider. Keeping it behind
 * this module keeps the rendering components off the environment runtime
 * service, whose module graph is far larger than a transcript page needs.
 */
import type {
  EnvironmentId,
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
  /** Read the newest entries instead of paging from `offset`. */
  readonly fromEnd?: boolean;
}): Promise<ProviderSubagentTranscriptResult> {
  const connection = requireEnvironmentConnection(input.environmentId);
  return await connection.client.server.readSubagentTranscript({
    threadId: input.threadId,
    agentId: input.agentId,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
    ...(input.fromEnd !== undefined ? { fromEnd: input.fromEnd } : {}),
  });
}
