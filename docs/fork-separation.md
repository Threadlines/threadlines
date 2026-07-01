# Threadlines Origins And Compatibility Policy

Threadlines began as a fork of [T3 Code](https://github.com/pingdotgg/t3code).
We keep that attribution and upstream history, while Threadlines owns the
product direction, visible app identity, release lane, and compatibility policy.

## Current Direction

- Threadlines is a Windows-first native desktop app for Codex and Claude Code.
- Codex and Claude are the maintained provider paths.
- Remote, hosted-web, SSH, Tailscale, Cursor, and OpenCode surfaces are being
  phased out unless they directly support the desktop workflow.
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
