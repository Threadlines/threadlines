// @effect-diagnostics globalTimers:off - The stream owns this browser control queue and its timeout.
/**
 * iPhone Duo hinge and stance commands (docs/design/devices.md, "Round 2").
 * Ported from T3 Code's duoControl.ts (MIT, see NOTICE) without the pinch
 * gesture of its 3D view. Commands travel as tagged messages on the iOS input
 * socket; one waits for the helper's reply at a time, and a newer one replaces
 * any still queued.
 */
import type { DeviceOrientationName, DeviceScreenSize } from "./stream.ts";

/** serve-sim's hinge presets (`closed` 0°, `book` and `laptop` 90°, `tent` 80°, `open` 180°). */
export type DuoPose = "closed" | "book" | "open" | "laptop" | "tent";
export const DUO_POSES: ReadonlyArray<DuoPose> = ["closed", "book", "open", "laptop", "tent"];

export type DuoCommand =
  | { readonly control: "angle"; readonly value: number }
  | { readonly control: "pose"; readonly value: DuoPose }
  | { readonly control: "table"; readonly value: boolean }
  | { readonly control: "physical"; readonly value: "faceup" | "facedown" }
  | { readonly control: "orientation"; readonly value: DeviceOrientationName };

export interface DuoControlState {
  /** A command was sent and its reply has not come back. */
  readonly pending: boolean;
  /** The command waiting or in flight, newest first. */
  readonly requested: DuoCommand | null;
  readonly error: string | null;
}

export const IDLE_DUO_CONTROL: DuoControlState = { pending: false, requested: null, error: null };

/** The two Duo displays serve-sim names: 1 the cover, 3 the inner screen. */
export type DuoPanelId = 1 | 3;

/** The display that is in front, from the helper's screen config. */
export const duoActivePanel = (screen: Pick<DeviceScreenSize, "screenId">): DuoPanelId =>
  screen.screenId === 1 ? 1 : 3;

/** The hinge angle the helper reports, or the one its display implies. */
export const duoHingeAngle = (screen: Pick<DeviceScreenSize, "screenId" | "hingeAngle">) =>
  screen.hingeAngle ?? (screen.screenId === 1 ? 0 : 180);

/**
 * The stance shown as chosen: the helper's preset, else the fold its angle is
 * at (a stance it set by angle alone has no preset).
 */
export function duoPose(
  screen: Pick<DeviceScreenSize, "screenId" | "hingeAngle" | "hingePose">,
): DuoPose | null {
  if (screen.hingePose) return screen.hingePose;
  const angle = duoHingeAngle(screen);
  return angle === 0 ? "closed" : angle === 180 ? "open" : null;
}

/**
 * Which displays a flat view shows: the cover alone when closed, the inner
 * screen alone when open, and both when the hinge is part way, where the
 * phone shows a screen on each side.
 */
export function duoVisiblePanels(
  screen: Pick<DeviceScreenSize, "screenId" | "hingeAngle">,
): ReadonlyArray<DuoPanelId> {
  const angle = duoHingeAngle(screen);
  if (angle <= 0) return [1];
  if (angle >= 180) return [3];
  return [1, 3];
}

/**
 * Sends one command at a time and waits for its reply; a command given while
 * one is in flight replaces any still queued. A reply that never comes clears
 * the queue after `timeoutMs` with an error.
 */
export function createDuoControl(options: {
  readonly send: (request: { readonly requestId: number; readonly command: DuoCommand }) => boolean;
  readonly onChange: (state: DuoControlState) => void;
  readonly timeoutMs?: number;
}) {
  let nextId = 1;
  let active: { readonly requestId: number; readonly command: DuoCommand } | null = null;
  let queued: DuoCommand | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const publish = (error: string | null = null) =>
    options.onChange({ pending: !!active, requested: queued ?? active?.command ?? null, error });
  const clear = (error: string | null = null) => {
    if (timer) clearTimeout(timer);
    timer = null;
    active = null;
    queued = null;
    publish(error);
  };
  const drain = () => {
    if (active || !queued) return;
    active = { requestId: nextId++, command: queued };
    queued = null;
    const id = active.requestId;
    timer = setTimeout(() => {
      if (active?.requestId === id) clear("The device did not answer. Its stance is unknown.");
    }, options.timeoutMs ?? 5_000);
    publish();
    if (!options.send(active)) clear("The device is disconnected.");
  };
  return {
    enqueue(command: DuoCommand) {
      if (
        command.control === "angle" &&
        (!Number.isFinite(command.value) || command.value < 0 || command.value > 180)
      )
        return;
      queued = command;
      if (active) publish();
      else drain();
    },
    receive(reply: { readonly requestId: number; readonly ok: boolean; readonly error?: string }) {
      if (!active || reply.requestId !== active.requestId) return;
      if (timer) clearTimeout(timer);
      timer = null;
      active = null;
      if (!reply.ok) {
        clear(reply.error ?? "The device refused. Its stance is unknown.");
        return;
      }
      if (queued) drain();
      else publish();
    },
    /** The request in flight, to settle an orientation change the screen config confirms. */
    get activeRequestId() {
      return active?.requestId ?? null;
    },
    clear,
  };
}

export type DuoControl = ReturnType<typeof createDuoControl>;
