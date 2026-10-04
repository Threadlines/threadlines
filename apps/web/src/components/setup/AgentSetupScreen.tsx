/**
 * The full-window first-run setup: pick agents, connect them, pick a folder.
 *
 * It takes the whole window instead of sitting on an empty thread. The
 * composer is not on screen here on purpose: a message sent before any agent
 * works only fails.
 *
 * Everything is live. Install, sign-in and update progress arrive on the
 * provider snapshots the rest of the app already streams, through the same
 * actions the Providers settings page uses, so an agent reads the same in both
 * places. Progress (step, picks, folder) is saved per computer, so a reload or
 * relaunch comes back to the same step.
 *
 * @module AgentSetupScreen
 */
import { scopeProjectRef } from "@threadlines/client-runtime";
import type { EnvironmentId, ProviderDriverKind, ScopedProjectRef } from "@threadlines/contracts";
import {
  BROWSER_SIGN_IN_DRIVERS,
  BROWSER_SIGN_IN_LABEL,
} from "@threadlines/shared/providerAuthCommands";
import { Link, useNavigate } from "@tanstack/react-router";
import { CheckIcon, FolderIcon, GitBranchIcon, LoaderIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import * as Option from "effect/Option";
import { useShallow } from "zustand/react/shallow";

import { APP_BASE_NAME } from "../../branding";
import { useCommandPaletteStore } from "../../commandPaletteStore";
import { usePrimaryEnvironmentDescriptor } from "../../environments/primary/context";
import { useNavigateBackWithinApp } from "../../hooks/useNavigateBackWithinApp";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { updateSettingsAndPersist, useSettings } from "../../hooks/useSettings";
import {
  useSourceControlDiscovery,
  useSourceControlSetup,
} from "../../lib/sourceControlDiscoveryState";
import { cn } from "../../lib/utils";
import { useServerConfig, useServerProviders } from "../../rpc/serverState";
import { selectWorkspaceProjectsAcrossEnvironments, useStore } from "../../store";
import { GitHubIcon, ThreadlinesGlyph } from "../Icons";
import { ThreadlinesFigure } from "../ThreadlinesFigure";
import { BrowserRedirectField } from "../settings/ProviderConnectFlow";
import { AgentRow, AgentUpdateTag, type AgentRowTone } from "../settings/AgentRow";
import {
  agentStatusLine,
  isAgentReady,
  thisComputerLabel,
  type AgentStatus,
} from "../settings/agentStatus";
import {
  CompactVersionAdvisory,
  SourceControlToolProgress,
} from "../settings/CompactVersionAdvisory";
import { GitHubSignInAction, GitHubSignInStatus } from "../settings/GitHubSignInAction";
import { ProviderInstallAction } from "../settings/ProviderInstallAction";
import {
  buildProviderEnablementPatch,
  deriveMaintainedProviderRows,
} from "../settings/providerEnablement";
import { getProviderVersionLabel } from "../settings/providerStatus";
import { ProviderUpdatePopover } from "../settings/ProviderUpdatePopover";
import { useProviderConnectFlow } from "../settings/useProviderConnectFlow";
import {
  useProviderUpdateRunner,
  type ProviderUpdateControls,
} from "../settings/useProviderUpdateRunner";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  ProviderSignInButton,
  ProviderSignInInlineStatus,
  toProviderSignInFlowView,
} from "../chat/providerSignIn";
import {
  countReadyPicks,
  deriveInitialPicks,
  deriveSetupAgents,
  describeFoundAgents,
  setupEnablementChanges,
  stepAfterAgents,
  type SetupAgent,
  type SetupStep,
} from "./agentSetup.logic";
import { dismissFirstRunSetup } from "./firstRunGate";
import { SETUP_ROUTE_PATH, useFirstRunSetupGate, useSetupEnvironmentId } from "./firstRunGateState";
import { useSetupProgress, useSetupProgressStore } from "./setupProgress";

/** How long the scan may take before still-checking agents count as picked. */
const INITIAL_PICKS_WAIT_MS = 5_000;

const STEP_LABELS: Record<SetupStep, string> = {
  agents: "Agents",
  connect: "Connect",
  folder: "Folder",
};

