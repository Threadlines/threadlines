# BadCode

BadCode is a Windows-first desktop GUI for coding agents. It is a fork of
[T3 Code](https://github.com/pingdotgg/t3code), with the upstream Git history
kept intact so useful changes can still be reviewed and brought forward.

The maintained provider paths are Codex and Claude. Inherited OpenCode and
Cursor support is being phased out as BadCode narrows toward a smaller native
desktop surface.

## Fork Positioning

BadCode does not hide its T3 Code origin, but it now treats BadCode as the
product identity and compatibility boundary:

- new local configuration should use `BADCODE_*` environment variables;
- legacy `T3CODE_*` variables remain accepted as compatibility aliases;
- when both names are set, `BADCODE_*` wins;
- new installs default to a separate `~/.badcode` data directory;
- the `badcode` CLI alias is preferred, while `t3` remains available for old
  scripts during the transition.

See [docs/fork-separation.md](./docs/fork-separation.md) for the current
branding and compatibility policy.

## Installation

> [!WARNING]
> BadCode uses locally installed coding agents. Install and authenticate at
> least one maintained provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`

### Desktop app

Install the latest Windows alpha from
[GitHub Releases](https://github.com/badcuban/badcode/releases).

This repository is private, so release downloads require a GitHub account with
access to the repo.

### Local development

```bash
bun install --frozen-lockfile
bun run dev
```

### Local Windows installer

```powershell
bun install --frozen-lockfile
bun run dist:desktop:artifact -- --platform win --target nsis --arch x64 --build-version 0.0.1
```

The installer is written to `release/`.

## Releases

BadCode keeps the upstream Git history but uses its own app versions starting
at `0.0.1`.

See [docs/release.md](./docs/release.md) for the Windows-only release workflow,
private-repo download notes, and auto-update requirements.

## Development Notes

This is still early WIP. Expect sharp edges.

The repository is private today, but it may become open source later. Treat it
as public-safe now: do not commit `.env` files, tokens, private keys, local app
data, customer data, or screenshots containing secrets. See
[SECURITY_GUARDRAILS.md](./SECURITY_GUARDRAILS.md) before publishing code or
release artifacts.

Before local development, prepare the environment and install dependencies:

```bash
# Optional: only needed if you use mise for dev tool management.
mise install
bun install
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.
