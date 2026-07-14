"use client";

import { useCallback, type ReactNode, useState } from "react";
import { ClockIcon, TimerResetIcon } from "lucide-react";
import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderRateLimitResetCredit,
  type ServerProviderRateLimitResetCredits,
  type ServerProviderRateLimitResetCreditOutcome,
} from "@threadlines/contracts";

import { ensureLocalApi } from "../localApi";
import { providerRateLimitResetCreditExpirationUrgency } from "../lib/providerUsage";
import { cn, randomUUID } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";

export const RATE_LIMIT_RESET_CREDIT_PROVIDER_DRIVER = ProviderDriverKind.make("codex");

export type ProviderRateLimitResetCreditRequest = {
  readonly instanceId: ProviderInstanceId;
  readonly resetCredits: ServerProviderRateLimitResetCredits;
};

type PendingProviderRateLimitResetCreditRequest = ProviderRateLimitResetCreditRequest & {
  readonly openedAtMs: number;
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

export function formatProviderRateLimitResetCreditTooltip(availableCount: number): string {
  const creditLabel =
    availableCount === 1 ? "your reset credit" : `1 of your ${availableCount} reset credits`;
  return `Use ${creditLabel} to refresh the current Codex 5h and weekly usage windows.`;
}

function normalizeResetCreditTimestampMs(timestamp: number): number {
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

const RESET_CREDIT_MINUTE_MS = 60_000;
const RESET_CREDIT_HOUR_MS = 60 * RESET_CREDIT_MINUTE_MS;
const RESET_CREDIT_DAY_MS = 24 * RESET_CREDIT_HOUR_MS;

export function formatProviderRateLimitResetCreditDate(
  timestamp: number,
  locale?: string,
  timeZone?: string,
): string {
  const date = new Date(normalizeResetCreditTimestampMs(timestamp));
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

export function formatProviderRateLimitResetCreditRelativeExpiration(
  timestamp: number,
  nowMs = Date.now(),
  locale?: string,
): string {
  const remainingMs = normalizeResetCreditTimestampMs(timestamp) - nowMs;
  if (remainingMs <= 0) return "expired";

  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
    remainingMs < RESET_CREDIT_HOUR_MS
      ? [Math.ceil(remainingMs / RESET_CREDIT_MINUTE_MS), "minute"]
      : remainingMs < RESET_CREDIT_DAY_MS
        ? [Math.ceil(remainingMs / RESET_CREDIT_HOUR_MS), "hour"]
        : [Math.ceil(remainingMs / RESET_CREDIT_DAY_MS), "day"];
  return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(value, unit);
}

export function sortProviderRateLimitResetCreditsByExpiration(
  credits: ReadonlyArray<ServerProviderRateLimitResetCredit>,
): ReadonlyArray<ServerProviderRateLimitResetCredit> {
  return [...credits].sort((a, b) => {
    const aExpiresAtMs =
      a.expiresAt === undefined
        ? Number.POSITIVE_INFINITY
        : normalizeResetCreditTimestampMs(a.expiresAt);
    const bExpiresAtMs =
      b.expiresAt === undefined
        ? Number.POSITIVE_INFINITY
        : normalizeResetCreditTimestampMs(b.expiresAt);
    return aExpiresAtMs - bExpiresAtMs;
  });
}

function providerRateLimitResetCreditStatusLabel(
  credit: ServerProviderRateLimitResetCredit,
  nowMs: number,
): string {
  if (
    credit.expiresAt !== undefined &&
    normalizeResetCreditTimestampMs(credit.expiresAt) <= nowMs
  ) {
    return "Expired";
  }

  switch (credit.status) {
    case "available":
      return "Available";
    case "redeeming":
      return "Redeeming";
    case "redeemed":
      return "Redeemed";
    case "unknown":
      return "Unavailable";
  }
}

export function canUseProviderRateLimitResetCredit(
  credit: ServerProviderRateLimitResetCredit,
  nowMs = Date.now(),
): boolean {
  return (
    credit.status === "available" &&
    (credit.expiresAt === undefined || normalizeResetCreditTimestampMs(credit.expiresAt) > nowMs)
  );
}

export function isProviderUsageLimitErrorMessage(message: string | null | undefined): boolean {
  const normalized = message?.trim().toLowerCase();
  if (!normalized) return false;

  return (
    normalized.includes("usage limit") ||
    normalized.includes("usagelimitexceeded") ||
    normalized.includes("usage limited") ||
    normalized.includes("rate limit reached") ||
    normalized.includes("rate limit exceeded")
  );
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
  readonly pendingReset: PendingProviderRateLimitResetCreditRequest | null;
  readonly isResetting: boolean;
  readonly resettingCreditId: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onUseCredit: (creditId?: string) => void;
}) {
  const resetCredits = props.pendingReset?.resetCredits;
  const detailedCredits = sortProviderRateLimitResetCreditsByExpiration(
    resetCredits?.credits ?? [],
  );
  const additionalCreditCount = Math.max(
    0,
    (resetCredits?.availableCount ?? 0) - detailedCredits.length,
  );
  const nowMs = props.pendingReset?.openedAtMs ?? 0;
  const recommendedCreditId = detailedCredits.find((credit) =>
    canUseProviderRateLimitResetCredit(credit, nowMs),
  )?.id;

  return (
    <Dialog open={props.pendingReset !== null} onOpenChange={props.onOpenChange}>
      <DialogPopup
        className="max-h-[min(86dvh,42rem)] max-w-xl"
        showCloseButton={!props.isResetting}
      >
        <DialogHeader>
          <DialogTitle>Codex usage resets</DialogTitle>
          <DialogDescription>
            {resetCredits?.availableCount === 1
              ? "1 reset is available. Choose it to refresh your current Codex usage windows."
              : `${resetCredits?.availableCount ?? 0} resets are available. Choose one to refresh your current Codex usage windows.`}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <div className="divide-y divide-border/60 overflow-hidden rounded-xl border bg-background/50">
            {detailedCredits.map((credit) => {
              const canUse = canUseProviderRateLimitResetCredit(credit, nowMs);
              const isThisCreditResetting =
                props.isResetting && props.resettingCreditId === credit.id;
              const statusLabel = providerRateLimitResetCreditStatusLabel(credit, nowMs);
              const urgency = providerRateLimitResetCreditExpirationUrgency(
                credit.expiresAt,
                nowMs,
              );
              const expirationDateLabel =
                credit.expiresAt === undefined
                  ? "Does not expire"
                  : `Expires ${formatProviderRateLimitResetCreditDate(credit.expiresAt)}`;
              return (
                <section
                  className="flex min-w-0 items-center justify-between gap-4 px-4 py-3"
                  key={credit.id}
                >
                  <div
                    aria-hidden="true"
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-lg",
                      !canUse
                        ? "bg-muted text-muted-foreground"
                        : urgency === "critical"
                          ? "bg-destructive/10 text-destructive"
                          : urgency === "soon"
                            ? "bg-warning/12 text-warning"
                            : "bg-primary/10 text-primary",
                    )}
                  >
                    <TimerResetIcon className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <h3 className="truncate font-medium text-sm">
                        {credit.title ?? "Full Codex usage reset"}
                      </h3>
                      {credit.expiresAt === undefined ? null : (
                        <Badge
                          size="sm"
                          variant={
                            urgency === "expired" || urgency === "critical"
                              ? "error"
                              : urgency === "soon"
                                ? "warning"
                                : "outline"
                          }
                        >
                          <ClockIcon />
                          {urgency === "expired"
                            ? "Expired"
                            : formatProviderRateLimitResetCreditRelativeExpiration(
                                credit.expiresAt,
                                nowMs,
                              )}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-muted-foreground text-xs">
                      {expirationDateLabel}
                      {statusLabel === "Available" ? null : ` · ${statusLabel}`}
                    </p>
                  </div>
                  <Button
                    className="shrink-0"
                    type="button"
                    size="sm"
                    variant={credit.id === recommendedCreditId ? "default" : "outline"}
                    disabled={props.isResetting || !canUse}
                    onClick={() => props.onUseCredit(credit.id)}
                  >
                    {isThisCreditResetting ? (
                      <>
                        <Spinner />
                        Using reset
                      </>
                    ) : canUse ? (
                      "Use reset"
                    ) : (
                      statusLabel
                    )}
                  </Button>
                </section>
              );
            })}

            {additionalCreditCount > 0 ? (
              <section className="flex min-w-0 items-center justify-between gap-4 px-4 py-3">
                <div
                  aria-hidden="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                >
                  <TimerResetIcon className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-medium text-sm">
                    {additionalCreditCount === 1
                      ? "1 additional reset"
                      : `${additionalCreditCount} additional resets`}
                  </h3>
                  <p className="mt-0.5 text-muted-foreground text-xs">
                    Individual expiration dates are unavailable.
                  </p>
                </div>
                <Button
                  className="shrink-0"
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={props.isResetting}
                  onClick={() => props.onUseCredit()}
                >
                  {props.isResetting && props.resettingCreditId === null ? (
                    <>
                      <Spinner />
                      Using reset
                    </>
                  ) : (
                    "Use next reset"
                  )}
                </Button>
              </section>
            ) : null}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

export function useProviderRateLimitResetCredit(): {
  readonly pendingRateLimitResetCredit: ProviderRateLimitResetCreditRequest | null;
  readonly isConsumingRateLimitResetCredit: boolean;
  readonly requestRateLimitResetCredit: (request: ProviderRateLimitResetCreditRequest) => void;
  readonly rateLimitResetCreditDialog: ReactNode;
} {
  const [pendingRateLimitResetCredit, setPendingRateLimitResetCredit] =
    useState<PendingProviderRateLimitResetCreditRequest | null>(null);
  const [isConsumingRateLimitResetCredit, setIsConsumingRateLimitResetCredit] = useState(false);
  const [resettingRateLimitResetCreditId, setResettingRateLimitResetCreditId] = useState<
    string | null
  >(null);

  const requestRateLimitResetCredit = useCallback(
    (request: ProviderRateLimitResetCreditRequest) => {
      setPendingRateLimitResetCredit({ ...request, openedAtMs: Date.now() });
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

  const consumeRateLimitResetCredit = useCallback(
    async (creditId?: string) => {
      const pendingReset = pendingRateLimitResetCredit;
      if (!pendingReset || isConsumingRateLimitResetCredit) return;

      setIsConsumingRateLimitResetCredit(true);
      setResettingRateLimitResetCreditId(creditId ?? null);
      try {
        const result = await ensureLocalApi().server.consumeProviderRateLimitResetCredit({
          instanceId: pendingReset.instanceId,
          idempotencyKey: randomUUID(),
          ...(creditId ? { creditId } : {}),
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
        setResettingRateLimitResetCreditId(null);
      }
    },
    [isConsumingRateLimitResetCredit, pendingRateLimitResetCredit],
  );

  return {
    pendingRateLimitResetCredit,
    isConsumingRateLimitResetCredit,
    requestRateLimitResetCredit,
    rateLimitResetCreditDialog: (
      <ProviderRateLimitResetCreditDialog
        pendingReset={pendingRateLimitResetCredit}
        isResetting={isConsumingRateLimitResetCredit}
        resettingCreditId={resettingRateLimitResetCreditId}
        onOpenChange={handleDialogOpenChange}
        onUseCredit={consumeRateLimitResetCredit}
      />
    ),
  };
}
