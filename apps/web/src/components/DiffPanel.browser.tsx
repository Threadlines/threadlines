// Production CSS defines the app font variables consumed by the diff shadow DOM.
import "../index.css";

import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata } from "@pierre/diffs/react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { DIFF_PANEL_HOST_STYLE, DIFF_PANEL_UNSAFE_CSS } from "./DiffPanel.styles";

function createFileDiff(): FileDiffMetadata {
  const patch = [
    "diff --git a/example.ts b/example.ts",
    "index 1111111..2222222 100644",
    "--- a/example.ts",
    "+++ b/example.ts",
    "@@ -1 +1 @@",
    "-const value = 'old';",
    "+const value = 'new';",
  ].join("\n");
  const fileDiff = parsePatchFiles(patch, "diff-panel-style-browser-test").at(0)?.files.at(0);
  if (!fileDiff) {
    throw new Error("Expected test patch to produce one file diff.");
  }
  return fileDiff;
}

describe("DiffPanel typography", () => {
  it("applies app code typography to the @pierre/diffs host", async () => {
    const screen = await render(
      <FileDiff
        fileDiff={createFileDiff()}
        disableWorkerPool
        style={DIFF_PANEL_HOST_STYLE}
        options={{
          lineDiffType: "none",
          unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
        }}
      />,
    );

    try {
      await vi.waitFor(
        () => {
          expect(
            document.querySelector("diffs-container"),
            "Diff host should render.",
          ).toBeTruthy();
        },
        { timeout: 8_000, interval: 16 },
      );
      const diffHost = document.querySelector("diffs-container");
      if (!(diffHost instanceof HTMLElement)) {
        throw new Error("Diff host should render.");
      }

      const hostStyle = getComputedStyle(diffHost);
      expect(hostStyle.fontSize).toBe("12px");
      expect(hostStyle.lineHeight).toBe("20px");
      expect(hostStyle.getPropertyValue("--diffs-font-size").trim()).toBe("12px");
      expect(hostStyle.getPropertyValue("--diffs-font-family")).toContain("Cascadia Mono Variable");

      const codePre = diffHost.shadowRoot?.querySelector("pre");
      expect(codePre, "Diff code block should render inside the shadow root.").toBeTruthy();
      if (!codePre) {
        throw new Error("Diff code block should render inside the shadow root.");
      }
      expect(getComputedStyle(codePre).fontFamily).toContain("Cascadia Mono Variable");
    } finally {
      await screen.unmount();
    }
  });
});
