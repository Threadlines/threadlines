import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AzureDevOpsPullRequestProvider from "./AzureDevOpsPullRequestProvider.ts";
import * as BitbucketPullRequestProvider from "./BitbucketPullRequestProvider.ts";
import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";
import * as GitLabPullRequestProvider from "./GitLabPullRequestProvider.ts";
import { fromProviders, PullRequestProviderRegistry } from "./PullRequestProvider.ts";

/**
 * The hosts this build reads pull requests from. A project on a host with no
 * entry here is skipped by the listing rather than reported as a failure, which
 * is what a repository on an unrecognised remote gets.
 */
export const make = Effect.map(
  Effect.all(
    [
      GitHubPullRequestProvider.make(),
      GitLabPullRequestProvider.make(),
      BitbucketPullRequestProvider.make(),
      AzureDevOpsPullRequestProvider.make(),
    ],
    { concurrency: 1 },
  ),
  (providers) => fromProviders(providers),
);

export const layer = Layer.effect(PullRequestProviderRegistry, make);
