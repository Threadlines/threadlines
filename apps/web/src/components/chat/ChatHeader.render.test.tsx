import { EnvironmentId } from "@threadlines/contracts";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { SidebarProvider } from "../ui/sidebar";
import type { LiveAgentIndicator } from "./agentsPanel.logic";
import { ChatHeader } from "./ChatHeader";
import { formatLiveAgentsTooltip } from "./HeaderAgentFaces";

const TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function renderChatHeader(overrides: Partial<ComponentProps<typeof ChatHeader>> = {}) {
  const props = {
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
    workingTreeChanges: null,
    remoteBehindCount: null,
    liveAgents: null,
    agentProviderDriverKind: null,
    fileBrowserAvailable: false,
    taskProgress: null,
    forkContext: null,
    backgroundRuns: [],
    activeThreadRef: null,
    onRunProjectScript: vi.fn(),
    onAddProjectScript: vi.fn(async () => {}),
    onUpdateProjectScript: vi.fn(async () => {}),
    onDeleteProjectScript: vi.fn(async () => {}),
    onToggleBackgroundRunTerminal: vi.fn(),
    onStopBackgroundRun: vi.fn(),
    onOpenForkSourceThread: vi.fn(),
    onToggleTerminal: vi.fn(),
    onToggleRail: vi.fn(),
    onToggleBrowser: vi.fn(),
    onOpenSourceTab: vi.fn(),
    onOpenAgentsTab: vi.fn(),
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

  it("makes the project crumb a menu only where there is a folder to act on", () => {
    const project = renderChatHeader({ activeProjectName: "Orbit", openInCwd: "/repo/orbit" });
    expect(project).toContain('aria-label="Orbit, project options"');

    const generalChat = renderChatHeader({ activeProjectName: "General chats", openInCwd: null });
    expect(generalChat).toContain("General chats");
    expect(generalChat).not.toContain("project options");
  });

  it("shows uncommitted changes as their own button, even with a Source tab open", () => {
    const markup = renderChatHeader({
      sourceControlAvailable: true,
      railOpen: true,
      workingTreeChanges: { insertions: 38, deletions: 12, fileCount: 3 },
      remoteBehindCount: 2,
    });

    expect(markup).toContain('data-header-source-changes="true"');
    expect(markup).toContain("+38");
    expect(markup).toContain("−12");
    expect(markup).toContain("↓2");
  });

  it("counts files when the changes add no lines", () => {
    const markup = renderChatHeader({
      sourceControlAvailable: true,
      workingTreeChanges: { insertions: 0, deletions: 0, fileCount: 2 },
    });

    expect(markup).toContain("2 files");
    expect(markup).not.toContain("+0");
  });

  it("leaves the change count out where there is no Source tab to open", () => {
    const markup = renderChatHeader({
      sourceControlAvailable: false,
      workingTreeChanges: { insertions: 38, deletions: 12, fileCount: 3 },
    });

    expect(markup).not.toContain("data-header-source-changes");
  });

  it("draws a face per live agent, waiting ones first, and folds the rest into a count", () => {
    const agents: LiveAgentIndicator["agents"] = [
      { id: "a", name: "Review", waiting: true, startedAt: "2026-08-11T10:00:00.000Z" },
      ...["b", "c", "d", "e"].map((id) => ({
        id,
        name: `Agent ${id}`,
        waiting: false,
        startedAt: "2026-08-11T10:01:00.000Z",
      })),
    ];
    const markup = renderChatHeader({
      railOpen: true,
      liveAgents: { count: 5, waitingCount: 1, agents },
    });

    expect(markup).toContain('data-header-agent-faces="waiting"');
    const faces = [...markup.matchAll(/data-agent-face="(\w+)"/g)].map((match) => match[1]);
    expect(faces).toEqual(["waiting", "running", "running"]);
    // Three faces on a wide header, one on a narrow one.
    expect(markup).toContain(">+2<");
    expect(markup).toContain(">+4<");
    expect(markup).toContain(
      'aria-label="4 agents running, 1 waiting on you. Open the Agents tab."',
    );
  });

  it("draws no faces while no agent is live", () => {
    expect(renderChatHeader({ liveAgents: null })).not.toContain("data-header-agent-faces");
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
