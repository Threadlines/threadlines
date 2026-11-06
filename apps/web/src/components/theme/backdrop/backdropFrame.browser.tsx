import type { BackdropZone } from "@threadlines/contracts";
import {
  BACKDROP_FRAME_SANDBOX,
  buildBackdropFrameDocument,
} from "@threadlines/shared/themeBackdropFrame";
import { color, formatHex, relativeLuminance } from "@threadlines/shared/themeColor";
import { glassTextColors } from "@threadlines/shared/themeContrast";
import { BUILTIN_THEME_TOKENS } from "@threadlines/shared/themeBuiltinTokens";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// The backdrop frame (packages/shared themes/backdropRuntime.ts) driven by hand,
// the way ThemeBackdropHost drives it, with its test hooks on.

type Message = Record<string, unknown> & { type: string };
interface Probe {
  tints: Record<string, number>;
  boxes: Record<string, { maxR: number; maxG: number; maxB: number }>;
  worst: Record<string, { low: number; high: number }>;
  drawnFrames: number;
  ticks: number;
  generation: number;
  workerAlive: boolean;
  throttle: number;
  t: number;
  staleDropped: number;
}

const tokens = BUILTIN_THEME_TOKENS.dark;
const texts = glassTextColors(tokens);

const LIVE = {
  motion: "live",
  visible: true,
  busy: false,
  streaming: false,
  idle: false,
  focused: false,
  power: "ac",
  thermal: "nominal",
  slowdown: 0,
} as const;

/** The reading column: text in its core, feathered 40 px around it. */
const COLUMN: BackdropZone = {
  id: "column",
  edge: "soft",
  shape: "rect",
  rect: { x: 160, y: 60, w: 480, h: 380 },
  core: { x: 200, y: 100, w: 400, h: 300 },
  tint: 0.2,
  tintColor: formatHex({ ...color(tokens.background), a: 1 }),
};

