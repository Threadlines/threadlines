# Pull requests page

A page that lists the pull requests of every GitHub project in the workspace, grouped by what
needs the user, with each row tied back to the thread that produced it. Reached from a row under
"General Chats" in the sidebar.

This document is the build spec for step 1 (list only). Steps 2 (detail in the right panel) and 3
(review actions, merged threads move to Done) come later and are out of scope here.

## Principles

- **Inbox, not a table.** The list answers "what needs me" first. Everything else is below it.
- **Threads are the unit of work.** A PR whose branch belongs to a thread shows that thread and
  opens it. A PR with no thread offers "Review in a thread", which is the existing checkout flow.
- **GitHub only, behind an interface.** The server reads through `gh`. Other hosts are skipped
  silently for now; the service shape leaves room for them.
- **Cheap on the host.** One `gh pr list` per repository, cached for 30 seconds, refreshed only
  while the page is open or on explicit refresh. The sidebar count shares the same cache.
- **Dense and flat.** Divider rows, mono meta line, colour-shift hover, no pills, no cards.

## Contracts (`packages/contracts/src/pullRequest.ts`, exported from `index.ts`)

```
PullRequestListState        = "open" | "merged" | "closed"
PullRequestState            = "open" | "merged" | "closed"
PullRequestReviewDecision   = "approved" | "changes-requested" | "review-required"
PullRequestChecksState      = "pending" | "success" | "failure"
PullRequestActor            = { login: TrimmedNonEmptyString; isBot: boolean }
PullRequestLabel            = { name: TrimmedNonEmptyString; color: string | null }   // hex without '#', as gh reports it

PullRequestListEntry = {
  provider: SourceControlProviderKind        // "github" for now
  projectId: ProjectId
  projectTitle: TrimmedNonEmptyString
  repository: TrimmedNonEmptyString          // "owner/name"
  number: PositiveInt
  title: TrimmedNonEmptyString
  url: TrimmedNonEmptyString
  author: PullRequestActor | null
  headBranch: TrimmedNonEmptyString
  baseBranch: TrimmedNonEmptyString
  state: PullRequestState
  isDraft: boolean
  additions: NonNegativeInt
  deletions: NonNegativeInt
  createdAt: IsoDateTime
  updatedAt: IsoDateTime
  viewerIsAuthor: boolean
  viewerReviewRequested: boolean
  reviewDecision?: PullRequestReviewDecision   // absent when gh reports none
  checksState?: PullRequestChecksState         // absent when no checks or not requested
  labels: PullRequestLabel[]
}

PullRequestListProjectError = {
  projectId: ProjectId
  projectTitle: TrimmedNonEmptyString
  repository: string | null
  reason: "missing-tool" | "unauthenticated" | "rate-limited" | "failed"
  detail: string
}

PullRequestListInput  = { state: PullRequestListState; projectId?: ProjectId; force?: boolean }
PullRequestListResult = {
  viewer: string | null                        // signed-in gh login for github.com, null if unknown
  entries: PullRequestListEntry[]
  errors: PullRequestListProjectError[]
}
```

Error type for the RPC: a `Schema.TaggedError` named `PullRequestServiceError` with
`{ operation: string; detail: string }`, in the same style as `GitManagerServiceError`.

RPC: `WS_METHODS.pullRequestsList = "pullRequests.list"`, `WsPullRequestsListRpc` added to the
`WsRpcGroup` in `rpc.ts`. `EnvironmentApi` (`ipc.ts`) gains `pullRequests: { list }`.

Capability: `ExecutionEnvironmentCapabilities` gains `pullRequests: Schema.optionalKey(Schema.Boolean)`.
The server sets it to `true` in `ServerEnvironment.ts`. Older servers omit it; the client treats
absent as unsupported.

## Server (`apps/server/src/pullRequest/`)

`gitHubPullRequestList.ts`: pure decoding of `gh pr list --json` output into
`PullRequestListEntry` fields (no I/O). Fields requested:

```
number,title,url,author,headRefName,baseRefName,state,isDraft,additions,deletions,createdAt,updatedAt,mergedAt,reviewDecision,reviewRequests,labels,statusCheckRollup
```

