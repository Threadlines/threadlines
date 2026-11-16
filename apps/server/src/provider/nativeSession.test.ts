import * as Effect from "effect/Effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  exportClaudeNativeSession,
  importClaudeNativeSession,
} from "./Drivers/ClaudeNativeSession.ts";
import {
  exportCodexNativeSession,
  importCodexNativeSession,
} from "./Drivers/CodexNativeSession.ts";
import {
  discardSessionFiles,
  isCarriedSessionRejection,
  releaseSessionFiles,
  type NativeSessionExport,
  type NativeSessionReceivedFile,
} from "./nativeSession.ts";
import { exportPiNativeSession, importPiNativeSession } from "./pi/PiNativeSession.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tempDir = (name: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `native-session-${name}-`));
  scratch.push(dir);
  return dir;
};
const write = (root: string, relPath: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, relPath)), { recursive: true });
  fs.writeFileSync(path.join(root, relPath), text);
};
/** Every file under `root`, `/`-separated, sorted; `markers` includes the transfer's marks. */
const listFiles = (root: string, markers = false): string[] =>
  fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && (markers || !entry.name.endsWith(".threadlines-move")))
    .map((entry) =>
      path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
    )
    .toSorted();
const TRANSFER = "transfer-key-1";
/** What the other computer receives of an export: each file's path and bytes. */
const received = (exported: NativeSessionExport): NativeSessionReceivedFile[] =>
  exported.files.map((file) => ({
    relPath: file.relPath,
    bytes: fs.readFileSync(file.absolutePath),
  }));

const SESSION = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const AT = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const CODEX_THREAD = "019f6910-960c-7d83-87f7-074ab55a95fb";
const PI_SESSION = "01a1502b-0fab-70f6-80c3-4f51b6687b5c";

