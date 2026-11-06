/**
 * Renders the starter themes' thumbnails from the real backdrop runtime, and
 * measures what each starter costs to draw.
 *
 *   node scripts/render-theme-thumbnails.ts             # writes apps/web/public/themes/<id>.png
 *   node scripts/render-theme-thumbnails.ts --measure   # frame costs at 1440×900 @2x
 *   node scripts/render-theme-thumbnails.ts --preview <dir>   # full-window shots, with sample zones and without
 *
 * Thumbnails are 320×200 PNG stills of the art (the frame's `capture-still`,
 * the same path a saved theme's still takes), drawn at 640×400 so a grid's
 * glyphs still read as texture, with color depth lowered a step at a time
 * until each fits in 60 KB. Phosphor has no art; its thumbnail is a small
 * terminal in its colors and font. Re-run after changing a starter's art or
 * colors.
 *
 * Uses the Playwright that apps/web's browser tests install
 * (`vp run --filter @threadlines/web test:browser:install`). The browser
 * side is a small harness page; this file only drives it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BackdropZone, ThemeManifest } from "@threadlines/contracts";
import { glassTextColors } from "@threadlines/shared/themeContrast";
import { STARTER_THEMES } from "@threadlines/shared/themeStarters";
import { resolveThemeTokens } from "@threadlines/shared/themeTokens";

const here = dirname(fileURLToPath(import.meta.url));
const outputDirectory = join(here, "..", "apps", "web", "public", "themes");

/**
 * The frame document. Imported by name at run time: its module is browser
 * code, typed against the DOM, which this package doesn't compile with.
 */
interface BackdropFrameModule {
  readonly BACKDROP_FRAME_SANDBOX: string;
  readonly buildBackdropFrameDocument: (options?: { readonly testHooks?: boolean }) => string;
}
const frameModuleName = "@threadlines/shared/themeBackdropFrame";
const frameModule = (await import(frameModuleName)) as BackdropFrameModule;

/** The few Playwright calls this script makes, typed here: it isn't a dependency of scripts/. */
interface Page {
  setContent(html: string): Promise<void>;
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  screenshot(options: { path?: string; type?: "png" }): Promise<Uint8Array>;
  close(): Promise<void>;
}
interface Browser {
  newPage(options: {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
  }): Promise<Page>;
  close(): Promise<void>;
}
interface Playwright {
  chromium: { launch(options: { args?: string[] }): Promise<Browser> };
}

const playwright = createRequire(join(here, "..", "apps", "web", "package.json"))(
  "playwright",
) as Playwright;

/** What the harness page (HARNESS below) offers, as data in and data out. */
interface Harness {
  start(input: { sandbox: string; document: string; messages: unknown[] }): Promise<void>;
  ask(input: { message: unknown; answer: string }): Promise<unknown>;
  failures(): unknown[];
  reduceColors(input: { dataUrl: string; mask: number }): Promise<string>;
  renderer(): string;
}
/** The harness as page callbacks reach it. Each callback runs in the page, so it can use only what it names itself. */
type HarnessScope = { harness: Harness };

/**
 * The browser side: loads the frame, sends it the given messages once it is
 * ready, collects what it says, and reduces a PNG's color depth.
 */
const HARNESS = `<!doctype html><html><body style="margin:0;background:#000"><script>
const received = [];
let frame = null;
window.harness = {
  start(input) {
    return new Promise((done) => {
      frame = document.createElement("iframe");
      frame.setAttribute("sandbox", input.sandbox);
      frame.srcdoc = input.document;
      frame.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;border:0";
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        received.push(event.data);
        if (event.data && event.data.type === "ready") {
          for (const message of input.messages) frame.contentWindow.postMessage(message, "*");
          done();
        }
      });
      document.body.appendChild(frame);
    });
  },
  ask(input) {
    const start = received.length;
    frame.contentWindow.postMessage(input.message, "*");
    return new Promise((done, fail) => {
      const began = Date.now();
      const look = () => {
        const found = received.slice(start).find((entry) => entry && entry.type === input.answer);
        if (found) done(found);
        else if (Date.now() - began > 10000) fail(new Error("no " + input.answer));
        else setTimeout(look, 50);
      };
      look();
    });
  },
  failures() {
    return received.filter((entry) => entry && entry.type === "failure");
  },
  async reduceColors(input) {
    const image = new Image();
    image.src = input.dataUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let at = 0; at < pixels.data.length; at += 4) {
      pixels.data[at] &= input.mask;
      pixels.data[at + 1] &= input.mask;
      pixels.data[at + 2] &= input.mask;
    }
    context.putImageData(pixels, 0, 0);
    return canvas.toDataURL("image/png");
  },
  renderer() {
    const context = document.createElement("canvas").getContext("webgl2");
    const info = context && context.getExtension("WEBGL_debug_renderer_info");
    return info ? String(context.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "unknown";
  },
};
</script></body></html>`;

