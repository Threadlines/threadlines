import { page } from "vite-plus/test/browser";
import { describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { AgentActivityLine, AgentApprovalLine } from "./BrowserPanel";
import type { AgentActivity } from "./previewAutomationHost";

const activity = (overrides: Partial<AgentActivity> = {}): AgentActivity => ({
  phase: "running",
  verb: "clicked",
  detail: '"Sign in"',
  sequence: 1,
  ...overrides,
});

/**
 * The line is the answer to "is the agent doing something, or is this page
 * broken?" -- so what it says, and whether it offers a way to go and look, are
 * the whole of its job.
 */
describe("AgentActivityLine", () => {
  it("says what the agent did, in words rather than tool names", async () => {
    render(<AgentActivityLine activity={activity()} isOnAgentTab onGoToAgentTab={() => {}} />);

    await expect.element(page.getByTestId("agent-activity-line")).toBeVisible();
    expect((await page.getByTestId("agent-activity-line").element()).textContent).toContain(
      'clicked "Sign in"',
    );
  });

  it("is inert while you are already on the agent's tab", async () => {
    // Nowhere to go, and a button that does nothing is worse than no button.
    render(<AgentActivityLine activity={activity()} isOnAgentTab onGoToAgentTab={() => {}} />);

    await expect.element(page.getByTestId("agent-activity-line")).toBeVisible();
    expect((await page.getByTestId("agent-activity-line").element()).tagName).toBe("DIV");
  });

  it("offers a way over when you are looking at another tab", async () => {
    render(
      <AgentActivityLine activity={activity()} isOnAgentTab={false} onGoToAgentTab={() => {}} />,
    );

    await expect.element(page.getByTestId("agent-activity-line")).toBeVisible();
    const line = await page.getByTestId("agent-activity-line").element();
    expect(line.tagName).toBe("BUTTON");
    expect(line.textContent).toContain("show");
  });

  it("reads without a subject when the action had none", async () => {
    render(
      <AgentActivityLine
        activity={activity({ verb: "read the page", detail: null })}
        isOnAgentTab
        onGoToAgentTab={() => {}}
      />,
    );

    await expect.element(page.getByTestId("agent-activity-line")).toBeVisible();
    const text = (await page.getByTestId("agent-activity-line").element()).textContent ?? "";
    expect(text).toContain("read the page");
    expect(text).not.toContain("null");
  });
});

/**
 * The same line asking rather than reporting. Its job is to name the site and
 * to make the two answers reachable -- a line that says a site was blocked
 * without a way to allow it just strands the agent.
 */
describe("AgentApprovalLine", () => {
  it("names the site the agent is asking for", async () => {
    render(<AgentApprovalLine host="docs.example.com" onAllow={() => {}} onDismiss={() => {}} />);

    await expect.element(page.getByTestId("browser-approval-bar")).toBeVisible();
    expect((await page.getByTestId("browser-approval-bar").element()).textContent).toContain(
      "wants to visit docs.example.com",
    );
  });

  it("offers allowing it for the project, and declining", async () => {
    // Allow is the whole feature; Not now has to exist beside it, or the only
    // way past the line is to say yes.
    const answers: string[] = [];
    render(
      <AgentApprovalLine
        host="docs.example.com"
        onAllow={() => answers.push("allow")}
        onDismiss={() => answers.push("dismiss")}
      />,
    );

    await page.getByTestId("browser-approval-allow").click();
    await page.getByTestId("browser-approval-dismiss").click();

    expect(answers).toEqual(["allow", "dismiss"]);
  });
});