function AgentIcon({ agent, className }: { agent: SetupAgent; className?: string }) {
  const Icon = agent.definition.icon;
  return <Icon className={cn("shrink-0 text-foreground", className)} aria-hidden />;
}

/** The status line on an Agents tile: what the scan found, in a few words. */
function tileStatus(
  status: AgentStatus,
  computer: string,
): { readonly text: string; readonly found: boolean } {
  switch (status.kind) {
    case "off":
      switch (status.detection?.status) {
        case "found":
          return { text: `On ${computer}`, found: true };
        case "notFound":
          return { text: "Not installed", found: false };
        case "unknown":
          return { text: "Turn on to check", found: false };
        default:
          return { text: "Turned off", found: false };
      }
    case "checking":
      return { text: "Checking…", found: false };
    case "notInstalled":
      return { text: "Not installed", found: false };
    case "installing":
      return { text: "Installing…", found: false };
    case "needsSignIn":
      return { text: `On ${computer} · not signed in`, found: true };
    case "ready":
      return { text: `On ${computer} · ready`, found: true };
    case "problem":
      return { text: status.headline, found: true };
  }
}

function AgentTile({
  agent,
  picked,
  computer,
  onToggle,
}: {
  readonly agent: SetupAgent;
  readonly picked: boolean;
  readonly computer: string;
  readonly onToggle: () => void;
}) {
  const status = tileStatus(agent.status, computer);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={picked}
      aria-label={`${agent.definition.label}: ${status.text}`}
      data-testid="setup-agent-tile"
      data-driver-kind={agent.driverKind}
      onClick={onToggle}
      className={cn(
        "relative flex min-h-27 cursor-pointer flex-col items-start gap-0.5 rounded-lg border p-3 text-left transition-colors focus-ring",
        picked
          ? "border-primary-readable/70 bg-primary-readable/[0.07]"
          : "border-border hover:bg-muted/[0.08]",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-3 right-3 flex size-4 items-center justify-center rounded-full border",
          picked ? "border-primary-readable bg-primary-readable text-background" : "border-input",
        )}
      >
        {picked ? <CheckIcon className="size-2.5" strokeWidth={3} /> : null}
      </span>
      <AgentIcon agent={agent} className="size-5" />
      <span className="mt-2.5 flex min-w-0 items-baseline gap-1.5 pr-5">
        <span className="truncate text-sm font-semibold tracking-[-0.01em] text-foreground">
          {agent.definition.label}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {status.found ? (
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
        ) : null}
        <span className="truncate">{status.text}</span>
      </span>
      <span className="text-xs text-muted-foreground/62">{agent.definition.needs}</span>
    </button>
  );
}

function agentRowTone(status: AgentStatus): AgentRowTone {
  if (status.kind === "problem") return "error";
  if (status.kind === "needsSignIn" || status.kind === "notInstalled") return "warning";
  return "none";
}

function OpenInSettingsButton({ agent, label }: { agent: SetupAgent; label: string }) {
  return (
    <Button
      size="xs"
      variant="outline"
      render={<Link to="/settings/providers" search={{ instance: String(agent.row.instanceId) }} />}
    >
      {label}
    </Button>
  );
}

function ReadyLabel() {
  return (
    <span className="flex items-center gap-1 text-xs font-medium text-success-foreground">
      <CheckIcon className="size-3.5" aria-hidden />
      Ready
    </span>
  );
}

/**
 * One agent on the Connect step with exactly one next step. Sign-in gets its
 * own component because it owns a live sign-in session.
 */
function SetupAgentRow({
  agent,
  updateControls,
}: {
  readonly agent: SetupAgent;
  readonly updateControls: ProviderUpdateControls;
}) {
  if (agent.status.kind === "needsSignIn" && agent.status.canSignIn) {
    return <SetupSignInAgentRow agent={agent} updateControls={updateControls} />;
  }
  const status = agent.status;
  let actions: ReactNode;
  switch (status.kind) {
    case "checking":
    case "off":
      actions = <span className="text-xs text-muted-foreground">Checking…</span>;
      break;
    case "notInstalled":
    case "installing":
      actions = status.install ? (
        <ProviderInstallAction
          instanceId={agent.row.instanceId}
          driverKind={agent.driverKind}
          displayName={agent.definition.label}
          view={status.install}
          statusClassName="max-w-56"
        />
      ) : (
        <OpenInSettingsButton agent={agent} label="Install guide" />
      );
      break;
    case "needsSignIn":
      actions = <OpenInSettingsButton agent={agent} label="Sign in" />;
      break;
    case "ready":
      actions = <ReadyLabel />;
      break;
    case "problem":
      actions = updateControls.candidate ? (
        <ProviderUpdatePopover
          liveProvider={agent.snapshot}
          displayName={agent.definition.label}
          controls={updateControls}
          trigger={
            <Button size="xs" variant="outline">
              Update
            </Button>
          }
        />
      ) : (
        <OpenInSettingsButton agent={agent} label="Details" />
      );
      break;
  }
  return <SetupAgentRowFrame agent={agent} updateControls={updateControls} actions={actions} />;
}

