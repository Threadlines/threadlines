import type { DesktopBridge, PreviewAutomationRequest } from "@threadlines/contracts";
import { describe, expect, it } from "vitest";

import { createPreviewAutomationHandler } from "./previewAutomationHost";

const request = (
  operation: PreviewAutomationRequest["operation"],
  input: PreviewAutomationRequest["input"] = {},
): PreviewAutomationRequest => ({ requestId: "r1", operation, input });

const handlerFor = (
  bridge: Partial<DesktopBridge>,
  webContentsId: number | null = 42,
  navigate: (url: string) => Promise<void> = () => Promise.resolve(),
) => createPreviewAutomationHandler(bridge as DesktopBridge, () => ({ webContentsId, navigate }));

describe("createPreviewAutomationHandler", () => {
  it("sends the operation's input to the bridge along with the tab it acts on", async () => {
    const seen: unknown[] = [];
    const handle = handlerFor({
      previewClick: (input) => {
        seen.push(input);
        return Promise.resolve();
      },
    });

    const response = await handle(request("click", { target: { ref: 7 } }));

    // The tab is the host's business, not the agent's: it never names one.
    expect(seen).toEqual([{ webContentsId: 42, target: { ref: 7 } }]);
    expect(response).toEqual({ requestId: "r1", result: undefined });
  });

  it("answers with the failure instead of rejecting", async () => {
    // A rejection would leave the broker waiting out its whole timeout for
    // something already known, and the agent needs the reason to pick its next
    // move -- a bad selector means re-snapshot, not give up.
    const handle = handlerFor({
      previewClick: () => Promise.reject(new Error('no element matches selector ".gone"')),
    });

    const response = await handle(request("click", { target: { selector: ".gone" } }));

    expect(response.error).toBe('no element matches selector ".gone"');
    expect(response.requestId).toBe("r1");
  });

  it("strips Electron's wrapper off a main-process failure", async () => {
    // Electron prefixes anything thrown across IPC, which buries the sentence
    // the agent actually needs under something that reads like a broken tool.
    const handle = handlerFor({
      previewType: () =>
        Promise.reject(
          new Error(
            "Error invoking remote method 'desktop:preview-type': Error: target is not editable",
          ),
        ),
    });

    const response = await handle(request("type", { target: { ref: 1 }, text: "hi" }));

    expect(response.error).toBe("target is not editable");
  });

  it("says so when the panel is open but has no page", async () => {
    const handle = handlerFor(
      { previewSnapshot: () => Promise.reject(new Error("unreachable")) },
      null,
    );

    const response = await handle(request("snapshot"));

    expect(response.error).toContain("no page loaded");
  });

  it("reports an operation this build cannot perform rather than hanging", async () => {
    // The bridge and the advertised operation list are built from the same
    // contract, so a gap here means they drifted -- which should be a loud
    // answer, not a twenty second silence.
    const handle = handlerFor({});

    const response = await handle(request("press", { key: "Enter" }));

    expect(response.error).toContain("cannot perform press");
  });
});
