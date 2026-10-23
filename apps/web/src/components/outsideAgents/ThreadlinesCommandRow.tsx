/**
 * The "Threadlines command" row in Settings › Connections › Agents
 * (docs/design/outside-agents.md, "Putting it on PATH"): the desktop app puts
 * its `threadlines` command on PATH, for scripts and for agents that run
 * shell commands but don't speak MCP. Not installed (Install), installed here
 * (Remove), or pointing at another copy of Threadlines (Install again). A dev
 * build shows how to run it from the repo instead. Only the desktop app can
 * install it; elsewhere the row isn't shown.
 */
import type { DesktopCliCommandResult, DesktopCliCommandStatus } from "@threadlines/contracts";
import { useEffect, useState } from "react";

import { CopyButton } from "../CopyButton";
import { SettingsRow } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

const TITLE = "Threadlines command";

function describeStatus(status: DesktopCliCommandStatus): string {
  switch (status.state) {
    case "not_installed":
      return `Start and follow threads from a terminal or a script. Install puts it at ${status.path}.`;
    case "installed":
      return status.folderOnPath
        ? `Installed at ${status.path}. Run threadlines connect in a new terminal to sign it in.`
        : `Installed at ${status.path}, but that folder isn't on your PATH. Add it, then run threadlines connect.`;
    case "other_copy":
      return `${status.path} points at another copy of Threadlines.`;
    case "unavailable":
      return status.reason ?? "This build can't install it.";
  }
}

export function ThreadlinesCommandRow() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const [status, setStatus] = useState<DesktopCliCommandStatus | null>(null);
  const [working, setWorking] = useState<"install" | "remove" | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.desktopBridge
      ?.getCliCommandStatus?.()
      .then((loaded) => {
        if (!cancelled) setStatus(loaded);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const install = bridge?.installCliCommand;
  const remove = bridge?.removeCliCommand;
  if (status === null || install === undefined || remove === undefined) return null;

  const run = async (action: "install" | "remove") => {
    setWorking(action);
    let result: DesktopCliCommandResult | null = null;
    try {
      result = await (action === "install" ? install() : remove());
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Couldn't ${action} the threadlines command`,
          description: error instanceof Error ? error.message : undefined,
        }),
      );
    } finally {
      setWorking(null);
    }
    if (result === null) return;
    setStatus(result.status);
    if (result.outcome === "failed") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Couldn't ${action} the threadlines command`,
          description: result.detail ?? undefined,
        }),
      );
    }
  };

  if (status.state === "unavailable" && status.devCommand !== null) {
    return (
      <SettingsRow
        data-testid="threadlines-command"
        title={TITLE}
        description={
          <>
            This is a dev build, so run it from the repo:
            <code className="block font-mono text-[11.5px] leading-[17px] wrap-anywhere text-foreground select-text">
              {status.devCommand}
            </code>
          </>
        }
        control={<CopyButton value={status.devCommand} label="Copy the command for a dev build" />}
      />
    );
  }

  const button =
    status.state === "installed" ? (
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={working !== null}
        onClick={() => void run("remove")}
      >
        {working === "remove" ? "Removing…" : "Remove"}
      </Button>
    ) : status.state === "unavailable" ? null : (
      <Button
        size="xs"
        variant="outline"
        disabled={working !== null}
        onClick={() => void run("install")}
      >
        {working === "install"
          ? "Installing…"
          : status.state === "other_copy"
            ? "Install again"
            : "Install"}
      </Button>
    );

  return (
    <SettingsRow
      data-testid="threadlines-command"
      title={TITLE}
      description={describeStatus(status)}
      control={button}
    />
  );
}