function SetupSignInAgentRow({
  agent,
  updateControls,
}: {
  readonly agent: SetupAgent;
  readonly updateControls: ProviderUpdateControls;
}) {
  const controller = useProviderConnectFlow({ instanceId: agent.row.instanceId, flow: "login" });
  const view = toProviderSignInFlowView({ instanceId: agent.row.instanceId, controller });
  const isBrowserFlow = BROWSER_SIGN_IN_DRIVERS.has(String(agent.driverKind));
  return (
    <SetupAgentRowFrame
      agent={agent}
      updateControls={updateControls}
      actions={
        <>
          <ProviderSignInInlineStatus view={view} className="max-w-56" />
          <ProviderSignInButton
            view={view}
            label={isBrowserFlow ? BROWSER_SIGN_IN_LABEL : "Sign in"}
            ariaLabel={`Sign in to ${agent.definition.label}`}
          />
        </>
      }
    >
      {isBrowserFlow && controller.isActive && controller.state.signInUrl ? (
        <div className="pb-3 pl-9 pr-1">
          <BrowserRedirectField onSubmit={controller.submitRedirect} />
        </div>
      ) : null}
    </SetupAgentRowFrame>
  );
}

function SetupAgentRowFrame({
  agent,
  updateControls,
  actions,
  children,
}: {
  readonly agent: SetupAgent;
  readonly updateControls: ProviderUpdateControls;
  readonly actions: ReactNode;
  readonly children?: ReactNode;
}) {
  const installed = agent.snapshot?.enabled === true && agent.snapshot.installed;
  return (
    <AgentRow
      data-testid="setup-agent-row"
      data-driver-kind={agent.driverKind}
      data-agent-status={agent.status.kind}
      icon={<AgentIcon agent={agent} className="size-4" />}
      name={agent.definition.label}
      version={installed ? getProviderVersionLabel(agent.snapshot?.version) : null}
      versionExtra={
        agent.status.kind === "ready" && updateControls.candidate ? (
          <ProviderUpdatePopover
            liveProvider={agent.snapshot}
            displayName={agent.definition.label}
            controls={updateControls}
            trigger={
              <AgentUpdateTag version={updateControls.candidate.versionAdvisory.latestVersion} />
            }
          />
        ) : null
      }
      status={agentStatusLine({
        status: agent.status,
        needs: agent.definition.needs,
        snapshot: agent.snapshot,
      })}
      tone={agentRowTone(agent.status)}
      actions={actions}
    >
      {children}
    </AgentRow>
  );
}

/** "git version 2.54.0 (Apple Git-157)" reads as "2.54.0" next to the name. */
function gitVersionLabel(raw: string | null): string | null {
  return raw?.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? raw;
}

