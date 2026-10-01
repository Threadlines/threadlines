// Records the Rooms promo take in the Marketing Capture Studio
// (`node scripts/marketing-studio.ts launch`, CDP on 9223, renderer on 6066).
//
// The thread is created on the studio server (nothing runs for it there); every
// later command for it, the user's clicks included, is caught in the renderer
// and decided by engine.ts, so no provider runs and no quota is spent.
//
//   node take.ts <name>             record a take to /tmp/rooms-promo/takes/<name>
//   node take.ts <name> --rehearse  same, without recording frames
//   node take.ts --cleanup          delete every promo thread from the studio
//   --viewport=480x800              lay the app out at that size (the tall take)
//   PROMO_DEBUG=1                   log every command the app sends for the thread
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createEngine, root } from "./engine.ts";
import { createStory, OPUS, THREAD_TITLE } from "./story.ts";

const STUDIO = "/Users/Shared/Threadlines Marketing Studio/";
const RENDERER = "http://127.0.0.1:6066";
const SCALE = 2;

const args = process.argv.slice(2);
const cleanupOnly = args.includes("--cleanup");
const rehearse = args.includes("--rehearse");
const takeName = args.find((arg) => !arg.startsWith("--")) ?? `take-${Date.now()}`;
// --viewport=864x1080 lays the app out at that size (the tall and square cuts);
// --hide-sidebar gives the thread the whole width.
const viewportArg = args.find((arg) => arg.startsWith("--viewport="))?.slice("--viewport=".length);
const viewport = viewportArg
  ? { width: Number(viewportArg.split("x")[0]), height: Number(viewportArg.split("x")[1]) }
  : { width: 1600, height: 934 };
if (![viewport.width, viewport.height].every((size) => Number.isInteger(size) && size >= 320)) {
  throw new Error(`--viewport takes WIDTHxHEIGHT in CSS pixels: ${viewportArg}`);
}
const hideSidebar = args.includes("--hide-sidebar");
if (!/^[A-Za-z0-9][\w.-]*$/.test(takeName) || takeName.includes("..")) {
  throw new Error(`Take names are letters, digits, dots and dashes: ${takeName}`);
}
const outDir = path.join("/tmp/rooms-promo/takes", takeName);

const { chromium } = await import(
  pathToFileURL(
    path.join(
      root,
      "node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.mjs",
    ),
  ).href
);
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser
  .contexts()
  .flatMap((context: any) => context.pages())
  .find((candidate: any) => candidate.url().startsWith(`${RENDERER}/`));
if (!page) throw new Error("The studio renderer is not open on 6066.");
const cdp = await page.context().newCDPSession(page);
page.on("console", (message: any) => {
  if (message.type() === "error") console.error("[renderer]", message.text().slice(0, 400));
});

/** Deletes the promo threads on the studio server, then reloads to drop staged state. */
async function cleanup() {
  const removed = await page.evaluate(
    async ({ title, studio }: { title: string; studio: string }) => {
      const [{ useStore }, apiModule] = await Promise.all([
        import("/src/store.ts" as string),
        import("/src/environmentApi.ts" as string),
      ]);
      apiModule.__resetEnvironmentApiOverridesForTests();
      const state = useStore.getState();
      const env = state.activeEnvironmentId;
      const envState = state.environmentStateById[env];
      const api = apiModule.readEnvironmentApi(env);
      const promo = Object.values(envState.threadShellById).filter(
        (thread: any) =>
          thread.title === title && envState.projectById[thread.projectId]?.cwd.startsWith(studio),
      ) as any[];
      for (const thread of promo) {
        await api.orchestration.dispatchCommand({
          type: "thread.delete",
          commandId: crypto.randomUUID(),
          threadId: thread.id,
        });
      }
      return promo.length;
    },
    { title: THREAD_TITLE, studio: STUDIO },
  );
  await page.reload();
  // waitForFunction would take an async predicate's promise as truthy.
  for (let tries = 0; ; tries += 1) {
    const ready = await page
      .evaluate(async () => {
        const { useStore } = await import("/src/store.ts" as string);
        const state = useStore.getState();
        return state.environmentStateById[state.activeEnvironmentId]?.bootstrapComplete === true;
      })
      .catch(() => false);
    if (ready) break;
    if (tries > 150) throw new Error("The studio app did not finish loading.");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
  return removed;
}

console.log(JSON.stringify({ cleanedUp: await cleanup() }));
if (cleanupOnly) {
  await browser.close();
  process.exit(0);
}

// Layout changes come before the thread exists, so a failure here leaves
// nothing to clean up; the finally below undoes them.
const toggleSidebar = page.getByRole("button", { name: "Toggle main sidebar" });
if (viewportArg) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: SCALE,
    mobile: false,
  });
}
if (hideSidebar) await toggleSidebar.click();

