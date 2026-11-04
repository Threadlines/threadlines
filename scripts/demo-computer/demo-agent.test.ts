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

/** Runs one prompt through the agent over ACP; returns its updates and the prompt's result. */
async function prompt(cwd: string, text: string) {
  const child = spawn(process.execPath, [AGENT, "acp"], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout });
  const updates: Array<Record<string, unknown>> = [];
  const replies = new Map<number, (message: Record<string, unknown>) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.method === "session/update") {
      updates.push((message.params as { update: Record<string, unknown> }).update);
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
    return { updates, done };
  } finally {
    child.stdin.end();
  }
}

it("adds a working helper with a test, commits it, and says it is scripted", async () => {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "demo-agent-test-"));
  folders.push(repo);
  NodeFS.mkdirSync(NodePath.join(repo, "src"));
  NodeFS.writeFileSync(
    NodePath.join(repo, "package.json"),
    JSON.stringify({ name: "sample", type: "module" }),
  );
  NodeFS.writeFileSync(NodePath.join(repo, "src/index.js"), "export const version = 1;\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "Start");

  const { updates, done } = await prompt(repo, "Add a slugify helper and commit it");

  expect(done.result).toEqual({ stopReason: "end_turn" });
  expect(NodeFS.readFileSync(NodePath.join(repo, "src/index.js"), "utf8")).toContain(
    'export { slugify } from "./slugify.js";',
  );
  // The test it wrote passes against the code it wrote.
  execFileSync(process.execPath, ["--test"], { cwd: repo, stdio: "pipe" });
  expect(git(repo, "status", "--porcelain")).toBe("");
  expect(git(repo, "log", "-1", "--format=%an %s")).toBe("Demo agent (scripted) Add slugify.js\n");
  const reply = updates
    .filter((update) => update.sessionUpdate === "agent_message_chunk")
    .map((update) => (update.content as { text: string }).text)
    .join("");
  expect(reply).toContain("`slugify`");
  expect(reply).toContain("scripted demo agent");
});
