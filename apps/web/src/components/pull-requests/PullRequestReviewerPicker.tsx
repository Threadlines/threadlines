/**
 * Asking someone for a review, from the row that says who is already
 * reviewing. Checking a name asks; unchecking takes the ask back.
 *
 * The people who may be asked are read only once this opens: on a large
 * repository that is everyone with access, which is worth a request when
 * somebody wants it and worth nothing on every pull request they merely open.
 */
import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestReviewerCandidate,
} from "@threadlines/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, UserPlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  pullRequestReviewerCandidatesQueryOptions,
  pullRequestReviewerRequestMutationOptions,
} from "../../lib/pullRequestsReactQuery";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Skeleton } from "../ui/skeleton";

/** Narrows what arrived; the host is asked once, when the picker opens. */
function matches(candidate: PullRequestReviewerCandidate, query: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLowerCase();
  return (
    candidate.login.toLowerCase().includes(needle) ||
    (candidate.name ?? "").toLowerCase().includes(needle)
  );
}

export function PullRequestReviewerPicker({
  environmentId,
  reference,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const candidates = useQuery({
    ...pullRequestReviewerCandidatesQueryOptions({ environmentId, reference }),
    enabled: open,
  });
  const request = useMutation(
    pullRequestReviewerRequestMutationOptions({ environmentId, reference, queryClient }),
  );

  const rows = useMemo(
    () => (candidates.data?.candidates ?? []).filter((entry) => matches(entry, query)),
    [candidates.data, query],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground/70"
            data-testid="pull-request-request-reviewers"
          >
            <UserPlusIcon aria-hidden />
            Request
          </Button>
        }
      />
      <PopoverPopup
        align="end"
        className="w-72"
        viewportClassName="p-0 [--viewport-inline-padding:0px]"
      >
        <div className="border-b border-border p-2">
          <Input
            autoFocus
            size="sm"
            value={query}
            placeholder="Search people with access"
            aria-label="Search people with access"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {candidates.isPending ? (
            <div className="flex flex-col gap-2 p-2" role="status" aria-label="Loading people">
              <Skeleton className="h-2.5 w-32 rounded-full" />
              <Skeleton className="h-2.5 w-24 rounded-full" />
            </div>
          ) : candidates.isError ? (
            <p className="p-2 text-xs text-muted-foreground/60">
              The people with access could not be read.
            </p>
          ) : rows.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground/55">
              {query.length > 0
                ? "Nobody with access matches that."
                : "Nobody else has access to this repository."}
            </p>
          ) : (
            rows.map((candidate) => (
              <button
                key={`${candidate.kind}:${candidate.id}`}
                type="button"
                disabled={request.isPending}
                aria-pressed={candidate.requested}
                aria-label={
                  candidate.requested
                    ? `Remove review request from ${candidate.login}`
                    : `Request review from ${candidate.login}`
                }
                className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent focus-ring disabled:opacity-60"
                onClick={() =>
                  request.mutate({
                    reviewers: [{ id: candidate.id, kind: candidate.kind }],
                    requested: !candidate.requested,
                  })
                }
              >
                <span className="min-w-0 flex-1 truncate text-foreground/85">
                  {candidate.login}
                  {candidate.name ? (
                    <span className="ml-1.5 text-muted-foreground/55">{candidate.name}</span>
                  ) : null}
                </span>
                {candidate.kind === "team" ? (
                  <span className="shrink-0 text-muted-foreground/55">team</span>
                ) : null}
                <CheckIcon
                  aria-hidden
                  className={cn("size-3.5 shrink-0", candidate.requested ? "" : "invisible")}
                />
                {candidate.requested ? <span className="sr-only">Already asked</span> : null}
              </button>
            ))
          )}
        </div>
        {request.isError ? (
          <p className="border-t border-border px-2 py-1.5 text-xs text-destructive">
            {request.error instanceof Error && request.error.message.trim().length > 0
              ? request.error.message
              : "The host refused that request."}
          </p>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
