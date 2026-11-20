import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { VcsDriverKind, type VcsDriverKind as VcsDriverKindType } from "@threadlines/contracts";

const ProjectVcsConfig = Schema.Struct({
  vcs: Schema.optional(
    Schema.Struct({
      kind: Schema.optional(VcsDriverKind),
    }),
  ),
  vcsKind: Schema.optional(VcsDriverKind),
});
const isProjectVcsConfig = Schema.is(ProjectVcsConfig);

interface ProjectVcsConfigFile {
  readonly vcs?:
    | {
        readonly kind?: VcsDriverKindType | undefined;
      }
    | undefined;
  readonly vcsKind?: VcsDriverKindType | undefined;
}

export interface VcsProjectConfigResolveInput {
  readonly cwd: string;
  readonly requestedKind?: VcsDriverKindType | "auto";
}

export interface VcsProjectConfigShape {
  readonly resolveKind: (
    input: VcsProjectConfigResolveInput,
  ) => Effect.Effect<VcsDriverKindType | "auto">;
}

export class VcsProjectConfig extends Context.Service<VcsProjectConfig, VcsProjectConfigShape>()(
  "threadlines/vcs/VcsProjectConfig",
) {}

const PROJECT_VCS_CONFIG_DIR_NAMES = [".threadlines", ".t3code"] as const;

function configuredKind(config: ProjectVcsConfigFile): VcsDriverKindType | "auto" {
  return config.vcs?.kind ?? config.vcsKind ?? "auto";
}

function parseConfig(raw: string): ProjectVcsConfigFile | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isProjectVcsConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export const make = Effect.fn("makeVcsProjectConfig")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  /**
   * The nearest `vcs.json` at or above `cwd`. Every candidate up to the root
   * is checked side by side (each check waits its turn on a busy server). The
   * answer comes as soon as the nearest existing one is known, so a stalled
   * check further up (an unreachable network mount) doesn't hold it.
   */
  const findConfigPath = Effect.fn("VcsProjectConfig.findConfigPath")(function* (cwd: string) {
    const candidates: Array<string> = [];
    let current = cwd;
    while (true) {
      for (const directoryName of PROJECT_VCS_CONFIG_DIR_NAMES) {
        candidates.push(path.join(current, directoryName, "vcs.json"));
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    const checks = yield* Effect.forEach(candidates, (candidate) =>
      Effect.forkChild(fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))),
    );
    for (const [index, check] of checks.entries()) {
      if (yield* Fiber.join(check)) {
        yield* Fiber.interruptAll(checks.slice(index + 1));
        return candidates[index] ?? null;
      }
    }
    return null;
  });

  const readConfiguredKind = Effect.fn("VcsProjectConfig.readConfiguredKind")(function* (
    configPath: string,
  ) {
    const raw = yield* fileSystem.readFileString(configPath).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to read VCS project config", {
          configPath,
          error,
        }).pipe(Effect.as(null)),
      ),
    );
    if (raw === null) {
      return "auto" as const;
    }

    const parsed = parseConfig(raw);
    if (parsed === null) {
      yield* Effect.logWarning("invalid VCS project config", {
        configPath,
      });
      return "auto" as const;
    }

    return configuredKind(parsed);
  });

  const resolveKind: VcsProjectConfigShape["resolveKind"] = Effect.fn(
    "VcsProjectConfig.resolveKind",
  )(function* (input) {
    if (input.requestedKind !== undefined && input.requestedKind !== "auto") {
      return input.requestedKind;
    }

    const configPath = yield* findConfigPath(input.cwd);
    if (configPath === null) {
      return "auto";
    }

    return yield* readConfiguredKind(configPath);
  });

  return VcsProjectConfig.of({
    resolveKind,
  });
});

export const layer = Layer.effect(VcsProjectConfig, make());