describe("carrying a Claude session", () => {
  const sourceHome = () => {
    const home = tempDir("claude-a");
    write(home, `projects/-old-repo/${SESSION}.jsonl`, '{"type":"user"}\n');
    write(home, `projects/-old-repo/${SESSION}/subagents/agent-a1.jsonl`, "{}\n");
    write(home, `projects/-old-repo/${SESSION}/subagents/agent-a1.meta.json`, "{}");
    write(home, `projects/-old-repo/${SESSION}/subagents/workflows/run-1/agent-w1.jsonl`, "{}\n");
    // This machine's own state: never carried.
    write(home, `file-history/${SESSION}/a.txt`, "x");
    write(home, `todos/${SESSION}.json`, "[]");
    write(home, `shell-snapshots/${SESSION}.sh`, "x");
    write(home, ".credentials.json", '{"secret":true}');
    return home;
  };

  it("exports the transcript and its subagents, and writes them under the new checkout's project", async () => {
    const exported = await Effect.runPromise(
      exportClaudeNativeSession({
        configDir: sourceHome(),
        resumeCursor: { threadId: "t", resume: SESSION, resumeSessionAt: AT, turnCount: 3 },
      }),
    );
    expect(exported?.files.map((file) => file.relPath).toSorted()).toEqual([
      `projects/-old-repo/${SESSION}.jsonl`,
      `projects/-old-repo/${SESSION}/subagents/agent-a1.jsonl`,
      `projects/-old-repo/${SESSION}/subagents/agent-a1.meta.json`,
      `projects/-old-repo/${SESSION}/subagents/workflows/run-1/agent-w1.jsonl`,
    ]);
    expect(exported?.cursor).toEqual({ resume: SESSION, resumeSessionAt: AT, turnCount: 3 });

    const target = tempDir("claude-b");
    const input = {
      configDir: target,
      cursor: exported!.cursor,
      files: received(exported!),
      worktreePath: "/Users/b/worktrees/moved-1",
      transferKey: TRANSFER,
    };
    const imported = await Effect.runPromise(importClaudeNativeSession(input));
    expect(imported).toMatchObject({
      cursor: { resume: SESSION, resumeSessionAt: AT, turnCount: 3 },
    });
    expect(listFiles(target)).toEqual([
      `projects/-Users-b-worktrees-moved-1/${SESSION}.jsonl`,
      `projects/-Users-b-worktrees-moved-1/${SESSION}/subagents/agent-a1.jsonl`,
      `projects/-Users-b-worktrees-moved-1/${SESSION}/subagents/agent-a1.meta.json`,
      `projects/-Users-b-worktrees-moved-1/${SESSION}/subagents/workflows/run-1/agent-w1.jsonl`,
    ]);
    // A retry of the same transfer finds its own files and is fine.
    expect(await Effect.runPromise(importClaudeNativeSession(input))).toEqual(imported);

    // The move didn't land: everything it wrote goes, and nothing else.
    write(target, "projects/-Users-b-worktrees-moved-1/other.jsonl", "not ours\n");
    expect(
      await Effect.runPromise(
        discardSessionFiles("written" in imported ? imported.written : [], TRANSFER),
      ),
    ).toBe(true);
    expect(listFiles(target, true)).toEqual(["projects/-Users-b-worktrees-moved-1/other.jsonl"]);
  });

  it("carries on from an older copy of the same transcript, and an abort cuts it back", async () => {
    const target = tempDir("claude-again");
    const transcript = `projects/-w/${SESSION}.jsonl`;
    write(target, transcript, '{"turn":1}\n');
    const imported = await Effect.runPromise(
      importClaudeNativeSession({
        configDir: target,
        cursor: { resume: SESSION },
        files: [
          {
            relPath: `projects/-b/${SESSION}.jsonl`,
            bytes: Buffer.from('{"turn":1}\n{"turn":2}\n'),
          },
        ],
        worktreePath: "/w",
        transferKey: TRANSFER,
      }),
    );
    expect(imported).toHaveProperty("cursor");
    expect(fs.readFileSync(path.join(target, transcript), "utf8")).toBe('{"turn":1}\n{"turn":2}\n');
    await Effect.runPromise(
      discardSessionFiles("written" in imported ? imported.written : [], TRANSFER),
    );
    expect(fs.readFileSync(path.join(target, transcript), "utf8")).toBe('{"turn":1}\n');
    expect(listFiles(target, true)).toEqual([transcript]);
  });

  it("writes nothing when the other computer names a credential or a path outside the session", async () => {
    for (const relPath of [
      ".credentials.json",
      "settings.json",
      `projects/-x/${SESSION}/../../../.credentials.json`,
      `projects/-x/${SESSION}/subagents/../../../../.credentials.json`,
      "/etc/passwd",
    ]) {
      const target = tempDir("claude-refuse");
      const imported = await Effect.runPromise(
        importClaudeNativeSession({
          configDir: target,
          cursor: { resume: SESSION },
          files: [
            { relPath: `projects/-x/${SESSION}.jsonl`, bytes: Buffer.from("{}\n") },
            { relPath, bytes: Buffer.from('{"stolen":true}') },
          ],
          worktreePath: "/w",
          transferKey: TRANSFER,
        }),
      );
      expect(imported).toHaveProperty("refused");
      expect(listFiles(target)).toEqual([]);
    }
    // A session id that isn't one names nothing.
    const target = tempDir("claude-refuse-id");
    const imported = await Effect.runPromise(
      importClaudeNativeSession({
        configDir: target,
        cursor: { resume: "../../.credentials" },
        files: [{ relPath: "projects/-x/../../.credentials.json", bytes: Buffer.from("{}") }],
        worktreePath: "/w",
        transferKey: TRANSFER,
      }),
    );
    expect(imported).toHaveProperty("refused");
    expect(listFiles(target)).toEqual([]);
  });

  it("refuses to carry over a file this transfer didn't write, and leaves nothing of its own", async () => {
    const target = tempDir("claude-clash");
    const slug = "-w";
    write(target, `projects/${slug}/${SESSION}/subagents/agent-a1.jsonl`, "someone else's\n");
    const imported = await Effect.runPromise(
      importClaudeNativeSession({
        configDir: target,
        cursor: { resume: SESSION },
        files: [
          { relPath: `projects/-old/${SESSION}.jsonl`, bytes: Buffer.from("ours\n") },
          {
            relPath: `projects/-old/${SESSION}/subagents/agent-a1.jsonl`,
            bytes: Buffer.from("ours\n"),
          },
        ],
        worktreePath: "/w",
        transferKey: TRANSFER,
      }),
    );
    expect(imported).toHaveProperty("refused");
    expect(listFiles(target)).toEqual([`projects/${slug}/${SESSION}/subagents/agent-a1.jsonl`]);
    expect(
      fs.readFileSync(
        path.join(target, `projects/${slug}/${SESSION}/subagents/agent-a1.jsonl`),
        "utf8",
      ),
    ).toBe("someone else's\n");
  });
});

