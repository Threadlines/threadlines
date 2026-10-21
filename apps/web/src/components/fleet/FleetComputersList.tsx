import { useLocation, useNavigate } from "@tanstack/react-router";
import { LayersIcon, PlusIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  cancelPendingRelayJoin,
  useSavedEnvironmentRegistryStore,
} from "../../environments/runtime";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { cn } from "../../lib/utils";
import { openConnectComputerDialog } from "../settings/connections/JoinComputerDialog";
import { AttentionCounts } from "../sidebar/AttentionCounts";
import { ChromeIconButton, ChromeTooltip } from "../sidebar/ChromeIconButton";
import { DestinationListHeader } from "../sidebar/DestinationListHeader";
import { Button } from "../ui/button";
import { SidebarContent, useSidebar } from "../ui/sidebar";
import { describeComputerLocation, type FleetComputer } from "./fleet.logic";
import { FLEET_CONNECTION_DOT_CLASS, FLEET_GLYPH_ICONS } from "./FleetGraph";
import { type FleetDirectoryEntry, FLEET_DEVICE_KEY_PREFIX } from "./fleetLinks.logic";
import { useFleetPageStore } from "./fleetPageStore";

function ComputerRow({
  testId,
  selected,
  icon,
  title,
  meta,
  needsYou,
  working,
  onSelect,
  action,
}: {
  readonly testId: string;
  readonly selected: boolean;
  readonly icon: ReactNode;
  readonly title: string;
  readonly meta: string | null;
  readonly needsYou: number;
  readonly working: number;
  readonly onSelect: () => void;
  /** A row's own action (Cancel a pairing), beside it rather than inside it. */
  readonly action?: ReactNode;
}) {
  return (
    <li className="relative">
      <button
        type="button"
        data-testid={testId}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "flex w-full min-w-0 cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors select-none focus-ring",
          selected ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60 active:bg-sidebar-accent/80",
          action ? "pe-20" : null,
        )}
        onClick={onSelect}
      >
        <span className="mt-px flex size-[18px] shrink-0 items-center justify-center text-muted-foreground">
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13.5px] leading-[19px] font-medium text-foreground">
              {title}
            </span>
            <AttentionCounts needsYou={needsYou} working={working} />
          </span>
          {meta ? (
            <span className="truncate font-mono text-[10.5px] leading-4 text-muted-foreground">
              {meta}
            </span>
          ) : null}
        </span>
      </button>
      {action ? <span className="absolute top-1.5 right-2">{action}</span> : null}
    </li>
  );
}

function ComputerGlyph({ computer }: { readonly computer: FleetComputer | null }) {
  const Glyph = FLEET_GLYPH_ICONS[computer?.glyph ?? "monitor"];
  return (
    <span className="relative inline-flex">
      <Glyph aria-hidden="true" className="size-4" />
      <span
        aria-hidden="true"
        className={cn(
          "absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-2 ring-sidebar",
          FLEET_CONNECTION_DOT_CLASS[computer?.connection ?? "offline"],
        )}
      />
    </span>
  );
}

/** Where a list row goes: a computer's page by environment id, or by device while it waits. */
export function fleetEntryRoute(entry: Pick<FleetDirectoryEntry, "environmentId" | "deviceId">) {
  return entry.environmentId !== null
    ? ({ to: "/fleet/$environmentId", params: { environmentId: entry.environmentId } } as const)
    : ({ to: "/fleet/device/$deviceId", params: { deviceId: entry.deviceId ?? "" } } as const);
}

/**
 * Fleet's list beside the rail: All computers (the graph page), then every
 * computer in the fleet, this one first (docs/design/fleet.md, R4.1). Each
 * row opens that computer's page. A computer still being added says so with
 * its comparison number and Cancel. "+" connects another computer. Phones
 * and tablets stay in Settings › Connections and are not listed.
 */
export function FleetComputersList() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  // On a phone the list is a sheet over the page: choosing a row closes it.
  const go = (navigateTo: () => void) => {
    if (isMobile) setOpenMobile(false);
    navigateTo();
  };
  const pathname = useLocation({ select: (location) => location.pathname });
  const nowMs = useRelativeTimeTick(30_000);
  const data = useFleetPageStore((state) => state.data);
  const savedRecords = useSavedEnvironmentRegistryStore((state) => state.byId);
  const computers = data ? [data.model.center, ...data.model.others] : [];
  const computerById = new Map(computers.map((computer) => [computer.id, computer] as const));
  const selectedKey = (() => {
    const match = /^\/fleet\/(?:device\/)?([^/]+)\/?$/u.exec(pathname);
    if (match === null) return null;
    const value = decodeURIComponent(match[1]!);
    return pathname.startsWith("/fleet/device/") ? `${FLEET_DEVICE_KEY_PREFIX}${value}` : value;
  })();

  return (
    <>
      <DestinationListHeader
        title="Computers"
        action={
          <ChromeIconButton
            size="titlebar"
            side="bottom"
            label="Connect to a computer"
            testId="fleet-list-connect"
            tooltip={<ChromeTooltip label="Connect to a computer" />}
            onClick={openConnectComputerDialog}
          >
            <PlusIcon aria-hidden="true" className="size-4" />
          </ChromeIconButton>
        }
      />
      <SidebarContent className="px-2 pb-3">
        <ul className="flex flex-col gap-0.5" data-testid="fleet-computers-list">
          <ComputerRow
            testId="fleet-list-all"
            selected={selectedKey === null}
            icon={<LayersIcon aria-hidden="true" className="size-4" />}
            title="All computers"
            meta={null}
            needsYou={data?.model.needsYou ?? 0}
            working={data?.model.working ?? 0}
            onSelect={() => go(() => void navigate({ to: "/fleet" }))}
          />
          {(data?.directory ?? []).map((entry) => {
            const computer = computerById.get(entry.key) ?? null;
            const record =
              entry.environmentId === null ? undefined : savedRecords[entry.environmentId];
            const relay = record?.relay && "version" in record.relay ? record.relay : null;
            const pairing = relay?.pendingRequest ?? null;
            const meta = pairing
              ? `Waiting for approval${pairing.matchNumber ? ` · ${pairing.matchNumber}` : ""}`
              : entry.kind === "waiting"
                ? "Waiting to hear from it"
                : computer
                  ? describeComputerLocation(computer, nowMs) || null
                  : null;
            return (
              <ComputerRow
                key={entry.key}
                testId={`fleet-list-computer-${entry.key}`}
                selected={selectedKey === entry.key}
                icon={<ComputerGlyph computer={computer} />}
                title={entry.label}
                meta={meta}
                needsYou={computer?.needsYou ?? 0}
                working={computer?.working ?? 0}
                onSelect={() => go(() => void navigate(fleetEntryRoute(entry)))}
                action={
                  pairing && entry.environmentId !== null ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        if (entry.environmentId !== null) {
                          void cancelPendingRelayJoin(entry.environmentId);
                        }
                      }}
                    >
                      Cancel
                    </Button>
                  ) : undefined
                }
              />
            );
          })}
        </ul>
      </SidebarContent>
    </>
  );
}
