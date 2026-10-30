# Agents know Threadlines

Status: plan, rev 2 (Oct 29 2026). Rev 2 takes Sol's six findings on rev 1
(the guide must not vanish with the room tools, fail-closed writes, per-page
destinations, page-owned reveal, both link directions, a real drift check).

## The problem

An agent in Threadlines knows its tools, and nothing about the app around
them. Asked "can you start a thread on my PC?", an agent called
`thread_agents`, saw no linked computers, and could only say so. It could not
say where computers are linked (the left bar's Fleet, the Computers list, +),
that each direction has its own permission ("Works with other computers"),
or what this computer's settings are. The user found the page on their own.

Users ask agents about the app they are using: where a setting is, what a
feature does, why a tool said no. An agent that can answer, from facts, and
point at the right row is a large part of the app feeling finished.

## What agents get

1. **`app_guide`, one read-only room tool.** Ask it a question, a place or a
   topic; it answers in markdown: the matching places in the app (where each
   is, as it reads on screen; what it does; its current value on this
   computer when the server can see it), short topic pages on how features
   work, and a link for each place.
2. **Place links.** Each place comes with a markdown link
   (`[Settings › Threads › Agents can start threads](threadlines-place:threads.agentThreads)`).
   The chat draws it as a chip; clicking it opens the page and briefly
   highlights the row. This is "show me where": the agent points, the user
   clicks. No tool call, no card.
3. **Tools that say why not, and where.** Refusals that hinge on a setting
   or a missing link name the place and give its link (`thread_agents` with
   no linked computers; `thread_start` with starting threads off; schedule
   tools hidden; room invites off; browser site policy).
4. **One sentence of instructions** for providers that take instructions
   (`<threadlines_guide>`): questions about Threadlines itself are answered
   from `app_guide`, and places are linked with the links it gives. ACP
   agents get no instructions, so the tool description says the same.

Agents change no settings in this version (see "Changing settings, later").

## One catalog: places

`@threadlines/shared/appPlaces` (runtime data, used by server and web;
contracts stays schema-only). A place is anything a user can be sent to:

```ts
interface AppPlace {
  readonly id: PlaceId; // "threads.agentThreads", "fleet.worksWith"
  readonly kind: "page" | "section" | "row";
  readonly title: string; // exactly what the screen says
  readonly about: string; // one sentence: what it does
  readonly parent?: PlaceId; // row › section › page
  readonly route?: AppRoute; // pages: path; rows/sections: reveal search params
  readonly target?: "own" | "thread" | "fleet"; // pages: which computer it can show
  readonly keywords?: ReadonlyArray<string>; // words users say ("link", "PC", "phone")
  readonly scope: "computer" | "device" | "desktop"; // where its value lives
  readonly value?: PlaceValue; // how app_guide reads and words it (allowlist)
  readonly appliesWhen?: "desktop" | "mac" | "windows" | "linux"; // else everywhere
  readonly widensAgents?: true; // shown as "only you can change this"
}
```

- `PlaceId` is a union from the `as const` catalog, so a typo fails typecheck
  everywhere a place is named.
- Pages mirror `SETTINGS_NAV_ITEMS` and the left bar (Fleet, Scheduled,
  Usage, General Chats, Pull Requests). `SETTINGS_NAV_ITEMS` takes its labels
  and descriptions from the page places, so there is one copy.
- Dynamic rows (one per provider, linked computer, device, agent) are not
  catalogued one by one: their section is a place, and its `about` says what
  each row holds.

### The settings screens read their words from it

`SettingsRow` and `SettingsSection` take `place={id}`: the title comes from
the catalog, `data-place={id}` is set, and the description defaults to the
place's `about` (a row whose description is live status still passes its
own). About 80 rows in 14 files move to this. Select options whose values
`app_guide` reports (Off / Ask first / Allowed) take their labels from the
place's `value.options`, so the guide and the screen word a value the same.

## Values: what app_guide can see

The guide reports values only for places with a `value`, from one reader on
the server. Nothing else is read, so nothing else can leak.

