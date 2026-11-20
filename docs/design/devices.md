# Devices

A Device tab in the right panel shows a live iOS Simulator or Android Emulator
running on the thread's computer. The user taps, types and presses hardware
buttons on it; agents drive the same device through four `device_*` tools and
the `agent-device` command line. Ported from T3 Code's Device panel (MIT, see
NOTICE; their `docs/internals/devices.md` is the reference for the parts kept
as they are).

## Scope

In:

- iOS Simulators (macOS with Xcode) and Android Emulators (Android SDK) on the
  machine that runs the Threadlines server. A Mac linked in Fleet shows its
  devices to whichever computer opens a thread there.
- The Device tab: device picker (start, stop), the live screen with touch,
  keyboard and paste, a toolbar (Home, app switcher, Back and Recents on
  Android, rotate, screenshot, power off), and a Tools drawer (appearance, text
  size, accessibility toggles, location, permissions, open URL, launch and quit
  app, shake, test push, network on Android) that reads every value back.
- Agent access: `device_list`, `device_open`, `device_screenshot`,
  `device_close`, plus `agent-device` on the agent's PATH. An agent opening a
  device brings up the Device tab for anyone watching that thread.
- Settings → Devices: "Use devices" and "Agents can use devices", tool versions
  with an update button. App guide place and topic.
- Works in the desktop app, the web app, the phone layout and on saved
  computers over the relay.

Out, on purpose:

- Expo cloud simulators (billed per minute), Simlock pools (alpha service),
  SSH device hosts. Linking the Mac in Fleet covers the SSH case.
- T3's 3D device models. They are Apple's AR assets with no redistribution
  license, so a public repo cannot ship them. Our frames are drawn in code
  (see "Round 2").
- WebRTC streaming (only Expo cloud needs it).

### Round 2: matching and passing T3's panel

