import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface DesktopStateShape {
  readonly backendReady: Ref.Ref<boolean>;
  readonly quitting: Ref.Ref<boolean>;
  /**
   * Threads running on this computer's own server, as the page last reported.
   * Quitting stops only these, so they decide whether quitting or closing the
   * window asks first. Threads on other computers never count here.
   */
  readonly localRunningThreadCount: Ref.Ref<number>;
  /**
   * Terminals on this computer's own server running a command, as the page
   * last reported. Quitting stops them too, so they also make it ask.
   */
  readonly localBusyTerminalCount: Ref.Ref<number>;
}

export class DesktopState extends Context.Service<DesktopState, DesktopStateShape>()(
  "threadlines/desktop/State",
) {}

export const layer = Layer.effect(
  DesktopState,
  Effect.all({
    backendReady: Ref.make(false),
    quitting: Ref.make(false),
    localRunningThreadCount: Ref.make(0),
    localBusyTerminalCount: Ref.make(0),
  }),
);
