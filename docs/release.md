# Threadlines Desktop Release Notes

Threadlines currently ships desktop release artifacts through GitHub Releases. The
release pipeline builds a Windows x64 NSIS `.exe` installer plus macOS arm64 and
x64 `.dmg`/`.zip` artifacts and a Linux x64 AppImage, then publishes them together
with Electron updater metadata.

Windows installers are signed with Azure Trusted Signing. macOS releases are
Developer ID signed, notarized, and stapled when the signing secrets are
configured.

The Linux release lane boots the AppImage under Xvfb and verifies that its embedded
backend is reachable before uploading it.

## Versioning

Threadlines keeps the fork's Git history, but uses its own app versions.

- First Threadlines alpha: `0.0.1`
- First public open-source release: `0.2.0`
- Stable tags: `v0.1.0`, `v0.1.1`, `v0.2.0`
- Nightly tags: `v0.2.0-nightly.20260712.160`

The release workflow aligns the releasable package versions during the build,
so a tag like `v0.2.0` produces installer and updater metadata for `0.2.0`.
Nightly releases are based on the next patch after the latest plain stable tag.
For example, if the latest stable tag is `v0.0.17`, a nightly dispatch from
`main` produces `0.0.18-nightly.<YYYYMMDD>.<run-number>`.

If you previously installed a private alpha build that used an older fork-era
app identity or an upstream-style `0.0.24` version, uninstall it before
installing the first public Threadlines build. Public releases use the
`dev.threadlines.app` app id and the Threadlines version lane.

## Local Desktop Artifacts

Use this when you want a local installer before publishing a GitHub Release:

```powershell
vp install --frozen-lockfile
vp run dist:desktop:artifact -- --platform win --target nsis --arch x64 --build-version 0.2.0
```

The artifacts and updater metadata are written to `release/`.

On macOS, build a local DMG plus updater ZIP with:

```bash
vp install --frozen-lockfile
vp run dist:desktop:artifact -- --platform mac --target dmg --arch arm64 --build-version 0.2.0
```

Use `--arch x64` on an Intel Mac runner. The macOS build uses `sips` and
`iconutil`, so it must run on macOS.

To override the GitHub update repository while building:

```powershell
$env:THREADLINES_DESKTOP_UPDATE_REPOSITORY = "Threadlines/threadlines"
vp run dist:desktop:artifact -- --platform win --target nsis --arch x64 --build-version 0.2.0
```

The desktop artifact script accepts `THREADLINES_DESKTOP_*` variables. New
automation should not use old fork-era variable names.

## GitHub Release

The workflow is `.github/workflows/release.yml`.

It verifies the required CI checks for the release commit, runs the release smoke
checks, and then performs:

- Windows x64 NSIS packaging
- macOS arm64 DMG/ZIP packaging
- macOS x64 DMG/ZIP packaging
- macOS updater manifest merging
- Linux x64 AppImage packaging and boot verification
- GitHub Release publishing

The platform jobs upload installers directly to a draft GitHub Release with the
GitHub CLI. Large release binaries are not passed through GitHub Actions
artifacts, so they do not consume Actions artifact retention/storage quota.

To publish by tag:

```powershell
git tag v0.2.0
git push origin v0.2.0
```

To publish a nightly from `main`, open GitHub Actions, run **Desktop Release**,
choose `nightly`, and leave the version blank. The workflow uses the latest
stable tag to choose the next stable target version, then appends the nightly
date/run suffix. The automatic nightly scope builds Windows x64, macOS arm64, and
Linux x64; stable releases additionally build macOS x64. You can also run the same
dispatch from the CLI:

```powershell
gh workflow run release.yml --ref main -f channel=nightly
```

To publish a stable manually from `main`, choose `stable` and enter a version
such as `0.2.0`, or leave it blank to use the next patch after the latest
stable tag.

To promote a tested nightly such as
`v0.2.0-nightly.20260712.160` to stable, create a fresh stable release from the
same commit instead of editing the prerelease in place:

