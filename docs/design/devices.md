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
- T3's 3D device models, iPhone Duo and foldable posture views. The screen sits
  in a flat rounded frame drawn in CSS, which matches the design language and
  drops about 6,000 lines and a three.js dependency.
- WebRTC streaming (only Expo cloud needs it).

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
- The client credits a chunk once the decoder has taken it, not on arrival.
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

- Right-panel tab `device` (`rightPanelTabs.ts`), available for project
  threads on every client. Keybinding `device.toggle`, command palette entry
  "Open device".
- First open: setup steps (start the hub, platform check, agent access
  choice). Opening the tab alone downloads nothing.
- Device picker, the screen in a flat frame sized to the device's aspect,
  toolbar, Tools drawer (`DeviceToolsPanel`), loading and error states that say
  what is missing ("Android SDK Command-line Tools are missing from …").
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
Both get app guide places (`devices.enable`, `devices.agentAccess`); agents may
propose turning on "Use devices" through `settings_change` but agent access is
user-only (`widensAgents`).

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
