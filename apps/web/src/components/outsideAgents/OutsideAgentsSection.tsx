/**
 * Settings › Connections › Agents (docs/design/outside-agents.md, "What the
 * user does"): agents running outside Threadlines that use this computer.
 * This computer's address for agents, how each client connects to it, every
 * connection with what it may do and when it last called (Change, Remove),
 * and after Deny all how long new sign-ins stay turned away, with the way
 * back. Owner only: ConnectionsSettings shows it to the computer's owner.
 */
import type { OutsideAgentConnection, OutsideAgentConnectionId } from "@threadlines/contracts";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";

import {
  describeOutsideAgentFailure,
  removeOutsideAgent,
  resumeOutsideAgentRequests,
  useOutsideAgentsSnapshot,
  useOutsideAgentsSync,
  useThisComputerProjects,
} from "../../environments/outsideAgents/outsideAgents";
import {
  describeOutsideAgentAccess,
  describeOutsideAgentLastUse,
  describeOutsideAgentProjects,
  type OutsideAgentClientId,
  outsideAgentConnectGuides,
  outsideAgentQuietMinutesLeft,
} from "../../environments/outsideAgents/outsideAgents.logic";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { cn } from "../../lib/utils";
import { CopyButton } from "../CopyButton";
import { SETTINGS_GROUP_ROW_CLASS, SettingsRow, SettingsSection } from "../settings/settingsLayout";
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
import { SegmentedControl, SegmentedControlItem } from "../ui/segmented-control";
import { Skeleton } from "../ui/skeleton";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { OutsideAgentDialog } from "./outsideAgentDialog";

const ROW_CLASS = cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2.5");

/**
 * The group, holding this computer's agents stream open while it shows.
 * `revealOnArrival` scrolls it into view (the command palette's "Connect an
 * agent" opens the page for it).
 */
export function OutsideAgentsSection({ revealOnArrival }: { readonly revealOnArrival: boolean }) {
  useOutsideAgentsSync(true);
  const snapshot = useOutsideAgentsSnapshot();
  const projects = useThisComputerProjects();
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name] as const)),
    [projects],
  );
  const nowMs = useRelativeTimeTick(30_000);
  const [changingId, setChangingId] = useState<OutsideAgentConnectionId | null>(null);
  const [removing, setRemoving] = useState<OutsideAgentConnection | null>(null);
  const [resuming, setResuming] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);

  // Once as the page opens, and once more when the group has its rows.
  const revealStep = revealOnArrival ? (snapshot === null ? "opening" : "settled") : null;
  useEffect(() => {
    if (revealStep !== null) sectionRef.current?.scrollIntoView({ block: "start" });
  }, [revealStep]);

  // A connection removed or replaced while its Change is open closes it.
  const changing =
    changingId === null
      ? null
      : (snapshot?.connections.find((connection) => connection.connectionId === changingId) ??
        null);
  const quietMinutes = outsideAgentQuietMinutesLeft(snapshot?.quietUntil ?? null, nowMs);

  const resume = async () => {
    setResuming(true);
    try {
      await resumeOutsideAgentRequests();
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not take agent sign-ins again",
          description: describeOutsideAgentFailure(error, "Try again."),
        }),
      );
    } finally {
      setResuming(false);
    }
  };

  const remove = async (connection: OutsideAgentConnection) => {
    setRemoving(null);
    try {
      await removeOutsideAgent(connection.connectionId);
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not remove ${connection.name}`,
          description: describeOutsideAgentFailure(error, "Try again."),
        }),
      );
    }
  };

  return (
    <div ref={sectionRef} className="scroll-mt-4" data-testid="outside-agents-section">
      <SettingsSection
        title="Agents"
        description="Agents you run outside Threadlines, like Claude Code in a terminal, can start and follow threads here once you allow them."
      >
        {snapshot === null ? (
          <div className={ROW_CLASS} role="status" aria-label="Loading agents">
            <div className="space-y-2" aria-hidden="true">
              <Skeleton className="h-3.5 w-36 max-w-full rounded-full" />
              <Skeleton className="h-3 w-64 max-w-full rounded-full" />
            </div>
          </div>
        ) : (
          <>
            {quietMinutes !== null ? (
              <SettingsRow
                data-testid="outside-agents-quiet"
                title={`Not taking new agent sign-ins (${quietMinutes} min left)`}
                description="You denied them all. Agents already connected keep working."
                control={
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={resuming}
                    onClick={() => void resume()}
                  >
                    {resuming ? "Taking requests…" : "Take requests again"}
                  </Button>
                }
              />
            ) : null}
            <SettingsRow
              title="Address for agents"
              description={
                <span
                  className="font-mono text-[11.5px] leading-[17px] break-all text-foreground select-text"
                  data-testid="outside-agents-address"
                >
                  {snapshot.address}
                </span>
              }
              control={<CopyButton value={snapshot.address} label="Copy the address for agents" />}
            />
            <ConnectGuideRow address={snapshot.address} />
            {snapshot.connections.map((connection) => (
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
                        describeOutsideAgentAccess(connection),
                        describeOutsideAgentProjects(connection.projectIds, projectNames),
                        describeOutsideAgentLastUse(connection.lastUsedAt, nowMs),
                      ].join(" · ")}
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
                      Remove
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </>
        )}
      </SettingsSection>

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
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It can&apos;t use Threadlines from its next call on, and has to sign in again to come
              back. Threads it started keep its name.
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
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

/** How to connect an agent: pick its client, copy what to run. */
function ConnectGuideRow({ address }: { readonly address: string }) {
  const guides = useMemo(() => outsideAgentConnectGuides(address), [address]);
  const [clientId, setClientId] = useState<OutsideAgentClientId>("claude");
  const guide = guides.find((candidate) => candidate.id === clientId) ?? guides[0]!;
  return (
    <div className={ROW_CLASS} data-testid="outside-agents-connect">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-[13.5px] leading-[19px] font-medium text-foreground">
          Connect an agent
        </h3>
        <SegmentedControl
          size="sm"
          value={clientId}
          onValueChange={setClientId}
          aria-label="Agent to connect"
        >
          {guides.map((candidate) => (
            <SegmentedControlItem
              key={candidate.id}
              value={candidate.id}
              data-testid={`outside-agents-client-${candidate.id}`}
            >
              {candidate.label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </div>
      <div className="mt-2 space-y-1.5">
        {guide.commands.map((command, index) => (
          <div key={command} className="flex items-center gap-3">
            <code
              className="min-w-0 flex-1 font-mono text-[11.5px] leading-[17px] break-all text-foreground select-text"
              data-testid={`outside-agents-command-${index}`}
            >
              {command}
            </code>
            <CopyButton
              value={command}
              label={
                guide.commands.length > 1
                  ? `Copy the ${index === 0 ? "first" : "second"} command for ${guide.label}`
                  : `Copy for ${guide.label}`
              }
            />
          </div>
        ))}
      </div>
      <p className="mt-1 text-[12.5px] leading-[18px] text-muted-foreground">{guide.hint}</p>
    </div>
  );
}