// --- The renderer: theme, noise, the intercepting API. ---
const threadId = randomUUID();
const setup = await page.evaluate(
  async ({ threadId, studio }: { threadId: string; studio: string }) => {
    const [{ useStore }, apiModule] = await Promise.all([
      import("/src/store.ts" as string),
      import("/src/environmentApi.ts" as string),
    ]);
    localStorage.setItem("threadlines:theme", "dark");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "threadlines:theme", newValue: "dark" }),
    );
    document.getElementById("promo-style")?.remove();
    const style = document.createElement("style");
    style.id = "promo-style";
    // A capture-only toast (the stand-in gh is old) and the real usage meter.
    style.textContent = `[data-slot=toast-viewport]{display:none!important}
      li:has(> [data-testid=sidebar-usage-meter]){display:none!important}`;
    document.head.append(style);

    const state = useStore.getState();
    const env = state.activeEnvironmentId;
    const envState = state.environmentStateById[env];
    const orbit = Object.values(envState.projectById).find(
      (project: any) => project.name === "Orbit",
    ) as any;
    if (!orbit || !orbit.cwd.startsWith(studio))
      throw new Error("Refusing: Orbit is not a studio project.");

    // The studio's threads were seeded weeks ago; show them as recent work.
    // Only dates older than a day move (the seed refreshes some on launch).
    const dayAgo = Date.now() - 24 * 60 * 60_000;
    const isDate = (value: unknown): value is string =>
      typeof value === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value);
    const oldDates: number[] = [];
    const collect = (value: any) => {
      if (isDate(value) && Date.parse(value) < dayAgo) oldDates.push(Date.parse(value));
      else if (value && typeof value === "object") Object.values(value).forEach(collect);
    };
    collect(envState.sidebarThreadSummaryById);
    const delta = oldDates.length > 0 ? Date.now() - 9 * 60_000 - Math.max(...oldDates) : 0;
    const shiftDates = (value: any): any => {
      if (isDate(value))
        return Date.parse(value) < dayAgo
          ? new Date(Date.parse(value) + delta).toISOString()
          : value;
      if (Array.isArray(value)) return value.map(shiftDates);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, shiftDates(entry)]),
        );
      return value;
    };
    if (delta > 0) {
      useStore.setState((current: any) => {
        const target = current.environmentStateById[env];
        return {
          environmentStateById: {
            ...current.environmentStateById,
            [env]: {
              ...target,
              threadShellById: shiftDates(target.threadShellById),
              sidebarThreadSummaryById: shiftDates(target.sidebarThreadSummaryById),
            },
          },
        };
      });
    }

    const original = apiModule.readEnvironmentApi(env);
    const queue: any[] = [];
    apiModule.__setEnvironmentApiOverrideForTests(env, {
      ...original,
      orchestration: {
        ...original.orchestration,
        dispatchCommand: async (command: any) => {
          if (command.threadId === threadId) {
            queue.push(command);
            return { sequence: 0 };
          }
          return original.orchestration.dispatchCommand(command);
        },
      },
    });
    (window as any).__promo = {
      queue,
      apply: (events: any[]) => useStore.getState().applyOrchestrationEvents(events, env),
      forward: (command: any) => original.orchestration.dispatchCommand(command),
    };
    return { env, projectId: orbit.id, projectCwd: orbit.cwd };
  },
  { threadId, studio: STUDIO },
);

// --- The stand-in server for the thread. ---
const engine = createEngine(async (events) => {
  await page.evaluate((batch: any[]) => (window as any).__promo.apply(batch), events);
});
const now = () => new Date().toISOString();
await engine.run(
  {
    type: "project.create",
    commandId: `promo:${randomUUID()}`,
    projectId: setup.projectId,
    title: "Orbit",
    workspaceRoot: setup.projectCwd,
    createdAt: now(),
  },
  { push: false },
);
const create = {
  type: "thread.create",
  commandId: `promo:${randomUUID()}`,
  threadId,
  projectId: setup.projectId,
  title: THREAD_TITLE,
  modelSelection: OPUS,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: new Date(Date.now() - 8 * 60_000).toISOString(),
};
await engine.run(create, { push: false });
await page.evaluate((command: any) => (window as any).__promo.forward(command), create);

