/**
 * The "Community agents" group on the Providers settings page: agents from
 * the open ACP registry that Threadlines can install but hasn't tested.
 *
 * The list is the server's, already reduced to what it would install on its
 * own computer. Installing asks once per agent, inline under its row, and
 * sends the digest of exactly what the row showed: the server refuses if the
 * listing moved in between. Once added, the agent leaves this list and shows
 * as a row under "In use", where its install runs.
 *
 * Everything shown here comes from the registry and is drawn as text; an
 * agent's icon is drawn as a mask (see `ProviderGlyph`).
 *
 * @module CommunityAgentsSection
 */
import type {
  AcpRegistryCatalog,
  AcpRegistryCatalogAgent,
  ProviderInstanceId,
} from "@threadlines/contracts";
import {
  acpRegistryAmbiguousAgentIds,
  acpRegistryInstallConfirmText,
  acpRegistryRowSubtitle,
  acpRegistrySourceText,
  filterAcpRegistryAgents,
} from "@threadlines/shared/acpRegistry";
import { LoaderIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { openExternalUrl } from "../../lib/externalLinks";
import { ensureLocalApi } from "../../localApi";
import { ProviderGlyph } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { AgentRow } from "./AgentRow";
import { communityAgentErrorText } from "./communityAgents";
import { ProviderGroupHeading } from "./ProviderGroupHeading";

const REGISTRY_URL = "https://github.com/agentclientprotocol/registry";
/** Below this many agents a search field is more clutter than help. */
const SEARCH_MIN_AGENTS = 8;

const WHAT_WORKS: ReadonlyArray<{ readonly title: string; readonly items: ReadonlyArray<string> }> =
  [
    {
      title: "Works with every agent",
      items: [
        "Chats and tool calls",
        "Stopping a turn",
        "Permission requests",
        "The models and modes it offers",
      ],
    },
    {
      title: "Depends on the agent",
      items: ["Resuming after a restart", "Images and files", "Plans", "Browser and room tools"],
    },
    {
      title: "Not available yet",
      items: [
        "Usage meters",
        "Importing its past sessions",
        "Extra accounts",
        "Writing titles and commit messages",
      ],
    },
  ];

type CatalogState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "loaded"; readonly catalog: AcpRegistryCatalog };

/** The listed agents that aren't added yet, narrowed by the search. */
export function visibleCommunityAgents(input: {
  readonly agents: ReadonlyArray<AcpRegistryCatalogAgent>;
  readonly addedAgentIds: ReadonlySet<string>;
  readonly query: string;
}): ReadonlyArray<AcpRegistryCatalogAgent> {
  return filterAcpRegistryAgents(
    input.agents.filter((agent) => !input.addedAgentIds.has(agent.agentId)),
    input.query,
  );
}

