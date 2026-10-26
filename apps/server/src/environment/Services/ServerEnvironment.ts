import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

/**
 * This computer as clients and linked computers see it. Its name follows the
 * `computerName` setting, so read it when it is needed: a copy taken when a
 * service starts goes stale after a rename.
 */
export interface ServerEnvironmentShape {
  readonly getEnvironmentId: Effect.Effect<EnvironmentId>;
  readonly getDescriptor: Effect.Effect<ExecutionEnvironmentDescriptor>;
  /** The computer's name right now, for text written outside an effect. */
  readonly currentLabel: () => string;
  /**
   * The descriptor for a given `computerName` setting: what a reader holding
   * that settings value must send, so its descriptor and settings agree.
   */
  readonly describe: (computerName: string | null) => ExecutionEnvironmentDescriptor;
  /** The descriptor each time the computer's name changes. */
  readonly labelChanges: Stream.Stream<ExecutionEnvironmentDescriptor>;
}

export class ServerEnvironment extends Context.Service<ServerEnvironment, ServerEnvironmentShape>()(
  "threadlines/environment/Services/ServerEnvironment",
) {
  /**
   * A computer whose name never changes, for tests. What isn't given is a
   * Mac called "Test computer".
   */
  static readonly layerTest = (descriptor: Partial<ExecutionEnvironmentDescriptor> = {}) => {
    const fixed: ExecutionEnvironmentDescriptor = {
      environmentId: EnvironmentId.make("env-test"),
      label: "Test computer",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0",
      capabilities: { repositoryIdentity: true },
      ...descriptor,
    };
    return Layer.succeed(ServerEnvironment, {
      getEnvironmentId: Effect.succeed(fixed.environmentId),
      getDescriptor: Effect.succeed(fixed),
      currentLabel: () => fixed.label,
      describe: (computerName) => ({
        ...fixed,
        label: computerName ?? fixed.systemLabel ?? fixed.label,
      }),
      labelChanges: Stream.never,
    });
  };
}
