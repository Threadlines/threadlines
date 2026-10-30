/**
 * Settings › Connections › Agents (docs/design/outside-agents.md, "What the
 * user does"): agents running outside Threadlines that use this computer.
 * This computer's address for agents, how each client connects to it, the
 * `threadlines` command the desktop app puts on PATH (ThreadlinesCommandRow),
 * and after Deny all how long new sign-ins stay turned away, with the way
 * back. Below it, in a group of their own like the devices above, the agents
 * signed in (OutsideAgentConnectionList): the command signs in under its own
 * name, and its sign-in must not read as a second copy of the row that
 * installs it. Assistants have their own group (AssistantsSection). Owner
 * only: ConnectionsSettings shows it to the computer's owner.
 */
import { placeById } from "@threadlines/shared/appPlaces";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  useOutsideAgentsSnapshot,
  useOutsideAgentsSync,
} from "../../environments/outsideAgents/outsideAgents";
import {
  type OutsideAgentClientId,
  outsideAgentConnectGuides,
} from "../../environments/outsideAgents/outsideAgents.logic";
import { cn } from "../../lib/utils";
import { CopyButton } from "../CopyButton";
import { SETTINGS_GROUP_ROW_CLASS, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { SegmentedControl, SegmentedControlItem } from "../ui/segmented-control";
import { Skeleton } from "../ui/skeleton";
import { OutsideAgentConnectionList } from "./OutsideAgentConnectionList";
import { OutsideAgentsQuietRow } from "./OutsideAgentsQuietRow";
import { ThreadlinesCommandRow } from "./ThreadlinesCommandRow";

const ROW_CLASS = cn(SETTINGS_GROUP_ROW_CLASS, "px-3.5 py-2.5");

/**
 * The group, holding this computer's agents stream open while it shows.
 * `revealOnArrival` scrolls it into view (the command palette's "Connect an
 * agent" opens the page for it).
 */
export function OutsideAgentsSection({ revealOnArrival }: { readonly revealOnArrival: boolean }) {
  useOutsideAgentsSync(true);
  const snapshot = useOutsideAgentsSnapshot();
  const sectionRef = useRef<HTMLDivElement>(null);

  // Once as the page opens, and once more when the group has its rows.
  const revealStep = revealOnArrival ? (snapshot === null ? "opening" : "settled") : null;
  useEffect(() => {
    if (revealStep !== null) sectionRef.current?.scrollIntoView({ block: "start" });
  }, [revealStep]);

  const localConnections = useMemo(
    () => snapshot?.connections.filter((connection) => connection.kind === "local") ?? [],
    [snapshot],
  );

  return (
    <div
      ref={sectionRef}
      // Two groups, spaced as the page spaces its own sections.
      className="flex scroll-mt-4 flex-col gap-7"
      data-testid="outside-agents-section"
    >
      <SettingsSection
        place="connections.agents"
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
            <OutsideAgentsQuietRow
              quietUntil={snapshot.quietUntil}
              who="agent"
              testId="outside-agents-quiet"
            />
            <SettingsRow
              place="connections.agentAddress"
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
            <ThreadlinesCommandRow />
          </>
        )}
      </SettingsSection>

      <OutsideAgentConnectionList
        connections={localConnections}
        heading={{ place: "connections.agentsUsingThis" }}
      />
    </div>
  );
}

/** How to connect an agent: pick its client, copy what to run. */
function ConnectGuideRow({ address }: { readonly address: string }) {
  const guides = useMemo(() => outsideAgentConnectGuides(address), [address]);
  const [clientId, setClientId] = useState<OutsideAgentClientId>("claude");
  const guide = guides.find((candidate) => candidate.id === clientId) ?? guides[0]!;
  return (
    <div
      className={ROW_CLASS}
      data-testid="outside-agents-connect"
      data-place="connections.connectAgent"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-[13.5px] leading-[19px] font-medium text-foreground">
          {placeById("connections.connectAgent").title}
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
