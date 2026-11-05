#!/usr/bin/env node
// @effect-diagnostics globalConsole:off globalTimers:off nodeBuiltinImport:off
/**
 * The daily check of the assistants door against the demo computer
 * (docs/design/assistants.md, "The demo computer"): what a directory's scan
 * does, from outside, through the public address and the relay. It signs in
 * with the demo computer's monitoring key (`threadlines-demo monitor-key`),
 * lists the tools and their annotations, and reads the fake data, without
 * changing anything. Plain Node, no dependencies.
 *
 *   DEMO_DOOR_KEY=<key> node scripts/demo-computer/doorCheck.ts
 *
 * - DEMO_DOOR_KEY: the key (keep it in a password store, never in a file in the repo).
 * - DEMO_DOOR_URL: the door (default https://connect.threadlines.dev/mcp).
 *
 * Prints one line per check and exits 1 when any fails.
 */

const URL_DEFAULT = "https://connect.threadlines.dev/mcp";
const PROTOCOL = "2025-06-18";
const TIMEOUT_MS = 30_000;
/** Every tool a Work connection lists: what the directories review. */
const WORK_TOOLS = [
  "agents",
  "computers",
  "inbox",
  "projects",
  "thread_answer",
  "thread_changes",
  "thread_read",
  "thread_send",
  "thread_start",
  "thread_stop",
  "thread_wait",
  "threads_list",
];
const DEMO_PROJECTS = ["Acme Notes", "Weather CLI", "Field Guide docs"];
/** A fixture thread that finished with uncommitted changes. */
const CHANGED_THREAD = "Add a clamp helper";

type Json = Record<string, unknown>;

const failures: Array<string> = [];

function report(ok: boolean, what: string, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures.push(what);
}

/** The JSON-RPC answer in a response that is either JSON or a server-sent event stream. */
function rpcAnswer(contentType: string, body: string): Json {
  if (!contentType.includes("text/event-stream")) return JSON.parse(body) as Json;
  const data = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .findLast((line) => line.length > 0);
  if (data === undefined) throw new Error("an event stream with no data");
  return JSON.parse(data) as Json;
}

function makeClient(url: string, key: string) {
  let sessionId: string | null = null;
  let nextId = 0;
  const post = async (message: Json): Promise<{ status: number; answer: Json | null }> => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "user-agent": "threadlines-door-check/1",
        ...(sessionId ? { "mcp-session-id": sessionId, "mcp-protocol-version": PROTOCOL } : {}),
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}${body ? ` ${body.slice(0, 200)}` : ""}`);
    }
    if (body.trim() === "") return { status: response.status, answer: null };
    return {
      status: response.status,
      answer: rpcAnswer(response.headers.get("content-type") ?? "", body),
    };
  };
  const call = async (method: string, params: Json = {}): Promise<Json> => {
    nextId += 1;
    const { answer } = await post({ jsonrpc: "2.0", id: nextId, method, params });
    if (answer === null) throw new Error(`${method}: no answer`);
    if (answer.error) throw new Error(`${method}: ${JSON.stringify(answer.error).slice(0, 200)}`);
    return answer.result as Json;
  };
  const notify = (method: string) => post({ jsonrpc: "2.0", method });
  /** A tool's structured answer; a refusal or tool error throws with its words. */
  const tool = async (name: string, args: Json = {}): Promise<Json> => {
    const result = await call("tools/call", { name, arguments: args });
    if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content).slice(0, 200)}`);
    const structured = result.structuredContent as Json | undefined;
    const answer =
      structured ??
      (JSON.parse(
        ((result.content as Array<{ text?: string }>)[0]?.text ?? "{}") as string,
      ) as Json);
    if (answer.outcome !== undefined && answer.outcome !== "ok") {
      throw new Error(`${name}: ${String(answer.outcome)} ${String(answer.detail ?? "")}`.trim());
    }
    return answer;
  };
  return { call, notify, tool };
}

