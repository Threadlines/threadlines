/**
 * The Change dialog's Other computers section (docs/design/assistants.md,
 * "Other computers"), for a connection that connects to this computer
 * itself: the user's linked computers, each asked live as the dialog opens,
 * with what the connection may do there and the one thing to do next. Ask
 * sends the question there, and that computer's user answers it there;
 * Cancel drops an ask still waiting; Remove takes the computer away. Offline
 * computers, and ones whose Threadlines is too old, say so and offer
 * nothing. Hidden when there are no linked computers.
 */
import type {
  EnvironmentId,
  OutsideAgentConnectionId,
  OutsideAgentReach,
} from "@threadlines/contracts";
import { useEffect, useId, useState } from "react";

import {
  askOutsideAgentReach,
  describeOutsideAgentFailure,
  readOutsideAgentReach,
  removeOutsideAgentReach,
} from "../../environments/outsideAgents/outsideAgents";
import {
  describeOutsideAgentReach,
  outsideAgentReachAction,
} from "../../environments/outsideAgents/outsideAgents.logic";
import { cn } from "../../lib/utils";
import { SETTINGS_GROUP_ROW_CLASS, SettingsGroup } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import {
  OUTSIDE_AGENT_FIELD_LABEL_CLASS as FIELD_LABEL_CLASS,
  OUTSIDE_AGENT_HINT_CLASS as HINT_CLASS,
  OutsideAgentErrorLine as ErrorLine,
} from "./OutsideAgentFields";

const ROW_CLASS = cn(SETTINGS_GROUP_ROW_CLASS, "flex min-h-12 items-center gap-3 px-3.5 py-2");

type ReachAction = NonNullable<ReturnType<typeof outsideAgentReachAction>>;

/** Each action's button, at rest and while it runs. Remove is the one that takes something away. */
const ACTIONS: Record<
  ReachAction,
  {
    readonly label: string;
    readonly busy: string;
    readonly variant: "outline" | "destructive-outline";
  }
> = {
  ask: { label: "Ask", busy: "Asking…", variant: "outline" },
  cancel: { label: "Cancel", busy: "Cancelling…", variant: "outline" },
  remove: { label: "Remove", busy: "Removing…", variant: "destructive-outline" },
};

/** The computers as last asked, or why they couldn't be. */
type ReachList =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "ready"; readonly computers: ReadonlyArray<OutsideAgentReach> };

export function OutsideAgentOtherComputers({
  connectionId,
}: {
  readonly connectionId: OutsideAgentConnectionId;
}) {
  const labelId = useId();
  const [list, setList] = useState<ReachList>({ kind: "loading" });
  const [busy, setBusy] = useState<{
    readonly environmentId: EnvironmentId;
    readonly action: ReachAction;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    readOutsideAgentReach(connectionId).then(
      (computers) => {
        if (current) setList({ kind: "ready", computers });
      },
      (cause: unknown) => {
        if (!current) return;
        setList({
          kind: "failed",
          error: describeOutsideAgentFailure(cause, "Couldn't check your linked computers."),
        });
      },
    );
    return () => {
      current = false;
    };
  }, [connectionId]);

  if (list.kind === "ready" && list.computers.length === 0) return null;

  const run = async (reach: OutsideAgentReach, action: ReachAction) => {
    setBusy({ environmentId: reach.environmentId, action });
    setError(null);
    try {
      const input = { connectionId, environmentId: reach.environmentId };
      const next =
        action === "ask" ? await askOutsideAgentReach(input) : await removeOutsideAgentReach(input);
      setList((current) =>
        current.kind === "ready"
          ? {
              kind: "ready",
              computers: current.computers.map((computer) =>
                computer.environmentId === next.environmentId ? next : computer,
              ),
            }
          : current,
      );
    } catch (cause) {
      setError(describeOutsideAgentFailure(cause, `Couldn't reach ${reach.computer}. Try again.`));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-1.5" data-testid="outside-agent-other-computers">
      <span className={FIELD_LABEL_CLASS} id={labelId}>
        Other computers
      </span>
      <p className={HINT_CLASS}>
        Let it work on your linked computers too. Each one asks you there first.
      </p>
      {list.kind === "loading" ? (
        <SettingsGroup role="status" aria-label="Checking your linked computers">
          <div className={ROW_CLASS} aria-hidden="true">
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-28 max-w-full rounded-full" />
              <Skeleton className="h-3 w-52 max-w-full rounded-full" />
            </div>
          </div>
        </SettingsGroup>
      ) : list.kind === "ready" ? (
        <SettingsGroup role="list" aria-labelledby={labelId}>
          {list.computers.map((reach) => {
            const action = outsideAgentReachAction(reach.state);
            const running = busy?.environmentId === reach.environmentId ? busy.action : null;
            return (
              <div
                key={reach.environmentId}
                role="listitem"
                className={ROW_CLASS}
                data-testid={`outside-agent-reach-${reach.environmentId}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] leading-[18px] font-medium text-foreground">
                    {reach.computer}
                  </p>
                  <p className={HINT_CLASS}>{describeOutsideAgentReach(reach)}</p>
                </div>
                {action !== null ? (
                  <Button
                    size="xs"
                    variant={ACTIONS[action].variant}
                    disabled={busy !== null}
                    aria-label={`${ACTIONS[action].label} (${reach.computer})`}
                    onClick={() => void run(reach, action)}
                    data-testid={`outside-agent-reach-${action}`}
                  >
                    {running !== null ? ACTIONS[running].busy : ACTIONS[action].label}
                  </Button>
                ) : null}
              </div>
            );
          })}
        </SettingsGroup>
      ) : null}
      <ErrorLine
        error={list.kind === "failed" ? list.error : error}
        testId="outside-agent-reach-error"
      />
    </div>
  );
}