// Commands the app sends for the thread, decided here in order.
const waiters = new Map<string, Array<(command: any) => void>>();
const handled: string[] = [];
const polling = new AbortController();
const poll = (async () => {
  while (!polling.signal.aborted) {
    const commands = await page.evaluate(() => (window as any).__promo.queue.splice(0));
    for (const command of commands) {
      handled.push(command.type);
      if (process.env.PROMO_DEBUG) console.log("ui command", JSON.stringify(command).slice(0, 300));
      await engine.run(command);
      const pending = waiters.get(command.type);
      pending?.shift()?.(command);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
})();
const nextCommand = (type: string) =>
  new Promise<any>((resolve) => {
    waiters.set(type, [...(waiters.get(type) ?? []), resolve]);
  });

// --- Pointer, capture log. ---
const log = { marks: [] as any[], clicks: [] as any[] };
let started = performance.now();
const at = () => (performance.now() - started) / 1000;
let position = { x: 1100, y: 640 };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pointer() {
  await page.evaluate((start: { x: number; y: number }) => {
    document.getElementById("capture-pointer")?.remove();
    const element = document.createElement("div");
    element.id = "capture-pointer";
    element.style.cssText = `position:fixed;left:${start.x}px;top:${start.y}px;width:21px;height:28px;pointer-events:none;z-index:2147483647;contain:strict;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))`;
    element.innerHTML =
      '<svg width="21" height="28" viewBox="0 0 19 25"><path d="M2 1.5V20l4.5-4.4 3.6 8 3.3-1.5-3.6-7.8H16Z" fill="white" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    document.body.append(element);
    document.addEventListener(
      "pointermove",
      (event) => {
        element.style.left = `${event.clientX}px`;
        element.style.top = `${event.clientY}px`;
      },
      true,
    );
  }, position);
}

async function move(target: { x: number; y: number }, duration = 950) {
  const start = { ...position };
  const steps = Math.max(10, Math.round(duration / 16));
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const eased = t * t * (3 - 2 * t);
    const arc = Math.sin(Math.PI * t) * 10;
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: start.x + (target.x - start.x) * eased,
      y: start.y + (target.y - start.y) * eased - arc,
    });
    await pause(duration / steps);
  }
  position = target;
}

async function rect(locator: any) {
  await locator.waitFor({ state: "visible", timeout: 15_000 });
  const box = await locator.boundingBox();
  if (!box) throw new Error("Target has no box.");
  return box;
}

async function click(
  locator: any,
  options: { duration?: number; hover?: number; hold?: number } = {},
) {
  const box = await rect(locator);
  const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await move(target, options.duration);
  await pause(options.hover ?? 200);
  log.clicks.push({ at: at(), x: target.x * SCALE, y: target.y * SCALE });
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      x: target.x,
      y: target.y,
      button: "left",
      clickCount: 1,
    });
    await pause(80);
  }
  await pause(options.hold ?? 350);
}

/**
 * The user's part is done: the pointer fades where it is, then the real
 * mouse moves onto the message box's empty space, so no hover state shows
 * and nothing covers what the agents write.
 */
async function rest() {
  await pause(300);
  await page.evaluate(() => {
    const element = document.getElementById("capture-pointer");
    if (element) {
      element.style.transition = "opacity 400ms ease";
      element.style.opacity = "0";
    }
  });
  await pause(450);
  const box = await rect(page.locator('[data-lexical-editor="true"]').last());
  await move({ x: box.x + box.width * 0.8, y: box.y + box.height * 0.5 }, 300);
}

function mark(name: string) {
  log.marks.push({ name, at: at() });
  console.log(`mark ${name} @ ${at().toFixed(2)}s`);
}

// --- Frames. ---
const frames: Array<{ file: string; at: number }> = [];
async function startFrames() {
  fs.mkdirSync(outDir, { recursive: true });
  cdp.on("Page.screencastFrame", async (event: any) => {
    const file = `frame-${String(frames.length).padStart(5, "0")}.jpg`;
    frames.push({ file, at: at() });
    fs.writeFileSync(path.join(outDir, file), Buffer.from(event.data, "base64"));
    await cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 90,
    maxWidth: viewport.width * SCALE,
    maxHeight: viewport.height * SCALE,
    everyNthFrame: 1,
  });
  // The screencast sends a frame only for a paint after the last ack, so the
  // final paint before the page goes still can be lost (the footage then
  // freezes on an earlier state). One corner pixel repaints 10 times a second,
  // too faintly to see, so a later frame always follows. The reload in
  // cleanup() removes it.
  await page.evaluate(() => {
    const dot = document.createElement("div");
    dot.style.cssText =
      "position:fixed;right:0;bottom:0;width:1px;height:1px;pointer-events:none;z-index:2147483646";
    document.body.append(dot);
    let on = false;
    setInterval(() => {
      on = !on;
      dot.style.background = on ? "rgba(0,0,0,0.02)" : "rgba(0,0,0,0.01)";
    }, 100);
  });
}

