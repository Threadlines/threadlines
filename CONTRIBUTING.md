# Contributing

## Welcome

Thanks for considering a contribution to Threadlines. The project is early and
its direction is intentionally focused, but thoughtful bug reports, fixes, and
small improvements are welcome.

Open an issue first for non-trivial changes. Small, concrete bug fixes,
reliability fixes, performance improvements, and maintenance work are much easier
to review than broad feature PRs.

PRs are automatically labeled with a `vouch:*` trust status and a `size:*` diff size based on changed lines.

If you are an external contributor, expect `vouch:unvouched` until we explicitly add you to [.github/VOUCHED.td](.github/VOUCHED.td).

By contributing to Threadlines, you agree that your contribution is licensed
under the repository's MIT license.

## Contributions That Fit Best

Small, focused bug fixes.

Small reliability fixes.

Small performance improvements.

Tightly scoped maintenance work that clearly improves the project without changing its direction.

## Changes To Discuss First

Large or cross-cutting PRs.

New product features that have not been discussed in an issue.

Broad rewrites without a concrete reliability or maintainability benefit.

Changes that substantially expand the supported product scope.

Large or unrelated changes will usually be asked to split into smaller PRs so
they can be reviewed and tested safely.

## Opening A PR

Keep it small.

Explain exactly what changed.

Explain exactly why the change should exist.

Do not mix unrelated fixes together.

If the PR makes anything resembling a UI change, include clear before/after images.

If the change depends on motion, timing, transitions, or interaction details, include a short video.

Clear context helps us review and respond quickly.

## Issues First

If you are thinking about a non-trivial change, open an issue first.

That gives everyone a chance to check direction and scope before you spend time
on a larger patch.

## Review Expectations

Maintainers may ask for a smaller scope, a different implementation, or more
tests before merging. If a proposal does not fit the current direction, we will
explain that as clearly as we can and preserve the useful context in its issue.

## Development Notes

Node.js 22.22.2+, 24.15+, or 26+ is required. Odd-numbered Node releases are
not supported.

Before considering a change done, all of `vp fmt`, `vp lint`, and
`vp run typecheck` must pass, and run the test suite with `vp run test`
(never `bun test`).

On Windows:

- Clone outside OneDrive-synced folders (Desktop/Documents by default).
  Syncing `node_modules`, `.git`, and build output makes installs, builds,
  and watch mode noticeably slower.
- A handful of test files currently fail on Windows regardless of your
  changes (git-revert checkpoint tests, terminal PATH tests, symlink
  tests, and the oxlint plugin tests, which spawn a POSIX-only bin shim).
  Verify your change's own test files pass; do not chase these unless your
  PR is about fixing them.