```powershell
$sha = git rev-list -n 1 v0.2.0-nightly.20260712.160
git tag v0.2.0 $sha
git push origin v0.2.0
```

This builds a new stable installer with version `0.2.0`, marks it as the
latest GitHub Release, and gives stable-channel installs a normal update target.

## Release Notes

Release notes combine GitHub's generated PR metadata with the local commit range.
That keeps the public list compact while retaining PR authors, first-time
contributors, meaningful direct commits, and the full compare link. Release-prep
PRs are omitted from the public changes and contributor sections. If GitHub's
note-generation endpoint is unavailable, the workflow falls back to local commit
and PR detection instead of blocking the release.

Nightly releases compare against the previous nightly build when one exists,
otherwise against the latest prior stable tag. Stable releases compare against
the previous stable tag, so their notes include the full stable-to-stable commit
range even if some of those commits already appeared in nightly notes.

Stable releases also require a human-reviewed changelog entry under
`apps/marketing/src/content/changelog/v<version>.md`. Nightly releases do not
create marketing changelog entries.

Before publishing a stable release, run **Prepare Stable Release Content** from
GitHub Actions with the target version. The workflow:

1. asks GitHub Copilot to summarize the commits since the previous stable tag,
   then applies strict local validation;
2. validates that every public claim cites a commit in that release range;
3. creates the marketing changelog entry and an X draft capped at 280 Unicode
   characters; and
4. opens a Draft PR and tries to assign it to the person who ran the workflow.

The generator only describes functionality available in the default
user-facing product. Add dormant, disabled, hidden, internal-only, or unreleased
features to `.github/release-content-policy.yml`. The policy is included in the
model prompt, and generated copy that still mentions a matching term is rejected
before a changelog or PR is created. Remove an exclusion when the feature becomes
publicly available.

Review the copy in the PR, edit the generated changelog file as needed, and use
the Vercel Preview check to inspect the rendered page. Merging the PR approves
the marketing and GitHub release copy. The X draft links to the GitHub release
so X renders GitHub's release card. It never posts to social media.

The generator uses GitHub Copilot through the `COPILOT_GITHUB_TOKEN` repository
secret. Create a fine-grained personal access token owned by the Copilot Free
user, grant only the account-level **Copilot Requests** permission, and save it
with that secret name. The SDK receives that token explicitly and does not fall
back to the workflow's built-in `GITHUB_TOKEN`; in an organization-owned
repository, that fallback would use organization-metered requests instead of the
token owner's personal Copilot allowance.

Copilot Free supports automatic model selection only, so the generator always
requests `auto` and has no named-model override. Each draft consumes the user's
included monthly GitHub AI Credits. Keep paid additional usage disabled (or its
budget at a hard stop) if this workflow must never incur overage charges. Once
the included allowance is exhausted, generation fails and the fallback below is
used until the allowance resets.

If the token is missing or the provider request fails, the workflow still opens a
Draft PR with deterministic placeholders and `reviewRequired: true` in the
changelog frontmatter. Stable publishing rejects either that marker or any
remaining reserved `TODO:` placeholder. Replace every placeholder and delete
`reviewRequired` before merging the content PR.

For a local draft, use:

```bash
COPILOT_GITHUB_TOKEN=... vp run release:content -- --version 0.2.5 --current-ref HEAD
```

Without `COPILOT_GITHUB_TOKEN`, a local run creates the same blocked
human-review fallback used by GitHub Actions.

The stable release workflow refuses to publish when the matching reviewed entry
is missing. Its GitHub release body places those highlights first and keeps the
complete compact technical change list in a collapsed details section.

The release assets should include:

- `Threadlines-<version>-win-x64.exe`
- `Threadlines-<version>-win-x64.exe.blockmap`
- `Threadlines-<version>-win-x64.zip`
- `Threadlines-<version>-mac-arm64.dmg`
- `Threadlines-<version>-mac-arm64.zip`
- `Threadlines-<version>-mac-x64.dmg`
- `Threadlines-<version>-mac-x64.zip`
- `Threadlines-<version>-linux-x86_64.AppImage`
- `latest.yml`
- `latest-mac.yml`
- `latest-linux.yml`

