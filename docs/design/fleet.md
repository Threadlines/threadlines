# Fleet: linked computers, the rail, Fleet page and Scheduled tasks

Status: plan rev 3 (Oct 20 2026). GPT-6.1 Sol reviewed rev 1 (18 findings) and rev 2 (8 of those partly open, 15 new). I checked every finding against the code; all held. Rev 2 and rev 3 fix them (see "Rev 2 changes" and "Rev 3 changes"). One decision is open for Will (see "Open decision").

Mockups (approved by Will in chat, Oct 20): the Fleet graph with traveling dots, the threads-by-computer list, the Links section, and the sidebar rail (open, and hidden down to the rail). The visual rules from those mockups are written out below, so this doc stands on its own.

## Why

A T3 Code power user's review (x.com/tenobrus, Oct 19 2026) praised T3 for linking several computers and phones, agents starting and messaging threads, and multiple subscriptions. His big letdown: threads on different computers can't reach each other. T3 is building that now in open PRs (#21670-21673, #21824-21826). Nothing of it is merged. He also disliked T3's sidebar ("no good way to organize") and its auto-filing of quiet threads ("settling", our Wrapped).

Threadlines has the same gap. Our server only knows itself (`environment/Services/ServerEnvironment.ts`). Saved computers and their secrets live only in the client. The thread tools are scoped to the caller's project on one server.

This push makes your computers work as one fleet:

1. **Computer links.** A computer's server keeps its own credential for another computer and talks to it directly, with no client in the middle.
2. **Agents across computers.** `thread_start` and friends can target a linked computer. Reports come back into the parent like local ones.
3. **Move a thread to another computer** (issue #48), over the same link.
4. **The rail and the Fleet page.** A vertical icon rail replaces the top of the sidebar. Hiding the sidebar leaves the rail. A new Fleet page shows computers, providers and running work as a graph.
5. **Sidebar organization.** Optional grouping by project or computer, and a switch to stop the 2-idle-day auto-wrap.
6. **Scheduled tasks.** A Scheduled page and a per-computer scheduler that starts threads at set times, matching Claude Desktop scheduled tasks and Codex automations, for every agent.
7. **Issue #38.** The working row says what is starting and where ("Starting Codex on Mac mini").

Out of scope for this push (agreed with Will): rooms whose agents live on different computers.

## Decisions already made by Will

- Build all of it in this push, Scheduled included.
- Fleet graph look:
  - This computer sits in the center, and each computer is a node with a connection dot.
  - Provider nodes hang off each computer, with a running count.
  - Lines carry status (below), and a glowing dot travels along working lines.
- The full icon rail: Threads, General Chats, Pull Requests, Fleet, Scheduled, Usage; Settings at the bottom.
- Hide the sidebar = keep the rail. The rail shows needs-you and working counts.

## Background running on Windows and Linux (decided Oct 20: opt-in setting, built in PR 3)

**Keep running when the window closes, on Windows and Linux.** Closing the last window quits Threadlines on Windows and Linux (DesktopLifecycle.ts:369-378), and that stops the server. So links and scheduled tasks to a Windows computer only work while its app is open. macOS already keeps running.

My recommendation: an opt-in setting, "Keep running in the background when the window closes", default off so today's behavior stays. When on:

- closing the window hides it to the tray;
- the tray menu gets Quit;
- the quit prompts count background work.

Claude Desktop's local scheduled tasks have the same limit ("only fires while the app is open"), so parity doesn't require it. Will chose the opt-in setting. User-facing copy for links and schedules says "while Threadlines is running on that computer". Settings › General gets the switch on Windows and Linux only.

Quit prompts already count work by computer (PR #492), and they count background work and active schedules too. Quitting from the tray stops the server as today.

## Rev 2 changes (from Sol's review)

1. **Link authority is the host's, persisted before any session.** The invite's purpose is stored with the invite, then copied into the device row before a session is issued. Restart recovery uses that copy. The joiner's claimed `kind` never decides access.
2. **Real fence.** Link-started threads get no Threadlines agent tools at all, and their ownership is carried in trusted events. The existing depth rule was not enough, since attached children can list and read other threads in their project.
3. **Reactor ownership is partitioned.** Local child machinery skips remote requests; `RemoteChildReactor` owns them, including the cancellation checks that today treat a missing local child as cancelled.
4. **B keeps a durable request ledger.** It records each incoming start and send, binds it to its message and turn, and reconciles at startup.
5. **Durable cancellation** keyed by the request id, with tombstones on B and terminal outcomes for every request on the watch stream.
6. **Windowless operation** is an open decision for Will (above), not an assumption.
7. **Scheduler runs** are recorded as launch intents, inserted in the same transaction that advances the slot, then launched in resumable stages, with startup reconciliation.
8. **Move** gets a freeze, prepare, commit and abort protocol with a transfer id, resumable on both sides.
9. **Move's git manifest** is exact: HEAD SHA, bundle prerequisites, untracked files, a binary diff, and branch-collision rules.
10. **Import** carries attachments and turn origins. Checkpoint reverts stop at the move boundary.
11. **Agents are resolved on the destination** (B-local instance ids) for remote starts and moves.
12. **Scheduled continuations** use `thread.follow-up.submit`. Runs are bound to their own message and turn, and never wrap newer work.
13. **Run tools** attach to run threads on their own, and only where the driver supports Threadlines tools. Run status otherwise comes from turn events.
14. **Cron** takes 5 fields (minute resolution) and must have a next occurrence when saved. Each task's errors stay with that task. Slots are UTC instants. DST and time-zone rules are written down.
15. **#38 gets a real launch signal** from the one place the reactor actually starts a session. `starting` alone also covers warm sessions.
16. **Rail geometry** is specified for macOS traffic lights, the fixed-position sidebar, Windows overlay controls and the phone.
17. **Families stay with their parent.** Lineage keys are environment-scoped, and the machine filter can show a remote child on its own.
18. **Waves re-planned** so no two parallel builders share a file. Every new UI is gated by server capabilities.

## Rev 3 changes (Sol's re-check of rev 2)

These override anything below that disagrees.

1. **Moves go through the link's authority.**
   - `off` refuses the move, `ask` waits for Allow on B ("Windows PC wants to move a thread here"), and `allowed` accepts it.
   - The imported thread's runtime mode is capped at `link_max_runtime_mode`.
   - An imported thread never starts a turn by itself: only a person using B sends its next message. That's why it can be an ordinary B thread once committed.
2. **Move commit is atomic and the two outcomes exclude each other.**
   - B imports into a hidden _prepared_ thread: the decider refuses every command on it, and clients never list it. One event (`thread.move.imported`) makes it visible.
   - B persists the transfer as `prepared | committed | aborted`. Abort is refused after commit, and commit is refused after abort. An abort leaves a tombstone, so a late prepare or chunk is refused.
   - A unfreezes only after B durably confirms the abort. When B can't be reached, A stays frozen with "Waiting for Mac mini".
   - "Keep it here" is offered only once B confirms the abort, or once the link is removed. The second case warns that a copy may exist on B.
3. **The B ledger stores the full request.** Each row holds the immutable payload: prompt or send text, launch config, parent metadata, and ids reserved at acceptance. Every pre-turn stage (create, worktree, setup, deliver) resumes idempotently from that row after a crash, approvals included.
4. **The decider validates remote reports remotely.** `isStaleReport` (childThreadDecisions.ts:940-952), and every other report or request check that looks up a local child, takes the remote branch when `origin.environmentId` is set. That branch checks the parent's remote-child record and its epochs, at queue time, send time and restart.
5. **A keeps remote children after their requests settle.** The parent's child state gains `remoteChildren: [{ environmentId, threadId, handle, title, attachmentEpoch, cachedStatus, updatedAt }]`, separate from `open` (settling removes open entries, childThreads.ts:292-302). `thread_read`, `thread_send`, `thread_stop`, family rows and report validation use it.
6. **Cancels overtake.** Recording a cancel deletes any unsent start or send for that request from the outbox. The cancel is then sent at once, not queued behind an in-flight start. B serializes work per request id and re-checks the tombstone before every bootstrap stage.
7. **Remote sends keep their origin, and turns bind explicitly.**
   - B delivers a remote send with a new internal command `thread.remote-request.queue`, the child-side half of `thread.child.send`. It writes `message-sent` and `follow-up-queued` with a `fromThread` that carries `environmentId`. `thread.follow-up.submit` has no origin field (contracts orchestration.ts:2433), so it isn't used.
   - The ledger binds the request's `turn_id` from `follow-up.send-queued`: the steered turn id when it steered, the new turn otherwise.
   - Scheduled continuations bind the same way.
8. **Move requires zero background tasks of both kinds.** `childHasLiveWork` lets `pendingBackgroundTaskCount: 1` through when `awaitedBackgroundTaskCount` is 0 (childThreadDecisions.ts:653). The move check requires both counts to be zero, and the decider checks it in the same decision as the freeze.
9. **A scheduled run's intent snapshots its launch config** (prompt, project id and cwd, workspace, agent, modes, target) in the run row. Resuming reads only the snapshot, never the edited task.
10. **Overlap counts every unfinished run.** The slot transaction counts the task's runs in `launching`, `queued` or `started` with a live turn, for the per-task rule and for the per-computer cap of 3.
11. **Any checked-out branch is occupied.** On B, a branch checked out in any worktree, or existing at another SHA, is taken. The move picks `<branch>-from-<computer>`, with a number suffix when needed, and saves the choice in the transfer row so retries reuse it.
12. **`startupPhase` clears when the wrapped `startSession` effect completes or fails**, guarded by a launch generation number. Codex signals readiness with `session/ready` → `session.state.changed` (CodexSessionRuntime.ts:2802), not `session.started`, so a per-event rule would miss it.
13. **DST follows Effect.** Effect's cron resolves times compatibly (.repos/effect/packages/effect/src/internal/dateTime.ts:774,859). A nonexistent 02:30 becomes 03:30, and an ambiguous time takes the earlier instant. The docs and UI say exactly that.
14. **The resize budget includes the rail.** The guard at AppSidebarLayout.tsx:123 subtracts the rail width as well, so the main pane keeps its 40 rem minimum.
15. **Cross-computer lineage moves to PR 5.** PR 2 does grouping and the machine filter over today's local lineage, and makes keys environment-scoped where the data already exists. Remote parents and children in the sidebar are PR 5, after PR 1 ships the fields.

## Rev 4 changes (Oct 21): Fleet is where your computers live

Will approved this on Oct 21 from a mockup in chat. Sol reviewed the first draft and found 10 gaps. All 10 were checked against the code and are fixed below. Rev 4 overrides anything below that disagrees, and it replaces Part 4's "Links section".

Fleet and Settings › Connections each get one job:

- **Fleet is your computers:** what they're doing, adding and removing them, and whether agents may start work across them.
- **Settings › Connections is this computer's door:** who can get in (phones, browsers, linked computers) and how (network options).

Users learn one idea, "my computers", instead of three: a computer this app uses, a device that uses this computer, and a link.

### R4.1 The list column

The list is the computer list, and each row opens that computer's page. "All computers" stays the graph page, and clicking a computer node in the graph also opens its page (instead of filtering the list). Back/forward and deep links work.

Who's in the list:

- this computer, when the app has a primary server (desktop, or the browser served by a server);
- every saved computer;
- every linked computer this app hasn't saved, from each connected server's links snapshot (outbound and inbound).

Keys and merging:

- Entries are keyed by environment id.
- An inbound link whose `environmentId` is still null (the peer hasn't introduced itself yet) gets a temporary entry keyed `device:<deviceId>`, labelled "<label> · waiting to hear from it". It merges into the environment entry once the id arrives.
- A saved computer and a link to the same environment id are one entry. The label is the saved one when the computer is saved, else the link's.

Rows and adding:

- A computer being added (pairing in progress) shows as a row: "Waiting for approval · <comparison number>", with Cancel.
- "+" in the list header opens the existing "Connect to a computer" dialog.

Routes: `/fleet/$environmentId`, plus `/fleet/device/$deviceId` for temporary entries.

### R4.2 A computer's page

**Header.** The page title is the computer's name. A mono line gives the connection state and route ("On your network", "Through the relay", "Offline · 2h ago") and the providers with live counts.

**Connection**, a quiet group. Every piece of today's saved-computer row in Settings lives here. Nothing is dropped:

- status, route, last connected, the SSH target when there is one, and the last connection error;
- the version-mismatch warning (ConnectionsSettings.tsx:180, 1170);
- Disconnect and Stop trying, which keep the computer saved (ConnectionsSettings.tsx:1194);
- Reconnect;
- after access was revoked, "Connect again with a new code", because an ordinary reconnect can't fix that (1119, 1189);
- the pending pairing state with its comparison number and Cancel (1132, 1179).

There is no Rename today, and Rev 4 doesn't add one.

**Works with other computers**, a quiet group.

- **Pairs.** There is one row per other computer in the fleet, named on both sides. There is no "here" or "this Mac" wording, so the page reads the same from desktop, the hosted web app and a phone, where the device in hand isn't a computer with a server.
- **Directions.** A row's direction lines read "Mac's agents can start work on Windows PC" and "Windows PC's agents can start work on Mac". Each line has the access dropdown (Allowed / Ask first / Off) and a most-access dropdown (the runtime mode cap). Each line reads and writes the receiving computer's inbound link through the app's connection to that computer (`links.setAccess`; a `client` session may do this, Part 1).
- **One direction linked:** that line shows its settings, and the other line offers Link for just that direction.
- **Neither direction linked:** one Link button creates both. If one fails, that line says why and offers Retry.
- **Creating a link** needs both computers connected to this app and both reporting `computerLinks`. Otherwise Link is disabled with the reason ("Connect to Mac mini first", "Mac mini needs a newer Threadlines").
- **Existing links are always manageable** on the side that holds them, whatever the remote reports. Capability gates only creation.
- **The owner of a setting is unreachable:** its line shows the last known value, disabled, with "Windows PC is offline".
- **A failed or revoked link** says what happened in plain words (from `lastError`) and offers Link again.
- **Pending requests** from that computer sit at the top of its pair row as approval rows (rows, not cards): "Windows PC wants to start a thread: <title>". Each shows the project, the parent thread and a one-line prompt preview, with Allow / Deny (`links.respondRequest`). The same requests also show in the sidebar inbox (Part 2, "Ask first") and at the top of the All computers page.

**Unlink** removes both directions and stops the work the link started.

- **Confirm.** The dialog lists what will stop: "2 threads Mac started on Windows PC are still running. Unlinking stops them." Unlink then cancels pending requests and stops running link-started threads on both sides. The server's inbound removal gains an explicit `stopRunning` that passes `stopThread: true` to `dropLink` (today it passes false: ComputerLinks.ts:355, LinkRequests.ts:1045, 1225).
- **Each direction reports its own result.** Today `links.remove` removes one direction per call, and the outbound path ignores a failed remote `peer.unlink` after 5 s, then deletes its record (ComputerLinks.ts:373). Rev 4:
  - Unlink calls each owning computer directly through the app.
  - When one side is unreachable, the dialog says so up front and offers "Unlink on Mac now. Windows PC finishes when it's back."
  - The reachable side records a pending unlink, and the other side applies it on its next contact. The peer refuses a revoked link's requests, so nothing new starts meanwhile.
  - The outbound path never reports success for the remote half it couldn't confirm.
- **As built.**
  - An offline computer hears the unlink over the other computer's link to it. When there is none (only its own agents worked on the other computer), the dialog promises only what happens: "Mac mini is offline. It can't start work on Mac after this, but it still lists the link until you unlink again while it's online."
  - Stops are owed until done. The receiving computer turns the link off and records the pass it owes (`link_drains_owed`) in one write, drains, ends the session, and drains again. Each thread a pass finds running a turn asked for before the link went off owes its stop (`link_thread_stops_owed`, with that turn) until it is seen stopped or on a later turn (its user's); the stop is asked for again every minute. An unlink cut off part way (a failed step, a restart) is finished on its own a minute later, and its link can't be turned back on meanwhile. A `peer.unlink` runs detached from its call, so ending the session (which closes the connection the call came over) can't cut it off.
  - A start or send that lands while its link is being removed ends at once: the link is read again right after the request is recorded. The send gate also refuses a request whose link is off or gone.
  - The reverse cleanup asks about each link back on its own and drops only the ones the other computer refuses.
  - One live link per direction. A computer makes and unlinks its links to another computer one at a time (making one gives up after two minutes), and finishes an earlier unlink of it before claiming a new invite. The receiving computer ends that computer's older links once it uses the newest (`peer.describe` or a start over a pinned link), and a newer one never used ten minutes after it was made. Outbound links report `remoteDeviceId`, so Fleet edits the other half of the link in use, and counts an unpinned half as a computer's when that computer's own link reports it.

**Working now.** For a saved, connected computer, its threads in the same rows as the All computers list. Cross-computer children read "Started by <title> on <computer>".

A linked computer this app hasn't saved has no thread data. Its page shows "Connect to Windows PC to see its work" with Connect, and never shows idle or zero counts. Its link state is the server-to-server link, which is separate from this app's connection, and the page says which is which.

**This app**, a quiet group.

- "Remove from this app" is today's forget (service.ts:2039). It only forgets this app's saved connection. It never unlinks.
- When a link exists, the confirm adds one plain line: "Mac and Windows PC stay linked. Unlink them first to stop agents working across them."
- Any remote calls a removal needs happen before the credentials are forgotten.

**This computer's own page** has no Remove. It shows its providers, its "Works with" rows, and "Devices that can use this Mac: <n> · Open Connections settings". Remote pages don't link to settings, because Settings only covers this computer.

### R4.3 Adding a computer ends with linking

After a successful connection, the "Connect to a computer" dialog asks "Let agents on these computers start work on each other?" with Link (Ask first) and Not now. Linking needs two computers with servers, so the question works like this:

- On desktop, or in a browser served by a server, the pair is that server and the new computer.
- On the hosted web app or a phone, it asks only when the app already has another saved computer, with a picker ("Link with: Mac ▾").
- It asks only when both computers report `computerLinks`.

The same dialog opens from Fleet's "+", the one-computer Fleet state, the command palette and Settings.

### R4.4 Settings › Connections

- The section is renamed "Devices that can use this computer".
- **A stable join for computer links.** `InboundComputerLink` gains `sessionId` (the server row already has it, ComputerLinks.ts:357). Settings joins an auth session (`role: peer`) to its inbound link by session id, never by label. Joined rows read "Linked computer · its agents: <access>", keep Remove access (removes that inbound link and stops its link-started work, as Unlink does), and add "Manage in Fleet", which opens the entry for its environment id or device id. A peer session with no matching link reads "Linked computer" with Remove access only.
- **"Computers you use from here"** shrinks to one row: "<n> computers. See what they're doing and manage them in Fleet." It has Open Fleet and Connect to a computer.

### R4.5 Phones and tablets

They stay managed in Settings. Fleet's graph still draws them around this computer, and clicking one opens Settings › Connections.

### R4.6 Look

Groups and approval rows follow the design language: quiet groups, rows, solid controls in content, and no raised cards.

### R4.7 Tests

- The list: unsaved linked computers, temporary device entries merging when the id arrives, and a saved-and-linked computer shown once.
- Per-direction rows read and write the receiving side's inbound link.
- One direction linked offers Link for the other.
- An offline owner disables its line. An existing link stays manageable when the remote's capabilities are unknown.
- Allow and Deny work from the computer page.
- Unlink stops link-started threads. Unlink with one side offline reports that side as pending and finishes on reconnect.
- Remove from this app never unlinks.
- The Settings join by session id, including two computers with the same name.
- One test walks every connection action from the old saved-computer rows on the new page.
- The hosted web app's add flow with and without a second saved computer.

## Part 1: Computer links

### Model

A link **A → B** means A's server is a paired device of B's server, with a new auth role `peer`. It lets agents on A use B, under B's per-link access setting. Links are directional. The client's single "Link" action creates both directions when it can.

We reuse relay-v2 device pairing (`apps/server/src/relay/RelayHost.ts`) instead of building a new auth system:

- B can already mint an invite, auto-approve a QR-style claim (RelayHost.ts:628-651) and issue a revocable 90-day sliding session.
- It already pins keys, and it already accepts both the direct route (`/relay/direct/:deviceId`, LAN or Tailscale) and the relay fallback.
- The Noise KK code in `packages/shared/src/relaySecure.ts` uses only `crypto.subtle` and runs in Node (`securePipe.test.ts`).
- Links show up in B's device list, and revoking one there cuts it everywhere (RelayHost.ts:1238-1250).

### Creating a link (one click)

The client is connected to both A and B.

1. Client → B: `links.createInvite({ joinerEnvironmentId: A })`. B mints a `computer-link` invite (single use, 10 min TTL, auto-approve claim) for A only and returns `{ hostId, relayOrigin, inviteId, inviteSecret, hostPublicKey, directRoutes, environmentId, label, expiresAt }`. B registers with the relay first if it never has.
2. Client → A: `links.accept(invite)`. A's server claims it as a device (Node joiner, below). It stores its device keys in `ServerSecretStore` under `computer-link-<linkId>`, inserts a `computer_links` row, and connects once to confirm.
3. The client repeats with roles swapped for B → A. If one direction fails, the UI says which and offers Retry.

**Who may mint a link invite on B.** Today `relay.createInvite` is owner-only (ws.ts:2509-2514). A remote client (Will's Windows app connected to the Mac) is role `client` on B, so owner-only would make one-click linking impossible. `links.createInvite` is allowed for `owner` and `client`:

- A `client` session can already run terminals and commands on B, and a `peer` session is strictly narrower.
- The invite is single use with a 10-minute TTL.
- A new inbound link defaults to **Ask first**, notifies B's owner clients, and appears in B's Fleet page and Connections device list with Remove.

**Authority is the host's.**

- Today the in-memory `localInvites` map (RelayHost.ts:243-257) holds the invite, and recovery calls `finishApproval` from a device row whose `kind` came from the joiner (RelayHost.ts:785-797, 935).
- New: the invite record is persisted, with `purpose: device | computer-link` set by the host. `approveVerified` copies `grant: client | peer` from the verified invite into the device row in the same insert, before any session exists. `finishApproval` and restart recovery issue the session role from `row.grant` only.
- The invite also pins the joining computer's environment id, as the client that asked for it knows it. `approveVerified` writes it into the device row as `link_environment_id` with `link_environment_pinned = 1`. The link refuses a `peer.describe` or `peer.request.start` that names a different computer, and its id never changes. An unpinned row (from an invite that named no computer) keeps the first id the computer gives, and clients show it as unconfirmed: never merged with a saved computer of that id.
- Test: crash between inserting the device row and issuing its session, then restart → the session has the invite's role.

### Server pieces (A side, outbound)

- **Node joiner.** Move `openLink` and the socket core of `SecureRelaySocket` (apps/web/src/rpc/secureRelaySocket.ts) into `packages/shared`, with no DOM types (`CloseEvent`, `DOMException`, `location`). Keep a thin web wrapper. Also move the claim half of `startInviteClaim` (apps/web/src/environments/runtime/relayJoins.ts:303-343) into shared. Web keeps using the same code.
- **Table `computer_links`** (new migration): `link_id, remote_environment_id, remote_label, remote_platform, relay_origin, host_id, device_id, host_public_key, direct_routes_json, state (active|revoked|failed), created_at, last_connected_at, last_error`.
- **`ComputerLinkClient` service.**
  - `withPeer(environmentId, effect)` opens or reuses a secure connection: direct routes first with the same 1.5 s race, then the relay.
  - It builds an Effect RPC client for `PeerRpcGroup` over that connection. This is the plain-Effect core of apps/web/src/rpc/protocol.ts: `RpcClient.make` + `makeProtocolSocket`.
  - Connections close after 2 minutes idle, and stay open while follow-up work is pending: open remote requests, unacked reports, and outbox items.
  - Reconnects use capped exponential back-off.
  - A status stream feeds `links.subscribe`.
- **Revocation.** A peer connection refused with auth errors marks the link `revoked`. The UI shows it and offers Link again.

### Server pieces (B side, inbound)

- **Role `peer`.** Extend `AuthSessionRole` (contracts/auth.ts:73) to `owner | client | peer`, along with the signed claims (SessionCredentialService.ts:41-50) and `auth_sessions.role`.
- **Separate endpoint.**
  - `openDeviceSession` (RelayHost.ts:1028-1041) splices peer devices to a new loopback `/peer` WebSocket that serves **only** `PeerRpcGroup`.
  - `/ws` refuses role `peer`, `/peer` refuses every other role, and every HTTP route (auth/http.ts, orchestration/http.ts and any other `/api`) refuses `peer`.
  - The allowlist exists by construction, not by per-method checks.
- **Per-link settings** live on the device row:
  - `link_access`: `off | ask | allowed`, default `ask`.
  - `link_max_runtime_mode`: defaults to B's default for new threads.
- **Fence.**
  - A thread started over a link carries `remoteOrigin { linkDeviceId, environmentId, environmentLabel, threadId, threadTitle }` in its `thread.create` event. Only the peer handler can set it; the Normalizer refuses it from clients, like the lineage fields today (Normalizer.ts:156-175).
  - Threads with `remoteOrigin` get **no Threadlines agent tools**: no thread, room, schedule or invite tools. Tool attachment (ProviderCommandReactor.ts:994-1003) checks it. That closes the relay-through-a-child path: attached children can list and read other threads in their project (threadToolHandlers.ts:776, 822).
  - A peer can only send to, stop, read and watch threads whose `remoteOrigin.linkDeviceId` is its own link.
  - The runtime mode is the lower of what A asked for and `link_max_runtime_mode`.
  - Honest limit: the fence governs Threadlines' own tools. What the agent can do on B's disk is governed by that runtime mode, which B controls.

### `PeerRpcGroup` (packages/contracts/src/peerRpc.ts)

| Method                | Does                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `peer.describe`       | B's descriptor, its ready agents with **B-local instance ids** (the `thread_agents` shape, usage summary included) and its projects (name, `RepositoryIdentity.canonicalKey`).                                                                                                                                                                       |
| `peer.request.start`  | `{ requestId, parent: { environmentId, environmentLabel, threadId, threadTitle, handle }, projectKey, workspace: { kind: worktree, branch? } \| { kind: local }, title?, prompt, agent: { instanceId, model? }, runtimeMode, interactionMode, reportBack }` → `{ status: started \| awaiting_approval \| refused \| cancelled, threadId?, reason? }` |
| `peer.request.send`   | `{ requestId, threadId, text }` → `{ status: queued \| refused \| cancelled }`                                                                                                                                                                                                                                                                       |
| `peer.request.cancel` | `{ requestId }`. Works before the thread exists.                                                                                                                                                                                                                                                                                                     |
| `peer.thread.stop`    | Stops the thread's session and detaches it from the remote parent.                                                                                                                                                                                                                                                                                   |
| `peer.thread.read`    | Same output shape as `thread_read`.                                                                                                                                                                                                                                                                                                                  |
| `peer.thread.list`    | Threads this link started, with status.                                                                                                                                                                                                                                                                                                              |
| `peer.watch`          | A stream of request status changes, every terminal outcome (answered, failed, cancelled, denied, expired), and pending reports. On connect it replays everything not yet acked.                                                                                                                                                                      |
| `peer.report.ack`     | `{ reportId }`: A has durably recorded the report.                                                                                                                                                                                                                                                                                                   |
| `peer.move.*`         | The move protocol (Part 3).                                                                                                                                                                                                                                                                                                                          |
| `peer.unlink`         | When A removes its outbound link, this revokes A's own session on B.                                                                                                                                                                                                                                                                                 |

Every mutating method is idempotent by `(linkDeviceId, requestId)` or `(linkDeviceId, transferId)`.

### Links RPC for clients (`WsRpcGroup`)

`links.list`, `links.subscribe` (outbound links with state; inbound links with access and last use; pending incoming requests), `links.createInvite`, `links.accept`, `links.setAccess`, `links.remove`, `links.respondRequest`.

### Capabilities

The environment descriptor's `capabilities` gains `computerLinks`, `scheduledTasks` and `threadMove`. Clients hide link, schedule and move UI for servers that lack them. An older server on another computer keeps working as today.

## Part 2: Agents across computers

### Tools (A)

- `thread_agents` adds `computers: [{ name, environmentId, reachable, agents: [{ instanceId, provider, models }] }]`, from cached `peer.describe` (5 min TTL, refreshed on use).
- `thread_start` gains an optional `computer` (name or id).
  - Unknown names are refused with the list of linked computers.
  - The agent must name one of that computer's `instanceId`s. The default is the computer's default instance for the caller's provider kind, or else its default agent.
  - The caller's own instance id is never sent: it means nothing on B (ProviderCommandReactor.ts:1048-1059).
- `thread_list` includes remote children with their computer.
- `thread_read`, `thread_send` and `thread_stop` work on remote children through the link. `thread_read` fails with a plain message when the computer is offline.
- **Workspace on B.** B finds the project by A's `canonicalKey`, or refuses with "Mac mini doesn't have this project". For a worktree, B fetches and starts from `branch` when A's HEAD is pushed (A checks its upstream). Otherwise it starts from B's default branch, and the tool result says the caller's unpushed changes are not there.

### Records and reactors on A (the parent's computer)

- `ChildThreadLaunch` gains `target?: { environmentId, label }`. `OrchestrationChildRequest` gains `remote?: { environmentId, label, threadId: ThreadId \| null, status, cancelRequested: boolean }`. `ThreadMessageOrigin` gains optional `environmentId`; absent means this computer.
- **Decider.** Remote variants of `thread.child.start`, `thread.child.send`, `thread.child-request.settle` and children-stop write **only the parent aggregate**. Today several of these write parent and child in one transaction (childThreadDecisions.ts:330-413, 457-539, 666-723).
- **Ownership is partitioned.**
  - `ChildThreadReactor` skips requests with `remote`. Today it sets up every `starting` request, and it cancels requests whose child is missing locally (ChildThreadReactor.ts:331-340, 448).
  - `ProviderRuntimeIngestion.routeChildReport` ignores remote requests.
  - The report-delivery cancellation check `isReportDeliveryCancelled` (ProviderCommandReactor.ts:830-846) uses the parent's remote request state for remote reports, not a local child lookup. It covers queued delivery and restart recovery too.
- **`RemoteChildReactor`** owns remote requests:
  1. **Outbox, in order per link.** Starts, sends and cancels are dispatched as `peer.request.*` in the order they were recorded, and each retries with its own requestId until B answers. A start's answer records `remote.threadId` and status.
  2. **Watch.** While any remote request is open, or any report is unacked, `peer.watch` stays open. A report becomes the remote settle with the report text (`fromThread` origin with `environmentId`), then `peer.report.ack`. If the decider says that report id is already recorded, that counts as success, and the reactor acks it. Unacked reports are tracked even after the parent request closed.
  3. **Terminal outcomes** (denied, expired, failed, cancelled) settle the parent request with a plain reply ("Mac mini didn't allow it").
  4. **Stop and wrap.** Stopping or wrapping the parent raises the delivery epoch as today. It also records `cancelRequested` on every attached remote request and enqueues `peer.request.cancel`, plus `peer.thread.stop` once a thread id exists. An in-flight start that lands after Stop is cancelled by B's tombstone (below).
  5. **Restart.** The reactor reloads open remote requests and the outbox, then re-attaches watches.

### Records on B (the child's computer)

- **Request ledger** `link_requests`: `link_device_id, request_id, kind (start|send), thread_id, message_id, turn_id, status (received|awaiting_approval|queued|running|awaiting_background|answered|failed|cancelled|denied|expired), report_id, report_text, delivered_at, created_at, updated_at`, unique on `(link_device_id, request_id)`.
  - Inserting the row is the dedupe.
  - A cancel that arrives first writes a `cancelled` tombstone, so a late start or send is refused.
  - Incoming sends become `thread.follow-up.submit` with `fromThread` origin and the ledger's `message_id`. The answering turn is bound by message id, the way local children bind with `pendingMessageId` (childThreadDelivery.ts:101-170).
  - Turn end (same rules as local children, including the 15 s background quiet period) writes `report_text` and `answered` **in the same transaction**. `peer.watch` emits it until acked.
  - **Startup reconcile:** requests whose turn ended get their report; a request whose turn was cut off by the restart becomes `failed` with "interrupted by a restart on Mac mini"; `awaiting_approval` past 24 h becomes `expired`.
- Start runs the staged `ThreadBootstrap` path (ThreadBootstrap.ts:461-709), with ids derived from `(linkDeviceId, requestId)`.
- **Ask first.** A start under `ask` waits in the ledger as `awaiting_approval`. B's clients show it as a card on the Fleet page and a row in B's sidebar inbox: "Windows PC wants to start a thread: <title>", Allow / Deny. A shows "Waiting for Mac mini to allow it" in the parent's child list.
- The child row on B reads "Started by <title> on Windows PC".

### Client

- The parent's child list (the option B family line) includes remote children. When the client is connected to B, the row is B's real thread and opens it. Otherwise it shows A's cached status.
- Fleet draws cross-computer work on the line between the two computers.

## Part 3: Move a thread (issue #48, v1)

"Move to another computer" in the thread menu and the command palette lists the computers this computer links to. A dialog picks the computer and, when the thread's agent isn't available there, one of that computer's agents.

**Who may move.** v1 refuses threads in a room, threads with attached children (local or remote), and threads with any live work. Live work uses the predicate behind `childHasLiveWork` (childThreadDecisions.ts:635): a running turn, queued messages, side turns, background work, pending approvals or questions.

**Protocol** (transfer id `T`, resumable on both sides):

1. **Freeze on A.** `thread.move.started { transferId, target, sourceSequence }`. From here the decider refuses turns, follow-ups, side turns, child operations and edits on that thread. The UI shows "Moving to Mac mini…" with Cancel.
2. **Export on A.** A builds a manifest and bundle for the thread state at `sourceSequence`.
   - Meta and messages, with each message's attachments (bytes and metadata) and turn and origin ids.
   - The last N tool-activity summaries.
   - **Git:**
     - The exact `headSha` and branch name, or detached.
     - A `git bundle` of `headSha` with its prerequisites, the merge base with the remote's default branch, or with its upstream when one exists.
     - A tarball of untracked, non-ignored files.
     - `git diff --binary HEAD` of tracked changes.
     - Staged versus unstaged is not preserved: everything lands as working-tree changes, and the dialog says so.
     - Refused: changed submodules, and changed Git LFS files.
3. **Transfer.** `peer.move.prepare { T, manifest }`, then `peer.move.chunk { T, index, bytes }` in 256 KiB chunks (the relay caps messages at 1 MiB). B stages the chunks under its state folder, keyed by `T`. Chunks are idempotent, and resending after a reconnect continues from the last chunk B has.
4. **Import on B.**
   - Match the project by `canonicalKey`, or abort.
   - Fetch the bundle and verify the prerequisites exist; abort if not.
   - Create a new worktree at `headSha`. The branch is named after the source, or `<branch>-from-<computer>` when B already has that branch pointing elsewhere; a detached HEAD gets `moved/<thread-slug>`. Then apply the diff and unpack the untracked files.
   - Import the thread with a new internal `thread.import` command:
     - messages with remapped attachment ids, turn and origin ids, and deterministic event ids from `T`;
     - the agent B resolved;
     - `historySeedOwed: true`, so the next turn starts a **seeded** session (`ThreadContextSeedBuilder`), never A's resume cursor;
     - `movedFrom { environmentId, label, threadId }`.
   - The seed mentions the attachments by name, since seed entries are text only (contracts/provider.ts:85).
5. **Commit.** B records `thread.move.imported { T }` and answers `committed`. A then records `thread.moved-away { T, environmentId, threadId }`. The thread is read-only on A, enforced by the decider, with a "Moved to Mac mini" banner and Open; the sidebar row points at the new location. A keeps its worktree until the user cleans it up.
6. **Abort.** Cancel before commit, or any refusal, sends `peer.move.abort { T }`. B deletes the staging data and any half-made worktree; A records `thread.move.aborted` and unfreezes.
7. **Recovery.** At startup:
   - A resumes a frozen move: it re-sends from the last acked chunk, asks B for status, and commits or aborts.
   - B resumes an import of a fully staged transfer, and deletes staging data older than 24 h that never committed.

**Checkpoints.** Revert refs are local to A's repo, so turns from before the move can't be reverted on B. The thread shows a "Moved here" boundary in the timeline, and revert controls stop at it.

v2 (carrying the provider's own session files) stays open on #48.

### Build plan (Oct 22, against the code on `feat/fleet-links-ui`)

Branch `feat/move-thread`, cut from `feat/fleet-links-ui`. The move dialog needs that branch's links store, computer names and agent lists; computer-links alone has no web links code. Merge order becomes 1, 2, 3, 5, 4, 6.

Sol reviewed the first draft of this plan (16 findings). All of them held against the code, and this version fixes them. Where it differs from the protocol above, this plan wins.

Names used below: `L` is the authenticated link device id on B, `T` the transfer id, and `K = hash(L, T)` the transfer key. Every B-side resource (row, lock, staging folder, git ref, thread id, message and activity ids, attachment ids) derives from `K`, never from `T` alone.

#### Who may move (one shared pure check, used by `moves.preview` and by the decider in the freeze decision)

Refused, each with a plain reason:

- archived, or deleted;
- a room (`isRoomThread`), or open agent requests;
- a child (attached `parentThreadId`), or `remoteOrigin` set;
- attached children, local or remote (`childRequests.remoteChildren`);
- `childHasLiveWork`, or either background count above 0;
- an active goal, any check-backs, a running command run, pending command requests, a running workflow run, voice active;
- PR auto-fix or auto-merge on ("turn it off first": A's automation would act on a frozen thread);
- a General Chats project, or a project without a `canonicalKey` (v1);
- already moving or moved.

#### Freeze on A

`moves.start { threadId, targetEnvironmentId, agent }` is a WS method, never a client orchestration command, because the decider can't see links. `ThreadMoveService` re-runs the preview (link active, B answers `moves: true` in `PeerDescriptor`, project and agent valid on B), then dispatches the internal `thread.move.start`. The decider runs the eligibility check and emits `thread.move-started { transferId, target { environmentId, label }, agent, startedAt }`.

The reactor then stops the thread's provider session, so no runtime can start a turn. `ProviderRuntimeIngestion` refuses provider-initiated turns on a moving or moved thread.

**One move guard, used everywhere a thread can change.** A thread with `move` set refuses:

- in the decider: every command whose `threadId` is the thread, except archive, unarchive, delete, pin, unpin, read, unread, wrap, unwrap and the move's internal commands;
- every command that names it as a parent to attach to (`thread.child.attach`'s parent);
- the typing warm-up (ws.ts:705) and every direct reactor entry.

Reading and forking a moving or moved thread stay allowed: a fork is a new thread, and it is the honest way to keep working here. Terminals in A's worktree stay the user's own shell. The snapshot rule below covers them.

#### Export on A (`ThreadMoveReactor`)

Everything runs from the git top level (`rev-parse --show-toplevel`) of the thread's cwd.

1. **A consistent snapshot.** Eligibility also refuses a move while another thread with live work shares the same checkout. Around the export, take `git status --porcelain=v2 -z --untracked-files=all` plus each untracked file's size and mtime, before and after. Regenerate the diff and compare its hash. If anything differs (a terminal or another writer changed files), retry once, then abort with "the checkout changed while exporting".
2. `headSha`, and the branch from `symbolic-ref`, or detached.
3. The remote is the one the project's `RepositoryIdentity` came from, not hard-coded `origin`. The base is `merge-base(head, <remote>/<upstream branch>)` when there is an upstream, else `merge-base(head, <remote>/HEAD)`. These commits exist on the remote. When base ≠ head, write `refs/threadlines/move/<T>` at head and run `git bundle create <file> refs/threadlines/move/<T> ^<base>`. Then delete the temp ref.
4. Tracked changes: `git diff --binary --full-index --no-textconv --no-ext-diff --no-color --no-relative HEAD --output=<file>`.
5. Untracked files: `ls-files --others --exclude-standard -z`. For each, `lstat`. A regular file goes with its executable bit; a symlink goes as its target text, written as a symlink on B, or refused on Windows B. Anything else is refused.
6. Refused: gitlink (mode 160000) changes, paths whose `filter` attribute is `lfs`, and a total over 100 MiB.
7. Attachments of every message are copied in by id, with name and mime type kept only as display metadata.

All of it goes into `<stateDir>/moves/<T>/`: `payload.bin` (the parts, concatenated), then `manifest.json`. The manifest lists:

- the part table `{ kind, offset, length, sha256, path?, mode?, attachment? }` and the payload's sha256;
- `headSha`, the branch, the remote's canonical key, the base;
- the thread export: title, model selection, runtime and interaction modes, and messages with their roles, text, turn ids, `createdAt`, attachment references and `completesTurn`;
- the tool-activity summaries the seed builder reads;
- the project's title.

Both files are written to temp names and renamed, so a finished export is atomic. On resume, A re-reads them. If either is missing or the hash is wrong, A aborts the move.

#### The transfer (`peer.move.*`, all idempotent under `(L, T)`)

- **`prepare { T, manifest }` → `awaiting_approval | receiving | refused { reason }`.** B checks that the manifest is valid and bounded: total ≤ 100 MiB, parts contiguous and inside the total, at most 20 000 parts, valid paths (below). B checks its current authority: `off` refuses, `ask` waits, `allowed` receives. A peer may have at most 2 unfinished moves, and B at most 4 in all. Reusing `(L, T)` with a different manifest is refused.
- **`chunk { T, offset, data }` → `{ bytesReceived }`.** Decoded data is at most 1 MiB, and `offset + length` must stay within the declared total. B accepts only `offset == bytesReceived`; any other offset just answers `bytesReceived`. B writes, fsyncs, then updates the row. At resume, a file longer than `bytes_received` is truncated to it.
- **`finish { T }` → `importing`.** All bytes are present, and every part's hash and the whole payload's hash match. The import runs in the background.
- **`status { T }` → the row's status**, plus `bytesReceived`, `threadId` once committed, and `reason`.
- **`abort { T }` → `aborted | committed`.**

A polls `status`, backing off from 2 s to 15 s, while waiting for approval and while B imports. `peer.watch` stays tied to remote requests.

The pending move is listed to B's user through `ComputerLinkPendingRequest`, which gains `kind: "start" | "move"` (absent means start) and a `move { messageCount, branch, changes }` summary. It is answered with `links.respondRequest`, as starts are.

#### Import on B (`LinkMoves`, beside `LinkRequests`)

Table `link_moves` (migration 079): `link_device_id, transfer_id, transfer_key, status (awaiting_approval|receiving|importing|committed|aborted), stage, manifest_json, bytes_received, thread_id, branch, worktree_path, repo_root, reason, cleaned_at, created_at, updated_at`, unique on `(link_device_id, transfer_id)`. Staging lives in `<stateDir>/link-moves/<K>/`.

**Path rules** (B's filesystem semantics, checked at prepare and again before writing):

- relative only, with no `..`, no empty or `.` segments, no absolute paths, and no drive, UNC or `:` stream syntax;
- nothing under `.git`;
- no collision, case-insensitive on Windows and macOS, with a tracked path or another incoming path;
- no symlinked parent: every parent directory is `lstat`-checked inside the worktree;
- files are created exclusively (`wx`).

Attachments get B's own ids (`createAttachmentId(B's thread id)`) and are written through `attachmentStore` helpers; the incoming name is display text only.

**Stages**, each recorded in `stage` before the next starts, with authority re-checked (`linkAuthority`) before each stage and before the commit:

1. **`fetched`**: `git fetch <remote>`, using the remote of B's project whose canonical key matched. With a bundle: `git bundle verify`, then `git -c transfer.fsckObjects=true fetch <bundle> refs/threadlines/move/<T>:refs/threadlines/move/<K>`. Without one: `headSha` must exist after the fetch. A missing prerequisite aborts with "<computer> can't find commit <short sha> on <remote>. Push it, or fetch on <computer>, then try again."
2. **`worktree`**: the branch and path are chosen and saved in the row first. Occupied means it exists at any SHA or is checked out anywhere. The order is `<branch>`, then `<branch>-from-<computer>`, then `-2` … `-100`; a detached head becomes `moved/<slug>`. Creating the worktree: when a worktree is already registered at the saved path with `HEAD == headSha`, keep it; otherwise run `createWorktree`.
3. **`applied`**: `git apply --binary` when the diff isn't empty, then write the untracked files. The worktree path is unique to `K` (`moved-<K8>` under the worktrees folder) and is recorded in the row before it is created. When resuming a crashed apply, B first checks that no thread's `worktreePath` or `effectiveCwd` points at that path; if one does, it aborts the move instead. Only then does it run `reset --hard headSha` and `clean -fdx` in that worktree, and re-apply.
4. **Commit**: copy the attachments, then dispatch `thread.import`.

**Commit and abort exclude each other under one lock that an interruption can't release early.** Both run under the per-transfer lock keyed by `K` (the `withRequestLock` pattern in `LinkRequests`).

- **Commit.** Under the lock, re-read the row. If it's `aborted`, stop. Otherwise dispatch `thread.import` and await the engine's answer _uninterruptibly_, then write `committed`, and only then release the lock. An interrupted caller can't leave a queued import behind an unlocked transfer. The thread id is deterministic, so a duplicate dispatch is refused as "already exists" and read as committed.
- **Abort.** Under the lock, check whether the import landed: the engine's receipt for the import's deterministic command id (written in the same transaction as its events), or the thread's row in any state, archived or deleted included. If it landed, answer `committed`. Otherwise write `aborted` durably, then release the lock and clean up. A read that fails is an error, never "gone": A asks again.
- **Startup.** The process died, so nothing is queued. Reconcile each `importing` row the same way: landed means committed, else resume the import.

After an abort, B removes the staging folder, the worktree, and any branch it made, then sets `cleaned_at`. An aborted row without `cleaned_at` is cleanup still owed: startup and the hourly sweep retry it. B never touches anything once committed.

**`thread.import` writes, in one decision:**

- `thread.created`, with `movedFrom { environmentId, label, threadId, importedTurnIds }`;
- every message as `thread.message-sent`, with fresh ids derived from `(K, original id)`, turn ids remapped the same way, and attachments remapped;
- the tool-activity summaries as activities, with fresh ids;
- one `thread.moved-in` activity, the boundary.

The runtime mode is capped at `link_max_runtime_mode`, and the agent is the one B resolved. The thread gets `historySeedOwed: true`.

**Cleanup.** An hourly sweep (and the one at startup) aborts `awaiting_approval` or `receiving` rows older than 24 h, and removes staging folders of committed or aborted rows. `ComputerLinks`' unlink drain covers moves: unfinished moves are aborted, committed ones are left alone.

#### After the commit, on A

The reactor sees `committed { threadId }` and records `thread.moved-away { environmentId, label, threadId, movedAt }`. The thread stays read-only under the move guard. If A crashed after B committed, startup asks `status`, gets `committed`, and records `moved-away`.

A unfreezes only after B confirms an abort (`thread.move-aborted { reason }`, plus an activity "Couldn't move to Mac mini: <reason>"). When B can't be reached, or the link is gone, the thread stays frozen. The notice says why and offers "Continue here as a new thread", which is a fork: an explicit second thread, never an unfrozen original.

#### The seed (fixes D5)

`historySeedOwed` is persisted on the thread, set by `thread.import`. Delivery is send-time, through the existing owed-history path (`withContextSeedPreamble` with a `ThreadContextSeedBuilder` seed). So a warm-up session, a restart between bind and send, or a provider switch all still deliver it on the first real send. The reactor dispatches `thread.history-seed.delivered` once the provider accepted that turn. A crash in between re-sends the seed: at least once, never zero. Owed-history delivery uses a strict build: if the transcript can't be read, or the seed has no entries while the thread has imported messages, the debt stays and that send goes without it. Today's builder falls back to a workspace-only seed, and that must not count as delivered. Also fix `hasProviderBinding` so that a null `projectedSession` reads as no binding.

The delivered event records the message whose send carried the seed (`historySeedMessageId`). A revert that removes that message owes the seed again, whichever of B's turns carried it (`revertOwesHistorySeed`, used by both projections). A session started seeded with the conversation pays the debt only through a send on that same runtime (matched by its `createdAt`); a replacement runtime builds the seed again. Seed entries name a message's attachments, so a message that was only an attachment still counts.

#### The revert boundary (fixes D6)

**Imported history is outside B's revert accounting.** Every imported message carries `imported: true`: a new optional field on `OrchestrationMessage` and on the `thread.message-sent` payload, stored in a `projection_thread_messages.imported` column. Imported activities have `turnId: null`, so revert already keeps them.

The shared `revertMessages` (`packages/shared/src/transcriptRevert.ts`) keeps imported messages unconditionally and leaves them out of its count-based fallback. That's one rule for all three revert sites: `projector.ts`, `ProjectionPipeline.ts`, and the web.

B's turn numbering starts at 1. Revert to count 0, the state right after the import, is valid and keeps all imported history. There is no decider fence. The web hides revert controls on imported messages.

#### Rules the server reviews added (Oct 22)

- **Branch ownership is proven, not inferred.** B makes the branch itself with `update-ref --create-reflog -m "threadlines move <K>" refs/heads/<name> <headSha> ""` (create-only), then adds the worktree on it. A restart reuses a saved name only when the branch's oldest reflog entry is that note; a name taken by anyone else gets another. Clean-up deletes the branch only with that note and only while it still points at `headSha`.
- **One size budget, measured before anything is written.** At the fetch stage: every path the commits change, at its new size (`diff-tree base..head`, then `cat-file`, so one blob under many paths counts each time), each binary hunk's real target size (a `literal`'s stated size, or the target size in a `delta`'s own header), the patch and the new files. Over 1 GiB aborts. A bundle without a base is refused.
- **Clean-up knows its repository.** The repo root is recorded before the fetch stage makes anything, so a project removed since doesn't strand the temp ref, branch or worktree. Clean-up is recorded only once each is verified gone.
- **Ask first is read at admission.** The link's current access is read inside the admission lock, right before the row is recorded.
- **A's worker can't die quietly.** Any failure restarts it from the top after 30 s (it asks B where it stands first). A drop B couldn't record yet is asked again every 15 s. A move runs on while its thread is archived. Deleting the thread mid-move ends the wait and asks B once to drop it; one that already arrived there stays.
- **The export packs its own snapshot.** The file lists and the diff come from the snapshot taken before packing, and the one after must match it exactly, lists included.

#### Web

- **Entry points**, all through one request store (the `ThreadDeleteDialog` pattern): the sidebar row menu, the command palette, and the chat view's "Continue in" area. They show when the thread's computer has `capabilities.threadMove` and at least one active outbound link.
- **The dialog:**
  - a computer `Select`;
  - the preview: "Lands in <project> on <computer> · branch <name>", the change summary, "Staged changes arrive unstaged", and "Your copy here stays, read-only";
  - B's agents in the agent picker;
  - the refusal text, when there is one;
  - Cancel and Move.
- **A's composer notice and lock while moving:** "Moving to Mac mini · waiting for it to allow it / sending 40% / setting up", with Cancel. Once moved: "Moved to Mac mini", with Open when the app has that thread, else "Connect to Mac mini to open it". The sidebar row shows "moved".
- **On B:**
  - a "Moved here from <computer>" boundary row;
  - the move request card and inbox row ("wants to move a thread here: <title>"), reusing PR 5's request components.
- `ServerEnvironment` sets `threadMove: true`, and `PeerDescriptor` gains `moves: true`.

#### Tests

- **Decider:**
  - eligibility, one case per reason;
  - the move guard, including attach-to-frozen-parent;
  - start, cancel, abort and moved-away;
  - `thread.import` refused for an existing thread id.
- **`LinkMoves`:**
  - off, ask and allowed;
  - bounded manifest and path rules (traversal, `.git`, case collision, symlinked parent);
  - chunk offsets and truncate-on-resume;
  - hash refusal;
  - restart at each stage;
  - abort vs commit, both orders, and an interrupted commit caller;
  - authority revoked mid-import;
  - per-link and global caps.
- **A real-git round trip on temp repos:**
  - unpushed commits;
  - staged, unstaged and deleted changes;
  - untracked binary and executable files;
  - a clean tree;
  - untracked-only changes;
  - a detached head;
  - a branch collision;
  - a missing prerequisite.
- **Projection:** a revert to count 0 and to count 1 keeps every imported message and activity, and B's own messages are kept or dropped correctly around them, in both projectors and in `transcriptRevert` unit tests.
- **`ProviderCommandReactor`:** the first send of a moved thread carries the seed, after a warm-up and after a restart before the send.
- **Web:**
  - menu and palette gating;
  - the dialog's preview and refusals;
  - the moving and moved notices;
  - the boundary row;
  - the move request card.

#### Live

The two test servers:

- Move a thread with unpushed commits and changes, under Ask first and then Allowed.
- Cancel while waiting.
- Kill A mid-send.
- Kill B mid-import.
- A real Codex turn on the moved thread, to see the seed.

## Part 4: The rail and the Fleet page

### Rail

- **Layout.** `AppSidebarLayout` gets a rail column (52 px wide, `--app-chrome-background`, a hairline `--border` on its right) to the left of the thread list.
  - The list's fixed container (`ui/sidebar.tsx:299`, `fixed inset-y-0 left-0`) and its gap element move right by the rail width (a `--sidebar-rail-width` variable used by both).
  - The list keeps `collapsible="offcanvas"`. Hiding it slides the list away, and the rail stays.
- **macOS.** The traffic lights span about x 16-70 px at y 18, wider than the rail. The top `--workspace-topbar-height` strip stays a drag region across rail and list, and the rail's first button starts below it. `--workspace-controls-left` keeps the horizontal clearance for the list header row.
- **Windows and Linux.** The overlay controls sit at the top right, so the rail starts at the top. The floating `SidebarControl` toggle moves into the rail's top slot on every platform.
- **Order:** Threads (inbox), General Chats, Pull Requests (hidden when no environment supports PRs, as today), Fleet, Scheduled, Usage, then a spacer, then Settings. Fleet and Scheduled are hidden when no connected server has the capability.
- **Buttons.** 34 px plain buttons (the toolbar rule). Selected is a soft `--sidebar-accent` fill with a foreground icon. Each has a tooltip with its name and shortcut.
- **Threads badge.** An amber count of needs-you threads. When the list is hidden, a blue dot with the working count sits under the Threads icon, and a New thread button sits at the top.
- **Moved out of the list:** General Chats and Pull Requests rows leave the list, so threads start higher. The Usage meter leaves the footer, and Settings moves to the rail. Update pills and the version tag stay in the list footer.
- **Collapse state** persists in `uiStateStore`. Today it never does: the `sidebar_state` cookie is never read. New keybinding command `sidebar.toggle`, default mod+B unless taken (check `packages/shared/src/keybindings.ts`).
- **Phone.** The Sheet keeps today's layout, and the destinations become one horizontal row of the same icons under the sheet header. `PageTitlebar` and the other sheet triggers are unchanged.
- **Settings route.** The list column shows `SettingsSidebarNav` as today, and the rail shows Settings selected.
- Update the "Exceptions" in `docs/design/design-language.md`: the rail is part of the sidebar, and the inbox list itself keeps its design.

### Fleet page (`/fleet`)

- Page title "Fleet", with a one-line summary ("3 working and 1 needs you, on 2 computers. Mac mini is offline.").
- **Graph**, in a quiet group (`--group` fill, 10 px radius):
  - **Nodes.** This computer sits in the center. Connected computers and this computer's linked phones and tablets go around it, placed deterministically by label. Provider nodes fan outward from each computer, one per provider with live threads. At most 8 computers are drawn; more go into the list only.
  - **Computer node.**
    - A device glyph (laptop, monitor, server, phone).
    - A dot for **connection**: `--success` connected, `--warning` reconnecting, `--muted-foreground` offline.
    - A ring for **work**: dot blue `--primary-graph` working, amber needs you, neutral otherwise.
    - A name, and a mono sub-line ("This computer", "On your network", "Through the relay", "Offline · 2h ago").
  - **Provider node.** The provider's own mark, with a count badge (blue working, amber needs you).
  - **Line styles.** Working is a blue dotted line plus a traveling dot. Needs you is amber solid and still. Connected is grey solid. Reconnecting is amber dashed. Offline is grey dashed and faint.
  - **Line meaning.**
    - Center → computer is this app's connection. It counts as working when that computer has running threads.
    - A line between two other computers is a link between them (added in PR 5).
    - Cross-computer work (a parent on one computer, its child on another) makes the line between those two computers working, with dots traveling from the asker to the worker.
- **Traveling dots, built for performance** (measured, see Appendix):
  - The dots are HTML elements over the SVG. They animate only `transform` and `opacity` with CSS keyframes, with the curve pre-sampled into about 18 translate keyframes at ease-in-out spacing.
  - The glow is a static radial gradient. The trail is two delayed copies at lower opacity and scale. The arrival ring is scale plus opacity.
  - Never animate SVG attributes, dash offsets, filters, shadows or motion paths.
  - Lines take turns with staggered delays: a 3.2 s cycle, travelling for 50 % of it.
  - Animations pause (`animation-play-state`) when the window is unfocused or the document hidden. There is none at all under reduced motion, and at most 8 lines move at once.
  - When a child's report arrives, one dot travels back from the worker to the asker, once.
- **Below the graph: threads by computer.** Each computer shows its name, mono location and counts. Rows show a status dot, title, project, the provider mark with the model, and status. Idle and offline computers are summed up in one muted line. Clicking a computer in the graph filters the list.
- **Links section** (PR 5). One row per known computer: its name, "Linked Oct 20 · on your network" or "Not linked", the inbound access dropdown (Allowed / Ask first / Off), and Link and Remove. Pending incoming requests show here as cards with Allow / Deny.
- **One computer.** The graph shows this computer and its providers, with a line under it, "Link another computer or your phone to see them here", and a Connect button that opens the existing Connect dialog.
- **Data:**
  - saved computers and their connection state: `useSavedEnvironmentRegistryStore` / `useSavedEnvironmentRuntimeStore` (catalog.ts:121,351);
  - the primary descriptor;
  - `environmentStateById` thread summaries (store.ts), `resolveThreadStatusPill` and lineage;
  - `links.subscribe` per environment (PR 5);
  - linked devices from `subscribeAuthAccess`, lifted out of ConnectionsSettings.tsx:1935-1975 into a shared hook (owner only, hidden for non-owners).

### Entry points (every one)

- **Command palette:** Fleet, Scheduled, General Chats (missing today), and Move to another computer (PR 4).
- **Keybindings:** `navigate.fleet`, `navigate.scheduled`, `sidebar.toggle`.
- **Desktop:** Fleet and Scheduled in the application menu ("Go") and the tray menu.
- **The rail.**

## Part 5: Sidebar organization

- **Lineage keys are environment-scoped.** A parent and its child may live on different computers. `attachedParentKeyOf` (Sidebar.tsx:255-262) assumes the parent shares the child's environment, so it takes the parent's environment from `remoteOrigin` / `remote`.
- **Families stay with their parent.** A child on another computer is nested under its parent with a small computer glyph.
- **Machine filter.** When it hides the parent's computer but shows the child's, the child appears as its own row with "from <parent> on <computer>". Group counts include nested children.
- **Group by.** A client setting `sidebarGrouping: none | project | computer`, default `none`, picked in the scope menu (ProjectScopeMenu) under a "Group" section.
  - Families are grouped by their parent's project or computer, after families are built (Sidebar.tsx:1011-1051).
  - Groups get header rows (project favicon or computer glyph, name, live counts), collapsible and remembered in `uiStateStore`.
  - Pins sort first inside their group, and Wrapped stays one flat section.
- **Wrap up idle threads.** A client setting `wrapUpIdleThreads`, default on, shown as a row in Settings › Threads › "When a thread is done", next to "Wrap up merged threads". Off passes `autoDoneAfterDays: null` (Sidebar.tsx:776; Sidebar.logic.ts:813 already handles null). Restore defaults lists it.

## Part 6: Scheduled tasks

Parity sources: Claude Desktop scheduled tasks (code.claude.com/docs/en/desktop-scheduled-tasks) and Codex automations (learn.chatgpt.com/docs/automations). Ours adds the choice of computer and works with every agent.

### Model (server, per computer)

Schedules are configuration, not thread history, so they live in their own tables with a repository, RPC and a stream, like settings. Runs create ordinary threads through orchestration commands. Exactly-once comes from the run table and staged launches, not from the event store.

- **`scheduled_tasks`:** `id, name, prompt, project_id, workspace (local|worktree), agent_json ({instanceId, model}), runtime_mode, interaction_mode, cadence_json, timezone, target_json ({kind:new_thread} | {kind:thread, threadId}), status (active|paused|error), error, created_at, updated_at, next_slot_utc`.
- **`scheduled_runs`:** `task_id, slot_utc, status (launching|started|skipped|failed|interrupted|finished|nothing_to_report), stage, reason, thread_id, message_id, turn_id, catch_up, created_at`, unique on `(task_id, slot_utc)`.
- **Cadence:** `manual | hourly | daily{time} | weekdays{time} | weekly{weekday,time} | custom{cron}`.
  - Presets compile to 5-field cron. Custom accepts 5 fields only (minute resolution), refusing the seconds field `effect/Cron` would allow.
  - Saving requires `Cron.next` to find an occurrence within 366 days. Parse and next both run in a `try` at save time and at every tick, so one bad task can only fail itself (status `error` with the reason).
- **Time.**
  - A slot is the UTC instant of a cron occurrence evaluated in the task's `timezone`. The timezone is stored on the task: the computer's zone at creation, editable.
  - A cadence whose hour field is `*` (hourly, every 15 minutes) keeps to real time through any clock change: it fires whenever the wall clock reads a matching time, in both passes of a repeated stretch and never for a skipped one. A cadence with set hours fires each wall time once: a time a spring-forward skips fires the same distance past the jump (02:30 fires at 03:30), and a repeated one at its first instant.
  - If the computer's zone changes, tasks keep their stored zone, and the UI names it when it differs from the viewer's.

### Scheduler (`ScheduledTaskReactor`)

- **Tick** every 30 s (`Schedule.spaced`), wired like `ThreadAutoArchiveSweeper`.
- **Due slots.** For each active task with `next_slot_utc` ≤ now, one transaction inserts the `scheduled_runs` row (`launching`, or `skipped` with its reason) and advances `next_slot_utc`. When several slots passed, only the most recent is considered, which is the catch-up rule.
  - Skip reason "the previous run is still working": the task's last run's turn is still live.
  - Skip reason "3 scheduled runs were already working": over the per-computer cap of 3.
- **Launch.** Each `launching` row runs the staged `ThreadBootstrap` sequence (create, worktree, setup, turn), with command ids derived from `(taskId, slotUtc, stage)`, and records `stage` after each step. "Once" means one launch per slot.
  - The run thread's first message carries a short preamble: the task name, and, where the run tool exists, "If there is nothing to report, call scheduled_run_finish with nothing_to_report".
- **Continue in a thread.** `thread.follow-up.submit` on the target thread, which steers or queues like any follow-up (decider.ts:331). The run records its `message_id`, and its turn is bound when that message's turn starts.
- **Startup reconcile.** `launching` rows resume from their stage. A started run whose turn was cut off by the restart becomes `interrupted`. A run whose turn ended becomes `finished`.
- **Missed runs.** At startup, and when a tick sees a gap over 90 s (sleep), every task with missed slots in the last 7 days gets one catch-up run for the most recent missed slot (`catch_up: true`). The older slots are recorded as one `skipped` row: "the computer was off or asleep".
- **Approvals.** Runs use the task's access level. A run that needs approval waits in the inbox like any thread ("needs you").

### Agent tools

- **`scheduled_run_finish { nothing_to_report: boolean, summary? }`.**
  - It is attached to run threads on its own, whatever the "Agents can start threads" setting, and only for drivers that take Threadlines tools.
  - ACP agents get it only when they declare HTTP MCP support (AcpAdapter.ts:1519). Each driver records its decision in the PR.
  - It is accepted only from the run's own turn.
  - `nothing_to_report` marks the run. It wraps and marks the thread seen only for new-thread runs, never a continued thread.
  - Without the tool, a run's status comes from its turn ending (`finished` or `failed`).
- **`schedule_list`, `schedule_create`, `schedule_update`** (pause and resume included) follow the "Agents can start threads" setting:
  - off hides them;
  - ask shows an approval card in the thread (the child-thread approval card gains a schedule kind);
  - auto applies them.

  Threads with `remoteOrigin` never get them.

### UI

- **`/scheduled` page.** Tasks from every connected computer that has `scheduledTasks`, grouped by computer. Each row shows the name, cadence ("Weekdays at 9:00"), project, agent, next run, last run status and an Active switch. "New task" is the page's one primary button.
- **Form:**
  - Name and Instructions.
  - Computer, which decides the server the task lives on.
  - Project, and "Runs in": Local checkout or New worktree.
  - Agent, model and reasoning, using the existing model picker against that computer's agents.
  - Access, using the composer's access levels.
  - Schedule: Manual, Hourly, Daily, Weekdays, Weekly or Custom, with time and day pickers, and a cron field plus a "next runs" preview for Custom.
  - Each run: New thread or Continue in a thread.
- **Detail view.**
  - Run history: started, skipped with the reason, nothing to report, interrupted, each with a link to its thread.
  - Run now, Edit and Pause.
  - Delete, with "Also archive its run threads".
- **Inbox.** Run threads are ordinary inbox threads, with a clock glyph and "Scheduled · <task>" on their top line.
- **Keep awake.** A desktop setting, "Keep this computer awake for scheduled tasks" (default off). Electron's `powerSaveBlocker` `prevent-app-suspension` holds while this computer has an active task that isn't manual.

## Part 7: Startup label (#38)

`starting` alone isn't enough. The decider sets it on every turn whose session isn't `running`, including warm `ready` sessions (decider.ts:2179-2215), and the reactor then reuses the live runtime (ProviderCommandReactor.ts:1373-1383).

- **Launch signal.** The reactor's one start path, `startProviderSession` (ProviderCommandReactor.ts:1162-1195), runs only when a session is actually started or restarted. There it records `thread.session-set` with a new optional `startupPhase: "launching"` and the instance id. The phase clears on `session.started` or an error. This covers every driver, ACP included, from one place.
- **Working row.** It says "Starting <instance display name>" during `launching` and "Preparing turn" otherwise. For a thread on another computer: "Starting Codex on Mac mini".
- **30 s notice.** It names the phase: "Codex is taking a while to start", or the current "Preparing this turn is taking longer than usual."
- **Tests:** a cold first turn, a warm turn (no launching), a resume after restart, and a provider switch.

## Pull requests, waves and file ownership

| PR  | Branch                 | Contents                                                                                                                                                                                                                                                                                                                                              | Needs merged first                                 |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | `feat/computer-links`  | Parts 1-2: shared secure socket and joiner, persisted invite purpose, the `peer` role and endpoint, `computer_links`, `ComputerLinkClient`, `PeerRpcGroup` (minus move), links RPC, capability flags, remote requests on both sides, the B ledger, tool changes and the fence.                                                                        | none                                               |
| 2   | `feat/fleet-rail`      | Parts 4-5 minus the Links section and minus cross-computer lineage. The graph uses client connections and today's local lineage only.                                                                                                                                                                                                                 | none                                               |
| 3   | `feat/scheduled-tasks` | Part 6, plus the Windows/Linux "keep running in the background" setting.                                                                                                                                                                                                                                                                              | 1, 2                                               |
| 5   | `feat/fleet-links-ui`  | Rev 4: computer pages, adding and linking in one step, and the trimmed Settings › Connections. Also incoming-request cards and inbox rows, link lines between computers, cross-computer lineage in the sidebar (remote parents and children, the family line, machine-filter orphans, grouping placement) and cross-computer work lines in the graph. | 1, 2                                               |
| 4   | `feat/move-thread`     | Part 3.                                                                                                                                                                                                                                                                                                                                               | 1, and 3 if both touch `ProviderCommandReactor.ts` |
| 6   | `fix/startup-label`    | Part 7.                                                                                                                                                                                                                                                                                                                                               | 4                                                  |

- **Wave 1:** PRs 1 and 2 in parallel. PR 1 owns `apps/server`, `packages/contracts` (except `settings.ts` and `keybindings.ts`), `packages/shared/src/relay*` and the new secure socket, plus `apps/web/src/rpc/secureRelaySocket.ts` and `relayJoins.ts`. PR 2 owns `apps/web/src/components/**` and routes, `packages/contracts/src/settings.ts` and `keybindings.ts`, `packages/shared/src/keybindings.ts`, `apps/desktop` menus, and `docs/design/design-language.md`.
- **Wave 2:** PRs 3 and 5. PR 3 owns its new server files, `ProviderCommandReactor.ts` (tool attachment) and `McpRoomServer.ts`, the Scheduled page, and its palette, rail and settings entries. PR 5 owns `apps/web/src/components/fleet/**` and the sidebar family and inbox files. Where both need the same file, the PR that is second edits it after the first merges.
- **Wave 3:** PR 4, then PR 6 (both touch `ProviderCommandReactor.ts`).

## Tests (focused)

- **Peer role and authority.**
  - A `peer` session is refused on `/ws` and on HTTP; `/peer` serves only peer methods; a client session is refused on `/peer`.
  - A crash between the device insert and session issue keeps the invite's grant.
- **Links.** Create and accept end to end between two in-process servers over the direct route. Revoking on B makes A's link `revoked`.
- **Fence.**
  - A peer can't read, send to or stop a thread its link didn't start.
  - A thread with `remoteOrigin` gets no Threadlines tools.
  - Runtime mode is capped at `link_max_runtime_mode`.
- **Remote requests.**
  - Start is idempotent by requestId.
  - A send binds to its own turn.
  - B restarts mid-turn → `failed` report.
  - B restarts after the turn → the report is still delivered.
  - A restarts after recording but before acking → no duplicate, ack sent.
  - Cancel before start, or while awaiting approval → B refuses the late start.
  - A stale epoch drops the report.
  - Stop reaches B.
  - Denied and expired requests settle the parent.
- **Move.**
  - Round trip with commits not on the remote, untracked files, a binary change and a branch collision.
  - Freeze refuses new turns.
  - Abort unfreezes.
  - A crash at each stage resumes or aborts cleanly.
  - B's next turn is seeded.
  - Revert stops at the boundary.
- **Scheduler.**
  - Next slot per preset and zone, including both DST edges.
  - Custom cron with seconds is refused, and one with no next occurrence is refused.
  - Exactly one run per slot across a crash at each stage.
  - Skip reasons; one catch-up for many missed slots.
  - `scheduled_run_finish` is refused from a newer turn; continuation runs never wrap.
- **Startup label.** Cold, warm, resume and provider switch.
- **Web.**
  - The rail renders, collapses to the rail with counts, and clears the macOS lights (geometry asserted).
  - Group by project and by computer, with a cross-computer family.
  - The wrap-idle switch.
  - Fleet statuses from fixture stores.
  - Capability gating hides Fleet and Scheduled items for old servers.
  - Scheduled form validation.

## Verification before calling it done

- `vp fmt`, `vp lint`, `vp run typecheck`, the tests of each touched package, and the web browser suite for PRs 2, 3 and 5.
- **Live:**
  - Two throwaway servers in temp homes (the `threadlines-isolated-verify-stack` recipe), linked over the direct route and over a local relay. A Codex parent on one starts a child on the other, gets the report, sends a follow-up and stops it. Kill each server mid-request once.
  - A scheduled run with a 1-minute custom cron; a sleep simulated with a clock jump.
- **Fleet animation cost in the real Electron app:** GPU process CPU via `app.getAppMetrics()` with the Fleet page open vs closed, on a 120 Hz screen.
- Light and dark screenshots of the rail, Fleet and Scheduled.

## Appendix: animation cost

Measured Oct 20 in headless Chromium at 60 fps, with 3 moving lines.

| Style                                       | Raster tasks / s | Main-thread ms / s |
| ------------------------------------------- | ---------------- | ------------------ |
| Nothing moving                              | 0                | 0.2                |
| HTML overlay, transform + opacity keyframes | 0                | 1.1                |
| SVG dash offset, `steps(6)`                 | 5                | 21                 |
| SVG dash offset, smooth                     | 60               | 31                 |
| rAF script moving SVG circles               | 60               | 35                 |
| CSS `offset-path` / `offset-distance`       | 60               | 38                 |
