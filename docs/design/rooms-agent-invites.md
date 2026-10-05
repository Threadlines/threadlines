# Rooms: agents bring in other agents

Status: plan, rev 2 (Sep 28 2026), after an independent review by GPT-6-Astra.
Builds on rooms-slice-2.md (room tools).

## Why

Only the user can add an agent to a thread today. An agent that would benefit
from a second model (a cross-model review, say) has no way to know which
agents exist or to ask for one, so developers without custom instructions
never get this. But adding an agent spends the user's quota on another
provider (per use, for API-key users) and, once a thread has been a room,
turns revert off for good. So the agent may suggest; the user decides, unless
they opted out of being asked.

## What the user sees

- With Rooms on, the thread's agent can see which other agents are available
  (signed-in providers and their models) and ask to bring one in to review
  its work.
- The ask shows as a card docked on top of the message box (where tool
  approvals sit) and as a line in the chat where it was made:
  "Opus 5.5 wants GPT-6-Astra to review its changes", the agent's one-line
  reason, the review request (expandable), and who pays ("Codex · ChatGPT
  Pro", or "Claude API Key · billed per use").
- Three buttons:
  - **Review only**: one independent review (fresh, no conversation, the
    request and the captured changes only). The thread stays as it is;
    revert keeps working.
  - **Add to thread**: the agent joins as a teammate and does the review; the
    thread becomes a room. The button's note says "Makes this a room. Revert
    turns off for good."
  - **Not now**: nothing runs, and the agent cannot ask again in this thread
    until the user writes.
- The review's answer shows like a side answer and goes back to the agent
  that asked, as its next message.
- Settings, under Rooms: "Agents bringing in other agents": Off, Ask me
  first (the default), or Without asking. Without asking applies the agent's own pick
  (review only or teammate) at once; its description says that can spend
  another provider's quota and, for a teammate, turn revert off for good. The
  chat line still shows what happened and that no one was asked.

## Design

### Settings

Both switches live with the computer (server settings), so every device
connected to it agrees, a phone included:

- `enableRooms` (Rooms, out of preview since Sep 30 2026): absent means never
  chosen, which is on. Off hides the room entry points in the clients (agents
  in the model picker, the Rooms filter) and turns invites off.
- `agentInvites: "off" | "ask" | "auto"`: absent means never chosen, which is
  `ask`. Shown under the Rooms row, greyed out while Rooms is off; the choice
  is kept for when Rooms comes back on.

One rule, `agentInvitesMode` in `@threadlines/shared/serverSettings`, gives the
mode in effect: the choice while Rooms is on, `off` otherwise. The server reads
it live at every invite call and every approval, not only when tools are
attached; when it turns off (either switch), invites awaiting the user are
cancelled at once and again at startup, and new ones are refused. The tool
reads the setting and the provider again after capturing the changes, right
before it submits.

### Guest agents

A reviewer brought in for one review is recorded as a participant with
`guest: true` and `leftAt` set when it is created. Membership questions are
split explicitly (packages/shared/threadParticipants.ts, apps/web/rooms.ts),
and every direct `participants.length` check is audited against them:

- has teammates now (`activeParticipants`, guests excluded by leftAt): room
  UI, picker, "@", sidebar, recipient;
- ever had a teammate (`isRoomThread` / `hasRoomHistory`, guests ignored):
  revert off, room catch-up header, native forks, room session handling,
  checkpoint handover;
- has agent records (any participant, guests included): author labels, Stop
  and restart recovery of agent requests.

So a guest-only thread keeps revert and plain-thread behavior, and the
existing side-review machinery (fresh side runtime keyed by participant) runs
the review unchanged. "Add to thread" turns the guest record into a member
(guest false, leftAt null), so its earlier review keeps the same author. A
guest's name stays reserved (adding an agent under it is refused), so it is
never renamed when it joins. Only
Codex and Claude agents can be invited (only they run locked-down review
runtimes).

### Requests

Invites reuse room agent requests (`thread.agentRequests`, JSON) with a new
kind, `invite`, so the limit (3 per user message), Stop's hold and epoch, and
restart recovery apply:

- request fields (optional in the schema): `reason`, `suggestion` ("review" |
  "teammate"), `billing` (instance id, auth type and label when asked);
- new status `awaiting_user`; new outcome `declined`;
- `agentRequests.invitesPaused` (decoding default false): set by Not now,
  cleared with `hold` by the user's next submission
  (`thread.agent-requests-reset`), through the projector, SQL projection and
  web store alike;
- the request message durably carries the invite (new message column
  `invite`, migration 062, JSON, added without a backfill): reason,
  suggestion, billing, the applied choice, and whether it was automatic.

Commands:

- `thread.agent-request.submit` with `kind: "invite"` (server-only, from the
  MCP handler): creates the guest participant in the same decision; with
  `autoChoice` it goes straight to that choice.
- `thread.agent-invite.respond` (client): `{ requestId, choice }`.

Decisions (agentRequestDecisions.ts, pure):

- submit: caller holds the thread with a turn in flight; refused when paused,
  held, over the limit, or another invite is awaiting the user.
- respond (and the auto path) revalidates everything that can change while
  the user thinks: the request is `awaiting_user`, the epoch is unchanged, no
  side answer is running, voice is off, the caller is still in the thread.
  Then, in one decision: for teammate, the guest becomes a member; the review
  is sent as its own message (`invite-review:<requestId>`, kind review, the
  same text and captured changes), so the chat shows it like any independent
  review; its side turn starts (askedBy the caller); the request runs; the
  invite message records the choice. decline settles `declined` and pauses
  invites.
- Provider checks the decider cannot make (the instance is still enabled,
  signed in, a Codex or Claude agent, and its billing matches what was shown)
  run in the server before dispatching respond or an auto submit; a change
  refuses with "Its sign-in changed since the agent asked; ask it again."
- An invite is not tied to the caller's turn: it survives that turn ending.
  Stop cancels it and anything it started (Stop now ends agent requests in any
  thread with open requests, not only rooms); the caller leaving cancels it.
  An invite waiting for the user survives a restart (nothing of it was in
  flight); one whose review was running settles as failed, with the reason.
  An invited review is not tied to the caller's turn either: it keeps running
  when that turn ends. Stop moves the epoch in any thread that ever had
  another agent, guests included, so a reply already on its way is dropped.
- Side turn settles: in the same decision the request settles and, for
  invites, the answer is queued to the caller as a reply message
  (`invite-reply:<requestId>`, fromAgent the reviewer, kind `reply`), with the
  hand-off reply's epoch, caller and duplicate guards.
- Revert is refused while an invite is awaiting the user, running, or its
  reply is still queued ("Finish or decline the agent's request first"). The
  web never offers revert on agent-written or side messages. An invite and an
  invited review sit beside a turn and never start one
  (`@threadlines/shared/transcriptRevert`): revert, native rewind and retry
  skip them when they look for a turn's message.

### Tools

The room endpoint is attached to the thread's own agent in every thread while
invites are not off. Each live session picks the tools up at its next turn
through the existing `room_tools` restart with resume (deferred while it has
background work): a one-time cost per session. Two new tools:

- `room_available_agents`: Codex and Claude providers that are enabled,
  installed and signed in, each with its models (picker names), how it is
  paid (auth label, per use or plan), which models are already in the
  thread, and the reasoning levels each model offers.
- `room_invite`: `{ agent, request, reason, basis?, suggestion?, reasoning? }`.
  `reasoning` names one of the model's levels by id ("xhigh") or picker label
  ("Extra High"); the guest is recorded with that option, the card shows it
  next to who pays, and its review runs at it. Left out, the guest carries no
  option and its provider picks. A level the model lacks is `refused` with
  the levels it has. The same model invited again takes the new invite's
  level. Captures
  the review basis like room_review, submits, and returns at once:
  `asked_user` ("The user will decide. If they agree, the review comes back to
  you as a message; if not, you will not hear back. Do not ask again unless
  the user asks.") or `started` when no approval is needed, or `refused`.
  The existing room tools stay; in a plain thread room_ask/review/hand_off
  refuse (nobody to address).

### Catch-up

A plain thread with only guests gets no room header. A reply to an invite
gets a short frame: "The message below is <reviewer>'s independent review,
which you asked for."

### Web

- Card: the invite pending decision renders in the composer-top slot after
  approvals and questions, with the three buttons and the notes above.
- Chat: the request message renders like other agent requests ("Opus 5.5 →
  GPT-6-Astra · wants a review"), with its outcome afterwards ("review only",
  "added to the thread", "not now", "cancelled"). The reply message renders as
  one line ("Sent GPT-6-Astra's review to Opus 5.5"), since the review itself
  is right above.
- Sidebar: a thread with an invite awaiting the user shows as needing input.
- Settings rows under Rooms.

## Not changing

Manual adding stays as is. Guests never count toward "is a room". Revert
rules for real rooms are unchanged.

## Tests (focused)

- decider: submit refusals (paused, held, limit, pending invite), each choice
  (events and request state), decline pauses until the user writes, invite
  survives the caller's turn ending, Stop cancels it.
- guest: a guest-only thread is not a room (revert allowed, no room header).
- reactor/ingestion: the review answer is routed back as a reply.
- MCP handlers: available agents lists signed-in providers only; invite
  returns asked_user / started / refused as set.
- web: the card's three buttons dispatch the right choice; an emptied/guest
  thread shows no room UI; the settings migration writes once.
