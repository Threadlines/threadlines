import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { PullRequestsView } from "../components/pull-requests/PullRequestsView";
import {
  DEFAULT_PULL_REQUEST_SORT,
  formatPullRequestSelection,
  parsePullRequestSelection,
  parsePullRequestsSearch,
  pullRequestFiltersFromSearch,
  pullRequestFiltersToSearch,
} from "../components/pull-requests/pullRequests.logic";

function PullRequestsRoute() {
  const search = Route.useSearch();
  const { state, pr } = search;
  const navigate = useNavigate();
  const selection = pr ? parsePullRequestSelection(pr) : null;
  // Held steady across renders, because the page memoizes the list it derives
  // from them and a fresh object every render would throw that away.
  const filters = useMemo(() => pullRequestFiltersFromSearch(search), [search]);
  const sort = search.sort ?? DEFAULT_PULL_REQUEST_SORT;
  // The narrowing travels with every navigation: it is how the user left the
  // page, and losing it on a tab press or an open row would read as a bug.
  const narrowing = pullRequestFiltersToSearch(filters, sort);

  return (
    <PullRequestsView
      state={state}
      selection={selection}
      filters={filters}
      sort={sort}
      onStateChange={(nextState) => {
        // Replace rather than push: flipping between Open and Merged is a view
        // change, not a place the back button should walk through. The open
        // pull request is dropped with it, since the row it came from is no
        // longer in the list.
        void navigate({
          to: "/pull-requests",
          search: { state: nextState, ...narrowing },
          replace: true,
        });
      }}
      onSelectionChange={(nextSelection) => {
        void navigate({
          to: "/pull-requests",
          search: {
            state,
            ...narrowing,
            ...(nextSelection ? { pr: formatPullRequestSelection(nextSelection) } : {}),
          },
          // Opening a pull request from the bare list is a step the back
          // button should undo: on a phone the detail stands in for the list,
          // and the back gesture is how people expect to get the list back.
          // Moving from one open pull request to another, or closing one, is
          // not a step worth keeping.
          replace: selection !== null || nextSelection === null,
        });
      }}
      onFiltersChange={(nextFilters) => {
        void navigate({
          to: "/pull-requests",
          search: {
            state,
            ...(pr ? { pr } : {}),
            ...pullRequestFiltersToSearch(nextFilters, sort),
          },
          replace: true,
        });
      }}
      onSortChange={(nextSort) => {
        void navigate({
          to: "/pull-requests",
          search: {
            state,
            ...(pr ? { pr } : {}),
            ...pullRequestFiltersToSearch(filters, nextSort),
          },
          replace: true,
        });
      }}
    />
  );
}

export const Route = createFileRoute("/_chat/pull-requests")({
  validateSearch: (search: Record<string, unknown>) => parsePullRequestsSearch(search),
  component: PullRequestsRoute,
});
