# GitHub status benchmark

How fresh and how in step the app's pull request surfaces are, and how many `gh` runs that costs. It
drives the real server and the production web build against a fake GitHub, so a change to how PR
status is read or pushed can be measured before and after.

## Run it

```sh
cd apps/web
vp build                                             # the server serves apps/web/dist
node bench/github-status/run.mjs                     # A, B, C, D, F: about 2.5 hours
node bench/github-status/run.mjs --scenarios E       # E alone: about 40 minutes
node bench/github-status/report.mjs <results.json>   # print a saved run's table again
```

Results go to `$TMPDIR/tl-ghbench-results-<time>.json` (or `--out <file>`), saved after every
change, and the summary table is printed at the end. Flags: `--runs 3` (runs per lag scenario),
`--cap 660` (seconds a surface gets before it counts as "never"; the slowest polls in the app are 10
minutes apart), `--away 90` (C: seconds unattended), `--stagger 30` (seconds between the starts of
side-by-side runs), `--startup 3`, `--transition 2`, `--steady 10` (E: minutes per window),
`--latency 400` (ms each fake `gh` call takes), `--port 14931`, `--keep` (keep the scratch folder:
server log, `gh-calls.jsonl`, `git-remote.jsonl`). Ctrl-C stops the server and browser and keeps
what was measured.

One server and one headless browser (full Chromium, `channel: "chromium"`) run at a time. The runs
of a lag scenario go side by side, each in its own tab (its own client) on its own thread and pull
request. Both processes are stopped at the end, by the PIDs the run started. The scratch folder is
in `$TMPDIR`; nothing reads or writes `~/.threadlines`.

## What it sets up

- **Repositories that look like GitHub.** Each one is a local bare repository under `remotes/`. Its
  checkout's origin is `git@github.com:bench/<name>.git`, and the checkout's `core.sshCommand` is a
  fake ssh that serves the bare repository and logs each fetch to `git-remote.jsonl`. Any other ssh
  on the server's PATH is a stub that refuses. A peer clone pushes to `main` to put the checkout
  behind.
- **A fake `gh`** (`fake-gh.mjs`) first on the server's PATH. The server puts the user's login-shell
  PATH first, so the run sets `SHELL` to a stand-in that reports the benchmark's PATH, checks that
  `gh` resolves to the fake before it starts the server, and stops if the server's first `gh` call
  does not reach the fake. Inherited `GIT_*`, `GH_*` and `GITHUB_*` variables are dropped, and git's
  global and system config are replaced with a scratch one.
- **A fake fx agent** (`fake-fx.mjs`), the only provider enabled; its reply puts a pull request
  address in the thread, so a chip renders. Codex, Claude and the rest are disabled in settings.
- Server state in a fresh home, telemetry off. The server still makes its own unauthenticated
  release checks (`api.github.com/repos/vercel-labs/fx/releases/latest`, `.../cli/cli/releases/latest`);
  nothing uses a GitHub account.

## The fake `gh`

Answers come from `gh-state.json` (repositories, each with pull requests: state, draft, checks
`pending|success|failure|none`, head commit, auto-merge, merge queue, behind-by). The run flips that
file (one atomic rename) and times the screen. Every call writes a `start` line when it begins and
an `end` line when it answers (kind, arguments, repository, working folder, duration, exit code) to
`gh-calls.jsonl`; a call with no `end` counts as `unfinished`.

| Kind                                                                                     | Command                                                                                |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `version`, `auth-status`                                                                 | `gh --version`, `gh auth status --json hosts`                                          |
| `pr-list-head:<state>`                                                                   | `gh pr list [--repo] --head <branch> --state <s> --limit N --json …` (checkout status) |
| `pr-list-repo:<state>`                                                                   | `gh pr list --repo R --state <s> --limit N --json …` (listings)                        |
| `pr-list-samples`                                                                        | `gh pr list --state merged --json title,body,author`                                   |
| `pr-view:summary`, `pr-view:detail`, `pr-view:activity`                                  | `gh pr view <number\|url\|branch> [--repo] --json …`                                   |
| `repo-view:default-branch`, `repo-view:clone-urls`                                       | `gh repo view [R] --json …`                                                            |
| `api-repo`, `api-repo:default-branch`, `api-user`, `api-user-repos`                      | `gh api repos/R`, `gh api user`, …                                                     |
| `gql:lookup`                                                                             | `gh api graphql --input -`: numbers and branches under `n<i>`/`bo<i>`/`bs<i>` aliases  |
| `gql:merge-queue-nodes`, `gql:base-state`, `gql:authored-search`                         | queue and auto-merge by node id, behind-by and queue, the viewer's own pull requests   |
| `gql:conversation`, `gql:auto-merge-readiness`, `gql:queue-standing`, `gql:avatar-nodes` | the rest of the reads the server makes                                                 |

