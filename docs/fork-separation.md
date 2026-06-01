# BadCode Fork Separation

BadCode is a fork of T3 Code. We keep that attribution and upstream history,
but BadCode now owns its product direction, app identity, local data, release
lane, and compatibility policy.

## Current Direction

- BadCode is a Windows-first native desktop app for Codex and Claude Code.
- Codex and Claude are the maintained provider paths.
- Remote, hosted-web, SSH, Tailscale, Cursor, and OpenCode surfaces are being
  phased out unless they directly support the desktop workflow.
- Compatibility should prevent old settings and scripts from crashing, but new
  user-facing guidance should use BadCode names.

## Identifier Policy

Use BadCode identifiers for new configuration and docs:

- `BADCODE_HOME`
- `BADCODE_PORT`
- `BADCODE_HOST`
- `BADCODE_NO_BROWSER`
- `BADCODE_LOG_WS_EVENTS`
- `BADCODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD`
- `BADCODE_*` observability and release variables
- `badcode` CLI command

Legacy `T3CODE_*` variables and the `t3` command are compatibility aliases.
When a BadCode alias and a legacy alias are both present, the BadCode alias
wins.

New default local data lives under `~/.badcode`. BadCode does not automatically
migrate data from `~/.t3`; users can opt into an old data directory by setting
`BADCODE_HOME` or `T3CODE_HOME` explicitly.

## Attribution Policy

Public docs may state that BadCode is a T3 Code fork. Product copy, release
assets, app names, icons, and new setup instructions should lead with BadCode.

Avoid broad package-name churn unless it removes a real collision. Workspace
package names under `@t3tools/*` can be handled later after higher-risk runtime
surface changes are smaller.
