/**
 * Community agents.
 *
 * Agents from the ACP registry (agentclientprotocol/registry) that
 * Threadlines can install and run but has not tested. The server reads the
 * registry, reduces each entry to what it would install on its own computer
 * (a "recipe"), and names that recipe by digest: a client confirms an
 * install or update by sending the digest of exactly what it was shown.
 *
 * Every string here comes from the registry or from an agent and is bounded
 * by the server before it is sent. Clients render all of it as text.
 *
 * @module acpRegistry
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/** The driver every community agent runs on. One instance per agent, `acp_<agentId>`. */
export const ACP_REGISTRY_DRIVER_KIND = ProviderDriverKind.make("acpRegistry");

const bounded = (maxLength: number) => Schema.String.check(Schema.isMaxLength(maxLength));

/** A registry agent's id. Short enough that `acp_<id>` is a valid instance id. */
export const AcpRegistryAgentId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]*$/),
  Schema.isMaxLength(59),
);
export type AcpRegistryAgentId = typeof AcpRegistryAgentId.Type;

/**
 * sha256 of a recipe's canonical JSON, lowercase hex. Two listings with the
 * same version but another download address, checksum, command or
 * environment have different digests.
 */
export const AcpRegistryRecipeDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export type AcpRegistryRecipeDigest = typeof AcpRegistryRecipeDigest.Type;

/** Where an agent's files come from: the npm registry, or a download from its publisher. */
export const AcpRegistrySource = Schema.Literals(["npm", "download"]);
export type AcpRegistrySource = typeof AcpRegistrySource.Type;

/**
 * What a first install can be checked against: the publisher's checksum
 * (`checksum`), nothing (`none`: the publisher lists no checksum), or the
 * npm registry's own package hashes (`package`).
 */
export const AcpRegistryIntegrity = Schema.Literals(["checksum", "none", "package"]);
export type AcpRegistryIntegrity = typeof AcpRegistryIntegrity.Type;

const AgentName = bounded(160);
const AgentVersion = bounded(64);
const AgentAuthors = Schema.Array(bounded(256));
const HttpsAddress = bounded(2048);
/** The agent's icon as SVG text. Drawn as a mask, never inserted as markup. */
const AgentIconSvg = bounded(32 * 1024);

/** One agent the user could add, as it would be installed on the server's computer. */
export const AcpRegistryCatalogAgent = Schema.Struct({
  agentId: AcpRegistryAgentId,
  name: AgentName,
  version: AgentVersion,
  recipeDigest: AcpRegistryRecipeDigest,
  description: bounded(1024),
  authors: AgentAuthors,
  license: Schema.NullOr(bounded(128)),
  /** Always https. */
  website: Schema.NullOr(HttpsAddress),
  /** Always https. */
  repository: Schema.NullOr(HttpsAddress),
  iconSvg: Schema.NullOr(AgentIconSvg),
  source: AcpRegistrySource,
  /** `npm`: the package and exact version that would be installed. */
  packageSpec: Schema.NullOr(bounded(256)),
  /** `download`: the host the archive comes from. */
  host: Schema.NullOr(bounded(255)),
  integrity: AcpRegistryIntegrity,
});
export type AcpRegistryCatalogAgent = typeof AcpRegistryCatalogAgent.Type;

export const AcpRegistryCatalog = Schema.Struct({
  /** Without the agents Threadlines supports itself and the ones the registry has quarantined. */
  agents: Schema.Array(AcpRegistryCatalogAgent),
  /** When the list was last read from the registry; null when it never was. */
  fetchedAt: Schema.NullOr(IsoDateTime),
  /** The last read failed and this is the saved copy. */
  stale: Schema.Boolean,
  /**
   * False until the registry's quarantine list has been read once. Nothing
   * can be installed before that.
   */
  quarantineKnown: Schema.Boolean,
  /** Listed agents with no build for the server's computer. */
  unsupportedCount: NonNegativeInt,
});
export type AcpRegistryCatalog = typeof AcpRegistryCatalog.Type;

export const AcpRegistryListInput = Schema.Struct({
  /** Read the registry again even if the copy in memory is recent. */
  refresh: Schema.optional(Schema.Boolean),
});
export type AcpRegistryListInput = typeof AcpRegistryListInput.Type;

