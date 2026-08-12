import { EnvironmentId, ThreadId } from "@threadlines/contracts";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { SidebarProvider } from "../ui/sidebar";
import { ChatHeader, formatLiveAgentsTooltip } from "./ChatHeader";

const TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function renderChatHeader(overrides: Partial<ComponentProps<typeof ChatHeader>> = {}) {
  const props = {
    activeThreadId: ThreadId.make("thread-chat-header-test"),
    activeThreadEnvironmentId: TEST_ENVIRONMENT_ID,
    activeThreadTitle: "General chat",
    activeProjectName: "General Chats",
    isGitRepo: false,
    openInCwd: null,
    activeProjectScripts: undefined,
    preferredScriptId: null,
    keybindings: [],
    availableEditors: [],
    terminalAvailable: true,
    terminalOpen: false,
    terminalToggleShortcutLabel: null,
    railToggleShortcutLabel: null,
    railOpen: false,
    sourceControlAvailable: false,
    browserAvailable: true,
    browserOpen: false,
    workingTreeDiffStat: null,
    remoteBehindCount: null,
    liveAgents: null,
    fileBrowserAvailable: false,
    taskProgress: null,
    subagentProgress: null,
    forkContext: null,
    backgroundRuns: [],
    onRunProjectScript: vi.fn(),
    onAddProjectScript: vi.fn(async () => {}),
    onUpdateProjectScript: vi.fn(async () => {}),
    onDeleteProjectScript: vi.fn(async () => {}),
    agentsPanelOpen: false,
    onToggleAgentsPanel: vi.fn(),
    onOpenForkSourceThread: vi.fn(),
    onToggleTerminal: vi.fn(),
    onToggleRail: vi.fn(),
    onToggleBrowser: vi.fn(),
    ...overrides,
  } satisfies ComponentProps<typeof ChatHeader>;

  return renderToStaticMarkup(
    <SidebarProvider>
      <ChatHeader {...props} />
    </SidebarProvider>,
  );
}

describe("ChatHeader", () => {
  it("exposes the active capture context on the rendered header", () => {
    const markup = renderChatHeader({
      activeProjectName: "Orbit",
      activeThreadTitle: "Project file editing",
    });

    expect(markup).toContain('data-active-project-name="Orbit"');
    expect(markup).toContain('data-active-thread-title="Project file editing"');
  });

  it("renders an actionable continue-in-project control by default", () => {
    const markup = renderChatHeader({ onContinueInProject: vi.fn() });

    expect(markup).toContain('aria-label="Continue in project"');
    expect(markup).toContain("cursor-pointer");
    expect(markup).not.toContain('aria-disabled="true"');
  });

  it("keeps continue-in-project visible but disabled when the current response is active", () => {
    const markup = renderChatHeader({
      continueInProjectDisabledReason:
        "Wait for the current response to finish before continuing into a project.",
      onContinueInProject: vi.fn(),
    });

    expect(markup).toContain('aria-label="Continue in project"');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('data-disabled="true"');
    expect(markup).toContain("cursor-default");
  });

  it("shows the working-tree diffstat on the closed rail toggle", () => {
    const markup = renderChatHeader({
      sourceControlAvailable: true,
      railOpen: false,
      workingTreeDiffStat: { insertions: 38, deletions: 12 },
    });

    expect(markup).toContain("+38");
    expect(markup).toContain("−12");
  });

  it("drops the diffstat once the rail is open and shows its own counts", () => {
    const markup = renderChatHeader({
      sourceControlAvailable: true,
      railOpen: true,
      workingTreeDiffStat: { insertions: 38, deletions: 12 },
    });

    expect(markup).not.toContain("+38");
    expect(markup).not.toContain("−12");
  });

  it("shows the behind-remote count on the closed rail toggle", () => {
    const markup = renderChatHeader({
      sourceControlAvailable: true,
      railOpen: false,
      remoteBehindCount: 2,
    });

    expect(markup).toContain("↓2");
  });

  it("drops the behind-remote count once the rail is open", () => {
    const markup = renderChatHeader({
      sourceControlAvailable: true,
      railOpen: true,
      remoteBehindCount: 2,
    });

    expect(markup).not.toContain("↓2");
  });

  it("nodes the closed rail toggle while agents are live, counting past one", () => {
    const single = renderChatHeader({
      railOpen: false,
      liveAgents: { count: 1, waitingCount: 0 },
    });
    expect(single).toContain('data-header-live-agents="running"');
    // One agent needs no digit; the node alone says it.
    expect(single).not.toContain("data-header-live-agents-count");

    const several = renderChatHeader({
      railOpen: false,
      liveAgents: { count: 2, waitingCount: 0 },
    });
    expect(several).toContain('data-header-live-agents="running"');
    expect(several).toContain('data-header-live-agents-count="true"');
    expect(several).toContain(">2<");
  });

  it("turns the node amber when an agent is waiting on the user", () => {
    const markup = renderChatHeader({
      railOpen: false,
      liveAgents: { count: 3, waitingCount: 1 },
    });

    expect(markup).toContain('data-header-live-agents="waiting"');
    expect(markup).toContain("bg-amber-500");
  });

  it("drops the live-agent node once the rail is open, where the Agents tab owns it", () => {
    const markup = renderChatHeader({
      railOpen: true,
      liveAgents: { count: 2, waitingCount: 0 },
    });

    expect(markup).not.toContain("data-header-live-agents");
  });
});

describe("formatLiveAgentsTooltip", () => {
  it("leads with what is running and names anything waiting", () => {
    expect(formatLiveAgentsTooltip({ count: 1, waitingCount: 0 })).toBe("1 agent running.");
    expect(formatLiveAgentsTooltip({ count: 2, waitingCount: 0 })).toBe("2 agents running.");
    expect(formatLiveAgentsTooltip({ count: 3, waitingCount: 1 })).toBe(
      "2 agents running, 1 waiting on you.",
    );
    expect(formatLiveAgentsTooltip({ count: 1, waitingCount: 1 })).toBe("1 agent waiting on you.");
  });
});
