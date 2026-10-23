/**
 * TEMPORARY: a stand-in for OutsideAgentConnectionsLive until the sign-in
 * side (OAuth, the connection rows) is in this build. No connection exists,
 * so every token is refused and `/mcp/connect` answers 401. Delete this file
 * and its one line in server.ts when the live service is provided.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OutsideAgentConnections } from "./OutsideAgentConnections.ts";

export const OutsideAgentConnectionsStandIn = Layer.succeed(OutsideAgentConnections, {
  authenticate: () => Effect.succeed(null),
  grant: () => Effect.succeed(null),
});
