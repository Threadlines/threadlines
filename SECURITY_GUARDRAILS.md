# Security Guardrails

BadCode may become public later, so treat the repository as public-safe from the start.

## Before pushing

- Run `git status --short` and review every changed file.
- Do not commit `.env*`, private keys, certs, local notes, logs, generated release artifacts, or app data.
- Keep local Codex handoff notes under `.codex-local/`.
- Keep screenshots and fixtures free of personal paths, API keys, customer data, tokens, and private repository URLs.
- Prefer example config files such as `.env.example` over real local config.

## Secret Scanning

Use a secret scanner before publishing or opening the repository.

Recommended local check:

```powershell
gitleaks detect --source . --redact --verbose
```

If `gitleaks` is not installed yet, install it from the official project:

https://github.com/gitleaks/gitleaks

## Open Source Checklist

Before making the repository public:

- Run a full secret scan.
- Review git history for accidental secrets or personal data.
- Confirm the app name, icons, and README clearly distinguish BadCode from upstream T3Code.
- Keep the upstream MIT license notice intact.
- Add BadCode-specific documentation only after checking it contains no local machine details.
