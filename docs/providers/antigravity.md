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

Plan mode sends the task as `/plan`, and the plan shows on the plan card for review. Writing that
plan (`brain/<session>/plan.md` in the account's profile) is the one thing approved without asking,
and only an edit of that file alone qualifies; anything else Antigravity asks to do in Supervised
mode waits for you, even if it names the plan file. A message
that starts with one of Antigravity's own commands or skills goes as typed instead (see Commands and
Skills in the Composer).

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

These files can themselves be links, into a dotfiles repository for example. Threadlines follows a
link to see where it leads, and skips it when it leads to a sign-in or token file, hooks, MCP or
plugin settings, anywhere else in `~/.gemini`, or Threadlines' own data folder.

Because the shared folders are links, what Antigravity writes in them lands in your real folders,
exactly as when you run `agy` in a terminal: a skill it creates in `config/skills` is a skill in
`~/.gemini/config/skills`. Threadlines itself only adds and removes its own links and copies. It
keeps a list of them beside the profile and never replaces or deletes anything else, and it skips
any profile folder that is itself a link, so it can't write into your own `~/.gemini` by accident.

Project rules and skills come from the project as usual: `AGENTS.md` and `GEMINI.md`, and skills in
`.agents/skills`, `.gemini/skills` and the older `.agent/skills`.

Threadlines reads which skills Antigravity loads, the way Antigravity finds them, and Settings
search lists them. Global skills are read through the account's profile, so the list matches what
that account's agent sees, including skills the agent keeps in its own profile. When two have the same name, the first wins in this order:
`~/.gemini/config/skills`, the project's `.gemini/skills`, `~/.gemini/antigravity-cli/skills`, the
project's `.agents/skills`, then `.agent/skills`. Folders a `skills.json` declares come after those: the project's
`.agents/skills.json` in the project and each folder above it up to the repository root, then
`~/.gemini/config/skills.json`. Threadlines follows the same rules as Antigravity for these files:
`inherits` reads another file, `include_only` and `exclude` match names exactly, a nested skill
loads only when `include_only` names it (`category/my-skill`), `~` is not expanded, and a project's
file can only point inside the project. A project skill folder that is a link to somewhere outside
the project is not listed, though Antigravity may still load it: Threadlines doesn't read outside a
project for it. Skills of plugins installed in that account's profile are listed unless the plugin
is turned off. Descriptions are cut to 1,024 characters. The list is read from the folder Threadlines runs in, like
other agents' lists, so a project's own skills show only when Threadlines runs inside it.

To use a skill, start the message with `/` and its name, as in a terminal (`/review this diff`).
Antigravity also picks a skill on its own when the task matches its description. The composer's
`$` skill list is for Codex only; Antigravity's skills are in its `/` list (below).

## Commands and Skills in the Composer

Typing `/` in the composer lists Antigravity's skills and its own commands, under Threadlines' own
(`/model`, `/plan`, `/theme`, `/default`). Picking one puts `/name ` in the message. In a room, the
list is the one of the agent the message goes to.

- Before Antigravity runs in a thread, the list has the skills Threadlines found (above).
- While it runs, it sends the commands that session offers (`available_commands_update`, the list
  Google fixed in 1.5.2 to be the session's agent's). They join the list, and where a command and a
  skill share a name, Antigravity's entry is the one shown. `/goal` and `/compact` show only when
  Antigravity offers them. The list lives only as long as the session: Threadlines doesn't save
  it, and after a restart the skills fill the list until Antigravity sends its own again.
- Antigravity's `/plan`, `/login` and `/logout` are left out: plan mode is the composer's `/plan`,
  and signing in or out is on the Antigravity row in Settings, where it also stops that account's
  chats. Typed by hand, they still go to Antigravity.
- Threadlines keeps at most 200 commands from a list, only names made of letters, digits, `_`,
  `.`, `:` and `-`, and short descriptions. A list that keeps changing reaches the composer at most
  every 5 seconds.

A message runs one of Antigravity's commands when the words you typed (spaces in front don't
matter) start with `/` and the name of a command that session offers or a skill Threadlines lists.
That message goes to Antigravity alone, as typed, since Antigravity only runs a command at the very
start of a message: in plan mode without the `/plan` prefix, and without what Threadlines would put
in front of your words (the project's instructions, the thread's history after a switch, an edit or
a move, the summary a fork starts from, notes from other threads). That waits for your next
ordinary message, also across a restart. Everything else is ordinary text: a name Antigravity
doesn't offer (`/etc is missing`), a path (`/tmp/out.log is empty`), a message sent as plain text,
and one an agent or a scheduled task wrote.

The thread's history counts as given to Antigravity only once the message carrying it actually went
out to Antigravity, not when Threadlines took the message: if Antigravity fails before that (setting
its model or mode, say), the next message carries the history again.

## Turns

