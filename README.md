# Threadlines

Threadlines is a desktop GUI for coding agents. It is a fork of
[T3 Code](https://github.com/pingdotgg/t3code), with the upstream Git history
kept intact so useful changes can still be reviewed and brought forward.

The maintained provider paths are Codex and Claude. Inherited OpenCode and
Cursor support is being phased out as Threadlines narrows toward a smaller native
desktop surface.

## Fork Positioning

Threadlines does not hide its T3 Code or BadCode origin, but it now treats
Threadlines as the visible product identity:

- new local configuration should use `THREADLINES_*` environment variables;
- legacy `BADCODE_*` and `T3CODE_*` variables remain accepted as compatibility aliases;
- when multiple aliases are set, `THREADLINES_*` wins, then `BADCODE_*`, then `T3CODE_*`;
- new installs default to a separate `~/.badcode` data directory;
- the `badcode` CLI alias remains the supported command name for now, while `t3`
  remains available for old scripts during the transition.

See [docs/fork-separation.md](./docs/fork-separation.md) for the current
branding and compatibility policy.

## Installation

> [!WARNING]
> Threadlines uses locally installed coding agents. Install and authenticate at
> least one maintained provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`

### Desktop app

Install the latest desktop alpha from
[GitHub Releases](https://github.com/Threadlines/threadlines/releases).

This repository is private, so release downloads require a GitHub account with
access to the repo.

### Local development

```bash
vp install --frozen-lockfile
vp run dev
```

### Local desktop artifact

```powershell
vp install --frozen-lockfile
vp run dist:desktop:artifact -- --platform win --target nsis --arch x64 --build-version 0.0.1
```

The artifact is written to `release/`.

## Releases

Threadlines keeps the upstream Git history but uses its own app versions starting
at `0.0.1`.

See [docs/release.md](./docs/release.md) for the desktop release workflow,
private-repo download notes, platform status, and auto-update requirements.

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
vp install
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.
