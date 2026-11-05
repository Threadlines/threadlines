/**
 * The other computers an outside agent connected here can work on
 * (docs/design/assistants.md, "Other computers"): the computers this one has
 * a usable Fleet link to. Each decides for itself: this computer asks its
 * user there (`peer.outside.ask`), and forwards the agent's calls over the
 * link once it said yes (`peer.outside.call`), with what the agent may do
 * here now so the other computer never lets it do more.
 *
 * Optional: a server without computer links has none.
 */
import {
  type EnvironmentId,
  type OutsideAgentConnectionId,
  OutsideAgentError,
  type OutsideAgentReach,
  type PeerOutsideAgent,
  type PeerOutsideCallInput,
  type PeerOutsideCallResult,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { ComputerLinkClient } from "../links/ComputerLinkClient.ts";
import { ComputerLinkRepository, isUsableLink } from "../links/ComputerLinkRepository.ts";
import { OutsideAgentConnections, type OutsideAgentLiveGrant } from "./OutsideAgentConnections.ts";

/** A linked computer, as calls name it. */
export interface OtherComputer {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/** The computer couldn't be reached, or its link refused the call before it ran. */
export class OtherComputerUnreachable extends Data.TaggedError("OtherComputerUnreachable")<{
  readonly detail: string;
}> {}

/**
 * Which computer a call's `computer` names: this one, a linked one, or none.
 * An id matches before a name, since a linked computer picks its own name
 * and could take another's; a name two computers share names neither.
 */
export type FoundComputer =
  | { readonly kind: "here" }
  | { readonly kind: "linked"; readonly computer: OtherComputer }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly computers: ReadonlyArray<OtherComputer> };

export interface OtherComputersShape {
  /** This computer: its name and id. */
  readonly here: Effect.Effect<OtherComputer>;
  /** The computer a call names, by id first, then by name (any case). */
  readonly find: (nameOrId: string) => Effect.Effect<FoundComputer>;
  /** Every linked computer and where the connection stands there, each asked live. */
  readonly reach: (
    connectionId: OutsideAgentConnectionId,
  ) => Effect.Effect<ReadonlyArray<OutsideAgentReach>, OutsideAgentError>;
  /** Asks that computer's user to let the connection in there too. */
  readonly ask: (
    connectionId: OutsideAgentConnectionId,
    environmentId: EnvironmentId,
  ) => Effect.Effect<OutsideAgentReach, OutsideAgentError>;
  /** Takes that computer away from the connection (an ask still waiting there too). */
  readonly remove: (
    connectionId: OutsideAgentConnectionId,
    environmentId: EnvironmentId,
  ) => Effect.Effect<OutsideAgentReach, OutsideAgentError>;
  /** Runs one of the agent's tools there. */
  readonly call: (
    computer: OtherComputer,
    input: PeerOutsideCallInput,
    timeout: Duration.Duration,
  ) => Effect.Effect<PeerOutsideCallResult, OtherComputerUnreachable>;
  /** The connection was removed here: every linked computer that's on forgets it, as far as it can be told. */
  readonly forgetEverywhere: (connectionId: OutsideAgentConnectionId) => Effect.Effect<void>;
}

export class OtherComputers extends Context.Service<OtherComputers, OtherComputersShape>()(
  "threadlines/outsideAgents/OtherComputers",
) {}

/** FoundComputer's rule, over this computer and the linked ones. */
export const findComputer = (input: {
  readonly nameOrId: string;
  readonly here: OtherComputer;
  readonly computers: ReadonlyArray<OtherComputer>;
}): FoundComputer => {
  const raw = input.nameOrId.trim();
  const wanted = raw.toLowerCase();
  if (raw === input.here.environmentId) return { kind: "here" };
  const byId = input.computers.find((computer) => computer.environmentId === raw);
  if (byId !== undefined) return { kind: "linked", computer: byId };
  // This computer's own name means this computer, whatever a linked one calls itself.
  if (input.here.label.trim().toLowerCase() === wanted) return { kind: "here" };
  const named = input.computers.filter(
    (computer) => computer.label.trim().toLowerCase() === wanted,
  );
  if (named.length === 1) return { kind: "linked", computer: named[0]! };
  return named.length === 0 ? { kind: "none" } : { kind: "ambiguous", computers: named };
};

/** How long a question about one computer waits before calling it offline. */
const ASK_WAIT = Duration.seconds(5);

/** The agent as another computer is told it: who it is, and what it may do here now. */
export const peerAgentOf = (
  grant: OutsideAgentLiveGrant,
  kind: PeerOutsideAgent["kind"],
): PeerOutsideAgent => ({
  connectionId: grant.connectionId,
  name: grant.name,
  givenName: grant.givenName ?? null,
  assistant: grant.assistant ?? null,
  kind: grant.kind ?? kind,
  access: grant.access,
  maxRuntimeMode: grant.maxRuntimeMode,
});

export const OtherComputersLive = Layer.effect(
  OtherComputers,
  Effect.gen(function* () {
    const client = yield* ComputerLinkClient;
    const links = yield* ComputerLinkRepository;
    const environment = yield* ServerEnvironment;
    const connections = yield* OutsideAgentConnections;

    const usable = links.list.pipe(
      Effect.map((rows) =>
        rows.filter(isUsableLink).map((row): OtherComputer => ({
          environmentId: row.remoteEnvironmentId,
          label: client.cachedDescribe(row.remoteEnvironmentId)?.label ?? row.remoteLabel,
        })),
      ),
      Effect.orElseSucceed((): ReadonlyArray<OtherComputer> => []),
    );

    const hereComputer = Effect.map(
      environment.getEnvironmentId,
      (environmentId): OtherComputer => ({ environmentId, label: environment.currentLabel() }),
    );

    const find: OtherComputersShape["find"] = (nameOrId) =>
      Effect.gen(function* () {
        return findComputer({ nameOrId, here: yield* hereComputer, computers: yield* usable });
      });

    const agentOf = (connectionId: OutsideAgentConnectionId) =>
      Effect.flatMap(connections.grant(connectionId), (grant) =>
        grant === null || grant.linked === true
          ? Effect.fail(new OutsideAgentError({ detail: "That connection was removed." }))
          : Effect.succeed(peerAgentOf(grant, "local")),
      );

    /** Where the connection stands on one computer, asked there. */
    const standing = (
      computer: OtherComputer,
      connectionId: OutsideAgentConnectionId,
    ): Effect.Effect<OutsideAgentReach> =>
      Effect.gen(function* () {
        const base = { environmentId: computer.environmentId, computer: computer.label };
        const described = yield* client.describe(computer.environmentId).pipe(
          Effect.timeoutOption(ASK_WAIT),
          Effect.orElseSucceed(() => Option.none()),
        );
        if (Option.isNone(described)) return { ...base, state: "offline" as const };
        if (described.value.outsideAgents !== true)
          return { ...base, state: "unsupported" as const };
        const status = yield* client
          .withPeer(computer.environmentId, (peer) =>
            peer["peer.outside.status"]({ connectionIds: [connectionId] }),
          )
          .pipe(
            Effect.timeoutOption(ASK_WAIT),
            Effect.orElseSucceed(() => Option.none()),
          );
        if (Option.isNone(status)) return { ...base, state: "offline" as const };
        const entry = status.value.entries.find((found) => found.connectionId === connectionId);
        if (entry === undefined) return { ...base, state: "none" as const };
        return {
          ...base,
          state: entry.state,
          ...(entry.access !== undefined ? { access: entry.access } : {}),
          ...(entry.maxRuntimeMode !== undefined ? { maxRuntimeMode: entry.maxRuntimeMode } : {}),
          ...(entry.projectCount !== undefined ? { projectCount: entry.projectCount } : {}),
        };
      });

    const computerOf = (environmentId: EnvironmentId) =>
      Effect.flatMap(usable, (computers) => {
        const found = computers.find((computer) => computer.environmentId === environmentId);
        return found === undefined
          ? Effect.fail(
              new OutsideAgentError({ detail: "That computer isn't linked to this one." }),
            )
          : Effect.succeed(found);
      });

    const unreachable = (computer: OtherComputer) =>
      new OutsideAgentError({
        detail: `${computer.label} couldn't be reached. Try again when it's on.`,
      });

    const reach: OtherComputersShape["reach"] = (connectionId) =>
      Effect.gen(function* () {
        yield* agentOf(connectionId);
        const computers = yield* usable;
        return yield* Effect.forEach(computers, (computer) => standing(computer, connectionId), {
          concurrency: "unbounded",
        });
      });

    const ask: OtherComputersShape["ask"] = (connectionId, environmentId) =>
      Effect.gen(function* () {
        const agent = yield* agentOf(connectionId);
        const computer = yield* computerOf(environmentId);
        yield* client
          .withPeer(environmentId, (peer) => peer["peer.outside.ask"](agent))
          .pipe(Effect.mapError(() => unreachable(computer)));
        return yield* standing(computer, connectionId);
      });

    const remove: OtherComputersShape["remove"] = (connectionId, environmentId) =>
      Effect.gen(function* () {
        const computer = yield* computerOf(environmentId);
        yield* client
          .withPeer(environmentId, (peer) => peer["peer.outside.forget"]({ connectionId }))
          .pipe(Effect.mapError(() => unreachable(computer)));
        return yield* standing(computer, connectionId);
      });

    const call: OtherComputersShape["call"] = (computer, input, timeout) =>
      client
        .withPeer(computer.environmentId, (peer) => peer["peer.outside.call"](input), { timeout })
        .pipe(
          Effect.catchTags({
            ComputerLinkUnavailableError: (error) =>
              Effect.fail(new OtherComputerUnreachable({ detail: error.detail })),
            PeerRpcError: (error) =>
              Effect.fail(new OtherComputerUnreachable({ detail: error.detail })),
          }),
        );

    const forgetEverywhere: OtherComputersShape["forgetEverywhere"] = (connectionId) =>
      Effect.gen(function* () {
        const computers = yield* usable;
        yield* Effect.forEach(
          computers,
          (computer) =>
            client
              .withPeer(computer.environmentId, (peer) =>
                peer["peer.outside.forget"]({ connectionId }),
              )
              .pipe(Effect.timeoutOption(ASK_WAIT), Effect.ignore),
          { concurrency: "unbounded", discard: true },
        );
      });

    return OtherComputers.of({
      here: hereComputer,
      find,
      reach,
      ask,
      remove,
      call,
      forgetEverywhere,
    });
  }),
);
