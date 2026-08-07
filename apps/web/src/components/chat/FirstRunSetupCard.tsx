/**
 * The first thing a brand-new install sees, in place of the empty draft
 * thread's usual "What's next in ...?" prompt.
 *
 * It is the same provider data the settings page shows, with the fix action on
 * the row instead of two clicks away, plus the folder the server bootstrapped
 * from. Rows are live: provider snapshots stream in over providers-updated
 * events, so a dot flips from amber to green while the sign-in terminal is
 * still open, and "Start first thread" enables at the same moment.
 *
 * No container: typography, spacing, and hairline dividers on the empty
 * canvas, matching the rest of the app.
 *
 * @module FirstRunSetupCard
 */
import type { EnvironmentId } from "@threadlines/contracts";
import { Link } from "@tanstack/react-router";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import { riseDelay, ThreadlinesFigure } from "../ThreadlinesFigure";
import { Button } from "../ui/button";
import {
  buildFirstRunSetupDismissalKey,
  canStartFirstThread,
  deriveFirstRunProjectRow,
  deriveFirstRunProviderRows,
  dismissFirstRunSetup,
  groupFirstRunProviderRows,
  isFirstRunSetupDismissed,
  type FirstRunProviderRow,
  type FirstRunSetupProvider,
} from "./firstRunSetup";

/**
 * Reads the environment's dismissal once and re-reads it after this hook
 * writes one, so "Skip for now" hides the card in the same tick. Callers that
 * dismiss on another path (a send) go through the returned `dismiss` too,
 * which keeps the render in step with storage.
 */
export function useFirstRunSetupDismissal(environmentId: EnvironmentId | null | undefined): {
  readonly isDismissed: boolean;
  readonly dismiss: () => void;
} {
  const dismissalKey = environmentId ? buildFirstRunSetupDismissalKey(environmentId) : null;
  const [dismissedKeys, setDismissedKeys] = useState<ReadonlyArray<string>>(() =>
    dismissalKey !== null && isFirstRunSetupDismissed(dismissalKey) ? [dismissalKey] : [],
  );

  const dismiss = useCallback(() => {
    if (dismissalKey === null) {
      return;
    }
    dismissFirstRunSetup(dismissalKey);
    setDismissedKeys((current) =>
      current.includes(dismissalKey) ? current : [...current, dismissalKey],
    );
  }, [dismissalKey]);

  // Re-read storage when the key changes (environment switch) rather than on
  // every render: this hook lives in the chat view's render path.
  const isDismissed = useMemo(
    () =>
      dismissalKey !== null &&
      (dismissedKeys.includes(dismissalKey) || isFirstRunSetupDismissed(dismissalKey)),
    [dismissalKey, dismissedKeys],
  );

  return { isDismissed, dismiss };
}

