import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe } from "vite-plus/test";

import { makeRecorder, privateDataIn } from "./recorder.ts";
import { runReplayScenario } from "./runReplay.ts";
import { FIXTURES_DIR, fixturePath, REPLAY_SCENARIOS } from "./scenarios.ts";
import { readTranscript } from "./transcript.ts";

// A recording no scenario plays would rot unnoticed.
const scenarioNames = new Set(REPLAY_SCENARIOS.map((scenario) => scenario.name));
for (const name of fs.existsSync(FIXTURES_DIR) ? fs.readdirSync(FIXTURES_DIR) : []) {
  if (!scenarioNames.has(name)) {
    throw new Error(`Replay fixture folder '${name}' has no scenario in scenarios.ts.`);
  }
}

describe("provider replays", () => {
  for (const scenario of REPLAY_SCENARIOS) {
    for (const provider of scenario.providers) {
      const path = fixturePath(scenario.name, provider);
      it.live(`${scenario.name} (${provider})`, () =>
        Effect.gen(function* () {
          assert.ok(
            fs.existsSync(path),
            `No recording at ${nodePath.relative(process.cwd(), path)}: run scripts/record-replay.ts --provider ${provider} --scenario ${scenario.name}`,
          );
          yield* runReplayScenario({
            provider,
            scenario,
            mode: { kind: "replay", transcript: readTranscript(path) },
            timeoutMs: 20_000,
          });
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
    }
  }

  // The repository is public: a hand-edited or older recording must not
  // carry anything the recorder would have refused.
  it("committed recordings hold no private data", () => {
    for (const scenario of REPLAY_SCENARIOS) {
      for (const provider of scenario.providers) {
        const path = fixturePath(scenario.name, provider);
        if (!fs.existsSync(path)) continue;
        assert.equal(privateDataIn(fs.readFileSync(path, "utf8")), null, path);
      }
    }
  });

  it("refuses a recording whose streamed pieces spell out a private path", () => {
    const workspaceDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "replay-recorder-"));
    try {
      const recorder = makeRecorder(
        { provider: "claude", protocol: "test", providerVersion: "0", scenario: "split" },
        { workspaceDir, rootDir: workspaceDir },
        (frame) => frame,
      );
      const home = os.homedir();
      const middle = Math.floor(home.length / 2);
      recorder.in(0, { delta: home.slice(0, middle) });
      recorder.in(0, { delta: `${home.slice(middle)}/notes.txt` });
      assert.throws(
        () => recorder.finish(nodePath.join(workspaceDir, "out.ndjson")),
        // Which check fires first depends on where this machine keeps home and temp.
        /Not writing .* still contains/,
      );
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("refuses recordings that still hold private data", () => {
    const machine = {
      environment: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-sentinel-not-a-real-token" },
      homeDir: "/Users/someone",
      userName: "someone",
    };
    assert.equal(privateDataIn('{"text":"PONG","example":"/Users/me/file.png"}', machine), null);
    assert.equal(
      privateDataIn('{"env":{"T":"sk-ant-oat01-sentinel-not-a-real-token"}}', machine),
      "the value of $CLAUDE_CODE_OAUTH_TOKEN",
    );
    assert.equal(
      privateDataIn('{"text":"curl -H Bearer abc123def456"}', machine),
      "a bearer token",
    );
    assert.equal(
      privateDataIn('{"headers":{"X-API-Key":"live_0123456789abcdef"}}', machine),
      "a credential-looking field",
    );
    assert.equal(
      privateDataIn('{"path":"/private/tmp/claude-502/x/tasks/out.txt"}', machine),
      "a temp folder path",
    );
    assert.equal(
      privateDataIn('{"cwd":"/Users/someone/project"}', machine),
      "the home folder path",
    );
    // JSON-escaped, as a Windows path appears in a transcript.
    assert.equal(
      privateDataIn('{"cwd":"C:\\\\Users\\\\someone\\\\project"}', machine),
      "a user folder path",
    );
    assert.equal(privateDataIn('{"user":"person@example.com"}', machine), "an email address");
  });
});
