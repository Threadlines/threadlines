/**
 * One-click provider install: what the button knows.
 *
 * A provider whose CLI is missing used to offer nothing but a link to the
 * vendor's install page. The server now derives an install command for it
 * (npm global, when npm is on the server's PATH) and runs it through the same
 * runner, lock, and progress state as an update, so the snapshot the browser
 * already streams carries everything a surface needs: whether an install is
 * offered at all, whether one is running, and why the last one failed.
 *
 * Both surfaces that show the action (the Providers settings page and the
 * setup screen) read it from here so they never disagree about whether a
 * provider can be installed.
 *
 * The same button reinstalls a CLI that is on the machine and cannot start
 * (an update that left a file out): the server says so with `runnable: false`
 * and offers the reinstall with `canRepair`.
 *
 * @module providerInstall
 */
import type { ServerProvider } from "@threadlines/contracts";

/** `incomplete`: the command finished cleanly but the CLI still is not visible. */
export type ProviderInstallStatus = "idle" | "running" | "failed" | "incomplete";

export interface ProviderInstallView {
  /** `reinstall`: the CLI is there but cannot start, and this puts it back. */
  readonly kind: "install" | "reinstall";
  /** The command the server will run, for display next to the action. */
  readonly command: string;
  readonly status: ProviderInstallStatus;
  /** The server's plain-language message about the last attempt. */
  readonly message: string | null;
  /** Last visible line of the command's output, when it failed. */
  readonly lastOutputLine: string | null;
}

function lastNonEmptyLine(value: string | null | undefined): string | null {
  const lines = (value ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines[lines.length - 1]! : null;
}

/** Which action the server offers for this provider and the command behind it. */
function offeredInstall(
  provider: ServerProvider,
): Pick<ProviderInstallView, "kind" | "command"> | null {
  const advisory = provider.versionAdvisory;
  if (!provider.installed) {
    return advisory?.canInstall === true && advisory.installCommand !== null
      ? { kind: "install", command: advisory.installCommand }
      : null;
  }
  return provider.runnable === false &&
    advisory?.canRepair === true &&
    advisory.updateCommand !== null
    ? { kind: "reinstall", command: advisory.updateCommand }
    : null;
}

/**
 * The install action for one provider, or null when there is nothing to
 * offer: the provider is disabled, its CLI is installed and starts, or the
 * server could not derive a command for this machine (no npm), in which case
 * the surface falls back to the provider's install guide.
 *
 * Progress rides on `updateState`, which the server writes for whichever
 * maintenance command is running. A provider that is missing or cannot start
 * has no update to offer, so an active state here is the install, or the
 * update that left the CLI unable to start.
 */
export function deriveProviderInstallView(
  provider: ServerProvider | undefined,
): ProviderInstallView | null {
  if (!provider || !provider.enabled) {
    return null;
  }
  const offered = offeredInstall(provider);
  if (!offered) {
    return null;
  }

  const status = provider.updateState?.status;
  return {
    ...offered,
    status:
      status === "queued" || status === "running"
        ? "running"
        : status === "failed"
          ? "failed"
          : // "unchanged" under a reinstall is an older update's verdict
            // (still outdated), not news about the CLI that cannot start.
            status === "unchanged" && offered.kind === "install"
            ? "incomplete"
            : "idle",
    message: provider.updateState?.message?.trim() || null,
    lastOutputLine: lastNonEmptyLine(provider.updateState?.output),
  };
}

/**
 * One line describing the run in progress or the one that failed, or null
 * when there is nothing to say. Every surface that shows it truncates.
 */
export function providerInstallStatusText(input: {
  readonly view: ProviderInstallView;
  readonly isStarting: boolean;
}): string | null {
  const reinstall = input.view.kind === "reinstall";
  if (input.view.status === "running" || input.isStarting) {
    // Some installers stay silent while they download (Cursor's takes about a
    // minute); without output, say so rather than look stuck.
    const doing = reinstall ? "Reinstalling…" : "Installing…";
    return input.view.lastOutputLine
      ? `${doing} ${input.view.lastOutputLine}`
      : `${doing} this can take a minute`;
  }
  if (input.view.status === "failed") {
    // The failed command may have been the update that broke the CLI, so a
    // reinstall says what is still true instead of naming a command.
    const failed = reinstall ? "Still can't start." : "Install failed.";
    const reason = input.view.lastOutputLine ?? input.view.message;
    return reason ? `${failed} ${reason}` : failed;
  }
  if (input.view.status === "incomplete") {
    // The installer's own last line ("Happy Coding") is not the story here:
    // the CLI landed somewhere this server's PATH does not see yet.
    return `${input.view.message ?? "Install finished, but the CLI is not visible yet."} Restart Threadlines and check again.`;
  }
  return null;
}

/** True while the surface should describe the install instead of offering it. */
export function isProviderInstallInFlight(input: {
  readonly view: ProviderInstallView;
  readonly isStarting: boolean;
}): boolean {
  return input.view.status === "running" || input.isStarting;
}
