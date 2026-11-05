/**
 * Runs the outside agents' tools here for an agent connected on a linked
 * computer (`peer.outside.call`, docs/design/assistants.md, "Other
 * computers"). The same handlers as this computer's doors, one set per door
 * kind so an assistant's calls keep the assistants door's rules (`requestId`
 * required, a start answering before its setup, short waits) and its privacy
 * (this computer's home folder scrubbed from answers, restored in answers to
 * questions). The call runs as the agent's row here, with its grant no more
 * than what the agent has there now (ForwardedGrantCap).
 *
 * One instance for the server: rate limits, starts still being set up and
 * request ids live in it, whichever connection to the link a call came over.
 */
import type { OutsideAgentConnectionKind } from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { Tool } from "effect/ai";

import { scrubHome, withHomeRestored, withHomeScrubbed } from "../assistants/AssistantMcpServer.ts";
import { makeConnectToolDeps } from "./connectToolDeps.ts";
import { type ConnectToolHandlers, makeConnectToolHandlers } from "./connectToolHandlers.ts";
import { ConnectToolkit, type OutsideThreadAnswerTool } from "./connectTools.ts";
import { cappedGrant, ForwardedGrantCap } from "./forwardedCalls.ts";
import type { OutsideAgentCaller } from "./OutsideAgentConnections.ts";

export type OutsideToolRun = { readonly result: unknown } | { readonly refused: string };

export interface OutsideToolRunnerShape {
  readonly run: (input: {
    readonly kind: OutsideAgentConnectionKind;
    readonly caller: OutsideAgentCaller;
    readonly cap: ForwardedGrantCap;
    readonly tool: string;
    readonly input: unknown;
  }) => Effect.Effect<OutsideToolRun>;
}

export class OutsideToolRunner extends Context.Service<OutsideToolRunner, OutsideToolRunnerShape>()(
  "threadlines/outsideAgents/OutsideToolRunner",
) {}

type AnyHandler = (caller: OutsideAgentCaller, input: unknown) => Effect.Effect<unknown>;

const refuse = (refused: string): OutsideToolRun => ({ refused });
const answered = (result: unknown): OutsideToolRun => ({ result });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const OutsideToolRunnerLive = Layer.effect(
  OutsideToolRunner,
  Effect.gen(function* () {
    const base = yield* makeConnectToolDeps;
    // A forwarded call's grant here is never above what the agent has there.
    const deps = {
      ...base,
      connections: {
        ...base.connections,
        grant: (connectionId: Parameters<typeof base.connections.grant>[0]) =>
          Effect.flatMap(base.connections.grant(connectionId), (grant) =>
            ForwardedGrantCap.useSync((cap) => cappedGrant(grant, cap)),
          ),
      },
    };
    const doors: Record<OutsideAgentConnectionKind, ConnectToolHandlers> = {
      local: yield* makeConnectToolHandlers(deps, { door: "local" }),
      assistant: yield* makeConnectToolHandlers(deps, { door: "assistant", scrubText: scrubHome }),
    };
    const tools: Readonly<Record<string, Tool.Any>> = ConnectToolkit.tools;

    const run: OutsideToolRunnerShape["run"] = (input) =>
      Effect.gen(function* () {
        const tool = tools[input.tool];
        const handler = (doors[input.kind] as unknown as Record<string, AnyHandler | undefined>)[
          input.tool
        ];
        if (tool === undefined || handler === undefined) {
          return refuse(`This computer has no tool called ${input.tool}.`);
        }
        // No hops: what came over a link stays here.
        if (isObject(input.input) && input.input["computer"] !== undefined) {
          return refuse("A call forwarded to this computer can't go on to another one.");
        }
        const decoded = yield* Schema.decodeUnknownEffect(
          tool.parametersSchema as Schema.Codec<unknown>,
        )(input.input ?? {}).pipe(Effect.result);
        if (decoded._tag === "Failure") {
          return refuse(`Those parameters don't fit ${input.tool}.`);
        }
        const parameters =
          input.kind === "assistant" && input.tool === "thread_answer"
            ? withHomeRestored(decoded.success as Tool.Parameters<typeof OutsideThreadAnswerTool>)
            : decoded.success;
        const answer = yield* handler(input.caller, parameters).pipe(
          Effect.provideService(ForwardedGrantCap, input.cap),
        );
        const encoded = yield* Schema.encodeEffect(tool.successSchema as Schema.Codec<unknown>)(
          answer,
        ).pipe(Effect.orDie);
        return answered(input.kind === "assistant" ? withHomeScrubbed(encoded) : encoded);
      });

    return OutsideToolRunner.of({ run });
  }),
);
