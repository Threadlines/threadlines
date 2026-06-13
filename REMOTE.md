# Remote Access

Remote, hosted-web, SSH, and Tailscale pairing flows are deprecated in Threadlines'
current product direction.

Threadlines is narrowing toward a local-first native desktop workflow for Codex and
Claude Code. The old remote-access internals remain in the repository for
compatibility while the runtime boundary is simplified, but new setup should not
depend on `app.t3.codes`, remote pairing links, or SSH-launched environments.

Use the desktop app on the machine where your projects and provider CLIs are
installed. If you need to keep an older remote setup alive temporarily, expect
that surface to move to compatibility-only behavior and be removed in a later
cleanup.
