// @effect-diagnostics nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  codexExecSessionsRoot,
  findCodexExecRollout,
  locateCodexExecRolloutBySessionId,
  mapCodexExecRolloutTranscript,
  matchCodexExecCommand,
  parseCodexExecAgentId,
  readCodexExecFinalMessage,
  readCodexExecRolloutHead,
  readCodexExecTurnContext,
} from "./CodexExecRollouts.ts";

const SESSION_A = "019fea48-4154-7982-876b-43e4c551eb65";
const SESSION_B = "019fea48-4154-7982-876b-43e4c551eb66";

function line(record: unknown): string {
  return JSON.stringify(record);
}

function sessionMeta(input: {
  readonly sessionId: string;
  readonly cwd: string;
  readonly originator?: string;
  readonly source?: string;
  readonly startedAt?: string;
}): string {
  return line({
    timestamp: input.startedAt ?? "2026-08-10T06:07:11.861Z",
    type: "session_meta",
    payload: {
      session_id: input.sessionId,
      cwd: input.cwd,
      originator: input.originator ?? "codex_exec",
      source: input.source ?? "exec",
      cli_version: "0.147.0",
    },
  });
}

function turnContext(model: string, effort: string): string {
  return line({
    timestamp: "2026-08-10T06:07:12.000Z",
    type: "turn_context",
    payload: { turn_id: "turn-1", cwd: "/tmp/x", model, effort },
  });
}

