import "../../index.css";

import { describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { WorkingAnchorDots } from "./WorkingAnchorDots";

function dotPositions(root: HTMLElement): ReadonlyArray<readonly [number, number]> {
  const box = root.getBoundingClientRect();
  return Array.from(root.children, (pose) => {
    const rect = pose.getBoundingClientRect();
    return [Math.round(rect.left - box.left), Math.round(rect.top - box.top)] as const;
  });
}

/** The script hop per dot, not the CSS loop or the no-JS slide fallback. */
function scriptHops(root: HTMLElement): ReadonlyArray<ReadonlyArray<Animation>> {
  return Array.from(root.children, (pose) =>
    pose
      .getAnimations()
      .filter(
        (animation) => !("animationName" in animation) && !("transitionProperty" in animation),
      ),
  );
}

describe("WorkingAnchorDots", () => {
  it("hops every dot to the next state's pose when the state changes", async () => {
    const screen = await render(<WorkingAnchorDots state="working" />);
    try {
      const root = document.querySelector<HTMLElement>(".working-dots");
      if (!root) {
        throw new Error("dots did not render");
      }
      expect(root.dataset.state).toBe("working");
      expect(dotPositions(root)).toEqual([
        [0, 5],
        [6, 5],
        [12, 5],
      ]);

      await screen.rerender(<WorkingAnchorDots state="thinking" />);

      // React keeps the mount-time attribute; the component owns the swap.
      expect(root.dataset.state).toBe("thinking");
      const hops = scriptHops(root);
      expect(hops.map((poseHops) => poseHops.length)).toEqual([1, 1, 1]);
      await Promise.all(hops.flat().map((animation) => animation.finished));

      // Landed on the triangle, on whole pixels, before the state's own loop starts.
      expect(dotPositions(root)).toEqual([
        [6, 2],
        [2, 8],
        [10, 8],
      ]);

      // Back to the row, then straight on to another row state while the dots
      // are still resting: they are already home, so nothing bounces.
      await screen.rerender(<WorkingAnchorDots state="working" />);
      await Promise.all(
        Array.from(root.children).flatMap((pose) => pose.getAnimations().map((a) => a.finished)),
      );
      await screen.rerender(<WorkingAnchorDots state="sending" />);
      expect(root.dataset.state).toBe("sending");
      expect(scriptHops(root).map((poseHops) => poseHops.length)).toEqual([0, 0, 0]);
      expect(dotPositions(root)).toEqual([
        [0, 5],
        [6, 5],
        [12, 5],
      ]);
    } finally {
      await screen.unmount();
    }
  });
});
