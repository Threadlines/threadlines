import { EnvironmentId, ThreadId } from "@threadlines/contracts";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { SidebarProvider } from "../ui/sidebar";
import { ChatHeader } from "./ChatHeader";

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
    sourceControlToggleShortcutLabel: null,
    sourceControlOpen: false,
    sourceControlAvailable: false,
    fileBrowserAvailable: false,
    taskProgress: null,
    subagentProgress: null,
    forkContext: null,
    backgroundRuns: [],
    onRunProjectScript: vi.fn(),
    onAddProjectScript: vi.fn(async () => {}),
    onUpdateProjectScript: vi.fn(async () => {}),
    onDeleteProjectScript: vi.fn(async () => {}),
    onToggleBackgroundRunTerminal: vi.fn(),
    onStopBackgroundRun: vi.fn(),
    onOpenForkSourceThread: vi.fn(),
    onToggleTerminal: vi.fn(),
    onToggleSourceControl: vi.fn(),
    ...overrides,
  } satisfies ComponentProps<typeof ChatHeader>;

  return renderToStaticMarkup(
    <SidebarProvider>
      <ChatHeader {...props} />
    </SidebarProvider>,
  );
}

describe("ChatHeader", () => {
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
});