async function step(what: string, run: () => Promise<string | undefined>): Promise<void> {
  try {
    report(true, what, (await run()) ?? "");
  } catch (cause) {
    report(false, what, cause instanceof Error ? cause.message : String(cause));
  }
}

async function main(): Promise<void> {
  const key = process.env.DEMO_DOOR_KEY?.trim();
  if (!key) {
    console.error("Set DEMO_DOOR_KEY to the demo computer's monitoring key.");
    process.exitCode = 2;
    return;
  }
  const url = process.env.DEMO_DOOR_URL?.trim() || URL_DEFAULT;
  const client = makeClient(url, key);
  const started = Date.now();

  let connected = false;
  await step("sign in and start a session", async () => {
    const result = await client.call("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "threadlines-door-check", version: "1" },
    });
    await client.notify("notifications/initialized");
    connected = true;
    const info = result.serverInfo as Json | undefined;
    return `${String(info?.title ?? info?.name)} ${String(info?.version)}, protocol ${String(result.protocolVersion)}`;
  });
  if (!connected) return finish(started);

  await step(
    "every Work tool listed, each with a title and a read-only or destructive hint",
    async () => {
      const result = await client.call("tools/list");
      const tools = (result.tools as Array<Json>) ?? [];
      const names = tools.map((tool) => String(tool.name)).sort();
      const missing = WORK_TOOLS.filter((name) => !names.includes(name));
      const extra = names.filter((name) => !WORK_TOOLS.includes(name));
      if (missing.length > 0 || extra.length > 0) {
        throw new Error(`missing [${missing.join(", ")}], unexpected [${extra.join(", ")}]`);
      }
      const unlabeled = tools
        .filter((tool) => {
          const annotations = (tool.annotations ?? {}) as Json;
          const hinted = annotations.readOnlyHint === true || annotations.destructiveHint === true;
          return !(tool.title ?? annotations.title) || !hinted;
        })
        .map((tool) => String(tool.name));
      if (unlabeled.length > 0) throw new Error(`no title or hint: ${unlabeled.join(", ")}`);
      return `${tools.length} tools`;
    },
  );

  await step("the demo projects are there", async () => {
    const result = await client.tool("projects");
    const names = ((result.projects as Array<Json>) ?? []).map((project) => String(project.name));
    const missing = DEMO_PROJECTS.filter((name) => !names.includes(name));
    if (missing.length > 0) throw new Error(`missing ${missing.join(", ")}`);
    return names.join(", ");
  });

  await step("the inbox has a question and an approval waiting", async () => {
    const result = await client.tool("inbox");
    const kinds = ((result.needsYou as Array<Json>) ?? []).map((item) => String(item.kind));
    for (const kind of ["question", "approval"]) {
      if (!kinds.includes(kind))
        throw new Error(`no ${kind} (waiting: ${kinds.join(", ") || "none"})`);
    }
    return `${kinds.length} waiting`;
  });

  await step(`"${CHANGED_THREAD}" reads and shows its changes`, async () => {
    const listed = await client.tool("threads_list", { query: CHANGED_THREAD });
    const thread = ((listed.threads as Array<Json>) ?? []).find(
      (candidate) => candidate.title === CHANGED_THREAD,
    );
    if (!thread) throw new Error("not found");
    const threadId = String(thread.threadId);
    const read = await client.tool("thread_read", { threadId });
    const messages = (read.messages as Array<unknown>) ?? [];
    if (messages.length === 0) throw new Error("no messages");
    const changes = await client.tool("thread_changes", { threadId });
    const files = (changes.files as Array<unknown>) ?? [];
    if (files.length === 0) throw new Error("no changed files");
    return `${messages.length} messages, ${files.length} files changed`;
  });

  finish(started);
}

function finish(started: number): void {
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (failures.length === 0) {
    console.log(`All checks passed in ${seconds}s.`);
  } else {
    console.log(`${failures.length} check(s) failed in ${seconds}s.`);
    process.exitCode = 1;
  }
}

await main();