- `state`: `MERGED` or a non-null `mergedAt` → `merged`; `CLOSED` → `closed`; else `open`.
- `reviewDecision`: `APPROVED` → `approved`, `CHANGES_REQUESTED` → `changes-requested`,
  `REVIEW_REQUIRED` → `review-required`; empty or unknown → absent.
- `reviewRequests`: collect user logins only (entries with `__typename: "User"` or a `login`);
  team requests are ignored.
- `statusCheckRollup` (array of checks) → one word: any `FAILURE`/`ERROR`/`TIMED_OUT`/`CANCELLED`
  conclusion → `failure`; any check without a completed status → `pending`; all
  `SUCCESS`/`SKIPPED`/`NEUTRAL` → `success`; empty array → absent.
- `statusCheckRollup` is expensive on big repositories, so it is requested only for `state: "open"`.
  Merged and closed listings omit the field and report no `checksState`.
- Malformed rows are skipped, not fatal. A whole payload that fails to parse is a `failed` error.

`PullRequestService.ts` (Effect `Context.Service`, layer in `server.ts`):

- `list(input)`:
  1. Read projects from `ProjectionSnapshotQuery.getShellSnapshot()`. Keep projects with
     `kind !== "general-chat"` whose `repositoryIdentity` has `provider === "github"` and both
     `owner` and `name`. If `input.projectId` is set, keep only that project. Other projects are
     skipped without an error entry.
  2. Viewer: run `gh auth status --json hosts` once, parse with `parseGitHubAuthStatus`, take the
     active authenticated account for `github.com` (`findAuthenticatedGitHubAccount` if it fits).
     Cache for 10 minutes. Null if unavailable; do not fail the listing for it.
  3. Per project, concurrency 4: `gh pr list -R owner/name --state <state> --limit <N> --json <fields>`
     with `cwd = workspaceRoot`, through `GitHubCli.execute`. N is 50 for open, 30 for merged and
     closed. Map rows with `gitHubPullRequestList.ts`; set `viewerIsAuthor` and
     `viewerReviewRequested` by comparing logins to the viewer (case-insensitive).
  4. A failing project becomes one `errors` entry and the rest still return. Classify from the
     CLI error text: `gh` not found → `missing-tool`; "not logged in" / "authentication" /
     "auth login" → `unauthenticated`; "rate limit" → `rate-limited`; else `failed`.
  5. Cache results in an Effect `Cache` keyed by `${state}|${projectId ?? "*"}`, TTL 30 seconds,
     capacity 32. `force: true` invalidates the key first. Concurrent identical reads share one
     lookup (the Cache does this).
- Entries are returned in the order gh gives them; the client sorts.

`ws.ts`: `[WS_METHODS.pullRequestsList]: (input) => observeRpcEffect(..., pullRequests.list(input), { "rpc.aggregate": "pullRequests" })`.

Tests (`PullRequestService.test.ts`, `gitHubPullRequestList.test.ts`), using `Layer.mock` for
`GitHubCli` and `ProjectionSnapshotQuery` like `GitHubCli.test.ts` does for `VcsProcess`:

- A GitHub project and a non-GitHub project: only the GitHub one is listed; no error for the other.
- Viewer flags: author equal to viewer → `viewerIsAuthor`; viewer in review requests →
  `viewerReviewRequested`; a team-only request → false.
- One project's gh call fails with "not logged into any GitHub hosts": the other project's rows
  still return and `errors` has one `unauthenticated` entry.
- Two `list` calls inside 30 seconds run gh once per project; `force: true` runs it again.
- Decoder: state mapping including `mergedAt`, checks rollup to one word, malformed row skipped.

## Web

### Data (`apps/web/src/lib/pullRequestsReactQuery.ts`)

react-query, in the style of `gitReactQuery.ts`:

- `pullRequestQueryKeys.list(environmentId, state)`.
- `pullRequestListQueryOptions({ environmentId, state })`: `staleTime` 30 s, `refetchOnWindowFocus`
  true, `placeholderData: keepPreviousData`. The page passes `refetchInterval` 60 s; the sidebar
  count passes 5 min. Both read the same key, so whichever is mounted keeps it warm.