// --- Where things are on screen, for the edit. ---
/**
 * Named elements the edit can frame or follow: a CSS selector (last match,
 * optionally widened to an ancestor) or a message id (its timeline row, its
 * text with `body`, or with `end` the box of its text's last line, where the
 * edit pins a label). The page samples them every 50 ms while the take records.
 */
type Target = {
  selector?: string;
  closest?: string;
  message?: string;
  body?: boolean;
  end?: boolean;
};
const TARGETS: Record<string, Target> = {
  thread: { selector: "[data-timeline-root]" },
  composer: { selector: '[data-lexical-editor="true"]', closest: "form" },
  trigger: { selector: '[data-chat-provider-model-picker="true"]' },
  picker: { selector: "[data-room-agents-section]", closest: '[data-slot="popover-popup"]' },
  working: { selector: "[data-turn-working-anchor]" },
  "side-status": { selector: "[data-side-answer-status]" },
};
async function track(name: string, target: Target) {
  TARGETS[name] = target;
  await page.evaluate(
    ({ name, target }: { name: string; target: Target }) => {
      (window as any).__promo.targets[name] = target;
    },
    { name, target },
  );
}
async function startTracking() {
  await page.evaluate(
    ({ targets, scale }: { targets: Record<string, Target>; scale: number }) => {
      const promo = (window as any).__promo;
      promo.targets = { ...targets };
      promo.samples = [];
      promo.trackStart = performance.now();
      const find = (target: Target): Element | null => {
        if (target.message !== undefined) {
          const id = CSS.escape(target.message);
          const body = document.querySelector(`[data-transcript-message-id="${id}"]`);
          // Agent request lines carry the message id on their row only.
          const row =
            body?.closest("[data-timeline-row-id]") ??
            document.querySelector(`[data-timeline-row-id="${id}"]`) ??
            document.querySelector(`[data-timeline-row-id$="${id}"]`);
          if (target.body) return body;
          if (target.end) return body ?? row;
          return row;
        }
        const all = document.querySelectorAll(target.selector ?? "");
        const last = all[all.length - 1] ?? null;
        return target.closest !== undefined ? (last?.closest(target.closest) ?? null) : last;
      };
      /** The box of the last line of visible text inside `element`. */
      const lastLine = (element: Element): DOMRect | null => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let last: DOMRect | null = null;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if ((node.textContent ?? "").trim().length === 0) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const boxes = [...range.getClientRects()].filter(
            (box) => box.width > 0 && box.height > 0,
          );
          if (boxes.length > 0) last = boxes[boxes.length - 1]!;
        }
        return last;
      };
      promo.trackTimer = setInterval(() => {
        const rects: Record<string, number[]> = {};
        for (const [name, target] of Object.entries(promo.targets as Record<string, Target>)) {
          const element = find(target);
          const box = element && target.end ? lastLine(element) : element?.getBoundingClientRect();
          if (box && box.width > 0 && box.height > 0) {
            rects[name] = [box.x, box.y, box.width, box.height].map((v) => Math.round(v * scale));
          }
        }
        promo.samples.push({ t: (performance.now() - promo.trackStart) / 1000, rects });
      }, 50);
    },
    { targets: TARGETS, scale: SCALE },
  );
}
/** The samples as per-element tracks, a point only where the rect changed. */
async function stopTracking(offset: number) {
  const samples: Array<{ t: number; rects: Record<string, number[]> }> = await page.evaluate(() => {
    const promo = (window as any).__promo;
    clearInterval(promo.trackTimer);
    return promo.samples;
  });
  const tracks: Record<string, Array<[number, ...number[]] | [number, null]>> = {};
  const last: Record<string, string> = {};
  for (const sample of samples) {
    const t = Math.round((sample.t + offset) * 1000) / 1000;
    for (const name of Object.keys(TARGETS)) {
      const rect = sample.rects[name];
      const key = rect ? rect.join(",") : "none";
      if (last[name] === key) continue;
      if (last[name] === undefined && !rect) continue;
      last[name] = key;
      (tracks[name] ??= []).push(rect ? [t, ...rect] : [t, null]);
    }
  }
  return tracks;
}

