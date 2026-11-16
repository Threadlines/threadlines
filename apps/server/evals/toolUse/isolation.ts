/**
 * Keeps a tool-use eval's agent away from the developer's own setup and off
 * per-use billing. Each provider runs from a settings folder made only for
 * evals (signed in once with the developer's subscription; see README.md):
 * no plugins, connectors, MCP servers or personal instructions. Before the
 * first model request, each run checks the sign-in is a subscription and only
 * Threadlines' own tool servers are connected, and stops otherwise.
 */
// @effect-diagnostics nodeBuiltinImport:off
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import type { ClaudeAdapterLiveOptions } from "../../src/provider/Layers/ClaudeAdapter.ts";

export const EVAL_HOME = nodePath.join(os.homedir(), ".threadlines-evals");
export const EVAL_CLAUDE_CONFIG_DIR = nodePath.join(EVAL_HOME, "claude");
export const EVAL_CODEX_HOME = nodePath.join(EVAL_HOME, "codex");

export class EvalSetupError extends Error {
  override readonly name = "EvalSetupError";
}

/** Environment variables that would put a run on per-use billing or another backend. */
const BILLING_OVERRIDES: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  // Credentials that would sign Claude in from outside the eval folder.
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
]);

/** The process environment without anything that could bill per use. */
export function subscriptionOnlyEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !BILLING_OVERRIDES.has(name)),
  );
}

/** Threadlines' tool endpoints (`threadlines_*`), and the Claude adapter's in-process server. */
const isOwnServer = (name: unknown) =>
  name === "threadlines" || String(name ?? "").startsWith("threadlines_");

function requireFolder(folder: string, signIn: string) {
  if (!fs.existsSync(folder)) {
    throw new EvalSetupError(`No eval sign-in at ${folder}. Sign in once: ${signIn}`);
  }
}

type CreateQuery = NonNullable<ClaudeAdapterLiveOptions["createQuery"]>;

/**
 * Wraps the real SDK query so the session runs from the eval folder with only
 * the servers Threadlines passes, and holds the first message back until the
 * session reports a subscription sign-in and only Threadlines' servers.
 * `onBlocked` hears why a session was stopped.
 */
export function makeIsolatedClaudeQuery(
  real: CreateQuery,
  onBlocked: (reason: string) => void,
): CreateQuery {
  requireFolder(
    EVAL_CLAUDE_CONFIG_DIR,
    `CLAUDE_CONFIG_DIR="${EVAL_CLAUDE_CONFIG_DIR}" claude, then /login`,
  );
  return (input) => {
    const source = input.options as unknown as { env?: NodeJS.ProcessEnv };
    const options = {
      ...input.options,
      env: {
        ...subscriptionOnlyEnvironment(source.env),
        CLAUDE_CONFIG_DIR: EVAL_CLAUDE_CONFIG_DIR,
      },
      settingSources: [],
      strictMcpConfig: true,
    } as typeof input.options;
    let runtime: ReturnType<CreateQuery> | undefined;
    const prompt = (async function* () {
      let checked = false;
      for await (const message of input.prompt) {
        if (!checked) {
          checked = true;
          const reason = await claudeSessionProblem(runtime!);
          if (reason !== null) {
            onBlocked(reason);
            throw new EvalSetupError(reason);
          }
        }
        yield message;
      }
    })();
    runtime = real({ prompt, options });
    return runtime;
  };
}

