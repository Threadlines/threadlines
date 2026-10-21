import type { EnvironmentId } from "@threadlines/contracts";
import { CircleCheckIcon, ClockIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { runComputerUnlink } from "../../environments/links/computerLinks";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import {
  type FleetDirection,
  type FleetPair,
  type FleetUnlinkOutcome,
  planFleetUnlink,
  resolveFleetUnlinkOutcomes,
} from "./fleetLinks.logic";

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function threadsWord(count: number): string {
  return count === 1 ? "1 thread" : `${count} threads`;
}

/**
 * Unlink two computers (docs/design/fleet.md, R4.2): both directions go, and
 * the work the links started stops on both sides. It says up front which
 * threads still run, and when a computer can't be reached, that this app
 * unlinks on the one it reaches and the other finishes when it's back. Each
 * direction then reports its own result.
 */
export function UnlinkDialog({
  pair,
  runningStartedBy,
  onClose,
}: {
  readonly pair: FleetPair;
  readonly runningStartedBy: (asker: EnvironmentId, worker: EnvironmentId) => number;
  readonly onClose: () => void;
}) {
  const plan = useMemo(() => planFleetUnlink(pair), [pair]);
  const [running, setRunning] = useState(false);
  const [outcomes, setOutcomes] = useState<ReadonlyArray<
    readonly [FleetDirection, FleetUnlinkOutcome]
  > | null>(null);
  const names = `${pair.self.label} and ${pair.other.label}`;
  const reachableHolders = [
    ...new Map(plan.steps.map((step) => [step.holder.environmentId, step.holder])).values(),
  ];
  const runningLines = [pair.outward, pair.inward].flatMap((direction) => {
    const count = runningStartedBy(direction.asker.environmentId, direction.worker.environmentId);
    return count === 0
      ? []
      : [
          `${threadsWord(count)} ${direction.asker.label} started on ${direction.worker.label} ${
            count === 1 ? "is" : "are"
          } still running. Unlinking stops ${count === 1 ? "it" : "them"}.`,
        ];
  });
  const finishLaterNames = plan.finishLater.map((computer) => computer.label);

  const unlink = async () => {
    setRunning(true);
    const results = await runComputerUnlink(plan.steps);
    setRunning(false);
    const directionOutcomes = resolveFleetUnlinkOutcomes(pair, plan, results).map(
      ({ direction, outcome }) => [direction, outcome] as const,
    );
    if (directionOutcomes.every(([, outcome]) => outcome.kind === "done")) {
      toastManager.add({
        type: "success",
        title: `${names} are unlinked`,
        description: "Agents on either one can no longer start work on the other.",
      });
      onClose();
      return;
    }
    setOutcomes(directionOutcomes);
  };

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !running) onClose();
      }}
    >
      <AlertDialogPopup data-testid="fleet-unlink-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Unlink {names}?</AlertDialogTitle>
          <AlertDialogDescription>
            Agents on either one can no longer start work on the other.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2 px-6 pb-2 text-[13px] leading-[19px]">
          {outcomes === null ? (
            <>
              {runningLines.map((line) => (
                <p key={line} className="text-foreground" data-testid="fleet-unlink-running">
                  {line}
                </p>
              ))}
              {finishLaterNames.length > 0 ? (
                <p className="text-muted-foreground" data-testid="fleet-unlink-offline">
                  {joinNames(finishLaterNames)} {finishLaterNames.length === 1 ? "is" : "are"}{" "}
                  offline. {joinNames(finishLaterNames)}{" "}
                  {finishLaterNames.length === 1 ? "finishes" : "finish"} when{" "}
                  {finishLaterNames.length === 1 ? "it's" : "they're"} back.
                </p>
              ) : null}
              {plan.blocked ? (
                <p className="text-warning">
                  Connect to {joinNames([pair.self.label, pair.other.label])} first.
                </p>
              ) : null}
            </>
          ) : (
            <ul className="space-y-1.5" data-testid="fleet-unlink-results">
              {outcomes.map(([direction, outcome]) => (
                <li
                  key={`${direction.asker.environmentId}>${direction.worker.environmentId}`}
                  className="flex items-start gap-1.5"
                >
                  {outcome.kind === "done" ? (
                    <CircleCheckIcon
                      aria-hidden
                      className="mt-0.5 size-3.5 shrink-0 text-success"
                    />
                  ) : outcome.kind === "pending" ? (
                    <ClockIcon
                      aria-hidden
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    />
                  ) : (
                    <TriangleAlertIcon
                      aria-hidden
                      className="mt-0.5 size-3.5 shrink-0 text-warning"
                    />
                  )}
                  <span>
                    {direction.asker.label}&apos;s agents on {direction.worker.label}:{" "}
                    {outcome.kind === "done"
                      ? "unlinked."
                      : outcome.kind === "pending"
                        ? `${outcome.waitingFor} finishes when it's back.`
                        : outcome.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <AlertDialogFooter>
          {outcomes === null ? (
            <>
              <AlertDialogClose disabled={running} render={<Button variant="outline" />}>
                Cancel
              </AlertDialogClose>
              <Button
                variant="destructive"
                disabled={running || plan.blocked}
                onClick={() => void unlink()}
                data-testid="fleet-unlink-confirm"
              >
                {running ? <Spinner className="size-3.5" /> : null}
                {finishLaterNames.length > 0 && reachableHolders.length > 0
                  ? `Unlink on ${joinNames(reachableHolders.map((computer) => computer.label))} now`
                  : "Unlink"}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