function SetupRow({
  rowId,
  state,
  dotClassName,
  name,
  versionLabel,
  description,
  action,
}: {
  rowId: string;
  state: string;
  dotClassName: string;
  name: string;
  versionLabel?: string | null;
  description: ReactNode;
  action: ReactNode;
}) {
  return (
    <li
      className="flex items-center gap-3 border-b border-border py-3.5"
      data-testid="first-run-setup-row"
      data-row-id={rowId}
      data-row-state={state}
    >
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", dotClassName)}
        data-testid="first-run-setup-dot"
        data-row-state={state}
      />
      <span className="w-20 shrink-0 truncate text-sm font-medium text-foreground">{name}</span>
      {versionLabel ? (
        <span className="-ml-1.5 shrink-0 font-mono text-[11px] text-muted-foreground/62">
          {versionLabel}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 text-[13px] text-muted-foreground">{description}</span>
      <span className="shrink-0">{action}</span>
    </li>
  );
}

function providerRowAction(
  row: FirstRunProviderRow,
  onSignIn: (row: FirstRunProviderRow) => void,
): ReactNode {
  if (row.state === "ready") {
    return null;
  }
  if (row.state === "needsSignIn" && row.signInCommand) {
    return (
      <Button
        size="xs"
        aria-label={`Sign in to ${row.name}`}
        onClick={() => onSignIn(row)}
        tooltip={`Runs ${row.signInCommand} in this thread's terminal`}
      >
        Sign in
      </Button>
    );
  }
  return (
    <Button
      size="xs"
      variant="outline"
      aria-label={`Open the ${row.name} install guide`}
      render={<Link to="/settings/providers" />}
    >
      Install guide
    </Button>
  );
}

export interface FirstRunSetupCardProps {
  /** Enabled and disabled instances alike; disabled ones are filtered out. */
  readonly providers: ReadonlyArray<FirstRunSetupProvider>;
  readonly projectName: string | null;
  readonly projectCwd: string | null;
  /** Where the project lives; lets the row show its favicon like every other project selector. */
  readonly projectEnvironmentId: EnvironmentId | null;
  /** True when this is the workspace's only project, i.e. the launch folder. */
  readonly isOnlyWorkspaceProject: boolean;
  readonly onSignIn: (row: FirstRunProviderRow) => void;
  readonly onChooseProject: () => void;
  readonly onSkip: () => void;
  readonly onStart: () => void;
}

export function FirstRunSetupCard({
  providers,
  projectName,
  projectCwd,
  projectEnvironmentId,
  isOnlyWorkspaceProject,
  onSignIn,
  onChooseProject,
  onSkip,
  onStart,
}: FirstRunSetupCardProps) {
  const providerRows = useMemo(() => deriveFirstRunProviderRows(providers), [providers]);
  const providerRowGroups = useMemo(() => groupFirstRunProviderRows(providerRows), [providerRows]);
  const projectRow = useMemo(
    () => deriveFirstRunProjectRow({ projectName, projectCwd, isOnlyWorkspaceProject }),
    [isOnlyWorkspaceProject, projectCwd, projectName],
  );
  const canStart = canStartFirstThread({ providerRows, projectRow });
  const projectDescription: ReactNode =
    projectRow.state === "ready" && projectCwd && projectEnvironmentId ? (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <ProjectFavicon cwd={projectCwd} environmentId={projectEnvironmentId} />
        <span className="min-w-0 truncate">{projectRow.description}</span>
      </span>
    ) : (
      projectRow.description
    );

  return (
    <div
      className="flex w-full max-w-140 flex-col items-center pb-10"
      data-testid="first-run-setup-card"
    >
      <ThreadlinesFigure compact />
      <h2
        className="no-thread-rise text-[19px] font-semibold tracking-tight text-foreground"
        style={riseDelay("0.16s")}
      >
        Set up Threadlines
      </h2>
      <p
        className="no-thread-rise mt-1 text-[13.5px] text-muted-foreground"
        style={riseDelay("0.24s")}
      >
        Connect a coding agent and pick a folder. Rows update live as you go.
      </p>

      <ul className="no-thread-rise mt-6 w-full border-t border-border" style={riseDelay("0.32s")}>
        {providerRowGroups.visible.map((row) => (
          <SetupRow
            key={row.instanceId}
            rowId={String(row.instanceId)}
            state={row.state}
            dotClassName={row.dotClassName}
            name={row.name}
            versionLabel={row.versionLabel}
            description={row.description}
            action={providerRowAction(row, onSignIn)}
          />
        ))}
        {providerRowGroups.overflow ? (
          <SetupRow
            rowId="more-agents"
            state="overflow"
            dotClassName="bg-muted-foreground/55"
            name="More agents"
            description={`${providerRowGroups.overflow
              .map((row) => row.name)
              .join(", ")} · set up from Settings`}
            action={
              <Button
                size="xs"
                variant="outline"
                aria-label="Open provider settings for more agents"
                render={<Link to="/settings/providers" />}
              >
                Open Settings
              </Button>
            }
          />
        ) : null}
        <SetupRow
          rowId="project"
          state={projectRow.state}
          dotClassName={projectRow.dotClassName}
          name="Project"
          description={projectDescription}
          action={
            projectRow.state === "ready" ? (
              <Button
                size="xs"
                variant="ghost"
                className="text-muted-foreground hover:text-foreground"
                onClick={onChooseProject}
              >
                {projectRow.actionLabel}
              </Button>
            ) : (
              <Button size="xs" onClick={onChooseProject}>
                {projectRow.actionLabel}
              </Button>
            )
          }
        />
      </ul>

      <div
        className="no-thread-rise mt-5 flex w-full flex-wrap items-center justify-between gap-3"
        style={riseDelay("0.4s")}
      >
        <span className="text-xs text-muted-foreground/62">
          You can start once one agent is signed in.
        </span>
        <span className="flex items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
            data-testid="first-run-setup-skip"
            onClick={onSkip}
          >
            Skip for now
          </Button>
          <Button
            size="xs"
            disabled={!canStart}
            data-testid="first-run-setup-start"
            onClick={onStart}
          >
            Start first thread
          </Button>
        </span>
      </div>
    </div>
  );
}
