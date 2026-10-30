/**
 * The connections signed in to this computer, one row each, in a group of
 * their own: name, how an assistant signs in, what it may do, where, and when
 * it last called; with Change (the approval dialog's choices, on its grant)
 * and Remove access (after asking). Settings' Agents group lists local agents
 * with it, the Assistants group assistants.
 */
import type { OutsideAgentConnection, OutsideAgentConnectionId } from "@threadlines/contracts";
import type { SettingsPlaceId } from "@threadlines/shared/appPlaces";
import { Suspense, useMemo, useState } from "react";

import {
  describeOutsideAgentFailure,
  removeOutsideAgent,
  useThisComputerProjects,
} from "../../environments/outsideAgents/outsideAgents";
import {
  describeOutsideAgentAccess,
  describeOutsideAgentLastUse,
  describeOutsideAgentProjects,
  describeOutsideAgentSignIn,
} from "../../environments/outsideAgents/outsideAgents.logic";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { cn } from "../../lib/utils";
import { SETTINGS_GROUP_ROW_CLASS, SettingsSection } from "../settings/settingsLayout";
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
import { Dialog } from "../ui/dialog";
import { failureNotice, toastManager } from "../ui/toast";
import { OutsideAgentDialog } from "./outsideAgentDialog";

const ROW_CLASS = cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2.5");

/** What Remove access means for this connection: a sign-in comes back by signing in, a key doesn't. */
function describeRemoval(connection: OutsideAgentConnection): string {
  return connection.signIn === "key"
    ? "Its key stops working from its next call on. Threads it started keep its name."
    : "It can't use Threadlines from its next call on, and has to sign in again to come back. Threads it started keep its name.";
}

/** Nothing while `connections` is empty. `heading`: the group's app place, or its own title. */
export function OutsideAgentConnectionList({
  connections,
  heading,
  testId,
}: {
  readonly connections: ReadonlyArray<OutsideAgentConnection>;
  readonly heading: { readonly place: SettingsPlaceId } | { readonly title: string };
  readonly testId?: string;
}) {
  const projects = useThisComputerProjects();
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name] as const)),
    [projects],
  );
  const nowMs = useRelativeTimeTick(30_000);
  const [changingId, setChangingId] = useState<OutsideAgentConnectionId | null>(null);
  const [removing, setRemoving] = useState<OutsideAgentConnection | null>(null);

  // A connection removed or replaced while its Change is open closes it.
  const changing =
    changingId === null
      ? null
      : (connections.find((connection) => connection.connectionId === changingId) ?? null);

  const remove = async (connection: OutsideAgentConnection) => {
    setRemoving(null);
    try {
      await removeOutsideAgent(connection.connectionId);
    } catch (error) {
      toastManager.add(
        failureNotice({
          title: `Couldn't remove access for ${connection.name}`,
          reason: describeOutsideAgentFailure(error, "Try again."),
        }),
      );
    }
  };

  return (
    <>
      {connections.length > 0 ? (
        <SettingsSection {...heading} data-testid={testId}>
          {connections.map((connection) => (
            <div
              key={connection.connectionId}
              className={ROW_CLASS}
              data-testid={`outside-agent-row-${connection.connectionId}`}
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <h3 className="truncate text-[13.5px] leading-[19px] font-medium text-foreground">
                    {connection.name}
                  </h3>
                  <p className="text-[12.5px] leading-[18px] text-muted-foreground">
                    {[
                      describeOutsideAgentSignIn(connection),
                      describeOutsideAgentAccess(connection),
                      describeOutsideAgentProjects(connection.projectIds, projectNames),
                      describeOutsideAgentLastUse(connection.lastUsedAt, nowMs),
                    ]
                      .filter((part) => part !== null)
                      .join(" · ")}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setChangingId(connection.connectionId)}
                    data-testid={`outside-agent-change-${connection.connectionId}`}
                  >
                    Change
                  </Button>
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    onClick={() => setRemoving(connection)}
                    data-testid={`outside-agent-remove-${connection.connectionId}`}
                  >
                    Remove access
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </SettingsSection>
      ) : null}

      <Dialog
        open={changing !== null}
        onOpenChange={(open) => {
          if (!open) setChangingId(null);
        }}
      >
        {changing !== null ? (
          <Suspense fallback={null}>
            <OutsideAgentDialog.Component
              key={changing.connectionId}
              subject={{ kind: "change", connection: changing }}
              onClose={() => setChangingId(null)}
            />
          </Suspense>
        ) : null}
      </Dialog>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogPopup className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove access for {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing !== null ? describeRemoval(removing) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing !== null) void remove(removing);
              }}
              data-testid="outside-agent-remove-confirm"
            >
              Remove access
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