function makeSessionsRoot(): { readonly root: string; readonly cleanup: () => void } {
  const home = mkdtempSync(path.join(os.tmpdir(), "codex-exec-rollouts-"));
  const root = path.join(home, "sessions");
  mkdirSync(root, { recursive: true });
  return { root, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function writeRollout(input: {
  readonly root: string;
  readonly date: Date;
  readonly sessionId: string;
  readonly lines: ReadonlyArray<string>;
  readonly mtimeMs?: number;
}): string {
  const year = String(input.date.getFullYear());
  const month = String(input.date.getMonth() + 1).padStart(2, "0");
  const day = String(input.date.getDate()).padStart(2, "0");
  const directory = path.join(input.root, year, month, day);
  mkdirSync(directory, { recursive: true });
  const filePath = path.join(
    directory,
    `rollout-${year}-${month}-${day}T00-00-00-${input.sessionId}.jsonl`,
  );
  writeFileSync(filePath, `${input.lines.join("\n")}\n`);
  if (input.mtimeMs !== undefined) {
    const seconds = input.mtimeMs / 1_000;
    utimesSync(filePath, seconds, seconds);
  }
  return filePath;
}

describe("matchCodexExecCommand", () => {
  it("recognises codex exec invocations and reads their explicit flags", () => {
    assert.deepEqual(matchCodexExecCommand(`codex exec "do the thing"`), {
      prompt: "do the thing",
    });
    assert.deepEqual(matchCodexExecCommand(`codex e -m gpt-5.6-sol 'review this'`), {
      model: "gpt-5.6-sol",
      prompt: "review this",
    });
    assert.deepEqual(matchCodexExecCommand(`CODEX_HOME=/x codex exec "go"`), { prompt: "go" });
    assert.deepEqual(matchCodexExecCommand(`timeout 600 codex exec "go"`), { prompt: "go" });
    assert.deepEqual(
      matchCodexExecCommand(`codex exec -c model_reasoning_effort="high" --model=gpt-5.6-sol "go"`),
      { model: "gpt-5.6-sol", reasoningEffort: "high", prompt: "go" },
    );
    assert.deepEqual(matchCodexExecCommand(`cd /tmp/work && /usr/local/bin/codex exec "go"`), {
      prompt: "go",
    });
  });

  it("rejects commands that only mention codex exec", () => {
    for (const command of [
      "codex review",
      "codex apply",
      "echo codex exec",
      "vp run codex-things",
      `python -c "subprocess.run(['codex', 'exec', 'go'])"`,
      `echo "codex exec go" > /tmp/note`,
      "npx codex exec go",
      "",
    ]) {
      assert.equal(matchCodexExecCommand(command), null, command);
    }
  });
});

describe("parseCodexExecAgentId", () => {
  it("accepts only prefixed uuids", () => {
    assert.equal(parseCodexExecAgentId(`codex-exec:${SESSION_A}`), SESSION_A);
    assert.equal(parseCodexExecAgentId("codex-exec:../../etc/passwd"), null);
    assert.equal(parseCodexExecAgentId("agent-123"), null);
  });
});

describe("readCodexExecRolloutHead", () => {
  it("accepts exec rollouts and rejects app-server ones", () => {
    assert.deepEqual(
      readCodexExecRolloutHead(sessionMeta({ sessionId: SESSION_A, cwd: "/tmp/work" })),
      { sessionId: SESSION_A, cwd: "/tmp/work", startedAt: "2026-08-10T06:07:11.861Z" },
    );
    assert.equal(
      readCodexExecRolloutHead(
        sessionMeta({
          sessionId: SESSION_A,
          cwd: "/tmp/work",
          originator: "threadlines_desktop",
          source: "vscode",
        }),
      ),
      null,
    );
    assert.equal(readCodexExecRolloutHead("not json"), null);
  });
});

describe("readCodexExecTurnContext", () => {
  it("reads model and effort from the first turn context", () => {
    assert.deepEqual(
      readCodexExecTurnContext([
        sessionMeta({ sessionId: SESSION_A, cwd: "/tmp/work" }),
        turnContext("gpt-5.6-sol", "medium"),
        turnContext("gpt-5.6-terra", "high"),
      ]),
      { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    );
    assert.equal(
      readCodexExecTurnContext([sessionMeta({ sessionId: SESSION_A, cwd: "/tmp/work" })]),
      null,
    );
  });
});

describe("mapCodexExecRolloutTranscript", () => {
  it("maps prompts, reasoning, tool calls and their output into entries", () => {
    const transcript = mapCodexExecRolloutTranscript([
      sessionMeta({ sessionId: SESSION_A, cwd: "/tmp/work" }),
      turnContext("gpt-5.6-sol", "medium"),
      line({ type: "world_state", payload: { anything: true } }),
      line({
        timestamp: "2026-08-10T06:07:13.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Verify the usage page" },
      }),
      line({
        type: "response_item",
        payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Plan the check" }] },
      }),
      line({
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "call-1",
          input: "ls /tmp/work",
        },
      }),
      line({
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-1",
          output: [{ type: "input_text", text: "usage.tsx" }],
        },
      }),
      line({
        type: "event_msg",
        payload: { type: "agent_message", message: "The page renders." },
      }),
      "not-json",
    ]);

    assert.equal(transcript.model, "gpt-5.6-sol");
    assert.equal(transcript.cwd, "/tmp/work");
    assert.equal(transcript.prompt, "Verify the usage page");
    assert.deepEqual(
      transcript.entries.map((entry) => ({
        role: entry.role,
        text: entry.text,
        tools: entry.toolUses.map((tool) => `${tool.name}:${tool.summary}`),
        ...(entry.outputPreview ? { outputPreview: entry.outputPreview } : {}),
      })),
      [
        { role: "user", text: "Verify the usage page", tools: [] },
        { role: "thinking", text: "Plan the check", tools: [] },
        {
          role: "assistant",
          text: "",
          tools: ["exec:ls /tmp/work"],
          outputPreview: "usage.tsx",
        },
        { role: "assistant", text: "The page renders.", tools: [] },
      ],
    );
    assert.equal(transcript.entries[0]?.at, "2026-08-10T06:07:13.000Z");
  });
});

describe("readCodexExecFinalMessage", () => {
  it("prefers the newest completion message", () => {
    assert.equal(
      readCodexExecFinalMessage([
        line({ type: "event_msg", payload: { type: "agent_message", message: "working" } }),
        line({
          type: "event_msg",
          payload: { type: "task_complete", last_agent_message: "all done" },
        }),
      ]),
      "all done",
    );
    assert.equal(readCodexExecFinalMessage(["not json"]), null);
  });
});

