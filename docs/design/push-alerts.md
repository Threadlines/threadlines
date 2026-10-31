# Phone alerts

Oct 23 2026. Built on `feat/phone-notifications`. Plan reviewed by Sol before
the build (the review moved alert discovery onto the event log, put the phone's
endpoint and switches at the relay, and dropped the badge number).

## What the user gets

The installed app (iPhone Home Screen, Android, or a desktop browser using the
hosted app) can get an alert when an agent needs them, finishes, or fails, even
with Threadlines closed. Settings › General › Alerts has one switch to turn
alerts on for the device and three for which ones:

- **Needs you:** an approval, a question, a plan to review, or an agent asking
  to change a scheduled task.
- **Finished:** a turn or side answer ended with nothing left going.
- **Failed:** a turn ended with an error, couldn't start, was cut off by a
  restart, or a side answer failed.

A thread someone is looking at right now, on any device, stays quiet. Tapping
an alert opens its thread. The desktop app gets no alerts here (macOS
notifications are a later piece) but it does report what it's showing, so a
thread open on the Mac doesn't buzz the phone.

## Who holds what

- **The relay** holds the VAPID keys (`PUSH_VAPID_KEYS`, one per hosted
  channel plus retired ones) and, per computer's relay host, each paired
  phone's push endpoint and alert switches. Only the relay can send to a
  phone's subscription.
- **The phone** registers its endpoint and switches at each computer's relay
  host itself, with its own device secret (`PUT|DELETE
  /v2/hosts/{h}/devices/{d}/push`). A computer never learns the endpoint, so a
  computer that loses access can't move it anywhere. Switches live at the relay,
  so turning one off works while a computer is offline.
- **The computer** gets only the keys to seal alerts with (`push.register`,
  over the end-to-end channel, from the phone's own relay-device session), so
  the relay can't read or forge an alert's content.

`registrationId` is a hash of the subscription (endpoint, keys, VAPID key). Every
alert names the registration it was sealed for; the relay refuses one sealed for
a replaced subscription (`stale`) and forgets a subscription the push service
dropped (`gone`) only if it is still that one.

Removing a phone (revoking the device) deletes its push row at the relay and its
keys on the computer: no more alerts. Nothing can recall an alert a push service
already accepted.

## Finding alerts (server)

`apps/server/src/pushAlerts/`. Alerts come from the orchestration event log,
read from a saved cursor (`push_alert_cursor`) in the same transaction as the
alerts that reading produced, so a restart neither loses one nor sends one
twice. The live event stream only rings a bell. A first run starts at the newest
event: history never alerts. Events read more than 10 minutes late start
nothing.

`pushAlertRules.ts` maps events to alerts keyed by what they are about:
`approval:<requestId>`, `question:<requestId>`, `turn:<turnId>`,
`side:<sideTurnId>`, `start:<activityId>`, `schedule:<requestId>`. Cancels:
an answered request, a user-requested interrupt (rules out that turn), a child
result its parent took (`thread.child-request-settled`), the thread being seen,
wrapped, archived, deleted or moved away.

Right before sending, every alert is checked against the thread as it is then
(`getThreadDetailById`): the request still open; for a finished turn, no newer
turn and no work going (`childHasLiveWork`), and a plan left to review sends it
as needs-you instead; for a child's turn, its result not already handed back
to the parent (`handedBackTurnId`); nobody looking at it (presence leases, renewed every 30 s,
held 90 s, dropped on disconnect). Finished turns wait 8 s first, failures 3 s.

Each phone's alert is sealed (RFC 8291 aes128gcm) and handed to the relay
(`POST /v2/hosts/{h}/devices/{d}/alert`), with retries inside the alert's
lifetime (30 min for needs-you, 10 for the rest). Topic per thread, so an
undelivered alert for a thread is replaced by the next.

## Sending (relay)

`apps/relay-worker/src/v2/webPush.ts`, `RelayHost.handleAlert`. The relay sends
only while the phone is active, on that registration, wants that kind, and the
day's allowances hold: per device, per host, and relay-wide (the ledger). All
are charged before the send. Endpoints must be on a known push service; redirects
are not followed; bodies are capped. `THREADLINES_RELAY_PUSH_ENABLED=false`
stops every send.

## The app (web)

`apps/web/src/pushAlerts/` and `apps/web/public/push-sw.js`. The service worker
handles push and notification taps only, with no fetch handler: it never serves
or caches the app, so the live data and the version-skew check are unchanged.
Alerts use Declarative Web Push's shape (`web_push: 8030`), which iOS 18.4+
shows without the worker; elsewhere the worker shows the same. A tap opens the
thread in an open window (asked over `postMessage`, acknowledged) or a new one.

The app registers again with every paired computer on every launch and
connection (endpoints rotate). Turning alerts off deletes every relay row, tells
every computer, and unsubscribes.

## Not in this release

- A Home Screen badge number (no definition that holds across computers yet).
- macOS notifications from the desktop app.
- Alerts for computers added by address or SSH (no relay to send through).
- A computer on a different relay than the phone's first computer.
