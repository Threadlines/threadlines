import type { EnvironmentId, InboundComputerLink } from "@threadlines/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PencilIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import {
  describeComputerLinkFailure,
  removeComputerLinkHalf,
} from "../../environments/links/computerLinks";
import {
  removeSavedEnvironment,
  useSavedEnvironmentRegistryStore,
} from "../../environments/runtime";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { cn } from "../../lib/utils";
import { openComputerRenameDialog, useComputerNaming } from "../DeviceRenameDialog";
import { PageTitlebar } from "../PageTitlebar";
import { openConnectComputerDialog } from "../settings/connections/JoinComputerDialog";
import {
  SETTINGS_GROUP_ROW_CLASS,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from "../settings/settingsLayout";
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
import { failureNotice, toastManager } from "../ui/toast";
import { ComputerConnectionGroup } from "./ComputerConnectionGroup";
import { describeComputerLocation, type FleetComputer, type FleetGlyph } from "./fleet.logic";
import {
  FLEET_DEVICE_ENTRY_STATUS,
  FLEET_DEVICE_KEY_PREFIX,
  type FleetDirectoryEntry,
  type FleetLinkReach,
  type FleetPair,
  isFleetDeviceEntry,
  resolveFleetPair,
} from "./fleetLinks.logic";
import { useFleetData } from "./FleetLayout";
import { FleetThreadList } from "./FleetThreadList";
import { LinkRequestRow } from "./LinkRequestRow";
import { ProjectSetupsGroup } from "./ProjectSetupsGroup";
import { useFleetLabels } from "./useFleetLabels";
import { LinkSettingsControls, WorksWithGroup } from "./WorksWithGroup";

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** What this app knows of a computer it doesn't connect to. */
function unknownReach(entry: FleetDirectoryEntry): FleetLinkReach {
  return {
    environmentId: entry.environmentId!,
    label: entry.displayLabel,
    reachable: false,
    known: false,
    supportsLinks: null,
    links: null,
  };
}

/** "Remove from this app": forgets this app's connection; never unlinks. */
function RemoveFromAppSection({
  entry,
  linkedWith,
}: {
  readonly entry: FleetDirectoryEntry;
  readonly linkedWith: readonly string[];
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  // A computer still being added is called off with Cancel in its Connection group.
  const pairing = useSavedEnvironmentRegistryStore((state) => {
    const relay = entry.environmentId === null ? undefined : state.byId[entry.environmentId]?.relay;
    return relay !== undefined && "version" in relay && relay.pendingRequest !== undefined;
  });
  const remove = async () => {
    if (entry.environmentId === null) return;
    setRemoving(true);
    try {
      await removeSavedEnvironment(entry.environmentId);
      setOpen(false);
      void navigate({ to: "/fleet" });
    } catch (error) {
      toastManager.add(
        failureNotice({
          title: `Couldn't remove ${entry.displayLabel}`,
          error,
        }),
      );
    } finally {
      setRemoving(false);
    }
  };
  if (pairing) return null;
  return (
    <SettingsSection title="This app">
      <SettingsRow
        title="Remove from this app"
        description={`This app forgets its connection to ${entry.displayLabel}. You can connect again with a new code.`}
        control={
          <Button
            size="xs"
            variant="destructive-outline"
            onClick={() => setOpen(true)}
            data-testid="fleet-remove-from-app"
          >
            Remove
          </Button>
        }
      />
      <AlertDialog open={open} onOpenChange={(next) => !removing && setOpen(next)}>
        <AlertDialogPopup data-testid="fleet-remove-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {entry.displayLabel} from this app?</AlertDialogTitle>
            <AlertDialogDescription>
              This app forgets its connection to {entry.displayLabel}. Its threads stay on{" "}
              {entry.displayLabel}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {linkedWith.length > 0 ? (
            <p
              className="px-6 pb-2 text-[13px] leading-[19px] text-foreground"
              data-testid="fleet-remove-stays-linked"
            >
              {joinNames([entry.displayLabel, ...linkedWith])} stay linked. Unlink them first to
              stop agents working across them.
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose disabled={removing} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={removing}
              onClick={() => void remove()}
              data-testid="fleet-remove-confirm"
            >
              {removing ? "Removing..." : "Remove"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

/**
 * A link known only by its device (its computer hasn't said which it is
 * yet, or can't be confirmed), on the computer it linked to: its agents'
 * settings there, and Unlink, which removes that link and stops what it
 * started.
 */
function WaitingLinkGroup({
  entry,
  holder,
  inbound,
}: {
  readonly entry: FleetDirectoryEntry;
  readonly holder: FleetLinkReach;
  readonly inbound: InboundComputerLink;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const editable = holder.reachable && holder.links?.live === true;
  const testId = `fleet-waiting-${inbound.deviceId}`;
  const pending = (holder.links?.snapshot.pending ?? []).filter(
    (request) => request.deviceId === inbound.deviceId,
  );
  const unlink = async () => {
    setRemoving(true);
    try {
      await removeComputerLinkHalf(
        { environmentId: holder.environmentId, label: holder.label },
        { direction: "inbound", deviceId: inbound.deviceId, stopRunning: true },
      );
      setConfirmOpen(false);
    } catch (error) {
      toastManager.add(
        failureNotice({
          title: `Couldn't unlink ${entry.displayLabel}`,
          reason: describeComputerLinkFailure(error, "Try again."),
        }),
      );
    } finally {
      setRemoving(false);
    }
  };
  return (
    <SettingsGroup data-testid={testId}>
      <div className={cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2.5")}>
        <div className="flex min-h-7 items-center gap-2.5">
          <h3 className="min-w-0 flex-1 truncate text-[13.5px] leading-[19px] font-medium text-foreground">
            {entry.displayLabel} and {holder.label}
          </h3>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={!holder.reachable}
            onClick={() => setConfirmOpen(true)}
            data-testid={`${testId}-unlink`}
          >
            Unlink
          </Button>
        </div>
      </div>
      {pending.map((request) => (
        <LinkRequestRow
          key={request.requestId}
          request={request}
          worker={{ environmentId: holder.environmentId, label: holder.label }}
        />
      ))}
      <div className={cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2.5")}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-[13px] leading-[18px] text-foreground">
              {entry.displayLabel}&apos;s agents can start work on {holder.label}
            </p>
            {editable ? null : (
              <p className="text-[12.5px] leading-[18px] text-muted-foreground">
                {holder.known
                  ? `${holder.label} is offline.`
                  : `Connect to ${holder.label} to change this.`}
              </p>
            )}
          </div>
          <LinkSettingsControls
            worker={{ environmentId: holder.environmentId, label: holder.label }}
            inbound={inbound}
            editable={editable}
            testId={testId}
          />
        </div>
      </div>
      <div className={cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2.5")}>
        <p className="text-[13px] leading-[18px] text-foreground">
          {holder.label}&apos;s agents can start work on {entry.displayLabel}
        </p>
        <p className="text-[12.5px] leading-[18px] text-muted-foreground">
          {entry.kind === "unconfirmed"
            ? "Unlink, then link the two computers again to set this way up too."
            : `This way can be linked once ${entry.displayLabel} says which computer it is.`}
        </p>
      </div>
      <AlertDialog open={confirmOpen} onOpenChange={(next) => !removing && setConfirmOpen(next)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Unlink {entry.displayLabel} and {holder.label}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Agents on {entry.displayLabel} can no longer start work on {holder.label}, and threads
              they started there stop.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={removing} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={removing} onClick={() => void unlink()}>
              {removing ? "Unlinking..." : "Unlink"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsGroup>
  );
}

/**
 * One computer's Fleet page (docs/design/fleet.md, R4.2): its name and where
 * it is, its Connection (for a computer this app connects to), which other
 * computers it works with and how, what is working on it now, and for a
 * saved computer, "Remove from this app". This computer's own page has no
 * Remove, and points to Settings for the devices that use it.
 */
export function FleetComputerView({ entryKey }: { readonly entryKey: string }) {
  const navigate = useNavigate();
  const nowMs = useRelativeTimeTick(30_000);
  const data = useFleetData();
  const { model, directory, reach, summaryByThreadKey, isOwner, deviceCount, runningStartedBy } =
    data;
  const computers = useMemo(() => [model.center, ...model.others], [model]);
  const { providerLabel, modelNameOf } = useFleetLabels(computers);
  const entry = directory.find((candidate) => candidate.key === entryKey) ?? null;
  const computer: FleetComputer | null =
    computers.find((candidate) => candidate.id === entryKey) ?? null;
  // This computer and the ones this app connects to; a linked one is renamed
  // where this app reaches it, if it does.
  const naming = useComputerNaming(
    entry?.kind === "this" || entry?.kind === "saved" ? entry.environmentId : null,
  );
  // A computer waiting to say which it is just did: its page moves to the
  // computer's own address, in place.
  const introducedAs = useMemo(() => {
    if (entry !== null || !entryKey.startsWith(FLEET_DEVICE_KEY_PREFIX)) return null;
    const deviceId = entryKey.slice(FLEET_DEVICE_KEY_PREFIX.length);
    for (const holder of Object.values(data.links)) {
      const link = holder.snapshot.inbound.find((candidate) => candidate.deviceId === deviceId);
      if (link?.environmentId) return link.environmentId;
    }
    return null;
  }, [data.links, entry, entryKey]);
  useEffect(() => {
    if (introducedAs === null) return;
    void navigate({
      to: "/fleet/$environmentId",
      params: { environmentId: introducedAs },
      replace: true,
    });
  }, [introducedAs, navigate]);

  const glyphOf = (environmentId: EnvironmentId): FleetGlyph =>
    computers.find((candidate) => candidate.environmentId === environmentId)?.glyph ?? "monitor";

  const selfReach =
    entry?.environmentId == null ? null : (reach.get(entry.environmentId) ?? unknownReach(entry));
  const pairs: FleetPair[] =
    selfReach === null
      ? []
      : directory.flatMap((other) =>
          other.environmentId === null || other.environmentId === selfReach.environmentId
            ? []
            : [resolveFleetPair(selfReach, reach.get(other.environmentId) ?? unknownReach(other))],
        );
  // Linked computers that haven't said who they are, held by this computer.
  const waitingHere =
    selfReach === null
      ? []
      : directory.flatMap((other) => {
          if (!isFleetDeviceEntry(other) || other.holderEnvironmentId !== selfReach.environmentId) {
            return [];
          }
          const inbound = selfReach.links?.snapshot.inbound.find(
            (link) => link.deviceId === other.deviceId,
          );
          return inbound ? [{ entry: other, inbound }] : [];
        });

  if (entry === null) {
    return (
      <div
        className="flex h-full min-h-0 w-full flex-col bg-background"
        data-testid="fleet-computer-view"
      >
        <PageTitlebar label="Fleet" />
        <div className="mx-auto w-full max-w-[720px] px-4 pt-8 sm:px-8">
          <p className="text-[13px] text-muted-foreground">
            That computer isn&apos;t in your fleet any more.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => void navigate({ to: "/fleet" })}
          >
            All computers
          </Button>
        </div>
      </div>
    );
  }

  const providers = computer?.providers ?? [];
  const location =
    entry.kind === "linked"
      ? "Not connected to this app"
      : isFleetDeviceEntry(entry)
        ? FLEET_DEVICE_ENTRY_STATUS[entry.kind]
        : computer
          ? describeComputerLocation(computer, nowMs)
          : "";
  const providerParts = providers.map((provider) => {
    const count = provider.working + provider.needsYou;
    return count > 0 ? `${providerLabel(provider)} ${count}` : providerLabel(provider);
  });
  const metaLine = [location, ...providerParts].filter((part) => part.length > 0).join(" · ");
  const linkedWith = pairs.filter((pair) => pair.linked).map((pair) => pair.other.label);

  let workingNow: ReactNode;
  if (entry.kind === "linked") {
    workingNow = (
      <SettingsGroup>
        <div
          className={cn(
            SETTINGS_GROUP_ROW_CLASS,
            "flex flex-wrap items-center justify-between gap-3 px-3.5 py-3",
          )}
        >
          <p className="text-[13px] text-muted-foreground">
            Connect to {entry.displayLabel} to see its work.
          </p>
          <Button size="xs" variant="outline" onClick={openConnectComputerDialog}>
            Connect
          </Button>
        </div>
      </SettingsGroup>
    );
  } else if (isFleetDeviceEntry(entry)) {
    workingNow = null;
  } else if (computer && computer.connection !== "connected" && entry.kind === "saved") {
    workingNow = (
      <p className="px-1 text-[12.5px] text-muted-foreground">
        {entry.displayLabel} is offline. Its work shows here when it&apos;s back.
      </p>
    );
  } else if (computer && computer.threads.length > 0) {
    workingNow = (
      <FleetThreadList
        threads={computer.threads}
        summaryByThreadKey={summaryByThreadKey}
        modelNameOf={modelNameOf}
      />
    );
  } else {
    workingNow = (
      <p className="px-1 text-[12.5px] text-muted-foreground">
        Nothing is running on {entry.displayLabel} right now.
      </p>
    );
  }

  const holder =
    isFleetDeviceEntry(entry) && entry.holderEnvironmentId !== null
      ? (reach.get(entry.holderEnvironmentId) ?? null)
      : null;
  const waitingInbound =
    holder?.links?.snapshot.inbound.find((link) => link.deviceId === entry.deviceId) ?? null;

  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 flex-col bg-background"
      data-testid="fleet-computer-view"
    >
      <PageTitlebar label={entry.label}>
        {naming ? (
          <button
            type="button"
            className="ml-auto flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-ring"
            data-testid="fleet-rename-computer"
            onClick={() => openComputerRenameDialog(naming)}
          >
            <PencilIcon aria-hidden className="size-3.5" />
            Rename
          </button>
        ) : null}
      </PageTitlebar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-7 px-4 pt-5 pb-12 sm:px-8 sm:pt-8">
          <header className="space-y-1 px-1">
            <h1 className="hidden text-[22px] leading-7 font-semibold tracking-[-0.015em] text-foreground md:block">
              {entry.label}
            </h1>
            {metaLine ? (
              <p
                className="font-mono text-[11px] leading-4 text-muted-foreground"
                data-testid="fleet-computer-meta"
              >
                {metaLine}
              </p>
            ) : null}
          </header>

          {entry.kind === "saved" && entry.environmentId !== null ? (
            <ComputerConnectionGroup environmentId={entry.environmentId} />
          ) : entry.kind === "linked" ? (
            <SettingsSection title="Connection">
              <SettingsRow
                title="Not connected to this app"
                description={`This app doesn't connect to ${entry.displayLabel}. ${
                  entry.linkedWith
                    ? `Its link with ${entry.linkedWith} is separate and works on its own.`
                    : "Its links with your computers are separate and work on their own."
                }`}
                control={
                  <Button size="xs" variant="outline" onClick={openConnectComputerDialog}>
                    Connect
                  </Button>
                }
              />
            </SettingsSection>
          ) : isFleetDeviceEntry(entry) && holder !== null ? (
            <SettingsSection title="Connection">
              <SettingsRow
                title={FLEET_DEVICE_ENTRY_STATUS[entry.kind]}
                description={
                  entry.kind === "unconfirmed"
                    ? `${holder.label} can't confirm which computer this is. Unlink it, then link that computer again from Fleet.`
                    : `${entry.displayLabel} linked to ${holder.label} and hasn't said which computer it is yet. It does the next time it reaches ${holder.label}.`
                }
              />
            </SettingsSection>
          ) : null}

          {isFleetDeviceEntry(entry) ? (
            holder !== null && waitingInbound !== null ? (
              <section className="flex flex-col gap-2">
                <h2 className="px-1 text-[15px] leading-5 font-semibold text-foreground">
                  Works with other computers
                </h2>
                <WaitingLinkGroup entry={entry} holder={holder} inbound={waitingInbound} />
              </section>
            ) : null
          ) : (
            <WorksWithGroup pairs={pairs} glyphOf={glyphOf} runningStartedBy={runningStartedBy}>
              {waitingHere.map(({ entry: waiting, inbound }) => (
                <WaitingLinkGroup
                  key={waiting.key}
                  entry={waiting}
                  holder={selfReach!}
                  inbound={inbound}
                />
              ))}
            </WorksWithGroup>
          )}

          {workingNow !== null ? (
            <section className="flex flex-col gap-2" data-testid="fleet-working-now">
              <h2 className="px-1 text-[15px] leading-5 font-semibold text-foreground">
                Working now
              </h2>
              {workingNow}
            </section>
          ) : null}

          {entry.environmentId !== null && !isFleetDeviceEntry(entry) ? (
            <ProjectSetupsGroup environmentId={entry.environmentId} label={entry.displayLabel} />
          ) : null}

          {entry.kind === "this" ? (
            <SettingsSection title="Devices">
              <SettingsRow
                title={
                  isOwner
                    ? `Devices that can use ${entry.displayLabel}: ${deviceCount}`
                    : `Devices that can use ${entry.displayLabel}`
                }
                description="Phones, tablets, browsers and linked computers are managed in Settings."
                control={
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void navigate({ to: "/settings/connections" })}
                  >
                    Open Connections settings
                  </Button>
                }
              />
            </SettingsSection>
          ) : null}

          {entry.kind === "saved" ? (
            <RemoveFromAppSection entry={entry} linkedWith={linkedWith} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
