import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { PullRequestsView } from "../components/pull-requests/PullRequestsView";
import { parsePullRequestsSearch } from "../components/pull-requests/pullRequests.logic";

function PullRequestsRoute() {
  const { state } = Route.useSearch();
  const navigate = useNavigate();

  return (
    <PullRequestsView
      state={state}
      onStateChange={(nextState) => {
        // Replace rather than push: flipping between Open and Merged is a view
        // change, not a place the back button should walk through.
        void navigate({ to: "/pull-requests", search: { state: nextState }, replace: true });
      }}
    />
  );
}

export const Route = createFileRoute("/_chat/pull-requests")({
  validateSearch: (search: Record<string, unknown>) => parsePullRequestsSearch(search),
  component: PullRequestsRoute,
});