function SourceControlRows({ environmentId }: { readonly environmentId: EnvironmentId | null }) {
  const { data } = useSourceControlDiscovery({ environmentId });
  useSourceControlSetup({ environmentId });
  const git = data?.versionControlSystems.find((item) => item.kind === "git");
  const github = data?.sourceControlProviders.find((item) => item.kind === "github");
  return (
    <>
      {git ? (
        <AgentRow
          data-testid="setup-source-control-row"
          data-row-id="git"
          icon={<GitBranchIcon className="size-4 text-muted-foreground" aria-hidden />}
          name="Git"
          version={gitVersionLabel(Option.getOrNull(git.version))}
          status="Tracks what agents change, so you can review and undo it."
          tone={git.status === "available" ? "none" : "warning"}
          actions={
            git.status === "available" ? (
              <>
                <SourceControlToolProgress target="git" environmentId={environmentId} />
                <ReadyLabel />
              </>
            ) : git.versionAdvisory ? (
              <CompactVersionAdvisory
                advisory={git.versionAdvisory}
                environmentId={environmentId}
                label="Git"
              />
            ) : (
              <Button
                size="xs"
                variant="outline"
                render={<a href="https://git-scm.com/downloads" target="_blank" rel="noreferrer" />}
              >
                Install guide
              </Button>
            )
          }
        />
      ) : null}
      {github ? (
        <AgentRow
          data-testid="setup-source-control-row"
          data-row-id="github"
          icon={<GitHubIcon className="size-4 text-muted-foreground" aria-hidden />}
          name="GitHub"
          label="Optional"
          status="Lets agents open pull requests and read issues."
          actions={
            github.status !== "available" ? (
              github.versionAdvisory ? (
                <CompactVersionAdvisory
                  advisory={github.versionAdvisory}
                  environmentId={environmentId}
                  label="GitHub CLI"
                />
              ) : (
                <Button
                  size="xs"
                  variant="outline"
                  render={<a href="https://cli.github.com/" target="_blank" rel="noreferrer" />}
                >
                  Install guide
                </Button>
              )
            ) : (
              <>
                <SourceControlToolProgress target="github-cli" environmentId={environmentId} />
                {github.auth.status === "authenticated" ? (
                  <GitHubSignInStatus environmentId={environmentId} />
                ) : (
                  <GitHubSignInAction
                    key={environmentId ?? "primary"}
                    environmentId={environmentId}
                  />
                )}
              </>
            )
          }
        />
      ) : null}
    </>
  );
}

function SectionLabel({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 px-1 pb-1.5">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/55">
        {children}
      </span>
      {aside ? <span className="text-[11.5px] text-muted-foreground/62">{aside}</span> : null}
    </div>
  );
}

function StepHeading({ title, lede }: { title: string; lede: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center">
      <h1 className="text-[20px] font-semibold tracking-[-0.015em] text-foreground">{title}</h1>
      <p className="mt-1.5 max-w-[34rem] text-[13.5px] text-balance text-muted-foreground">
        {lede}
      </p>
    </div>
  );
}

