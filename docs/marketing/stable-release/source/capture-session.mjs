// Isolated app capture. The visible pointer tracks the same CDP mouse input that operates the UI.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const { chromium } = await import(
  pathToFileURL(
    path.join(
      root,
      "node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.mjs",
    ),
  ).href
);
export async function connect() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9225");
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().startsWith("http://127.0.0.1:6039/"));
  if (!page) throw new Error("Isolated capture app not found.");
  const cdp = await page.context().newCDPSession(page);
  let position = { x: 670, y: 620 };
  const pause = (ms) => page.waitForTimeout(ms);
  async function cursor() {
    await page.evaluate(() => {
      document.getElementById("capture-pointer")?.remove();
      const pointer = document.createElement("div");
      pointer.id = "capture-pointer";
      pointer.style.cssText =
        "position:fixed;left:670px;top:620px;width:19px;height:25px;pointer-events:none;z-index:2147483647;contain:strict";
      pointer.innerHTML =
        '<svg width="19" height="25" viewBox="0 0 19 25"><path d="M2 1.5V20l4.5-4.4 3.6 8 3.3-1.5-3.6-7.8H16Z" fill="white" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
      document.body.append(pointer);
      document.addEventListener(
        "pointermove",
        (e) => {
          pointer.style.left = e.clientX + "px";
          pointer.style.top = e.clientY + "px";
        },
        true,
      );
    });
  }
  async function move(locator, duration = 500) {
    const box =
      typeof locator === "object" && "x" in locator ? locator : await locator.boundingBox();
    if (!box) throw new Error("Capture target is not visible.");
    const target = { x: box.x + (box.width || 0) / 2, y: box.y + (box.height || 0) / 2 };
    const start = { ...position };
    const steps = Math.max(8, Math.round(duration / 33));
    await Promise.all(
      Array.from({ length: steps }, async (_, index) => {
        const i = index + 1;
        await new Promise((resolve) => setTimeout(resolve, (duration * i) / steps));
        const t = i / steps;
        const progress = t * t * (3 - 2 * t);
        const arc = Math.sin(Math.PI * t) * 9;
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: start.x + (target.x - start.x) * progress,
          y: start.y + (target.y - start.y) * progress + arc,
        });
      }),
    );
    position = target;
  }
  async function click(locator, hold = 450) {
    await locator.waitFor({ state: "visible", timeout: 12000 });
    if ((await locator.getAttribute("role")) === "tab") {
      const box = await locator.boundingBox();
      await move({ x: box.x + Math.min(18, box.width / 4), y: box.y + box.height / 2 });
    } else await move(locator);
    await pause(120);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: position.x,
      y: position.y,
      button: "left",
      clickCount: 1,
    });
    await pause(85);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: position.x,
      y: position.y,
      button: "left",
      clickCount: 1,
    });
    await pause(hold);
  }
  async function record(name, action) {
    const directory = path.join(root, "output/playwright", name);
    if (fs.existsSync(directory)) throw new Error("Use a new take name: " + name);
    fs.mkdirSync(directory, { recursive: true });
    await cursor();
    const frames = [];
    const started = performance.now();
    const onFrame = async (event) => {
      const filename = `frame-${String(frames.length).padStart(5, "0")}.jpg`;
      frames.push({ filename, at: (performance.now() - started) / 1000 });
      fs.writeFileSync(path.join(directory, filename), Buffer.from(event.data, "base64"));
      await cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId });
    };
    cdp.on("Page.screencastFrame", onFrame);
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 95,
      maxWidth: 1600,
      maxHeight: 934,
      everyNthFrame: 1,
    });
    try {
      await pause(550);
      await action();
      await pause(750);
    } finally {
      await cdp.send("Page.stopScreencast");
      cdp.off("Page.screencastFrame", onFrame);
    }
    const seconds = (performance.now() - started) / 1000;
    if (!frames.length) throw new Error("Capture is empty.");
    fs.writeFileSync(
      path.join(directory, "frames.json"),
      JSON.stringify({ seconds, cursor: "CDP input pointer", frames }, null, 2),
    );
    fs.writeFileSync(
      path.join(directory, "frames.txt"),
      frames
        .map(
          (frame, i) =>
            `file '${frame.filename}'\nduration ${Math.max(0.001, (frames[i + 1]?.at ?? seconds) - frame.at)}\n`,
        )
        .join("") + `file '${frames.at(-1).filename}'\n`,
    );
    await page.evaluate(() => document.getElementById("capture-pointer")?.remove());
    console.log(JSON.stringify({ take: name, seconds, frames: frames.length }));
  }
  return { browser, page, cdp, record, click, move, pause, root };
}
