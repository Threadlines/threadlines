# Antigravity: move to Google's CLI and close the gap with T3 Code (plan, 2026-11-23)

Goal, from Will: Antigravity in Threadlines should be at least as good as in T3 Code, better where
we see room, and should include what Google's own engineers have contributed to T3 Code.

This file is the shared brief for everyone building it. Facts marked [v] were checked on
2026-11-23 against the named source. Facts marked [t3] come from reading T3 Code's source and are
how T3 does it, not proof of how the agent behaves. Nothing here was checked against a signed-in
session.

## Sources

- Google's CLI repo and changelog: https://github.com/google-antigravity/antigravity-cli
  (`CHANGELOG.md` is the authority on what `agy acp` does in each version).
- Google's update feed, one manifest per build:
  `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/<os>_<cpu>.json`
  with `{version, url, sha512}`; `url` is under
  `https://storage.googleapis.com/antigravity-public/antigravity-cli/<version>-<n>/` [v]. It served
  1.5.14 for `darwin_arm64`, `linux_amd64` and `windows_amd64` on 2026-11-23 [v].
- T3 Code, MIT licensed: https://github.com/pingdotgg/t3code. A clone may be at
  `/tmp/t3research/t3code`; clone it again if it is gone. Read it for wire shapes, edge cases and
  test fixtures. Write our own code in our own structure: do not paste theirs.
- The two T3 pull requests from a Google engineer (patrick-toulme, the only author of 284 checked
  whose profile says Google): #31158, merged, client identity; #40368, open, native swarm.

## Decisions

### 1. Run the CLI (`agy acp`), not the `agy_acp_server` package

Google moved ACP into the Antigravity CLI in 1.5.0 and does its ACP work there [v, changelog].
The registry package we install today is the old channel: it is at 1.5.2 while the CLI is at
1.5.14 [v]. What the CLI's ACP mode has, by version [v, changelog]:

| Version | What it adds for an app like ours                                                                                                                                          |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.5.0   | `agy acp`; modes `default`, `accept-edits`, `plan`; steering a running turn by sending another prompt; `session/resume`; `agy acp --login`                                 |
| 1.5.1   | Every model on the account (Claude and GPT too) for every ACP client, not only allowlisted editors                                                                         |
| 1.5.4   | `auto` mode; a second approval for the same tool call arrives as a new request                                                                                             |
| 1.5.8   | Context window usage updates                                                                                                                                               |
| 1.5.9   | A failed turn reports its real error (model, quota)                                                                                                                        |
| 1.5.10  | Replies, tool calls and approvals after a turn ended arrive right away (background task or subagent wakes the agent); cancel and close stop subagents and background tasks |
| 1.5.13  | Shell commands run in the session's folder; attached file contents are honored; retries are silent                                                                         |

- Launch: `<agy> acp --gemini-dir <profile> --app-data-dir antigravity-acp` [t3].
- Version floor: 1.5.14, on every platform and for custom binaries too. Below it, sessions don't
  start and the row says what to do. Reasons [v, changelog]: 1.5.10 delivers what the agent does
  after a turn ends, 1.5.13 honors attached file contents, and 1.5.14 fixes a Windows flaw where
  a network path in a file mention or rule could send Windows credentials to a remote host. The
  floor is a constant next to the release code with these reasons in its comment. (T3 accepts
  1.5.0; ours is stricter on purpose.)
- Source of releases: Google's update feed. Accept a manifest only when the URL is under the
  storage folder above with the file name Google uses for that build, and the version is plain
  semver. Keep the host allowlist on every redirect hop (`makeHttpsFetch`).
- Download and unpack checks must not get weaker than today's. The feed gives sha512 and no
  sizes, and the shared downloader wants an exact size and hashes sha256, so it needs a sha512
  streaming path with a size cap. Unix builds are `tar.gz` and Windows is a bare `.exe` [t3]:
  the tarball gets its own limit on unpacked size and entry count, exact entry names, and no
  links or paths that leave the folder; the disk-space check budgets the download plus what it
  unpacks to. Sizes learned on install go in the marker so the "files intact" check still works.
- Keep what we built on 2026-11-23: a built-in fallback release (now a CLI release with its
  sha512 per build), an hourly check that never blocks a status refresh for more than a few
  seconds, backoff while the feed is down, user-clicked Update only, never installing an older
  version than the one in place, a start-up check of the new copy before switching to it.
- Stop the CLI updating itself: `AGY_CLI_DISABLE_AUTO_UPDATE=1`, and make the installed files
  read-only [t3]. Not the version folder: `ManagedRuntimeStore` writes its leases inside it, so a
  read-only folder would pass the install check and then fail the first real launch.