describe("carrying a Codex session", () => {
  it("exports the rollout and writes it under the date its name says, resumed by path", async () => {
    const source = tempDir("codex-a");
    const name = `rollout-2026-07-15T23-55-22-${CODEX_THREAD}.jsonl.zst`;
    write(source, `sessions/2026/07/15/${name}`, "zst");
    write(source, "auth.json", '{"tokens":{}}');
    const exported = await Effect.runPromise(
      exportCodexNativeSession({ home: source, resumeCursor: { threadId: CODEX_THREAD } }),
    );
    expect(exported?.files.map((file) => file.relPath)).toEqual([`sessions/2026/07/15/${name}`]);

    const target = tempDir("codex-b");
    const imported = await Effect.runPromise(
      importCodexNativeSession({
        home: target,
        cursor: exported!.cursor,
        files: received(exported!),
        worktreePath: "/w",
        transferKey: TRANSFER,
      }),
    );
    const destination = path.join(target, "sessions/2026/07/15", name);
    expect(imported).toEqual({
      cursor: { threadId: CODEX_THREAD, rolloutPath: destination },
      written: [destination],
    });
    expect(listFiles(target)).toEqual([`sessions/2026/07/15/${name}`]);
    // Landed: the file is the thread's, and the transfer's mark goes.
    await Effect.runPromise(releaseSessionFiles([destination], TRANSFER));
    expect(listFiles(target, true)).toEqual([`sessions/2026/07/15/${name}`]);
  });

  it("a thread that moved away and back carries on from the rollout left here", async () => {
    // A's rollout from before the move; the one coming back carries on from it.
    const relPath = `sessions/2026/07/15/rollout-2026-07-15T23-55-22-${CODEX_THREAD}.jsonl`;
    const target = tempDir("codex-back");
    write(target, relPath, '{"a":1}\n');
    const carry = (bytes: string, transferKey: string) =>
      Effect.runPromise(
        importCodexNativeSession({
          home: target,
          cursor: { threadId: CODEX_THREAD },
          files: [{ relPath, bytes: Buffer.from(bytes) }],
          worktreePath: "/w",
          transferKey,
        }),
      );
    expect(await carry('{"a":1}\n{"b":2}\n', TRANSFER)).toHaveProperty("cursor");
    expect(fs.readFileSync(path.join(target, relPath), "utf8")).toBe('{"a":1}\n{"b":2}\n');
    // The same transfer again (a retry) may write it; another one with other
    // contents may not.
    expect(await carry('{"a":1}\n{"b":3}\n', TRANSFER)).toHaveProperty("cursor");
    expect(await carry('{"z":0}\n', "transfer-key-2")).toHaveProperty("refused");
    expect(fs.readFileSync(path.join(target, relPath), "utf8")).toBe('{"a":1}\n{"b":3}\n');
  });

  it("writes nothing for auth.json or a rollout of another thread", async () => {
    for (const relPath of [
      "auth.json",
      "config.toml",
      `sessions/2026/07/15/rollout-2026-07-15T23-55-22-${"0".repeat(8)}-0000-7000-8000-${"0".repeat(12)}.jsonl`,
      `sessions/../auth.json`,
    ]) {
      const target = tempDir("codex-refuse");
      const imported = await Effect.runPromise(
        importCodexNativeSession({
          home: target,
          cursor: { threadId: CODEX_THREAD },
          files: [{ relPath, bytes: Buffer.from("{}") }],
          worktreePath: "/w",
          transferKey: TRANSFER,
        }),
      );
      expect(imported).toHaveProperty("refused");
      expect(listFiles(target)).toEqual([]);
    }
  });
});

