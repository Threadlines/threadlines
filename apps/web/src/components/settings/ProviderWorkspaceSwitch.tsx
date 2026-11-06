/**
 * The Workspace row of a provider's Account & Sign-in: which of the sign-in's
 * workspaces the agent uses (Codex's ChatGPT workspaces), and a switch to
 * another. The switch runs as the `switch-workspace` sign-in flow, so it gets
 * the sign-in panel's progress line, Cancel, and the browser step a workspace
 * behind company sign-on asks for.
 *
 * @module ProviderWorkspaceSwitch
 */
import type { ProviderInstanceId, ServerProvider } from "@threadlines/contracts";
import { useState } from "react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ProviderConnectFlow } from "./ProviderConnectFlow";
import { switchableWorkspaces, workspaceDisplayName } from "./providerWorkspaces.logic";

export function ProviderWorkspaceSwitch(props: {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly provider: ServerProvider;
}) {
  // The workspace picked to switch to; the current one until the user picks.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const workspaces = switchableWorkspaces(props.provider.auth);
  if (!workspaces) return null;
  const selected =
    workspaces.find((workspace) => workspace.id === pickedId) ??
    workspaces.find((workspace) => workspace.current) ??
    null;

  return (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium text-foreground">Workspace</span>
      <ProviderConnectFlow
        instanceId={props.instanceId}
        flow="switch-workspace"
        displayName={props.displayName}
        actionLabel="Switch"
        command=""
        surface="browser"
        offerCommandFallback={false}
        buttonVariant="outline"
        workspaceId={selected?.id}
        actionDisabled={!selected || selected.current}
        description={`${props.displayName} chats use this workspace's plan. Switching stops any ${props.displayName} chat that's running.`}
        statusRow={
          <Select value={selected?.id ?? null} onValueChange={(value) => setPickedId(value)}>
            <SelectTrigger size="xs" className="w-auto min-w-36 max-w-64" aria-label="Workspace">
              <SelectValue>
                {selected ? workspaceDisplayName(selected) : "Pick a workspace"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false} popupClassName="max-w-72">
              {workspaces.map((workspace) => (
                <SelectItem key={workspace.id} value={workspace.id}>
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="min-w-0 flex-1 truncate">
                      {workspaceDisplayName(workspace)}
                    </span>
                    {workspace.current ? (
                      <span className="text-xs text-muted-foreground">In use</span>
                    ) : null}
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </div>
  );
}
