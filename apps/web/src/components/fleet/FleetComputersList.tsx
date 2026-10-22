import { LayersIcon } from "lucide-react";

import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { cn } from "../../lib/utils";
import { DestinationListHeader } from "../sidebar/DestinationListHeader";
import { DestinationListRow } from "../sidebar/DestinationListRow";
import { SidebarContent } from "../ui/sidebar";
import { describeComputerLocation, type FleetComputer } from "./fleet.logic";
import { FLEET_CONNECTION_DOT_CLASS, FLEET_GLYPH_ICONS } from "./FleetGraph";
import { useFleetPageStore } from "./fleetPageStore";

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
          <DestinationListRow
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
            <DestinationListRow
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