describe("carrying a Pi session", () => {
  it("exports the cursor's session file and opens it from this computer's Pi folder", async () => {
    const agentDir = tempDir("pi-a");
    const name = `2026-10-18T17-59-21-771Z_${PI_SESSION}.jsonl`;
    write(agentDir, `sessions/--old-repo--/${name}`, '{"type":"session"}\n');
    const exported = await Effect.runPromise(
      exportPiNativeSession({
        agentDir,
        resumeCursor: {
          schemaVersion: 2,
          sessionFile: path.join(agentDir, "sessions/--old-repo--", name),
          cwd: "/old/repo",
        },
      }),
    );
    expect(exported?.cursor).toMatchObject({ sessionFile: `sessions/--old-repo--/${name}` });

    const target = tempDir("pi-b");
    const imported = await Effect.runPromise(
      importPiNativeSession({
        agentDir: target,
        cursor: exported!.cursor,
        files: received(exported!),
        worktreePath: "/Users/b/moved",
        transferKey: TRANSFER,
      }),
    );
    expect(imported).toMatchObject({
      cursor: {
        schemaVersion: 2,
        sessionFile: path.join(target, "sessions/--Users-b-moved--", name),
        // Pi forks it into the new checkout on its first start.
        cwd: "/old/repo",
      },
    });
    expect(listFiles(target)).toEqual([`sessions/--Users-b-moved--/${name}`]);

    // An older copy of the same session here is carried on from; someone else's isn't replaced.
    const again = tempDir("pi-again");
    const there = `sessions/--Users-b-moved--/${name}`;
    const carry = (bytes: string) =>
      Effect.runPromise(
        importPiNativeSession({
          agentDir: again,
          cursor: exported!.cursor,
          files: [{ relPath: `sessions/--old-repo--/${name}`, bytes: Buffer.from(bytes) }],
          worktreePath: "/Users/b/moved",
          transferKey: TRANSFER,
        }),
      );
    write(again, there, '{"type":"session"}\n');
    expect(await carry('{"type":"session"}\n{"type":"message"}\n')).toHaveProperty("cursor");
    write(again, there, "someone else's\n");
    fs.rmSync(path.join(again, `sessions/--Users-b-moved--/.${name}.threadlines-move`));
    expect(await carry('{"type":"session"}\n')).toHaveProperty("refused");
    expect(fs.readFileSync(path.join(again, there), "utf8")).toBe("someone else's\n");
  });
});

describe("a carried session's refused turn", () => {
  it("is recognized only by the providers' own signatures", () => {
    // Codex passes OpenAI's body through.
    expect(
      isCarriedSessionRejection(
        '{"error":{"message":"The encrypted content gAAA could not be verified. Reason: Encrypted content organization_id did not match the target organization.","type":"invalid_request_error","param":null,"code":"invalid_encrypted_content"}}',
      ),
    ).toBe(true);
    // Claude's API, as its docs word it.
    expect(
      isCarriedSessionRejection(
        "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.",
      ),
    ).toBe(true);
    // Anything else is an ordinary failed turn.
    for (const ordinary of [
      "Rate limit reached for requests",
      "The model `gpt-6` does not exist",
      "authentication expired",
      "Claude Code process exited with code 1",
    ]) {
      expect(isCarriedSessionRejection(ordinary)).toBe(false);
    }
  });
});
