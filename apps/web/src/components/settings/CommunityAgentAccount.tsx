/**
 * The Account tab of a community agent: the sign-in the agent itself offers,
 * run from Threadlines.
 *
 * An agent lists its sign-in methods; the server says how each can be run
 * (`AcpRegistrySignInMethod.kind`). The agent signs in by itself or through
 * its own login command, both through the sign-in panel; a key read from an
 * environment variable is set under Configuration; anything else the agent
 * handles on its own, and the tab says so.
 *
 * @module CommunityAgentAccount
 */
import type {
  AcpRegistrySignInMethod,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderCommunity,
} from "@threadlines/contracts";

import { openExternalUrl } from "../../lib/externalLinks";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ProviderConnectFlow } from "./ProviderConnectFlow";

const RUNNABLE_KINDS: ReadonlySet<AcpRegistrySignInMethod["kind"]> = new Set(["agent", "terminal"]);

/** The one-word state shown beside the sign-in button. "Ready" never claims "signed in". */
export function communityAgentAccountBadge(provider: ServerProvider | undefined): {
  readonly label: string;
  readonly variant: "success" | "warning" | "secondary";
} {
  if (!provider || provider.statusReason === "provider_probe_pending") {
    return { label: "Checking", variant: "secondary" };
  }
  if (provider.auth.status === "unauthenticated") {
    return { label: "Not signed in", variant: "warning" };
  }
  return provider.status === "ready"
    ? { label: "Ready", variant: "success" }
    : { label: "Not working", variant: "warning" };
}

/** What a method that Threadlines doesn't run says under its name. */
function passiveMethodNote(method: AcpRegistrySignInMethod, displayName: string): string {
  if (method.kind === "envVar") {
    return method.envVars.length > 0
      ? `Reads a key from ${method.envVars.join(", ")}. Set it under Configuration.`
      : "Reads a key from an environment variable. Set it under Configuration.";
  }
  return `${displayName} runs this sign-in itself.`;
}

