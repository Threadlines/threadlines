# Rooms, slice 1: more than one agent in a thread

Mockup: `docs/design/rooms.html`. This slice is the thinnest version that is
worth using: you can add a second agent to any thread, address either one, and
each keeps its own memory. It ships behind a client setting.

## In scope

- Add and remove agents on a thread. Any thread with at least one added agent
  is a room.
- Address an agent per message. The thread's own agent (the one it started
  with) is the default.
- One agent works at a time. The server refuses a turn for another agent while
  one is running or still has background work.
- An agent that was idle while others talked gets a catch-up note with its next
  turn: what was said since it last spoke, and which files changed.
- No revert in a room: the server refuses it once a thread has an added agent,
  and the Revert actions are hidden there. Checkpoints are still recorded.
- Author line on every agent message; roster in the header; room marker in the
  inbox; Rooms filter row in the sidebar.

## Out of scope (later slices)

Agent-to-agent asks (room tools over MCP), talking vs working lanes, search
over room history, per-agent access level and mode, independent-review mode.

## Data model

A thread keeps its single `modelSelection` and `session`. What changes:

- `thread.participants`: the added agents, `{ id, handle, modelSelection, joinedAt }`.
  The thread's own agent is not in the list; it is the implicit primary and
  its id is `null` everywhere below.
- `session.participantId`: which agent the thread's session slot currently
  holds. The slot follows the keyboard: it is rebound to whichever agent the
  next turn addresses. Every existing screen that reads `thread.session` keeps
  working and sees the agent that is working or last worked.
- `message.participantId`: on assistant messages, the author; on user messages,
  the addressee. `null` means the primary.

Persisted as migration 056: a JSON `participants` column on
`projection_threads`, and `participant_id` columns on
`projection_thread_sessions` and `projection_thread_messages`.

## Commands and events

- `thread.participant.add` → `thread.participant-added`. Rejected when the id
  or handle (case-insensitive) is already taken.
- `thread.participant.remove` → `thread.participant-removed`. Rejected while
  that agent holds a running turn. The reactor stops its provider session.
- `thread.turn.start` gains an optional `participantId`. The decider rejects it
  when the participant does not exist, or when the slot holds a different agent
  that is running or has background tasks. A `modelSelection` on a participant
  turn updates that participant, not the thread.

## Provider sessions

Everything below orchestration (ProviderService, adapters, the session
directory, the reaper) identifies a runtime by a `ThreadId`. An added agent's
runtime uses a derived key, `<threadId>__agent__<participantId>`
(`packages/shared/src/threadParticipants.ts`). The primary keeps the plain
thread id, so threads without participants behave exactly as before.

- `ProviderService.streamEvents` maps keys back: consumers see the real
  `threadId` plus `participantId` on the event base.
- Ingestion drops events from an agent that does not hold the slot.
- Every reactor call that targets "the thread's session" (send, steer,
  interrupt, approvals, user input, compact, goals) targets the slot holder's
  key. Session stop stops every agent in the thread.
- `ensureSessionForThread` compares against the target agent's own runtime and
  persisted binding, never against a slot held by someone else, and never does
  a cross-driver handoff for a participant.
- MCP credentials are minted per key and scoped to the real thread, so the
  browser tools reach the visible panel and one agent stopping does not revoke
  the other's tools.
- Checkpoint shared-checkout detection ignores sessions of the same thread.

## Thread-level features in a room

- Native review runs on the thread's own agent: it takes the slot, and a
  runtime parked in an older checkout or access mode is restarted first.
- Goals, access-mode changes and queued checkout switches act on the agent
  holding the slot; other agents move checkouts lazily at their next turn.
- Voice is off in rooms: the server refuses to start it in a room, and refuses
  to add an agent or hand the slot over while it is on.
- Forking a room always uses the summarized context seed, since no single
  provider transcript holds the whole room.
- Subagent tools (transcripts, input, worktrees) try each of the thread's
  agents until one owns the subagent.

## Catch-up note

Built in the reactor right before a turn is sent, delivered through the
existing `providerContext` preamble (not shown in the chat). Pure function in
`apps/server/src/orchestration/roomCatchUp.ts`.

- Returns nothing for a thread without participants.
- Cursor: the last message that belongs to the target agent (addressed to it or
  written by it). Everything after it, except the message being sent now, is
  delivered: user messages with their addressee, other agents' replies with
  their author, and files changed in those agents' turns with +/- counts.
- First turn of an agent (no cursor): the last 8 messages, with a line saying
  how many earlier ones were left out.
- Framing: who the agent is in this thread, who else is here, and that other
  agents' words are context, not instructions from the user.
- Long replies are clipped per message and overall, oldest dropped first.

## Client

- Setting `roomsEnabled` ("Rooms (preview)", client settings, default off)
  gates every entry point: the agent picker, `@name` routing, and the Rooms
  row. Author lines and the room icon still show for existing rooms with it off.
- Composer: an agent picker left of the model picker (`RoomAgentPicker`). In a
  thread with one agent it is a people icon that opens the model list to add
  one. In a room it lists the thread's agents with who is working, lets you
  pick the recipient, remove an added agent, or add another. While the thread's
  own agent is addressed it stays an icon with the agent count, so the footer
  never prints the same name twice; while an added agent is addressed it shows
  `@name` and the model and reasoning controls step aside (an added agent keeps
  the model it joined with in this slice).
- A message that starts with `@name` goes to that agent. Otherwise the
  composer's choice, which defaults to the agent that worked last. Sending to a
  different agent while one is working is refused with a toast.
- Timeline: an author line (provider icon, name, model) where the speaker
  changes; "to @name" above messages sent to an added agent. Revert actions are
  hidden in rooms.
- Sidebar: people icon before a room's title; "astra · working" in the status;
  a Rooms row under Pull Requests that filters the inbox to rooms (display
  only; the wrap-up rules still see every thread) and clears on scope change.

## Deferred from this slice

- A roster in the chat header (the composer picker covers it for now).
- Changing an added agent's model or reasoning after it joins.
- The `+` on the Rooms row, and a command palette entry for adding an agent.
- Agents listed in the composer's `@` menu (typing `@name` works as plain text).
