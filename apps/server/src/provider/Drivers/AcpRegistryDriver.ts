// @effect-diagnostics nodeBuiltinImport:off - the agent's folder and its saved listing
/**
 * AcpRegistryDriver — `ProviderDriver` for community agents: agents from the
 * ACP registry, installed by Threadlines and not tested by it.
 *
 * One instance per agent (`acp_<agentId>`), built by the generic ACP driver
 * from a descriptor made here. Everything an agent keeps between rebuilds
 * of its instance (its launch gate, what it offers, its health, its
 * installer) lives per agent in this module and in `acpRegistry/`.
 *
 * @module provider/Drivers/AcpRegistryDriver
 */
import { randomBytes } from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import {
  ACP_REGISTRY_DRIVER_KIND,
  AcpRegistryAgentId,
  AcpRegistryCatalogAgent,
  AcpRegistrySettings,
  TextGenerationError,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import type { TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import { type AcpProviderDriverEnv, makeAcpProviderDriver } from "../acp/AcpProviderDriver.ts";
import {
  type AcpRegistryDescriptorInput,
  type AcpRegistryListing,
  makeAcpRegistryDescriptor,
} from "../acp/AcpRegistrySupport.ts";
import {
  type AcpRegistryAgentState,
  acpRegistryAgentState,
} from "../acpRegistry/AcpRegistryAgentState.ts";
import { makeAcpRegistryAuthFlows } from "../acpRegistry/AcpRegistryAuth.ts";
import { isReservedAcpRegistryEnvName } from "../acpRegistry/AcpRegistryCatalog.ts";
import {
  type AcpRegistryInstaller,
  acpRegistryAgentRoot,
  makeAcpRegistryInstaller,
} from "../acpRegistry/AcpRegistryInstaller.ts";
import { acpRegistryNodes } from "../acpRegistry/AcpRegistryNodes.ts";
import { ProviderDriverError } from "../Errors.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import type { ProviderDriver } from "../ProviderDriver.ts";

export type AcpRegistryDriverEnv = AcpProviderDriverEnv;

const LISTING_FILE = "listing.json";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const isAgentId = Schema.is(AcpRegistryAgentId);
/** What the registry, or an agent's sign-in method, may set in an agent's environment. */
const allowsEnvName = (name: string) => !isReservedAcpRegistryEnvName(name);

const ListingJson = Schema.fromJsonString(
  Schema.Struct({
    authors: AcpRegistryCatalogAgent.fields.authors,
    website: AcpRegistryCatalogAgent.fields.website,
    repository: AcpRegistryCatalogAgent.fields.repository,
    iconSvg: AcpRegistryCatalogAgent.fields.iconSvg,
    source: AcpRegistryCatalogAgent.fields.source,
    packageSpec: AcpRegistryCatalogAgent.fields.packageSpec,
    host: AcpRegistryCatalogAgent.fields.host,
  }),
);
const decodeListing = Schema.decodeUnknownOption(ListingJson);
const encodeListing = Schema.encodeSync(ListingJson);

/** What Threadlines keeps for one community agent, shared by every rebuild of its instance. */
export interface AcpRegistryAgentContext {
  readonly agentId: string;
  /** The agent's folder: its installed versions, and what it last said about itself. */
  readonly root: string;
  readonly installer: AcpRegistryInstaller;
  readonly state: AcpRegistryAgentState;
}

const contexts = new Map<string, AcpRegistryAgentContext>();

/** Where community agents and the Node.js they run on are installed. */
export const acpRegistryToolsDirs = (stateDir: string) => ({
  agents: NodePath.join(stateDir, "tools", "acp"),
  node: NodePath.join(stateDir, "tools", "node"),
});

/** The agent's installer and state in this process, created on first use. */
export function acpRegistryAgentContext(input: {
  readonly stateDir: string;
  readonly agentId: string;
  /** For messages. */
  readonly displayName: string;
}): AcpRegistryAgentContext {
  const key = `${input.stateDir}\u0000${input.agentId}`;
  let context = contexts.get(key);
  if (!context) {
    const dirs = acpRegistryToolsDirs(input.stateDir);
    // Node.js is shared: every agent's installer goes through the same
    // manager of a release, and an install keeps the releases from being
    // pruned while it runs.
    const nodes = acpRegistryNodes(dirs.node);
    const installer = makeAcpRegistryInstaller({
      agentId: input.agentId,
      label: input.displayName,
      toolsDir: dirs.agents,
      nodeToolsDir: dirs.node,
      makeNode: nodes.nodeFor,
    });
    context = {
      agentId: input.agentId,
      root: acpRegistryAgentRoot(dirs.agents, input.agentId),
      installer: {
        ...installer,
        install: (recipeDigest, onProgress) =>
          nodes.whileInstalling(installer.install(recipeDigest, onProgress)),
      },
      state: acpRegistryAgentState(input.agentId),
    };
    contexts.set(key, context);
  }
  return context;
}

/** Forgets a removed agent, so adding it again starts clean. */
export function forgetAcpRegistryAgentContext(stateDir: string, agentId: string): void {
  contexts.delete(`${stateDir}\u0000${agentId}`);
}

/**
 * Saves what the Providers page shows about where the agent came from. Best
 * effort, and it never fails: two clients reading the list at once both
 * write it.
 */
export const writeAcpRegistryListing = (
  root: string,
  listing: AcpRegistryListing,
): Effect.Effect<void> =>
  Effect.promise(async () => {
    const target = NodePath.join(root, LISTING_FILE);
    // A name of its own, so writers at the same moment don't share one.
    const temp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await NodeFS.mkdir(root, { recursive: true });
      await NodeFS.writeFile(temp, `${encodeListing(listing)}\n`, { mode: 0o600 });
      await NodeFS.rename(temp, target);
    } catch {
      await NodeFS.rm(temp, { force: true }).catch(() => undefined);
    }
  });

const readAcpRegistryListing = (root: string): Effect.Effect<AcpRegistryListing | null> =>
  Effect.promise(() =>
    NodeFS.readFile(NodePath.join(root, LISTING_FILE), "utf8").then(
      (raw) => Option.getOrNull(decodeListing(raw)),
      () => null,
    ),
  );

/** Text generation is left to the tested providers: what an untested agent would write is unknown. */
const noTextGeneration = (displayName: string): TextGenerationShape => {
  const refuse = (operation: TextGenerationError["operation"]) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: `${displayName} is a community agent and can't be used for writing titles, branch names or commit messages. Pick another agent for that in Settings.`,
      }),
    );
  return {
    generateCommitMessage: () => refuse("generateCommitMessage"),
    generatePrContent: () => refuse("generatePrContent"),
    generateBranchName: () => refuse("generateBranchName"),
    generateThreadTitle: () => refuse("generateThreadTitle"),
  };
};

