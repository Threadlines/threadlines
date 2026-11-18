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
3. **The B ledger stores the full request.** Each row holds the immutable payload: prompt or send text, launch config, parent metadata, and ids reserved at acceptance. Every pre-turn stage (worktree, then the start that makes the thread with its first turn) resumes idempotently from that row after a crash, approvals included (docs/design/thread-setup-state.md).
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

**Rename** (Oct 26) sits in the page's title bar for this computer and for a connected one. See "Names" under R4.5.

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

**Names (Oct 26).** A computer is called by the name its system gives it (macOS's Computer Name, the Windows device name, Linux's pretty hostname) until the user names it in Threadlines: the `computerName` server setting, so the name lives on that computer and every device and linked computer sees the same one. The descriptor's `label` is the name in effect and `systemLabel` the system's; capability `deviceNames` gates every Rename.

- Rename: the computer page's title bar, Settings › Connections › This computer, the command palette ("Rename this computer"), and a computer's menu on the Fleet pages: right-click (or press and hold on a phone) a computer in the list or on the map, or the list row's ⋯ (shown on hover, always on a touch screen). The menu offers Open and Rename… for this computer and the ones this app connects to (Rename shown but off while one can't take a name), Open for a linked one, and Rename… and Connections settings for a phone or tablet on the map. An empty name goes back to the system's.
- Live everywhere: the server reads the name when it needs it (relay lease, link invites, error texts), so nothing keeps the startup name. A rename goes to clients as a new config `snapshot`, which every client version takes the name from, and the config stream subscribes to settings changes before it reads the snapshot. Replayed lifecycle events carry the current name. After the config stream's first snapshot it alone names a saved computer; a late welcome or metadata fetch can't put back an old name.
- Linked computers: a renamed computer re-describes itself to every computer it links to, and the other side stores the name on both halves (its inbound device row and its outbound link; only for a link the invite confirmed). One it can't reach hears it the next time that link connects, as does each of them once after a restart. A description already on its way, or one asked for earlier, can't put an older name back. A computer that only links _to_ the renamed one hears it the next time it calls. An older peer ignores the name until it updates.
- Phones, tablets and browsers are named per sign-in (`auth_sessions.client_name`, `/api/auth/clients/rename`, owner only), from their row in Settings › Connections. A phone that pairs again starts unnamed. Two unnamed ones that would read the same say when each paired ("iPhone (paired Oct 20)"). Their messages (voice included) carry the new name from the next one, without reconnecting. A phone can't name itself: the computer's owner names it.

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
  - A settles the reasoning before it records the launch (child-threads.md, Reasoning), from B's descriptor: `peer.describe` lists each model's `reasoningSetting` (the option id and its levels). A model B didn't list (past the first 12) borrows the same model's setting from A's own provider of that kind; with none, an explicit level is refused and a followed one is sent as is. B checks the level again when it starts the thread and refuses one its model doesn't offer, rather than letting the provider swap in another. Moves keep the thread's options and skip that check.
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
  2. **Watch.** While any remote request is open, or any report is unacked, or a parent that is neither archived nor deleted holds a child there (and the link is usable), `peer.watch` stays open. It passes the held children's ids (`PeerWatchInput.threads`) so B replays their state on connect. A report becomes the remote settle with the report text (`fromThread` origin with `environmentId`), then `peer.report.ack` with `delivered` (the report message was written into the parent). If the decider says that report id is already recorded, that counts as success, and the reactor acks it. Unacked reports are tracked even after the parent request closed.
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

### Filing a child on another computer (Oct 30)