- Refresh button: call the RPC with `force: true` through `queryClient.fetchQuery` on the same key
  (or a mutation that writes to the key), so the cache and the UI update together.
- Environments: from `useSavedEnvironmentRuntimeStore` `byId`, take environments whose
  `connectionState` is connected and whose `descriptor.capabilities.pullRequests === true`. Query
  each with `useQueries` and merge. One environment failing degrades to a notice, never a blank
  page.

`environmentApi.ts` and `rpc/wsRpcClient.ts` gain `pullRequests.list`.

### Logic (`apps/web/src/components/pull-requests/pullRequests.logic.ts`, pure, unit-tested)

- `linkThreadsToPullRequests(entries, threads)`: for each entry, threads with the same
  `environmentId` + `projectId`, `archivedAt === null`, and `branch === headBranch`. Sorted most
  recently updated first. Threads come from `selectSidebarThreadsAcrossEnvironments`.
- `resolveNeedsYouReason(entry)` (open state only), first match wins:
  - `viewerReviewRequested` → "Review requested"
  - `viewerIsAuthor && reviewDecision === "changes-requested"` → "Changes requested"
  - `viewerIsAuthor && checksState === "failure"` → "Checks failing"
  - `viewerIsAuthor && reviewDecision === "approved" && !isDraft` → "Approved"
  - otherwise null.
- `groupPullRequests(entries, viewer)` for the open state → `[needsYou, yours, others]`, each
  sorted by `updatedAt` desc; empty groups are omitted. A row is in exactly one group.
  `yours` = `viewerIsAuthor`. When the viewer is null, everything is "others" and the group
  header is omitted (a single flat list). Merged and closed states are one flat list, newest
  update first.
- `matchesPullRequestQuery(entry, query)`: case-insensitive match on title, `#number` or bare
  number, author login, head branch, repository, label names. Words are ANDed.
- `countNeedsYou(entries)` for the sidebar.

### Page (`apps/web/src/components/pull-requests/PullRequestsView.tsx`, route `routes/_chat.pull-requests.tsx`)

Mirror `ChatsDestinationView.tsx`: `DesktopPageTitlebar label="Pull requests"`, a pane-wide
scroller, a centred reading column (`max-w-3xl`, this list is wider than a chat list).

Header block:

- `h1` "Pull requests" (same size as General chats). To its right, a segmented control
  (`ui/toggle-group`, size and variant as the existing segmented usage) with **Open**, **Merged**,
  **Closed**. Default Open. The state lives in the route search param `state`.
- One line of muted copy under the title: "Across every project with a GitHub remote."
- Below: a search `Input` (placeholder "Search title, #number, author, branch, label") with a
  refresh icon button at its right (`RefreshCwIcon`, spins while fetching, tooltip "Refresh").
  Search is local, instant, and lives in component state (not the URL).

List:

- Group header: same voice as the General chats page (`font-mono text-[10px] uppercase
tracking-wider text-muted-foreground/55`), text "Needs you · 3", "Yours · 5", "Others · 12".
- Rows separated by `divide-y divide-border/50`. Each row is a `button` (`hover:bg-muted`,
  `rounded-md`, `py-2.5`, same as `ChatRow`) laid out as a grid: glyph column, content column.
- Glyph: `GitPullRequestIcon` emerald for open (reuse the exact classes from
  `ThreadStatusIndicators`), `GitPullRequestDraftIcon` muted for draft, `GitMergeIcon` violet for
  merged, `GitPullRequestClosedIcon` zinc for closed. `size-4`.
- Line 1: title (`text-sm font-medium text-foreground/90`, truncate). Right end: relative time from
  `formatRelativeTimeLabel(updatedAt)` in `font-mono text-xs tabular-nums text-muted-foreground/50`.
- Line 2 (`text-xs text-muted-foreground/55`, single line, truncating from the left cluster):
  `#123`, then `owner/name` only when the list spans more than one repository, then author login,
  then the environment label only when more than one environment contributes. Then the needs-you
  reason in amber (`text-amber-600/90 dark:text-amber-400/80`), except "Approved" in emerald. Then
  up to two labels as plain text each preceded by a 6 px dot in the label colour, "+n" for the rest.
  Right end: `DiffStatLabel` (`font-mono text-xs`) when additions or deletions are non-zero.