- Builds: the six we have, and Linux musl (the feed has `_musl` builds; pick by detecting musl,
  as T3 does), so a Threadlines server on Alpine gets a managed install.
- The weekly drift check (`scripts/check-upstream-drift.ts`) compares the built-in release with
  the feed instead of the registry.
- Remove what the registry route needed and nothing else uses (`builtIn` recipes in
  `AcpRegistryCatalog`, the zip range reader), unless the new code reuses it.
- Two kinds of existing install, each with its own way forward:
  - Managed: the old marker names two files (server and harness). The new reader must still
    recognize it, so the row says "Update needed" with Update, not "Install", and the old copy
    keeps its leases until the CLI is activated. It is pruned once nothing runs on it.
  - A custom binary path pointing at the old server: managed Update can't fix it and adding
    `acp` to it doesn't make it the CLI. The row says the path must be Google's `agy` (or be
    cleared to use the managed copy), with both choices one click away.
- A thread started before the switch: its saved session may not resume on the CLI. The existing
  failed-resume path then starts a fresh session with the thread's context
  (`contextSeedOnResumeFailure`). The foundation stage checks that the next prompt really carries
  the kept conversation.

### 2. Sign-in

- The 1.5 CLI keeps Google sign-ins in one OS keyring entry shared by every profile unless it
  thinks it runs over SSH; T3 sets `SSH_CONNECTION` for Google-account sign-ins so each profile
  keeps its own sign-in in a file (`antigravity-acp/antigravity-oauth-token`) and signs in with
  `agy acp --login`, where Google ends on an antigravity.google page that shows a code to paste
  back [t3]. We need the same isolation: extra accounts must not share one sign-in, and a
  Threadlines sign-out must not sign the user's terminal `agy` out. Confirm the mechanism against
  the binary and the changelog before copying it; if Google has a real switch for file storage by
  now, use that.
- The paste-a-code sign-in is a new flow, not a variant of today's. Today the paste field shows
  only for a loopback redirect, and the server replays a pasted address to the agent's local
  port. A code from the antigravity.google page fits neither. Foundation builds code entry end to
  end: tied to the instance and the sign-in attempt that asked, handed privately to the waiting
  `agy acp --login` process, and reachable from setup, Settings, a phone, and a browser on
  another computer.
- Whether the old `acp_token.json` sign-in carries over is unknown. If it does not, say so once on
  the row ("Sign in again") instead of failing a chat.