interface Probe {
  fps: number;
  throttle: number;
  costs: { count: number; p50: number; p90: number; max: number };
  own: { count: number; p50: number; p90: number; max: number };
  tints: Record<string, number>;
}

/** A layout like the app's thread view: title row, thread list, reading column, composer. */
function sampleZones(width: number, height: number, manifest: ThemeManifest): BackdropZone[] {
  const glass = manifest.glass!;
  const tintColor = manifest.colors.background;
  const hard = (id: string, rect: BackdropZone["rect"], tint: number): BackdropZone => ({
    id,
    edge: "hard",
    shape: "rect",
    rect,
    core: rect,
    tint,
    tintColor,
  });
  const column = { x: width * 0.3, y: 52, w: Math.min(720, width * 0.5), h: height - 220 };
  return [
    hard("frame", { x: 0, y: 0, w: width, h: 40 }, glass.frame),
    hard("list", { x: 0, y: 40, w: 270, h: height - 40 }, glass.list),
    {
      id: "column",
      edge: "soft",
      shape: "rect",
      rect: { x: column.x - 60, y: column.y - 20, w: column.w + 120, h: column.h + 40 },
      core: column,
      tint: glass.column,
      tintColor,
    },
    hard("composer", { x: column.x, y: height - 150, w: column.w, h: 120 }, glass.composer),
  ];
}

/** Loads the frame into a page and starts a starter's art in it, in a window of the page's size. */
async function startArt(
  page: Page,
  manifest: ThemeManifest,
  size: { width: number; height: number; dpr: number },
  zones: BackdropZone[],
  working: number,
) {
  const tokens = resolveThemeTokens(manifest);
  const texts = glassTextColors(tokens);
  const backdrop = manifest.backdrop!;
  await page.setContent(HARNESS);
  await page.evaluate((input) => (globalThis as unknown as HarnessScope).harness.start(input), {
    sandbox: frameModule.BACKDROP_FRAME_SANDBOX,
    document: frameModule.buildBackdropFrameDocument({ testHooks: true }),
    messages: [
      {
        type: "init",
        mode: backdrop.mode,
        script: backdrop.script,
        maxFps: backdrop.maxFps,
        base: manifest.base,
        palette: { ...tokens },
        textColors: texts.map((text) => text.color),
        textRatios: texts.map((text) => text.ratio),
        blur: manifest.glass?.blur ?? 16,
      },
      { type: "viewport", ...size },
      { type: "zones", zones },
      { type: "activity", activity: { working, waiting: 0 } },
      {
        type: "conditions",
        conditions: {
          motion: "live",
          visible: true,
          busy: false,
          idle: false,
          focused: false,
          power: "ac",
          thermal: "nominal",
        },
      },
    ],
  });
}

const ask = <T>(page: Page, message: Record<string, unknown>, answer: string) =>
  page.evaluate((input) => (globalThis as unknown as HarnessScope).harness.ask(input), {
    message,
    answer,
  }) as Promise<T>;
const failures = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as HarnessScope).harness.failures(), null);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Thumbnails stay small: busy art drops low bits of color, a step at a time, until the PNG fits. */
const THUMBNAIL_MAX_BYTES = 60 * 1024;

async function fitThumbnail(page: Page, dataUrl: string): Promise<Buffer> {
  for (const mask of [0xff, 0xfe, 0xfc, 0xf8, 0xf0]) {
    const url = await page.evaluate(
      (input) => (globalThis as unknown as HarnessScope).harness.reduceColors(input),
      {
        dataUrl,
        mask,
      },
    );
    const png = Buffer.from(url.slice("data:image/png;base64,".length), "base64");
    if (png.length <= THUMBNAIL_MAX_BYTES) return png;
  }
  throw new Error("A thumbnail stayed over the size limit.");
}

/** Phosphor's thumbnail: a few terminal lines in its colors and font, with its scanlines. */
function terminalSwatch(manifest: ThemeManifest): string {
  const tokens = resolveThemeTokens(manifest);
  // Double quotes in a font stack would end the inline style attribute.
  const font = (manifest.fonts?.mono?.family ?? "monospace").replaceAll('"', "'");
  const accent = manifest.colors.accent;
  const muted = tokens["muted-foreground"];
  const lines = [
    `<span style="color:${accent}">❯</span> fix the login redirect`,
    `<span style="color:${muted}">  read  src/auth/redirect.ts</span>`,
    `<span style="color:${muted}">  edit  src/auth/redirect.ts</span> <span style="color:${accent}">+12 −3</span>`,
    `<span style="color:${muted}">  ran   typecheck</span> <span style="color:${accent}">ok</span>`,
    `<span style="color:${accent}">❯</span> <span style="background:${accent}">&nbsp;</span>`,
  ];
  return `<!doctype html><html><body style="margin:0;width:320px;height:200px;overflow:hidden;background:${manifest.colors.background};font:13px/1.65 ${font};color:${manifest.colors.foreground}">
<div style="padding:26px 22px;white-space:pre;text-shadow:0 0 6px ${accent}55">${lines.join("\n")}</div>
<div style="position:fixed;inset:0;background:repeating-linear-gradient(0deg,rgba(0,0,0,.22) 0 1px,transparent 1px 3px)"></div>
</body></html>`;
}

