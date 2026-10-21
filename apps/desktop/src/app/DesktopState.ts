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
   * Active scheduled tasks with a schedule on this computer's own server, as
   * the page last reported: they keep the computer awake when the user asked
   * for that, and quitting stops them.
   */
  readonly activeScheduledTaskCount: Ref.Ref<number>;
  /**
   * Windows and Linux: closing the window hides it to the tray instead of
   * quitting (Settings › General, "Keep running in the background").
   */
  readonly runInBackground: Ref.Ref<boolean>;
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
    activeScheduledTaskCount: Ref.make(0),
    runInBackground: Ref.make(false),
  }),
);
