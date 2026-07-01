# Security Guardrails

Threadlines is intended to be public-safe. Treat every commit, fixture,
screenshot, and release artifact as if it may be inspected by outside users.

## Before pushing

- Run `git status --short` and review every changed file.
- Do not commit `.env*`, private keys, certs, local notes, logs, generated release artifacts, or app data.
- Keep local Codex handoff notes under `.codex-local/`.
- Keep screenshots and fixtures free of personal paths, API keys, customer data, tokens, and private repository URLs.
- Prefer example config files such as `.env.example` over real local config.

## Secret Scanning

Use a secret scanner before publishing releases or large changes.

Recommended local check:

```powershell
gitleaks detect --source . --redact --verbose
```

If `gitleaks` is not installed yet, install it from the official project:

https://github.com/gitleaks/gitleaks

## Public Release Checklist

Before public releases:

- Run a full secret scan.
- Review git history for accidental secrets or personal data.
- Confirm the app name, icons, and README clearly distinguish Threadlines from
  its upstream origin.
- Keep the upstream MIT license notice intact.
- Add Threadlines-specific documentation only after checking it contains no local machine details.
