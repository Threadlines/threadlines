/**
 * Which access level a chat actually runs at.
 *
 * A thread keeps the level its user chose, so a chat that moves to another
 * agent or model takes that choice along. An agent that lacks the level (Pi
 * has no Auto, Grok no Auto-accept edits, older Claude models no Auto) runs
 * at the next safer level it has, never a more permissive one. Drivers apply
 * this rule when they launch, and the composer shows its result, so what the
 * chat says it runs at is what the agent does.
 *
 * @module runtimeMode
 */
import { LEGACY_RUNTIME_MODES, RUNTIME_MODES, type RuntimeMode } from "@threadlines/contracts";

/** What each access level is called wherever the user sees or picks it. */
export const RUNTIME_MODE_LABELS: Readonly<Record<RuntimeMode, string>> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

/**
 * The level from `supported` that a chat set to `requested` runs at: the
 * chosen one, else the nearest safer one. Supervised when `supported` has
 * nothing that safe (every agent offers Supervised, so none today).
 */
export function effectiveRuntimeMode<Mode extends RuntimeMode>(
  requested: RuntimeMode,
  supported: ReadonlyArray<Mode>,
): Mode | "approval-required" {
  const rank = RUNTIME_MODES.indexOf(requested);
  for (const candidate of RUNTIME_MODES.slice(0, rank + 1).reverse()) {
    const match = supported.find((mode) => mode === candidate);
    if (match !== undefined) return match;
  }
  return "approval-required";
}

/**
 * The level an agent runs at when its chat asks for `requested`: what its
 * driver supports (`providerModes`, absent: the three legacy levels),
 * narrowed by its model's own list (`modelModes`, absent: all of them).
 */
export function runtimeModeOnAgent(input: {
  readonly requested: RuntimeMode;
  readonly providerModes: ReadonlyArray<RuntimeMode> | undefined;
  readonly modelModes: ReadonlyArray<RuntimeMode> | undefined;
}): RuntimeMode {
  const driver = input.providerModes ?? LEGACY_RUNTIME_MODES;
  const supported =
    input.modelModes === undefined
      ? driver
      : driver.filter((mode) => input.modelModes?.includes(mode) === true);
  return effectiveRuntimeMode(input.requested, supported);
}

/** Whether `mode` lets an agent do more than `ceiling` does. */
export const exceedsRuntimeMode = (mode: RuntimeMode, ceiling: RuntimeMode): boolean =>
  RUNTIME_MODES.indexOf(mode) > RUNTIME_MODES.indexOf(ceiling);

/** The safer of two levels: never more access than either allows. */
export const saferRuntimeMode = (left: RuntimeMode, right: RuntimeMode): RuntimeMode =>
  exceedsRuntimeMode(left, right) ? right : left;