export const AcpRegistryAddInput = Schema.Struct({
  agentId: AcpRegistryAgentId,
  /** The digest the client showed the user. Refused when the listing has moved on. */
  recipeDigest: AcpRegistryRecipeDigest,
});
export type AcpRegistryAddInput = typeof AcpRegistryAddInput.Type;

export const AcpRegistryAddResult = Schema.Struct({
  /** The new instance. Its install runs on the server and shows on its row. */
  instanceId: ProviderInstanceId,
});
export type AcpRegistryAddResult = typeof AcpRegistryAddResult.Type;

export const AcpRegistryRemoveInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type AcpRegistryRemoveInput = typeof AcpRegistryRemoveInput.Type;

export class AcpRegistryError extends Schema.TaggedError<AcpRegistryError>()("AcpRegistryError", {
  reason: Schema.Literals([
    /** The registry could not be read and there is no saved copy. */
    "catalogUnavailable",
    "unknownAgent",
    /** The listing changed since the client read it. */
    "staleRecipe",
    "quarantineUnknown",
    "alreadyAdded",
    "unknownInstance",
    /** Removal: something of the agent is still running. The row stays; try again. */
    "stillRunning",
    "settingsFailed",
    "filesFailed",
  ]),
  /** Plain-language explanation, safe to show the user. */
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

/**
 * How an agent's sign-in method can be run from Threadlines:
 * - `agent`: the agent signs in itself when asked (usually it opens a browser);
 * - `terminal`: the agent's own login command, run in the sign-in terminal;
 * - `envVar`: the agent reads a key from environment variables the user sets;
 * - `unsupported`: the agent signs in some way Threadlines doesn't run.
 */
export const AcpRegistrySignInMethodKind = Schema.Literals([
  "agent",
  "terminal",
  "envVar",
  "unsupported",
]);
export type AcpRegistrySignInMethodKind = typeof AcpRegistrySignInMethodKind.Type;

export const AcpRegistrySignInMethod = Schema.Struct({
  id: bounded(128),
  name: AgentName,
  description: Schema.NullOr(bounded(1024)),
  kind: AcpRegistrySignInMethodKind,
  /** `envVar`: the variables the method reads. */
  envVars: Schema.Array(bounded(128)),
});
export type AcpRegistrySignInMethod = typeof AcpRegistrySignInMethod.Type;

/** What a provider snapshot says about a community agent, beyond what every provider reports. */
export const ServerProviderCommunity = Schema.Struct({
  agentId: AcpRegistryAgentId,
  authors: AgentAuthors,
  website: Schema.NullOr(HttpsAddress),
  repository: Schema.NullOr(HttpsAddress),
  iconSvg: Schema.NullOr(AgentIconSvg),
  source: AcpRegistrySource,
  packageSpec: Schema.NullOr(bounded(256)),
  host: Schema.NullOr(bounded(255)),
  /**
   * How the installed copy was checked: against the publisher's checksum,
   * against the hash recorded the first time it was installed, or by the npm
   * registry's package hashes. Null while nothing is installed.
   */
  verification: Schema.NullOr(Schema.Literals(["publisher", "firstInstall", "packageRegistry"])),
  /**
   * The recipe the user confirmed, to name when installing it again (Try
   * again, repair). Null when the agent's files are gone and its record with
   * them.
   */
  confirmedRecipeDigest: Schema.NullOr(AcpRegistryRecipeDigest),
  /** A newer listing the user could update to. Never applied by itself. */
  updateCandidate: Schema.NullOr(
    Schema.Struct({ version: AgentVersion, recipeDigest: AcpRegistryRecipeDigest }),
  ),
  /** The agent now reports another version than when it was installed: it updated itself. */
  reportedVersionChanged: Schema.Boolean,
  signIn: Schema.Struct({
    methods: Schema.Array(AcpRegistrySignInMethod),
    /** The method the user picked; null when none is, or none is needed. */
    selected: Schema.NullOr(bounded(128)),
    canSignOut: Schema.Boolean,
  }),
});
export type ServerProviderCommunity = typeof ServerProviderCommunity.Type;