async function mountFrame() {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", BACKDROP_FRAME_SANDBOX);
  frame.srcdoc = buildBackdropFrameDocument({ testHooks: true });
  frame.style.cssText = "position:fixed;left:0;top:0;width:800px;height:500px;border:0";
  const messages: Message[] = [];
  const onMessage = (event: MessageEvent) => {
    if (event.source === frame.contentWindow) messages.push(event.data as Message);
  };
  window.addEventListener("message", onMessage);
  document.body.appendChild(frame);
  await vi.waitFor(() => expect(messages.some((message) => message.type === "ready")).toBe(true));
  const post = (message: Record<string, unknown>) => frame.contentWindow?.postMessage(message, "*");
  /** The frame's state; `measure` also reads back each zone's frost box and tint (a GPU wait). */
  const probe = async (measure = false) => {
    const before = messages.length;
    post({ type: "test:probe", measure });
    return vi.waitFor(() => {
      const found = messages.slice(before).find((message) => message.type === "test:probe");
      if (!found) throw new Error("no probe answer yet");
      return found as unknown as Probe;
    });
  };
  const start = (
    mode: "grid" | "pixels" | "canvas",
    script: string,
    zones: BackdropZone[] = [],
    textColors: ReadonlyArray<{ color: string; ratio: number }> = texts,
  ) => {
    post({
      type: "init",
      mode,
      script,
      maxFps: 24,
      base: "dark",
      palette: { ...tokens },
      textColors: textColors.map((text) => text.color),
      textRatios: textColors.map((text) => text.ratio),
      blur: 16,
    });
    post({ type: "viewport", width: 800, height: 500, dpr: window.devicePixelRatio || 1 });
    post({ type: "zones", zones });
    post({ type: "activity", activity: { working: 0, waiting: 0 } });
    post({ type: "conditions", conditions: LIVE });
  };
  const failure = (timeout = 8_000) =>
    vi.waitFor(
      () => {
        const found = messages.find((message) => message.type === "failure");
        if (!found) throw new Error("no failure yet");
        return found as Message & { reason: string; detail?: string };
      },
      { timeout, interval: 50 },
    );
  const framesAbove = (count: number) =>
    vi.waitFor(
      async () => {
        const answer = await probe();
        expect(answer.drawnFrames).toBeGreaterThan(count);
        return answer;
      },
      { timeout: 6_000, interval: 50 },
    );
  const dispose = () => {
    window.removeEventListener("message", onMessage);
    frame.remove();
  };
  return { post, messages, probe, start, failure, framesAbove, dispose };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const GRID_ART = `threadlines.backdrop({
  mode: "grid", cell: { width: 10, height: 14 }, glyphs: " .:+#",
  draw(grid, info) {
    for (let i = 0; i < grid.glyph.length; i++) {
      grid.glyph[i] = (i + Math.floor(info.t * 10)) % 5;
      grid.fg[i * 4] = 120; grid.fg[i * 4 + 1] = 200; grid.fg[i * 4 + 2] = 255; grid.fg[i * 4 + 3] = 255;
      grid.bg[i * 4 + 3] = 0;
    }
  },
});`;

/** Every glass text color, against the brightest pixel shown in the zone's core over every frame since capture began. */
function expectReadable(worst: { low: number; high: number } | undefined) {
  expect(worst).toBeDefined();
  for (const text of texts) {
    const ratio = (relativeLuminance(color(text.color)) + 0.05) / (worst!.high + 0.05);
    // 8-bit rounding of the shown pixels can land a hair under the exact ratio.
    expect([text.color, ratio >= text.ratio - 0.05]).toEqual([text.color, true]);
  }
}

let mounted: Awaited<ReturnType<typeof mountFrame>> | null = null;
afterEach(() => {
  mounted?.dispose();
  mounted = null;
});

describe("backdrop frame", () => {
  it("keeps the page's timers on time while the art spins", async () => {
    mounted = await mountFrame();
    mounted.start(
      "grid",
      `threadlines.backdrop({ mode: "grid", cell: { width: 10, height: 14 }, glyphs: " #",
        draw() { const end = performance.now() + 2500; while (performance.now() < end) {} } });`,
    );
    await vi.waitFor(async () => expect((await mounted!.probe()).ticks).toBeGreaterThan(0));
    let worst = 0;
    for (let round = 0; round < 30; round++) {
      const asked = performance.now();
      await sleep(25);
      worst = Math.max(worst, performance.now() - asked - 25);
    }
    expect(worst).toBeLessThan(50);
  });

  it("gives the art no network, nested scripts or fonts", async () => {
    mounted = await mountFrame();
    mounted.start(
      "grid",
      `const out = {};
      const settle = (key, promise) => promise.then(() => { out[key] = "open"; }, () => { out[key] = "blocked"; });
      try { settle("fetch", fetch("https://example.com/")); } catch { out.fetch = "blocked"; }
      try { const socket = new WebSocket("wss://example.com/"); socket.onopen = () => { out.socket = "open"; }; socket.onerror = () => { out.socket = "blocked"; }; } catch { out.socket = "blocked"; }
      // The prelude hides importScripts; reach the original to show the content policy holds on its own.
      try { WorkerGlobalScope.prototype.importScripts.call(self, "https://example.com/x.js"); out.scripts = "open"; } catch { out.scripts = "blocked"; }
      try { settle("font", new FontFace("x", "url(https://example.com/x.woff2)").load()); } catch { out.font = "blocked"; }
      threadlines.backdrop({ mode: "grid", cell: { width: 10, height: 14 }, glyphs: " #",
        draw() { if (Object.keys(out).length === 4) throw new Error("reach " + JSON.stringify(out)); } });`,
    );
    const failure = await mounted.failure();
    expect(failure.reason).toBe("script-error");
    const reached = JSON.parse(failure.detail!.slice(failure.detail!.indexOf("{")));
    expect(reached).toEqual({
      fetch: "blocked",
      socket: "blocked",
      scripts: "blocked",
      font: "blocked",
    });
  });

  it("terminates the worker while paused, remeasures new zones, and resumes the art's time", async () => {
    mounted = await mountFrame();
    mounted.start("grid", GRID_ART, [COLUMN]);
    await mounted.framesAbove(3);
    mounted.post({ type: "conditions", conditions: { ...LIVE, visible: false } });
    await vi.waitFor(async () => expect((await mounted!.probe()).workerAlive).toBe(false));
    const paused = await mounted.probe();
    await sleep(500);
    const later = await mounted.probe();
    expect(later.ticks).toBe(paused.ticks);
    expect(later.drawnFrames).toBe(paused.drawnFrames);

    // Zones still update while paused: the kept frame is measured again.
    mounted.post({ type: "zones", zones: [{ ...COLUMN, id: "composer" }] });
    await vi.waitFor(async () =>
      expect(Object.keys((await mounted!.probe()).tints)).toEqual(["composer"]),
    );

    const resumedAt = performance.now();
    mounted.post({ type: "conditions", conditions: LIVE });
    const resumed = await mounted.framesAbove(paused.drawnFrames + 2);
    expect(resumed.generation).toBe(paused.generation + 1);
    expect(resumed.t).toBeGreaterThan(paused.t);
    expect(resumed.t - paused.t).toBeLessThan((performance.now() - resumedAt) / 1000 + 0.3);
  });

  it("steps the rate down when ticks go unanswered, then stops the art as too heavy", async () => {
    mounted = await mountFrame();
    // In front, the art runs at its own 24 fps: even slowed twice (6 fps) a
    // reply is due within 333 ms, so a 700 ms frame misses at every rate,
    // with room to spare for a busy machine's late timers.
    mounted.start(
      "grid",
      `threadlines.backdrop({ mode: "grid", cell: { width: 10, height: 14 }, glyphs: " #",
        draw() { const end = performance.now() + 700; while (performance.now() < end) {} } });`,
    );
    mounted.post({ type: "conditions", conditions: { ...LIVE, focused: true } });
    await vi.waitFor(async () => expect((await mounted!.probe()).throttle).toBeGreaterThan(0), {
      timeout: 8_000,
      interval: 50,
    });
    expect((await mounted.failure(12_000)).reason).toBe("too-heavy");
  });

  it("counts work the art defers past its frame, and slows art that hides it there", async () => {
    mounted = await mountFrame();
    // Each frame looks free, but queues 12 ms of work to run right after its reply.
    mounted.start(
      "grid",
      `threadlines.backdrop({ mode: "grid", cell: { width: 10, height: 14 }, glyphs: " #",
        draw() { Promise.resolve().then(() => { const end = performance.now() + 12; while (performance.now() < end) {} }); } });`,
    );
    await vi.waitFor(async () => expect((await mounted!.probe()).throttle).toBeGreaterThan(0), {
      timeout: 12_000,
      interval: 250,
    });
  });

  it("keeps column text readable when the art turns white", async () => {
    mounted = await mountFrame();
    mounted.start(
      "grid",
      `threadlines.backdrop({ mode: "grid", cell: { width: 10, height: 14 }, glyphs: " #",
        draw(grid, info) {
          const white = info.t > 1;
          for (let i = 0; i < grid.glyph.length; i++) {
            grid.glyph[i] = 1;
            grid.fg.fill(white ? 255 : 30, i * 4, i * 4 + 4);
            grid.bg.fill(white ? 255 : 10, i * 4, i * 4 + 4);
          }
        } });`,
      [COLUMN],
    );
    mounted.post({ type: "test:capture-shown", on: true });
    await vi.waitFor(async () => expect((await mounted!.probe(true)).boxes.column?.maxR).toBe(1), {
      timeout: 6_000,
      interval: 50,
    });
    await mounted.framesAbove((await mounted.probe()).drawnFrames + 3);
    expectReadable((await mounted.probe()).worst.column);
  });

  it("keeps column text readable over one-pixel white lines on black", async () => {
    mounted = await mountFrame();
    mounted.start(
      "canvas",
      `threadlines.backdrop({ mode: "canvas", context: "2d",
        draw(ctx, info) {
          ctx.fillStyle = "#000"; ctx.fillRect(0, 0, info.width, info.height);
          ctx.fillStyle = "#fff";
          const pixel = 1 / info.scale;
          for (let x = 0; x < info.width; x += 6) ctx.fillRect(x, 0, pixel, info.height);
          for (let y = 0; y < info.height; y += 9) ctx.fillRect(0, y, info.width, pixel);
        } });`,
      [COLUMN],
    );
    mounted.post({ type: "test:capture-shown", on: true });
    await mounted.framesAbove(6);
    const answer = await mounted.probe();
    expectReadable(answer.worst.column);
    expect(mounted.messages.some((message) => message.type === "failure")).toBe(false);
  });

  it("keeps a core readable where another zone's feather in another color crosses it", async () => {
    mounted = await mountFrame();
    // A gray-tinted zone whose feather reaches into the column's core: the gray
    // needs far more tint than the column's own color to hold the same text.
    const crossing: BackdropZone = {
      id: "crossing",
      edge: "soft",
      shape: "rect",
      rect: { x: 420, y: 60, w: 360, h: 380 },
      core: { x: 640, y: 100, w: 120, h: 300 },
      tint: 0.2,
      tintColor: "#666666",
    };
    mounted.start(
      "grid",
      `threadlines.backdrop({ mode: "grid", cell: { width: 10, height: 14 }, glyphs: " #",
        draw(grid) { grid.glyph.fill(-1); grid.bg.fill(255); } });`,
      [COLUMN, crossing],
    );
    mounted.post({ type: "test:capture-shown", on: true });
    await mounted.framesAbove(6);
    expectReadable((await mounted.probe()).worst.column);
  });

  it("draws a new theme's first frame at once, even while the app is busy, and says so at once", async () => {
    mounted = await mountFrame();
    mounted.start("grid", GRID_ART, [COLUMN]);
    // Arrow keys previewing themes keep the app busy.
    mounted.post({ type: "conditions", conditions: { ...LIVE, busy: true } });
    const first = await vi.waitFor(
      () => {
        const beat = mounted!.messages.find(
          (message) => message.type === "heartbeat" && Number(message.frame) > 0,
        );
        if (!beat) throw new Error("no frame announced yet");
        return beat;
      },
      { timeout: 6_000, interval: 20 },
    );
    // Announced on the first frame, not on the next once-a-second heartbeat.
    expect(first.frame).toBe(1);
    // After it, busy holds the art.
    await sleep(300);
    expect((await mounted.probe()).drawnFrames).toBe(1);
  });

  it("keeps the art moving while a reply streams in, at half speed and a lower rate", async () => {
    mounted = await mountFrame();
    mounted.start("grid", GRID_ART, [COLUMN]);
    // In front, the art would run at its own 24 fps and full speed.
    mounted.post({ type: "conditions", conditions: { ...LIVE, focused: true, streaming: true } });
    await mounted.framesAbove(2);
    // Past the ease, art time runs at about half the clock's.
    await sleep(1_000);
    const before = await mounted.probe();
    const startedAt = performance.now();
    await sleep(1_500);
    const after = await mounted.probe();
    const seconds = (performance.now() - startedAt) / 1000;
    expect(after.drawnFrames).toBeGreaterThan(before.drawnFrames);
    expect((after.t - before.t) / seconds).toBeLessThan(0.75);
    expect(after.drawnFrames - before.drawnFrames).toBeLessThan(seconds * 16);
  });

  it("runs at a quarter of its rate when the CPU watchdog has slowed it twice, and says it is throttled", async () => {
    mounted = await mountFrame();
    mounted.start("grid", GRID_ART, [COLUMN]);
    mounted.post({ type: "conditions", conditions: { ...LIVE, slowdown: 2 } });
    const stats = await vi.waitFor(
      () => {
        const all = mounted!.messages.filter(
          (message) => message.type === "stats" && Number(message.fps) > 0,
        );
        if (all.length < 2) throw new Error("not enough stats yet");
        return all.at(-1)!;
      },
      { timeout: 10_000, interval: 100 },
    );
    // Behind other apps the art runs at 10 fps; slowed twice, 2.5.
    expect(Number(stats.fps)).toBeLessThan(5);
    expect(stats.throttled).toBe(true);
  });

  it("rounds a hard zone's corners like the surface over it, leaving the corners to the art", async () => {
    mounted = await mountFrame();
    // White glass over black art: a square zone is white edge to edge; a
    // rounded one (the composer's outline) leaves its corners black.
    const hardZone = (id: string, x: number, radii?: BackdropZone["radii"]): BackdropZone => ({
      id,
      edge: "hard",
      shape: "rect",
      rect: { x, y: 100, w: 200, h: 120 },
      core: { x, y: 100, w: 200, h: 120 },
      ...(radii ? { radii } : {}),
      tint: 1,
      tintColor: "#ffffff",
    });
    mounted.start(
      "canvas",
      `threadlines.backdrop({ mode: "canvas", context: "2d",
        draw(ctx, info) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, info.width, info.height); } });`,
      [hardZone("square", 100), hardZone("round", 450, [24, 24, 24, 24])],
    );
    mounted.post({ type: "test:capture-shown", on: true });
    await mounted.framesAbove(4);
    const { worst } = await mounted.probe();
    expect(worst.square?.low).toBeGreaterThan(0.9);
    expect(worst.round?.high).toBeGreaterThan(0.9);
    expect(worst.round?.low).toBeLessThan(0.05);
  });

  it("keeps column text readable where a tint passes, fails, then passes again", async () => {
    mounted = await mountFrame();
    // Black text under green glass: red art passes with no tint, fails as
    // the green dims it, passes again near opaque. Black art beside it needs
    // most of the green, so the map must not blend the two into the gap.
    mounted.start(
      "grid",
      `threadlines.backdrop({ mode: "grid", cell: { width: 10, height: 14 }, glyphs: " #",
        draw(grid) {
          grid.glyph.fill(-1);
          for (let i = 0; i < grid.cols * grid.rows; i++) {
            const red = (i % grid.cols) < grid.cols / 2;
            grid.bg[i * 4] = red ? 255 : 0; grid.bg[i * 4 + 1] = 0; grid.bg[i * 4 + 2] = 0; grid.bg[i * 4 + 3] = 255;
          }
        } });`,
      [{ ...COLUMN, tint: 0, tintColor: "#00a000" }],
      [{ color: "#000000", ratio: 4.5 }],
    );
    mounted.post({ type: "test:capture-shown", on: true });
    await mounted.framesAbove(6);
    const darkest = (await mounted.probe()).worst.column!.low;
    // 8-bit rounding of the shown pixels can land a hair under the exact ratio.
    expect((darkest + 0.05) / 0.05).toBeGreaterThanOrEqual(4.45);
  });

  it("keeps column text readable where tiled cells let an angled background show", async () => {
    mounted = await mountFrame();
    mounted.start(
      "grid",
      `threadlines.backdrop({ mode: "grid", cell: { width: 10, height: 14 }, glyphs: " #", gap: 2,
        background: ["#000000", "#ffffff"], backgroundAngle: 90,
        draw(grid) {
          for (let i = 0; i < grid.glyph.length; i++) {
            grid.glyph[i] = -1;
            grid.bg[i * 4] = 0; grid.bg[i * 4 + 1] = 0; grid.bg[i * 4 + 2] = 0; grid.bg[i * 4 + 3] = 255;
          }
        } });`,
      [COLUMN],
    );
    mounted.post({ type: "test:capture-shown", on: true });
    await mounted.framesAbove(6);
    const answer = await mounted.probe(true);
    // Black cells, but the seams show the gradient, white toward the right, and the frost carries it.
    expect(answer.boxes.column!.maxR).toBeGreaterThan(0.1);
    expectReadable(answer.worst.column);
    expect(mounted.messages.some((message) => message.type === "failure")).toBe(false);
  });

  it("reports a lost graphics context", async () => {
    mounted = await mountFrame();
    mounted.start("grid", GRID_ART);
    await mounted.framesAbove(2);
    mounted.post({ type: "test:lose-context" });
    expect((await mounted.failure()).reason).toBe("context-lost");
  });

  it("ignores replies from a terminated worker generation", async () => {
    mounted = await mountFrame();
    mounted.start("grid", GRID_ART);
    await mounted.framesAbove(2);
    mounted.post({ type: "conditions", conditions: { ...LIVE, visible: false } });
    await vi.waitFor(async () => expect((await mounted!.probe()).workerAlive).toBe(false));
    mounted.post({ type: "conditions", conditions: LIVE });
    const resumed = await mounted.framesAbove((await mounted.probe()).drawnFrames + 1);
    mounted.post({ type: "test:replay-stale" });
    await vi.waitFor(async () =>
      expect((await mounted!.probe()).staleDropped).toBeGreaterThan(resumed.staleDropped),
    );
    await mounted.framesAbove(resumed.drawnFrames + 2);
    expect(mounted.messages.some((message) => message.type === "failure")).toBe(false);
  });
});
