# Provider replay tests

These tests run the real Codex and Claude adapter code, plus ingestion and orchestration, against recorded provider sessions. No model and no network are needed, so they run in CI on every change.

- `fixtures/<scenario>/<codex|claude>.ndjson`: one recording per scenario and provider (format in `transcript.ts`).
- `scenarios.ts`: what each scenario does in a thread and what the thread must show after. The same script records and replays.
- Codex is replayed at the process boundary (`codexTransport.ts`, a fake `codex app-server`). Claude is replayed at the SDK boundary (`claudeTransport.ts`, a fake `query()`).

A replay fails when our code sends a request the recording doesn't have, stops sending one it has, or the thread doesn't end up as the scenario expects.

## Recording

```
cd apps/server
node scripts/record-replay.ts --provider codex [--scenario simple-turn]
node scripts/record-replay.ts --provider claude [--scenario simple-turn]
```

This uses your real sign-in and a little usage. It runs harmless prompts in a throwaway git folder, then replays each new recording once to check it holds up.

The repository is public. Before anything is written, the recorder:

- swaps machine paths for placeholders and masks emails;
- strips your own setup (plugins, skills, connected services, plan, machine name) and the agent's reasoning text;
- refuses to write a file that still looks private.

Read the diff before committing a recording anyway.

Re-record a scenario when a provider changes its protocol, or when you change what our code sends on purpose. Edits to our instructions to the agent don't need a new recording.
