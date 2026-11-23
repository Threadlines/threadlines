# Antigravity

Antigravity is Google's coding agent. Threadlines runs Google's Antigravity CLI (`agy`) in its ACP
mode (`agy acp`), and downloads and checks the CLI for you (`Install` on the Antigravity row in
`Settings -> Providers`), so there is nothing to install by hand. Each Antigravity account in
Threadlines has its own profile, separate from your own `~/.gemini`.

Threadlines needs Antigravity 1.5.14 or newer, for the managed copy and for one you point it at
(`Binary path`). That version is the first that delivers what the agent does after a turn ends,
honors attached file contents, and closes a Windows flaw where a network path in a file mention
could send your Windows credentials to another computer. An older custom `agy` is refused with a
message saying so; run `agy update`, or clear the path to use the copy Threadlines installs.

## Updates

Threadlines asks Google's CLI update feed for a newer Antigravity at most once an hour. When there is
one, the Antigravity row shows `Update`; nothing installs until you click it. New models arrive this
way, since each Antigravity version lists its own.

Threadlines only offers a release from Google's own download folder under the name Google uses for
your computer's build, with a plain version and a sha512. It checks the download against that hash
and a size cap (the feed lists no sizes), unpacks only the one `antigravity` file (refusing links,
extra files and anything outside its folder), and starts the new copy once to make sure it's
Antigravity at that version before switching to it. The installed file is read-only, and the CLI's
own self-update is turned off, so only Threadlines changes it. If the feed can't be read, the
version built into Threadlines is offered instead, and an installed copy is never replaced by an
older one. Linux computers that use musl (Alpine) get Google's musl build.

A weekly GitHub check (`.github/workflows/upstream-drift.yml`) opens an issue when Google's version
is ahead of the built-in one, or when Google's feed changes so Threadlines would refuse it.

### Moving From Google's Old Antigravity Server

Before 1.5.14, Threadlines ran Google's older `agy_acp_server` package. If you had it installed, the
Antigravity row says `Antigravity now runs on Google's Antigravity CLI. Update it to keep using it.`
with `Update`. The old copy stays until no chat uses it, then Threadlines deletes it.

A `Binary path` that points at the old server (`agy_acp_server`) can't be updated. The row says to
point it at Google's `agy`, or to clear it so Threadlines uses its own copy.

The CLI keeps its sign-in in a different file, so a Google account or Gemini Enterprise sign-in made
with the old server needs one more sign-in; the row says `Sign in again`. Threads from before the
move continue: when the CLI can't reopen an old conversation, Threadlines starts a new one with the
thread's earlier turns as context.

## Models and Access Levels

The model picker lists the models your account has, Claude and GPT models included where your plan
has them. The reasoning level is its own choice next to the model.

| Access level      | What Antigravity runs                                                          |
| ----------------- | ------------------------------------------------------------------------------ |
| Supervised        | `default`: asks before edits and commands                                      |
| Auto-accept edits | `accept-edits`                                                                 |
| Auto              | The CLI's own `auto` where your session offers it, otherwise `accept-edits`    |
| Full access       | `default`, and Threadlines approves each request; questions still wait for you |

Plan mode sends the task as `/plan`, and the plan shows on the plan card for review.

## Your Rules and Skills

Each Antigravity account runs in its own profile, so Threadlines brings your own global setup from
`~/.gemini` into it before every start. These are shared:

- Rules: `AGENTS.md` and `GEMINI.md`, both in `~/.gemini` and in `~/.gemini/config`, the
  `~/.gemini/config/rules` folder, and `~/.gemini/config/rules.json`.
- Skills: the `~/.gemini/config/skills` and `~/.gemini/antigravity-cli/skills` folders, and
  `~/.gemini/config/skills.json`.

On macOS and Linux each one is a link, so an edit shows up in the next chat. On Windows the folders
are junctions and the files are copies, refreshed at each start; a copy changed inside the profile
is left alone from then on. Something you add later is picked up at the next start. Your sign-in,
hooks, plugins, subagents (`agents.json`) and MCP servers (`mcp_config.json`) stay out, so an
Antigravity account in Threadlines never runs them.

Project rules and skills come from the project as usual: `AGENTS.md` and `GEMINI.md`, and skills in
`.agents/skills`, `.gemini/skills` and the older `.agent/skills`.

Threadlines reads which skills Antigravity loads, the way Antigravity finds them, and Settings
search lists them. When two have the same name, the first wins in this order:
`~/.gemini/config/skills`, the project's `.gemini/skills`, `~/.gemini/antigravity-cli/skills`, the
project's `.agents/skills`, then `.agent/skills`. Folders a `skills.json` declares come after those: the project's
`.agents/skills.json` in the project and each folder above it up to the repository root, then
`~/.gemini/config/skills.json`. Threadlines follows the same rules as Antigravity for these files:
`inherits` reads another file, `include_only` and `exclude` match names exactly, a nested skill
loads only when `include_only` names it (`category/my-skill`), `~` is not expanded, and a project's
file can only point inside the project. Skills of plugins installed in that account's profile are
listed unless the plugin is turned off. The list is read from the folder Threadlines runs in, like
other agents' lists, so a project's own skills show only when Threadlines runs inside it.

To use a skill, start the message with `/` and its name, as in a terminal (`/review this diff`).
Antigravity also picks a skill on its own when the task matches its description. The composer's
`$` skill list is for Codex only.

## Sign-In Methods

Open `Settings -> Providers`, open the Antigravity row, and pick a method under `Sign-in method` on
the `Account` tab.

