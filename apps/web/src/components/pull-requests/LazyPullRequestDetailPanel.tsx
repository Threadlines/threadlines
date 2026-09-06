import { Suspense, lazy } from "react";

import type { PullRequestDetailPanelProps } from "./PullRequestDetailPanel";
import { PullRequestDetailSkeleton } from "./pullRequestPresentation";

/**
 * The detail panel pulls in the diff viewer, which is the heaviest chunk in
 * the app and is already kept out of the main bundle for the Diff tab. Both
 * hosts open the panel on a click, so the chunk is fetched then rather than
 * paid for by every session that never looks at a pull request.
 */
const PullRequestDetailPanel = lazy(async () => {
  const module = await import("./PullRequestDetailPanel");
  return { default: module.PullRequestDetailPanel };
});

export function LazyPullRequestDetailPanel(props: PullRequestDetailPanelProps) {
  return (
    <Suspense
      // The same skeleton the panel itself draws while it reads, so the wait
      // for the chunk and the wait for the host look like one wait.
      fallback={
        <PullRequestDetailSkeleton
          {...(props.context === "page" && props.onClose ? { onClose: props.onClose } : {})}
        />
      }
    >
      <PullRequestDetailPanel {...props} />
    </Suspense>
  );
}
