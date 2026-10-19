# Threadlines Origins And Compatibility Policy

Threadlines began as a fork of [T3 Code](https://github.com/pingdotgg/t3code).
We keep that attribution and upstream history, while Threadlines owns the
product direction, visible app identity, release lane, and compatibility policy.
Upstream remains a source of inspiration, and improvements flow back where they
fit.

## Current Direction

- Threadlines is a workspace for coding agents that runs where you work: a
  desktop app for macOS, Windows, and Linux, a self-hostable server (Docker,
  VPS, homelab), a hosted web app, and phone access through device pairing.
- Codex and Claude Code are the actively maintained providers. Drivers for
  other agents remain in the codebase and support for more providers is open
  for the future.
- Compatibility should prevent old settings from disappearing during upgrades,
  but new user-facing guidance should use Threadlines names.

## Identifier Policy

Use Threadlines names for new configuration, release, and observability surfaces:

- `THREADLINES_HOME`
- `THREADLINES_PORT`
- `THREADLINES_HOST`
- `THREADLINES_NO_BROWSER`
- `THREADLINES_LOG_WS_EVENTS`
- `THREADLINES_AUTO_BOOTSTRAP_PROJECT_FROM_CWD`
- `THREADLINES_*` observability, telemetry, source-control, and release variables

Legacy `BADCODE_*` and `T3CODE_*` variables may remain as compatibility aliases
where removing them would lose user data or break installed apps. When multiple
aliases are present, `THREADLINES_*` wins.

The data folder is the exception. T3 Code still uses `T3CODE_HOME` and `~/.t3`
for its own live data, so Threadlines reads neither: following them would open
T3 Code's database. The two apps share their first migration ids and then
diverge, and the server refuses a database whose migration history names other
steps (`persistence/MigrationHistory.ts`). The desktop sets such a copy aside
when it sits in the default `~/.threadlines`, where earlier versions copied it.

Keep bundle IDs, app IDs, and existing local data paths stable unless a dedicated
identity-migration release handles the data movement. New setup instructions
should still use Threadlines environment names.

## Attribution Policy

Public docs may state that Threadlines began as a fork of T3 Code.
Product copy, release assets, app names, icons, and new setup instructions should
lead with Threadlines.

Workspace packages use the `@threadlines/*` scope. Keep legacy local-storage
keys, data-directory fallbacks, and environment aliases only where they are
explicitly needed for upgrade compatibility.
