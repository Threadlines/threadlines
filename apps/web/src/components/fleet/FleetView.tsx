import { scopeThreadRef } from "@threadlines/client-runtime";
import {
  type EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
} from "@threadlines/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useEnvironmentProviders } from "../../hooks/useEnvironmentProviders";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { cn } from "../../lib/utils";
import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../../providerInstances";
import { useServerConfig } from "../../rpc/serverState";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { SidebarThreadSummary } from "../../types";
import { getPickerModelName } from "../chat/providerIconUtils";
import { ProviderGlyph } from "../chat/ProviderInstanceIcon";
import { PageTitlebar } from "../PageTitlebar";
import { ConnectDeviceDialog } from "../settings/connections/ConnectDeviceDialog";
import { useRelayAccess } from "../settings/connections/useRelayAccess";
import { SettingsGroup } from "../settings/settingsLayout";
import { ThreadStatusText } from "../sidebar/InboxRows";
import { Button } from "../ui/button";
import {
  describeComputerCounts,
  describeComputerLocation,
  describeFleetSummary,
  describeQuietComputers,
  type FleetComputer,
  type FleetProvider,
  type FleetThreadInput,
} from "./fleet.logic";
import { FleetGraph, FleetGraphLegend } from "./FleetGraph";
import { useFleetPageStore } from "./fleetPageStore";
import { useFleetModel } from "./useFleetModel";

/** Graph heights: room for the arc of computers, or just this one and its agents. */
const GRAPH_HEIGHT = 300;
const GRAPH_HEIGHT_PHONE = 270;
const GRAPH_HEIGHT_ONE_COMPUTER = 210;

const NO_PROVIDER_ENTRIES: ReadonlyArray<ProviderInstanceEntry> = [];

/**
 * Each computer's own agents, looked up by computer: instance ids are named
 * per computer, so the same id can be a different agent elsewhere.
 */
function useProviderEntriesByComputer(
  computers: ReadonlyArray<FleetComputer>,
): (environmentId: EnvironmentId | null) => ReadonlyArray<ProviderInstanceEntry> {
  const providersOn = useEnvironmentProviders();
  const byEnvironmentId = useMemo(() => {
    const entries = new Map<EnvironmentId, ReadonlyArray<ProviderInstanceEntry>>();
    for (const computer of computers) {
      if (computer.environmentId === null) continue;
      entries.set(
        computer.environmentId,
        deriveProviderInstanceEntries(providersOn(computer.environmentId)),
      );
    }
    return entries;
  }, [computers, providersOn]);
  return useCallback(
    (environmentId) =>
      environmentId === null
        ? NO_PROVIDER_ENTRIES
        : (byEnvironmentId.get(environmentId) ?? NO_PROVIDER_ENTRIES),
    [byEnvironmentId],
  );
}

/**
 * "Connect a device" for this computer's owner: its relay code and QR, the
 * same dialog Settings › Connections opens. Mounted only while open, so the
 * relay subscription runs only then.
 */
