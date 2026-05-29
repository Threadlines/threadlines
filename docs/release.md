# BadCode Windows Release Notes

BadCode currently ships as a Windows x64 Electron desktop app. The release
pipeline builds an NSIS `.exe` installer, uploads it to this repository's
GitHub Releases, and includes the Electron updater metadata files that the app
needs for future updates.

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

## Local Windows Installer

Use this when you want a local installer before publishing a GitHub Release:

```powershell
bun install --frozen-lockfile
bun run dist:desktop:artifact -- --platform win --target nsis --arch x64 --build-version 0.0.1
```

The installer and updater metadata are written to `release/`.

For a private-repo update feed, set the update repository while building:

```powershell
$env:BADCODE_DESKTOP_UPDATE_REPOSITORY = "badcuban/badcode"
bun run dist:desktop:artifact -- --platform win --target nsis --arch x64 --build-version 0.0.1
```

The desktop artifact script still accepts legacy `T3CODE_DESKTOP_*` variables
for compatibility. When both names are set, `BADCODE_DESKTOP_*` takes
precedence.

## GitHub Release

The workflow is `.github/workflows/release.yml`.

It runs:

- `bun run fmt:check`
- `bun run lint`
- `bun run typecheck`
- `bun run test`
- Windows x64 NSIS packaging
- GitHub Release publishing

To publish by tag:

```powershell
git tag v0.0.1
git push origin v0.0.1
```

To publish a nightly from `main`, open GitHub Actions, run **Windows Release**,
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

The release assets should include:

- `BadCode-<version>-x64.exe`
- `BadCode-<version>-x64.exe.blockmap`
- `latest.yml`

Nightly releases may also include `nightly.yml`. The workflow keeps a
`latest.yml` copy on nightly prereleases so private GitHub updater checks can
read the prerelease manifest.

## Private Repository Downloads

Because this repository is private, downloading the installer from GitHub
Releases requires a GitHub account with access to the repo.

For another Windows laptop:

1. Sign into GitHub with an account that can access `badcuban/badcode`.
2. Open the release page.
3. Download the `BadCode-<version>-x64.exe` asset.
4. Run the installer.

Unsigned alpha builds may show Windows SmartScreen or "unknown publisher"
warnings. Code signing can be added later without changing the basic release
flow.

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

For personal testing on your own Windows machine, install and sign into the
GitHub CLI once:

```powershell
gh auth login
gh auth status
```

When the packaged app sees a private GitHub update feed, it checks
`GH_TOKEN`/`GITHUB_TOKEN` first. If neither is set, it asks `gh auth token` for
the signed-in GitHub CLI token and passes that token directly to the updater for
the update check or download.

If GitHub CLI is not installed or is not visible on `PATH`, launch BadCode from
a shell with a token that can read releases from this private repo:

```powershell
$env:GH_TOKEN = "github_pat_or_classic_token_here"
& "$env:LOCALAPPDATA\Programs\BadCode (Alpha)\BadCode (Alpha).exe"
```

`GITHUB_TOKEN` also works. Do not commit tokens, screenshots containing tokens,
or local token setup scripts. Prefer `gh auth login` for personal testing;
environment tokens are inherited by the Electron process for that launch.

If BadCode becomes public later, or if release assets move to public hosting,
users will not need a private-repo token for updates.

## Signing Later

Windows signing is not required for local alpha testing, but it is strongly
recommended before wider distribution. The existing build script already has an
optional Azure Trusted Signing path; the workflow intentionally leaves it off
for the first Windows-only release lane.