// --- The user's side of the story. ---
const composer = page.locator('[data-lexical-editor="true"]').last();
const story = createStory({
  engine,
  threadId,
  ui: {
    async addAstra() {
      const trigger = page.locator('[data-chat-provider-model-picker="true"]').last();
      await click(trigger, { duration: 1100, hover: 500, hold: 300 });
      mark("picker-open");
      await pause(1700);
      await click(page.locator('[data-room-add-agent="true"]'), { hover: 450, hold: 200 });
      mark("add-agent");
      await pause(1300);
      const codexTab = page.locator('[data-model-picker-tab="codex"]');
      if ((await codexTab.getAttribute("aria-selected")) !== "true") {
        await click(codexTab, { hover: 300, hold: 200 });
      }
      mark("codex");
      await pause(1200);
      const added = nextCommand("thread.participant.add");
      await click(
        page.locator("[data-model-picker-model-name]").filter({ hasText: /^GPT-6-Astra$/ }),
        { hover: 900, hold: 200 },
      );
      const command = await added;
      mark("added");
      await rest();
      return command.participant.id;
    },
    async sendTo(agent, text, marks) {
      // Keyboard only: the pointer has faded, so nothing crosses the chat.
      await composer.focus();
      mark(`${marks}-mention`);
      await page.keyboard.type(`@${agent}`, { delay: 110 });
      await page.locator('[data-composer-item-id^="agent:"]').first().waitFor({ timeout: 5000 });
      await pause(800);
      await page.keyboard.press("Enter");
      mark(`${marks}-recipient`);
      await pause(1400);
      mark(`${marks}-typing`);
      await page.keyboard.type(text, { delay: 55 });
      await pause(700);
      const sent = nextCommand("thread.turn.start");
      await page.keyboard.press("Enter");
      const command = await sent;
      mark(`${marks}-sent`);
      return command.message.messageId;
    },
    mark,
    track(name, messageId, part) {
      void track(name, { message: messageId, body: part === "body", end: part === "end" });
    },
    sleep: pause,
  },
});

async function until(label: string, predicate: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate().catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await pause(100);
  }
}

let seconds = 0;
let trackOffset = 0;
let tracks: Awaited<ReturnType<typeof stopTracking>> = {};
try {
  await until("the studio server to create the thread", () =>
    page.evaluate(async (threadId: string) => {
      const { useStore } = await import("/src/store.ts" as string);
      const state = useStore.getState();
      return Boolean(
        state.environmentStateById[state.activeEnvironmentId].threadShellById[threadId],
      );
    }, threadId),
  );
  await page.evaluate(
    ({ env, threadId }: { env: string; threadId: string }) => {
      location.hash = `#/${env}/${threadId}`;
    },
    { env: setup.env, threadId },
  );
  await until("the thread to open", () =>
    page.evaluate((threadId: string) => location.hash.endsWith(threadId), threadId),
  );
  await pause(1500);
  const prologue = await story.prologue();
  await pause(1200);
  await page.mouse.move(position.x, position.y);
  await pointer();
  started = performance.now();
  await startTracking();
  trackOffset = at();
  if (!rehearse) await startFrames();
  await pause(400);
  await story.take(prologue);
} finally {
  seconds = at();
  tracks = await stopTracking(trackOffset).catch(() => ({}));
  if (!rehearse) await cdp.send("Page.stopScreencast").catch(() => {});
  if (hideSidebar) await toggleSidebar.click().catch(() => {});
  if (viewportArg) await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  polling.abort();
  await poll.catch(() => {});
  // The thread's story exists only in this renderer: the server's copy has no
  // agents and no session, so a message sent in it would start a real turn.
  // Delete it and reload, which also drops the intercepting API.
  await cleanup().catch((error) => console.error("Cleanup failed; run --cleanup.", error));
}

if (!rehearse) {
  fs.writeFileSync(
    path.join(outDir, "frames.txt"),
    frames
      .map(
        (frame, index) =>
          `file '${frame.file}'\nduration ${Math.max(0.001, (frames[index + 1]?.at ?? seconds) - frame.at).toFixed(4)}\n`,
      )
      .join("") + `file '${frames.at(-1)?.file}'\n`,
  );
  fs.writeFileSync(
    path.join(outDir, "take.json"),
    JSON.stringify(
      { seconds, scale: SCALE, viewport, firstFrameAt: frames[0]?.at ?? 0, ...log, tracks },
      null,
      2,
    ),
  );
}
console.log(JSON.stringify({ take: takeName, frames: frames.length, handled, threadId }));
await browser.close();