async function renderThumbnails(browser: Browser) {
  mkdirSync(outputDirectory, { recursive: true });
  for (const { id, manifest } of STARTER_THEMES) {
    let png: Buffer;
    if (manifest.backdrop) {
      const size = { width: 640, height: 400, dpr: 1 };
      const page = await browser.newPage({ viewport: size, deviceScaleFactor: size.dpr });
      await startArt(page, manifest, size, [], 0);
      await sleep(3_000);
      const still = await ask<{ dataUrl: string }>(
        page,
        { type: "capture-still", requestId: `thumb-${id}`, width: 320, height: 200 },
        "still",
      );
      const problems = await failures(page);
      if (problems.length > 0) throw new Error(`${id} failed: ${JSON.stringify(problems)}`);
      png = await fitThumbnail(page, still.dataUrl);
      await page.close();
    } else {
      const page = await browser.newPage({
        viewport: { width: 320, height: 200 },
        deviceScaleFactor: 1,
      });
      await page.setContent(terminalSwatch(manifest));
      png = Buffer.from(await page.screenshot({ type: "png" }));
      await page.close();
    }
    writeFileSync(join(outputDirectory, `${id}.png`), png);
    console.log(`${id}.png ${(png.length / 1024).toFixed(1)} KB`);
  }
}

async function measure(browser: Browser) {
  const size = { width: 1440, height: 900, dpr: 2 };
  const first = await browser.newPage({
    viewport: { width: 100, height: 100 },
    deviceScaleFactor: 1,
  });
  await first.setContent(HARNESS);
  console.log(
    `WebGL renderer: ${await first.evaluate(() => (globalThis as unknown as HarnessScope).harness.renderer(), null)}`,
  );
  await first.close();
  console.log(
    "starter        state    fps  frames  cost p50/p90 ms  frame's own p50/p90 ms  throttled",
  );
  for (const { id, manifest } of STARTER_THEMES) {
    if (!manifest.backdrop) continue;
    for (const working of [0, 1]) {
      const page = await browser.newPage({ viewport: size, deviceScaleFactor: size.dpr });
      await startArt(page, manifest, size, sampleZones(size.width, size.height, manifest), working);
      await sleep(12_500);
      const probe = await ask<Probe>(page, { type: "test:probe" }, "test:probe");
      const problems = await failures(page);
      console.log(
        [
          id.padEnd(14),
          working ? "working" : "idle   ",
          probe.fps.toFixed(0).padStart(4),
          String(probe.costs.count).padStart(7),
          ` ${probe.costs.p50.toFixed(2)} / ${probe.costs.p90.toFixed(2)}      `,
          ` ${probe.own.p50.toFixed(2)} / ${probe.own.p90.toFixed(2)}            `,
          probe.throttle > 0 ? "yes" : "no",
          problems.length ? `FAILED ${JSON.stringify(problems)}` : "",
        ].join(" "),
      );
      await page.close();
    }
  }
}

async function preview(browser: Browser, directory: string) {
  mkdirSync(directory, { recursive: true });
  const size = { width: 1440, height: 900, dpr: 1 };
  for (const { id, manifest } of STARTER_THEMES) {
    if (!manifest.backdrop) continue;
    const page = await browser.newPage({ viewport: size, deviceScaleFactor: size.dpr });
    await startArt(page, manifest, size, sampleZones(size.width, size.height, manifest), 0);
    await sleep(3_000);
    await page.screenshot({ path: join(directory, `${id}.png`) });
    const probe = await ask<Probe>(page, { type: "test:probe" }, "test:probe");
    console.log(id, JSON.stringify(probe.tints));
    // The same moment of art with nothing over it, as the new-thread screen's margins show it.
    await ask(page, { type: "zones", zones: [] }, "heartbeat");
    await sleep(300);
    await page.screenshot({ path: join(directory, `${id}-art.png`) });
    await page.close();
  }
}

const args = process.argv.slice(2);
const browser = await playwright.chromium.launch({
  args: ["--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
});
try {
  if (args.includes("--measure")) await measure(browser);
  else if (args.includes("--preview")) {
    const directory = args[args.indexOf("--preview") + 1];
    if (!directory) throw new Error("--preview needs a directory");
    await preview(browser, resolve(directory));
  } else await renderThumbnails(browser);
} finally {
  await browser.close();
}
