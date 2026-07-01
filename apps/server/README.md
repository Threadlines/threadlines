# @threadlines/server

Threadlines server and CLI package.

Threadlines is a local-first desktop workspace for Codex and Claude Code. This
package contains the server/CLI used by the desktop app, remote bootstrap flows,
and advanced local usage.

Most users should install the signed desktop app from GitHub Releases:

https://github.com/Threadlines/threadlines/releases

## Usage

Run without installing:

```bash
npx @threadlines/server@latest --help
```

Install globally:

```bash
npm install --global @threadlines/server
threadlines --help
```

Threadlines uses locally installed coding agents. Install and authenticate at
least one maintained provider before use:

- Codex: install Codex CLI and run `codex login`
- Claude: install Claude Code and run `claude auth login`

## License

MIT. See `LICENSE`.
