# BadCode Desktop Release Notes

BadCode currently ships desktop release artifacts through GitHub Releases. The
release pipeline builds a Windows x64 NSIS `.exe` installer plus macOS arm64 and
x64 `.dmg`/`.zip` artifacts, then publishes them together with Electron updater
metadata.

Linux packaging exists in the local artifact script, but it is not part of the
normal release workflow yet because there is no tested Linux install/update path.

## Versioning

BadCode keeps the fork's Git history, but uses its own app versions.

- First BadCode alpha: `0.0.1`
- Stable tags: `v0.0.1`, `v0.0.2`, `v0.1.0`
- Nightly tags: `v0.0.18-nightly.20260529.123`

The release workflow aligns the releasable package versions during the build,
so a tag like `v0.0.1` produces an installer and updater metadata for `0.0.1`.
Nightly releases are based on the next patch after the latest plain stable tag.
For example, if the latest stable tag is `v0.0.17`, a nightly dispatch from
`main` produces `0.0.18-nightly.<YYYYMMDD>.<run-number>`.

If you previously installed a local build that reported an upstream-style
`0.0.24` version, uninstall it before installing the first `0.0.1` BadCode
build. Auto-updaters normally treat `0.0.1` as older than `0.0.24`.

## Local Desktop Artifacts

Use this when you want a local installer before publishing a GitHub Release:

```powershell
bun install --frozen-lockfile
bun run dist:desktop:artifact -- --platform win --target nsis --arch x64 --build-version 0.0.1
```

The artifacts and updater metadata are written to `release/`.

On macOS, build a local DMG plus updater ZIP with:

```bash
bun install --frozen-lockfile
bun run dist:desktop:artifact -- --platform mac --target dmg --arch arm64 --build-version 0.0.1
```

Use `--arch x64` on an Intel Mac runner. The macOS build uses `sips` and
`iconutil`, so it must run on macOS.

For a private-repo update feed, set the update repository while building:

```powershell
$env:BADCODE_DESKTOP_UPDATE_REPOSITORY = "badcuban/badcode"
bun run dist:desktop:artifact -- --platform win --target nsis --arch x64 --build-version 0.0.1
```

The desktop artifact script accepts `BADCODE_DESKTOP_*` variables. Legacy
`T3CODE_DESKTOP_*` variables remain compatibility aliases. When both names are
set, `BADCODE_DESKTOP_*` takes precedence.

## GitHub Release

The workflow is `.github/workflows/release.yml`.

It runs:

- `bun run fmt:check`
- `bun run lint`
- `bun run typecheck`
- `bun run test`
- Windows x64 NSIS packaging
- macOS arm64 DMG/ZIP packaging
- macOS x64 DMG/ZIP packaging
- macOS updater manifest merging
- GitHub Release publishing

To publish by tag:

```powershell
git tag v0.0.1
git push origin v0.0.1
```

To publish a nightly from `main`, open GitHub Actions, run **Desktop Release**,
choose `nightly`, and leave the version blank. The workflow uses the latest
stable tag to choose the next stable target version, then appends the nightly
date/run suffix. You can also run the same dispatch from the CLI:

```powershell
gh workflow run release.yml --ref main -f channel=nightly
```

To publish a stable manually from `main`, choose `stable` and enter a version
such as `0.0.18`, or leave it blank to use the next patch after the latest
stable tag.

To promote a tested nightly such as
`v0.0.18-nightly.20260529.123` to stable, create a fresh stable release from the
same commit instead of editing the prerelease in place:

```powershell
$sha = git rev-list -n 1 v0.0.18-nightly.20260529.123
git tag v0.0.18 $sha
git push origin v0.0.18
```

This builds a new stable installer with version `0.0.18`, marks it as the
latest GitHub Release, and gives stable-channel installs a normal update target.

## Release Notes

Release notes are generated automatically from commit subjects. Nightly releases
compare against the previous nightly build when one exists, otherwise against
the latest prior stable tag. Stable releases compare against the previous stable
tag, so their notes include the full stable-to-stable commit range even if some
of those commits already appeared in nightly notes.

The release assets should include:

- `BadCode-<version>-x64.exe`
- `BadCode-<version>-x64.exe.blockmap`
- `BadCode-<version>-arm64.dmg`
- `BadCode-<version>-arm64.zip`
- `BadCode-<version>-x64.dmg`
- `BadCode-<version>-x64.zip`
- `latest.yml`
- `latest-mac.yml`

