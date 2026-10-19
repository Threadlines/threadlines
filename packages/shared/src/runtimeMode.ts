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
import { RUNTIME_MODES, type RuntimeMode } from "@threadlines/contracts";

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
