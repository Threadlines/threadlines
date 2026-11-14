/**
 * Two read-only lines of a provider's Account & Sign-in, both in the agent's
 * own words: the model provider its chats run on when that is not its maker's
 * service (a gateway in Codex's config), and a security notice its service
 * has for the signed-in account.
 *
 * @module ProviderAccountNotes
 */
import type { ServerProvider } from "@threadlines/contracts";
import { ExternalLinkIcon } from "lucide-react";

import { openExternalUrl } from "../../lib/externalLinks";
import { Button } from "../ui/button";

/** The short words a provider's row adds when its chats run on a gateway. */
export function providerRunsOnText(provider: ServerProvider | undefined): string | null {
  const name = provider?.auth.modelProvider?.name;
  return name ? `Runs on ${name}` : null;
}

/** Where the agent's chats run, when that is somewhere other than its maker's service. */
export function ProviderModelProviderRow(props: {
  readonly displayName: string;
  readonly provider: ServerProvider;
}) {
  const modelProvider = props.provider.auth.modelProvider;
  if (!modelProvider) return null;
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <span className="text-xs font-medium text-foreground">Model provider</span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {props.displayName} chats run on this provider. It's set in {props.displayName}'s own
          config.
        </span>
      </div>
      <span className="max-w-[50%] shrink-0 truncate text-xs text-foreground">
        {modelProvider.name}
      </span>
    </div>
  );
}

/**
 * A notice's link, opened only when it is an https page. The server already
 * keeps it to the provider's own sites; this guards a server that doesn't.
 */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** What the provider's service asks the signed-in person to do about their account. */
export function ProviderSecurityNoticeRow(props: { readonly provider: ServerProvider }) {
  const notice = props.provider.auth.securityNotice;
  if (!notice) return null;
  const action = notice.action && isHttpsUrl(notice.action.url) ? notice.action : null;
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <span className="text-xs font-medium text-foreground">{notice.title}</span>
        {notice.description ? (
          <span className="mt-1 block text-xs text-muted-foreground">{notice.description}</span>
        ) : null}
      </div>
      {action ? (
        <Button
          size="xs"
          variant="outline"
          className="shrink-0"
          onClick={() => openExternalUrl(action.url)}
        >
          <ExternalLinkIcon className="size-3" />
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