- **Server settings** (`ServerSettings`, after `redactServerSettingsForClient`):
  the agent-facing switches (starting threads, rooms, invites, agent pages,
  command requests, artifacts, start-while-typing), new-thread defaults
  (agent, room, start in, worktrees from), writing models, archive and git
  fetch, streaming, analytics. Never provider env vars, binaries or secrets.
- **State the user set elsewhere**: linked computers, both directions: what
  their agents may do here and the most access they get (this computer's
  link record), and what this computer's agents may do there (the other
  computer's answer in `PeerDescriptor.access`/`maxRuntimeMode`, fresh when
  it answers within the describe wait, else "as last seen", else unknown),
  providers (on, signed in, not their keys), outside agents (count, most
  access), scheduled and event tasks (count, paused).
- **Device and desktop settings** (theme, alerts, diff and terminal prefs,
  wrap-up rules, site policy, keep running in background) live in each app,
  not on the server. The guide describes them and says "set on each device;
  I can't see yours."

## Topics

Short pages (each under ~250 words) on how things work, written as TS
strings in `apps/server/src/guide/topics.ts`, mentioning places as
`{place:threads.agentThreads}` (rendered as the place's path and link):

threads and worktrees; access levels; rooms and reviews; threads agents
start; linking computers (Fleet); phones and other devices; scheduled and
event tasks; outside agents and the `threadlines` command; providers and
sign-in; plugins, skills and instructions; the browser panel and sites
agents can visit; updates and release tracks.

A unit test fails on an unknown `{place:...}`. Prose about behavior can
still go stale: AGENTS.md's "Hit every surface" gains a line, "a change users
can see updates its guide topic".

## The tool

`app_guide` in the room toolkit (read-only annotation, so Pi auto-approves
it). Main runtimes and side "ask" answerers get it; "review" side runtimes do
not (they read only the checkout).

**Its grant does not hang on the other room tools.** Today a thread's agent
gets the room server only while rooms, invites or agent-started threads are
on (`ProviderCommandReactor`, `roomToolsWanted`), so the guide would vanish
exactly when the user asks "why can't you start threads?". Every local
thread's main runtime gets the room server; with those features off its
grant is `app_guide` alone (`roomToolsFor`). Threads another computer's
agent or an outside agent started keep getting no room server (their fence
is unchanged).

```
app_guide({ query?: string, topic?: string })
→ { outcome: "ok" | "no_match", answer: string /* markdown */ }
```

- No arguments: the topic list and the pages, one line each.
- `query`: plain words ("link my windows pc", "why can't you start threads").
  Deterministic scoring over place titles, abouts, keywords, parent titles
  and topic titles; up to 6 places and 2 topics. Each place: path, what it
  does, value ("now: Ask first"), and its link.
- `topic`: that topic page, places expanded.

Its description carries the rules for agents without instructions: use it
for any question about Threadlines itself before answering from memory; link
places with the links it gives; never tell the user to edit Threadlines'
files by hand.

## Place links in the chat

`threadlines-place:<id>` (the desktop app already owns `threadlines://`).
The file-link detector rejects other schemes, so there is no collision; the
URL transform must keep this one (react-markdown's default drops it).
`chatMarkdownUrlTransform` keeps the scheme; `MarkdownAnchor` renders a known
id as a chip (plain glyph, the place's path as label) and an unknown one as
plain text, so an old message never shows a dead link.

Clicking resolves the place to its page route, with the search params that
page already uses to reveal things (`?instance=` opens a provider card,
`?section=agents` and `?section=community`, Plugins `?tab=`), plus
`#place=<id>`. No generic "open whatever holds it" DOM walk: an inactive
Plugins tab is not in the DOM at all. Each page that hides places owns a
small reveal for them; the shared arrival hook only waits for
`[data-place=<id>]` to mount (bounded), scrolls it into view itself
(TanStack's own hash scroll looks for an element id, so it is not used), and
plays a short highlight: a tinted overlay fading out over ~1.5 s, opacity
only, none with reduced motion. Clicking the same chip again highlights
again (the hash carries a click counter).

**Another computer's thread.** What a place can show depends on its page,
so each page place says how it targets a computer:

- `device`/`desktop` places open here: they are this device's anyway.
- Fleet places open that computer's Fleet page, which shows every computer.
- Pages that already pick a computer or project (Plugins & Skills, Agent
  Instructions) open with the thread's computer (and project) selected.
- Other `computer` places on Settings pages show the app's own computer
  only. When the thread's environment is not the primary environment (the
  Windows app watching a Mac thread), the chip is not a link and its tooltip
  says "In Threadlines on Denys's MacBook Pro". Compare environments, never
  machines. (Seeing another computer's settings from here is a separate
  feature.)

## Tools that say why not

Each refusal below gets the place's path and link, built from the catalog
(a server helper `placeRef(id)`), so wording matches the screen:

- `thread_agents` with no linked computers, and `thread_start` naming a
  computer that is not linked or not reachable.
- `thread_start` / `thread_send` with starting threads off; outcomes
  `off`, `asked_user`.
- Schedule tools while starting threads is off (hidden today; the guide
  explains why they are missing).
- `room_invite` / `room_available_agents` with invites off.
- Browser tools refused by "Sites agents can visit".
- `ask_user_to_run` with command requests off.

## Changing settings, later

Not in this version. When it comes: a `settings_change` tool whose every
call is a card the user accepts or declines, limited to an explicit
server-side allowlist of writable settings (fail closed: a place is not
writable unless listed). Every underlying key a change touches is checked
against the list, including aggregate actions: "Restore defaults" turns
rooms, pages, command requests, invites and thread starts back on, so it is
never agent-callable. `widensAgents` stays as metadata the guide shows ("only
you can change this"); it marks everything that gives agents more reach: starting threads, rooms,
invites, agent pages, artifacts, command requests, start-while-typing,
new-thread agent and room, providers and sign-ins, computer links and their
access, outside agents, devices and relay, plugins, skills, MCP connections
and instruction files, scheduled and event tasks, per-thread access, site
policy, server exposure and Tailscale, keep awake for scheduled tasks, keep
running in the background (it keeps scheduled tasks and linked computers
working with the window closed). A
prompt-injected agent could otherwise unlock itself.

## Providers

The tool reaches every provider that gets the room server (Claude, Codex,
ACP incl. community agents, OpenCode, Pi, Muse when its host grants session
MCP). The instruction sentence goes into each instruction builder (Claude
append, Codex developer instructions, OpenCode, Pi, Muse); ACP relies on the
description. Outside agents (`threadlines` command) do not get it in this
version.

## Testing

- shared: catalog integrity (unique ids, parents exist, every row's page has
  a route, every `value.options` key is a valid setting value).
- server: `app_guide` at the tool boundary: a query finds "Agents can start
  threads" with its value; a linked computer appears with its permissions;
  provider secrets never appear in any answer; unknown `{place:}` fails.
- web unit: place link parsing/resolution (known, unknown, another
  computer's thread).
- The drift check, two halves. (1) A source test: every catalogued row and
  section id is used as a `place` somewhere in the web app, and every
  `<SettingsRow`/`<SettingsSection title=` in it passes a `place` (rows built
  from data, like provider fields from their schema, are dynamic sections
  and listed as exceptions; their section is the place). (2) Places carry
  `appliesWhen` (desktop only, a platform, a capability), so the guide says
  "on the desktop app only" instead of promising a row that is not there.
- browser: a place chip opens Settings › Threads and highlights the row; one
  opens a provider card through `?instance=`.
- Existing instruction-string tests updated (Codex, Claude).

## Build order

1. Catalog + `placeRef`/link helpers + topics skeleton (one owner: me).
2. In parallel, after 1:
   - server: value reader, `app_guide` and its grant, refusals, instructions
     per provider, the friendly wording for the tool in the chat
     (`activitySteps.ts`);
   - web A: `SettingsRow`/`SettingsSection` `place` prop and the row moves;
   - web B: chat chip, link resolution, arrival highlight.
3. Topics written, AGENTS.md line, gates, review, live test with a real
   agent ("where do I let your agents start work on my PC?").

## Open questions

- Is a markdown link (no card) enough for "show me", or do users miss it?
  The chip is styled like file chips, which they already click.
- Should side "ask" answerers get `app_guide`? Proposed yes (read-only).