Antigravity answers a message while work it started goes on: a command it waits for, a timer it
set (`schedule`), or a subagent it launched. When that work ends, the agent wakes and replies by
itself. Threadlines keeps the turn open meanwhile, so the thread shows it working and Stop stays on
screen, and the reply lands in the same turn. A dev server or other daemon doesn't hold the turn.
Stop cancels the turn and that work together (Antigravity 1.5.10 stops its commands and subagents on
a cancel). A turn that was only waiting on that work shows cancelled at once, but Threadlines keeps
track of the commands and subagents until the agent shows they ended (a command's end, or the
subagent's record saying it stopped), and a message sent meanwhile waits for that. If the agent
hasn't answered or ended that work 15 seconds after Stop, Threadlines restarts it and the turn ends
cancelled; a message that was waiting fails, and the next message picks the conversation up again.
A timer gives no word when a cancel ends it, so a stop doesn't wait on one. Stopping the session (or
Threadlines) while a turn is held ends that turn as interrupted. A reply the agent starts after the
turn ended opens a turn of its own, except the CLI's "request was cancelled" notice after a Stop,
which never shows. Threadlines waits 30 seconds for that notice; after that, a reply counts again.

Two limits keep a lost wake from leaving the thread working forever: a turn held only by commands
and subagents ends after 30 minutes without a word from the agent, and a reply the agent started
by itself ends 2 minutes after its last output if its closing usage update never comes. Both count
from the agent's last activity. A timer
holds the turn until it fires. When a reply ends with subagents still counted, Threadlines reads the
CLI's records of them (see Subagents below) and holds the turn only for the ones still at work, so
several reports answered in one reply, or a subagent the agent stopped, end the hold. A launch
counts only for the child its own call started, so a resumed conversation's older subagents never
stand in for a new one, and only the newest reading counts. When the records can't tie every
launch to its child (one not written yet, or a batch launch from before 1.5), each report (a reply
no finished command or timer woke) frees one subagent, and a batch launch counts each subagent in
it. If the
agent exits while a turn is held, the turn fails with that reason and the next message starts it
again.

A message sent while Antigravity is answering waits for that turn to end, as with other agents. One
sent while the turn only waits on work Antigravity started ends that turn, and goes at once.
Prompts reach the agent in the order they were sent, each turn's mode and model setup first.
Threadlines can also steer a running turn with a second prompt, which the CLI takes into it
(1.5.0+), but that ships off (`ANTIGRAVITY_STEERS` in
`apps/server/src/provider/antigravity/AntigravityTurns.ts`): a steer is recorded as accepted before
it is written, so an agent that exits at that moment would leave a steer shown that it never got.

All of this is one state machine (`apps/server/src/provider/acp/AcpTurnMachine.ts`), stepped in
order with the agent's updates. A prompt's answer takes its place among those updates where the
CLI wrote it, a step and the commands it issues run as one unit, and stopping the session is an
event the machine takes after everything already received (an answered prompt's usage included).
The machine's test walks every sequence of up to nine events with steering on and ten with it off,
and checks that each turn ends exactly once, Stop always has a deadline until the work it stopped
is over, every message hears back, and a hold with nothing left ends.

### Subagents

When Antigravity launches a subagent (its `invoke_subagent` tool), the subagent shows in the thread
like other agents' subagents: its role, its prompt, whether it runs, and the report it sent back.
Open it to read its recent steps. ACP says only that a launch happened, so the rest is read from the
CLI's own records in the profile (`antigravity-acp/brain/`, a private format read only for this;
the code is `apps/server/src/provider/antigravity/AntigravityChildRecords.ts`). They are read when
each reply ends and when the turn ends:

- A subagent that sent its report shows as done, with the report.
- One the agent stopped (`manage_subagents`) shows as stopped.
- Stop ends every running subagent with the turn.
- A subagent the records don't name shows as done once its turn has ended, and its view says
  "Antigravity did not record which subagent this started". A later reading that finds it still at
  work shows it running again.
- When the records can't be read (one the CLI is still writing, say), nothing is marked done; the
  next reading tries again.

The view is read-only: you can't message a subagent directly. The same records decide how long the
turn stays open (see Turns above).

### Tool rows

- An MCP tool the agent reaches through `call_mcp_tool` shows as that tool (server and name), not
  as a shell command, and doesn't hold the turn like a command. Only a call that is plainly that
  wrapper does: one that also carries a command or an edit stays a command or an edit. Its approval
  is asked the same way as any command's, and names the server, the tool and its arguments.
  If a later update shows the call is something else, it goes back to what that update says.
- An approval shows everything known about its call, even when Antigravity's request names only
  the call. If an update while you decide shows the approval is for something else, the card is
  withdrawn and asked again in the new words; the old card can't be answered.
- A command line longer than 8,000 characters keeps its start; output keeps its end. A cut never
  splits a character, and the timeline keeps a long command's start too.
- Screenshots and other inline images in a tool's result are left out of what Threadlines stores.
- Edits show the files they change with their added and removed lines; the turn's diff shows them at
  their real line numbers.

### Attachments