| Method            | Who pays                                         | What you need                                           |
| ----------------- | ------------------------------------------------ | ------------------------------------------------------- |
| Google account    | Your Google AI plan                              | A Google sign-in                                        |
| Gemini Enterprise | Your company's Gemini plan, through Google Cloud | A Google Cloud project and location, and a work sign-in |
| Gemini API key    | Per use, billed by Google                        | A key from Google AI Studio                             |
| Vertex AI         | Per use, billed to a Google Cloud project        | A project and location, or a Vertex AI express key      |

Google account is the default, and it's what `Sign in with Google` on the setup screen uses. The
setup screen's `Other ways` link opens the same choice in Settings.

Picking another method shows its fields and a `Switch` button. Switching saves the method, then
starts what the method needs: a Google sign-in for Gemini Enterprise, a key check for a Gemini API
key, a check of the project and Google Cloud sign-in for Vertex AI. Switching back to Google account
keeps its earlier sign-in, so it needs no new one.

### Signing In With Google

`Sign in with Google` (and Gemini Enterprise's sign-in) opens Google's sign-in page on the device you
started from: this computer, another one, or your phone. After you approve, Google shows an
Antigravity page with a code. Paste that code (or the page's whole address) into the box Threadlines
shows, and Threadlines hands it to Antigravity on the computer that runs Threadlines. Sign-in then
opens a session to make sure it works.

The sign-in is kept in that Antigravity account's own profile, not in your computer's keychain, so
each Threadlines account has its own, and your own `agy` in a terminal keeps its sign-in.

If sign-in fails, the message says why: Antigravity didn't start, it couldn't reach Google (broken
IPv6 is a common cause), Google refused the code, the account needs an eligible plan, or Google
wants you to verify the account first (with a link to Google's page).

Running chats stop when you switch, as with any change to a provider's settings.

### Plan Limits

An account signed in with Google (Google account or Gemini Enterprise) shows how much of the
Google plan is used: on the Antigravity row in Settings, on the Usage page, in the ring beside the
send button, and on each model in the picker. Google meters groups of models apart, so there is a
row for each: Gemini, each Gemini 4 model that has a limit of its own (such as Gemini 4 Argon), and
Claude & GPT, which share one. Each has a 5-hour and a weekly window with its reset time. Gemini
Enterprise accounts are metered per model, with no window length; their rows show each group's
fullest model. A group that runs out stops only its own models. The row also shows the signed-in
Google account's email (blurred until you show it).

The numbers come from Google, not from Antigravity: Threadlines asks Google's Cloud Code service
(`retrieveUserQuotaSummary`, the call Google's own Antigravity apps make) with the sign-in
Antigravity saved in this account's profile, under Threadlines' own name. Google doesn't publish
this API, so it can change or stop answering; the row then says it couldn't read the limits and
keeps the last numbers.

When the numbers can be stale:

- They are read every few minutes, when the provider status refreshes, so a chat's usage shows up
  within about five minutes.
- Threadlines never renews the sign-in itself. Antigravity renews it while it runs, so after an
  hour or so without a chat the saved sign-in lapses. The last numbers stay, with their age, and a
  line says to start a chat to refresh them.
- A Gemini API key or Vertex AI bills per request and has no plan to meter, even if an earlier
  Google sign-in is still in the profile.

Requests go only to `daily-cloudcode-pa.googleapis.com`, `cloudcode-pa.googleapis.com` and, for the
email when the sign-in doesn't carry it, `www.googleapis.com`. Redirects are refused, so the
sign-in can't be carried anywhere else. The code is `apps/server/src/provider/antigravity/AntigravityUsage.ts`.

### Per-Use Billing

With a Gemini API key or Vertex AI, Google bills every request to you. These requests don't show on
Threadlines' Usage page; check Google AI Studio or the Google Cloud console for spending.

### Where Keys Are Kept

Keys are saved like every other Threadlines secret: in a private file on the computer that runs
Threadlines (readable only by your user account), never in `settings.json`, and never sent back to
the app. Settings shows that a key is saved and, in the account line, its last four characters.
`Replace key` and `Remove key` are on the Account tab.

Each method keeps its own key (`GEMINI_API_KEY` for a Gemini API key, `GOOGLE_API_KEY` for a Vertex
AI express key), so switching never hands one method's key to the other. Keys set in your shell are
ignored: only the key saved on the provider is used.

### Checking a Key

`Check key` asks Google whether it accepts a Gemini API key, with a request that costs nothing. A
key Google rejects shows as an error until you replace it. A key that passed the check can still
lack access to a model or run out of quota; the first chat tells you if so.

Vertex AI keys and Google Cloud sign-ins are only proven by a real request, so the row says
`Credential configured` until then.

### Vertex AI Without a Key

Without a key, Vertex AI uses the Google Cloud sign-in on the computer that runs Threadlines
(Application Default Credentials). Sign in once there:

```bash
gcloud auth application-default login
```

Threadlines looks where Google's tools look: `GOOGLE_APPLICATION_CREDENTIALS` if it is set (and only
there), otherwise the gcloud config folder (`CLOUDSDK_CONFIG`, else `~/.config/gcloud`, or
`%APPDATA%\gcloud` on Windows). If you use Threadlines from a phone or another computer, this is
the computer running the Threadlines server, not the device in your hand.

## Extra Accounts

`Add another Antigravity account` (the Antigravity row, or the `+` at the top of the page) adds a
second Antigravity with its own sign-in. Each account picks its own method, so one can use your
Google account and another a Gemini API key.

## Signing Out

Google account and Gemini Enterprise have `Sign out` on the Account tab. It removes the sign-in from
that Antigravity account's profile and nothing else, so your own `agy` stays signed in. Key methods
have `Remove key` instead.
