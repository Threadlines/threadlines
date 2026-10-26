/**
 * The data-sharing choice for providers whose plan trades training data for
 * usage (Muse Code's Contributor mode). The choice lives in the provider's own
 * settings, so it also changes the provider in the user's terminal; the
 * server applies it to new messages.
 *
 * @module ProviderDataSharing
 */
import type { ServerProvider } from "@threadlines/contracts";
import { useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { failureNotice, toastManager } from "../ui/toast";

const DATA_SHARING_LABEL = "Share chats for training";
const DATA_SHARING_DESCRIPTION =
  "On, Meta may train its models on your Muse chats and your plan lasts longer. Off, your chats stay out of training and use your plan up faster.";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Threadlines could not save the choice in Muse's settings.";
}

/** Saves the choice; the switch shows it until the server has answered. */
function useDataSharing(provider: ServerProvider) {
  const sharing = provider.dataSharing;
  const [pending, setPending] = useState<boolean | null>(null);
  const save = async (enabled: boolean) => {
    setPending(enabled);
    try {
      await ensureLocalApi().server.setProviderDataSharing({
        instanceId: provider.instanceId,
        enabled,
      });
    } catch (error: unknown) {
      toastManager.add(
        failureNotice({
          title: "Couldn't save the data-sharing choice",
          reason: errorMessage(error),
        }),
      );
    } finally {
      setPending(null);
    }
  };
  return { sharing, checked: pending ?? sharing?.enabled ?? false, busy: pending !== null, save };
}

/** The switch on the provider's Account tab. */
export function ProviderDataSharingSwitch({
  provider,
  className,
}: {
  readonly provider: ServerProvider;
  readonly className?: string;
}) {
  const { sharing, checked, busy, save } = useDataSharing(provider);
  if (!sharing) return null;
  return (
    <div className={cn("flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <span className="text-xs font-medium text-foreground">{DATA_SHARING_LABEL}</span>
        <span className="mt-1 block text-xs text-muted-foreground">{DATA_SHARING_DESCRIPTION}</span>
        {sharing.error ? (
          <span className="mt-1 block text-xs text-destructive">{sharing.error}</span>
        ) : (
          <span className="mt-1 block text-xs text-muted-foreground">
            The same setting as Muse in your terminal.
          </span>
        )}
      </div>
      <Switch
        checked={checked}
        disabled={busy || sharing.error !== undefined}
        onCheckedChange={(next) => void save(Boolean(next))}
        aria-label={DATA_SHARING_LABEL}
      />
    </div>
  );
}

/**
 * The choice on the setup screen, shown until the user has made it (here or
 * in Muse's own app): the switch, and a button to keep the current setting.
 */
export function ProviderDataSharingSetupChoice({
  provider,
}: {
  readonly provider: ServerProvider;
}) {
  const { sharing, checked, busy, save } = useDataSharing(provider);
  if (!sharing || sharing.acknowledged || sharing.error) return null;
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <span className="text-xs font-medium text-foreground">{DATA_SHARING_LABEL}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {DATA_SHARING_DESCRIPTION}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Switch
          checked={checked}
          disabled={busy}
          onCheckedChange={(next) => void save(Boolean(next))}
          aria-label={DATA_SHARING_LABEL}
        />
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void save(checked)}>
          Done
        </Button>
      </div>
    </div>
  );
}