export const AcpRegistryDriver: ProviderDriver<AcpRegistrySettings, AcpRegistryDriverEnv> = {
  driverKind: ACP_REGISTRY_DRIVER_KIND,
  metadata: {
    displayName: "Community agent",
    supportsMultipleInstances: true,
  },
  configSchema: AcpRegistrySettings,
  defaultConfig: () => decodeSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const agentId = input.config.agentId;
      if (!isAgentId(agentId)) {
        return yield* new ProviderDriverError({
          driver: ACP_REGISTRY_DRIVER_KIND,
          instanceId: input.instanceId,
          detail: "This community agent's settings are damaged. Remove it and add it again.",
        });
      }
      const displayName = input.displayName?.trim() || agentId;
      const context = acpRegistryAgentContext({
        stateDir: serverConfig.stateDir,
        agentId,
        displayName,
      });
      const listing = yield* readAcpRegistryListing(context.root);
      // Filled in once the instance exists: results that arrive off the
      // usual schedule ask for a fresh look at the status.
      let refresh: Effect.Effect<void> = Effect.void;
      const descriptorInput: AcpRegistryDescriptorInput = {
        agentId,
        displayName,
        agentRoot: context.root,
        installer: context.installer,
        state: context.state,
        instanceVariableNames: new Set(input.environment.map((variable) => variable.name)),
        listing,
        authMethodId: input.config.authMethodId,
        allowsEnvName,
        requestRefresh: Effect.suspend(() => refresh),
      };
      // A rebuild is a settings change: look at the agent again.
      context.state.checkRequested = true;
      // Leftovers of interrupted installs; best effort, off the start path.
      yield* Effect.forkDetach(context.installer.prune.pipe(Effect.ignore));

      const instance = yield* makeAcpProviderDriver(
        makeAcpRegistryDescriptor(descriptorInput),
      ).create(input);
      refresh = instance.snapshot.refresh.pipe(Effect.forkDetach, Effect.asVoid);

      const authFlows = makeAcpRegistryAuthFlows({
        displayName,
        agentRoot: context.root,
        installer: context.installer,
        state: context.state,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment),
        instanceVariableNames: descriptorInput.instanceVariableNames,
        allowsEnvName,
        childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        signInDescriptor: (purpose) => makeAcpRegistryDescriptor({ ...descriptorInput, purpose }),
        // Built per run: a closing gate stops sessions on every poll.
        stopSessions: Effect.suspend(() => instance.adapter.stopAll()).pipe(Effect.ignore),
      });
      return {
        ...instance,
        textGeneration: noTextGeneration(displayName),
        authFlows,
      };
    }),
};
