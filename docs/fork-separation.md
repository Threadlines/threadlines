# Threadlines Fork And Compatibility Policy

Threadlines is the current product identity for the BadCode fork of T3 Code. We
keep that attribution and upstream history, while Threadlines owns the product
direction, visible app identity, release lane, and compatibility policy.

## Current Direction

- Threadlines is a Windows-first native desktop app for Codex and Claude Code.
- Codex and Claude are the maintained provider paths.
- Remote, hosted-web, SSH, Tailscale, Cursor, and OpenCode surfaces are being
  phased out unless they directly support the desktop workflow.
- Compatibility should prevent old settings and scripts from crashing, but new
  user-facing guidance should use Threadlines names.

## Identifier Policy

Keep the existing BadCode identifiers for configuration, storage, and commands
until a dedicated identity-rename phase migrates them:

- `BADCODE_HOME`
- `BADCODE_PORT`
- `BADCODE_HOST`
- `BADCODE_NO_BROWSER`
- `BADCODE_LOG_WS_EVENTS`
- `BADCODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD`
- `BADCODE_*` observability and release variables
- `badcode` CLI command

Legacy `T3CODE_*` variables and the `t3` command are compatibility aliases.
When a `BADCODE_*` alias and a legacy alias are both present, the `BADCODE_*` alias
wins.

New default local data lives under `~/.badcode`. Threadlines does not automatically
migrate data from `~/.t3`; users can opt into an old data directory by setting
`BADCODE_HOME` or `T3CODE_HOME` explicitly.

## Attribution Policy

Public docs may state that Threadlines started as the BadCode fork of T3 Code.
Product copy, release assets, app names, icons, and new setup instructions should
lead with Threadlines.

Avoid broad package-name churn unless it removes a real collision. Workspace
package names under `@t3tools/*` can be handled later after higher-risk runtime
surface changes are smaller.
