/**
 * The composer notice for a thread whose model its provider is retiring. It
 * names the date and offers the provider's replacement, switched the same way
 * as picking it from the model picker.
 *
 * @module modelRetirementNotice
 */
import type { ServerProviderModel } from "@threadlines/contracts";
import { useEffect, useState } from "react";

import { readModelRetirement, retirementRecheckDelayMs } from "~/modelRetirement";
import { Button } from "../ui/button";
import type { ComposerNotice } from "./composerNotices";

export function useModelRetirementNotice(input: {
  /** The model the next message goes to; null when it isn't this composer's
   *  own pick (a room message addressed to another agent). */
  readonly model: ServerProviderModel | null;
  /** The picker's options for the same instance. */
  readonly pickable: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
  readonly onSwitch: (slug: string) => void;
}): ComposerNotice | null {
  const { model, pickable, onSwitch } = input;
  // "Not now" hides the row for this model until it retires or the composer
  // remounts; the picker row keeps showing the date.
  const [dismissedSlug, setDismissedSlug] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const retirement = model ? readModelRetirement(model, pickable, nowMs) : null;
  const retiresAtMs = retirement?.retiresAtMs ?? null;

  // Re-read the clock just after the deadline, so a composer left open flips
  // to "was retired", and right away when the stored time is behind it (the
  // model came back into view after the date passed).
  useEffect(() => {
    if (retiresAtMs === null) {
      return;
    }
    const delayMs =
      retirementRecheckDelayMs(retiresAtMs, Date.now()) ?? (nowMs < retiresAtMs ? 0 : null);
    if (delayMs === null) {
      return;
    }
    const timeoutId = window.setTimeout(() => setNowMs(Date.now()), delayMs);
    return () => window.clearTimeout(timeoutId);
  }, [nowMs, retiresAtMs]);

  if (!model || !retirement || (!retirement.retired && dismissedSlug === model.slug)) {
    return null;
  }
  const { replacement } = retirement;
  return {
    id: `model-retirement:${model.slug}`,
    severity: retirement.retired ? "warning" : "info",
    lead: retirement.retired
      ? `${model.name} was retired ${retirement.dateLabel}.`
      : `${model.name} retires ${retirement.dateLabel}.`,
    detail: replacement
      ? retirement.retired
        ? "Switch models to keep working."
        : "It stops working after that."
      : "Pick another model to keep working.",
    ...(replacement
      ? {
          actions: (
            <Button size="xs" variant="outline" onClick={() => onSwitch(replacement.slug)}>
              Switch to {replacement.name}
            </Button>
          ),
        }
      : {}),
    ...(retirement.retired
      ? {}
      : { dismissLabel: "Not now", onDismiss: () => setDismissedSlug(model.slug) }),
  };
}
