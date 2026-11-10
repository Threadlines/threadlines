import "../index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { WorkingAnchorDots } from "../components/chat/WorkingAnchorDots";
import { readAfterEachPaint } from "./frameProbe.browser-harness";
import { installSteppedLoops, UNATTENDED_LOOP_FPS } from "./steppedLoops";

// Boxes sliding 300px a second, forever. At 30 poses a second one only ever
// sits on a multiple of 10px; at 10 a second, on a multiple of 30px.
const SCENE = (
  <div style={{ position: "relative", width: 400, height: 60 }}>
    <style>{`
      @keyframes test-slide { from { transform: translateX(0); } to { transform: translateX(300px); } }
      .test-loop { position: absolute; left: 0; width: 4px; height: 4px; animation: test-slide 1s linear infinite; }
      .test-stepped { --loop-fps: 30; }
    `}</style>
    <div data-loop="plain" className="test-loop" style={{ top: 0 }} />
    <div data-loop="stepped" className="test-loop test-stepped" style={{ top: 10 }} />
    <div
      data-loop="late"
      className="test-loop test-stepped"
      style={{ top: 20, animationDuration: "2s", animationDelay: "137ms" }}
    />
    <div
      data-loop="held"
      className="test-loop test-stepped"
      style={{ top: 30, animationPlayState: "paused" }}
    />
  </div>
);

const POSE_MS = 1000 / 30;

function loopOf(name: string): { element: HTMLElement; animation: Animation } {
  const element = document.querySelector<HTMLElement>(`[data-loop="${name}"]`);
  const animation = element?.getAnimations()[0];
  if (!element || !animation) throw new Error(`no loop ${name}`);
  return { element, animation };
}

const isStepped = (animation: Animation) =>
  String(animation.effect?.getTiming().easing).startsWith("steps(");

/** Where a loop's box stands on every frame drawn over `ms`, in px from where it starts. */
async function positionsOver(name: string, ms: number): Promise<number[]> {
  const { element } = loopOf(name);
  const origin = element.parentElement!.getBoundingClientRect().left;
  const positions: number[] = [];
  const stop = readAfterEachPaint(() =>
    positions.push(element.getBoundingClientRect().left - origin),
  );
  await new Promise((resolve) => setTimeout(resolve, ms));
  stop();
  return positions;
}

const offGrid = (positions: ReadonlyArray<number>, grid: number) =>
  positions.filter((x) => Math.abs(x - Math.round(x / grid) * grid) > 0.01);

/** How far the moment a loop's first pose begins is from the grid stepped loops share, in ms. */
function msOffSharedGrid(animation: Animation): number {
  const begins = Number(animation.startTime) + (animation.effect?.getComputedTiming().delay ?? 0);
  const past = ((begins % POSE_MS) + POSE_MS) % POSE_MS;
  return Math.min(past, POSE_MS - past);
}

describe("installSteppedLoops", () => {
  let uninstall: (() => void) | undefined;
  let inFront = true;
  let attentionChanged: (() => void) | undefined;
  /** Puts this window in front of every other app, or behind one. */
  const setInFront = (next: boolean) => {
    inFront = next;
    attentionChanged?.();
  };
  const install = () => {
    inFront = true;
    uninstall = installSteppedLoops({
      isAttended: () => inFront,
      onChange: (listener) => {
        attentionChanged = listener;
        return () => {
          attentionChanged = undefined;
        };
      },
    });
  };
  const hasBegun = (name: string) => typeof loopOf(name).animation.startTime === "number";
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it("shows a loop that asks for it 30 poses a second, on the grid stepped loops share, and leaves other loops alone", async () => {
    const screen = await render(SCENE);
    try {
      // It arrives after startup: these loops are already running, one still in its delay.
      await vi.waitFor(() => expect(hasBegun("stepped")).toBe(true));
      install();
      await vi.waitFor(() => {
        expect(isStepped(loopOf("stepped").animation)).toBe(true);
        expect(isStepped(loopOf("late").animation)).toBe(true);
      });
      const [plain, stepped] = await Promise.all([
        positionsOver("plain", 500),
        positionsOver("stepped", 500),
      ]);
      expect(new Set(stepped).size).toBeGreaterThan(2);
      expect(offGrid(stepped, 10)).toEqual([]);
      expect(offGrid(plain, 10).length).toBeGreaterThan(0);
      expect(isStepped(loopOf("plain").animation)).toBe(false);
      // Started at another moment, with a delay and another length: the same grid.
      expect(msOffSharedGrid(loopOf("stepped").animation)).toBeLessThan(0.05);
      expect(msOffSharedGrid(loopOf("late").animation)).toBeLessThan(0.05);
      // A loop that began paused sent its start before it ran: it is stepped as it comes around.
      loopOf("held").element.style.animationPlayState = "running";
      await vi.waitFor(() => expect(isStepped(loopOf("held").animation)).toBe(true), {
        timeout: 5_000,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("slows stepped loops while another app is in front, and brings them back", async () => {
    install();
    const screen = await render(SCENE);
    try {
      await vi.waitFor(() => expect(isStepped(loopOf("stepped").animation)).toBe(true));

      setInFront(false);
      const behind = await positionsOver("stepped", 500);
      expect(new Set(behind).size).toBeGreaterThan(1);
      expect(offGrid(behind, 300 / UNATTENDED_LOOP_FPS)).toEqual([]);

      setInFront(true);
      const inFront = await positionsOver("stepped", 500);
      expect(offGrid(inFront, 10)).toEqual([]);
      expect(offGrid(inFront, 300 / UNATTENDED_LOOP_FPS).length).toBeGreaterThan(0);
    } finally {
      await screen.unmount();
    }
  });

  it("steps the working dots' loops and the status word's sheen", async () => {
    install();
    const screen = await render(
      <>
        <WorkingAnchorDots state="thinking" />
        <span className="working-shimmer">Thinking</span>
      </>,
    );
    try {
      const loops = () =>
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getTiming().iterations === Infinity);
      // Three dots turning, each pulled to the center in its own loop, and the sheen.
      // The dots' loops start .6s in.
      await vi.waitFor(
        () => {
          expect(loops().length).toBe(7);
          expect(loops().filter((animation) => !isStepped(animation))).toEqual([]);
        },
        { timeout: 5_000 },
      );
      for (const animation of loops()) {
        expect(msOffSharedGrid(animation)).toBeLessThan(0.05);
      }
    } finally {
      await screen.unmount();
    }
  });
});