export function CommunityAgentAccount(props: {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly liveProvider: ServerProvider | undefined;
  readonly community: ServerProviderCommunity;
  /** Saves the user's pick of method. */
  readonly onPickMethod: (methodId: string) => void;
  readonly onOpenConfiguration: () => void;
  /**
   * Set when this client isn't on the computer the agent runs on: a sign-in
   * whose browser page answers to that computer can only be finished there.
   */
  readonly remoteComputerName?: string | undefined;
  readonly signInHandoffActive?: boolean;
}) {
  const { community, displayName, liveProvider } = props;
  const { methods, selected, canSignOut } = community.signIn;
  const runnable = methods.filter((method) => RUNNABLE_KINDS.has(method.kind));
  const selectedMethod = runnable.find((method) => method.id === selected);
  const badge = communityAgentAccountBadge(liveProvider);
  const needsSignIn = liveProvider?.auth.status === "unauthenticated";
  const site = community.website ?? community.repository;

  if (liveProvider?.enabled === false) {
    return <p className="text-xs text-muted-foreground">Turn {displayName} on to sign in.</p>;
  }
  if (liveProvider?.installed === false) {
    return (
      <p className="text-xs text-muted-foreground">
        Install {displayName} first, then sign in here.
      </p>
    );
  }

  return (
    <div className="grid gap-4">
      {methods.length === 0 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <Badge variant={badge.variant} size="sm">
            {badge.label}
          </Badge>
          <span className="min-w-0 text-muted-foreground">
            {displayName} hasn't said how it signs in. If it is ready, there is nothing to do.
          </span>
        </div>
      ) : null}

      {methods.length > 1 || (methods.length === 1 && !selectedMethod) ? (
        <ul className="grid gap-2" aria-label={`${displayName} sign-in methods`}>
          {methods.map((method) => {
            const canRun = RUNNABLE_KINDS.has(method.kind);
            const isSelected = method.id === selected;
            return (
              <li key={method.id} className="flex min-w-0 items-start gap-2.5 text-xs">
                <input
                  type="radio"
                  className="mt-0.5 size-3.5 shrink-0 accent-primary"
                  name={`community-sign-in-${props.instanceId}`}
                  checked={isSelected}
                  disabled={!canRun}
                  onChange={() => props.onPickMethod(method.id)}
                  aria-label={method.name}
                />
                <div className="min-w-0">
                  <div className={canRun ? "text-foreground" : "text-muted-foreground"}>
                    {method.name}
                  </div>
                  {method.description ? (
                    <div className="text-muted-foreground">{method.description}</div>
                  ) : null}
                  {canRun ? null : (
                    <div className="text-muted-foreground">
                      {passiveMethodNote(method, displayName)}{" "}
                      {method.kind === "envVar" ? (
                        <button
                          type="button"
                          className="text-foreground underline-offset-2 hover:text-primary-readable hover:underline"
                          onClick={props.onOpenConfiguration}
                        >
                          Open Configuration
                        </button>
                      ) : null}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {selectedMethod ? (
        <ProviderConnectFlow
          instanceId={props.instanceId}
          flow="login"
          displayName={displayName}
          actionLabel={needsSignIn ? "Sign in" : "Sign in again"}
          command={selectedMethod.name}
          surface={selectedMethod.kind === "terminal" ? "terminal" : "browser"}
          // A login command is typed into: its terminal shows from the start.
          autoShowTerminal={
            selectedMethod.kind === "terminal" || (props.signInHandoffActive ?? false)
          }
          runningHint={
            props.remoteComputerName
              ? `You may need to finish signing in on ${props.remoteComputerName}.`
              : selectedMethod.kind === "terminal"
                ? "Follow the steps in the terminal below."
                : `Finish signing in wherever ${displayName} opened it.`
          }
          buttonVariant={needsSignIn ? "default" : "ghost"}
          description={methods.length === 1 ? (selectedMethod.description ?? undefined) : undefined}
          statusRow={
            <Badge variant={badge.variant} size="sm">
              {badge.label}
            </Badge>
          }
        />
      ) : methods.length > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <Badge variant={badge.variant} size="sm">
            {badge.label}
          </Badge>
          <span className="min-w-0 text-muted-foreground">{displayName} signs in its own way.</span>
          {site ? (
            <Button
              size="xs"
              variant="outline"
              className="h-6 px-2 text-xs"
              onClick={() => openExternalUrl(site)}
            >
              Open its website
            </Button>
          ) : null}
        </div>
      ) : null}

      {canSignOut ? (
        <ProviderConnectFlow
          instanceId={props.instanceId}
          flow="logout"
          displayName={displayName}
          actionLabel="Sign out"
          command="Sign out"
          surface="browser"
          buttonVariant="ghost"
        />
      ) : null}
    </div>
  );
}

/** A community agent's About block: who made it, where it came from, how it was checked. */
export function CommunityAgentAbout(props: {
  readonly community: ServerProviderCommunity;
  readonly version: string | null | undefined;
}) {
  const { community } = props;
  const rows: Array<readonly [string, string]> = [];
  if (community.authors.length > 0) rows.push(["Made by", community.authors.join(", ")]);
  rows.push([
    "Source",
    community.source === "npm"
      ? `npm${community.packageSpec ? `, ${community.packageSpec}` : ""}`
      : `Download${community.host ? ` from ${community.host}` : ""}`,
  ]);
  if (props.version) rows.push(["Version", props.version]);
  if (community.verification) {
    rows.push([
      "Checked",
      community.verification === "publisher"
        ? "Against the publisher's checksum"
        : community.verification === "packageRegistry"
          ? "By npm's package hashes"
          : "Against the hash recorded when it was first installed",
    ]);
  }
  const links: Array<readonly [string, string]> = [];
  if (community.website) links.push(["Website", community.website]);
  if (community.repository) links.push(["Repository", community.repository]);

  return (
    <div className="grid gap-2 text-xs">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      {community.reportedVersionChanged ? (
        <p className="text-muted-foreground">
          This agent has updated itself since you installed it. Threadlines didn't make that change.
        </p>
      ) : null}
      {links.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {links.map(([label, url]) => (
            <Button
              key={label}
              size="xs"
              variant="outline"
              className="h-6 px-2 text-xs"
              // Registry links are https only (the server drops the rest).
              onClick={() => openExternalUrl(url)}
            >
              {label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