Nightly releases may also include `nightly.yml` and `nightly-mac.yml`. The
workflow keeps latest-channel copies on nightly prereleases so private GitHub
updater checks can read the prerelease manifest.

## Private Repository Downloads

Because this repository is private, downloading the installer from GitHub
Releases requires a GitHub account with access to the repo.

For another machine:

1. Sign into GitHub with an account that can access `badcuban/badcode`.
2. Open the release page.
3. Download the matching asset for the machine:
   - Windows: `BadCode-<version>-x64.exe`
   - Apple Silicon macOS: `BadCode-<version>-arm64.dmg`
   - Intel macOS: `BadCode-<version>-x64.dmg`
4. Run the installer or open the DMG.

Unsigned alpha builds may show Windows SmartScreen or "unknown publisher"
warnings. Unsigned macOS builds will also show Gatekeeper friction and may
require manual approval in System Settings. Signing can be added without
changing the basic release flow.

## Windows Publisher Name

There are two different Windows publisher surfaces:

- Installed app metadata can be set by the installer package. BadCode's desktop
  artifact script stages the package author as `BadCode`, so newly built
  unsigned installers should not inherit the upstream app metadata.
- UAC, SmartScreen, and Authenticode publisher identity come from the signing
  certificate. If an `.exe` is signed by an upstream certificate, Windows will
  show that upstream identity. To make those verified publisher prompts say
  BadCode, sign the installer with a BadCode-owned code-signing certificate or
  Azure Trusted Signing identity. Without signing, Windows will show an unknown
  publisher.

## Auto-Updates In A Private Repo

The app uses `electron-updater` and GitHub Releases metadata. For private
repositories, the updater needs a token at runtime because GitHub release
assets are not public.

For personal testing on your own machine, install and sign into the GitHub CLI
once:

```powershell
gh auth login
gh auth status
```

When the packaged app sees a private GitHub update feed, it checks
`GH_TOKEN`/`GITHUB_TOKEN` first. If neither is set, it asks `gh auth token` for
the signed-in GitHub CLI token and passes that token directly to the updater for
the update check or download.

If GitHub CLI is not installed or is not visible on `PATH`, launch BadCode from a
shell with a token that can read releases from this private repo. Windows
example:

```powershell
$env:GH_TOKEN = "github_pat_or_classic_token_here"
& "$env:LOCALAPPDATA\Programs\BadCode (Alpha)\BadCode (Alpha).exe"
```

`GITHUB_TOKEN` also works. Do not commit tokens, screenshots containing tokens,
or local token setup scripts. Prefer `gh auth login` for personal testing;
environment tokens are inherited by the Electron process for that launch.

If BadCode becomes public later, or if release assets move to public hosting,
users will not need a private-repo token for updates.

## macOS Signing And Notarization

The workflow can build unsigned macOS artifacts now. For a clean public macOS
release, enroll in the Apple Developer Program, create a Developer ID
Application certificate, and configure notarization credentials.

Set repository variable `BADCODE_MACOS_SIGNED=true`, then add these GitHub
secrets:

- `MACOS_CSC_LINK`: base64-encoded `.p12` certificate or a secure certificate
  URL accepted by Electron Builder
- `MACOS_CSC_KEY_PASSWORD`: `.p12` password
- `APPLE_API_KEY`: App Store Connect API private key contents
- `APPLE_API_KEY_ID`: App Store Connect key ID
- `APPLE_API_ISSUER`: App Store Connect issuer ID

When signing is enabled, the artifact script enables hardened runtime and
Electron Builder notarization for macOS.

## Windows Signing Later

Windows signing is not required for local alpha testing, but it is strongly
recommended before wider distribution. The existing build script already has an
optional Azure Trusted Signing path; the workflow intentionally leaves it off
for now.

## Linux Later

The local script can build a Linux AppImage:

```bash
bun run dist:desktop:artifact -- --platform linux --target AppImage --arch x64 --build-version 0.0.1
```

Keep Linux out of normal stable/nightly releases until there is at least one
repeatable install/update check on a real Linux desktop or VM. An experimental
manual artifact job is a reasonable next step after Windows and macOS releases
are proven.
