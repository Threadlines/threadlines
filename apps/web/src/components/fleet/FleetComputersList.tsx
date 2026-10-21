import { LayersIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { cn } from "../../lib/utils";
import { AttentionCounts } from "../sidebar/AttentionCounts";
import { DestinationListHeader } from "../sidebar/DestinationListHeader";
import { SidebarContent } from "../ui/sidebar";
import { describeComputerLocation, type FleetComputer } from "./fleet.logic";
import { FLEET_CONNECTION_DOT_CLASS, FLEET_GLYPH_ICONS } from "./FleetGraph";
import { useFleetPageStore } from "./fleetPageStore";

function ComputerRow({
  testId,
  selected,
  disabled = false,
  icon,
  title,
  meta,
  needsYou,
  working,
  onSelect,
}: {
  readonly testId: string;
  readonly selected: boolean;
  readonly disabled?: boolean;
  readonly icon: ReactNode;
  readonly title: string;
  readonly meta: string | null;
  readonly needsYou: number;
  readonly working: number;
  readonly onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-testid={testId}
        aria-pressed={disabled ? undefined : selected}
        disabled={disabled}
        className={cn(
          "flex w-full min-w-0 items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors select-none focus-ring",
          disabled
            ? "cursor-default"
            : selected
              ? "cursor-pointer bg-sidebar-accent"
              : "cursor-pointer hover:bg-sidebar-accent/60 active:bg-sidebar-accent/80",
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
    </li>
  );
}

function ComputerGlyph({ computer }: { readonly computer: FleetComputer }) {
  const Glyph = FLEET_GLYPH_ICONS[computer.glyph];
  return (
    <span className="relative inline-flex">
      <Glyph aria-hidden="true" className="size-4" />
      <span
        aria-hidden="true"
        className={cn(
          "absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-2 ring-sidebar",
          FLEET_CONNECTION_DOT_CLASS[computer.connection],
        )}
      />
    </span>
  );
}

/**
 * The Fleet page's list beside the rail: every computer, this one first,
 * where each is and what runs on it. Choosing one narrows the page to it, as
 * clicking it in the graph does; choosing it again, or All computers, shows
 * them all. Phones and tablets are listed, and run nothing to narrow to.
 */
export function FleetComputersList() {
  const nowMs = useRelativeTimeTick(30_000);
  const model = useFleetPageStore((state) => state.model);
  const selectedComputerId = useFleetPageStore((state) => state.selectedComputerId);
  const select = useFleetPageStore((state) => state.select);
  const toggle = useFleetPageStore((state) => state.toggle);
  const computers = model ? [model.center, ...model.others] : [];
  const selected = computers.some((computer) => computer.id === selectedComputerId);

  return (
    <>
      <DestinationListHeader title="Computers" />
      <SidebarContent className="px-2 pb-3">
        <ul className="flex flex-col gap-0.5" data-testid="fleet-computers-list">
          <ComputerRow
            testId="fleet-list-all"
            selected={!selected}
            icon={<LayersIcon aria-hidden="true" className="size-4" />}
            title="All computers"
            meta={null}
            needsYou={model?.needsYou ?? 0}
            working={model?.working ?? 0}
            onSelect={() => select(null)}
          />
          {computers.map((computer) => (
            <ComputerRow
              key={computer.id}
              testId={`fleet-list-computer-${computer.id}`}
              selected={computer.id === selectedComputerId}
              disabled={computer.environmentId === null}
              icon={<ComputerGlyph computer={computer} />}
              title={computer.label}
              meta={describeComputerLocation(computer, nowMs) || null}
              needsYou={computer.needsYou}
              working={computer.working}
              onSelect={() => toggle(computer.id)}
            />
          ))}
        </ul>
      </SidebarContent>
    </>
  );
}