function FleetConnectDialog({
  hostLabel,
  onOpenChange,
}: {
  readonly hostLabel: string;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const relayAccess = useRelayAccess(true);
  return (
    <ConnectDeviceDialog
      open
      onOpenChange={onOpenChange}
      hostLabel={hostLabel}
      relayAccess={relayAccess}
    />
  );
}

function FleetThreadRow({
  thread,
  summary,
  modelName,
  onOpen,
}: {
  readonly thread: FleetThreadInput;
  readonly summary: SidebarThreadSummary | undefined;
  readonly modelName: string | null;
  readonly onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-testid={`fleet-thread-${thread.threadId}`}
        className="-mx-2 flex w-[calc(100%+1rem)] min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-left transition-colors select-none hover:bg-muted focus-ring"
        onClick={onOpen}
      >
        <span
          aria-label={thread.status?.label}
          className={cn("size-[7px] shrink-0 rounded-full", thread.status?.dotClass)}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-[13.5px] leading-[19px] font-medium text-foreground">
              {thread.title}
            </span>
            {thread.projectLabel ? (
              <span className="min-w-0 shrink truncate text-[12.5px] text-muted-foreground">
                {thread.projectLabel}
              </span>
            ) : null}
          </span>
          {thread.startedByTitle ? (
            <span className="truncate text-[12.5px] leading-[18px] text-muted-foreground">
              Started by &ldquo;{thread.startedByTitle}&rdquo;
            </span>
          ) : null}
        </span>
        {thread.provider ? (
          <span className="hidden max-w-44 min-w-0 shrink-0 items-center gap-1.5 text-[12.5px] text-muted-foreground sm:flex">
            <ProviderGlyph
              instanceId={thread.provider.instanceId}
              driverKind={thread.provider.driverKind}
              environmentId={thread.environmentId}
              className="size-3.5 shrink-0"
            />
            {modelName ? <span className="truncate">{modelName}</span> : null}
          </span>
        ) : null}
        <span className="flex w-24 shrink-0 justify-end">
          {summary ? (
            <ThreadStatusText
              thread={summary}
              status={thread.status}
              restingClassName="text-muted-foreground"
              testId={`fleet-thread-status-${thread.threadId}`}
            />
          ) : null}
        </span>
      </button>
    </li>
  );
}

/**
 * The Fleet page: every computer this app is connected to and the phones and
 * tablets linked to this one, drawn as a graph with what runs where, then the
 * threads that are working or need the user, by computer. Clicking a computer
 * narrows the list to it.
 */
export function FleetView() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const nowMs = useRelativeTimeTick(30_000);
  const { model, summaryByThreadKey, isOwner } = useFleetModel();
  const computers = useMemo(() => [model.center, ...model.others], [model]);
  const providerEntriesFor = useProviderEntriesByComputer(computers);
  const hostLabel = useServerConfig()?.environment.label ?? "This computer";
  // Shared with the list of computers beside the rail: either one narrows the page.
  const selectedComputerId = useFleetPageStore((state) => state.selectedComputerId);
  const toggleComputer = useFleetPageStore((state) => state.toggle);
  const selectComputer = useFleetPageStore((state) => state.select);
  const publishModel = useFleetPageStore((state) => state.publish);
  useEffect(() => {
    publishModel(model);
  }, [model, publishModel]);
  useEffect(() => () => publishModel(null), [publishModel]);
  const [connectOpen, setConnectOpen] = useState(false);

  const providerLabel = useCallback(
    (provider: FleetProvider) => {
      const entries = providerEntriesFor(provider.environmentId);
      const entry =
        (provider.instanceId === null
          ? undefined
          : entries.find((candidate) => candidate.instanceId === provider.instanceId)) ??
        entries.find((candidate) => candidate.driverKind === provider.driverKind);
      return (
        entry?.displayName ??
        PROVIDER_DISPLAY_NAMES[provider.driverKind as ProviderDriverKind] ??
        provider.driverKind
      );
    },
    [providerEntriesFor],
  );
  const modelNameOf = useCallback(
    (thread: FleetThreadInput) => {
      const selection = thread.modelSelection;
      if (selection === null) return null;
      const entry = providerEntriesFor(thread.environmentId).find(
        (candidate) => candidate.instanceId === selection.instanceId,
      );
      const model = entry?.models.find((candidate) => candidate.slug === selection.model);
      return entry && model ? getPickerModelName(model, entry.driverKind) : selection.model;
    },
    [providerEntriesFor],
  );

  // A computer that left (removed under Connections) stops filtering.
  const selected = computers.find((computer) => computer.id === selectedComputerId) ?? null;
  const listed = selected
    ? [selected]
    : computers.filter((computer) => computer.threads.length > 0);
  const quietLine = selected
    ? null
    : describeQuietComputers(
        computers.filter((computer) => computer.kind !== "this"),
        nowMs,
      );
  const alone = model.others.length === 0;
  const graphHeight = alone
    ? GRAPH_HEIGHT_ONE_COMPUTER
    : isMobile
      ? GRAPH_HEIGHT_PHONE
      : GRAPH_HEIGHT;

  const openConnect = useCallback(() => {
    if (isOwner) {
      setConnectOpen(true);
      return;
    }
    // Only the computer's owner can let a device in; everyone else sees where
    // it is done.
    void navigate({ to: "/settings/connections" });
  }, [isOwner, navigate]);

  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 flex-col bg-background"
      data-testid="fleet-view"
    >
      <PageTitlebar label="Fleet" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[960px] flex-col px-4 pt-5 pb-12 sm:px-8 sm:pt-8">
          <header className="space-y-1 px-1">
            <h1 className="hidden text-[22px] leading-7 font-semibold tracking-[-0.015em] text-foreground md:block">
              Fleet
            </h1>
            <p
              className="text-[13px] leading-[18px] text-muted-foreground"
              data-testid="fleet-summary"
            >
              {describeFleetSummary(model)}
            </p>
          </header>

          <SettingsGroup className="mt-7 overflow-hidden">
            <div className="px-3 pt-3 sm:px-4">
              <FleetGraph
                model={model}
                nowMs={nowMs}
                height={graphHeight}
                selectedComputerId={selected?.id ?? null}
                onSelectComputer={toggleComputer}
                providerLabel={providerLabel}
              />
            </div>
            <div className="border-t border-group-divider px-3.5 py-2.5">
              {alone ? (
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <p className="text-[12.5px] text-muted-foreground">
                    Link another computer or your phone to see them here.
                  </p>
                  <Button size="sm" variant="outline" onClick={openConnect}>
                    Connect
                  </Button>
                </div>
              ) : (
                <FleetGraphLegend
                  hint={isMobile ? null : "Click a computer to show only its threads."}
                />
              )}
            </div>
          </SettingsGroup>

          {selected ? (
            <div className="mt-6 flex items-center gap-2 px-1 text-[12.5px] text-muted-foreground">
              <span>Showing {selected.label} only.</span>
              <button
                type="button"
                className="cursor-pointer text-foreground underline-offset-2 hover:underline focus-ring"
                onClick={() => selectComputer(null)}
                data-testid="fleet-show-all"
              >
                Show all
              </button>
            </div>
          ) : null}

          {listed.map((computer) => (
            <section
              key={computer.id}
              className={selected ? "mt-3" : "mt-7"}
              data-testid={`fleet-computer-${computer.id}`}
            >
              {/* The name keeps its width first; on a narrow screen the counts
                  wrap to their own line rather than squeezing it. */}
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1">
                <h2 className="max-w-full shrink-0 truncate text-[15px] leading-5 font-semibold text-foreground">
                  {computer.label}
                </h2>
                <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                  {describeComputerLocation(computer, nowMs)}
                </span>
                <span className="ms-auto shrink-0 font-mono text-[11px] text-muted-foreground">
                  {describeComputerCounts(computer)}
                </span>
              </div>
              {computer.threads.length > 0 ? (
                <ul className="mt-1.5 flex flex-col divide-y divide-border/60 px-1">
                  {computer.threads.map((thread) => (
                    <FleetThreadRow
                      key={thread.threadKey}
                      thread={thread}
                      summary={summaryByThreadKey.get(thread.threadKey)}
                      modelName={modelNameOf(thread)}
                      onOpen={() => {
                        void navigate({
                          to: "/$environmentId/$threadId",
                          params: buildThreadRouteParams(
                            scopeThreadRef(thread.environmentId, thread.threadId),
                          ),
                        });
                      }}
                    />
                  ))}
                </ul>
              ) : (
                <p className="mt-1.5 px-1 text-[12.5px] text-muted-foreground">
                  Nothing is running here.
                </p>
              )}
            </section>
          ))}

          {quietLine ? (
            <p className="mt-6 px-1 text-[12.5px] text-muted-foreground" data-testid="fleet-quiet">
              {quietLine}
            </p>
          ) : null}
        </div>
      </div>
      {connectOpen ? (
        <FleetConnectDialog hostLabel={hostLabel} onOpenChange={setConnectOpen} />
      ) : null}
    </div>
  );
}