- Thread link: when the row has linked threads, a third element on line 2's right side, before the
  diff stat: `MessagesSquareIcon` + the thread title (truncate, max 40 % of the row). It reads as
  "this PR is being worked in that thread".
- Click on the row: with a linked thread, navigate to it (`buildThreadRouteParams`, same as
  `ChatRow`). Without one, open the PR on GitHub (`window.open` with `noopener`, or the
  existing external-link helper if one exists).
- Hover actions at the row's right end, revealed on hover or focus-within, always visible for coarse
  pointers (same technique as the inbox rows): **Open on GitHub** (`ExternalLinkIcon`) and
  **Review in a thread** (`GitBranchPlusIcon`). Tooltips carry those labels. "Review in a thread"
  opens `PullRequestThreadDialog` with `environmentId`, `cwd = project.cwd`, `threadId = newThreadId()`,
  `initialReference = entry.url`. `onPrepared` calls `handleNewThread` from `useNewThreadHandler()`
  with `scopeProjectRef(entry.environmentId, entry.projectId)` and
  `{ branch, worktreePath, envMode: worktreePath ? "worktree" : "local" }`.

States:

- Loading with nothing cached: three skeleton rows (see `SidebarInboxLoadingSkeleton`).
- No connected environment supports pull requests: "Pull requests need a newer Threadlines server."
- No GitHub project anywhere: "Add a project with a GitHub remote to see its pull requests."
- Every project failed with `missing-tool` or `unauthenticated`: title "Sign in to GitHub CLI",
  one line "Threadlines reads pull requests through gh on the server.", and an outline button
  "Open Source Control settings" that navigates to `/settings/source-control`.
- Some projects failed: a single muted notice line above the list, "Couldn't load 2 projects", with
  the project titles and details in a tooltip or a collapsible line, and a "Retry" text button.
- Nothing to show: "No open pull requests." / "Nothing merged recently." / "Nothing closed recently."
- Search with no match: "No pull requests match."

Empty states use the `ui/empty` primitives.

### Sidebar row (`Sidebar.tsx`)

Directly under the General Chats row, as its sibling, same anatomy and classes:
`GitPullRequestIcon` `size-3.5`, label "Pull Requests", `data-testid="sidebar-pull-requests"`,
`aria-current="page"` when the pathname starts with `/pull-requests`. Tighten the General Chats
wrapper's bottom margin so the two rows read as a pair, and give the pair the existing gap below.

Right end of the row: the needs-you count when it is greater than zero, `font-mono text-[10px]
tabular-nums text-muted-foreground/60`. Hover does not change it (no "new" affordance).

The row is hidden entirely when no connected environment reports the capability.

Click: close the mobile sheet, navigate to `/pull-requests` (mirror `handleOpenChats`).

### Command palette (`CommandPalette.tsx`)

Action `action:pull-requests`, title "Open pull requests", search terms
`["pull requests", "prs", "pr", "reviews", "github"]`, `GitPullRequestIcon`, navigates to
`/pull-requests`. Registered only when the row would be visible.

### Tests

- `pullRequests.logic.test.ts`: grouping and reasons (one row per group, first-match rule), thread
  linking (archived excluded, branch must match, project must match), query matching.
- `PullRequestsView.browser.tsx`: with `__setEnvironmentApiOverrideForTests` stubbing
  `pullRequests.list`: renders three groups with the right counts; the sign-in empty state when
  every project is `unauthenticated`; clicking "Review in a thread" opens the dialog with the PR
  URL prefilled. Keep it to those three.
- Regenerate `routeTree.gen.ts` the way the router plugin does (check `apps/web/vite.config.ts`
  and the scripts before hand-editing it; it is checked in).

## Out of scope for step 1

Detail panel, diffs, comments, reviews, merge, linked-PR persistence on the thread, settling merged
threads, seeding the composer with the PR context, hosts other than GitHub, keybinding.
