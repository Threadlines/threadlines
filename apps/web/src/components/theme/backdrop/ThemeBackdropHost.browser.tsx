import type { BackdropConditions, ThemeBackdrop } from "@threadlines/contracts";
import { color, colorBox, minimumGlassTint } from "@threadlines/shared/themeColor";
import { glassTextColors } from "@threadlines/shared/themeContrast";
import { deriveThemeTokens } from "@threadlines/shared/themeTokens";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  ThemeBackdropHost,
  type ThemeBackdropHostHandle,
  type ThemeBackdropStatus,
} from "./ThemeBackdropHost";

// Hex tokens, as every theme with a backdrop has.
const tokens = deriveThemeTokens(
  {
    background: "#0a1029",
    foreground: "#e7ecff",
    mutedForeground: "#a3aed2",
    accent: "#2fd6b0",
    accentForeground: "#03231c",
  },
  "dark",
);

const LIVE: BackdropConditions = {
  motion: "live",
  visible: true,
  busy: false,
  idle: false,
  focused: false,
  power: "ac",
  thermal: "nominal",
};

const GRID_ART = `threadlines.backdrop({
  mode: "grid", cell: { width: 10, height: 14 }, glyphs: " .:+#",
  draw(grid, info) {
    for (let i = 0; i < grid.glyph.length; i++) {
      grid.glyph[i] = (i + Math.floor(info.t * 10)) % 5;
      grid.fg[i * 4] = 120; grid.fg[i * 4 + 1] = 200; grid.fg[i * 4 + 2] = 255; grid.fg[i * 4 + 3] = 255;
    }
  },
});`;

/** A still: the left half black, the right half white. */
function halfAndHalfStill() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 40;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#000000";
  context.fillRect(0, 0, 32, 40);
  context.fillStyle = "#ffffff";
  context.fillRect(32, 0, 32, 40);
  return canvas.toDataURL("image/png");
}

function mountHost(backdrop: ThemeBackdrop, extra: { stillOnly?: boolean } = {}) {
  const statuses: ThemeBackdropStatus[] = [];
  const ref = createRef<ThemeBackdropHostHandle>();
  const screen = render(
    <ThemeBackdropHost
      ref={ref}
      themeKey="theme-under-test"
      backdrop={backdrop}
      base="dark"
      tokens={tokens}
      blur={16}
      zones={[]}
      conditions={LIVE}
      activity={{ working: 0, waiting: 0 }}
      pulse={0}
      onStatus={(status) => statuses.push(status)}
      {...extra}
    />,
  );
  const statusOf = (kind: ThemeBackdropStatus["kind"]) =>
    vi.waitFor(
      () => {
        const found = statuses.findLast((status) => status.kind === kind);
        if (!found) throw new Error(`no ${kind} status yet`);
        return found;
      },
      { timeout: 8_000, interval: 50 },
    );
  return { statuses, ref, screen, statusOf };
}

const frameElement = () =>
  document.querySelector<HTMLIFrameElement>('iframe[name="threadlines-backdrop"]');
const stillElement = () =>
  document.querySelector<HTMLImageElement>('[data-slot="theme-backdrop-still"]');

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup) step();
  cleanup = [];
});

describe("ThemeBackdropHost", () => {
  it("runs the art in a walled-off frame and ignores messages from any other window", async () => {
    const host = mountHost({ mode: "grid", script: GRID_ART, maxFps: 20 });
    // A forged failure from the page itself, and one from another sandboxed frame.
    window.postMessage({ type: "failure", reason: "script-error" }, "*");
    const stranger = document.createElement("iframe");
    stranger.setAttribute("sandbox", "allow-scripts");
    stranger.srcdoc = `<script>parent.postMessage({ type: "failure", reason: "bad-output" }, "*");</script>`;
    document.body.appendChild(stranger);
    cleanup.push(() => stranger.remove());

    const running = await host.statusOf("running");
    expect(running.kind).toBe("running");
    expect(host.statuses.some((status) => status.kind === "failed")).toBe(false);
    const frame = frameElement()!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.hasAttribute("inert")).toBe(true);
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.style.pointerEvents).toBe("none");
  });

  it("captures a still of the running art", async () => {
    const host = mountHost({ mode: "grid", script: GRID_ART, maxFps: 20 });
    await host.statusOf("running");
    const still = await host.ref.current!.captureStill(320, 200);
    expect(still.startsWith("data:image/png;base64,")).toBe(true);
    const image = new Image();
    image.src = still;
    await image.decode();
    expect([image.naturalWidth, image.naturalHeight]).toEqual([320, 200]);
  });

  it("shows only the still on a phone, with one tint that covers all of it", async () => {
    const still = halfAndHalfStill();
    const host = mountHost(
      { mode: "grid", script: GRID_ART, maxFps: 20, still },
      { stillOnly: true },
    );
    const status = await host.statusOf("still");
    expect(status).toMatchObject({ kind: "still", reason: "phone" });
    const expected = minimumGlassTint({
      tint: color(tokens.background),
      box: colorBox([
        { r: 0, g: 0, b: 0 },
        { r: 1, g: 1, b: 1 },
      ]),
      texts: glassTextColors(tokens).map((text) => ({
        color: color(text.color),
        ratio: text.ratio,
      })),
      floor: 0,
    });
    await vi.waitFor(() =>
      expect(host.statuses.findLast((entry) => entry.kind === "still")).toMatchObject({
        minimumTint: expected,
      }),
    );
    expect(frameElement()).toBeNull();
    expect(stillElement()?.getAttribute("src")).toBe(still);
  });

  it("removes a failed frame and falls back to the still", async () => {
    const still = halfAndHalfStill();
    const host = mountHost({
      mode: "grid",
      maxFps: 20,
      still,
      script: `threadlines.backdrop({ mode: "grid", cell: { width: 10, height: 14 }, glyphs: " #",
        draw() { throw new Error("the art broke"); } });`,
    });
    const failed = await host.statusOf("failed");
    expect(failed).toMatchObject({ kind: "failed", reason: "script-error" });
    expect(failed.kind === "failed" ? failed.detail : "").toContain("the art broke");
    await vi.waitFor(() => expect(frameElement()).toBeNull());
    expect(stillElement()).not.toBeNull();
  });
});
