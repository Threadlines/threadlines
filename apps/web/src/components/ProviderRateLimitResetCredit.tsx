"use client";

import { useCallback, type ReactNode, useState } from "react";
import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderRateLimitResetCreditOutcome,
} from "@threadlines/contracts";

import { ensureLocalApi } from "../localApi";
import { randomUUID } from "../lib/utils";
import { Button } from "./ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { toastManager } from "./ui/toast";

export const RATE_LIMIT_RESET_CREDIT_PROVIDER_DRIVER = ProviderDriverKind.make("codex");

export type ProviderRateLimitResetCreditRequest = {
  readonly instanceId: ProviderInstanceId;
  readonly availableCount: number;
};

type ProviderRateLimitResetCreditToast = {
  readonly type: "success" | "info" | "warning";
  readonly title: string;
  readonly description?: string;
};

function unknownErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function canRequestProviderRateLimitResetCredit(
  provider: Pick<ServerProvider, "driver"> | null | undefined,
  availableCount: number | null | undefined,
): boolean {
  return (
    provider?.driver === RATE_LIMIT_RESET_CREDIT_PROVIDER_DRIVER &&
    Number.isInteger(availableCount) &&
    (availableCount ?? 0) > 0
  );
}

export function formatProviderRateLimitResetCreditConfirmation(availableCount: number): string {
  const creditLabel =
    availableCount === 1 ? "your reset credit" : `1 of your ${availableCount} reset credits`;
  return `This spends ${creditLabel} and refreshes your current Codex rate-limit windows so you can keep working. This cannot be undone.`;
}

export function toastForProviderRateLimitResetCreditOutcome(
  outcome: ServerProviderRateLimitResetCreditOutcome,
): ProviderRateLimitResetCreditToast {
  switch (outcome) {
    case "reset":
      return {
        type: "success",
        title: "Codex usage reset",
        description: "Your Codex rate-limit windows were refreshed.",
      };
    case "nothingToReset":
      return {
        type: "info",
        title: "Nothing to reset",
        description: "Codex did not find an active usage limit to reset.",
      };
    case "noCredit":
      return {
        type: "warning",
        title: "No reset credit available",
      };
    case "alreadyRedeemed":
      return {
        type: "info",
        title: "Reset already applied",
      };
  }
}

export function ProviderRateLimitResetCreditDialog(props: {
  readonly pendingReset: ProviderRateLimitResetCreditRequest | null;
  readonly isResetting: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}) {
  return (
    <AlertDialog open={props.pendingReset !== null} onOpenChange={props.onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Reset Codex usage?</AlertDialogTitle>
          <AlertDialogDescription>
            {formatProviderRateLimitResetCreditConfirmation(
              props.pendingReset?.availableCount ?? 0,
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose
            render={<Button type="button" variant="outline" disabled={props.isResetting} />}
          >
            Cancel
          </AlertDialogClose>
          <Button type="button" onClick={props.onConfirm} disabled={props.isResetting}>
            {props.isResetting ? "Resetting" : "Reset usage"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

export function useProviderRateLimitResetCredit(): {
  readonly pendingRateLimitResetCredit: ProviderRateLimitResetCreditRequest | null;
  readonly isConsumingRateLimitResetCredit: boolean;
  readonly requestRateLimitResetCredit: (request: ProviderRateLimitResetCreditRequest) => void;
  readonly rateLimitResetCreditDialog: ReactNode;
} {
  const [pendingRateLimitResetCredit, setPendingRateLimitResetCredit] =
    useState<ProviderRateLimitResetCreditRequest | null>(null);
  const [isConsumingRateLimitResetCredit, setIsConsumingRateLimitResetCredit] = useState(false);

  const requestRateLimitResetCredit = useCallback(
    (request: ProviderRateLimitResetCreditRequest) => {
      setPendingRateLimitResetCredit(request);
    },
    [],
  );

  const handleDialogOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !isConsumingRateLimitResetCredit) {
        setPendingRateLimitResetCredit(null);
      }
    },
    [isConsumingRateLimitResetCredit],
  );

  const confirmRateLimitResetCredit = useCallback(async () => {
    const pendingReset = pendingRateLimitResetCredit;
    if (!pendingReset || isConsumingRateLimitResetCredit) return;

    setIsConsumingRateLimitResetCredit(true);
    try {
      const result = await ensureLocalApi().server.consumeProviderRateLimitResetCredit({
        instanceId: pendingReset.instanceId,
        idempotencyKey: randomUUID(),
      });
      toastManager.add(toastForProviderRateLimitResetCreditOutcome(result.outcome));
      setPendingRateLimitResetCredit(null);
    } catch (error: unknown) {
      toastManager.add({
        type: "error",
        title: "Usage reset failed",
        description: unknownErrorMessage(error, "Codex could not reset usage right now."),
      });
    } finally {
      setIsConsumingRateLimitResetCredit(false);
    }
  }, [isConsumingRateLimitResetCredit, pendingRateLimitResetCredit]);

  return {
    pendingRateLimitResetCredit,
    isConsumingRateLimitResetCredit,
    requestRateLimitResetCredit,
    rateLimitResetCreditDialog: (
      <ProviderRateLimitResetCreditDialog
        pendingReset={pendingRateLimitResetCredit}
        isResetting={isConsumingRateLimitResetCredit}
        onOpenChange={handleDialogOpenChange}
        onConfirm={confirmRateLimitResetCredit}
      />
    ),
  };
}
