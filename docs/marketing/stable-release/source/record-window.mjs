// Records only the isolated Electron renderer. No desktop, system pointer, or audio.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const directory = path.resolve(process.argv[2]);
const seconds = 20;
if (!directory.includes(`${path.sep}output${path.sep}playwright${path.sep}`))
  throw new Error("Recordings must stay in output/playwright.");
if (fs.existsSync(directory)) throw new Error("Use a new take directory.");
fs.mkdirSync(directory, { recursive: true });
const targets = await (await fetch("http://127.0.0.1:9225/json/list")).json();
const target = targets.find(
  (item) => item.type === "page" && item.url.startsWith("http://127.0.0.1:6039/"),
);
if (!target) throw new Error("Isolated release capture window not found.");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let id = 0;
const pending = new Map();
const frames = [];
const start = performance.now();
function send(method, params = {}) {
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
}
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error.message));
    else waiter?.resolve(message.result);
  }
  if (message.method === "Page.screencastFrame") {
    const filename = `frame-${String(frames.length).padStart(5, "0")}.jpg`;
    fs.writeFileSync(path.join(directory, filename), Buffer.from(message.params.data, "base64"));
    frames.push({ filename, at: (performance.now() - start) / 1000 });
    void send("Page.screencastFrameAck", { sessionId: message.params.sessionId });
  }
});
await send("Page.startScreencast", {
  format: "jpeg",
  quality: 95,
  maxWidth: 1600,
  maxHeight: 934,
  everyNthFrame: 1,
});
console.log(`Recording isolated renderer for ${seconds} seconds.`);
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const click = async (label, tab = false) => {
  const result = await send("Runtime.evaluate", {
    expression: `(() => {
    const label = ${JSON.stringify(label)};
    const element = Array.from(document.querySelectorAll(${JSON.stringify(tab ? '[role="tab"]' : "button")})).find(e => e.getAttribute('aria-label') === label || e.getAttribute('title') === label || e.textContent.trim() === label);
    if (!element) throw new Error('Capture control not found: ' + label);
    element.click(); return true;
  })()`,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
};
await pause(3000);
await click("Open diff for docs/stable-release.md");
await pause(6000);
await click("Previous file");
await pause(6000);
await click("Source", true);
await pause(5000);
await send("Page.stopScreencast");
socket.close();
if (!frames.length) throw new Error("No frames received.");
const end = (performance.now() - start) / 1000;
fs.writeFileSync(
  path.join(directory, "frames.json"),
  JSON.stringify({ seconds: end, frames }, null, 2),
);
const concat = frames
  .map(
    (frame, index) =>
      `file '${frame.filename}'\nduration ${Math.max(0.001, (frames[index + 1]?.at ?? end) - frame.at)}\n`,
  )
  .join("");
fs.writeFileSync(path.join(directory, "frames.txt"), concat + `file '${frames.at(-1).filename}'\n`);
console.log(`Saved ${frames.length} frames to ${directory}.`);
