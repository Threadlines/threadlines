/**
 * Stand-ins for the services a real Pi talks to in tests: an OpenAI-compatible
 * model server driven by the prompt text, an MCP tool server, and a throwaway
 * Pi folder pointed at the model server. No keys, no network, no cost.
 *
 * The model server reads the last user message:
 *
 *   TOOL <name> <json-args>  one tool call, then "done: <result>" after it runs
 *   SLOW <ms> <text>         streams <text> over <ms>
 *   a line REPLY <text>      exactly <text> (the line may sit inside a longer prompt)
 *   anything else            "echo: <text>"
 *
 * @module provider/pi/testing/PiTestServers
 */
// @effect-diagnostics nodeBuiltinImport:off -- test servers on node:http.
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

export interface TestServer {
  readonly url: string;
  /** Request bodies, parsed, in arrival order. */
  readonly requests: Array<Record<string, unknown>>;
  readonly close: () => Promise<void>;
}

const readBody = async (request: NodeHttp.IncomingMessage) => {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body;
};

const listen = (server: NodeHttp.Server) =>
  new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });

const closeServer = (server: NodeHttp.Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) =>
            typeof part === "object" && part !== null && (part as { type?: string }).type === "text"
              ? String((part as { text?: unknown }).text ?? "")
              : "",
          )
          .join("")
      : "";

/** An OpenAI chat-completions server that answers from a script in the prompt. */
export async function startTestModelServer(): Promise<TestServer> {
  const requests: Array<Record<string, unknown>> = [];
  let calls = 0;
  const server = NodeHttp.createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "test-model", object: "model" }] }));
      return;
    }
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    requests.push(body);
    calls += 1;
    const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>;
    const last = messages.at(-1);
    const lastUser = messages.findLast((message) => message.role === "user");
    const base = {
      id: `chatcmpl-${calls}`,
      object: "chat.completion.chunk",
      created: 0,
      model: body.model,
    };
    const send = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const finish = (reason: string) => {
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: reason }] });
      send({
        ...base,
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      });
      response.end("data: [DONE]\n\n");
    };
    const sendText = async (text: string, durationMs = 0) => {
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] });
      const parts = text.match(/.{1,8}/gsu) ?? [text];
      // The first piece goes out at once, so a test sees the reply start right away.
      for (const [index, part] of parts.entries()) {
        if (durationMs > 0 && index > 0) {
          await new Promise((resolve) => setTimeout(resolve, durationMs / parts.length));
        }
        send({ ...base, choices: [{ index: 0, delta: { content: part } }] });
      }
      finish("stop");
    };
    if (last?.role === "tool") {
      await sendText(`done: ${textOf(last.content).slice(0, 80)}`);
      return;
    }
    const text = textOf(lastUser?.content).trim();
    const tool = /^TOOL (\S+) ([\s\S]*)$/u.exec(text);
    if (tool) {
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: null } }] });
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `call_${calls}`,
                  type: "function",
                  function: { name: tool[1], arguments: tool[2] },
                },
              ],
            },
          },
        ],
      });
      finish("tool_calls");
      return;
    }
    const slow = /^SLOW (\d+) ([\s\S]*)$/u.exec(text);
    if (slow) {
      await sendText(slow[2]!, Number(slow[1]));
      return;
    }
    const reply = /^REPLY (.+)$/mu.exec(text);
    if (reply) {
      await sendText(reply[1]!);
      return;
    }
    await sendText(`echo: ${text}`);
  });
  const url = await listen(server);
  return { url: `${url}/v1`, requests, close: () => closeServer(server) };
}

export interface TestMcpTool {
  readonly name: string;
  readonly readOnly: boolean;
}

/** A streamable-HTTP MCP server with the given tools; each call answers `<tool>:<args>`. */
export async function startTestMcpServer(input: {
  readonly token: string;
  readonly tools: ReadonlyArray<TestMcpTool>;
}): Promise<TestServer & { readonly calls: Array<{ name: string; args: unknown }> }> {
  const requests: Array<Record<string, unknown>> = [];
  const calls: Array<{ name: string; args: unknown }> = [];
  const server = NodeHttp.createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${input.token}`) {
      response.writeHead(401);
      response.end();
      return;
    }
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    requests.push(body);
    if (body.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    const reply = (result: unknown) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "test-session",
      });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    };
    const params = (body.params ?? {}) as Record<string, unknown>;
    switch (body.method) {
      case "initialize":
        reply({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "test", version: "1" },
        });
        return;
      case "tools/list":
        reply({
          tools: input.tools.map((tool) => ({
            name: tool.name,
            description: `Test tool ${tool.name}`,
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
            annotations: { readOnlyHint: tool.readOnly },
          })),
        });
        return;
      case "tools/call":
        calls.push({ name: String(params.name), args: params.arguments });
        reply({
          content: [
            { type: "text", text: `${String(params.name)}:${JSON.stringify(params.arguments)}` },
          ],
        });
        return;
      default:
        reply({});
    }
  });
  const url = await listen(server);
  return { url: `${url}/mcp`, requests, calls, close: () => closeServer(server) };
}

/** A fresh Pi folder whose only model is the test server's. */
export function makeTestPiHome(modelServerUrl: string): {
  readonly agentDir: string;
  readonly projectDir: string;
} {
  const root = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "threadlines-pi-test-"));
  const agentDir = NodePath.join(root, "agent");
  const projectDir = NodePath.join(root, "project");
  NodeFs.mkdirSync(agentDir, { recursive: true });
  NodeFs.mkdirSync(projectDir, { recursive: true });
  NodeFs.writeFileSync(
    NodePath.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        test: {
          baseUrl: modelServerUrl,
          api: "openai-completions",
          apiKey: "test-key",
          models: [
            {
              id: "test-model",
              name: "Test Model",
              reasoning: false,
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  );
  NodeFs.writeFileSync(
    NodePath.join(agentDir, "settings.json"),
    JSON.stringify({ defaultProvider: "test", defaultModel: "test-model" }),
  );
  return { agentDir, projectDir };
}

/** The environment a test Pi runs in: its own folder, offline, quiet. */
export const testPiEnvironment = (agentDir: string): NodeJS.ProcessEnv => ({
  ...process.env,
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
  PI_SKIP_VERSION_CHECK: "1",
});

/**
 * Pi's `cli.js` for integration tests: THREADLINES_PI_CLI, else the copy the
 * server's dev dependencies install (found by folder: Pi's package exports
 * only ES module entry points, which `require` can't resolve). Undefined
 * when neither exists.
 */
export function resolveTestPiCli(): string | undefined {
  const fromEnv = process.env.THREADLINES_PI_CLI;
  if (fromEnv && NodeFs.existsSync(fromEnv)) return fromEnv;
  let dir = NodePath.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const cli = NodePath.join(
      dir,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "bundle",
      "cli.js",
    );
    if (NodeFs.existsSync(cli)) return cli;
    const parent = NodePath.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
