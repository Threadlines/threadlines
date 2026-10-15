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
import { GrokSettings } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { type AcpProviderDriverEnv, makeAcpProviderDriver } from "../acp/AcpProviderDriver.ts";
import { GROK_ACP_DESCRIPTOR } from "../acp/GrokAcpSupport.ts";
import { makeGrokAuthFlows } from "../grok/GrokAuth.ts";
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
      const instance = yield* acpDriver.create(input);
      return {
        ...instance,
        authFlows: makeGrokAuthFlows({
          descriptor: GROK_ACP_DESCRIPTOR,
          settings: { ...input.config, enabled: input.enabled },
          environment: mergeProviderInstanceEnvironment(input.environment),
          childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
          fileSystem: yield* FileSystem.FileSystem,
        }),
      };
    }),
};