export function CommunityAgentsSection(props: {
  /** Registry ids of the community agents that already have a row above. */
  readonly addedAgentIds: ReadonlySet<string>;
  /** Where agents run, as this client would say it ("this Mac", or the other computer's name). */
  readonly computerName: string;
  /** Bumped by the page's "Check again": the list is read from the registry again. */
  readonly refreshRequest: number;
  /** The page was opened for this group: bring it into view. */
  readonly revealOnArrival?: boolean;
  readonly onAdded: (instanceId: ProviderInstanceId) => void;
}) {
  const [state, setState] = useState<CatalogState>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [showWhatWorks, setShowWhatWorks] = useState(false);
  const [confirmingAgentId, setConfirmingAgentId] = useState<string | null>(null);
  const [addingAgentId, setAddingAgentId] = useState<string | null>(null);
  // Only the newest request may write the list.
  const loadSeq = useRef(0);
  const sectionRef = useRef<HTMLElement>(null);
  // When the page was opened for this group: once as it opens, and once
  // more when the list has arrived and the page has its final height.
  const revealOnArrival = props.revealOnArrival ?? false;
  const isLoading = state.kind === "loading";
  useEffect(() => {
    if (revealOnArrival) sectionRef.current?.scrollIntoView({ block: "start" });
  }, [revealOnArrival, isLoading]);

  const load = useCallback((refresh: boolean) => {
    const seq = ++loadSeq.current;
    setState((current) => (current.kind === "loaded" ? current : { kind: "loading" }));
    // Inside the chain, so a list that can't even be asked for (an older
    // server) ends as a message here and never takes the page down.
    void Promise.resolve()
      .then(() => ensureLocalApi().server.listAcpRegistryAgents({ refresh }))
      .then(
        (catalog) => {
          if (loadSeq.current === seq) setState({ kind: "loaded", catalog });
        },
        (error: unknown) => {
          if (loadSeq.current !== seq) return;
          setState((current) =>
            // A failed refresh keeps the list that is already on screen.
            current.kind === "loaded"
              ? current
              : {
                  kind: "failed",
                  message: communityAgentErrorText(
                    error,
                    "Couldn't read the community agent list.",
                  ),
                },
          );
        },
      );
  }, []);

  // The first look takes the server's saved copy; "Check again" asks for a fresh one.
  const { refreshRequest } = props;
  useEffect(() => {
    load(refreshRequest > 0);
  }, [load, refreshRequest]);

  const catalog = state.kind === "loaded" ? state.catalog : null;
  const available = useMemo(
    () =>
      catalog
        ? visibleCommunityAgents({
            agents: catalog.agents,
            addedAgentIds: props.addedAgentIds,
            query: "",
          })
        : [],
    [catalog, props.addedAgentIds],
  );
  const shown = useMemo(() => filterAcpRegistryAgents(available, query), [available, query]);
  const ambiguousIds = useMemo(
    () => acpRegistryAmbiguousAgentIds(catalog?.agents ?? []),
    [catalog],
  );

  const install = (agent: AcpRegistryCatalogAgent) => {
    if (addingAgentId !== null) return;
    setAddingAgentId(agent.agentId);
    void ensureLocalApi()
      .server.addAcpRegistryAgent({ agentId: agent.agentId, recipeDigest: agent.recipeDigest })
      .then(
        ({ instanceId }) => {
          setConfirmingAgentId(null);
          props.onAdded(instanceId);
        },
        (error: unknown) => {
          toastManager.add({
            type: "error",
            title: `Could not install ${agent.name}`,
            description: communityAgentErrorText(error, "Try again in a moment."),
          });
          // The usual reason is a listing that moved on: show the new one.
          load(true);
        },
      )
      .finally(() => setAddingAgentId(null));
  };

  return (
    <section ref={sectionRef} aria-label="Community agents" data-testid="community-agents">
      <ProviderGroupHeading
        label="Community agents"
        count={catalog ? available.length : undefined}
      />
      <div className="px-1 pb-3 text-[12.5px] leading-5 text-muted-foreground">
        <p>
          Made by other teams and listed in the open ACP registry. We haven't tested them, so some
          features may not work.{" "}
          <button
            type="button"
            className="text-foreground underline-offset-2 hover:text-primary-readable hover:underline"
            aria-expanded={showWhatWorks}
            onClick={() => setShowWhatWorks((open) => !open)}
          >
            What works
          </button>
        </p>
        {showWhatWorks ? (
          <div className="mt-2.5 grid gap-x-6 gap-y-3 sm:grid-cols-3">
            {WHAT_WORKS.map((column) => (
              <div key={column.title} className="min-w-0">
                <h3 className="text-[12.5px] font-medium text-foreground">{column.title}</h3>
                <ul className="mt-1 space-y-0.5">
                  {column.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {state.kind === "loading" ? (
        <p
          data-group-row=""
          className="flex items-center gap-2 px-3.5 py-3 text-[12.5px] text-muted-foreground"
        >
          <LoaderIcon className="size-3 animate-spin" />
          Reading the registry…
        </p>
      ) : null}

      {state.kind === "failed" ? (
        <div
          data-group-row=""
          className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3 text-[12.5px] text-muted-foreground"
        >
          <span className="min-w-48 flex-1">{state.message}</span>
          <Button size="xs" variant="outline" onClick={() => load(true)}>
            Try again
          </Button>
        </div>
      ) : null}

      {catalog ? (
        <>
          {catalog.stale ? (
            <p className="px-1 pb-2 text-[12.5px] text-muted-foreground">
              The registry couldn't be reached. This is the list from the last time it could.
            </p>
          ) : null}
          {catalog.quarantineKnown ? null : (
            <p className="px-1 pb-2 text-[12.5px] text-muted-foreground">
              Couldn't check the registry's quarantine list, so nothing can be installed yet.{" "}
              <button
                type="button"
                className="text-foreground underline-offset-2 hover:text-primary-readable hover:underline"
                onClick={() => load(true)}
              >
                Try again
              </button>
            </p>
          )}
          {available.length >= SEARCH_MIN_AGENTS ? (
            <div className="relative mb-2">
              <SearchIcon
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                size="sm"
                className="pl-8"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search community agents"
                aria-label="Search community agents"
              />
            </div>
          ) : null}

          {shown.map((agent) => {
            const confirming = confirmingAgentId === agent.agentId;
            const adding = addingAgentId === agent.agentId;
            return (
              <AgentRow
                key={agent.agentId}
                data-testid={`community-agent-${agent.agentId}`}
                icon={
                  <ProviderGlyph
                    instanceId={null}
                    driverKind={null}
                    iconSvg={agent.iconSvg}
                    className="size-5 shrink-0"
                  />
                }
                name={agent.name}
                label={ambiguousIds.has(agent.agentId) ? agent.agentId : undefined}
                version={agent.version}
                status={<span className="truncate">{acpRegistryRowSubtitle(agent)}</span>}
                expanded={confirming}
                actions={
                  confirming ? null : (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!catalog.quarantineKnown || addingAgentId !== null}
                      onClick={() => setConfirmingAgentId(agent.agentId)}
                    >
                      Install
                    </Button>
                  )
                }
              >
                {confirming ? (
                  <div className="px-3.5 pt-1 pb-3.5 pl-[46px]">
                    <p className="max-w-[68ch] text-[13px] leading-5 text-foreground">
                      {acpRegistryInstallConfirmText({ agent, computer: props.computerName })}
                    </p>
                    <p className="mt-1 max-w-[68ch] text-[12.5px] leading-5 text-muted-foreground">
                      {acpRegistrySourceText(agent)}
                    </p>
                    <div className="mt-3 flex items-center gap-2">
                      <Button size="xs" disabled={adding} onClick={() => install(agent)}>
                        {adding ? "Installing…" : "Install"}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={adding}
                        onClick={() => setConfirmingAgentId(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </AgentRow>
            );
          })}

          {shown.length === 0 ? (
            <p data-group-row="" className="px-3.5 py-3 text-[12.5px] text-muted-foreground">
              {available.length === 0
                ? "Every listed agent is already added."
                : `No community agent matches "${query.trim()}".`}
            </p>
          ) : null}

          <p className="px-1 pt-2.5 text-[12.5px] leading-5 text-muted-foreground">
            {catalog.unsupportedCount > 0
              ? `${catalog.unsupportedCount} more can't be installed on this computer. `
              : null}
            Want one that isn't here? Agents join by adding themselves to the{" "}
            <button
              type="button"
              className="text-foreground underline-offset-2 hover:text-primary-readable hover:underline"
              onClick={() => openExternalUrl(REGISTRY_URL)}
            >
              ACP registry
            </button>
            .
          </p>
        </>
      ) : null}
    </section>
  );
}
