# Antigravity sign-in methods: build plan (2026-10-04)

Piece 3 of the four Will approved on 2026-10-04 (see `agent-setup-plan.md`).
Pieces 1 (#381) and 2 (#387, extra accounts) are merged. Per-use billing for
these methods was approved by Will on 2026-10-04.

## What Will approved (mockup)

- Antigravity's Account tab gets a **Sign-in method** choice with four rows:
  Google account ("Uses your Google AI plan", Plan), Gemini Enterprise ("Your
  company's Gemini plan, through Google Cloud", Plan), Gemini API key ("Pay for
  what you use. Get a key in Google AI Studio", Per use), Vertex AI ("Pay for
  what you use, billed to a Google Cloud project", Per use).
- Only the picked method's fields show. Enterprise: Google Cloud project and
  location, then a work Google sign-in. API key: the key, with "Get a key in
  Google AI Studio". Vertex: project, location and an optional express key;
  without a key it uses the Google Cloud sign-in on the computer.
- Picking a different method shows Cancel and "Switch to <method>" (Enterprise:
  "Switch and sign in"); the current one is marked and keeps its own actions.
- Keys are saved as secrets on the computer running Threadlines and never
  shown again (the last four characters only). Will, 2026-10-04: store them
  like every other Threadlines secret today (a private file only the user can
  read, never in settings, never sent back to the app) and say exactly that;
  encrypting all secrets with the OS keychain is its own follow-up PR.
- Per-use methods say up front that Google bills the requests and that they
  won't appear on the Usage page.
- Setup keeps "Sign in with Google" on Antigravity's row, plus an "Other ways"
  link to the same choice. Works with extra accounts: each account picks its
  own method.

## Verified (Antigravity 1.3.0, copied runtime, throwaway profile)

- `initialize` advertises `oauth-personal`, `oauth-business`, `gemini-api-key`,
  `agent-platform` (the last is "Gemini Enterprise Agent Platform, formerly
  Vertex AI, with Application Default Credentials or an API key").
- `authenticate("gemini-api-key")` with a fake `GEMINI_API_KEY` succeeds at
  once, records `{"auth":{"type":"gemini-api-key"}}` in
  `<GEMINI_HOME>/antigravity-acp/settings.json`, and `session/new` succeeds with
  a model list. The key is only tested by the first prompt.
- Enterprise and Agent Platform read `gcp.project` / `gcp.location` from that
  settings file (or `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION`).
  Enterprise refuses without them. Agent Platform without a key uses
  Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`, else the
  gcloud ADC file under `HOME`).
- T3 Code (same lineage, shipping this) passes the Agent Platform key as
  `GOOGLE_API_KEY` and the Gemini key as `GEMINI_API_KEY`, strips every ambient
  Google variable, and writes `auth.type` plus `gcp` into the settings file on
  every launch. Their key lives in plain-text settings; ours won't.

## Design

### Settings

`AntigravitySettings` gains `authMethod` (`oauth-personal` default,
`oauth-business`, `gemini-api-key`, `agent-platform`), `gcpProject` and
`gcpLocation` (trimmed strings, default empty). All three are hidden from the
generic Configuration form: the Account tab owns them. The legacy patch schema
gets the same keys.

Keys are sensitive instance environment variables under reserved names:
`GEMINI_API_KEY` (Gemini API key method) and `GOOGLE_API_KEY` (Agent Platform
express key). Sensitive values already go to the server's secret store and
reach clients redacted. The generic environment editor treats both names as
reserved (as it does Claude's token). Keeping one name per method means
switching between them never feeds one method's key to the other.

### Process environment and profile

- `antigravityEnvironment` keeps stripping every ambient Google variable, then
  adds only the selected method's credential: `GEMINI_API_KEY` for
  `gemini-api-key`, `GOOGLE_API_KEY` for `agent-platform` with a key. For
  `agent-platform` without a key, a server-level
  `GOOGLE_APPLICATION_CREDENTIALS` passes through (that is the user's ADC);
  nothing else does.
- Before every agent process (sessions, probes' discovery, sign-in), the
  profile's `antigravity-acp/settings.json` is merged, not replaced: `auth.type`
  set to the method, `gcp.project` / `gcp.location` set or removed. Other keys
  the agent wrote stay. Atomic write.
- Sessions for the two key methods pass `authMethodId` so each process
  authenticates without a browser. The two OAuth methods keep today's behaviour
  (the saved token, no interactive authenticate at session start).
- Changing the method or its fields rebuilds the instance (settings change),
  which stops its sessions, as any instance edit does today.

### Status (probe), per method

| Method            | Signed in when                                           | Account line                                   |
| ----------------- | -------------------------------------------------------- | ---------------------------------------------- |
| Google account    | token file present (today)                               | "Google account"                               |
| Gemini Enterprise | project + location set and token file present            | "Gemini Enterprise · <project>"                |
| Gemini API key    | key set                                                  | "Gemini API key ••••7Qx2 · per use"            |
| Vertex AI         | key set, or project + location set and an ADC file found | "Vertex AI · <project> · <location> · per use" |

A missing piece is a warning naming it ("Add a Google Cloud project and
location", "Add a Gemini API key", "Sign in to Google Cloud on this computer:
gcloud auth application-default login"). The masked key is computed on the
server, which has the secret; clients never see more than four characters. The
OAuth token file is left alone on switching away, so switching back to Google
account needs no new sign-in.

### Flows

- `login` follows the method: `oauth-personal` and `oauth-business` run
  today's browser sign-in with that method id (Enterprise only once project
  and location are saved). `gemini-api-key` runs a key check: one free
  `GET generativelanguage.googleapis.com/v1beta/models?pageSize=1` with
  `x-goog-api-key`, reporting "Key works" or Google's reason. `agent-platform`
  checks what can be checked without spending: fields present, ADC file present
  when there is no key. Its first real request is the final test, and the row
  says so.
- `logout` for OAuth methods is unchanged. For key methods, "Remove key" clears
  the secret (a settings write).

### UI

- Account tab, Antigravity only: "Sign-in method" list above today's sign-in
  section, flat rows (name, one-line description, "Plan" / "Per use"), the
  current one marked. Picking another shows its fields plus Cancel and
  "Switch to <method>" / "Switch and sign in". Switching saves the settings
  (method, project, location, key) in one write, then starts `login` for the
  new method on the row.
- The current method's actions: Google account and Enterprise keep Sign in
  again / Sign out; key methods show "Replace key" and "Remove key".
- Per-use note under the fields for the two per-use methods.
- Setup's Connect step: Antigravity's row gets an "Other ways" link that opens
  Settings › Providers on that instance's Account tab.

## Surfaces checklist

- Contracts: settings fields + patch keys.
- Server: profile settings merge, environment, descriptor `authMethodId`,
  probe per method, auth flows per method, key check, reserved env names.
- Web: method chooser in the card's Account tab, reserved env names, setup
  "Other ways" link, Usage note.
- Extra accounts: per instance; nothing account-specific beyond that.
- Docs: new `docs/providers/antigravity.md` (user guide: methods, billing,
  keys, ADC, extra accounts).
- Reverse states: switching back to Google account works without re-login;
  "Remove key"; per-method sign-out.

## Tests

- Server: settings merge keeps foreign keys and removes `gcp` when empty;
  environment carries only the selected credential (ambient Google variables
  stripped, ADC passthrough only for keyless Agent Platform); probe status
  matrix; key check against a fake HTTP server; descriptor `authMethodId` per
  method.
- Web: method chooser logic (fields per method, switch label, per-use note);
  browser test: switching to Gemini API key saves the method and a sensitive
  key in one write and starts the check.
- Live (throwaway stack): switch methods and back; API-key path with a real key
  needs Will.

## Review dispositions (GPT-6.1-Sol, 2026-10-04)

All ten findings checked; all accepted.

1. Secrets are 0600 files, not encrypted: Will chose honest wording now and an
   OS-keychain store for all secrets as a follow-up (above).
2. Reserved names enforced server-side: `GEMINI_API_KEY` / `GOOGLE_API_KEY` on
   an Antigravity instance are always stored and returned as sensitive,
   whatever the client sends (case-insensitive).
3. Credentials are passed to the launcher explicitly from the instance's own
   environment list, never read back out of the merged environment; ambient
   keys can't stand in for a missing instance key. ADC inputs
   (`GOOGLE_APPLICATION_CREDENTIALS`, `CLOUDSDK_CONFIG`) come from the server
   environment and pass only for keyless Agent Platform.
4. The profile's `settings.json` is written when the instance is built (no
   agent process of the new configuration exists yet) and by the auth flows
   after they drain, not on every launch. It is merged, preserving the agent's
   other keys.
5. Switching: the client stops any sign-in run, saves, waits until the
   instance's snapshot reports the new method, then starts `login` (the
   pending-install pattern from piece 1).
6. Secret writes vs the settings commit: new secrets are written before the
   commit, stale ones deleted only after it succeeds (applies to every
   sensitive variable, including account removal).
7. The model catalog cache records the method, project, location and a hash of
   the credential; a mismatch is ignored and rediscovered.
8. Configured vs verified: the last check result per credential hash is kept in
   the profile. A rejected key shows as an error until the key changes; a
   never-checked key shows as configured. The OAuth token must be non-empty
   JSON. The Gemini check is described as "Google accepted this key", not as
   proof of model access.
9. One ADC resolver mirrors the agent's environment: an explicit
   `GOOGLE_APPLICATION_CREDENTIALS` must exist and parse (no fallback past it),
   else `CLOUDSDK_CONFIG`, else `%APPDATA%\gcloud` on Windows or
   `~/.config/gcloud` elsewhere.
10. One method-aware action table drives the Account tab, the collapsed row,
    setup and composer notices: keyless Vertex gets "Check again" and field
    edits, not key actions; the current method's fields can be saved; method
    labels show without an email; ADC copy names the computer that runs
    Threadlines.

## Diff review dispositions (GPT-6.1-Sol, 2026-10-04)

All five findings checked against the code; all fixed.

1. A failed write of the profile's `settings.json` now fails the instance build
   (it would otherwise run the old method or project and bill the wrong one).
2. Switching awaits the server ending any sign-in run on the instance
   (`stopAnyRun`) before saving. Stopping a run now also tells every panel
   watching it (an `idle` status), so an old method's failure doesn't linger.
3. `builtFrom` compares the whole environment list as well as the sign-in
   fingerprint, so an ADC path change also waits for the rebuild.
4. No marker file: the saved token names the OAuth client that issued it
   (Google account and Gemini Enterprise use different clients in 1.3.0, and
   only a Google account's token carries the Code Assist scope).
5. Check results and the model cache are written with `Effect.tryPromise`, so
   a full disk is ignored instead of becoming a defect that strands the run.

Live check (throwaway home, copied 1.3.0 runtime): Gemini API key with a fake
key (stored as a 0600 secret, not in settings; Google's free check rejected it;
row offers Replace key), Vertex AI with a project and no ADC on this Mac (check
names the gcloud command), back to Google account (no sign-in started, old
failure cleared), setup's Other ways link. Not checked live: a real Gemini key,
real ADC, a real Gemini Enterprise or Google sign-in.
