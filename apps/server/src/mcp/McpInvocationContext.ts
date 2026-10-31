import type { ThreadId } from "@threadlines/contracts";
import * as Context from "effect/Context";

import type { OutsideToolLimit } from "./outsideToolLimit.ts";

/**
 * Which conversation a tool call belongs to.
 *
 * The tools take no thread argument and must not: the agent would be guessing,
 * and a wrong guess would drive somebody else's browser. It comes from the
 * credential the call arrived with instead, so the reach of a tool call is
 * decided by whoever issued that credential rather than by the model.
 */
export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  {
    readonly threadId: ThreadId;
    readonly agentId: string;
    /** Read per call: outside work turns the browser off for the agent (outsideToolLimit.ts). */
    readonly outsideLimit?: OutsideToolLimit | undefined;
  }
>()("@threadlines/server/mcp/McpInvocationContext") {}
