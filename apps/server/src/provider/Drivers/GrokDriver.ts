/**
 * GrokDriver — `ProviderDriver` for Grok Build (`grok agent stdio`).
 *
 * The generic ACP driver applied to the Grok descriptor, plus sign-in and
 * sign-out that run inside Grok's own process instead of a terminal.
 * Everything Grok-specific lives in `acp/GrokAcpSupport.ts`,
 * `acp/GrokAcpExtension.ts` and `grok/`.
 *
 * @module provider/Drivers/GrokDriver
 */
import { join } from "node:path";

import { GrokSettings } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { type AcpProviderDriverEnv, makeAcpProviderDriver } from "../acp/AcpProviderDriver.ts";
import { GROK_ACP_DESCRIPTOR } from "../acp/GrokAcpSupport.ts";
import { grokMainHome, materializeGrokAccountFolder } from "../grok/GrokAccountFolder.ts";
import { makeGrokAuthFlows } from "../grok/GrokAuth.ts";
import { ProviderDriverError } from "../Errors.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import type { ProviderDriver } from "../ProviderDriver.ts";

export type GrokDriverEnv = AcpProviderDriverEnv;

const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const acpDriver = makeAcpProviderDriver(GROK_ACP_DESCRIPTOR);

export const GrokDriver: ProviderDriver<GrokSettings, GrokDriverEnv> = {
  ...acpDriver,
  defaultConfig: () => decodeGrokSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const environment = mergeProviderInstanceEnvironment(input.environment);
      // Grok prefers a stored sign-in to an API key, so an instance billed by
      // key runs in a folder with no sign-in: one of its own, laid over the
      // main Grok folder like an account's (shared setup and sessions).
      const config =
        input.config.authMethod === "api-key" && !input.config.accountFolder.trim()
          ? {
              ...input.config,
              accountFolder: join(
                (yield* ServerConfig).stateDir,
                "grok",
                "api-key",
                input.instanceId,
              ),
            }
          : input.config;
      // An account folder is laid over the main Grok folder before anything
      // runs in it, so the first turn sees the user's setup and writes its
      // conversation where the main instance can resume it.
      const accountFolder = config.accountFolder.trim();
      if (accountFolder) {
        yield* materializeGrokAccountFolder({
          mainDir: grokMainHome(environment),
          accountDir: expandHomePath(accountFolder),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: GROK_ACP_DESCRIPTOR.driverKind,
                instanceId: input.instanceId,
                detail: cause.message,
                cause,
              }),
          ),
        );
      }
      const instance = yield* acpDriver.create({ ...input, config });
      return {
        ...instance,
        authFlows: makeGrokAuthFlows({
          descriptor: GROK_ACP_DESCRIPTOR,
          settings: { ...config, enabled: input.enabled },
          environment,
          childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
          fileSystem: yield* FileSystem.FileSystem,
        }),
      };
    }),
};
