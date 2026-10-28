import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { useIsMobile } from "../../hooks/useMediaQuery";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { PageTitlebar } from "../PageTitlebar";
import { openConnectComputerDialog } from "../settings/connections/JoinComputerDialog";
import { SettingsGroup } from "../settings/settingsLayout";
import { usePendingLinkRequests } from "../sidebar/linkedComputers";
import { Button } from "../ui/button";
import {
  describeComputerCounts,
  describeComputerLocation,
  describeFleetSummary,
  describeQuietComputers,
  type FleetComputer,
} from "./fleet.logic";
import { FleetGraph, FleetGraphLegend } from "./FleetGraph";
import { useFleetData } from "./FleetLayout";
import { fleetEntryRoute } from "./fleetLinks.logic";
import { FleetThreadList } from "./FleetThreadList";
import { LinkRequestRow } from "./LinkRequestRow";
import { useFleetComputerMenu } from "./useFleetComputerMenu";
import { useFleetLabels } from "./useFleetLabels";

/** Graph heights: room for the arc of computers, or just this one and its agents. */
const GRAPH_HEIGHT = 300;
const GRAPH_HEIGHT_PHONE = 270;
const GRAPH_HEIGHT_ONE_COMPUTER = 210;

/**
 * Fleet's All computers page: every computer in the fleet and the phones and
 * tablets using this one, drawn as a graph with what runs where and the
 * links and work between computers; then threads that wait on another
 * computer's Allow, and the threads that are working or need the user, by
 * computer. Clicking a computer opens its page; a phone opens Settings ›
 * Connections, where phones are managed.
 */
export function FleetView() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const nowMs = useRelativeTimeTick(30_000);
  const { model, directory, edges, summaryByThreadKey } = useFleetData();
  const computers = useMemo(() => [model.center, ...model.others], [model]);
  const { providerLabel, modelNameOf } = useFleetLabels(computers);

  const labelOfEnvironment = useMemo(
    () =>
      new Map(
        directory.flatMap((entry) =>
          entry.environmentId === null ? [] : [[entry.environmentId, entry.displayLabel] as const],
        ),
      ),
    [directory],
  );
  // Threads other computers asked to start, waiting for an Allow, on the
  // computers this app hears from now (the same list the inbox leads with).
  const pendingRequests = usePendingLinkRequests();
  const pending = useMemo(
    () =>
      pendingRequests.map(({ environmentId, request }) => ({
        request,
        worker: { environmentId, label: labelOfEnvironment.get(environmentId) ?? "this computer" },
      })),
    [labelOfEnvironment, pendingRequests],
  );

  const listed = computers.filter((computer) => computer.threads.length > 0);
  const quietLine = describeQuietComputers(
    computers.filter((computer) => computer.kind !== "this"),
    nowMs,
  );
  const alone = model.others.length === 0;
  const graphHeight = alone
    ? GRAPH_HEIGHT_ONE_COMPUTER
    : isMobile
      ? GRAPH_HEIGHT_PHONE
      : GRAPH_HEIGHT;

  const openComputer = useCallback(
    (computer: FleetComputer) => {
      if (computer.kind === "device") {
        void navigate({ to: "/settings/connections" });
        return;
      }
      const entry = directory.find((candidate) => candidate.key === computer.id);
      if (entry) void navigate(fleetEntryRoute(entry));
    },
    [directory, navigate],
  );
  const openMenu = useFleetComputerMenu();
  const openComputerMenu = useCallback(
    (computer: FleetComputer, position: { readonly x: number; readonly y: number }) => {
      if (computer.kind === "device") {
        void openMenu({ kind: "device", computer }, position);
        return;
      }
      const entry = directory.find((candidate) => candidate.key === computer.id);
      if (entry) void openMenu({ kind: "computer", entry }, position);
    },
    [directory, openMenu],
  );

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

          {pending.length > 0 ? (
            <section className="mt-7 flex flex-col gap-2" data-testid="fleet-pending-requests">
              <h2 className="px-1 text-[15px] leading-5 font-semibold text-foreground">
                Waiting for your Allow
              </h2>
              <SettingsGroup>
                {pending.map(({ request, worker }) => (
                  <LinkRequestRow
                    key={`${worker.environmentId}:${request.requestId}`}
                    request={request}
                    worker={worker}
                    showWorker
                  />
                ))}
              </SettingsGroup>
            </section>
          ) : null}

          <SettingsGroup className="mt-7 overflow-hidden">
            <div className="px-3 pt-3 sm:px-4">
              <FleetGraph
                model={model}
                edges={edges}
                nowMs={nowMs}
                height={graphHeight}
                onOpenComputer={openComputer}
                onComputerMenu={openComputerMenu}
                providerLabel={providerLabel}
              />
            </div>
            <div className="border-t border-group-divider px-3.5 py-2.5">
              {alone ? (
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <p className="text-[12.5px] text-muted-foreground">
                    Connect another computer to see it here.
                  </p>
                  <Button size="sm" variant="outline" onClick={openConnectComputerDialog}>
                    Connect to a computer
                  </Button>
                </div>
              ) : (
                <FleetGraphLegend
                  hint={isMobile ? null : "Click a computer to open it, right-click to rename it."}
                />
              )}
            </div>
          </SettingsGroup>

          {listed.map((computer) => (
            <section
              key={computer.id}
              className="mt-7"
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
              <FleetThreadList
                threads={computer.threads}
                summaryByThreadKey={summaryByThreadKey}
                modelNameOf={modelNameOf}
              />
            </section>
          ))}

          {quietLine ? (
            <p className="mt-6 px-1 text-[12.5px] text-muted-foreground" data-testid="fleet-quiet">
              {quietLine}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