Before, A heard about a child only while a request to it was open, and the sidebar counted a quiet child nobody followed as finished. A user who picked the child up again on B never showed on A, and a child that wrapped on A had no row anywhere (A's app has no thread for it), while B kept it under the parent. The computer the child runs on now decides, and both computers apply one rule.

- **B says how it files the thread.** Every `thread` watch event carries `RemoteThreadFiling`: when its newest turn's answer reached the parent (`handedBackAt`), pinned, the user's Wrap up or Reopen (with its stamp), last activity, seen stamp, unseen work, and archived or deleted. B publishes on every change to those facts and replays the requested threads' state after the reports on connect, so a thread's state outranks how a request ended. `remoteThreadFilingOf` (`packages/shared/src/threadFiling.ts`) computes it with the same helpers the sidebar uses.
- **Handed back on B.** A delivered ack dispatches `thread.remote-handed-back.record` before the ledger marks the report delivered (a retried ack finishes both; the command id is per report). The decider records `thread.handed-back` while that turn is the thread's newest, so a late ack for an older turn never takes back a newer one. The report goes out before the turn's checkpoint ends it, so the ack usually lands while the turn still reads as running; it is recorded then too, and the filing counts it (`isHandedBackCompletion`) once `thread.turn-diff-completed` or `thread.turn-completed` ends the turn, which B publishes to A.
- **A records it.** A thread event updates every parent holding that child (`holdersByChild`), keeping `filing`. A report keeps the record's status when B sends filing, since B's thread state is newer than any request's end.
- **One rule.** `isRemoteChildDone` (Sidebar.logic.ts) runs the same ladder as `isThreadDone` (`fileByFacts`) over B's facts: moving, blocked or waiting holds it; so does an unseen failure, or an unseen turn that didn't go back; then the freshest of the two overrides, a pin, the answer having reached the parent, and idle time. Archived on B is done. An older B (no filing) keeps the earlier rule. Settings stay per device.
- **Wrapped.** A child that leaves a live family gets its own row in Wrapped (`InboxDoneRemoteRow`): the started-by arrow, its computer, and when it wrapped.
- **Wrap up and Reopen from A.** The row's button dispatches `thread.remote-child.done-override.set` on the parent. The record keeps `override`, and the reactor sends `peer.thread.wrap` with the same stamp to a B whose descriptor has `threadFiling`, once per word. B keeps a newer word it already has. A Wrap up also marks the thread seen on B: the user read its answer on A, and that is the visit a failed or unread thread needs before it can be wrapped.
- **A link that's gone.** When the parent's computer no longer links to B (its live links snapshot), the child's last status is history: no pill, the button always shows, and only the user's word files it.

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

A debt for another reason (the provider couldn't reopen its conversation) on a thread that still owes its moved history counts as the move's debt, so paying it records the delivery. The delivered event records the message whose send carried the seed (`historySeedMessageId`). A revert that removes that message owes the seed again, whichever of B's turns carried it (`revertOwesHistorySeed`, used by both projections). A session started seeded with the conversation pays the debt only through a send on that same runtime (matched by its `createdAt`); a replacement runtime builds the seed again. Seed entries name a message's attachments, so a message that was only an attachment still counts.

#### The revert boundary (fixes D6)

**Imported history is outside B's revert accounting.** Every imported message carries `imported: true`: a new optional field on `OrchestrationMessage` and on the `thread.message-sent` payload, stored in a `projection_thread_messages.imported` column. Imported activities have `turnId: null`, so revert already keeps them.

The shared `revertMessages` (`packages/shared/src/transcriptRevert.ts`) keeps imported messages unconditionally and leaves them out of its count-based fallback. That's one rule for all three revert sites: `projector.ts`, `ProjectionPipeline.ts`, and the web.

B's turn numbering starts at 1. Revert to count 0, the state right after the import, is valid and keeps all imported history. There is no decider fence. The web hides revert controls on imported messages.

#### Rules the server reviews added (Oct 22)

- **Branch ownership is proven, not inferred.** B makes the branch itself with `update-ref --create-reflog -m "threadlines move <K>" refs/heads/<name> <headSha> ""` (create-only), then adds the worktree on it. A restart reuses a saved name only when the branch's oldest reflog entry is that note; a name taken by anyone else gets another. Clean-up deletes the branch only with that note and only while it still points at `headSha`.
- **One size budget, measured before anything is written.** At the fetch stage: every path the commits change, at its new size (`diff-tree base..head`, then `cat-file`, so one blob under many paths counts each time), each binary hunk's real target size (a `literal`'s stated size, or the target size in a `delta`'s own header), the patch and the new files. Over 1 GiB aborts. A bundle without a base is refused.
- **Clean-up knows its repository.** The repository's top level (`rev-parse --show-toplevel`, so a project in a subfolder works) is recorded before the fetch stage makes anything, so a project removed since doesn't strand the temp ref, branch or worktree. Clean-up is recorded only once each is verified gone.
- **Only its own folder.** A worktree path already taken when the move first picks it stops the move. Keeping, resetting or removing a worktree there needs proof it's the move's own: its `.git` file points into the recorded repository's worktree list at a `moved-<K>` entry, and (while that repository is there) the entry has the move's tagged branch checked out. Any other folder there is left (an empty one excepted). A path that can't be read, unlike one confirmed gone, leaves clean-up owed.
- **Every stop checks for a landed import.** Not only `peer.move.abort`: a stage that stops an `importing` row (link turned off, a resent `finish`) first checks the receipt, and records `committed` if the import landed.
- **Ask first is read at admission.** The link's current access is read inside the admission lock, right before the row is recorded.
- **A's worker can't die quietly.** Any failure restarts it from the top after 30 s (it asks B where it stands first), including a failure to record the outcome, which keeps the packed copy until it is recorded. A drop B couldn't record yet is asked again every 15 s. A move runs on while its thread is archived (the export reads archived threads too). Deleting the thread mid-move ends the wait and asks B once to drop it; one that already arrived there stays.
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

## Part 3b: Move a working thread (Nov 15, v2 step 1)

Will's ask: keep a thread going on another computer when this one has to shut down. Move v1 refuses any thread with live work, so a working thread can't move. Step 1 adds a move that waits for the thread to be free, an option to stop the work first, and an agent tool. Clearing a whole computer from Fleet and the quit dialog is step 2, carrying the provider's own session is step 3, and families, goals, check-backs and PR automation are step 4. Step 1 changes none of v1's transfer protocol. A queued move ends in today's `thread.move.start`, and nothing about freezing, export, import or abort changes.

### What the user sees

- **Dialog.** When the only things stopping a move are live work, the dialog no longer refuses. It shows what the thread is doing and two choices:
  - **Move when it's done** (default): the move starts as soon as the thread is free.
  - **Stop and move now**: ends the thread's agent session, which stops the turn and all its background work, then moves.

  A thread that can't move for any other reason (room, children, goal, check-back, PR automation, General Chats) is still refused with today's words.

- **While it waits.** A notice above the message box: "Moves to Windows PC when this turn ends." with Cancel. The text changes when it waits on something else: "...when its background work finishes", or "...once you answer" for an approval or question. While a move waits, the thread takes no new turns. The send button reads why. "Send when done" messages, steering and outside assistants' queued messages are refused with the same words. Approvals and questions still work, since the turn needs them to finish.
- **When it can no longer move.** If the turn leaves something that blocks a move (the agent set a check-back or a goal, started a child thread, turned on PR automation, or proposed a plan), the wait ends. The notice says why: "Didn't move: this thread's agent set itself a time to come back. Cancel it first, then move again." It stays until dismissed. The same happens when the thread is archived or deleted, the link is removed, or the target no longer has the chosen agent.
- **Target offline.** A move that is ready but can't reach the target keeps waiting and says "Waiting for Windows PC to connect." It starts when the link comes back. Cancel always works.
- **Sidebar.** The row shows the same "moving" state v1 shows once frozen, and a quieter "move queued" mark before that.

### State

`OrchestrationThread.pendingMove: { requestId, target: { environmentId, label }, agent: ModelSelection, mode: "when-done" | "stop-now", stage: "waiting" | "quiescing", requestedAt, requestedBy: { kind: "user" } | { kind: "agent", turnId } } | null`, projected into a new `pending_move_json` column (migration 111). A thread has at most one: a pending move or a move (`thread.move`), never both.

Events:

- `thread.move-queued`
- `thread.move-quiescing { requestId }`
- `thread.move-queue-ended { requestId, reason: "started" | "cancelled" | "blocked" | "gone", words? }`

Commands:

- `thread.move.queue`, from the user or from the agent tool;
- `thread.move.unqueue { requestId }`, Cancel;
- `thread.move.quiesce { requestId }`, internal, from the reactor;
- `thread.move.queue-end { requestId }`, internal, from the reactor.

Every unqueue and queue-end names the request it ends, and the decider ignores one that names an older request. A late Cancel or an old blocked evaluation can't clear a newer queued move.

### Who may queue (decider, one shared check)

`threadMoveRefusal` becomes `threadMoveRefusals(model, thread) → Array<{ code, kind: "wait" | "blocked", words }>`. Every check runs, instead of the first one winning, so a busy thread doesn't hide a goal behind its running turn.

- `wait`, gone on its own:
  - a running turn, a waiting approval or question, a side turn;
  - background tasks (both counts), a running command run or workflow run, voice active;
  - another thread working in the same checkout.
- `blocked`, needs the user:
  - everything else v1 refuses;
  - **queued follow-up messages**: they would start the next turn as soon as this one ends ("Send or remove your queued messages first");
  - **a proposed plan waiting to be implemented**: `childHasLiveWork` counts it as live work, but only the user's answer clears it, and implementing it starts a turn ("Implement or dismiss the plan first").

`thread.move.queue` is refused when there is a `blocked` code, a pending move, or a move. It is allowed with zero or more `wait` codes. With no `wait` code it still queues, and the reactor starts it at once. That gives one path whether the thread is busy or not.

For `mode: "stop-now"` the decision also plans:

- `thread.session-stop-requested`: ends every runtime of the thread (ProviderCommandReactor `processSessionStopRequested`), and with them the running turn and the background work inside them;
- `thread.side-turn.interrupt` when a side turn runs (its runtime is separate);
- the existing stops for running command runs and workflow runs.

Per-task stops and interrupts aren't used. Claude's interrupt deliberately leaves background tasks running (`perTaskStopAffordance`). Codex, ACP and Pi have no per-task stop, and Muse only has stop-all. An interrupt also projects `interrupted` before ACP and OpenCode finish cancelling. Ending the session is the one stop every driver completes.

### The guard

`threadMoveGuardRefusal` gains a pending-move rule. On a thread with `pendingMove`, it refuses one shared set of work-starting commands, `WORK_START_COMMANDS`:

- `thread.turn.start`, `thread.turn.retry`, `thread.turn.resend`;
- `thread.follow-up.submit`, both steer and queue (scheduled runs into an existing thread use it too);
- `thread.side-turn.start`, `thread.realtime.start`, `thread.command-run.start`;
- `thread.goal.set`, `thread.participant.add`, `thread.pull-request-automation.set` turning a switch on, `thread.continue-at-reset.set` arming;
- `thread.create` with this thread as attached parent;
- implementing a plan.

The automatic continue-at-reset arming inside `thread.session.set` (decider.ts:4143) is skipped while a move waits. The user asked to move, and that wins over an automatic retry here. Early agent start while typing is refused for the thread too.

The words: "This thread is waiting to move to Windows PC. Cancel the move to keep working here." Everything a running turn needs keeps working: approvals, answers, activity, session updates, interrupt. The guard keeps the wait short and tells the user why. It is not what keeps the move safe. Providers start turns of their own, through runtime events rather than commands: Claude after queued steering or a finished background agent (ClaudeAdapter.ts:5150), ACP autonomous turns (AcpAdapter.ts:834), Codex `turn/started`. No command guard can refuse those. The barrier below handles them.

### The barrier: the session ends before the freeze

A thread is ready to move only when no runtime of it exists. The projected state can say "free" while a provider is still cancelling, or just before it starts a turn of its own. So the queue never goes straight from "free" to the freeze:

1. When the projection has no `wait` code, the reactor dispatches `thread.move.quiesce { requestId }`. The decider records `thread.move-quiescing`, which sets `pendingMove.stage: "quiescing"`, and plans `thread.session-stop-requested`. In "stop-now" mode the queue decision records it straight away. From here the **session fence** holds (below).
2. It calls the new `ProviderService.quiesceThread(threadId)` and waits for it. This stops every session whose parsed thread id is this thread: main, participants, side runtimes (their own keys, ProviderCommandReactor.ts:5774) and early starts. Each driver confirms its teardown (below). The result is `confirmed`, or `unconfirmed { reason }`.
   - `unconfirmed` keeps the move waiting, with "Couldn't confirm the agent stopped: <reason>." plus Try again and Cancel. It never moves anyway.
3. It re-reads the projection. If a turn slipped in (a provider turn that ended before the stop, for example), it goes back to waiting.
4. Otherwise it calls `ThreadMoves.start`. `decideMoveStart` checks again, in the same decision as the freeze, that the session is stopped and there are no `wait` codes. If either fails, the move isn't started, and the reactor goes back to step 1.

**The session fence.** A command guard can't stop sessions that reopen without a command. `serverReadSubagentTranscript` (ws.ts:1727) and context compaction both let ProviderService recover a stopped session (ProviderService.ts:792, 2205, 2793). So ProviderService itself asks one admission check before it starts or recovers any session for a thread: `ThreadSessionAdmission.check(threadId)`. The check reads the projection and refuses while `pendingMove.stage === "quiescing"` or `thread.move` is set, frozen or moved away. That covers starts, recovery, compaction, transcript reads that would recover, room agents, side runtimes and early starts. The fence lives in the projection, so it holds across restarts, and startup recovery skips fenced threads. v1 gains this fence too: today a frozen thread can be recovered by a transcript read. `thread.context-compact.request` joins `WORK_START_COMMANDS`.

If the user cancels while the move is quiescing, the fence lifts with the pending move, and the next message starts a fresh session as usual.

**Confirmed teardown, per driver.** `quiesceThread` passes only when each runtime confirms its work is gone. A session missing from `listSessions()` isn't enough: today Claude marks itself closed after a `query.close()` that may have failed (ClaudeAdapter.ts:8442-8482). ACP also ignores `session/close` failures, though Grok's background shells live in separate process groups that survive a plain kill (AcpSessionRuntime.ts:859-873). Each driver's stop gains a confirmed result:

- **Claude:** wait for the CLI child process to exit after close, then kill its process group and wait for it.
- **Codex:** the app-server process exits.
- **ACP:** after `session/close`, or its timeout, kill the agent's process group and any process groups it reported for shells, then wait for exit.
- **OpenCode, Pi, Muse:** their host or process exits, after Muse's `task/stopAll`.

A driver that can't prove it returns `unconfirmed`. These are the same checks v1's freeze should have made. v1's export also starts only after `quiesceThread` confirms.

Once quiesced and fenced, nothing can start work. Provider turns need a session, and no session can open. A command the guard misses only makes the move wait.

### The reactor (`moves/MoveQueue.ts`, beside ThreadMoves)

It watches projected thread changes and link changes (added, removed, access changed, reconnected) for threads with `pendingMove`. It subscribes before its startup scan, so a change during the scan isn't missed, and the scan waits until provider session recovery has run. A move that is waiting on its target also retries on its own, every 15 s at first and backing off to 2 minutes, so a failed `peer.describe` on a connected link doesn't leave the thread stuck. For each one:

1. A `blocked` code → `thread.move.queue-end { reason: "blocked", words }`.
2. A `wait` code → nothing. It looks again on the next change.
3. Free → the barrier above, then `ThreadMoves.start({ threadId, targetEnvironmentId, agent, queuedRequestId })`. `start` already re-runs preview and checks the target and the agent.
   - A target refusal that can pass (unreachable, `peer.describe` failed) → keep waiting with "Waiting for <target> to connect."
   - A refusal that won't pass (link removed or off, agent gone, no project there) → `queue-end { reason: "blocked", words }`.
   - Success → the decider's `decideMoveStart` records `thread.move-started` and, in the same decision, `thread.move-queue-ended { reason: "started" }` when the command carries the thread's current `queuedRequestId`. The pending move and the freeze swap in one commit.

`decideMoveStart` refuses a `queuedRequestId` that isn't the thread's current one, so an old reactor pass can't start a cancelled move. A direct user `thread.move.start` on a thread with a pending move is refused ("A move is already waiting").

**Cancel against start.** `moves.unqueue { threadId, requestId }` dispatches `thread.move.unqueue`. If the move already started from that request (the thread's `move.queuedRequestId` matches), it becomes v1's `thread.move.cancel` for that transfer, which asks the target to drop it. The user sees one Cancel button either way.

### Agent tool: `thread_move`

- **Who gets it:** a room tool, main runtime only, in `THREAD_TOOL_NAMES`, access tier "changes".
- **What it moves:** the caller's own thread only, in step 1.
- **Input:** `{ computer, agent? }`. Computer names come from `thread_agents`' `computers`. `agent` defaults to the target's suggested agent, the way the dialog does.
- **What it does:** queues `mode: "when-done"` with `requestedBy: { kind: "agent", turnId }`. The caller's own turn is the live work, so the move starts once this turn ends, after the agent's last words. A turn that ends in an error or is interrupted still ends, and the move goes ahead. The user's Cancel is the way to keep the thread here.
- **What it returns:** "Queued: this thread moves to <computer> when your turn ends. Finish your reply; don't start more work." Or the refusal words.

Fences:

- refused on threads started by a link (`remoteOrigin`, already a `blocked` code) and on threads an outside agent works in (`outsideOrigin`); the endpoint's existing `changes` fence stays;
- refused for side runtimes;
- the target's own Ask first/Allowed/Off gate applies unchanged, as in v1.

The user sees the same notice, with "Your agent asked to move this thread", and can Cancel.

### Contracts

- `ThreadMovePreview` gains `waitsFor?: ThreadMoveWait[]`: the wait codes with words. Only `blocked` codes fill `refusal`.
- New RPCs: `moves.queue { threadId, targetEnvironmentId, agent, mode }` and `moves.unqueue { threadId, requestId }`. The client sends the `requestId` it shows, never the server's current one.
- `moves.start` stays for older clients and for the reactor's path.

### App guide

The Fleet topic paragraph (added Nov 15) gains a sentence on Move when it's done, Stop and move now, and the agent tool.

### Tests (focused)

Decider:

- queue refused on a `blocked` code;
- queue accepted while a turn runs;
- the guard refuses `thread.turn.start` and a "Send when done" follow-up while a move waits;
- a stale `queuedRequestId` is refused;
- start and queue-end happen in one decision;
- stop-now plans the session stop and the side-turn interrupt;
- the freeze is refused while the projected session isn't stopped;
- an unqueue or queue-end naming an old request changes nothing.

Reactor, against a fake engine and links:

- starts after the turn completes;
- not before background tasks settle;
- ends as blocked when the agent set a check-back during the turn;
- keeps waiting while the target is offline, then starts on reconnect;
- survives a restart with a pending move;
- a provider-started turn after "free" sends the move back to waiting;
- a Cancel that races the start cancels the transfer instead;
- a failed describe on a connected link retries.

Browser:

- the dialog's two choices on a working thread;
- the notice with Cancel;
- the send button's reason.

One live check on the two-computer test stack with a fake fx agent: queue during a turn, the turn ends, the move commits, the thread continues on B.

### Out of scope here (later steps)

- clearing a computer from Fleet and the quit dialog (step 2);
- carrying native sessions (step 3);
- families, goals, check-backs, PR automation, rooms and General Chats (step 4);
- moving another thread with the agent tool.

## Part 3c: Clear a computer before you shut it down (Nov 16, v2 step 2)

Step 1 (Part 3b) moves one thread at a time, from its menu. Step 2 is for the moment Will asked about: this computer is about to shut down, and its threads should keep going on another one. It adds a way to move several threads at once, an offer in the quit dialog, and a way for a move to finish without anyone at the other computer. Each thread still moves through Part 3b's queue and Part 3's transfer, unchanged in kind.

### What the user sees

- **Move threads dialog.** Opened from Fleet (a computer's page: "Move threads here…"; this computer's page: "Move threads to another computer…") and from ⌘K. It shows:
  - the target computer (picker; preset when opened from that computer's page);
  - this computer's open threads, one row each with its title and what moving it means: "Moves now", "Moves when the agent finishes", or, greyed out, why it can't move ("Has a goal set. Clear it first.");
  - threads whose agent is working come first and are ticked by default; idle ones are listed, unticked;
  - for working threads, the same two choices as Part 3b, once for all of them: "Move when each agent finishes" (default) or "Stop the agents and move now";
  - a button "Move 3 threads".

  "Open threads" are this computer's project threads in the inbox: not archived, not wrapped up, not General Chats. Threads that can't move are still listed (greyed out, with the reason), so nothing is silently left behind.

- **Progress.** While a batch runs, the target's Fleet row and page show "Moving 3 threads here: 1 moved, 2 waiting for their agents". Each thread's own notice is Part 3b's. When it's done, it reads "Moved 3 threads to Windows PC" for a while, or names the ones that didn't move and why.
- **Quit dialog.** When threads are working on this computer and a linked computer is connected that takes moves, the dialog adds "Move them to Windows PC and quit" (a picker when there are several computers), beside today's Cancel and Quit.
  - Clicking it queues the working threads ("when each agent finishes") and turns the dialog into progress: "Moving 3 threads to Windows PC. 1 moved, 2 waiting for their agents to finish."
  - Buttons while it runs: "Stop the agents and move now" (switches the waiting ones to stop-now), "Quit anyway" (the rest stay waiting here and carry on when this computer starts again), "Cancel" (cancels the moves that haven't started; started ones finish).
  - When every thread has a final answer, the app quits by itself after a short "All moved. Quitting…". If any didn't move, it doesn't quit: it lists them with why, and offers Quit anyway.
  - Only a quit the user starts gets this. A system shutdown or log-out can't be held for minutes; it keeps today's behavior.
- **The other computer doesn't need anyone there.** When the other computer's permission is Ask first, the move still sends everything right away and waits there for its user to allow it. This computer counts it as done once the other computer has every byte ("Sent, waiting for Windows PC to allow it"), so it can quit. Allow imports it; Don't allow drops it, and this computer's copy unfreezes the next time it starts and hears back.
  - The other computer's allow card groups moves from one computer: "Mac wants to move 3 threads here" with Allow all and Don't allow, plus each thread's title.

### Server

1. **Batch RPCs** (WsMovesRpcGroup):
   - `moves.previewMany { threadIds } → { threads: [{ threadId, refusal?, waitsFor? }], targets }`: the same checks as `moves.preview`, one read of the targets.
   - `moves.queueMany { threadIds, targetEnvironmentId, mode } → { batchId, queued: [{ threadId, requestId }], refused: [{ threadId, words }] }`: one `thread.move.queue` per thread, each decided on its own. One refusal doesn't stop the others. No `agent`: each picks the target's suggestion when it starts (Part 3b).
   - `moves.setMode { threadId, requestId, mode: "stop-now" }` for "Stop the agents and move now" on moves already waiting. It re-plans the stop for that request; a request that already started is untouched.
2. **`batchId` on `pendingMove` and on the move** (optional), so any client can group a batch and show its progress from the projection alone. No new table.
3. **The other computer's caps become waits.** Today the target refuses a third open move from one link ("already taking other moves", LinkMoves.ts:75, per link 2, total 4), and Part 3b ends a queued move on that refusal. That refusal becomes a code (`busy`) that MoveQueue treats as "wait and retry" with its backoff, showing "Waiting for Windows PC to finish other moves." The caps stay: they bound disk and memory on the target.
4. **Receive before allow.** On the target, `peer.move.prepare` under Ask first records the move as `awaiting_approval` and **accepts chunks** into staging, as `receiving` does. Only the import waits for Allow.
   - The staged bytes count against the same per-transfer and unpack limits as today. The 24-hour expiry of unanswered moves stays, and deletes the staging.
   - `peer.move.status` gains a state the source can read: `staged_awaiting_approval`, meaning every byte arrived and the import waits for its user.
   - The source records this as a move phase (`awaiting_approval`, already shown in v1's notice as "waiting for X to allow it") and treats it as a final answer **for quitting only**. The thread stays frozen here. Its outcome (imported, or dropped) is read the next time the link connects, as v1 recovery already does.
5. **Grouped allow card.** The target's pending-move notifications group by link: one inbox row and one card listing the threads, with Allow all and Don't allow. Allowing one at a time stays possible on each thread's row.

### Desktop

The quit confirmation already waits for the page's answer (`resolveQuitConfirmation`). The page keeps the dialog open while moves run and answers `true` when it's time to quit. Check the window code for any timeout on that wait, and make sure a quit asked again while moves run (a second ⌘Q) shows the same dialog rather than quitting.

### Clients

- The batch dialog, Fleet entries, ⌘K entry and quit-dialog flow above, on desktop, web and phone. The quit flow is desktop only.
- Progress is computed from the threads' `pendingMove` and `move` with a `batchId`. The quit flow remembers its `batchId`.
- Offered only for targets with `threadMoveQueue` (and, for receive-before-allow, a new capability `threadMoveStagedApproval`; without it, an Ask-first target means "Waiting for X to allow it" blocks quitting, and the dialog says so).

### Tests (focused)

- Decider and RPC: queueMany decides each thread on its own; a refused thread doesn't stop the others; setMode affects only its own waiting request.
- MoveQueue: a busy target keeps the move waiting and retries; three moves to a 2-per-link target all land in turn.
- LinkMoves: Ask first stages every chunk before Allow; Allow imports; Don't allow and expiry delete the staging; the source reads `staged_awaiting_approval`.
- Web: the batch dialog's list (working first and ticked, refusals greyed out with words); the quit dialog's progress and auto-quit; Quit anyway; a thread that didn't move stops the auto-quit.
- Live, on the two-server stack: move three working threads to a 2-per-link target from the batch RPC; quit-style flow against an Ask-first target where A's part ends at "sent" and B's Allow imports later.

### Review changes (Nov 16, outside review of this plan)

The plan above is corrected as follows. Where they differ, this wins.

1. **Staged moves get their own budget.** Moves held for Ask first (every byte staged, waiting for Allow) no longer count against the 2-per-link and 4-total caps. Those caps now bound only transfers in flight, so they always drain.
   - Staged moves have their own limits on the target: at most 20 per link and 2 GiB of staged bytes per link, counted at prepare from the manifest's declared sizes.
   - A move past them is refused at prepare with the code `staging_full`: "Windows PC is holding other moves until its user allows them." That is a final answer: the source unfreezes the thread, and it's reported as not moved.
2. **A busy target makes the transfer wait, not fail.** The cap refusal at `peer.move.prepare` (ThreadMoves.ts, after MoveQueue has handed the move off) becomes the code `busy`. The transfer worker keeps the thread frozen in a phase `waiting_for_target` ("Waiting for Windows PC to finish other moves") and asks again with backoff (15 s, rising to 2 min). Today it settles the move as aborted.
3. **Batches and outcomes are durable.**
   - A table `thread_move_batches (batch_id, target_environment_id, created_at, members_json, refused_json)` records every thread asked for and the refusals given at queue time.
   - Each thread gains `lastMoveOutcome { batchId?, requestId, result: "moved" | "not_moved" | "awaiting_approval", words?, at }`, set by the same decisions that end a pending move or settle a move. It survives the abort and blocked paths that clear `pendingMove` and `move` today.
   - `moves.batchStatus { batchId }` returns every member with its state. Final means moved, not moved, or staged and waiting for approval.
   - The quit flow and the Fleet progress read that instead of guessing from the projection.
4. **The quit wait belongs to the desktop app's main process, not the page.**
   - New IPC: `desktop:quit-after-moves { batchId }` starts it, and `desktop:quit-after-moves-cancel` ends it.
   - While it runs, hiding or closing the window doesn't answer the quit question with "no" (DesktopWindow.ts:1488). The window hides, the page keeps running, and it answers "quit" when `batchStatus` is final for every member with nothing not moved.
   - A second ⌘Q shows the same progress dialog.
   - If the page goes away (a renderer crash), the main process asks `batchStatus` itself, through the backend.
   - The update-restart path stays as it is (no update-flow changes): moves under way stop with the backend and resume when the app starts again, which the queue and the transfer worker already do.
5. **Capabilities.**
   - `threadMoveBatch` on the source server gates the batch RPCs and the batch dialog. Without it, the Move threads dialog and the quit offer don't appear, and the single-thread move works as in step 1.
   - `threadMoveStagedApproval` on the target gates receive-before-allow. Without it, an Ask-first target holds the bytes back as today, and the quit dialog says the move will wait for Allow there before this computer can quit.

### Out of scope

- A system shutdown waiting for moves.
- Moving General Chats, rooms, families (step 4).
- Native session carry (step 3).

## Part 3d: The agent keeps its memory when a thread moves (Nov 16, v2 step 3)

Today a moved thread's agent starts a fresh session on the other computer with a text summary of the conversation (the handoff seed). It loses its tool history, the files it read, its subagents' work and anything it held in context but never wrote into a message. Step 3 carries the agent's own session file to the other computer, so it resumes where it was. The summary stays as the fallback for every case that can't carry one, or where the carried session fails to resume.

### Which agents

- **Claude, Codex and Pi** keep their sessions as files, and Threadlines already resumes each from a file (`ClaudeSessionTranscripts.ts`, Codex's resume by path in `CodexSessionRuntime.ts`, Pi's `--session`/`--fork`). These three carry.
- **OpenCode** keeps sessions in its server's SQLite database, with no export call in our code. **Muse** and the **ACP agents** (fx, Cursor, Grok, Antigravity, community) keep them where we don't know. They all get the summary, as today.
- A session carries only when the agent picked on the other computer is the **same driver** (Claude to Claude, and so on). A different driver gets the summary. The model may differ.

### What the user sees

- **Move dialog** (single thread and batch), one quiet line per thread: "The agent keeps its full memory." or "The agent gets a summary of the conversation." It updates with the agent picked. A session too large to send reads "…a summary (its session is too large to send)".
- **On the other computer**, the moved-in line in the timeline says which it was: "Moved here from Mac with its agent's memory" or "…with a summary of the conversation". If a carried session fails and falls back: "Couldn't resume the agent's session here, so it got a summary instead."

### Export (the computer the thread leaves)

`ThreadMoves` reads the thread's provider binding (ProviderSessionDirectory: instance, `resumeCursor`) while the thread is frozen and quiesced (Part 3b). With a confirmed stop, the files are no longer written. It asks the driver's new `exportNativeSession(binding) → NativeSessionExport | null`:

- **Claude:**
  - `projects/<slug>/<sessionId>.jsonl` from the instance's config folder;
  - the `<sessionId>/subagents/` tree, so subagent transcripts open on the other side;
  - not `file-history`, `todos`, `plans` or `shell-snapshots`. Checkpoints don't cross a move (Part 3), and the rest is per-machine state.
  - The cursor keeps `resume` and `resumeSessionAt`.
- **Codex:** the rollout file (`sessions/YYYY/MM/DD/rollout-*<threadId>.jsonl`, or `.zst` as found), plus the cursor `{threadId}`.
- **Pi:** the session file named in the cursor, plus the cursor with `sessionFile` made relative.

The export becomes a new manifest part kind, `session`: `{ driver, cliVersion?, files: [{ relPath, bytes, sha256 }], cursor }`. Paths are relative to the driver's home, checked for traversal on both sides. Sizes:

- The session counts against the move's existing 100 MB cap, with a per-session cap of 50 MB.
- Past either, no session part is sent, and the manifest says `sessionOmitted: "too_large"`.
- The preview reports the expected outcome (`carries | summary | too_large`) per thread and target agent, so the dialog line is right before the move starts.

The part is only sent to a target whose peer descriptor has `moveNativeSession: true` (a new capability). Older targets refuse unknown part kinds (`moveManifestRefusal`), so they never get one.

### Import (the computer the thread arrives at)

In `commitStage`, before `thread.import`, under the per-transfer lock:

- The chosen instance's driver gets `importNativeSession(export, { worktreePath }) → { cursor } | { refused }`. It writes the files into **that instance's own home** (its account folder or CODEX_HOME or Pi dir) and returns the cursor for this computer:
  - **Claude:** writes under `projects/<slug of the new worktree path>/`. The transcript's `worktree-state` line names the old worktree, so the existing `forkResumeOutOfWorktree` resumes it as a fork in the new place. No file is rewritten.
  - **Codex:** writes the rollout under this home's `sessions/` with the same relative path. The cursor gains the rollout's path, so the first start resumes it by path with the new cwd (the side-answer path already does this). Codex's state database learns it from that resume.
  - **Pi:** writes the session file under this computer's Pi sessions folder and returns a cursor with the new absolute `sessionFile` and the old `cwd`. The cwd differs, so Pi forks it into the new folder, as it already does.
- The import writes the thread's provider binding (`ProviderSessionDirectory.upsert`) with that cursor, inside the same commit step, so a crash between the two is redone by the existing import recovery. The import is idempotent per transfer key: files land under names derived from the session id, and are rewritten on retry.
- `thread.import` records `nativeSession: "carried"` on the thread, alongside the existing `historySeedOwed`.

### Resume, and falling back to the summary

The seed debt stays owed on a carried thread until the carried session proves itself:

1. The first start resumes from the imported cursor.
   - If the driver reports it couldn't resume (Claude's resume-fallback, Codex's `onResumeFallback`, Pi failing to open the file), the reactor pays the seed as today. It records `nativeSession: "fell_back"`, with the timeline line.
   - `ProviderService.startSession` must return whether it truly resumed. Add that signal where a driver lacks a clean one; don't infer it from warnings.
2. If the first turn after a carried resume fails with an error showing the session's contents can't be used on this account or version, the reactor:
   - drops the carried session;
   - starts a seeded session;
   - sends the user's message again, once;
   - records the fallback.

   Codex examples: encrypted reasoning from another account, or a rollout written by a newer Codex. Claude example: a rejected thinking-block signature.

   The exact error signatures come from each provider's real errors. Verify them against the Codex open-source repo and real Claude errors; don't guess. An unrecognized failure is an ordinary failed turn.

3. Once a turn succeeds on the carried session, the debt is cleared: `nativeSession: "resumed"`, no seed. A later revert past the move boundary still re-owes the seed, as Part 3 already does.

### Review changes (Nov 16, outside review of this plan)

Where they differ, these win.

1. **The target names every file itself.** A manifest's paths are never used to write. `importNativeSession` takes the session id from the cursor, checks its shape (Claude: a UUID; Codex: its thread id format; Pi: its session id), and computes each destination from it with the driver's own layout:
   - **Claude:** `projects/<slug>/<sessionId>.jsonl`, plus `<sessionId>/subagents/` files named `agent-<id>.jsonl` or `.meta.json`, and `workflows/<runId>/` under it.
   - **Codex:** `sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl` or `.zst`, with the date taken from the rollout's own name.
   - **Pi:** `sessions/<slug>/<timestamp>_<id>.jsonl`.

   Anything else in the part is refused, and the move carries no session (summary). No credential, settings or other home file can be named.

   **Ownership:** a destination that already exists is overwritten only if it was written by this same transfer (a marker beside it, or the same SHA-256). Otherwise the session isn't carried, rather than overwriting someone else's.

2. **A fallback never sends without context.** For a thread whose context is owed (moved, or a fallen-back carried session), a send that can't build its seed is not sent. The turn fails visibly with "Couldn't give the agent this conversation, so the message wasn't sent." and the debt stays owed. That replaces today's path, which drops both seeds and sends anyway (ProviderCommandReactor.ts ~2353, ~2498). Retrying the send tries again.

### Not in this step

- OpenCode, Muse and ACP native carry. Each needs its own export or import story.
- Carrying sessions between different drivers.
- Checkpoints and file history across a move.

### Tests (focused)

- Export picks the right files per driver, skips the per-machine folders, and respects both caps with `sessionOmitted`.
- Import writes under the target instance's home with traversal refused, writes the binding in the commit step, and is idempotent on retry.
- Preview outcome per agent choice.
- Reactor:
  - a resumed session pays no seed;
  - a resume fallback pays it;
  - a first-turn signature error falls back once and resends;
  - an ordinary failure doesn't.
- Live, on the two-server stack: real Claude and Codex runs need Will's OK for usage. Without it, a stand-in Pi or Claude CLI isn't feasible, so the live part tests the file placement and binding with a fake session file, and states that a real resume is unverified.

## Part 3e: A thread moves with what it had going (Nov 17, v2 step 4a)

Steps 1 to 3 move a thread that is doing nothing special. A thread with a goal, a check-back, pull request auto-fix or auto-merge, queued messages or a plan waiting is still refused, and so is every General Chats thread. Those are the threads people leave running, so they are the ones a shutdown most needs to move. Step 4a lifts those six refusals. Families (threads that started threads) and rooms are step 4b.

Nothing in Part 3's transfer, Part 3b's queue and barrier, Part 3c's batches or Part 3d's session carry changes in kind. This step adds what rides along, and what happens to it at each end.

### The rule

**What was going to run by itself here runs by itself there, fenced.** A goal that was working, a check-back that was due, a message waiting its turn: each keeps going on the other computer without the user setting it up again, as far as the link's permission allows (its access ceiling caps the thread's mode). A thread with none of these still arrives idle, as today. (Will's call 1 below: the default is that this starts work on arrival.) Two things are the other computer's user's to give, not the move's (Security changes, below): pull request switches arrive off, and the thread works behind the link fence (no Threadlines tools) until that user sends it a message.

Three more rules follow from the requirements:

- **Never on two computers.** Everything that acts on its own for a thread (the queue drain, the pull request watcher, check-back timers, the goal) stops on this computer before the thread leaves, and stays stopped on the read-only copy.
- **Nothing is left behind quietly.** The dialog says what comes along before the move. The "Moved here" line on the other computer says what arrived and what could not, with why.
- **If the move doesn't happen, the thread gets back what the move took.** Stopping the agent for a move ends its timers and pauses its goal. A move that is then cancelled, blocked or dropped puts them back here ("Put back", below).

### What each one does

| The thread has                          | What happens                                                                                                                                                            | Still refused                                                                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) A goal                              | **Carried.** The goal, its budget and its counts come along. One that was working is picked up there by itself. One the user had paused arrives paused, with Resume.    | Nothing. An agent picked there that can't keep goals gets none: the arrival line says so and quotes the goal.                                     |
| (b) Check-backs                         | **Set up again there.** The agent's timers end with its process here. On arrival the agent is told what it had planned and when, and sets them again itself.            | Nothing. An agent picked there that can't set check-backs is still told once, on arrival.                                                         |
| (c) Pull request auto-fix or auto-merge | **Linked, off.** The linked pull requests come along; every switch arrives off. The thread's notice there says what was on, with Turn on. They stop here at the freeze. | Nothing. When the branch had to be renamed there, there is no Turn on: the arrival line says why.                                                 |
| (d) A General Chats thread              | **Carried.** The chat and every file in its folder land in General chats on the other computer.                                                                         | A folder over the move's 100 MB limit, with its size.                                                                                             |
| (e) Queued messages                     | **Carried.** The user's own queued messages wait here while the move waits, travel with their attachments, and are sent there in order.                                 | A queued message from a scheduled task, another thread or an outside assistant: "…is waiting its turn. Move once it has been sent, or remove it." |
| (f) A plan waiting                      | **Carried.** The thread's plans come along. The waiting one arrives waiting, and Implement and Dismiss work there.                                                      | Nothing.                                                                                                                                          |

All of it only when the other computer says it takes it (Capabilities). Against an older computer, every one of these is refused exactly as today.

### What the user sees

- **Move dialog** (single thread and batch). Under the agent line from Part 3d, one quiet line per thing that comes along, in the server's words:
  - "Its goal carries on there." or "Its goal arrives paused."
  - "Its agent sets its 2 check-backs again there."
  - "Auto-fix for pull request #212 arrives off, for you to turn on there."
  - "2 queued messages are sent there."
  - "The plan waits for you there."
  - General Chats: "Lands in General chats on Windows PC · 14 files". The branch and "Staged changes arrive as unstaged changes" lines don't show.
- **Warnings**, same place, when something won't work as it did:
  - "GitHub isn't signed in on Windows PC. Sign in there before you turn auto-fix on."
  - "Codex on Windows PC can't set check-backs. It's told once what was planned."
  - Claude with a working goal: "It's working toward its goal. Move when it's done waits until it gets there."
- **The batch dialog and the quit dialog** (Part 3c) stop greying these threads out. Working General Chats threads are listed with the project threads.
- **On the other computer**, the "Moved here from Mac" line lists what arrived ("its goal · 2 queued messages · pull request #212") and, on a second line, anything that didn't, or waits for the user there ("Auto-fix was on for pull request #212 on Mac. It's off here until you turn it on." "Its agent can't use other threads, rooms or schedules here until you send it a message."). A notice above the message box says the same about the switches, with Turn on.
- **The arrival message.** When the agent has to be told something (a goal to carry on with, check-backs to set again), the first message on the other computer is one Threadlines wrote. It shows as a quiet system-written row, like the "Continue where you left off." row after a restart, not as something the user typed.
- **On this computer**, the read-only copy shows no queue, no armed switches and no goal controls. If the move didn't happen: "The move to Windows PC didn't happen. Your goal and check-backs are back on here."

### Capabilities

- **`PeerDescriptor.moveThreadState`** (new, optional): the computer takes goal, check-backs, pull request switches, queued messages and plans in a manifest, and runs arrival. **`PeerDescriptor.moveGeneralChats`** (new, optional): it takes a thread with no git checkout. Two flags so the General Chats work can ship on its own.
- An older computer decodes a manifest by dropping fields it doesn't know (no `onExcessProperty: "error"` on any peer path), so new fields sent to it would vanish without a word. They are never sent: without the flag, the thread is refused with today's words.
- **The decider can't see links**, so the answer travels on the command. `thread.move.queue` and `thread.move.start` gain `targetTakes?: { threadState?: true, generalChats?: true }`, filled by `ThreadMoves` from the descriptor it just read. A pending move keeps it (`pendingMove.targetTakes`), and every later check uses it: `threadMoveRefusals(view, thread, takes)`. Absent means "takes nothing": today's refusals.
- **A target that is offline when the move is queued** is assumed to take everything. The queue asks it before it stops anything (below), and `decideMoveStart` gets the real answer on its command.
- **Per-target refusal.** In the preview, `ThreadMovePreview.refusal` is computed as if the target took everything. A target without the flag gets its own `refusal` (an existing field): "Update Threadlines on Windows PC to move this thread: it has a goal." No new refusal code: `refusalCode` is never extended.
- **`ServerEnvironment.threadMoveState`** (new, optional) tells clients this server moves these threads, so they offer Move on General Chats threads and list them in the batch dialog.
- **`PeerAgent` gains `threadGoals?: boolean` and `checkBacks?: boolean`**, so the dialog's lines are right for the agent picked.

### Shared pieces

Four pieces serve all six items. Build them first.

**1. One pure description of what a thread carries: `threadMoveCarry(view, thread)`** (`apps/server/src/orchestration/threadMoveCarry.ts`). It returns what the thread has of (a) to (f), and which capability each needs. Three callers: `threadMoveRefusals` (to decide refused or not), the preview (the dialog's lines), and the export (what to pack). One function, so the three can't disagree.

**2. What the stop takes: `interrupted`.** Ending the agent's session for a move pauses a Codex goal (`pauseActiveThreadGoalForStop`) and kills every check-back that isn't saved to disk (the adapter reports them ended, and ingestion clears the list). By the time the thread is exported they are gone from the projection. So the decision that plans the stop records them first:

- `interrupted?: { goalActive?: true, checkBacks?: OrchestrationCheckBack[] }`, optional on `ThreadPendingMove` and on `OrchestrationThreadMove`.
- Written by the same decisions that plan `thread.session-stop-requested`: `thread.move-queued` in `stop-now` mode, `thread.move-quiescing`, `thread.move-mode-set` to `stop-now`, and a direct `thread.move-started` whose session isn't stopped yet. `thread.move-started` from a queue copies the pending move's.
- Kept for the life of the request, and only ever added to: a move that goes back to waiting after its stop (a turn slipped in) must not forget the goal was working.
- `goalActive` is `thread.goal?.status === "active"` at that decision. The decider needs no knowledge of the provider.
- `thread.goal.state.set` joins `FROZEN_THREAD_COMMANDS`. Today a direct move freezes the thread in the same decision as its stop, so the pause Codex reports is refused and the projection says `active` while Codex says `paused`. If that move is then dropped, the goal bar is wrong.

**3. Arrival, on the computer the thread lands on.** `thread.import` creates the thread with its state in one decision (per item, below). What needs the agent is sent as ordinary messages, never by setting provider state on a cold thread. The reason is Part 3d: a moved thread's agent gets its conversation (a carried session, or the summary) only through a message send, and that send is also where a carried session that fails falls back and tries again. A goal set by RPC, or a turn the provider starts itself, would run without the conversation.

- **The arrival message.** When `interrupted` has a working goal or check-backs, `thread.import` puts one server-written message at the head of the thread's queue, ahead of the user's carried messages. Built by `moves/arrivalMessage.ts`:

  ```
  This thread moved from Mac to Windows PC, and your session was restarted for it.
  - Your goal is still on: <objective>. Carry on with it.
  - Your check-backs ended with the move. Run CronList, then set again the ones you still need:
    - at 14:32 today: <prompt>
    - every 5 minutes (*/5 * * * *): <prompt>
  ```

  Marked `afterMove: true`, a new optional field on `OrchestrationQueuedFollowUp`, `OrchestrationMessage` and the `thread.message-sent` payload. Not a new `MessageTrigger`: that is a closed list older clients decode. An older client shows the row as a user message.

- **One kick, owned by `LinkMoves`.** Queued entries written by an import carry `imported: true` on `thread.follow-up-queued`, and `processFollowUpQueued` ignores those. Otherwise each event would try to send, and nothing would send after a crash (the reactor drains nothing at startup). After the import lands, `LinkMoves` dispatches `thread.follow-up.send-queued` for the head of the queue, with a command id derived from `K`, then records the stage `arrived`. Startup redoes it for any committed row not yet `arrived`. Once the first turn ends, the ordinary drain sends the rest.
- **The goal reaches the provider after the conversation does.** One rule in `ProviderCommandReactor`, for a thread with `movedFrom`: when a send is accepted and the projected goal is `active` but the provider holds no goal for that session (Codex `thread/goal/get`; Claude's folded goal), the reactor gives it: objective, what is left of the budget, `active`. It needs no marker, so it survives a restart, and it runs again by itself if a carried session falls back to a fresh one.
- **Capped as every import is.** The arrival turn and the queued messages run with the runtime mode capped at `link_max_runtime_mode`.

**4. Put back, on the computer the thread stays on.** When a move ends without moving and `interrupted` is set (`thread.move-queue-ended` with `cancelled` or `blocked`, or `thread.move-aborted`), `MoveQueue` puts the thread back as it was:

- a goal that was working and now reads `paused`: `thread.goal.set { status: "active" }`;
- check-backs: the same server-written message, with "The move to Windows PC didn't happen" as its first line;
- queued messages: one drain kick, since nothing else sends them once the turn has ended.

Not for `gone` (the thread was archived or deleted). To make this rare, the queue asks the target what it takes **before** the barrier whenever the thread carries something, and ends the move as blocked there instead of stopping the agent first.

### (a) Goals

**Decision: carry.** Lifted when the target takes thread state. A `complete` goal already moved; now its record comes along too.

- **While the move waits.** No new wait code (`ThreadMoveWaitCode` is closed). A Claude goal keeps its turn running until it is met, so "Move when it's done" waits for the goal; the dialog says so and "Stop and move now" is the way to move it sooner. A Codex goal works in separate turns, so the move goes at the next turn end and the goal carries on there. `thread.goal.set` stays refused while a move waits, as today.
- **Manifest:** `thread.state.goal { objective, status, tokenBudget, tokensUsed, timeUsedSeconds, createdAt, updatedAt, checks?, lastCheck?, pickUp }`. `status` is the projected one on the frozen thread; `pickUp` is `interrupted.goalActive`.
- **Import:** `thread.import.goal`, written as `thread.goal-state-set` in the same decision.
  - `pickUp` → `active`, plus the arrival message.
  - Otherwise `active`, `paused` and `usageLimited` → `paused`. The provider here doesn't hold it, and a continue-at-reset wait is not carried.
  - `blocked`, `budgetLimited` and `complete` arrive as they are: they need an edit, and editing sets the goal whole.
  - The agent picked here can't keep goals (`threadGoals` not supported): no goal is written, and the arrival line quotes it.
- **Resume, by hand.** Today a status-only resume fails on Claude (the adapter refuses a set without an objective), and would do nothing useful on a Codex session that never had the goal. `processGoalSetRequested` changes:
  - a resume with no objective, on a session whose provider holds no goal, sends the projected objective and the remaining budget with it;
  - on a moved thread whose conversation is still owed, it doesn't call the provider at all: it records the goal as `active` and queues the arrival message, and the rule in "Arrival" gives the goal once that message is accepted.
- **Budget.** The provider counts from zero again, so it is given `max(1, tokenBudget - tokensUsed)`. The goal bar shows what is left.
- **Per driver.** Codex and Claude support goals. Every other driver: not carried, named in the arrival line.
- **Risks.**
  - Whether a carried Claude transcript resumed as a fork re-arms its goal is unverified. The design doesn't depend on it: if it does, the provider holds the goal and nothing is set; if not, the reactor sets it.
  - Claude's `/goal` sent while a turn runs cuts that turn short. On the summary path that cuts the arrival turn right after it delivered the conversation, which is wasteful but correct. Check the adapter's late-goal path (`lateGoalCommands`) before building, and prefer it if it waits for the turn.
  - Whether Codex takes `thread/goal/set` during a running turn: read the Codex source. If it refuses, give the goal when that turn ends.
  - A Codex goal set to `active` starts work by itself. That is the point, and it is why the goal is given only after a send.

### (b) Check-backs

**Decision: set up again on the other computer, by the agent.** Only Claude has them (`ScheduleWakeup`, `CronCreate`). Nothing can create one without a model turn, and a check-back is a model turn waiting to happen, so the arrival turn is the honest way to bring it.

- **What's recorded.** The projected check-back has only a clipped description and the schedule in words. `OrchestrationCheckBack` gains optional `prompt` (clipped at 2 000 characters) and `cron`; the Claude adapter already holds both. A carried session's agent knows what it scheduled from its own transcript; these fields make the message complete for the summary case.
- **At the stop.** The decision records the list in `interrupted.checkBacks`. The session stop then ends them here, as it does today for any stop. The note ingestion writes reads "Check-back ended: this thread is moving to Windows PC" while a move is under way.
- **Manifest:** `thread.state.checkBacks [{ scheduledFor, recurring, exact, schedule?, cron?, description?, prompt?, durable }]`.
- **Import:** they are not written to the thread's `checkBacks`: that list mirrors the provider, which has none yet. They go into the arrival message, and the list fills in when the agent sets them and its next turn ends.
- **A different agent there.** One that can't set check-backs still gets the message, without the "set again" line, so it acts once on what was planned. The dialog warns.
- **Saved to disk (`durable`).** Treated the same (Will's call 3). The message says "Run CronList" first, so if Claude restores a saved one in the new folder by itself, the agent doesn't set it twice. Claude's saved copy stays in this computer's folder, where Threadlines can't remove it.
- **The words today are wrong.** "Cancel it first" can't be done for a saved check-back (the decider refuses, since stopping the runtime doesn't remove it). Against an older target, where the refusal stays, a thread whose check-backs are all saved reads: "Claude saved this thread's check-back to disk. Ask the agent to delete it, then move."
- **Risks.**
  - The agent may not set them again. The message is explicit, and the user sees the list refill or not. A check-back is never guaranteed anyway (the runtime can be reaped).
  - A time that passed during the move: the message says "was due at 14:32", and the agent decides.
  - Where Claude keeps saved ones (`.claude/scheduled_tasks.json`, folder unverified), and whether another Claude session in this computer's folder would later run the copy left here: check live. If it would, the dialog gains one calm line.

### (c) Pull request auto-fix and auto-merge

**Decision: carry the links, not the switches; stop them here at the freeze.** (Changed by the security review, below: this section first carried the switches on.) GitHub-side auto-merge (`gh pr merge --auto`) lives on GitHub and needs nothing.

- **Here.** `PullRequestAutomationWatcher` skips any thread with `pendingMove` or `move`: no look, no baseline step, no turn, no merge. Today it knows nothing of moves. Its merge is a direct `gh` call that no command guard sees, so an armed frozen thread would still merge from this computer. A turn refused by the move guard also still steps the baseline, which would swallow a failure. `decideMoveComplete` turns the switches off on the read-only copy (`thread.pull-request-automation-changed`). A dropped move leaves them on, and the watcher picks up where its baseline was.
- **Manifest:** `thread.state.pullRequests { autoFix, autoMerge, linked: [{ number, url, autoFix, autoMerge }] }`, and `git.upstreamBranch?` (the branch on the project's remote that this branch tracks).
- **Import:** `thread.pull-request-linked` for each, every switch off. What was on goes to `movedFrom.pullRequestSwitches`; the thread's notice and the arrival line offer it, and Turn on sends the normal `thread.pull-request-automation.set` from the user's client, once per pull request. Any switch set there clears the offer (`clearsMovedSwitches` on `thread.pull-request-automation-changed`). The watcher sees a switch turned on while it runs, so it treats what is failing now as news. Its turn cap starts again.
- **The branch keeps its upstream.** The import creates the branch with no upstream today. The thread's own pull request is found by upstream name, else by local name, and the "wait for unpushed commits" guard before a merge compares against the upstream. A moved thread can arrive with commits that were never pushed. At the `worktree` stage, when `<remote>/<upstreamBranch>` exists after the fetch, the import sets `branch.<name>.remote` and `.merge`. For every move, not only armed ones.
- **No Turn on, with why,** when the branch had to be renamed (`<branch>-from-<computer>`): a plain push from it would not reach the pull request. Also when the upstream couldn't be set on an armed thread.
- **No GitHub sign-in there** (Will's call 2). Move anyway, and say so at both ends: "GitHub isn't signed in on this computer. Sign in before you turn them on."
- **Asking the target.** New `peer.move.readiness { canonicalKey } → { gitHubReady?: boolean }`, called by the preview only for a thread with armed switches and a target with `moveThreadState`. It runs the probe behind `server.discoverSourceControl`. Not on `peer.describe`: every preview would pay for a `gh` call.
- **Risks.**
  - Whether `remoteStatus` reports unpushed commits with no upstream is unverified. If it reports none, auto-merge could merge a pull request that lacks the thread's local commits. Setting the upstream closes it. Test it with a real repo.
  - A restart there before the first look baselines quietly, as any restart does.

### (d) General Chats threads

**Decision: carry the chat and its folder.** A general chat has no project to match (every computer has `project-general-chats`), no git, no branch and no checkpoints. Its files are whatever the agent wrote into `<stateDir>/general-chats/threads/<threadId>`.

- **Manifest.** `PeerMoveManifest` becomes a union: today's shape, and a second with `workspace: "scratch"`, `project: { title }` and no `git`. An older computer can't decode the second, and is never sent one (`moveGeneralChats`).
- **Export** (`moveExport.ts`, a second path beside the git one): every file under the thread's folder, with Part 3's untracked-file rules (regular files keep their executable bit, symlinks go as their text, anything else refuses the move). No bundle, no diff. The same before-and-after listing check (path, size, mtime), with one retry. A folder that was never made is zero files.
- **Size** (Will's call 4). No `.gitignore` says what to skip, so everything goes, under the move's existing limits (100 MB, 20 000 files). Over that: "This chat's folder is 240 MB. Moves take up to 100 MB."
- **Preview.** `targetPreviewOf` skips the project match for a general chat. Today it would mark every target `no_project`, and the app would offer to set a project up. The target is fine when it has the flag; `projectName` is "General chats". `ThreadMovePreview` gains `folder?: { files, bytes }` in place of `changes`.
- **Import** (`LinkMoves`): the git stages (`fetched`, `worktree`, `applied`) don't run. Instead:
  - **`folder`**: the path is `generalChatThreadScratchCwd(root, linkMoveThreadId(K))` (`orchestration/generalChats.ts`), saved in the row first, then made with an exclusive mkdir. One that exists and isn't empty stops the move.
  - **`applied`**: each file through `writeReceivedFile` (the same path rules and exclusive create).
  - **commit**: attachments, the agent's session with that folder as its cwd (`carrySession` returns false today when `worktreePath` is null), then `thread.import` into `GENERAL_CHATS_PROJECT_ID` with `branch` and `worktreePath` null.
- **Clean-up needs its own proof.** Part 3's proof reads the worktree's `.git` file. Here: the path equals the one derived from this row's `K`, and no thread with that id exists (checked under the transfer lock, as abort already checks for a landed import). Only a session start for that thread could have made the folder otherwise, and that needs the thread. A crashed `applied` empties the folder under the same proof and writes again.
- **The shared-folder wait.** `checkoutOf` returns the project's root for a thread with no worktree, so every general chat shares one "checkout" and any busy one would make all the others wait. For a general-chat project it returns the thread's own folder (`resolveThreadProviderCwd` already knows it).
- **Left here:** the folder stays with the read-only copy, as a worktree does.
- **Risks.** Claude's session carry writes under `projects/<slug of the folder>`. That is expected to work with the new folder's path, but it is inferred, so test it.

### (e) Queued messages

**Decision: carry the user's own; keep refusing the others.**

- **Which.** An entry with none of `fromAgent`, `fromThread`, `fromOutside`, `scheduledTaskId` is the user's. The others answer to something on this computer: a scheduled run waiting for its turn, an outside assistant waiting for a reply, another thread. Those keep a `blocked` refusal, with words that name whose message it is.
- **While the move waits.** The queue must not drain here, or the thread never becomes free. That is why queued messages are refused today. `thread.follow-up.send-queued` joins the pending-move guard, and the reactor's two drains (`processFollowUpQueued`, `maybeSendNextQueuedFollowUp`) skip a thread with `pendingMove` or `move`. Edit and Remove still work while it waits. A cancelled or blocked move gets a drain kick (Put back).
- **Manifest:** `thread.state.queuedFollowUps [{ messageId, text, attachments, skills?, composer?, sentFrom?, interactionMode, createdAt }]`. Their attachments are packed as `attachment` parts. Today only history messages' attachments are packed and remapped.
- **Import:** `thread.follow-up-queued` (`imported: true`) for each, in order, behind the arrival message when there is one. Message ids and attachment ids are remapped as messages' are. Each entry runs on the agent picked for the move, with the thread's capped runtime mode: a per-message model names an agent on the computer it left, so it is dropped. `overtakes` is dropped.
- **Sent on arrival**, after the arrival message if there is one. The user queued them to run next, and "next" is now there. "Stop and move now" sends them too: the user asked to move, not to stop working.
- **Here.** `decideMoveComplete` removes them from the read-only copy. Otherwise they would sit on a thread that can't unqueue.
- **Risks.**
  - The first queued message is the first send on a carried session. Part 3d's fall back and one resend cover it as they cover a typed message.
  - A skill named in a queued message that the other computer lacks: check what a send does with one. If it fails the send, drop the reference at import and say so in the arrival line.

### (f) A plan waiting

**Decision: carry the thread's plans.** Today they vanish from a moved thread's history: the timeline draws plan cards from `proposedPlans[]`, which no move carries.

- **Not a block, not a wait.** A waiting plan is waiting for the user, who can answer on either computer. `childHasLiveWork` keeps counting it for families; the move check stops.
- **Manifest:** `thread.state.proposedPlans`: the newest 20, at most 1 MiB of markdown together.
- **Import:** `thread.proposed-plan-upserted` for each. Ids are rebuilt for the new thread, with turn ids remapped as messages' are. `implementationThreadId` becomes the new thread's id when it named the old one, else null. `implementedAt` and `dismissedAt` are kept.
- **Implement works there with no provider state.** The client sends the plan's markdown in the message, and the decider only checks that the plan exists on the thread. An imported thread has no latest turn, and the web's `actionableProposedPlan` already falls back to the newest plan then, so the card shows as ready.
- **Risks.** With a summary instead of a carried session, the agent doesn't remember proposing the plan. Implement sends the whole plan, so nothing is missing.

### Contracts

- **`peerRpc.ts`**
  - `PeerDescriptor.moveThreadState`, `.moveGeneralChats`;
  - `PeerAgent.threadGoals`, `.checkBacks`;
  - `PeerMoveManifest.thread.state?` as above, `git.upstreamBranch?`, and the `workspace: "scratch"` variant;
  - `peer.move.readiness`.
- **`orchestration.ts`**
  - `thread.import` gains `goal?`, `pullRequests?`, `queuedFollowUps?`, `proposedPlans?`, `arrival?: { message, brought: string[], left: string[] }`;
  - `interrupted?` on `ThreadPendingMove` and `OrchestrationThreadMove`; `targetTakes?` on `ThreadPendingMove` and on the queue and start commands;
  - `OrchestrationCheckBack.prompt?`, `.cron?`;
  - `afterMove?` on queued follow-ups and messages; `imported?` on the `thread.follow-up-queued` payload;
  - the `thread.moved-in` activity payload gains `brought?: string[]` and `left?: string[]`, plain words.
- **`moves.ts`**
  - `ThreadMovePreview.brings?: Array<{ words }>` and `.folder?`;
  - `ThreadMoveTargetPreview.notes?: Array<{ words }>`.
- **`environment.ts`**: `threadMoveState`.
- **Nothing closed is extended:** no new wait code, phase, outcome, trigger or refusal code. Every addition is an optional field, and every sentence a client shows is the server's.
- **Bounds** (`moveManifestRefusal`): `thread.state` at most 2 MiB encoded, 50 queued messages, 50 check-backs, 20 plans, 50 linked pull requests.
- **No migration rewrites rows.** `link_moves.stage` gains the values `folder` and `arrived` (a text column).

### Will's calls

Each has a default written into this plan, so the build can start. Changing one is small.

1. **Work starts on arrival.** Default: yes. A goal that was working, check-backs and queued messages make the other computer start a turn by itself when the thread lands (under Ask first, when its user allows the move). That spends that computer's usage with nobody watching, which is what a goal or a check-back already does. The other choice: everything arrives held, with one "Pick up here" button on the thread. It is the same build with the kick moved from `LinkMoves` to that button.
2. **Auto-fix, and the other computer has no GitHub sign-in.** Default: warn and move. Refusing would block a shutdown over something fixable later. (The switches arrive off now either way: Security changes, below.)
3. **Check-backs Claude saved to disk.** Default: bring them like the others, through the arrival message. The copy Claude saved stays in this computer's folder. The other choice: keep refusing those, with the honest words.
4. **General Chats files.** Default: every file in the chat's folder, up to 100 MB, refused above that with the size. The other choice: offer "move without its files".
5. **A live check on real agents.** Three facts decide details here and can't be read from our code: whether Claude re-arms a goal on a forked resume, where it keeps saved check-backs, and how Codex takes a goal set during a turn. Checking them needs a few real Claude and Codex turns. Without an OK the build follows this plan's safe side (set the goal when the provider holds none; "Run CronList" first) and the report says a real resume is unverified.

### Build order

1. **Shared pieces:** `threadMoveCarry`, `targetTakes`, the two capabilities, `interrupted`, the preview's `brings` and `notes`, the arrival line. No refusal lifted yet.
2. **(f) plans and (e) queued messages:** projection only, plus the drain fence and the kick.
3. **(c) pull requests:** the watcher's skip (a fix worth having on its own), the upstream, `peer.move.readiness`.
4. **(a) goals and (b) check-backs:** the arrival message, the goal rule, put back.
5. **(d) General Chats:** the scratch manifest, export and import path.

One PR is fine. Steps 3 and 5 can each be their own if the review gets long.

### Tests (focused)

- **Decider.**
  - Each of the six is refused without `targetTakes`, and allowed with it.
  - A queued message from a scheduled task still blocks.
  - `interrupted` is recorded by each stop decision, and survives a move going back to waiting.
  - `thread.goal.state.set` is accepted on a frozen thread.
  - `thread.import` writes the goal, pull requests, queue and plans in one decision.
  - `decideMoveComplete` clears the queue and turns the switches off.
- **MoveQueue and the reactor.**
  - The queue doesn't drain while a move waits, and drains after a cancel.
  - Put back resumes a Codex goal and queues the message after a cancel and after an abort.
  - A target without the flag ends the move as blocked before anything is stopped.
- **Arrival.**
  - An import with an arrival message and three queued messages starts exactly one turn, and the rest follow in order.
  - A crash between the import and the kick still sends.
  - The goal is given only after a send is accepted, and again after a carried session falls back.
- **Watcher.** An armed thread that is frozen or moved away is never looked at and never merged. One with a pending move doesn't step its baseline.
- **LinkMoves.**
  - A scratch manifest lands in General chats with its files.
  - Path rules hold, a folder that exists stops the move, and an abort removes only its own folder.
  - The upstream is set when the remote branch exists.
  - A renamed branch arrives with the switches off and the reason.
- **Web.** The dialog's lines and warnings; the batch dialog lists a goal thread and a General Chats thread as movable; the arrival row; the moved-in line's two lists.
- **Live**, on the two-server stack with the stand-in fx agent: a thread with queued messages and a waiting plan; a General Chats thread with files. Goals and check-backs need real Claude or Codex (call 5).

### Out of scope

- Families and rooms (step 4b).
- Queued messages from scheduled tasks, other threads and outside assistants.
- Carrying a continue-at-reset wait, or the watcher's baselines and turn counts.
- Checkpoints for General Chats (there are none).

### Review changes (Nov 17, outside review of this plan)

These win over the text above where they differ.

1. **The freeze fences PR actions already in flight.**
   - The watcher and the move share one in-process gate per thread (`ThreadActionGate`). The watcher holds it from the thread read through `runAction` (PullRequestAutomationWatcher.ts ~783-803), and re-reads `move` and `pendingMove` under it before acting.
   - The move's barrier (Part 3b) takes the gate before the freeze. That waits for an action under way, and no new one starts until the move ends.
   - After a restart the freeze is in the projection, so the watcher's own check is enough.
2. **Put back means what was running, not what reads paused.**
   - Restoring on a cancel or a dropped move works from the interruption record: was the goal working when the move stopped it. It doesn't look at the goal's current status.
   - A goal that was working is picked up again here by the same arrival-style turn the target would have run. That covers Claude, which can't pause a goal and leaves it reading active.
   - A goal the user had paused stays paused.
3. **What a move owes back is durable.**
   - The decision that ends a move without moving it (unqueue, queue-end, abort) records `moveRestoreOwed` on the thread: a new optional field holding the interruption record.
   - A reactor pays it (goal, check-backs, queued messages) and clears it with its own event, only once that succeeds.
   - Startup scans for threads that still owe it.
4. **A goal that finished stays finished.**
   - At export, a goal whose status is `complete`, or anything other than working or paused, is carried with `pickUp: false`, whatever the earlier interruption record says.
   - Teardown accepting an already-complete goal (ProviderService.ts ~2461) is the case this covers.
5. **A goal the target's agent can't hold arrives paused, with why.**
   - Today the one known case is a token budget going to Claude, which refuses any budget (ClaudeAdapter.ts ~6897). The goal lands paused, not dropped. The notice and the "Moved here" line say: "Its goal came paused: the agent here can't keep its token budget. Resume runs it without one."
   - Resume clears the budget explicitly, so nothing spends past the user's limit without them choosing it.
   - The preview names this before the move starts.
6. **No plan is dropped silently.**
   - Every proposed plan is carried, up to 100. Past that, the oldest stay behind, and the dialog and the "Moved here" line say "N older plans stayed on <source>".
   - The newest plan, the one with Implement, always comes.

### Security changes (Nov 17, PR #976 review)

These win over everything above in Part 3e. What a move carries came from another computer, so it gets no more trust than work that computer's agent starts here over the link.

1. **Pull request switches arrive off, every one.**
   - A switch acts with this computer's GitHub sign-in: auto-fix starts turns, auto-merge merges. The other computer can't turn one on here.
   - The linked pull requests still come along, so the thread's pull request rows show.
   - What was on rides in `ThreadMovedFrom.pullRequestSwitches`. The "Moved here" line says it ("Auto-fix was on for pull request #212 on Mac. It's off here until you turn it on."). So does a notice above the message box, with Turn on and a dismiss.
   - Turn on sends the normal `thread.pull-request-automation.set` from the user's client, one per pull request. Never from the peer.
   - Any switch the user sets here clears the offer (`clearsMovedSwitches`).
2. **A moved thread works behind the link fence until the user here takes it over.**
   - The import sets `ThreadMovedFrom.fenced`. A new optional field, not a new kind of thread.
   - Every place that fences a thread another computer's agent started (`remoteOrigin`) fences this one too, through one rule (`orchestration/linkFence.ts`):
     - the room and guide tools the reactor gives the agent;
     - the thread and room tool handlers' guard, `thread_read` and `thread_list` included;
     - the schedule tools;
     - continuing it on a schedule.
   - Work still picks up on arrival as the link's permission allows, fenced. Its mode stays capped by the link's access ceiling, as before.
   - **The fence lifts** when a message a person sent from the app starts a turn in the thread, directly or from the queue ("send when done"): `liftsMoveFence` on that `thread.turn-start-requested`, which clears `fenced` in every projection. A restart keeps whatever the projection holds. The rule is an allow-list (`turnLiftsMoveFence` in `linkFence.ts`): the message must carry `sentFrom`, which only this server stamps from the connection's sign-in, so nothing Threadlines writes can lift it by forgetting a marker.
   - **What doesn't lift it:** the arrival message (`afterMove`), queued messages the move carried (`imported` on the queued entry; the other computer's `sentFrom` on them is dropped at import), and anything Threadlines or an agent sends: command output, another thread, an outside assistant, a scheduled task, a restart or usage-limit resume, a retry, pull request auto-fix. A session that is no person's device gets no `sentFrom` and can't lift it either: a linked computer (`peer`), a CLI-issued token or a sign-in that looked like a script (`bot`), or one that said nothing about itself. A browser paired through the relay counts as a computer (`sessionDeviceKind` in `messageSentFrom.ts`).
   - A session started fenced is restarted with resume at the next start after the lift, so the agent gets its tools.
   - The "Moved here" line says it: "Its agent can't use other threads, rooms or schedules here until you send it a message."

## Part 3f: Families and rooms move too (Nov 17, v2 step 4b)

After step 4a, three kinds of thread still can't move: one that started other threads, one that was started by another thread or by another computer's agent, and one with more than one agent. That is most of the threads worth moving. A thread that ever started a child stays unmovable for good, because the finished child keeps it a parent, and a room is how two agents work on one thing. Step 4b lifts those refusals where a move can be honest and safe, and keeps the rest with words that say the real reason.

The transfer (Part 3), the queue and barrier (3b), batches (3c), session carry (3d), and what rides along and the arrival fence (3e) are unchanged in kind. Each thread still moves as its own transfer.

### What each case does

| The case                                                                | What happens                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A parent moves with its children                                        | **The family moves together** and arrives as a family: the children are still its children there.                                                                                                                  |
| A parent moves and some children stay                                   | **They become their own threads here**, each with a line saying why. The parent can't reach them from the other computer.                                                                                          |
| A parent has children on another computer                               | **They stay where they are.** The moved parent can't reach them. Named in the dialog and on arrival.                                                                                                               |
| A parent is waiting on answers from its children                        | "Move when it's done" waits for the answers. "Stop and move now" ends the waiting as Stop does, and says so.                                                                                                       |
| A child moves and its parent stays                                      | **It stays its parent's child**, as a thread on another computer: the parent can still send to it, read it and stop it over the link. There it is fenced for good, as any thread another computer's agent directs. |
| A thread another computer's agent started (or a child that moved there) | **It can move back to that computer, and nowhere else.** At home it becomes a local child of the thread that started it again.                                                                                     |
| A room                                                                  | **Carried with its agents.** Each agent is matched to one on the other computer. One that has no match stays behind, shown as having left, and the dialog says which.                                              |
| The project's lead chat                                                 | Still refused, with today's words: each computer keeps its own lead.                                                                                                                                               |

### Rules

These hold for every case below. The first four are the link fence, and a move must never loosen it.

1. **`remoteOrigin` is only ever written by the computer the thread is on, from the link it authenticated.** A manifest can ask for a thread to arrive as its sender's child. It can't supply the link, the environment, or anyone else's.
2. **A thread with `remoteOrigin` moves only to `remoteOrigin.environmentId`**, and only when that identity is pinned (`environmentPinned`). This is checked in the decider, not the dialog. There is no path from "an agent on A started work on B" to that work running on C.
3. **Every import arrives fenced** (`movedFrom.fenced`, Part 3e). Each thread of a family lifts its own fence with its own message from the user here. A message in the parent doesn't lift a child's.
4. **A peer can't attach a thread under one of this computer's threads.** Lineage is written in two cases only: both threads arrived in the same family from the same link, or this computer's own records already name the incoming thread as that parent's child (coming home).
5. **Never on two computers.** The reactors that act for a family (`ChildThreadReactor`, `RemoteChildReactor`) and the room's request chain stop for a thread with `pendingMove` or `move`, as the queue drain and the watcher do since 4a.
6. **Nothing closed is extended.** Waits reuse existing codes with their own words. No new phase, hold kind, outcome, watch event or peer status.

### What the user sees

- **Move dialog, on a parent.** "Its 3 threads move with it", with the list and a tick each. Unticking one says "Stays here as its own thread." Children on another computer are listed apart: "2 threads it started on Windows PC stay there. It can't reach them from Mac mini."
- **Move dialog, on a child.** Two choices: "Move just this thread" (default; "It stays a thread of <parent> on Mac, which can still send to it") and "Move its whole family (4 threads)".
- **Move dialog, on a room.** One row per agent: its name here, and a picker of the other computer's agents, preset to the same agent and model when there is one. The last choice is "Leave out". An agent with no match reads "Sol can't come: Windows PC has no Codex agent." Under each, Part 3d's memory line.
- **Batch and quit dialogs.** A family is one group: ticking any member ticks all of it, and it expands to untick members. A room is one row.
- **While it moves.** Each thread shows its own notice (Part 3b). A child that is ready before its parent reads "Moves to Windows PC with <parent>."
- **On the other computer.** Children are nested under the parent as here. The "Moved here" line names what stayed: "2 threads it started stayed on Mac: Fix tests, Review.", "Sol didn't come: this computer has no Codex agent." On a child that came alone: "Started by <parent> on Mac, which still directs it."
- **On this computer.** A child left behind: "Its parent thread moved to Windows PC, so this is its own thread now." A child that went alone shows under its parent as a thread on Windows PC, as any thread started there does.
- **A thread another computer started**, moving anywhere but home: "This thread was started by an agent on Mac, which still directs it. It can move back to Mac, not to another computer." When this computer has no link to Mac: "…Link this computer to Mac in Fleet first."

### Capabilities

- **`PeerDescriptor.moveFamilies`** and **`PeerDescriptor.moveRooms`** (new, optional). Without one, that kind of thread is refused with today's words, and nothing new is sent.
- **`targetTakes`** (Part 3e) gains `families?: true` and `rooms?: true`.
- No new client flag. The preview's new fields are optional, and an older client that sends none gets the server's defaults: the whole family, and the suggested agent for each room agent.

### (g) A thread that started threads

#### The family moves together

A family is a parent and its attached local children that aren't archived or deleted. It is one level deep by the existing rule.

- **How it's asked for.** `moves.queueMany` already takes a set of threads. The set decides: a parent and some of its children in one call are a family; a child without its parent moves alone (h); children left out stay behind. The single-thread dialog uses the same call when children are ticked. No new RPC.
- **`familyId`.** The server gives the family one id, recorded on each member's pending move and move as `family?: { id, parentThreadId? }` (`parentThreadId` on children only), and in the batch record. The parent is queued first; a child's queue decision checks that its parent holds a move with the same family id.
- **Each member is its own transfer**, with its own freeze, export and import. Nothing about one thread's move changes.
- **Ids that members can name before they exist.** Today every new id derives from the transfer key `K = hash(L, T)`. A family member's thread, turn and message ids derive from the family key `FK = hash(L, familyId)` and the id it had here. So a child's import can name its parent's new id, and the parent's history can name its children's, whichever arrives first. Rows, locks, staging folders, git refs, worktrees and attachments keep deriving from `K`.
- **The parent lands first.** On the other computer a child's import waits until its parent's has committed (`link_moves` gains `family_id` and `source_thread_id`, two nullable columns with an index). If the parent's move is dropped, the child's is dropped with "Its parent thread didn't move." The child's status to the sender stays `importing` while it waits. So no child ever sits there pointing at a parent that never came.
- **On this computer** (`MoveQueue`):
  - the parent's queued move ends without starting → the children's end too;
  - the parent's transfer is dropped → the children's are cancelled (none can have committed);
  - the parent moved and a child's move then fails → that child is left behind (below).
- **Import.** `thread.import` gains `lineage?: { parentThreadId, parentTurnId, attachedToParent: true }`, filled by `LinkMoves` from `FK`. `decideThreadImport` checks the parent exists, isn't deleted, isn't itself a child, is in the same project, and came in the same family. The attachment epoch starts fresh.
- **History keeps its labels.** `ThreadImportMessage` gains optional `fromThread`, kept only when it names a member of the family, with ids remapped by `FK`. Reports and requests between members keep "from <thread>". One that names a thread outside the family arrives as a plain message, as today.
- **Threads that shared a folder share one there.** Members are grouped by checkout (`checkoutOf`). In a group, the owner is the thread whose worktree it is (not a guest: no `worktreeOrigin`), else the parent, else the oldest. Only the owner exports the files. A sharer's manifest says `family.sharesCheckoutOf: <owner's id here>` and has no bundle, diff or file parts; its import skips the git stages, waits for the owner's, and takes the owner's worktree and branch. Clean-up never removes a worktree for a sharer. If the owner's move fails, the sharer's fails with "The thread whose folder it works in didn't move." Without this, each would get its own copy and they would drift apart.
- **The fence.** Parent and children each arrive fenced. Reports between them are `fromThread` messages, which don't lift it. After the user's message in the parent, `thread_list`, `thread_send` and `thread_stop` work on the children, which are found by `parentThreadId` as here.

#### Children that stay

A child that isn't in the set, or whose own move failed after the parent's committed.

- `decideMoveComplete` for the parent detaches each attached local child still here, in the same decision. These are the events `thread.parent-attachment.set { attached: false }` writes: the parent's open requests for it settle as cancelled, and its queued reports are taken back. An activity is added on the child with the line above.
- Why not keep them as the moved parent's children across the link: that needs a link from the other computer back to this one and its permission to direct threads here, which the move can't assume. Not in this step.
- Archived children stay attached to the read-only copy, as history.

#### Waiting on answers

`childRequests.open` holds requests whose answers are owed. Today any open request refuses the move.

- **"Move when it's done"** waits. A request to a child reuses the `background` wait code with the words "when the threads it started report back". A start or invite waiting for the user's OK (`awaiting_user`) reuses `approval`: "once you answer".
- **"Stop and move now"** ends the waiting the way the user's Stop does: the delivery epoch rises and the open requests settle as stopped, in the decision that plans the session stop. Children in the family are stopped by their own moves. The "Moved here" line says: "It was waiting on 2 threads it started. They were stopped for the move."
- No arrival message for this. The children arrive idle, like any thread stopped mid-turn, and a fenced parent couldn't send to them anyway.

#### Children on another computer

`childRequests.remoteChildren` lists threads this parent's agent started on linked computers. They stay listed after they finish, so today such a parent can never move.

- **They stay where they are, and the moved parent doesn't know them.** Taking them along would mean the new computer directing threads that the child's computer let _this_ computer start. That is the hop rule 2 forbids, so nothing is re-pointed or handed over.
- **Open remote requests:** "when done" waits for them as above. "Stop and move now" cancels them through the path Stop already uses (`cancelRequested`, `peer.request.cancel`, `peer.thread.stop`) and settles them here at once.
- **`RemoteChildReactor` learns about moves.** It reads only `id`, `title`, `participants`, `childRequests`, `archivedAt` and `deletedAt` today. It now skips a parent with `move` set for watches and for anything that writes to the parent. One exception: `thread.remote-cancels.delivered` joins `FROZEN_THREAD_COMMANDS`, so cancels owed at the freeze still drain.
- **A hole this closes.** On a frozen parent the reactor's four commands are refused. It reads a refused settle as "settled meanwhile" and acks the report as not delivered (RemoteChildReactor.ts ~609-619), so the answer is lost. No frozen parent can have remote children today, so it can't happen yet. Skipping frozen parents makes sure it never does.
- **Also when the child's computer is the target.** The parent arrives beside threads it once started there and stays separate from them. Adopting them would turn a thread that is fenced for good into one a message can unfence.

### (h) A child, and a thread another computer started

#### A child moves alone

The link the move travels over is the one a parent needs to direct a child on that computer. So the child keeps its parent.

- **Asked for** by moving a child without its parent (`family.remoteParent` on its pending move).
- **Manifest:** `family.remoteParent { threadId, title }`.
- **Import.** `LinkMoves` builds `remoteOrigin` itself: `linkDeviceId` from the transfer's row, `environmentId` and label from the link's pinned identity, `threadId` and `threadTitle` from the manifest. That is the same trust as a thread this link starts here, where the sender also names its own parent. `thread.import` gains `remoteOrigin?`. The thread also has `movedFrom`.
- **An unpinned link** can't prove where home is. The child arrives as its own thread, and both ends say so.
- **Fenced for good.** `remoteOrigin` fences it whatever the user there types, like every thread another computer's agent directs. It is stricter than a plain moved thread, and it is what keeps rule 2 simple.
- **On this computer.** `decideMoveComplete` for the child writes, in one decision, the parent's `remoteChildren` entry (as a remote start records one) and the detach of the read-only copy, so the parent doesn't count it as a local child. `RemoteChildReactor` picks it up from the parent's record. `thread_send`, `thread_read` and `thread_stop` then reach it through `peer.request.*`, which the other computer's `linkThread` accepts because the link matches.
- **Its parent is itself moving or moved:** it arrives as its own thread.

#### Moving back home

The only move a `remoteOrigin` thread makes. It covers a child that moved out, and a thread started over the link.

- **Decider.** `threadMoveRefusals` allows a `remoteOrigin` thread when `target.environmentId === remoteOrigin.environmentId`, `environmentPinned` is true and the target takes families. Any other target gets the words above. The `remote_origin` refusal stays for everything else.
- **Manifest:** `family.home { parentThreadId }`, from `remoteOrigin.threadId`.
- **Import at home.** The thread arrives over home's link from that computer. `LinkMoves` asks home's own records: does `parentThreadId` exist here, undeleted and not moving, with a `remoteChildren` entry for (the link's pinned environment, `manifest.source.threadId`)?
  - **Yes:** `thread.import` carries `adopt { parentThreadId }`. The decider checks the record again and, in one decision, creates the thread as that parent's attached local child, removes the `remoteChildren` entry (a new event, `thread.remote-child-removed`), and settles any request still open for it as cancelled.
  - **No** (the parent is gone, moved, or never held it): it arrives as its own thread, and the line says "The thread that started it isn't on this computer anymore."
- **No `remoteOrigin` at home**, only `movedFrom.fenced`. Home is where the permission to start it came from, so the user there may take it over with a message.
- **Where it left.** The request ledger's open rows for the thread settle as failed with "the thread moved to Mac", as an archive settles them.

### (i) Rooms

**Decision: carry the room with every agent that has a match.**

- **Who comes.** Every participant is carried as a record, those who left and guests included, so old messages keep their authors. Each one still in the room needs an agent on the other computer.
- **Matching.** New `suggestRoomAgent`: the same driver and model, else the same driver's default model, else none. Today's `suggestAgent` matches the model's name only, and looks at the thread's own agent only. The dialog shows the suggestion and lets the user pick any of the target's agents or "Leave out". A batch move, and a target that is offline when queued, take the suggestions when the move starts.
- **An agent with no match, or left out,** arrives as having left (`leftAt` = the move's time). Its messages keep its name, and the dialog and the "Moved here" line say why it didn't come. The room goes on with the others. This is Will's call 3.
- **Asked for:** `ThreadMoveQueueInput.roomAgents?: [{ participantId, agent: ModelSelection | null }]` (null leaves it out; absent takes the suggestion), kept on the pending move.
- **Manifest:** `thread.room { agentRole?, participants: [{ id, handle, role?, joinedAt, leftAt, guest?, source: { driver, model }, agent?, session? }] }`. Messages gain `participantId`, `fromAgent` and the request kind and outcome; activities, check-backs and queued messages keep `participantId`.
- **Import.**
  - Participant ids are rebuilt from `K` and remapped everywhere, the keys inside `agentModels` included.
  - `decideThreadImport` writes the participant events as `thread.create` with participants does.
  - `LinkMoves` checks each handle is free, and each chosen agent and model exists here (`resolveAgent`). At most 16 agents.
  - `sentModels`, `roomContext` and the request counters start empty.
- **Each agent's memory.** Part 3d, once per agent: `exportNativeSession` for each participant's session key, when the matched agent is the same driver. A `session` part gains optional `participantId`. All sessions share the move's 100 MB, 50 MB each. When they don't fit, the largest go as a summary first, and the dialog's line for that agent says so. A participant gains optional `nativeSession`, as the thread has for its own agent.
- **Each agent gets the conversation.** Today this would be wrong: in a room, a moved thread's first send gets only the join note (the last 8 messages) and skips the summary, for the thread's own agent and for the others. New rule in the reactor, for a thread with `movedFrom`: an agent that came with the move and has no `roomContext` cursor yet gets the whole conversation summary on its first send, unless it reopened its carried session. Then it is caught up only on what was said here. Derived from the projection, so it holds across restarts.
- **Requests between agents.** A room is free when `agentRequests.open` is empty.
  - **"Move when it's done"** waits for the chain to finish (reusing `side_turn`: "when its agents finish"). Agent hand-offs keep draining while the move waits. Only the user's own queued messages are held (Part 3e), and the request limit already bounds a chain.
  - **An invite waiting for the user:** "once you answer".
  - **"Stop and move now"** ends the chain as Stop does (`decideAgentChainStop`): requests settle as stopped and agents' queued messages are taken back. Today a move's stop skips this.
- **What rides along, per agent.**
  - The goal belongs to the agent holding the session slot, and check-backs name their agent. The arrival message (Part 3e) becomes one per agent that has something, addressed to it.
  - A queued message for an agent that didn't come arrives as a not-sent message, with a line saying so.
- **The fence** is per thread. No agent has room tools until the user's first message there, which lifts it for all of them.
- **Per driver.** Session carry is Claude, Codex and Pi, as in 3d. Every other agent gets the summary.

### Fixes this step needs in today's code

- **`sessionStopEvents` interrupts one side answer** (`thread.sideTurn`). A room can have three (`sideTurns`). Interrupt all of them.
- **Outside-work marks aren't carried** (`outsideWork`; moveExport.ts ~307 keeps only who wrote a message). An agent that outside text reached has limited tools until it starts fresh. With a carried session it arrives holding that text and without the limit, and the limit doesn't come back when the fence lifts. Carry the marks, remapped per agent. Check whether this is reachable after 4a for a single-agent thread. If it is, fix it there first.
- **`ChildThreadReactor`** has no move check beyond the lent checkout. A settle aimed at a frozen parent is refused and only logged. It skips threads with `move`, and its startup pass does too.

### Contracts

- **`peerRpc.ts`**
  - `PeerDescriptor.moveFamilies`, `.moveRooms`;
  - `PeerMoveManifest.family? { id?, parentThreadId?, sharesCheckoutOf?, remoteParent?, home? }` and `thread.room?`;
  - `PeerMovePart.participantId?`.
- **`orchestration.ts`**
  - `thread.import` gains `lineage?`, `remoteOrigin?`, `adopt?`, `participants?`, `agentRole?`;
  - `ThreadImportMessage` gains `fromThread?`, `participantId?`, `fromAgent?`, request kind and outcome;
  - `family?` and `roomAgents?` on `ThreadPendingMove` and `OrchestrationThreadMove`;
  - `families?`, `rooms?` on `targetTakes`;
  - `nativeSession?` on a participant;
  - new event `thread.remote-child-removed`.
- **`moves.ts`**
  - `ThreadMovePreview.family? { parent?, children: [{ threadId, title, refusal? }], remoteChildren: [{ label, title }] }`;
  - `ThreadMovePreview.room? { agents: [{ participantId, name }] }`;
  - `ThreadMoveTargetPreview.roomAgents? [{ participantId, suggestedAgent?, sessionOutcome? }]`;
  - `ThreadMoveQueueInput.roomAgents?`.
- **Migration:** `link_moves.family_id`, `.source_thread_id`. New nullable columns, no rows rewritten.
- **Bounds** (`moveManifestRefusal`): at most 16 participants; a family manifest names one parent or one home, never both.

### Will's calls

Each has a default in this plan.

1. **A child that moves alone.** Default: it stays its parent's child across the link, and so is fenced for good on the other computer. The other choice: it becomes its own thread there, which a message can unfence, and the parent loses it.
2. **Children left behind when the parent moves.** Default: they become their own threads here, with a line saying why. The other choice: refuse to move a parent unless every child comes.
3. **A room agent with no match on the other computer.** Default: the room moves without it, shown as having left, named before and after. The other choice: refuse until every agent has a match.
4. **Threads another computer's agent started.** Default: they may move back to that computer and nowhere else. The other choice: keep refusing them entirely. Simpler, but a child that moved out could then never come back.
5. **Children on another computer when the parent moves.** Default: they stay and the parent loses them, named. The other choice: refuse to move such a parent, which keeps most of today's refusal.
6. **Tools for a moved family.** Default: each thread needs its own message from the user to get its tools back. The other choice: a message in the parent also unfences the children that came with it. More convenient, and looser than the rule the security fix just set.

### Build order

Three PRs, each useful alone.

1. **Rooms** (`moveRooms`): participants, matching, per-agent sessions and history, the chain stop, the two reactor fixes. Nothing here touches families.
2. **Families together** (`moveFamilies`): the family id and `FK` ids, parent-first on the target, shared folders, children left behind, waiting on answers, children on another computer, the reactors' move checks.
3. **Across the link:** a child alone, and moving back home. Smallest, and the most security-sensitive, so it gets Sol's review on its own.

Each waits for the security scan before it merges.

### Tests (focused)

- **Decider.**
  - A `remoteOrigin` thread is refused for any target but its pinned home, and for an unpinned one.
  - A child's queue is refused unless its parent holds the same family id, or it moves alone to a target that takes families.
  - `thread.import` with `lineage` is refused when the parent is missing, deleted, itself a child or from another family.
  - `adopt` is refused when the parent holds no `remoteChildren` entry for that thread.
  - The parent's moved-away detaches the children still here, and settles its requests for them.
  - "Stop and move now" settles open child requests and open agent requests as stopped.
- **LinkMoves.**
  - A child staged before its parent imports after it; a dropped parent drops it.
  - A sharer takes the owner's worktree, and its abort removes nothing.
  - `remoteOrigin` is built from the link, whatever the manifest claims.
  - A manifest naming a local thread of this computer as its parent is refused.
  - Participants land with fresh ids, and an unknown instance is refused.
- **Reactors.**
  - `RemoteChildReactor` opens no watch for a moved-away parent, never acks a report for one, and still drains owed cancels.
  - A child that moved alone is reachable from its parent by `thread_send`, and its answer comes back.
  - A moved room's agent gets the whole summary once, and one on its carried session doesn't.
  - Every imported thread is fenced; a message in the parent leaves the child fenced.
- **Web.** The family list with ticks; the two choices on a child; the per-agent rows with "Leave out" and "can't come"; the family as one group in the batch dialog; the arrival lines.
- **Live**, two servers with the stand-in fx agent: a parent and two children, one sharing its folder; a child alone, then a send from its parent and its answer; that child moving home; a two-agent room with one agent that has no match.

### Out of scope

- Keeping children as the moved parent's children when they stay behind (needs the reverse link's permission).
- Handing a child on another computer over to the parent's new computer.
- Adopting threads already on the target when their parent arrives.
- Moving the lead chat.
- A message in the parent unfencing its children (call 6).

### Review changes (Nov 17, outside review of this plan)

These win over the text above where they differ.

1. **Sharers keep their guest marker.**
   - The import carries each sharer's `worktreeOrigin` guest marker, remapped to the family's new ids, so a sharer can never do a whole-workspace restore of a checkout it doesn't own (CheckpointRevert.ts ~116). That holds even after the owner is gone.
   - The manifest carries the marker, and the target re-derives it from the family's ownership map. It never trusts a raw path from the peer.
2. **A wait for the family holds no admission slot.**
   - A transfer that waits for another member (a parent's commit, a checkout's owner) moves to a new row state, `waiting_for_family`, with every byte staged.
   - That state counts against the staging budget (20 moves, 2 GiB per link) like an Allow wait, and holds none of the in-flight slots (2 per link, 4 total). The member it waits for can always get a slot.
3. **Checkouts first, then threads, so no cycle.**
   - A family's import runs in two phases.
     - **(a) Materialize every checkout the family uses.** Each checkout's owner transfer brings its files and makes the worktree, in any order, without waiting on any thread commit.
     - **(b) Commit threads parent-first.**
   - A sharer waits only for its checkout to be materialized, never for another thread's commit, so a parent working in its child's worktree can't deadlock.
   - The family key orders phase (b); phase (a) has no ordering.
4. **Waiting drains, quiescing stops.**
   - While a move is pending at stage `waiting`, the requests the thread already has keep settling: child answers (RemoteChildReactor, ChildThreadReactor), the room's request chain, and side turns already asked. "Move when it's done" needs them finished. Starting new work stays refused, as in Part 3b.
   - The room chain's sends of already-open requests are exempt from the waiting guard (threadMoveDecisions.ts ~435-437, ~493) during `waiting`. Not during `quiescing`.
   - The reactors stop for the thread only from `quiescing` on, and when frozen.
5. **An explicit family choice.**
   - `moves.queueMany` and `moves.queue` gain an optional `familySelection: "explicit"`.
   - Absent (older clients): a parent moves with its whole family, as promised.
   - Present: exactly the listed threads move, and the unlisted children stay behind under the rule above.
   - New clients always send it.

### Build notes for "across the link" (Nov 17)

Where the build differs from the text above, and why.

1. **Its own capability.** `PeerDescriptor.moveLinkLineage` and `targetTakes.linkLineage`, not `moveFamilies`: a computer that already takes families would read a lone child's manifest as a family member and wait for a parent that never comes.
2. **Its own manifest field.** `PeerMoveManifest.linkLineage { remoteParent? | home? }` (exactly one, never with `family`), not `family.remoteParent` / `family.home`: `PeerMoveFamily.id` stays required, and nothing in the family code path sees these moves.
3. **No new event.** "Moving back home" removes the parent's record with `thread.remote-child-updated` and a new optional `removed: true`, not a new `thread.remote-child-removed`: the event union is closed to clients that decode it. An older client keeps showing the record until it reloads.
4. **Nothing new on the pending move.** A child queued without a family, to a computer that takes `linkLineage`, is a child moving alone. The export names `remoteParent` only when the parent is here and not moving; the other computer's committed answer says whether it kept the parent (`PeerMoveState.keptParent`, read from the thread it wrote), and `thread.move.complete` carries that into the decision that writes the parent's record.
5. **The child's dialog.** "Move its whole family" queues the parent with no `familySelection` (the server's whole family). A computer without `linkLineage` disables "Move just this thread" with why (`ThreadMoveTargetPreview.aloneRefusal`).
6. **Moves that don't wait** (`moves.start`, older apps) never cross the link, for a child or a thread going home.
7. **A fenced thread goes only back where it came from** (review fix). A thread a move brought, still fenced (`movedFrom.fenced`), may move only to `movedFrom.environmentId` until a person here sends it a message, for every kind of move (single, batch, alone, family). Without this, a link-started thread that came home as a local child could move on to a third computer with nobody having taken it over.
8. **A parent and its child moving alone never cross** (review fix). A parent's move waits (`background`, "when '<child>' finishes moving") while a child of it has a move of its own queued or under way; the freeze decision checks it again. A child doesn't start moving alone while its parent's move is under way, nor queue while its parent's is queued. Otherwise the parent's move could leave behind a child that lands on the other computer as the parent's child.
9. **What a queued move holds isn't work in a shared folder** (review fix). A thread whose own move is queued holds its user's messages and its plan (the guard refuses them), so the shared-folder wait counts only what still runs there: everything that thread's own move would wait on (a turn and its approvals and questions, side answers, either background count, a command in the terminal, a workflow, a voice chat, the room's and the family's open requests), one list for both (`workWaits`), and while it waits (`waiting`) the room's and the family's messages that still drain. Otherwise a parent waiting for its child's own move, in the same folder, and the child waiting for the parent's held message, would wait on each other for good.
10. **A queued parent keeps its lone child** (review fix). The export names `remoteParent` whenever the parent is here and not frozen or moved away. A parent whose own move is queued waits for the child, so if it cancels the child is still its child there, and if it moves later the child is one of its threads on another computer, which stay, named.

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
- **Group by.** A client setting `sidebarGrouping: none | project | computer`, default `none`, picked behind the View button beside the project picker (InboxViewMenu), alongside the Computer and Show filters. The project picker itself holds projects only.
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
- **Launch.** Each `launching` row runs the staged `ThreadBootstrap` sequence (worktree, then the start that makes the thread with its first turn and claims its setup script; docs/design/thread-setup-state.md), with command ids derived from `(taskId, slotUtc, stage)`, and records `stage` after each step. "Once" means one launch per slot.
  - The run thread's first message carries a short preamble: the task name, and, where the run tool exists, "If there is nothing to report, call scheduled_run_finish with nothing_to_report".
- **Continue in a thread.** `thread.follow-up.submit` on the target thread, which steers or queues like any follow-up (decider.ts:331). The run records its `message_id`, and its turn is bound when that message's turn starts.
- **Startup reconcile.** `launching` rows resume from their stage. A started run whose turn was cut off by the restart becomes `interrupted`. A run whose turn ended becomes `finished`.
- **Missed runs.** At startup, and when a tick sees a gap over 90 s (sleep), every task with missed slots in the last 7 days gets one catch-up run for the most recent missed slot (`catch_up: true`). The older slots are recorded as one `skipped` row: "the computer was off or asleep".
- **Upkeep wakes (macOS).** A sleeping Mac wakes for a few seconds at a time to sync and back up (a dark wake: screen and sound off), and macOS puts it back to sleep whatever a power assertion asks, so a run started then crawls along a few seconds per wake. While `pmset -g systemstate` lists no Graphics capability (`power/Layers/SystemWake.ts`), the tick leaves due slots unclaimed and launches unresumed, event tasks still check each event (signature, age, the cap of 20 waiting) but park the ones that came on their own as waiting instead of starting them, and continuing at a usage reset waits too. Checking them keeps a stream of deliveries during upkeep wakes from piling up unchecked. The first tick once the Mac is fully awake claims the slot as a catch-up run; a waiting event still ages against its task's `maxLateMinutes`. What the user starts doesn't wait: a "Run now" launch, "Send a test event" with a run, "Run with this event" (those two go ahead of events that came on their own). One gap: a run row doesn't say which event started it, so a test event's launch that a restart cut off resumes with the automatic ones. A half-awake reading that lasts 10 minutes with no sleep between (the same `sysctl kern.sleeptime`) is not trusted, and work starts. Windows and Linux always count as fully awake.
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

  A task an agent creates runs on the agent's own model and reasoning unless `schedule_create` names an `agent`. A named agent's reasoning is settled when the task is proposed and saved in it, by the same rule as a thread an agent starts (child-threads.md, Reasoning): a level the agent names, else the one the user set for an agent in the room on that model, else the user's default for new threads on it. `schedule_list` shows each task's agent and reasoning.

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
- **Inbox.** Run threads are ordinary inbox threads, with a clock glyph after the project name on their top line (the run's title is the task's name); the hover card says "Scheduled · <task>".
- **Keep awake.** A desktop setting, "Keep this computer awake for scheduled tasks" (default off). Electron's `powerSaveBlocker` `prevent-app-suspension` holds while this computer has an active task that isn't manual.

## Part 7: Startup label (#38)

`starting` alone isn't enough. The decider sets it on every turn whose session isn't `running`, including warm `ready` sessions (decider.ts:2179-2215), and the reactor then reuses the live runtime (ProviderCommandReactor.ts:1373-1383).

- **Launch signal.** The reactor's one start path, `startProviderSession` (ProviderCommandReactor.ts:1162-1195), runs only when a session is actually started or restarted. There it records `thread.session-set` with a new optional `startupPhase: "launching"` and the instance id. The phase clears on `session.started` or an error. This covers every driver, ACP included, from one place.
- **Working row.** It says "Starting <instance display name>" during `launching` and "Preparing turn" otherwise. For a thread on another computer: "Starting Codex on Mac mini".
- **30 s notice.** It names the phase: "Codex is taking a while to start", or the current "Preparing this turn is taking longer than usual."
- **Tests:** a cold first turn, a warm turn (no launching), a resume after restart, and a provider switch.

## Part 8: Set up a project on another computer (Oct 22)

Will asked for it after Move shipped: moving a thread fails with "<computer> doesn't have this project" until that computer has a copy. This part makes that copy in one step: the other computer clones the project from its git remote and gets the ignored files the user ticks (`.env` and the like). T3 Code shipped the same idea as "Add to another machine" (t3code #22180); the rules below take its later fixes (#22492, #23170, #22780, #14781) and avoid its open bugs (#22383 copy lost on a late reconnect, #22539 binary files, #23694 cleanup deleting a `.git` it didn't make, #16560 unborn branch, #22180 empty-folder identity cached).

### Shape

The app does it, not the link. The app is already connected to both computers as the user (the same rule as creating a link, R4.2), so:

- **Source computer (A)** answers two reads: what to clone (remotes, sub-folder, scripts, title) and the bytes of the ignored files the user ticked.
- **Target computer (B)** runs the whole job on its own from one start call: clone, extra remotes, submodules, write the files, add the project. The files travel inside the start call, so the app can close right after Start (T3 holds them in the browser until the clone ends; a late reconnect loses them).
- No `peer.*` methods and no link needed: it works for any two computers this app is connected to, linked or not. No "Ask first": the user is acting on B through their own session there.
- Files travel only when both of the app's connections are protected: end to end encrypted (a relay v2 connection, Noise KK, over the relay or its direct route), `wss://`, or loopback. A computer added by a plain `ws://` address can still be set up, but its file list is off with the reason ("This app reaches Test PC over an unencrypted address, so files can't be sent. Connect it with a code to send them."). Large frames are chunked by the transport (`relayChunking`); the feature's own caps are below.
- The app must be connected to B. Move can name a linked computer the app isn't connected to; there "Set it up there" says "Connect to Test PC in this app first" and opens its Fleet page.

### Contracts (`packages/contracts/src/projectSetup.ts`, schema-only)

- Capability `projectSetup` on `ExecutionEnvironmentCapabilities`. The app offers only computers that report it.
- `projects.setupSource({ projectId })` on A:
  - `title`, `repositoryKey` (the project's `RepositoryIdentity.canonicalKey`), `subdirectory` (the project's folder relative to the repository root, `""` at the root), `scripts` (`ProjectScript[]`).
  - `remotes: { name, url, protocol: "ssh" | "https" | "other" }[]` and `primaryRemoteName`, picked by the identity resolver's own rule (origin, then upstream, then the first by name), so B's copy resolves to the same `canonicalKey`. URLs lose any `user:token@` before they leave A; B's own credential helpers sign it in.
  - `homeRelativePath`: the repository root relative to A's home folder, or null outside it.
  - `files: { path, size, suggested, tooLarge }[]` plus `filesTruncated`: ignored files only (`git ls-files --others --ignored --exclude-standard --directory --no-empty-directory -z`, 10 s timeout), regular files by `lstat` (symlinks and folders git ignores whole, like `node_modules/`, are left out), at most 500. `suggested` = basename `.env`, `.env.*`, `.envrc` or `.dev.vars`. `tooLarge` = over 1 MiB.
  - Refuses: a general chat, a project with no git remote ("It has no git remote, so another computer has nothing to clone it from"), a repository with no commits.
- `projects.setupReadFiles({ projectId, paths })` on A: base64 bytes and the file mode for each path. Each path is checked again: relative, inside the repository root after `realpath`, not under `.git/`, a regular file, ignored by git (`git check-ignore`), at most 1 MiB; at most 8 MiB in all.
- On B:
  - `projectSetups.start(input)`: `setupId` (made by the app, so a retried call is the same job), `source: { environmentId, projectId, label }`, `title`, `repositoryKey`, `remotes`, `primaryRemoteName`, `protocol` (the user's choice for the primary remote), `subdirectory`, `scripts`, `destinationPath`, `files: { path, contentBase64, mode }[]`. Answers with the job.
  - `projectSetups.inspectDestination({ path, repositoryKey })`: `{ resolvedPath, state: "missing" | "empty" | "same-repository" | "other-repository" | "not-empty" | "not-a-folder" }`, so the dialog can say what will happen before Start.
  - `projectSetups.cancel({ setupId })`, `projectSetups.dismiss({ setupId })`.
  - `projectSetups.subscribe`: a snapshot of the jobs, then each change.
  - The job: `setupId`, `source`, `title`, `destinationPath`, `repositoryKey`, `subdirectory`, `protocol`, `filePaths` (the ticked paths, for Retry), `stage` (`cloning` | `submodules` | `copying` | `publishing` | `adding` | `done` | `failed` | `cancelled`), `progress` (`{ phase, percent, detail, stalled }` from git's stderr), `projectId` once added, `error`, `warnings` (plain sentences), timestamps.

### B: `ProjectSetupService` (`apps/server/src/projectSetup/`)

- **A project here is (repository, folder in it).** B "has" A's project when a live project of B's resolves to the same `repositoryKey` and the same `subdirectory`. When B has the repository but not that folder (a monorepo's other app), the job adds the folder from B's existing copy and clones nothing.
- **Admission**, under one lock: refuse when B already has the project, when another unfinished job has this repository or this folder, or when the folder is `not-empty`, `not-a-folder` or `other-repository`. `same-repository` (adopt) needs both the key and the folder's primary remote URL to match one of A's remotes, protocol aside: keys drop ports, so a key alone doesn't prove it's the same repository.
- **Record first.** A row in `project_setups` (migration 084) before any disk change. It keeps every non-secret part of the request so Retry works after a reload: the source computer and project ids, the chosen remote URL and protocol, the remotes, title, subfolder, scripts, the ticked file paths, and the folder. It also keeps the `projectId` and command ids it will use (made at admission), the staging folder's path, the stage, error and warnings. File bytes stay in memory only: they are secrets and never touch the database.
- **Stage, then publish.** Everything happens in a staging folder beside the destination, `.<name>.setup-<setupId8>`, made with an exclusive `mkdir` (it fails if anything is there) after the row is written, holding the job's mark (`.threadlines-setup`, its setup id) and the copy (`copy/`). Cleanup deletes that folder only when it is at that name, is a real folder and carries this job's mark, so the job only ever deletes a folder it made itself:
  1. clone into `copy/`;
  2. the extra remotes, submodules and files;
  3. check the project's folder (`subdirectory`) exists on the cloned branch ("apps/web isn't on main on github.com/org/repo yet" fails the job otherwise);
  4. **publish:** rename `copy/` to the destination (an empty destination folder is removed first, only while still empty), then drop the staging folder. The rename is the commit point: from here nothing is ever deleted.
  5. `project.create` with the recorded `projectId` and command id, then `project.meta.update` with the scripts.
     Steps 4 and 5 run as one uninterruptible piece: a cancel or shutdown that lands there waits for the job to finish, so a published copy always ends with its project. A start runs under the admission lock, uninterruptible too, so two starts with one id are one job and a dropped connection can't leave a row without its worker.
- **The repository already here.** When this computer has another folder of the repository as a project, a start uses that copy whatever folder it named, and adds the new folder from it.
- **Clone:** `git clone --progress --origin origin -- <url> <staging>` with `GIT_TERMINAL_PROMPT=0`, run by its own process runner (not `GitCore.execute`, which has a 30 s deadline, splits progress only on newlines and keeps the output): no overall deadline, every stderr chunk counts as activity, progress parsed on `\r` and `\n`, the last 16 KiB kept for the error. 20 s without output sets `stalled`; 15 minutes without output fails the job ("Stopped receiving anything from github.com for 15 minutes.").
- **Sign-in fallback:** when the primary URL is refused for credentials (publickey refused, HTTPS authentication failed; _not_ a host key mismatch, which is a trust failure and fails the job), retry once over the other protocol when the URL converts, and say so in `warnings`. Both refused: the plain reason plus what to do on B ("Sign in to GitHub on Test PC, then Retry").
- **Remotes.** The primary remote is cloned as `origin`; A's other remotes are added under their own names (`origin` collisions skipped), so B's resolver picks the same URL A's did.
- **Submodules.** With `.gitmodules`: `git submodule update --init --recursive`. A failure is a warning.
- **Files.** B checks the request on its own before admission: at most 500 files, 1 MiB each and 8 MiB in all after decoding, valid base64, a mode of 0o600, 0o644 or 0o755, and each path through the receive rule Move uses (`receivedPathRefusal`, moved out of LinkMoves.ts into `apps/server/src/fs/receivedFiles.ts`, gaining Windows reserved names). Writing (`writeReceivedFile`, shared with Move) makes parents one at a time, refusing a symlinked parent, and opens with `wx` and the mode, so nothing is overwritten. In a staging folder nothing else writes; in an adopted copy B's own files win and a warning names each one kept.
- **Partial success** is success with warnings: a file that couldn't be written or submodules that failed still end "ready", and the dialog lists them.
- **Cancel** interrupts git and deletes the staging folder. A published job can't be cancelled.
- **Restart.** At startup, an unfinished job is reconciled: before publish it ends failed ("Stopped when Test PC restarted. Retry starts it again.") and its staging folder is deleted; after publish it carries on (create the project with the recorded id if it isn't there, apply the scripts) and ends done, with a warning if its files hadn't all been written.
- **Finished jobs** stay listed until dismissed or 24 hours old.

### A: `ProjectSetupSource` (`apps/server/src/projectSetup/`)

The two reads above, with the git commands behind the `GitCore` service (operation names `ProjectSetupSource.*`). File reads open with `O_NOFOLLOW` and check the opened file is a regular file before reading it.

- **Identity hardening** (`packages/shared/src/git.ts`): `normalizeGitRemoteUrl` drops any `user:password@` in every form (today a one-segment path like `https://alice:token@host/repo.git` falls through with its token, which then reaches `peer.describe` and the plan's `repositoryKey`), and treats any `user@host:path` scp form like `git@host:path`. Only unusual URLs change key.

### The app

- **Targets** (`packages/client-runtime`): the connected computers that report `projectSetup` and have no live project with this `repositoryKey`. Offline and older computers are left out of pickers; the dialog's computer list shows them disabled with the reason.
- **Dialog** (`ProjectSetupDialog`, opened by `openProjectSetupDialog({ project, target?, then? })`, one host at the root):
  - Title "Set up <project> on another computer".
  - **Computer** picker (when more than one).
  - **Folder on <computer>**, a text field. Default: B's own `addProjectBaseDirectory` setting when set; else the folder most of B's projects share; else A's home-relative path on B's home (`~/badcode`); else `~/<name>`. Under it, one line from `inspectDestination`: "A new folder", "An empty folder", "Test PC already has a copy here. It will be added as is, keeping its own files.", or why it can't be used.
  - **Clone over** SSH or HTTPS, only when the URL converts; the source's protocol first.
  - **Files to copy**: the ignored files, suggested ones ticked and listed first, "Over 1 MB" rows disabled, All / None, and "Showing the first 500." when truncated. One line: "Sent encrypted to <computer>. Nothing else leaves this computer."
  - **Start** reads the ticked files from A, then calls `start` on B. The dialog then shows the job's progress ("Downloading · 45%", "Stalled", "Copying 2 files", "Adding the project") with Cancel, and "Keep going in the background" to close it.
  - The computer stays the one asked for (or first shown): if it drops out, the dialog says "<computer> isn't available right now. Pick another computer." rather than sending the files elsewhere. When that computer already has a copy of the repository, the folder is that copy, shown fixed ("<computer> already has this repository here. The project is added from it, keeping its own files."). The files are checked against both connections again right before they leave.
  - **Done:** "badcode is ready on Test PC" with "Start a thread there", and warnings listed. **Failed:** the reason, with Retry (reads the files again and starts a new job) and Close.
- **Watching** (`useProjectSetups`): the app subscribes on every connected computer that reports `projectSetup`. A job this app started that ends while its dialog is closed raises a toast (done: "Start a thread there"; failed: "Show", which reopens the dialog on it).
- **Entry points:**
  - The project's menu in the sidebar: "Set up on another computer…".
  - The command palette: "Set up project on another computer" for the open thread's project.
  - The composer's "Runs on <computer>" picker on a new thread: a "Set up on another computer…" item at its end. The picker shows whenever there is a target, not only when two computers already have the project. When the job finishes and that draft is still the one on screen, unsent and on the same project, the draft switches to the new copy (matched by repository, so "Separate" sidebar grouping works too, joining the copy's sidebar project), keeping its text.
  - Move: a target refused for lacking the project shows "Set it up there". `ThreadMoveTargetPreview` gains `refusalCode: "no_project"` so the dialog doesn't parse the sentence. When the job finishes, the Move dialog asks for a new preview and that computer becomes choosable; if that ask fails, the dialog says so with Check again. Previews describe each computer fresh (today a cached description up to 5 minutes old would still say "doesn't have this project").
  - A computer's Fleet page lists its unfinished and recent jobs with progress, Cancel and Dismiss (the way back out of a job started elsewhere).
- **Matching by folder too.** `PeerProject` gains `subdirectory`; Move's target lookup and a remote start's `projectForKey` match key and folder (`PeerStartInput.projectSubdirectory`), falling back to the key alone for a computer that doesn't report folders.
- **A moved thread gets its setup.** Move's import on B now runs the project's worktree setup script for the moved worktree, the way a new worktree thread does (`ProjectSetupScriptRunner.runForThread`), on every path that records the move committed (the import, the sweep, a late abort that finds it landed), before the record: a crash between them repeats the script rather than skipping it. That is how ignored files like `.env`, copied into B's main checkout by this feature, reach the moved thread's worktree, and how its dependencies get installed.
- **Agents.** A remote start refused for the missing project says "<computer> doesn't have this project. The user can set it up there from the project's menu." Agents can't start a setup.

### Tests

- Server, with real git and a bare repository as the remote: the copy's `canonicalKey` equals the source's; the extra remotes; credentials stripped from `setupSource`; ignored-file listing (symlink, folder, size, suggested); `setupReadFiles` refuses a tracked file, `..`, a symlink and `.git/`; `start` is idempotent by `setupId`; files keep their mode and never overwrite; adopting a same-repository folder; refusing a not-empty folder and a key B already has; cancel removes only a folder it made; a restart marks the job failed and cleans up; a `.git` that isn't the job's survives cleanup.
- The protocol fallback through a stubbed git failure, and the URL conversion as a pure function.
- Web browser: the dialog from the project menu (ticked files, default folder, the destination line), Start sends the files to B and shows progress to done; Move's "Set it up there".

### Live

Two test servers on this Mac (the release test homes A and B): set up the scratch project from A on B with a `.env`, check B's project matches (Move's target becomes choosable), then move a thread to B end to end. Once more with the clone cancelled, and once with B restarted mid-clone.

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
