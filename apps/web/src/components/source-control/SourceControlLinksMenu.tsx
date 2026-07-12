import { ChevronDownIcon, GitBranchIcon, GitPullRequestIcon, WorkflowIcon } from "lucide-react";

import type { SourceControlQuickLinks } from "~/lib/sourceControlQuickLinks";
import { readLocalApi } from "~/localApi";
import {
  getSourceControlPresentation,
  resolveChangeRequestPresentation,
} from "~/sourceControlPresentation";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

function openExternalUrl(url: string) {
  const api = readLocalApi();
  if (!api) return;
  void api.shell.openExternal(url);
}

function sentenceCase(value: string): string {
  return value.length > 0 ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

export function SourceControlLinksMenu({ links }: { links: SourceControlQuickLinks }) {
  const { automation, changeRequest, changeRequests, currentBranch } = links;
  const presentation = getSourceControlPresentation(links.provider);
  const { Icon } = presentation;
  const changeRequestName = sentenceCase(presentation.terminology.singular);
  const changeRequestsName = sentenceCase(
    resolveChangeRequestPresentation(links.provider).pluralLongName,
  );

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={`${presentation.providerName} links`}
            title={presentation.providerName}
            className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm border border-border/70 bg-muted/45 px-1 py-0.5 leading-none text-muted-foreground/80 transition-colors hover:border-border hover:bg-muted/70 hover:text-foreground"
          />
        }
      >
        <Icon aria-hidden="true" className="size-3 shrink-0" />
        <ChevronDownIcon aria-hidden="true" className="size-2.5 shrink-0 opacity-70" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => openExternalUrl(links.repository)}>
          <Icon aria-hidden="true" className="text-muted-foreground" />
          Repository
        </MenuItem>
        {changeRequest ? (
          <MenuItem onClick={() => openExternalUrl(changeRequest.url)}>
            <GitPullRequestIcon aria-hidden="true" className="text-muted-foreground" />
            {`${changeRequestName} #${changeRequest.number}`}
          </MenuItem>
        ) : changeRequests ? (
          <MenuItem onClick={() => openExternalUrl(changeRequests)}>
            <GitPullRequestIcon aria-hidden="true" className="text-muted-foreground" />
            {changeRequestsName}
          </MenuItem>
        ) : null}
        {automation ? (
          <MenuItem onClick={() => openExternalUrl(automation.url)}>
            <WorkflowIcon aria-hidden="true" className="text-muted-foreground" />
            {automation.label}
          </MenuItem>
        ) : null}
        {currentBranch !== null && (
          <MenuItem onClick={() => openExternalUrl(currentBranch)}>
            <GitBranchIcon aria-hidden="true" className="text-muted-foreground" />
            {`Branch on ${presentation.providerName}`}
          </MenuItem>
        )}
      </MenuPopup>
    </Menu>
  );
}
