/**
 * AntigravityDriver — `ProviderDriver` for Google Antigravity.
 *
 * The generic ACP driver applied to a descriptor built per instance: each
 * instance has its own profile (`GEMINI_HOME`) and temp root, and all of them
 * share one managed runtime under Threadlines' state dir. Everything
 * Antigravity-specific lives in `acp/AntigravityAcpSupport.ts`.
 *
 * @module provider/Drivers/AntigravityDriver
 */
import { join } from "node:path";

import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import {
  ANTIGRAVITY_DRIVER_KIND,
  ANTIGRAVITY_PRESENTATION,
  makeAntigravityDescriptor,
  validateAntigravityRuntime,
} from "../acp/AntigravityAcpSupport.ts";
import { type AcpProviderDriverEnv, makeAcpProviderDriver } from "../acp/AcpProviderDriver.ts";
import { antigravityReleaseFor } from "../antigravity/AntigravityRelease.ts";
import { makeAntigravityAuthFlows } from "../antigravity/AntigravityAuth.ts";
import {
  antigravityInstancePaths,
  sweepAntigravityTempRoot,
} from "../antigravity/AntigravityProfile.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  type AntigravityRuntime,
  makeAntigravityRuntime,
} from "../antigravity/AntigravityRuntime.ts";
import type { ProviderDriver } from "../ProviderDriver.ts";
import { AntigravitySettings } from "@threadlines/contracts";
import * as Schema from "effect/Schema";

export type AntigravityDriverEnv = AcpProviderDriverEnv;

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);

/**
 * One runtime per install root in this process, shared by every instance:
 * its locks then serialize their installs, prunes, and leases.
 */
const runtimesByRoot = new Map<string, AntigravityRuntime>();

export const AntigravityDriver: ProviderDriver<AntigravitySettings, AntigravityDriverEnv> = {
  driverKind: ANTIGRAVITY_DRIVER_KIND,
  metadata: {
    displayName: ANTIGRAVITY_PRESENTATION.displayName,
    supportsMultipleInstances: true,
  },
  configSchema: AntigravitySettings,
  defaultConfig: () => decodeAntigravitySettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const paths = antigravityInstancePaths(serverConfig.stateDir, input.instanceId);
      const platformRelease = antigravityReleaseFor(process.platform, process.arch);
      const runtimeRoot = platformRelease
        ? join(serverConfig.stateDir, "tools", "agy", platformRelease.assetKey)
        : undefined;
      let runtime = runtimeRoot ? runtimesByRoot.get(runtimeRoot) : undefined;
      if (platformRelease && runtimeRoot && !runtime) {
        runtime = makeAntigravityRuntime({
          root: runtimeRoot,
          release: platformRelease,
          validate: (runtimePaths) => validateAntigravityRuntime(runtimePaths, platformRelease),
        });
        runtimesByRoot.set(runtimeRoot, runtime);
      }
      // Leftovers of processes whose server is gone; best effort, off the
      // start path.
      yield* Effect.forkDetach(
        sweepAntigravityTempRoot(paths.tempRoot).pipe(
          Effect.andThen(runtime ? runtime.prune : Effect.void),
          Effect.ignore,
        ),
      );
      // Sign-in and sign-out close the instance while they run; their own
      // process starts from a descriptor that ignores the gate.
      const gate = { busy: false, holds: 0 };
      const descriptor = makeAntigravityDescriptor({
        paths,
        runtime,
        release: platformRelease,
        gate,
      });
      const instance = yield* makeAcpProviderDriver(descriptor).create(input);
      return {
        ...instance,
        authFlows: makeAntigravityAuthFlows({
          descriptor: makeAntigravityDescriptor({ paths, runtime, release: platformRelease }),
          settings: { ...input.config, enabled: input.enabled },
          environment: mergeProviderInstanceEnvironment(input.environment),
          childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
          profileDir: paths.profileDir,
          gate,
          // Built per run: the drain stops sessions on every poll.
          stopSessions: Effect.suspend(() => instance.adapter.stopAll()).pipe(Effect.ignore),
        }),
      };
    }),
};