describe("codexExecSessionsRoot", () => {
  it.effect("follows CODEX_HOME when set, else the default codex home", () =>
    Effect.gen(function* () {
      const pathService = yield* Path.Path;
      assert.equal(
        codexExecSessionsRoot({ CODEX_HOME: "/tmp/codex-work" }, pathService),
        path.join("/tmp/codex-work", "sessions"),
      );
      assert.equal(
        codexExecSessionsRoot({}, pathService),
        path.join(os.homedir(), ".codex", "sessions"),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("findCodexExecRollout", () => {
  const cwd = os.tmpdir();

  it.effect("claims the earliest matching rollout and never reuses a claimed one", () =>
    Effect.gen(function* () {
      const { root, cleanup } = makeSessionsRoot();
      try {
        const startedAtMs = Date.now();
        const startedAtIso = new Date(startedAtMs).toISOString();
        const first = writeRollout({
          root,
          date: new Date(startedAtMs),
          sessionId: SESSION_A,
          lines: [
            sessionMeta({ sessionId: SESSION_A, cwd, startedAt: startedAtIso }),
            turnContext("gpt-5.6-sol", "medium"),
          ],
          mtimeMs: startedAtMs + 1_000,
        });
        const second = writeRollout({
          root,
          date: new Date(startedAtMs),
          sessionId: SESSION_B,
          lines: [sessionMeta({ sessionId: SESSION_B, cwd, startedAt: startedAtIso })],
          mtimeMs: startedAtMs + 2_000,
        });
        // An exec run that began ten minutes before this task, still writing:
        // its mtime is fresh, so only its recorded start time rules it out.
        // Earliest-mtime ordering would otherwise hand it every match.
        writeRollout({
          root,
          date: new Date(startedAtMs),
          sessionId: "019fea48-4154-7982-876b-43e4c551eb69",
          lines: [
            sessionMeta({
              sessionId: "019fea48-4154-7982-876b-43e4c551eb69",
              cwd,
              startedAt: new Date(startedAtMs - 600_000).toISOString(),
            }),
          ],
          mtimeMs: startedAtMs + 500,
        });
        // Same directory, but written by the desktop app-server rather than an
        // exec run, and for an unrelated directory.
        writeRollout({
          root,
          date: new Date(startedAtMs),
          sessionId: "019fea48-4154-7982-876b-43e4c551eb67",
          lines: [
            sessionMeta({
              sessionId: "019fea48-4154-7982-876b-43e4c551eb67",
              cwd,
              originator: "threadlines_desktop",
              source: "vscode",
            }),
          ],
          mtimeMs: startedAtMs,
        });
        writeRollout({
          root,
          date: new Date(startedAtMs),
          sessionId: "019fea48-4154-7982-876b-43e4c551eb68",
          lines: [
            sessionMeta({
              sessionId: "019fea48-4154-7982-876b-43e4c551eb68",
              cwd: path.join(cwd, "somewhere-else"),
            }),
          ],
          mtimeMs: startedAtMs,
        });

        const claimed = new Set<string>();
        const firstMatch = yield* findCodexExecRollout({
          sessionsRoot: root,
          cwd,
          notBeforeMs: startedAtMs,
          claimedPaths: claimed,
        });
        assert.deepEqual(firstMatch, { rolloutPath: first, sessionId: SESSION_A });

        claimed.add(first);
        const secondMatch = yield* findCodexExecRollout({
          sessionsRoot: root,
          cwd,
          notBeforeMs: startedAtMs,
          claimedPaths: claimed,
        });
        assert.deepEqual(secondMatch, { rolloutPath: second, sessionId: SESSION_B });

        claimed.add(second);
        assert.equal(
          yield* findCodexExecRollout({
            sessionsRoot: root,
            cwd,
            notBeforeMs: startedAtMs,
            claimedPaths: claimed,
          }),
          null,
        );
      } finally {
        cleanup();
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves a rollout from its session id alone", () =>
    Effect.gen(function* () {
      const { root, cleanup } = makeSessionsRoot();
      try {
        const rolloutPath = writeRollout({
          root,
          date: new Date("2026-08-10T12:00:00Z"),
          sessionId: SESSION_A,
          lines: [sessionMeta({ sessionId: SESSION_A, cwd })],
        });
        assert.equal(
          yield* locateCodexExecRolloutBySessionId({ sessionsRoot: root, sessionId: SESSION_A }),
          rolloutPath,
        );
        assert.equal(
          yield* locateCodexExecRolloutBySessionId({ sessionsRoot: root, sessionId: SESSION_B }),
          null,
        );
      } finally {
        cleanup();
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