Added after the first build, before merging (the developer asked for T3's
polish or better, the newest models, and T3's extras):

- **Model-accurate frames, drawn by us.** A shape profile per device family
  (T3's `shapeProfile.ts` is the reference for screen sizes and corner radii;
  the simulator's own reported screen size wins): the body outline, the screen
  corner radius that matches the hardware, side buttons, and the Dynamic
  Island, notch or punch hole drawn over the stream where the hardware has one.
  SVG/CSS only, theme tokens only, flat (no shadows, no gloss). Unknown models
  fall back to the plain rounded frame.
- **iPhone Duo.** Both screens: the cover screen when closed, the inner screen
  when open, both in the book and tent stances where the hardware shows both.
  Hinge and stance controls beside the screen (closed, book, open, laptop,
  tent, table mode where available), the same messages T3's `duoControl.ts`
  sends. Touch and keys go to the screen in front. Uses serve-sim's
  `/helper/<id>/panel/{1,3}/stream.avcc`, already on the allowlist.
- **Android foldables.** Fold and unfold beside the screen through serve-emu's
  `/api/fold` (already allowed); the screen follows the reported posture.
- **Accessibility-frame overlay.** A toolbar toggle draws the element frames
  from `/helper/<id>/ax` (iOS) or serve-emu's `/api/accessibility` (Android)
  over the screen, with the element's label on hover. Read-only.
- **Several devices open at once.** Each open device is a chip in a row at the
  top of the Device tab (close, rename on double-click, "+" opens the picker).
  Only the visible one streams; switching keeps the others running.
- **Float the device over the chat.** A toolbar button moves the device into a
  small window over the chat that keeps streaming and taking touch while the
  right panel shows something else: drag by its handle, resize from an edge,
  "Open in right panel" brings it back. One floating device per thread.
- **Record a flow.** A record button: tap through the app, press stop, and the
  composer gets an unsent draft with a numbered step log (taps named from the
  accessibility tree, like `Tapped button "General"`, plus Home, rotate and
  Tools actions), a few key screenshots and a video of the screen made in the
  browser from the stream canvas. Capped at 3 minutes. Client only (T3's open
  PR pingdotgg/t3code#38735 is the reference).
- **Event log.** A section in the Tools drawer that lists serve-sim's recent
  device events (`/vendor/serve-sim/api/event-log/events`, allowed), iOS only.

Settled by the plan review (Astra, 6 findings):

- **Model identity.** Names lie (simulators get renamed) and screen sizes
  overlap across models, so `DeviceSummary` gains an optional `model`: the
  simulator's device type (`com.apple.CoreSimulator.SimDeviceType.iPhone-Duo`,
  from `simctl list devices -j`) or the emulator's hardware profile. Frames map
  from it, never from the name. Older servers omit it and get the plain frame.
  This is the one contract and server change in Round 2 (additive).
- **Duo input follows the active display.** The viewer keeps the helper's
  reported `screenId` and hinge fields, hit-tests a touch against the panel it
  landed on, and drops touches on the inactive surface, as T3 does. One input
  socket stays admitted across a handoff; when the active display changes the
  video reopens on the new panel. A helper that rejects fixed-panel video
  (400/404/405/410) falls back to the ordinary single screen with the Duo
  controls hidden, never a blank panel.
- **Recording fits the composer or is kept.** Drafts allow 8 attachments of 10
  MiB each. The recorder works to a byte budget (bitrate chosen so 3 minutes
  stays under 10 MiB, stopped early if it would not), adds at most as many
  screenshots as free slots allow, and skips screenshots when the thread's
  model takes no images. The step log and attachments are appended to the
  originating thread's existing draft; nothing already there is replaced. If
  attaching or saving the draft fails, the recording stays available to
  download from the Device tab with a one-line notice. Stop attaches; Discard
  throws it away.
- **One owner per recording.** A recording belongs to the device view it
  started in. Switching device, floating, docking, hiding the tab or closing
  the device stops it first and hands it off. Only visible views (the shown
  chip and a float) hold channels; hidden chips release theirs, which keeps a
  connection well under its 16 channels.
- **Agent opens keep today's behavior.** `device_open` opens the Device tab on
  that device for anyone viewing the thread; it never auto-floats.
- **Touch and reverse actions.** Rename is also in each chip's menu. The AX
  overlay has an inspect mode in which a tap shows the element's label instead
  of reaching the device. The float has a close button (the device keeps
  running; Power off stays separate). Everything new is hidden for servers
  without the `devices` capability.
- **Event log** reads `event-log/events?device=<id>` through the channel
  incrementally (never `EventSource`) and cancels when the drawer closes.

Every hub route Round 2 uses is already on the channel allowlist; the Duo's
hinge, stance and table mode travel as tagged messages on the allowed iOS input
socket.

## Architecture

```
web Device tab ──WS RPC──► DeviceService ──► DeviceHost (local)
   │  device.* RPCs            │                 ├─ expo-device-hub  (child, 127.0.0.1:<port>)
   │  deviceChannel.* stream ──┘ allowlist ─────►│     serve-sim (iOS) / serve-emu (Android)
   │                                             └─ agent-device daemon (child, only with agent access)
agent ──MCP device_*──► DeviceService
agent ──agent-device CLI (shim on PATH) ──► agent-device daemon
```

### Server owns devices

Devices belong to a machine, not to a window, so `apps/server/src/device/`
owns discovery, boot, shutdown, streaming and agent access, the way it owns
terminals. Ported from T3's `apps/server/src/device/` with the EAS, Simlock and
SSH hosts removed:

- `DeviceToolchain.ts`: installs `expo-device-hub` and `agent-device` at the
  versions in `deviceToolVersions.json` into `<stateDir>/tools/device/<name>/<version>`
  (staged, then published with a `.install-complete` marker), only after the
  matching consent: the hub on "Use devices", agent-device on "Agents can use
  devices". Reuse our pinned-npm installer (`provider/acpRegistry/AcpRegistryInstaller.ts`,
  `npmPinnedFlags`) and managed Node where they fit instead of copying T3's
  `npm install --prefix`. Install scripts stay on: the hub's native addons
  need them. npm and both tools run on Threadlines' managed Node.js
  (`<stateDir>/tools/node`, shared with community agents, leased while a tool
  runs), never `npx` and never the server's own runtime, which is Electron in
  the desktop app. Both tools load only N-API addons, so a later Node.js
  release runs an earlier install. Keeps the pinned version and the last
  other one, never one a running process was started from
  (`pruneDeviceTool`, in place of T3's `deviceToolMaintenance.ts`).
- `DeviceHost.ts`: the seam. One implementation, `LocalDeviceHost.ts`.
- `LocalDeviceHost.ts`: platform checks (macOS + `xcrun` for iOS; full Android
  SDK for Android), spawns the hub as a supervised child on a reserved loopback
  port with `--host 127.0.0.1`, restarts it with backoff, records
  `{pid, port, entryPath}` in `<stateDir>/device/hub.json` so the next server
  stops a hub this one left behind (checked by pid AND command line, never by
  name). The hub's own state file goes to `<stateDir>/device/hub-state`
  (`EXPO_DEVICE_HUB_STATE_DIR`), not the shared temp folder. The daemon
  records itself in `<stateDir>/device/agent-device/daemon.json`; a healthy
  daemon on the pinned version is reused, one on another pin is stopped
  through its own CLI and replaced.
- `DeviceHubOperations.ts`: list, boot, shutdown, screenshot through the hub.
- `DeviceService.ts`: state (`DeviceServiceState`), sessions per thread,
  open/close/shutdown, `revision` for subscribers, stop the hub and daemon on
  server shutdown.
- Claims survive a crash. `<stateDir>/device/claims.json` (atomic write)
  records each open `{threadId, deviceId, platform, agentSession,
  bootedByThreadlines, openedAt}` before it is reported open, and drops it on
  close. On startup the service reloads claims, releases the agent-device
  session of every claim whose thread was archived, deleted or moved while the
  server was down (sweep like `secrets/AgentSecretRequests.ts`), and keeps the
  rest. A reactor releases claims on `thread.archived`, `thread.move-started`
  and `thread.deleted`. Ending a session ends its agent-device session on the
  daemon (`close` over the daemon's RPC, which quits the app it opened and
  frees the device) and removes its launcher. Closing never shuts a simulator down unless asked
  (`shutdown: true` or the power button), the same as T3: a simulator the user
  booted is theirs. `bootedByThreadlines` is shown in the picker so the user
  can tell which ones Threadlines started.
- agent-device's daemon is started by its CLI, so the pid we spawn is the
  launcher's. It is stopped through the CLI's own stop command with our
  isolated state directory (T3's `LocalDeviceHost` daemon stop), never by pid
  guess or name.
- `DeviceActions.ts`: the Tools drawer. Runs `simctl`, `adb` and serve-sim's
  helper binaries directly, one typed action per control. Nothing here goes
  through the hub's exec route.
- `AgentDeviceShim.ts`, `AgentDeviceTarget.ts`: the agent-device launcher.

### The hub is never reachable from a client

serve-sim has a shell-exec route whose token is readable from its own
unauthenticated `/api`; serve-emu's action routes have no auth. So:

1. The hub binds 127.0.0.1 only.
2. **The hub runs with `--require-token`.** Every hub route except its health
   and ready checks then refuses requests without the session token (bearer,
   cookie or WS subprotocol; see `gateRequest`/`gatedSocket` in the hub's
   `dist/server/index.mjs`). The hub makes the token and prints it once in its
   startup line (`Local: http://localhost:<port>/?token=<token>`); the server
   reads it from the child's stdout, keeps it in memory only, and adds
   `Authorization: Bearer` on every request it makes. A test pins that line's
   format for the pinned version. This is what protects the hub from a second
   Threadlines server on the same Mac (desktop app plus a dev server), an
   older release, or anything else on loopback: a port denylist in one server
   cannot.
3. **`PreviewTunnel` refuses ports held by device tools** as well as its own:
   any listener whose process is the hub, a serve-sim/serve-emu helper or an
   agent-device daemon, found through the listening-port scan
   (`preview/parseListeningPorts.ts`, `LocalServers.ts`) by pid tree and by
   command line, so it also covers another server's tools. Refusing by name is
   fine here; killing by name is not. Checked live with 0.22.1: serve-sim's
   per-device helper runs inside the hub process and opens no port of its own;
   an emulator the hub boots is its child, so the pid tree covers its ports.
   The check runs where `pgrep`, `ps` and `lsof` exist (macOS, Linux); on
   Windows and in the slim Docker image, where no simulator runs, it is
   skipped (preview/deviceToolPorts.ts).
4. Clients reach the hub only through the device channel below, which allows
   T3's stream and read paths and drops cookies and auth headers. **Not
   `/vendor/serve-sim/api` or `/vendor/serve-emu/api`**: serve-sim's body
   carries the exec token. The viewer read them only to detect WebRTC-only
   hubs (Expo cloud), which we do not run, so the probe is removed.

Agents on the same machine can reach loopback anyway; they already have a
shell there, so this adds nothing they lack.

### Transport: the device channel over WS RPC

T3 proxies the hub over HTTP routes with cookies and WS tickets. Ours cannot:
saved computers and the relay carry only `/ws` and `/peer`, and a browser has
no cookie for another computer's origin. So every byte between the Device tab
and the hub rides the client's existing WS RPC connection, modeled on
`PreviewTunnel` (flow-controlled, base64 chunks, closed by unsubscribing):

- `deviceChannelOpen` (stream): `{channelId, kind: "http", method, path, query, body?}`
  or `{channelId, kind: "ws", path, query}`. The server checks the path against
  the allowlist, opens the request or socket to the hub, and streams
  `opened {status, contentType}` / `data {data}` (http body chunks) /
  `message {data, binary}` (ws messages) / `end`.
- `deviceChannelSend`: one ws message from the client, in order (`seq`).
- `deviceChannelCredit`: bytes delivered, so a stalled tab holds the hub up
  instead of filling server memory.

Flow control, so a suspended phone cannot pile up video in the server:

- Each `data`/`message` event carries at most 256 KiB before base64; a larger
  ws message is split into parts with `final: false` until the last.
- The server keeps at most 2 MiB sent but not credited per channel. For an
  http body it stops reading (the hub's socket backs up). For a ws upstream it
  pauses the socket; if 4 MiB more queue up anyway, the channel fails with
  `slow` and the client reopens.
- The client credits a chunk once the decoder has taken it, not on arrival:
  an http chunk when a body read hands it over, a ws message when its
  listeners return. Credits count decoded bytes (before base64; a text
  message's UTF-8 bytes) and go out in batches of 64 KiB or after 40 ms.
- A `message` event's `data` is base64 when `binary`, the text itself
  otherwise, the same as `deviceChannelSend`.
- Channels never resubscribe. On any failure or reconnect the client opens a
  fresh channel and a fresh decoder that waits for a keyframe, and drops input
  it had not sent. A pre-disconnect gesture never reaches the new session.

On the client, `packages/client-runtime/src/device/hubTransport.ts` turns the
channel into a `Response` with a `ReadableStream` body (`fetch`) and a
`WebSocket`-shaped object (`socket`). T3's stream client
(`client-runtime/src/device/stream.ts`) takes that transport instead of URLs,
so its AVCC/WebCodecs decoder, MJPEG fallback (fetched, painted to the canvas)
and Android SEMU socket port with small changes. One path for every client: no
special case for the desktop app.

Owner and paired clients may both use devices (same rule as terminals).

### Agents

- MCP server `threadlines_device` (like `McpCommandsServer.ts`), scope flag
  `device` on the credential, tools from T3's `toolkits/device/tools.ts` with
  their descriptions. `device_open` returns the quick start text and a bound
  launcher path; `device_screenshot` returns an image block.
- Session flag `ProviderSessionStartInput.deviceTools`, set in
  `ProviderCommandReactor` when `enableDevices && agentDeviceAccess`, never for
  a fenced thread (one another computer's agent or an outside agent started:
  device tools act on this machine). Like the other per-session flags, it
  applies to sessions started after the switch. Each tool call also checks
  that both settings are still on, so turning either off stops agents at
  once, not only in later sessions.
- **No PATH changes.** `device_open` writes a launcher bound to that thread's
  agent-device session at `<stateDir>/device/bin/<thread>/<device>/agent-device`
  (a device id with characters unsafe in a path is encoded there)
  and returns its absolute path; the quick start tells the agent to use that
  exact path. This works the same in every provider, including OpenCode, whose
  one server per instance would never see a PATH change made for a later
  session. T3's launcher logic (refused commands, connection check, naming a
  sandboxed shell versus a dead daemon) ports as is.
- Registered where the commands server is registered today: Codex
  (`codexAppServerArgs`), Claude (`ClaudeAdapter` mcpServers), ACP
  (`AcpAdapter`), Pi, Muse, OpenCode. ACP agents that do not advertise HTTP
  MCP get no device tools, the same as every other Threadlines tool today.
- Instructions: `provider/deviceInstructions.ts`, a short block like
  `previewPanelInstructions.ts`, sent only to sessions with `deviceTools`:
  use the device tools and `agent-device` for simulator UI work, `simctl`/`adb`
  stay fine for builds, installs and logs. Codex, Claude, OpenCode, Pi, Muse.
  ACP providers get it through tool descriptions only (their existing rule).
- An agent's `device_open` records its session with `openedBy: "agent"`. The
  web watches `subscribeDeviceState` and opens the Device tab on that device
  for anyone viewing the thread when such a session appears; no orchestration
  activity is written.

### Web

- Right-panel tab `device` (`rightPanelTabs.ts`, URL param `device=1`),
  available for project threads on every client whose server reports the
  `devices` capability (`ExecutionEnvironmentCapabilities.devices`; older
  servers hide the tab, the palette entry and the Devices settings). Command
  palette entry "Open device". No keybinding command: `KeybindingCommand` is
  a closed set that older clients and servers decode strictly, and the server
  writes every default into the user's keybindings file, so a new command
  breaks an older client's whole config (the same reason the lead chat
  dropped `navigate.leadChat`, #972). It can come back once keybinding
  decoding skips unknown commands.
- First open: setup steps (start the hub, platform check, agent access
  choice). Opening the tab alone downloads nothing.
- Device picker, the screen in a flat frame sized to the device's aspect,
  a toolbar above it (plain until hover: back to the picker, Home, app
  switcher, or Back and Recents on Android, rotate, screenshot, Tools, and a
  menu with Close and Power off), Tools drawer (`DeviceToolsPanel`, beside
  the screen when the panel is wide, over it when not), loading and error
  states that say what is missing ("Android SDK Command-line Tools are missing
  from …"). T3's accessibility-frame overlay and serve-sim event log are not
  ported; the foreground app comes from `deviceDetail`, not serve-sim's
  `/appstate` event stream.
- Only the visible device streams; switching tabs or threads stops the channel.
- Settings → Devices section with the two switches and tool versions.

### Settings

`ServerSettings.enableDevices` (default false) and
`ServerSettings.agentDeviceAccess` (default false), plus patch fields. Turning
"Use devices" off ends every device session and stops the hub and daemon;
simulators keep running. Turning "Agents can use devices" off stops the daemon
and makes the tools refuse at once; sessions started after do not get them.
Turning it on fetches agent-device in the background (nothing starts until an
agent asks), so the first `device_open` is quick.
Both get app guide places (`devices.enable`, `devices.agentAccess`, on the
`settings.devices` page, with the `device-tab` topic); agents may
propose turning on "Use devices" through `settings_change` but agent access is
user-only (`widensAgents`).

### Settled by the live test and the diff review

- The hub's device list leaves out simulators never booted; serve-sim's grid
  inventory adds them (T3's fix, pingdotgg/t3code#28915).
- iOS's app in front comes from the device's serve-sim helper
  (`/helper/<udid>/foreground`), asked every two seconds while Tools is open;
  `simctl` cannot report it and serve-sim's `/appstate` stream refuses a
  device it has not been told to watch.
- The preview tunnel also refuses the ports this server's own hub and daemon
  hold, recorded as the host starts and stops them, so the refusal holds on
  Windows and without `pgrep`, where the process scan cannot run.
- `device_open` never picks a physical phone by default; an agent gets one only
  by naming its id.
- A session whose close the daemon did not confirm stays claimed and open, so
  a second close or the next startup sweep retries it. An open that finishes
  after its thread was put away records nothing (a release count per thread).
- Turning a switch off publishes the new state before stopping anything, so
  the agent tools refuse from that moment.
- The state stream slides: a subscriber that stops reading keeps only the
  newest two snapshots.
- The iOS screenshot fallback writes through a temp file in
  `<stateDir>/device/tmp` (simctl writes `-` and `/dev/stdout` as files of that
  name), never the user's temp folder.
- Touch screens get a Keyboard button: it focuses a hidden field whose typing
  goes to the device. iOS takes keys, so text becomes US-layout key presses;
  characters no key types are skipped.

## Contracts

`packages/contracts/src/device.ts`: T3's device schemas without host configs
(`hostId` dropped everywhere: one host per server), the channel schemas, and
the MCP tool schemas. RPCs in their own `WsDeviceRpcGroup`:
`deviceList`, `deviceOpen`, `deviceClose`, `deviceShutdown`, `deviceDetail`,
`deviceAction`, `deviceUpdateTool`, `subscribeDeviceState` (stream),
`deviceChannelOpen` (stream), `deviceChannelSend`, `deviceChannelCredit`.

## Risks

- Both tools move fast (hub 0.19 → 0.25 in a month). Pinned; updated on purpose.
- serve-sim loads private CoreSimulator frameworks through a native addon. It
  runs as a child so a crash restarts the hub, not the server.
- iOS first agent tap builds an XCTest runner (minutes, once).
- Video over base64 WS RPC costs about a third more bytes than T3's raw HTTP.
  iOS AVCC at simulator bitrates is well inside that.
- WebCodecs needs a secure context (the desktop app, https, the relay,
  localhost). On a plain-http LAN address iOS falls back to MJPEG, and
  Android falls back to still frames from serve-emu's screenshot route at
  about 4 per second, with touch still live and a one-line note saying a
  secure connection gives full video.
