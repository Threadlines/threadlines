/**
 * The workspaces a provider's sign-in can switch between (Codex's ChatGPT
 * workspaces, `ServerProviderAuth.workspaces`), in the words Settings shows.
 *
 * @module providerWorkspaces.logic
 */
import type { ServerProviderAuth, ServerProviderWorkspace } from "@threadlines/contracts";

/** A workspace's name on screen: its own, or "Personal" for an unnamed personal one. */
export function workspaceDisplayName(workspace: ServerProviderWorkspace): string {
  const name = workspace.name?.trim();
  if (name) return name;
  return workspace.kind === "personal" ? "Personal" : "Unnamed workspace";
}

/**
 * The workspaces a signed-in provider can switch between, or null when there
 * is nothing to switch to (one workspace, none reported, or signed out).
 */
export function switchableWorkspaces(
  auth: ServerProviderAuth | undefined,
): ReadonlyArray<ServerProviderWorkspace> | null {
  if (auth?.status !== "authenticated") return null;
  const workspaces = auth.workspaces;
  return workspaces && workspaces.length >= 2 ? workspaces : null;
}

/** The workspace in use, named for the provider's row, when there are others to tell it from. */
export function currentWorkspaceName(auth: ServerProviderAuth | undefined): string | null {
  const current = switchableWorkspaces(auth)?.find((workspace) => workspace.current);
  return current ? workspaceDisplayName(current) : null;
}