GraphQL documents are matched whole (whitespace collapsed) against copies of the server's own,
pinned in `fake-gh.mjs`; the lookup's is rebuilt from its variables. `--json` fields are checked
before anything is answered, and only the fields asked for are returned. A missing pull request
fails the way `gh` does (`Could not resolve to a PullRequest …`, exit 1). Anything else, including
a GraphQL document that changed on the server, is logged as `UNKNOWN`, exits 64 and makes the run
exit non-zero; it never answers with empty JSON. When the server's queries change, update the pinned
copy and the answer together. Writes (`pr merge`, `pr create`, comments, reviews) are not supported.

## Surfaces it reads

All from what is on screen, with no hooks added to the app:

- **Composer row**: `[data-composer-pull-request-row]`, the glyph in `Open pull request #N` (its
  colour class is the shared state table, `pullRequestBadgeTone`), and the checks chip's word and
  dot (`CI` with an amber, green or red dot; `No checks`; `Merged`; `Closed`; `Queued`). Rows are
  told apart by number only.
- **Sidebar badge**: `[data-testid="inbox-thread-pr-badge"]` in the thread's row, live
  (`thread-row-<id>`) or under Wrapped (`done-row-<id>`; the shelf is opened when the row is not on
  screen). Its label reads `#N PR open|draft|merged|closed|auto-merge: title`.
- **Chat chip**: `.chat-markdown-pull-request-chip` with the pull request's address; the glyph's
  colour class gives the state (muted means "state unknown").
- **Behind count**: `[data-header-source-changes]`, whose label says `N commits behind the remote`.

## Scenarios

- **A** the page shows the thread whose pull request changes: checks pending→passing,
  draft→ready, open→closed, closed→reopened, open→merged, in that order on one pull request.
- **B** another thread is on screen; the changing pull request is only in the sidebar.
- **C** the window is unattended for `--away` seconds while the pull request merges: blurred but
  visible (another tab takes the browser's focus and the page's focus emulation is turned off), or
  hidden. Headless Chromium cannot hide a page, so hidden is the page being told so
  (`document.visibilityState` and `visibilitychange`); a real hidden tab's timer throttling is not
  reproduced. Lag is timed from attention coming back; surfaces that caught up while away are noted.
- **D** a teammate pushed to `main`; New thread, pick the project, time until the header's ↓N is
  right (Source panel closed). Cold: a project the server has never fetched, added with the remote
  already ahead and picked at once (the server's first fetch can land before the pick; the results
  say when). Warm: the same project later, pushed to right after the server's own next fetch, so
  the server's answer is stale until something fetches again; a run where no such fetch came is
  marked invalid.
- **E** nothing changes: `gh` runs per minute by kind, focused, blurred and hidden, each after a
  first window (the page load, or the switch) reported on its own. Two projects, four threads with
  pull requests, one tab.
- **F** two repositories each have a pull request with the same number, in different states.
  Counts every time a surface shows a state its own pull request has not had by then.

For each change, a surface's lag is the time from the state file changing until the surface shows
the new value and keeps it (every expected surface must hold for 10 seconds before the change is
done). "Shown before" means it already showed that value before the change, so it never showed the
old state; "never" means not within the cap. "Disagree" is the time the composer row, sidebar badge
and chip of one pull request showed different states during the window. Before each change the run
waits (up to 30 seconds) for `gh` to go quiet, so it is not timed against reads already in flight.
