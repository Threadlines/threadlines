// A stand-in for the fx agent: just enough newline-delimited ACP for
// Threadlines' generic ACP driver, so the benchmark can put an agent reply in a
// thread without running a real provider. A prompt containing
// `SAY64:<base64>` is answered with exactly that decoded text (so a pull
// request address can sit in the agent's reply and not in the user's message);
// any other prompt gets one short sentence.
import readline from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("fx 0.0.99\n");
  process.exit(0);
}
if (args[0] === "status") {
  process.stdout.write(`${JSON.stringify({ auth: "key", model: "fake-model" })}\n`);
  process.exit(0);
}
if (args[0] !== "acp") {
  process.stderr.write(`fake fx: unsupported args ${args.join(" ")}\n`);
  process.exit(2);
}

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

const configOptions = (model) => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: model,
    options: [{ value: "fake-model", name: "Fake model" }],
  },
];

let sessionCounter = 0;

function reply(message) {
  const sessionId = message.params?.sessionId;
  const text = (message.params?.prompt ?? [])
    .map((block) => (block && block.type === "text" ? block.text : ""))
    .join("\n");
  const said = /SAY64:([A-Za-z0-9+/=]+)/u.exec(text);
  const answer = said ? Buffer.from(said[1], "base64").toString("utf8") : "Fake fx here.";
  send({
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } },
    },
  });
  send({ id: message.id, result: { stopReason: "end_turn" } });
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === undefined) return;
  const { method, id, params } = message;
  switch (method) {
    case "initialize":
      send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
            mcpCapabilities: { http: true, sse: false },
          },
          authMethods: [],
          agentInfo: { name: "fx", version: "0.0.99" },
        },
      });
      return;
    case "session/new":
      sessionCounter += 1;
      send({
        id,
        result: {
          sessionId: `fake-${process.pid}-${sessionCounter}`,
          configOptions: configOptions("fake-model"),
        },
      });
      return;
    case "session/set_config_option":
      send({ id, result: { configOptions: configOptions(params?.value ?? "fake-model") } });
      return;
    case "session/set_mode":
      send({ id, result: {} });
      return;
    case "session/prompt":
      reply(message);
      return;
    case "session/cancel":
      return;
    case "session/close":
      if (id !== undefined) send({ id, result: {} });
      return;
    default:
      if (id !== undefined)
        send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
lines.on("close", () => process.exit(0));
