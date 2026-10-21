# Contributing

Threadlines has mostly been built by one person, me. I'd like that to change.
If you use it and something bugs you, or you want a feature it doesn't have,
I'd love your help. Bug fixes, new features, docs and testing all count.

## Ways to help

- **Build a feature.** New features are welcome. If it's more than a small
  change, open an issue first so we can agree on the approach before you put
  in the time.
- **Catch up with Codex and Claude.** When Codex or Claude ships something new
  in their own apps and Threadlines doesn't have it yet, that's one of the most
  useful things you can work on.
- **Fix bugs.** Anything you've hit yourself is fair game. You don't need to ask
  first for a fix.
- **Make it faster or sturdier.** Slow screens, stuck spinners, sessions that
  don't recover after a restart or a dropped connection.
- **Platform fixes.** Bugs that only show up on Windows or Linux are easy to
  miss. Fixes and test reports from those machines help a lot.
- **More agents.** Threadlines runs several coding agents, plus community
  agents from the ACP registry that nobody has tested. Trying one and reporting
  what works and what breaks is a real contribution.
  [docs/providers/community-agents.md](docs/providers/community-agents.md) has
  the details.
- **Docs.** If something here or in the README confused you, fix it for the
  next person.
- **Report bugs and ideas.** A clear bug report with steps to reproduce is often
  half the fix.

If you're not sure where to start, look for issues labeled `good first issue`
or `help wanted`, or open an issue saying what you'd like to work on and I'll
help you find a starting point.

## Using a coding agent

Go for it. Most of Threadlines is written by directing agents, usually from
inside Threadlines. [AGENTS.md](AGENTS.md) is written for them, so point your
agent at it. It covers where the code lives, the checks to run and the house
style.

You're still responsible for what you send. Run the checks, read the diff
yourself, and be ready to answer questions about it.

## What I'm likely to push back on

Most things are open for discussion. A few are hard sells:

- Rewriting core architecture without a concrete problem it solves. The
  event-sourced orchestration core, the per-provider drivers and the Effect
  stack are settled.
- Features that only work with one agent when they could work with all of
  them. Switching agents without losing your work is a big part of the point.
- UI that doesn't follow the design language in
  [docs/design/design-language.md](docs/design/design-language.md). Read it
  before changing anything users will see.
- One PR that mixes unrelated changes. Split them so each can be reviewed and
  reverted on its own.

If I turn down a proposal, I'll explain why and leave the context in the issue.

## Opening a PR

- Say what changed and why. The PR template has two short sections for this.
- Big features are fine as one PR when the pieces belong together. If it's
  huge, I may ask to split it so it's easier to review and test.
- For visual changes, a before and after screenshot or a short clip helps.
  Welcome, not required.
- Make sure the checks below pass.

On your first PR, GitHub waits for me to approve it before the automated
checks run. That's a standard GitHub safety step, so don't worry if the checks
sit there for a bit.

I review everything myself, so a reply can take a few days. A nudge on the PR
after a week is fine.

## Development setup

You'll need Node.js 22.22.2+, 24.15+ or 26+. Odd-numbered releases aren't
supported. You'll also need [Vite+](https://viteplus.dev/guide/), which
provides the `vp` command used for every repo task.

```bash
vp install --frozen-lockfile
vp run dev
```

`vp run dev` keeps its data in `~/.threadlines/dev`, apart from the threads in
your installed Threadlines app.

### Checks

Before a change is done, `vp fmt`, `vp lint` and `vp run typecheck` must all
pass. Run the tests that cover the code you changed, for example
`vp run --cache '@threadlines/server#test' <filename substring>`. Web UI changes
also need `vp run --cache '@threadlines/web#test:browser'`, which CI runs
separately. Save `vp run test`, the full suite, for broad changes. Never run
`bun test`.

### On Windows

- Clone outside folders that OneDrive syncs, which by default includes Desktop
  and Documents. Syncing `node_modules`, `.git` and build output makes
  installs, builds and watch mode much slower.
- A handful of test files fail on Windows no matter what you change: the
  git-revert checkpoint tests, the terminal PATH tests, the symlink tests and
  the oxlint plugin tests, which spawn a POSIX-only shim. Make sure your own
  change's tests pass and leave those alone unless your PR is about fixing
  them.

## The fine print

By contributing, you agree that your contribution is licensed under the
repository's [MIT license](LICENSE). Please follow the
[code of conduct](CODE_OF_CONDUCT.md). Report security problems privately as
described in [SECURITY.md](SECURITY.md), not in a public issue. Don't commit
secrets or private data. [SECURITY_GUARDRAILS.md](SECURITY_GUARDRAILS.md) has
the list.
