/**
 * The web's side of MCP app cards (docs/mcp-apps.md) that does not draw:
 * loading a card's call and view, kept for the app session so a card the
 * timeline unmounts and mounts again does not load twice, and reading the
 * server's refusals.
 */
import type {
  EnvironmentId,
  McpAppFailureReason,
  McpAppLoadResult,
  ThreadId,
} from "@threadlines/contracts";

import { readEnvironmentApi } from "../../environmentApi";

/** The frame's height before the view reports its own, CSS px. */
export const MCP_APP_INITIAL_HEIGHT = 200;
/** The tallest a card's frame grows in the chat; the view scrolls past it. */
export const MCP_APP_INLINE_MAX_HEIGHT = 640;
export const MCP_APP_MIN_HEIGHT = 80;
/** A card's height before it loads: its title line and the frame. */
export const MCP_APP_CARD_ESTIMATED_PX = 48 + MCP_APP_INITIAL_HEIGHT;

export interface McpAppFailure {
  readonly reason: McpAppFailureReason;
  readonly message: string;
}

const REASONS: ReadonlySet<string> = new Set<McpAppFailureReason>([
  "not-found",
  "session-ended",
  "unsupported",
  "invalid-view",
  "needs-confirmation",
  "not-allowed",
  "failed",
]);

/** A refusal as the server worded it (McpAppError), or a plain failure. */
export function readMcpAppFailure(error: unknown): McpAppFailure {
  if (error !== null && typeof error === "object") {
    const { reason, message } = error as { reason?: unknown; message?: unknown };
    if (typeof reason === "string" && REASONS.has(reason)) {
      return {
        reason: reason as McpAppFailureReason,
        message: typeof message === "string" && message.length > 0 ? message : "It failed.",
      };
    }
  }
  return { reason: "failed", message: "Couldn't reach the server." };
}

/** A refusal the client itself makes, read like the server's. */
class McpAppUnavailableError extends Error {
  readonly reason: McpAppFailureReason = "unsupported";
}

const loaded = new Map<string, McpAppLoadResult>();

const cacheKey = (environmentId: EnvironmentId, threadId: ThreadId, toolCallId: string) =>
  `${environmentId}/${threadId}/${toolCallId}`;

export function cachedMcpApp(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  toolCallId: string,
): McpAppLoadResult | undefined {
  return loaded.get(cacheKey(environmentId, threadId, toolCallId));
}

/** A card's call and view. `recover`: start the agent's session again if
 *  that is what reading the view needs (the reader asked to). */
export async function loadMcpApp(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly toolCallId: string;
  readonly recover?: boolean;
}): Promise<McpAppLoadResult> {
  const api = readEnvironmentApi(input.environmentId)?.mcpApps;
  if (api === undefined) {
    throw new McpAppUnavailableError("This Threadlines server can't show MCP apps.");
  }
  const result = await api.load({
    threadId: input.threadId,
    toolCallId: input.toolCallId,
    ...(input.recover ? { recover: true } : {}),
  });
  loaded.set(cacheKey(input.environmentId, input.threadId, input.toolCallId), result);
  return result;
}