Electron Builder also uploads matching `.blockmap` files for differential
updates.

Nightly releases may also include `nightly.yml`, `nightly-mac.yml`, and
`nightly-linux.yml`. The workflow keeps latest-channel copies on nightly
prereleases so updater checks can read the prerelease manifest.

## Downloads

Download the matching asset from GitHub Releases:

- Windows: `Threadlines-<version>-win-x64.exe` (or
  `Threadlines-<version>-win-x64.zip` for a portable copy that does not install)
- Apple Silicon macOS: `Threadlines-<version>-mac-arm64.dmg`
- Intel macOS: `Threadlines-<version>-mac-x64.dmg`
- Linux x64: `Threadlines-<version>-linux-x86_64.AppImage`

Every asset name carries its operating system, so a macOS updater zip can no
longer be mistaken for a Windows download.

Windows and macOS public release artifacts are expected to be signed. Windows may
still show SmartScreen reputation prompts until the signing identity has enough
download reputation.

## npm Package

The server/CLI package is `@threadlines/server`. It backs advanced local usage
and remote bootstrap flows:

```bash
npx @threadlines/server@latest --help
```

The npm organization scope is `@threadlines`. The first package publish must be
done by an npm account that owns the organization and has 2FA enabled for
publishing:

```bash
vp install --frozen-lockfile
vp exec vp run --filter @threadlines/server build:bundle
node scripts/prepare-server-npm-package.ts
cd release/npm-server
npm login
npm publish --access public
```

After the first package exists, configure npm Trusted Publishing for
`@threadlines/server` with the GitHub repository and workflow
`.github/workflows/npm-package.yml`. Then use the **npm Package** workflow to
dry-run or publish future versions. Stable builds should use the `latest`
dist-tag; nightly builds should use the `nightly` dist-tag.

## Windows Publisher Name

There are two different Windows publisher surfaces:

- Installed app metadata can be set by the installer package. Threadlines'
  desktop artifact script stages the package author as `Threadlines`.
- UAC, SmartScreen, and Authenticode publisher identity come from the signing
  certificate. Current Threadlines releases use Wilfredo Leon's verified Azure
  Trusted Signing identity.

## Auto-Updates

The app uses `electron-updater` and GitHub Releases metadata. Public GitHub
release assets do not require a runtime GitHub token for normal update checks or
downloads.

## macOS Signing And Notarization

For public macOS releases, configure a Developer ID Application certificate and
notarization credentials.

Set repository variable `THREADLINES_MACOS_SIGNED=true`, then add these GitHub
secrets:

- `MACOS_CSC_LINK`: base64-encoded `.p12` certificate or a secure certificate
  URL accepted by Electron Builder
- `MACOS_CSC_KEY_PASSWORD`: `.p12` password
- `APPLE_API_KEY`: App Store Connect API private key contents
- `APPLE_API_KEY_ID`: App Store Connect key ID
- `APPLE_API_ISSUER`: App Store Connect issuer ID

When signing is enabled, the artifact script enables hardened runtime and runs
the explicit after-sign notarization hook. The hook submits the `.app` bundle to
Apple, waits for acceptance, staples the ticket, and validates the staple.

## Windows Signing

The release workflow requires Windows signing before upload. Configure
`THREADLINES_DESKTOP_SIGNED=true` and the Azure Trusted Signing variables and
secrets used by `.github/workflows/release.yml`.

## Linux AppImage

The local script can build a Linux AppImage:

```bash
vp run dist:desktop:artifact -- --platform linux --target AppImage --arch x64 --build-version 0.2.0
```

Stable and nightly GitHub Releases include the Linux x64 AppImage. The release
workflow performs a repeatable headless boot check before it publishes the asset.
