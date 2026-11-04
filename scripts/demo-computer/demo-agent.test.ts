// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync, spawn } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createInterface } from "node:readline";

import { afterEach, expect, it } from "vitest";

const AGENT = NodePath.join(import.meta.dirname, "demo-agent.ts");

const folders: Array<string> = [];
afterEach(() => {
  for (const folder of folders.splice(0)) NodeFS.rmSync(folder, { recursive: true, force: true });
});

const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
  });

const tempFolder = (prefix: string) => {
  const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  folders.push(folder);
  return folder;
};

/**
 * Runs one prompt through the agent over ACP, allowing whatever it asks to
 * do; returns its reply text and the prompt's result.
 */
async function prompt(cwd: string, text: string) {
  const child = spawn(process.execPath, [AGENT, "acp"], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, DEMO_AGENT_STEP_MS: "0", DEMO_AGENT_RUN_DIR: tempFolder("demo-run-") },
  });
  const lines = createInterface({ input: child.stdout });
  const chunks: Array<string> = [];
  const replies = new Map<number, (message: Record<string, unknown>) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const update = (message.params as { update?: Record<string, unknown> } | undefined)?.update;
    if (message.method === "session/update" && update?.sessionUpdate === "agent_message_chunk") {
      chunks.push((update.content as { text: string }).text);
    } else if (message.method === "session/request_permission") {
      const outcome = { outcome: "selected", optionId: "allow-once" };
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { outcome } })}\n`,
      );
    } else if (typeof message.id === "number") {
      replies.get(message.id)?.(message);
    }
  });
  const call = (id: number, method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      replies.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    await call(1, "initialize", { protocolVersion: 1, clientInfo: { name: "test" } });
    const created = await call(2, "session/new", { cwd, mcpServers: [] });
    const { sessionId } = created.result as { sessionId: string };
    const done = await call(3, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
    return { reply: chunks.join(""), done };
  } finally {
    child.stdin.end();
  }
}

it("adds a working helper with a test, commits it, says it is scripted, and stays in its folder", async () => {
  const repo = tempFolder("demo-agent-test-");
  NodeFS.mkdirSync(NodePath.join(repo, "src"));
  NodeFS.writeFileSync(
    NodePath.join(repo, "package.json"),
    JSON.stringify({ name: "sample", type: "module" }),
  );
  NodeFS.writeFileSync(NodePath.join(repo, "src/index.js"), "export const version = 1;\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "Start");

  const { reply, done } = await prompt(repo, "Add a slugify helper and commit it");

  expect(done.result).toEqual({ stopReason: "end_turn" });
  expect(NodeFS.readFileSync(NodePath.join(repo, "src/index.js"), "utf8")).toContain(
    'export { slugify } from "./slugify.js";',
  );
  // The test it wrote passes against the code it wrote.
  execFileSync(process.execPath, ["--test"], { cwd: repo, stdio: "pipe" });
  expect(git(repo, "status", "--porcelain")).toBe("");
  expect(git(repo, "log", "-1", "--format=%an %s")).toBe("Demo agent (scripted) Add slugify.js\n");
  expect(reply).toContain("`slugify`");
  expect(reply).toContain("scripted demo agent");

  // A path in the message never leads it out of its folder: not by `..`,
  // not through a symlink. (Every request is allowed here.)
  const outside = tempFolder("demo-agent-outside-");
  NodeFS.writeFileSync(NodePath.join(outside, "keep.md"), "keep\n");
  NodeFS.symlinkSync(outside, NodePath.join(repo, "linked"));
  const escape = await prompt(
    repo,
    `Remove ./../${NodePath.basename(outside)}/keep.md and linked/keep.md`,
  );
  expect(NodeFS.readFileSync(NodePath.join(outside, "keep.md"), "utf8")).toBe("keep\n");
  expect(escape.reply).toContain("couldn't find a file to remove");
});
