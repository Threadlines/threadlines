import { ChevronDownIcon, GitBranchIcon, GitPullRequestIcon, WorkflowIcon } from "lucide-react";

import type { GitHubQuickLinks } from "~/lib/gitHubQuickLinks";
import { readLocalApi } from "~/localApi";
import { GitHubIcon } from "../Icons";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

function openExternalUrl(url: string) {
  const api = readLocalApi();
  if (!api) return;
  void api.shell.openExternal(url);
}

export function GitHubLinksMenu({ links }: { links: GitHubQuickLinks }) {
  const { pr, currentBranch } = links;

  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label="GitHub links"
            title="GitHub"
            className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm border border-border/70 bg-muted/45 px-1 py-0.5 leading-none text-muted-foreground/80 transition-colors hover:border-border hover:bg-muted/70 hover:text-foreground"
          />
        }
      >
        <GitHubIcon aria-hidden="true" className="size-3 shrink-0" />
        <ChevronDownIcon aria-hidden="true" className="size-2.5 shrink-0 opacity-70" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => openExternalUrl(links.repository)}>
          <GitHubIcon aria-hidden="true" className="text-muted-foreground" />
          Repository
        </MenuItem>
        {pr ? (
          <MenuItem onClick={() => openExternalUrl(pr.url)}>
            <GitPullRequestIcon aria-hidden="true" className="text-muted-foreground" />
            {`Pull request #${pr.number}`}
          </MenuItem>
        ) : (
          <MenuItem onClick={() => openExternalUrl(links.pullRequests)}>
            <GitPullRequestIcon aria-hidden="true" className="text-muted-foreground" />
            Pull requests
          </MenuItem>
        )}
        <MenuItem onClick={() => openExternalUrl(links.actions)}>
          <WorkflowIcon aria-hidden="true" className="text-muted-foreground" />
          Actions
        </MenuItem>
        {currentBranch !== null && (
          <MenuItem onClick={() => openExternalUrl(currentBranch)}>
            <GitBranchIcon aria-hidden="true" className="text-muted-foreground" />
            Branch on GitHub
          </MenuItem>
        )}
      </MenuPopup>
    </Menu>
  );
}
