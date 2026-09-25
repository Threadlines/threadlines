import "../../index.css";

import { page } from "vite-plus/test/browser";
import { describe, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

const noop = () => {};

const baseProps = {
  isRunning: true,
  showPlanFollowUpPrompt: false,
  promptHasText: false,
  isSendBusy: false,
  isConnecting: false,
  isEnvironmentUnavailable: false,
  isPreparingWorktree: false,
  runtimeMode: "approval-required" as const,
  runtimeModeOptions: [],
  onRuntimeModeChange: noop,
  onFollowUpDeliveryChange: noop,
  onInterrupt: noop,
  onImplementPlanInNewThread: noop,
};

// A faux composer footer so the action button is shown in the context it actually
// lives in: a rounded card surface with the textarea/placeholder on the left.
function ComposerFooterMock({
  label,
  draft,
  compact,
  hasSendableContent,
  followUpDelivery = "steer",
}: {
  label: string;
  draft: string;
  compact: boolean;
  hasSendableContent: boolean;
  followUpDelivery?: "steer" | "queue";
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="font-medium text-muted-foreground text-xs">{label}</div>
      <div className="w-[420px] rounded-2xl border border-border bg-card p-3 shadow-sm">
        <div className="min-h-9 text-sm">
          {draft ? (
            <span className="text-foreground">{draft}</span>
          ) : (
            <span className="text-muted-foreground">Message the agent…</span>
          )}
        </div>
        <div className="mt-3 flex items-center justify-end">
          <ComposerPrimaryActions
            {...baseProps}
            compact={compact}
            hasSendableContent={hasSendableContent}
            followUpDelivery={followUpDelivery}
          />
        </div>
      </div>
    </div>
  );
}

describe("ComposerPrimaryActions running-state preview", () => {
  it("captures the Steer, Queue and Stop variants", async () => {
    document.documentElement.classList.add("dark");
    const host = document.createElement("div");
    host.className = "flex flex-col gap-6 bg-background p-8";
    host.style.width = "fit-content";
    document.body.append(host);

    await render(
      <>
        <ComposerFooterMock
          label="Running · empty composer → Stop"
          draft=""
          compact={false}
          hasSendableContent={false}
        />
        <ComposerFooterMock
          label="Running · draft typed → Steer"
          draft="also rename the helper to clarify intent"
          compact={false}
          hasSendableContent={true}
        />
        <ComposerFooterMock
          label="Running · draft typed → Send when done"
          draft="then open a pull request"
          compact={false}
          hasSendableContent={true}
          followUpDelivery="queue"
        />
        <ComposerFooterMock
          label="Compact · empty → Stop"
          draft=""
          compact={true}
          hasSendableContent={false}
        />
        <ComposerFooterMock
          label="Compact · draft typed → Steer"
          draft="tweak the spacing"
          compact={true}
          hasSendableContent={true}
        />
      </>,
      { container: host },
    );

    await page.screenshot({ element: host, path: "preview-output/composer-running-actions.png" });
  });
});
