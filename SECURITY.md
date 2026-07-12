# Security Policy

## Reporting a Vulnerability

Please report suspected security issues privately instead of opening a public
issue.

Use a private
[GitHub Security Advisory](https://github.com/Threadlines/threadlines/security/advisories/new)
with a minimal description, affected version or commit, and reproduction steps.

Do not include secrets, private repository contents, or customer data in reports.

## Scope

Threadlines is a local-first desktop app. Security-sensitive areas include:

- local provider credentials and environment variables;
- shell and terminal process management;
- Git operations and worktree handling;
- desktop auto-update behavior;
- relay, SSH, and remote environment access.

## Supported Versions

Threadlines is in public alpha. The latest published release and the current
`main` branch receive security fixes.
