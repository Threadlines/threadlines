/**
 * Records replay fixtures (apps/server/integration/replay) against the real
 * provider, then replays each one once to check it holds up.
 *
 *   node scripts/record-replay.ts --provider codex [--scenario simple-turn]
 *
 * Uses the provider's real sign-in and a little of its usage. The prompts are
 * harmless and run in a throwaway git workspace; the recorder masks paths and
 * emails and refuses to write a file that still looks private.
 */
// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import { redactClaudeFrame } from "../integration/replay/claudeTransport.ts";
import { redactCodexFrame } from "../integration/replay/codexTransport.ts";
import { makeRecorder } from "../integration/replay/recorder.ts";
import { runReplayScenario } from "../integration/replay/runReplay.ts";
import {
  fixturePath,
  REPLAY_SCENARIOS,
  type ReplayProvider,
} from "../integration/replay/scenarios.ts";

const { values } = parseArgs({
  options: {
    provider: { type: "string" },
    scenario: { type: "string" },
  },
});
const provider = values.provider as ReplayProvider | undefined;
if (provider !== "codex" && provider !== "claude") {
  throw new Error("Pass --provider codex or --provider claude.");
}

const providerVersion =
  provider === "codex"
    ? execFileSync("codex", ["--version"], { encoding: "utf8" }).trim()
    : execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
const protocol = provider === "codex" ? "codex.app-server.jsonrpc" : "claude-agent-sdk.query";

const scenarios = REPLAY_SCENARIOS.filter(
  (scenario) =>
    scenario.providers.includes(provider) &&
    (values.scenario === undefined || scenario.name === values.scenario),
);
if (scenarios.length === 0)
  throw new Error(`No scenario named ${values.scenario} for ${provider}.`);

for (const scenario of scenarios) {
  const output = fixturePath(scenario.name, provider);
  console.log(`recording ${scenario.name} (${provider})`);
  const recorded = await Effect.runPromise(
    runReplayScenario({
      provider,
      scenario,
      mode: {
        kind: "record",
        recorder: (paths) =>
          makeRecorder(
            { provider, protocol, providerVersion, scenario: scenario.name },
            paths,
            provider === "codex" ? redactCodexFrame : redactClaudeFrame,
          ),
      },
      timeoutMs: 240_000,
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  const transcript = recorded.recorder!.finish(output);
  console.log(`  wrote ${output} (${transcript.entries.length} entries); checking it replays`);
  await Effect.runPromise(
    runReplayScenario({
      provider,
      scenario,
      mode: { kind: "replay", transcript },
      timeoutMs: 30_000,
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  console.log("  replays cleanly");
}