- Sign-in errors get their own words: the agent didn't start, Google didn't answer (with the
  IPv6 hint), Google refused, subscription required, account verification needed (link to
  Google's page) [t3 has the first four merged; the link is an open PR there].
- Keep the four methods we have, the key check, and the gcloud lookup for Vertex AI.

### 3. Identity, models, modes

- Client identity: `{ name: "threadlines", title: "Threadlines", version: <ours> }` (Google's
  PR #31158 did this for T3). We never pretend to be another editor.
- Models come from the session, as now. Claude and GPT models will appear for plans that have
  them. The reasoning level is its own setting (`thought_level`) in current versions [t3]; keep
  the name-suffix folding only as a fallback. The saved model list stays tagged with the agent
  version.
- Access levels: Supervised is `default`; Auto-accept edits is `accept-edits`; Auto is the CLI's
  own `auto` when the session offers it, else `accept-edits`; Full access has no CLI mode (it
  rejects `yolo` [t3]), so it runs in `default` and Threadlines approves requests itself, as the
  ACP core already does for full access. Questions with fixed choices still need an answer.
- Plan: use the CLI's `plan` mode if it produces the same plan file our plan card reads; else
  keep the `/plan` prefix. The plan card stays.
- Our own MCP tools (room, browser, pages) follow the rule Claude and Codex threads already
  follow for the same access level. Do not invent a looser one.

### 4. Turns

- Design these four together, before anything else touches the adapter's prompt path:
  - A reply the agent starts on its own, after a background command or subagent finishes, shows
    in the thread (the core's `agentTurns`, which Grok uses).
  - Between the prompt ending and that reply, the thread still shows "working" with Stop.
    `agentTurns` alone doesn't do this: the adapter clears the active turn when the prompt
    settles and only opens a new one when output arrives. Grok gets explicit background and end
    notices from its agent. Antigravity needs its own source of "work is pending" (tool calls
    that outlive the prompt, wake-ups, subagents), with an upper bound on a silent wait
    [t3: 30 minutes].
  - A message sent mid-turn steers the turn (CLI 1.5.0+). The core's prompt helper keeps one
    "prompt in flight" flag and closes the current text segment per request, so a second prompt
    sent while the first is open needs its own handling of responses, or either response clears
    the flag for both.
  - Stop cancels the prompt and the pending work, and the thread settles once.
- Failures are failures: 5xx and 429 are retryable, a quota failure carries its reset time into
  the usage-limit notice, a session Google can no longer continue starts fresh with the thread's
  context. Use what the prompt response and error carry first. Read the agent's own session
  files only where the protocol truly gives nothing, and isolate that reader in one module.
- Subagents show as child work with role, prompt and steps, in whatever view Threadlines already
  has for other agents' subagents.
- Tool rows: an MCP call made through `call_mcp_tool` shows the tool's name; edits land at their
  real lines; long command text keeps its start; tool text is capped without cutting a character
  in half.
- Attachments: images and audio inline, PDFs and text files as documents, MIME parameters
  stripped, everything else as a file path.
- The agent's own slash commands list in the composer (`available_commands`), including `/goal`
  and `/compact` when offered.
- Editing an earlier message starts a fresh Antigravity session seeded with the kept turns,
  since the agent cannot rewind.

### 5. The user's own setup

- Link `~/.gemini/AGENTS.md`, `GEMINI.md`, `config/skills.json` and the global skills folders into
  each private profile (copy on Windows) [t3]. Credentials, hooks and the user's MCP config stay
  out of the profile.
- List Antigravity's skills where Threadlines lists other agents' skills, with T3's lookup order
  as the reference (`.gemini/skills`, `.agents/skills`, `.agent/skills`, global folders,
  `skills.json` with `inherits`, `include_only`, `exclude`).

### 6. Usage

- Tokens per turn come from the prompt response's `usage` (input plus cached read; output as
  sent, since 1.5 already counts thinking in it) [t3]. This needs its own conversion: the generic
  one subtracts cached reads from input, which is right for fx and would undercount here. The
  ledger only knows `fx` today, and the usage contract lists provider kinds that older clients
  negotiate, so the ledger, the contract and both clients change together. Gemini 4 prices are
  added. The context meter uses `usage_update` (1.5.8+).
- Plan limits: read them the way T3 does, from Google's `retrieveUserQuotaSummary`, with the
  access token the CLI saved in our own profile. Rules: never renew or rewrite the token (when it
  has expired, say "start a chat to refresh" and keep the last numbers); never touch the OS
  keyring; send our own User-Agent first and only come back to Will if Google refuses it; fail
  soft. Rows look like Grok's: family, window, percent used, reset time. This is an unpublished
  Google API and can break; that is accepted, and the code says so.
- Limits and email belong to one sign-in. Switching an instance to an API key keeps the earlier
  Google sign-in on disk on purpose, so a saved token alone proves nothing: read limits only
  when the instance's method is a Google sign-in, and key what is cached by the sign-in
  fingerprint, so a per-use account never shows a subscription's limits or someone's email.
- Show the signed-in Google account's email on the row if the same call path gives it cheaply.
- Not building: usage history for runs made outside Threadlines (it needs Google's private
  file format), and T3's CLIProxyAPI hub.

### 7. Swarm (Google's open PR #40368)

Native swarm is not in a released `agy` yet [t3 PR text]. Build it last. The client sends its
capabilities in `initialize` before it hears the agent's, so once Threadlines can handle swarm
messages it always offers `clientCapabilities._meta.antigravity.swarm`; whether the native path
is used is decided from the agent's answer or its `_antigravity/swarm` notifications. The
`swarm/members.json` fallback for released 1.5 builds is judged on its own, not behind that
gate. Workers show as subagents with live steps, and the thread stays working while they run.
Re-read the PR when starting: it is still changing.

## Order

1. **Foundation**: decisions 1 to 3, including the code-entry sign-in and both migration paths.
   Everything else depends on the CLI being the runtime.
2. **Turn lifecycle**: the four items at the top of decision 4, failures, and tokens per turn
   (they settle in the same prompt-completion path). One builder owns the ACP adapter here.
   **Alongside it**, since neither touches the adapter: the user's setup and skills (decision 5),
   and plan limits with the account email (decision 6, without tokens).
3. **The rest of decision 4**, after stage 2's adapter work lands: subagents, tool rows,
   attachments, slash commands, edit-earlier-message.
4. **Swarm**, decision 7, on top of 3.

Each stage ends with gates green, an outside review of its diff, and a short list of what Will
should click to check it signed in.

## Checking it

- No test can sign in to Google. Unit and integration tests use the stand-in ACP agent
  (`apps/server/scripts/acp-mock-agent.ts`) and shapes taken from T3's fixtures and Google's
  changelog.
- The real binary can be started signed out in a temp profile to read `initialize` (version,
  sign-in methods, modes, capabilities). If a permission guard refuses that, stop and say so.
- Will does the signed-in pass on a dev build at the end of each stage. Each stage's report ends
  with the exact things to click.
- `docs/providers/antigravity.md` and the app guide topic change with each stage.