Images (PNG, JPEG, WebP, BMP) and audio go to Antigravity inline. PDFs go as a link to the saved file,
which Antigravity reads as a document. Text files go as text, in UTF-8, or UTF-16 when the file
starts with its byte order mark; one over 100 KB goes as a path instead, so it doesn't crowd the
conversation. Anything else (a spreadsheet, a video) goes as the saved file's path for the agent to
open with its tools. Images, audio and text each need Antigravity to say it reads that kind;
otherwise the file goes as a path. A PDF link needs nothing: every ACP agent reads links. A MIME
type's parameters (`; charset=utf-8`) don't change the choice. Files are read as they are on disk,
never through a link, up to each kind's limit and 50 MB inline per message.

### When a turn fails

Antigravity sometimes ends a turn normally while the reply is really an upstream error. Threadlines
reads the error the CLI reports (1.5.9+) and, where the CLI reports none, the last step of the
turn in the CLI's own session log (`antigravity-acp/conversations/<id>.db` in the profile, a
private format read only for this). The log doesn't say which prompt wrote a step, so an error
counts for the newest prompt when it is the log's last step and was written after that prompt went
out. That never hides the newest prompt's own failure; the cost is that an older prompt's late
error, with nothing written after it, fails a turn whose steer was answered. When the log can't be
read, the prompt's own answer stands (the agent's words about the error stay in its reply). The turn then fails with Google's words and a
Retry. An
exhausted quota fails with its reset time, so the usage-limit notice above the composer says when
it resets and can continue then. A conversation Google can no longer continue (a model rejected a
saved thinking block) stops its session, and the next message starts a new one with the thread's
history, also one sent in the moment the session is stopping. A message whose mode or model couldn't be
set never reaches Antigravity: its turn fails, and the earlier conversation Threadlines had put in
front of it goes with the next message instead.

### Editing an Earlier Message

Antigravity can't rewind its own conversation. When you edit an earlier message (or undo back to
one), Threadlines first stops anything Antigravity still runs for the thread (a running turn, its
commands and subagents, by a cancel, then a moment to wind down) and ends that session, so nothing
it ran can write over the files being restored. Then it restores the files. It also drops the
saved conversation from its own record of the thread, so the next message starts a new Antigravity
session and sends it the turns that are left: Antigravity no longer remembers the removed ones,
also when Threadlines restarts before that message. Nothing is started to do this when Antigravity
wasn't running. If Threadlines can't update that record, the thread says Antigravity still
remembers the reverted turns. If Antigravity can't be stopped at all, no file is restored and the
revert fails, saying so. If the files can't be restored after Antigravity was reset, the revert
fails and says both: the files stayed as they were, and Antigravity no longer remembers those
turns.

### Tokens

Each turn's tokens come from the CLI's answer to the prompt: input is its input plus cached reads,
and output already includes thinking. They count on the Usage page under Antigravity, priced at
Google's Gemini 4 API rates (an equivalent, not what a Google plan bills). A reply the agent starts
by itself reports no tokens, so it isn't counted. The context meter beside the composer reads the
CLI's context usage updates (1.5.8+).

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
Enterprise accounts (and accounts Google only reports per model) are metered per model, with no
window length, so each model gets its own row. A group that runs out stops only its own models.
When a limit stops a chat and Antigravity doesn't say when it resets, the reset time comes from
these numbers, so Continue at reset still works. The row also shows the signed-in
Google account's email (blurred until you show it).

The numbers come from Google, not from Antigravity: Threadlines asks Google's Cloud Code service
(`retrieveUserQuotaSummary`, the call Google's own Antigravity apps make) with the sign-in
Antigravity saved in this account's profile, under Threadlines' own name. Google doesn't publish
this API, so it can change or stop answering; the row then says it couldn't read the limits and
keeps the last numbers.

When the numbers can be stale:

- They are read every few minutes, when the provider status refreshes, so a chat's usage shows up
  within about five minutes. When one of Google's two hosts doesn't answer, the rows only it gave
  stay from the last read, with their age.
- Threadlines never renews the sign-in itself. Antigravity renews it while it runs, so after an
  hour or so without a chat the saved sign-in lapses. The last numbers stay, with their age, and a
  line says to start a chat to refresh them.
- A Gemini API key or Vertex AI bills per request and has no plan to meter, even if an earlier
  Google sign-in is still in the profile.

Requests go only to `daily-cloudcode-pa.googleapis.com`, `cloudcode-pa.googleapis.com` and, for the
email when the sign-in doesn't carry it, `www.googleapis.com`. Redirects are refused, so the
sign-in can't be carried anywhere else. The code is `apps/server/src/provider/antigravity/AntigravityUsage.ts`.

### Per-Use Billing

With a Gemini API key or Vertex AI, Google bills every request to you. Threadlines' Usage page counts
the tokens of chats run in Threadlines at Google's list prices, but not what you run elsewhere;
check Google AI Studio or the Google Cloud console for what Google bills.

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
