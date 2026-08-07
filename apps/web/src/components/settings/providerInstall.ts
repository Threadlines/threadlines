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
 * Both surfaces that show the action (the settings provider card and the
 * first-run setup card) read it from here so they never disagree about
 * whether a provider can be installed.
 *
 * @module providerInstall
 */
import type { ServerProvider } from "@threadlines/contracts";

export type ProviderInstallStatus = "idle" | "running" | "failed";

export interface ProviderInstallView {
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

/**
 * The install action for one provider, or null when there is nothing to
 * offer: the provider is disabled, its CLI is already installed, or the
 * server could not derive an install command for this machine (no npm), in
 * which case the surface falls back to the provider's install guide.
 *
 * Install progress rides on `updateState`, which the server writes for
 * whichever maintenance command is running. A provider that is not installed
 * has no update to run, so an active state here is always the install.
 */
export function deriveProviderInstallView(
  provider: ServerProvider | undefined,
): ProviderInstallView | null {
  const command = provider?.versionAdvisory?.installCommand ?? null;
  if (
    !provider ||
    !provider.enabled ||
    provider.installed ||
    provider.versionAdvisory?.canInstall !== true ||
    command === null
  ) {
    return null;
  }

  const status = provider.updateState?.status;
  return {
    command,
    status:
      status === "queued" || status === "running"
        ? "running"
        : status === "failed" || status === "unchanged"
          ? "failed"
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
  if (input.view.status === "running" || input.isStarting) {
    return input.view.lastOutputLine ? `Installing… ${input.view.lastOutputLine}` : "Installing…";
  }
  if (input.view.status === "failed") {
    const reason = input.view.lastOutputLine ?? input.view.message;
    return reason ? `Install failed. ${reason}` : "Install failed.";
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