async function claudeSessionProblem(runtime: ReturnType<CreateQuery>): Promise<string | null> {
  const live = runtime as unknown as {
    initializationResult?: () => Promise<{
      account?: { subscriptionType?: string; tokenSource?: string };
    }>;
  };
  if (live.initializationResult === undefined) return "Claude didn't report its sign-in.";
  const init = await live.initializationResult();
  const account = init.account;
  if (!account?.subscriptionType) {
    return "Claude isn't signed in with a subscription in the eval folder, so it would bill per use.";
  }
  if (/api.?key/i.test(account.tokenSource ?? "")) {
    return `Claude would use an API key (${account.tokenSource}), which bills per use.`;
  }
  const servers = ((await runtime.mcpServerStatus?.()) ?? []) as ReadonlyArray<{ name?: unknown }>;
  const foreign = servers
    .filter((server) => !isOwnServer(server.name))
    .map((server) => server.name);
  return foreign.length > 0
    ? `Claude has MCP servers besides Threadlines' own (${foreign.join(", ")}).`
    : null;
}

/** The environment Claude's adapter and SDK run with in an eval. */
export const claudeEvalEnvironment = (): NodeJS.ProcessEnv => ({
  ...subscriptionOnlyEnvironment(),
  CLAUDE_CONFIG_DIR: EVAL_CLAUDE_CONFIG_DIR,
});

/**
 * Checks the Codex eval folder before a run, to fail early with a clear
 * reason: a ChatGPT sign-in, OpenAI as the model provider (no paid gateway),
 * and no MCP servers or plugins of its own (Threadlines adds its servers per
 * session). Each session is checked again before its first turn (codexGate.ts).
 */
export async function checkCodexEvalSetup(binaryPath = "codex"): Promise<void> {
  requireFolder(EVAL_CODEX_HOME, `CODEX_HOME="${EVAL_CODEX_HOME}" codex login`);
  // An empty folder, so no project's own Codex settings apply.
  const cwd = fs.mkdtempSync(nodePath.join(os.tmpdir(), "threadlines-eval-check-"));
  const child = spawn(binaryPath, ["app-server"], {
    cwd,
    env: { ...subscriptionOnlyEnvironment(), CODEX_HOME: EVAL_CODEX_HOME },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (typeof message.id === "number") pending.get(message.id)?.(message);
      } catch {
        // Not a frame.
      }
      end = buffer.indexOf("\n");
    }
  });
  let nextId = 0;
  const request = (method: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(
        () => reject(new EvalSetupError(`Codex didn't answer ${method}.`)),
        30_000,
      );
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ id, method, params: {} })}\n`);
    });
  try {
    child.stdin.write(
      `${JSON.stringify({ id: 0, method: "initialize", params: { clientInfo: { name: "threadlines-evals", version: "0" }, capabilities: { experimentalApi: true } } })}\n`,
    );
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const answer = async (method: string) => {
      const message = await request(method);
      if (message.error !== undefined || message.result === undefined) {
        throw new EvalSetupError(`Codex couldn't answer ${method}, so the setup can't be checked.`);
      }
      return message.result;
    };
    const account = (await answer("account/read")) as { account?: { type?: string } | null };
    if (account.account?.type !== "chatgpt") {
      throw new EvalSetupError(
        `Codex in the eval folder isn't signed in with ChatGPT (${account.account?.type ?? "signed out"}), so it would bill per use.`,
      );
    }
    const providers = (await answer("modelProvider/list")) as { defaultProviderId?: string };
    if (providers.defaultProviderId !== "openai") {
      throw new EvalSetupError(
        `Codex in the eval folder uses the model provider ${providers.defaultProviderId}, not OpenAI.`,
      );
    }
    const status = (await answer("mcpServerStatus/list")) as { data?: unknown };
    if (!Array.isArray(status.data)) throw new EvalSetupError("Codex didn't list its MCP servers.");
    // None at all: Threadlines adds its own per session, so any here is the folder's.
    const servers = (status.data as ReadonlyArray<{ name?: string }>).map((server) => server.name);
    if (servers.length > 0) {
      throw new EvalSetupError(
        `Codex in the eval folder has MCP servers or plugins of its own (${servers.join(", ")}). Turn them off in ${EVAL_CODEX_HOME}/config.toml ([features] apps = false, plugins = false).`,
      );
    }
  } finally {
    child.kill();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