function StepIndicator({
  step,
  connectSkipped,
  onGoTo,
}: {
  readonly step: SetupStep;
  readonly connectSkipped: boolean;
  readonly onGoTo: (step: SetupStep) => void;
}) {
  const order: ReadonlyArray<SetupStep> = ["agents", "connect", "folder"];
  const currentIndex = order.indexOf(step);
  return (
    <ol className="flex items-center gap-2.5 text-[13px]" aria-label="Setup steps">
      {order.map((item, index) => {
        const done = index < currentIndex;
        const current = index === currentIndex;
        return (
          <li key={item} className="flex items-center gap-2.5">
            {index > 0 ? <span aria-hidden className="h-px w-7 bg-border" /> : null}
            <button
              type="button"
              disabled={!done}
              onClick={() => onGoTo(item)}
              aria-current={current ? "step" : undefined}
              className={cn(
                "flex items-center gap-1.5 whitespace-nowrap transition-colors",
                current && "font-medium text-foreground",
                done && "cursor-pointer text-muted-foreground hover:text-foreground",
                !done && !current && "text-muted-foreground/55",
              )}
            >
              <span
                className={cn(
                  "flex size-4.5 items-center justify-center rounded-full border font-mono text-[10.5px]",
                  current && "border-primary-readable text-primary-readable",
                  done && "border-transparent bg-success/15 text-success-foreground",
                  !done && !current && "border-border",
                )}
              >
                {done ? <CheckIcon className="size-3" strokeWidth={2.5} /> : index + 1}
              </span>
              {STEP_LABELS[item]}
              {item === "connect" && connectSkipped && done ? (
                <span className="font-mono text-[9.5px] uppercase tracking-[0.07em] text-muted-foreground/55">
                  Skipped
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function AgentSetupScreen({ routeStep }: { readonly routeStep: SetupStep | null }) {
  const navigate = useNavigate();
  const navigateBack = useNavigateBackWithinApp();
  const environmentId = useSetupEnvironmentId();
  const gate = useFirstRunSetupGate(environmentId);
  const descriptor = usePrimaryEnvironmentDescriptor();
  const computer = thisComputerLabel(descriptor?.platform.os);
  const computerName = descriptor?.label ?? computer;
  const settings = useSettings();
  const providers = useServerProviders();
  // Until the computer's settings arrive, `settings` holds the defaults, and
  // picks frozen from those would turn the wrong agents on or off.
  const serverSettingsLoaded = useServerConfig() !== null;
  const rows = useMemo(() => deriveMaintainedProviderRows(settings), [settings]);
  const agents = useMemo(() => deriveSetupAgents({ rows, providers }), [rows, providers]);
  const updateRunner = useProviderUpdateRunner(providers);
  const progress = useSetupProgress(environmentId);
  const updateProgress = useSetupProgressStore((store) => store.update);
  const clearProgress = useSetupProgressStore((store) => store.clear);
  const forgetPicks = useSetupProgressStore((store) => store.forgetPicks);
  const step = routeStep ?? progress.step;
  const [saving, setSaving] = useState(false);
  const { handleNewThread } = useNewThreadHandler();

  // The scan's picks settle once every turned-on agent has been checked (or
  // after a short wait), then freeze, so a late probe never reshuffles the grid.
  // The wait starts when the settings arrive, so a slow connection doesn't
  // use it up before there is anything to check.
  const [forceInitialPicks, setForceInitialPicks] = useState(false);
  useEffect(() => {
    if (!serverSettingsLoaded) return;
    const timeout = window.setTimeout(() => setForceInitialPicks(true), INITIAL_PICKS_WAIT_MS);
    return () => window.clearTimeout(timeout);
  }, [serverSettingsLoaded]);
  // A first run starts from what is on this computer; reopening setup later
  // starts from what is turned on now, so Continue changes nothing by itself.
  const isFirstRun = gate === "pending";
  // Picks belong to one visit. A later visit left any way (Close, Back, a
  // link) forgets them, so the next one starts from what is turned on then.
  // A first run keeps them, so relaunching mid-setup resumes the same choice.
  useEffect(() => {
    if (!environmentId || isFirstRun) return;
    return () => forgetPicks(environmentId);
  }, [environmentId, forgetPicks, isFirstRun]);
  const scannedPicks = useMemo(() => {
    if (gate === "unknown" || !serverSettingsLoaded) return null;
    if (!isFirstRun) {
      return new Set(
        agents
          .filter((agent) => agent.row.instance.enabled ?? true)
          .map((agent) => agent.driverKind),
      );
    }
    return deriveInitialPicks(agents, { force: forceInitialPicks });
  }, [agents, forceInitialPicks, gate, isFirstRun, serverSettingsLoaded]);
  const [frozenScanPicks, setFrozenScanPicks] = useState<ReadonlySet<ProviderDriverKind> | null>(
    null,
  );
  if (frozenScanPicks === null && scannedPicks !== null) {
    // Adjusting state while rendering: the first settled scan wins, once.
    setFrozenScanPicks(scannedPicks);
  }
  const picks = useMemo<ReadonlySet<ProviderDriverKind> | null>(
    () =>
      progress.picks
        ? new Set(progress.picks.map((value) => value as ProviderDriverKind))
        : frozenScanPicks,
    [frozenScanPicks, progress.picks],
  );

  const workspaceProjects = useStore(useShallow(selectWorkspaceProjectsAcrossEnvironments));
  const environmentProjects = workspaceProjects.filter(
    (project) => project.environmentId === environmentId,
  );
  const project =
    (progress.projectId
      ? environmentProjects.find((candidate) => String(candidate.id) === progress.projectId)
      : undefined) ??
    environmentProjects[0] ??
    null;
  const isLaunchFolder = project !== null && environmentProjects.length === 1;

  const goTo = (next: SetupStep, patch: Parameters<typeof updateProgress>[1] = {}) => {
    if (environmentId) updateProgress(environmentId, { step: next, ...patch });
    void navigate({ to: SETUP_ROUTE_PATH, search: { step: next }, replace: true });
  };

  const leave = () => {
    // "Set up later" ends the first run too, so its picks go with it.
    if (environmentId) forgetPicks(environmentId);
    if (gate === "pending") {
      dismissFirstRunSetup(environmentId);
      void navigate({ to: "/", replace: true });
      return;
    }
    navigateBack();
  };

  const togglePick = (driverKind: ProviderDriverKind) => {
    if (!environmentId || !picks) return;
    const next = new Set(picks);
    if (next.has(driverKind)) next.delete(driverKind);
    else next.add(driverKind);
    updateProgress(environmentId, { picks: [...next].map(String) });
  };

  const continueFromAgents = async () => {
    if (!picks || picks.size === 0 || saving) return;
    const patch = buildProviderEnablementPatch({
      settings,
      changes: setupEnablementChanges(agents, picks),
    });
    setSaving(true);
    try {
      if (Object.keys(patch).length > 0) {
        await updateSettingsAndPersist(patch);
      }
      const next = stepAfterAgents(agents, picks);
      goTo(next, { picks: [...picks].map(String), connectSkipped: next === "folder" });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not save your agents",
          description: error instanceof Error ? error.message : "Try again in a moment.",
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  const anyAgentReady = agents.some(
    (agent) => (agent.row.instance.enabled ?? true) && isAgentReady(agent.status),
  );

  const finish = () => {
    if (!project || !anyAgentReady || !environmentId) return;
    const projectRef: ScopedProjectRef = scopeProjectRef(project.environmentId, project.id);
    dismissFirstRunSetup(environmentId);
    clearProgress(environmentId);
    void handleNewThread(projectRef, {
      envMode: settings.defaultThreadEnvMode,
      replace: true,
    });
  };

  const chooseFolder = () => {
    useCommandPaletteStore.getState().openAddProject({
      ...(environmentId ? { environmentId } : {}),
      onProjectSelected: (selected) => {
        if (!environmentId || selected.environmentId !== environmentId) return;
        updateProgress(environmentId, { projectId: String(selected.projectId) });
      },
    });
  };

  const pickedAgents = picks ? agents.filter((agent) => picks.has(agent.driverKind)) : [];
  const readyPicks = picks ? countReadyPicks(agents, picks) : 0;
  const foundNames = frozenScanPicks
    ? agents
        .filter((agent) => frozenScanPicks.has(agent.driverKind))
        .map((agent) => agent.definition.label)
    : [];

  let body: ReactNode;
  let footer: ReactNode;
  switch (step) {
    case "agents": {
      body = (
        <>
          <div className="flex flex-col items-center">
            <ThreadlinesFigure compact />
          </div>
          <StepHeading
            title="Which agents do you use?"
            lede={
              picks === null
                ? `Looking for agents on ${computerName}…`
                : isFirstRun
                  ? describeFoundAgents({ found: foundNames, computer: computerName })
                  : `Picked agents are turned on for ${computerName}. Change the picks to turn agents on or off.`
            }
          />
          <div className="mt-6 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((agent) => (
              <AgentTile
                key={agent.driverKind}
                agent={agent}
                picked={picks?.has(agent.driverKind) ?? false}
                computer={computer}
                onToggle={() => togglePick(agent.driverKind)}
              />
            ))}
          </div>
          <p className="mt-4 text-center text-xs text-muted-foreground/62">
            {isFirstRun && foundNames.length === 0 && picks !== null
              ? "Not sure where to start? OpenCode's free models work without an account."
              : "Agents you don't pick stay in Settings › Providers, ready to add later."}
          </p>
        </>
      );
      footer = (
        <>
          <span className="text-[12.5px] text-muted-foreground/62">
            {picks === null
              ? "Looking…"
              : picks.size === 0
                ? "Pick at least one agent"
                : `${picks.size} picked`}
          </span>
          <span className="flex-1" />
          <Button
            data-testid="setup-continue"
            disabled={picks === null || picks.size === 0 || saving}
            onClick={() => void continueFromAgents()}
          >
            {saving ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
            Continue
          </Button>
        </>
      );
      break;
    }
    case "connect": {
      body = (
        <>
          <StepHeading
            title="Connect your agents"
            lede="Install and sign in. Once one is ready you can keep going."
          />
          <div className="mt-6">
            <SectionLabel
              aside={`On ${computerName}`}
            >{`${pickedAgents.length} picked`}</SectionLabel>
            {pickedAgents.map((agent) => (
              <SetupAgentRow
                key={agent.driverKind}
                agent={agent}
                updateControls={updateRunner.controlsFor(agent.snapshot)}
              />
            ))}
          </div>
        </>
      );
      footer = (
        <>
          <Button variant="ghost" className="-ml-2.5" onClick={() => goTo("agents")}>
            Back
          </Button>
          <span className="min-w-0 truncate text-[12.5px] text-muted-foreground/62">
            {readyPicks === 0
              ? "Get one agent ready to continue."
              : readyPicks < pickedAgents.length
                ? `${readyPicks} of ${pickedAgents.length} ready. You can finish the rest later in Settings.`
                : pickedAgents.length === 1
                  ? "Ready."
                  : `All ${pickedAgents.length} ready.`}
          </span>
          <span className="flex-1" />
          <Button
            data-testid="setup-continue"
            disabled={readyPicks === 0}
            onClick={() => goTo("folder", { connectSkipped: false })}
          >
            Continue
          </Button>
        </>
      );
      break;
    }
    case "folder": {
      body = (
        <>
          <StepHeading
            title="Where do you want to work?"
            lede="Pick a folder with your code. Agents read and edit files inside it."
          />
          <div className="mt-6">
            <SectionLabel>Folder</SectionLabel>
            {project ? (
              <AgentRow
                data-testid="setup-folder-row"
                icon={<FolderIcon className="size-4 text-muted-foreground" aria-hidden />}
                name={project.name}
                status={isLaunchFolder ? "You started Threadlines from this folder." : project.cwd}
                actions={
                  <Button
                    size="xs"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={chooseFolder}
                  >
                    Change
                  </Button>
                }
              />
            ) : (
              <AgentRow
                data-testid="setup-folder-row"
                icon={<FolderIcon className="size-4 text-muted-foreground/55" aria-hidden />}
                name="No folder yet"
                status="Pick the project you want agents to work on."
                tone="warning"
                actions={
                  <Button size="xs" onClick={chooseFolder}>
                    Choose a folder
                  </Button>
                }
              />
            )}
            <div className="mt-7">
              <SectionLabel aside="GitHub is optional">Source control</SectionLabel>
              <SourceControlRows environmentId={environmentId} />
            </div>
          </div>
        </>
      );
      footer = (
        <>
          <Button
            variant="ghost"
            className="-ml-2.5"
            onClick={() => goTo(progress.connectSkipped ? "agents" : "connect")}
          >
            Back
          </Button>
          <span className="min-w-0 truncate text-[12.5px] text-muted-foreground/62">
            {!anyAgentReady
              ? "No agent is ready yet. Go back to connect one."
              : project
                ? ""
                : "Pick a folder to start."}
          </span>
          <span className="flex-1" />
          <Button data-testid="setup-start" disabled={!project || !anyAgentReady} onClick={finish}>
            Start first thread
          </Button>
        </>
      );
      break;
    }
  }

  return (
    <div
      className="flex h-dvh min-h-0 flex-col bg-background text-foreground"
      data-testid="agent-setup"
    >
      <header className="drag-region relative flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 border-b border-border/60 pr-[var(--workspace-controls-right)] pl-[var(--workspace-controls-left)]">
        <span className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
          <ThreadlinesGlyph aria-hidden="true" className="h-3 w-auto shrink-0" />
          {APP_BASE_NAME}
        </span>
        <div className="pointer-events-none absolute inset-x-0 hidden justify-center md:flex">
          <div className="pointer-events-auto">
            <StepIndicator
              step={step}
              connectSkipped={progress.connectSkipped}
              onGoTo={(target) => goTo(target)}
            />
          </div>
        </div>
        <span className="flex-1" />
        <Button
          size="xs"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          data-testid="setup-later"
          onClick={leave}
        >
          {gate === "pending" ? "Set up later" : "Close"}
        </Button>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-5 pt-10 pb-8 sm:px-10 sm:pt-12">
        <div className="mx-auto w-full max-w-[42rem]">{body}</div>
      </main>
      <footer className="flex h-15 shrink-0 justify-center border-t border-border/60 px-5 sm:px-10">
        <div className="flex w-full max-w-[42rem] items-center gap-3">{footer}</div>
      </footer>
    </div>
  );
}
