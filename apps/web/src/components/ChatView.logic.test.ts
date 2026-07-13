import { scopeThreadRef } from "@threadlines/client-runtime";
import {
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationThreadActivity,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { type EnvironmentState, useStore } from "../store";
import { type ChatMessage, type Thread } from "../types";

import {
  buildRevertConfirmView,
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  buildExpiredTerminalContextToastCopy,
  classifyModelSwitch,
  createLocalDispatchSnapshot,
  deriveLockedProvider,
  backgroundRunCommandsMatch,
  deriveComposerSendState,
  deriveDetectedBackgroundRunLabel,
  deriveProviderBackgroundRuns,
  deriveProviderAuthReconnectPrompt,
  desktopCapturedScreenshotToFile,
  filterUnresolvedProviderBackgroundRuns,
  hasServerAcknowledgedLocalDispatch,
  isRetryableThreadError,
  isScrollMetricsAtEnd,
  deriveTimelineScrolledFarFromEnd,
  TIMELINE_SCROLLED_FAR_FROM_END_PX,
  mergeLocalDraftThreadWithServerThread,
  threadHasPromotableServerActivity,
  reconcileSteeringHandoffStatuses,
  reconcileMountedTerminalThreadIds,
  resolveSendEnvMode,
  shouldConfirmTerminalKill,
  shouldWriteThreadErrorToCurrentServerThread,
  waitForStartedServerThread,
} from "./ChatView.logic";

const localEnvironmentId = EnvironmentId.make("environment-local");

describe("isScrollMetricsAtEnd", () => {
  it("treats content shorter than the viewport as already at the end", () => {
    expect(
      isScrollMetricsAtEnd({
        scrollOffset: 0,
        viewportLength: 800,
        contentLength: 640,
      }),
    ).toBe(true);
  });

  it("allows small fractional drift at the end", () => {
    expect(
      isScrollMetricsAtEnd({
        scrollOffset: 298.5,
        viewportLength: 500,
        contentLength: 800,
      }),
    ).toBe(true);
  });

  it("treats a small residual gap near the end as still at the end", () => {
    expect(
      isScrollMetricsAtEnd({
        scrollOffset: 276,
        viewportLength: 500,
        contentLength: 800,
      }),
    ).toBe(true);
  });

  it("returns false when there is visible content below the viewport", () => {
    expect(
      isScrollMetricsAtEnd({
        scrollOffset: 240,
        viewportLength: 500,
        contentLength: 800,
      }),
    ).toBe(false);
  });

  it("accounts for bottom content inset", () => {
    expect(
      isScrollMetricsAtEnd({
        scrollOffset: 280,
        viewportLength: 500,
        contentLength: 800,
        contentInsetEnd: 20,
      }),
    ).toBe(true);
  });
});

describe("deriveTimelineScrolledFarFromEnd", () => {
  it("clears immediately when the timeline reports at-end", () => {
    expect(
      deriveTimelineScrolledFarFromEnd({ current: true, isAtEnd: true, distanceFromEnd: 500 }),
    ).toBe(false);
  });

  it("engages only beyond the far threshold", () => {
    expect(
      deriveTimelineScrolledFarFromEnd({
        current: false,
        isAtEnd: false,
        distanceFromEnd: TIMELINE_SCROLLED_FAR_FROM_END_PX,
      }),
    ).toBe(true);
    expect(
      deriveTimelineScrolledFarFromEnd({
        current: false,
        isAtEnd: false,
        distanceFromEnd: TIMELINE_SCROLLED_FAR_FROM_END_PX - 1,
      }),
    ).toBe(false);
  });

  it("holds the current state inside the hysteresis band so panel height changes cannot oscillate it", () => {
    // Collapsing the panel shrinks the composer and reveals ~200px more timeline;
    // a mid-band distance must not flip the signal in either direction.
    expect(
      deriveTimelineScrolledFarFromEnd({ current: true, isAtEnd: false, distanceFromEnd: 120 }),
    ).toBe(true);
    expect(
      deriveTimelineScrolledFarFromEnd({ current: false, isAtEnd: false, distanceFromEnd: 120 }),
    ).toBe(false);
  });

  it("releases once the user is back within the at-end tolerance", () => {
    expect(
      deriveTimelineScrolledFarFromEnd({ current: true, isAtEnd: false, distanceFromEnd: 10 }),
    ).toBe(false);
  });

  it("holds the current state when scroll metrics are unavailable", () => {
    expect(
      deriveTimelineScrolledFarFromEnd({ current: true, isAtEnd: false, distanceFromEnd: null }),
    ).toBe(true);
  });

  it("uses a measured panel threshold when provided", () => {
    expect(
      deriveTimelineScrolledFarFromEnd({
        current: false,
        isAtEnd: false,
        distanceFromEnd: 200,
        farThresholdPx: 180,
      }),
    ).toBe(true);
    expect(
      deriveTimelineScrolledFarFromEnd({
        current: false,
        isAtEnd: false,
        distanceFromEnd: 160,
        farThresholdPx: 180,
      }),
    ).toBe(false);
  });
});

describe("classifyModelSwitch", () => {
  const CODEX = ProviderDriverKind.make("codex");
  const CLAUDE = ProviderDriverKind.make("claudeAgent");

  it("applies a plain in-driver model swap", () => {
    expect(
      classifyModelSwitch({
        boundProvider: CODEX,
        pickedDriverKind: CODEX,
        boundContinuationGroupKey: "codex:home:/a",
        pickedContinuationGroupKey: "codex:home:/a",
      }),
    ).toBe("apply");
  });

  it("applies when the thread has no binding yet", () => {
    expect(
      classifyModelSwitch({
        boundProvider: null,
        pickedDriverKind: CLAUDE,
        boundContinuationGroupKey: null,
        pickedContinuationGroupKey: null,
      }),
    ).toBe("apply");
  });

  it("confirms a cross-driver switch", () => {
    expect(
      classifyModelSwitch({
        boundProvider: CODEX,
        pickedDriverKind: CLAUDE,
        boundContinuationGroupKey: "codex:home:/a",
        pickedContinuationGroupKey: "claudeAgent:instance:claudeAgent",
      }),
    ).toBe("confirm-cross-driver");
  });

  it("blocks a same-driver switch across an incompatible continuation group", () => {
    expect(
      classifyModelSwitch({
        boundProvider: CODEX,
        pickedDriverKind: CODEX,
        boundContinuationGroupKey: "codex:home:/a",
        pickedContinuationGroupKey: "codex:home:/b",
      }),
    ).toBe("blocked-incompatible-instance");
  });

  it("applies a same-driver switch when a continuation group is unknown", () => {
    expect(
      classifyModelSwitch({
        boundProvider: CODEX,
        pickedDriverKind: CODEX,
        boundContinuationGroupKey: null,
        pickedContinuationGroupKey: "codex:home:/b",
      }),
    ).toBe("apply");
  });
});

describe("deriveLockedProvider", () => {
  const CODEX = ProviderDriverKind.make("codex");

  it("locks to the resolved driver for custom provider instances", () => {
    const startedThread = {
      latestTurn: null,
      messages: [{ id: "message-1" }],
      session: null,
    } as unknown as Thread;

    expect(
      deriveLockedProvider({
        thread: startedThread,
        selectedProvider: CODEX,
        threadProvider: null,
      }),
    ).toBe(CODEX);
  });
});

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      attachmentCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.make("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      attachmentCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.make("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });

  it("treats transcript highlight contexts as sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "",
      attachmentCount: 0,
      terminalContexts: [],
      transcriptHighlightContexts: [
        {
          id: "highlight-1",
          threadId: ThreadId.make("thread-1"),
          sourceMessageId: MessageId.make("assistant-1"),
          sourceRole: "assistant",
          selectedText: "selected text",
          note: "my answer",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTranscriptHighlightContexts).toHaveLength(1);
    expect(state.hasSendableContent).toBe(true);
  });
});

describe("desktopCapturedScreenshotToFile", () => {
  it("converts a desktop-captured PNG data URL into a File", async () => {
    const file = desktopCapturedScreenshotToFile({
      name: "screenshot-20260609.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,AQID",
      width: 1,
      height: 1,
      capturedAt: "2026-06-09T12:00:00.000Z",
      source: "macos-screencapture",
    });

    expect(file).not.toBeNull();
    if (!file) return;
    expect(file?.name).toBe("screenshot-20260609.png");
    expect(file?.type).toBe("image/png");
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([1, 2, 3]);
  });

  it("returns null for non-base64 image data", () => {
    expect(
      desktopCapturedScreenshotToFile({
        name: "bad.png",
        mimeType: "image/png",
        sizeBytes: 3,
        dataUrl: "data:image/png,not-base64",
        width: 1,
        height: 1,
        capturedAt: "2026-06-09T12:00:00.000Z",
        source: "windows-snipping-tool-clipboard",
      }),
    ).toBeNull();
  });
});

describe("deriveProviderAuthReconnectPrompt", () => {
  const claudeProvider = ProviderDriverKind.make("claudeAgent");
  const codexProvider = ProviderDriverKind.make("codex");

  it("detects Claude authentication failures from the thread error", () => {
    expect(
      deriveProviderAuthReconnectPrompt({
        provider: claudeProvider,
        threadError: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
      }),
    ).toEqual({
      provider: claudeProvider,
      command: "claude auth login",
      message: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
    });
  });

  it("detects structured authentication runtime activities", () => {
    const activity: OrchestrationThreadActivity = {
      id: EventId.make("evt-auth"),
      tone: "error",
      kind: "runtime.error",
      summary: "Authentication required",
      payload: {
        message: "Failed to authenticate.",
        class: "authentication_error",
        provider: claudeProvider,
      },
      turnId: null,
      createdAt: "2026-03-29T00:00:00.000Z",
    };

    expect(
      deriveProviderAuthReconnectPrompt({
        provider: claudeProvider,
        activities: [activity],
      }),
    ).toEqual({
      provider: claudeProvider,
      command: "claude auth login",
      message: "Failed to authenticate.",
    });
  });

  it("detects authentication failures from assistant messages", () => {
    expect(
      deriveProviderAuthReconnectPrompt({
        provider: claudeProvider,
        messages: [
          {
            role: "assistant",
            text: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
          },
        ],
      }),
    ).toEqual({
      provider: claudeProvider,
      command: "claude auth login",
      message: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
    });
  });

  it("detects Codex authentication failures with the Codex login command", () => {
    expect(
      deriveProviderAuthReconnectPrompt({
        provider: codexProvider,
        messages: [
          {
            role: "assistant",
            text: "Not logged in. Run `codex login` in a terminal, then retry.",
          },
        ],
      }),
    ).toEqual({
      provider: codexProvider,
      command: "codex login",
      message: "Not logged in. Run `codex login` in a terminal, then retry.",
    });
  });

  it("ignores diagnostic assistant prose that mentions unauthenticated UI state", () => {
    expect(
      deriveProviderAuthReconnectPrompt({
        provider: codexProvider,
        messages: [
          {
            role: "assistant",
            text: "The config path matters here: Threadlines can materialize a Codex shadow home before starting app-server. If that shadow home misses or ages out MCP credential files, the UI would repeatedly appear unauthenticated even though the primary ~/.codex login was fresh.",
          },
        ],
      }),
    ).toBeNull();
  });

  it("ignores assistant summaries that mention unrelated unauthenticated tooling", () => {
    expect(
      deriveProviderAuthReconnectPrompt({
        provider: codexProvider,
        messages: [
          {
            role: "assistant",
            text: "I could not change the live Vercel project setting yet because the local Vercel CLI is not authenticated and the connector returned 403. To finish it directly in your Vercel dashboard, I need your explicit approval to use your logged-in Chrome session.",
          },
        ],
      }),
    ).toBeNull();
  });

  it("ignores unrelated runtime errors", () => {
    expect(
      deriveProviderAuthReconnectPrompt({
        provider: claudeProvider,
        threadError: "Sandbox setup failed",
      }),
    ).toBeNull();
  });
});

describe("isRetryableThreadError", () => {
  function runtimeErrorActivity(input: {
    id: string;
    errorClass?: string;
    message?: string;
    createdAt?: string;
  }): OrchestrationThreadActivity {
    return {
      id: EventId.make(input.id),
      tone: "error",
      kind: "runtime.error",
      summary: input.message ?? "Turn failed",
      payload: {
        message: input.message ?? "Turn failed",
        ...(input.errorClass !== undefined ? { class: input.errorClass } : {}),
      },
      turnId: null,
      createdAt: input.createdAt ?? "2026-03-29T00:00:00.000Z",
    };
  }

  it("is false without a thread error", () => {
    expect(
      isRetryableThreadError({
        threadError: null,
        activities: [runtimeErrorActivity({ id: "evt-1", errorClass: "transport_error" })],
      }),
    ).toBe(false);
    expect(isRetryableThreadError({ threadError: "   " })).toBe(false);
  });

  it("is true for transport and provider errors", () => {
    expect(
      isRetryableThreadError({
        threadError: "API Error: Unable to connect to API (ECONNRESET)",
        activities: [
          runtimeErrorActivity({
            id: "evt-transport",
            errorClass: "transport_error",
            message: "API Error: Unable to connect to API (ECONNRESET)",
          }),
        ],
      }),
    ).toBe(true);
    expect(
      isRetryableThreadError({
        threadError: "Claude turn failed.",
        activities: [runtimeErrorActivity({ id: "evt-provider", errorClass: "provider_error" })],
      }),
    ).toBe(true);
  });

  it("is true when no runtime error activity exists", () => {
    expect(
      isRetryableThreadError({
        threadError: "Provider process exited before the turn started",
        activities: [],
      }),
    ).toBe(true);
  });

  it("is false for authentication, permission, and validation classes", () => {
    for (const errorClass of ["authentication_error", "permission_error", "validation_error"]) {
      expect(
        isRetryableThreadError({
          threadError: "Turn failed",
          activities: [runtimeErrorActivity({ id: `evt-${errorClass}`, errorClass })],
        }),
      ).toBe(false);
    }
  });

  it("is false for auth-shaped and usage-limit thread errors regardless of activities", () => {
    expect(
      isRetryableThreadError({
        threadError: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
      }),
    ).toBe(false);
    expect(
      isRetryableThreadError({
        threadError: "You've hit your usage limit.",
        activities: [runtimeErrorActivity({ id: "evt-usage", errorClass: "provider_error" })],
      }),
    ).toBe(false);
  });

  it("uses the most recent runtime error activity", () => {
    expect(
      isRetryableThreadError({
        threadError: "API Error: Unable to connect to API (ECONNRESET)",
        activities: [
          runtimeErrorActivity({
            id: "evt-old-auth",
            errorClass: "authentication_error",
            createdAt: "2026-03-29T00:00:00.000Z",
          }),
          runtimeErrorActivity({
            id: "evt-new-transport",
            errorClass: "transport_error",
            createdAt: "2026-03-29T00:05:00.000Z",
          }),
        ],
      }),
    ).toBe(true);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats clear empty-state guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
  });

  it("formats omission guidance for sent messages", () => {
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("resolveSendEnvMode", () => {
  it("keeps worktree mode for git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: true })).toBe("worktree");
  });

  it("forces local mode for non-git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: false })).toBe("local");
    expect(resolveSendEnvMode({ requestedEnvMode: "local", isGitRepo: false })).toBe("local");
  });
});

describe("shouldConfirmTerminalKill", () => {
  it("confirms when the terminal still has a running subprocess", () => {
    expect(
      shouldConfirmTerminalKill({
        runningTerminalIds: ["default", "terminal-2"],
        terminalId: "terminal-2",
        sessionExited: false,
      }),
    ).toBe(true);
  });

  it("does not confirm when no subprocess is running in the terminal", () => {
    expect(
      shouldConfirmTerminalKill({
        runningTerminalIds: ["terminal-2"],
        terminalId: "default",
        sessionExited: false,
      }),
    ).toBe(false);
  });

  it("does not confirm when the close follows a session exit", () => {
    expect(
      shouldConfirmTerminalKill({
        runningTerminalIds: ["default"],
        terminalId: "default",
        sessionExited: true,
      }),
    ).toBe(false);
  });
});

describe("deriveDetectedBackgroundRunLabel", () => {
  it("uses provider intent before command-derived fallbacks", () => {
    const command =
      "node -e \"let n=0; const t=setInterval(()=>console.log('background test', ++n), 1000); setTimeout(()=>{clearInterval(t); console.log('done')}, 120000)\"";

    expect(
      deriveDetectedBackgroundRunLabel({
        command: `${command.slice(0, 96)}...`,
        port: null,
        providerBackgroundRuns: [
          {
            id: "provider:task-command",
            source: "provider",
            label: "Run a 2-minute counter that logs every second",
            command,
            detail: "Local Bash task",
            statusLabel: "Running",
            urls: [],
            pids: [],
            commandHints: [command],
          },
        ],
      }),
    ).toBe("Run a 2-minute counter that logs every second");
  });

  it("falls back to a compact command intent label", () => {
    expect(
      deriveDetectedBackgroundRunLabel({
        command:
          '"C:\\Program Files\\nodejs\\node.exe" -e "setInterval(() => console.log(1), 1000)"',
        port: null,
        providerBackgroundRuns: [],
      }),
    ).toBe("Node inline script");
    expect(
      deriveDetectedBackgroundRunLabel({
        command: "C:\\repo\\node_modules\\.bin\\vp.cmd run dev:desktop",
        port: 5733,
        providerBackgroundRuns: [],
      }),
    ).toBe("vp run dev:desktop");
  });

  it("derives a compact intent label for timed Node counters", () => {
    expect(
      deriveDetectedBackgroundRunLabel({
        command:
          "node -e \"let n=0; const t=setInterval(()=>console.log('background test', ++n), 1000); setTimeout(()=>{clearInterval(t); console.log('done')}, 120000)\"",
        port: null,
        providerBackgroundRuns: [],
      }),
    ).toBe("2-minute Node counter");
  });

  it("derives command intent through shell launcher wrappers", () => {
    expect(
      deriveDetectedBackgroundRunLabel({
        command: String.raw`powershell -Command "node -e \"setInterval(() => console.log(1), 1000)\""`,
        port: null,
        providerBackgroundRuns: [],
      }),
    ).toBe("Node inline script");
  });

  it("uses stable generic labels when no command intent exists", () => {
    expect(
      deriveDetectedBackgroundRunLabel({
        command: null,
        port: null,
        providerBackgroundRuns: [],
      }),
    ).toBe("Agent background process");
    expect(
      deriveDetectedBackgroundRunLabel({
        command: null,
        port: 5733,
        providerBackgroundRuns: [],
      }),
    ).toBe("Local preview");
  });
});

describe("deriveProviderBackgroundRuns", () => {
  function taskActivity(
    kind: "task.started" | "task.progress" | "task.completed",
    payload: Record<string, unknown>,
    sequence: number,
    turnId = TurnId.make("turn-1"),
  ): OrchestrationThreadActivity {
    return {
      id: EventId.make(`event-${kind}-${sequence}`),
      tone: kind === "task.completed" ? "info" : "thinking",
      kind,
      summary: kind,
      payload,
      turnId,
      sequence,
      createdAt: `2026-06-23T00:00:0${sequence}.000Z`,
    };
  }

  function commandToolActivity(
    command: string,
    sequence: number,
    turnId = TurnId.make("turn-1"),
    kind: "tool.started" | "tool.updated" | "tool.completed" = "tool.completed",
    toolCallId = "tool-command-1",
  ): OrchestrationThreadActivity {
    const status =
      kind === "tool.completed" ? "completed" : kind === "tool.started" ? "inProgress" : undefined;
    return {
      id: EventId.make(`event-tool-${sequence}`),
      tone: kind === "tool.completed" ? "info" : "tool",
      kind,
      summary: "Ran command",
      payload: {
        itemType: "command_execution",
        title: "Ran command",
        ...(status ? { status } : {}),
        detail: command,
        data: {
          toolCallId,
          toolName: "Bash",
          input: { command },
          item: {
            id: toolCallId,
            input: { command },
          },
        },
      },
      turnId,
      sequence,
      createdAt: `2026-06-23T00:00:0${sequence}.000Z`,
    };
  }

  function assistantMessage(text: string): ChatMessage {
    return {
      id: MessageId.make("message-preview"),
      role: "assistant",
      text,
      createdAt: "2026-06-23T00:00:10.000Z",
      streaming: false,
    };
  }

  it("reconstructs active provider task rows from persisted task activity", () => {
    const { runs, detectionSeeds } = deriveProviderBackgroundRuns({
      activities: [
        taskActivity(
          "task.started",
          {
            taskId: "task-dev-server",
            taskType: "background-command",
            detail: "Starting local preview http://localhost:5953",
          },
          1,
        ),
        taskActivity(
          "task.progress",
          {
            taskId: "task-dev-server",
            detail: "Local preview ready at http://localhost:5953",
          },
          2,
        ),
      ],
      messages: [],
      pendingBackgroundTaskCount: 1,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: "provider:task-dev-server",
      source: "provider",
      label: "Local preview ready at http://localhost:5953",
      detail: "Background Command task",
      statusLabel: "Running",
      urls: ["http://localhost:5953"],
    });
    expect(detectionSeeds.urls).toEqual(["http://localhost:5953"]);
  });

  it("never mines pid 1 from task details", () => {
    const { runs } = deriveProviderBackgroundRuns({
      activities: [
        taskActivity(
          "task.started",
          {
            taskId: "task-orphan-hunt",
            taskType: "background-command",
            detail: "Detected background process PID 1 and PID 4242 still running",
          },
          1,
        ),
      ],
      messages: [],
      pendingBackgroundTaskCount: 1,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]?.pids).toEqual([4242]);
  });

  it("hides local and remote agent tasks without active subagent records", () => {
    for (const taskType of ["local_agent", "remote_agent"]) {
      const { runs } = deriveProviderBackgroundRuns({
        activities: [
          taskActivity(
            "task.started",
            {
              taskId: `task-bg-${taskType}`,
              taskType,
              detail: "Inventory Threadlines features thoroughly",
              toolUseId: `tool-${taskType}`,
            },
            1,
          ),
          // Progress activities never repeat taskType; the suppression from the
          // task.started classification must stick.
          taskActivity(
            "task.progress",
            {
              taskId: `task-bg-${taskType}`,
              detail: "Reading packages/contracts/src/rpc.ts",
              lastToolName: "Read",
              toolUseId: `tool-${taskType}`,
            },
            2,
            TurnId.make("turn-2"),
          ),
        ],
        messages: [],
        pendingBackgroundTaskCount: 1,
        activeSubagentCount: 0,
      });

      expect(runs).toEqual([]);
    }
  });

  it("hides tasks tagged with a subagent type from background runs", () => {
    const { runs } = deriveProviderBackgroundRuns({
      activities: [
        taskActivity(
          "task.progress",
          {
            taskId: "task-bg-agent",
            detail: "Reading packages/contracts/src/rpc.ts",
            subagentType: "Explore",
            toolUseId: "tool-agent-bg",
          },
          1,
        ),
      ],
      messages: [],
      pendingBackgroundTaskCount: 1,
      activeSubagentCount: 0,
    });

    expect(runs).toEqual([]);
  });

  it("keeps a normalized provider command when task payload exposes one", () => {
    const { runs, detectionSeeds } = deriveProviderBackgroundRuns({
      activities: [
        taskActivity(
          "task.started",
          {
            taskId: "task-dev-server",
            taskType: "background-command",
            command:
              "C:\\Users\\Will\\AppData\\Local\\Programs\\node.exe scripts/dev-runner.ts dev",
            detail: "Starting local preview http://localhost:5953",
          },
          1,
        ),
      ],
      messages: [],
      pendingBackgroundTaskCount: 1,
    });

    expect(runs[0]?.command).toBe("node scripts/dev-runner.ts dev");
    expect(detectionSeeds.commandHints).toContain("node scripts/dev-runner.ts dev");
  });

  it("uses active command tool activities to seed detection without rendering provider runs", () => {
    const command =
      'node -e "let n=0; const t=setInterval(()=>console.log(n++), 1000); setTimeout(()=>clearInterval(t), 120000)"';
    const { runs, detectionSeeds } = deriveProviderBackgroundRuns({
      activities: [commandToolActivity(command, 1, TurnId.make("turn-1"), "tool.started")],
      messages: [],
      pendingBackgroundTaskCount: 0,
      activeCommandTurnId: TurnId.make("turn-1"),
    });

    expect(runs).toEqual([]);
    expect(detectionSeeds.commandHints).toContain(command);
  });

  it("does not render many foreground command tools as background runs", () => {
    const { runs, detectionSeeds } = deriveProviderBackgroundRuns({
      activities: [
        commandToolActivity(
          'sed -n "1,140p" apps/server/src/bin.ts',
          1,
          TurnId.make("turn-1"),
          "tool.started",
          "tool-command-1",
        ),
        commandToolActivity(
          'sed -n "1,80p" apps/server/dist/bin.mjs',
          2,
          TurnId.make("turn-1"),
          "tool.started",
          "tool-command-2",
        ),
        commandToolActivity(
          'rg -n "background run" apps/web/src',
          3,
          TurnId.make("turn-1"),
          "tool.started",
          "tool-command-3",
        ),
      ],
      messages: [],
      pendingBackgroundTaskCount: 0,
      activeCommandTurnId: TurnId.make("turn-1"),
    });

    expect(runs).toEqual([]);
    expect(detectionSeeds.commandHints).toEqual([
      'sed -n "1,140p" apps/server/src/bin.ts',
      'sed -n "1,80p" apps/server/dist/bin.mjs',
      'rg -n "background run" apps/web/src',
    ]);
  });

  it("ignores active command tool activities from inactive historical turns", () => {
    const command =
      'node -e "let n=0; const t=setInterval(()=>console.log(n++), 1000); setTimeout(()=>clearInterval(t), 120000)"';
    const { runs, detectionSeeds } = deriveProviderBackgroundRuns({
      activities: [
        commandToolActivity(command, 1, TurnId.make("turn-old"), "tool.started", "old-command"),
      ],
      messages: [],
      pendingBackgroundTaskCount: 0,
      activeCommandTurnId: TurnId.make("turn-current"),
    });

    expect(runs).toEqual([]);
    expect(detectionSeeds.commandHints).toEqual([]);
  });

  it("does not render command-only rows when there is no active command turn", () => {
    const command =
      'node -e "let n=0; const t=setInterval(()=>console.log(n++), 1000); setTimeout(()=>clearInterval(t), 120000)"';
    const { runs, detectionSeeds } = deriveProviderBackgroundRuns({
      activities: [commandToolActivity(command, 1, TurnId.make("turn-old"), "tool.started")],
      messages: [],
      pendingBackgroundTaskCount: 0,
      activeCommandTurnId: null,
    });

    expect(runs).toEqual([]);
    expect(detectionSeeds.commandHints).toEqual([]);
  });

  it("removes active command tool activities when the command completes", () => {
    const command =
      'node -e "let n=0; const t=setInterval(()=>console.log(n++), 1000); setTimeout(()=>clearInterval(t), 120000)"';
    const { runs, detectionSeeds } = deriveProviderBackgroundRuns({
      activities: [
        commandToolActivity(command, 1, TurnId.make("turn-1"), "tool.started", "tool-command-1"),
        commandToolActivity(command, 2, TurnId.make("turn-1"), "tool.completed", "tool-command-1"),
      ],
      messages: [],
      pendingBackgroundTaskCount: 0,
      activeCommandTurnId: TurnId.make("turn-1"),
    });

    expect(runs).toEqual([]);
    expect(detectionSeeds.commandHints).toEqual([]);
  });

  it("uses command tool activity to seed detection for provider-only background tasks", () => {
    const command =
      'node -e "let n=0; const t=setInterval(()=>console.log(n++), 1000); setTimeout(()=>clearInterval(t), 120000)"';
    const { runs, detectionSeeds } = deriveProviderBackgroundRuns({
      activities: [
        taskActivity(
          "task.started",
          {
            taskId: "task-bash-background",
            description: "Run a 2-minute counter that logs every second",
          },
          1,
        ),
        taskActivity(
          "task.progress",
          {
            taskId: "task-bash-background",
            description: "Run a 2-minute counter that logs every second",
            summary: "Local Bash task",
            lastToolName: "Bash",
          },
          2,
        ),
        commandToolActivity(command, 3),
      ],
      messages: [],
      pendingBackgroundTaskCount: 1,
    });

    expect(runs[0]?.label).toBe("Run a 2-minute counter that logs every second");
    expect(runs[0]?.command).toBe(command);
    expect(detectionSeeds.commandHints).toContain(command);
  });

  it("does not duplicate a provider task when its command tool activity is still running", () => {
    const command =
      'node -e "let n=0; const t=setInterval(()=>console.log(n++), 1000); setTimeout(()=>clearInterval(t), 120000)"';
    const { runs, detectionSeeds } = deriveProviderBackgroundRuns({
      activities: [
        taskActivity(
          "task.started",
          {
            taskId: "task-bash-background",
            description: "Run a 2-minute counter that logs every second",
          },
          1,
        ),
        commandToolActivity(command, 2, TurnId.make("turn-1"), "tool.started"),
      ],
      messages: [],
      pendingBackgroundTaskCount: 1,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe("provider:task-bash-background");
    expect(runs[0]?.command).toBe(command);
    expect(detectionSeeds.commandHints).toContain(command);
  });

  it("does not seed active provider task detection from older command turns", () => {
    const previousTurnId = TurnId.make("turn-previous");
    const activeTurnId = TurnId.make("turn-active");
    const command =
      'node -e "let n=0; const t=setInterval(()=>console.log(n++), 1000); setTimeout(()=>clearInterval(t), 120000)"';
    const { detectionSeeds } = deriveProviderBackgroundRuns({
      activities: [
        commandToolActivity("vp run dev:desktop", 1, previousTurnId),
        taskActivity(
          "task.started",
          {
            taskId: "task-bash-background",
            description: "Run a 2-minute counter that logs every second",
          },
          2,
          activeTurnId,
        ),
        commandToolActivity(command, 3, activeTurnId),
      ],
      messages: [],
      pendingBackgroundTaskCount: 1,
    });

    expect(detectionSeeds.commandHints).toContain(command);
    expect(detectionSeeds.commandHints).not.toContain("vp run dev:desktop");
  });

  it("removes provider task rows when completion activity is present", () => {
    const { runs } = deriveProviderBackgroundRuns({
      activities: [
        taskActivity("task.started", { taskId: "task-dev-server", detail: "Starting" }, 1),
        taskActivity("task.completed", { taskId: "task-dev-server", status: "completed" }, 2),
      ],
      messages: [],
      pendingBackgroundTaskCount: 0,
    });

    expect(runs).toEqual([]);
  });

  it("adds placeholder rows when only the provider pending count is known", () => {
    const { runs } = deriveProviderBackgroundRuns({
      activities: [],
      messages: [],
      pendingBackgroundTaskCount: 1,
    });

    expect(runs).toEqual([
      {
        id: "provider:unknown:1",
        source: "provider",
        providerKind: "task",
        label: "Provider background task",
        command: null,
        detail: "Provider-managed; stop handle not exposed.",
        statusLabel: "Tracked",
        urls: [],
        pids: [],
        commandHints: [],
      },
    ]);
  });

  it("does not duplicate active subagents as anonymous provider background rows", () => {
    const { runs } = deriveProviderBackgroundRuns({
      activities: [],
      messages: [],
      pendingBackgroundTaskCount: 1,
      activeSubagentCount: 1,
    });

    expect(runs).toEqual([]);
  });

  it("does not surface Claude subagent task progress as a background run", () => {
    const { runs } = deriveProviderBackgroundRuns({
      activities: [
        taskActivity(
          "task.started",
          {
            taskId: "subagent-task-1",
            taskType: "general-purpose",
            description: "Output sample sentences to chat",
          },
          1,
        ),
        taskActivity(
          "task.progress",
          {
            taskId: "subagent-task-1",
            taskType: "general-purpose",
            description: "Output sample sentences to chat",
            summary: "General purpose subagent returned a sample sentence.",
          },
          2,
        ),
      ],
      messages: [],
      pendingBackgroundTaskCount: 1,
      activeSubagentCount: 1,
    });

    expect(runs).toEqual([]);
  });

  it("seeds detection from mentioned localhost preview URLs without rendering a run", () => {
    const { runs, detectionSeeds } = deriveProviderBackgroundRuns({
      activities: [],
      messages: [
        assistantMessage(
          "Started the preview server. Web: http://localhost:5953 and API: http://localhost:13993",
        ),
      ],
      pendingBackgroundTaskCount: 0,
    });

    expect(runs).toEqual([]);
    expect(detectionSeeds.urls).toEqual(["http://localhost:5953", "http://localhost:13993"]);
    expect(detectionSeeds.pids).toEqual([]);
  });

  it("seeds detection from mentioned background process PIDs without rendering a run", () => {
    const { runs, detectionSeeds } = deriveProviderBackgroundRuns({
      activities: [],
      messages: [assistantMessage("Left a live background process running. PID 21820")],
      pendingBackgroundTaskCount: 0,
    });

    expect(runs).toEqual([]);
    expect(detectionSeeds.pids).toEqual([21820]);
    expect(detectionSeeds.urls).toEqual([]);
  });

  it("does not seed detection from instructional localhost prose", () => {
    const { runs, detectionSeeds } = deriveProviderBackgroundRuns({
      activities: [],
      messages: [assistantMessage("To preview, run `npm run dev` and open http://localhost:3000.")],
      pendingBackgroundTaskCount: 0,
    });

    expect(runs).toEqual([]);
    // The URL is still mined as a detection seed; nothing renders unless the
    // server later confirms a live listener on that port.
    expect(detectionSeeds.urls).toEqual(["http://localhost:3000"]);
  });

  it("extracts command hints from mentioned detached preview messages", () => {
    const { detectionSeeds } = deriveProviderBackgroundRuns({
      activities: [],
      messages: [
        assistantMessage(
          [
            "Started a detached preview.",
            "$env:THREADLINES_PORT_OFFSET='280'",
            "Set-Location -LiteralPath 'C:\\Users\\Will\\Desktop\\Projects\\badcode'",
            "node scripts/dev-runner.ts dev --no-browser --home-dir '$env:TEMP\\threadlines-activity-preview-280\\home'",
            "Web: http://localhost:6013",
          ].join("\n"),
        ),
      ],
      pendingBackgroundTaskCount: 0,
    });

    expect(detectionSeeds.commandHints[0]).toContain("THREADLINES_PORT_OFFSET");
    expect(detectionSeeds.commandHints[0]).toContain("scripts/dev-runner.ts");
    expect(detectionSeeds.commandHints[0]).toContain("threadlines-activity-preview-280");
  });
});

describe("backgroundRunCommandsMatch", () => {
  it("matches agent shell-snapshot wrappers against the tracked command", () => {
    const tracked =
      "until gh run list --commit 75bdfb9 --json status | jq -e 'all(.status == \"completed\")'; do sleep 60; done";
    const detected =
      "zsh -c source /Users/demo/.claude/shell-snapshots/snapshot-zsh-123.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB 2>/dev/null || true && eval 'until gh run list --commit 75bdfb9 --json status | jq -e '\"'\"'all(.status == \"completed\")'\"'\"'; do sleep 60; done'";

    expect(backgroundRunCommandsMatch(detected, tracked)).toBe(true);
    expect(backgroundRunCommandsMatch(detected, "vp run dev")).toBe(false);
  });
});

describe("filterUnresolvedProviderBackgroundRuns", () => {
  const providerUrlRun = {
    id: "provider:task-dev-server",
    source: "provider" as const,
    label: "Local preview ready at http://localhost:5953",
    command: null,
    detail: "Background Command task",
    statusLabel: "Running",
    urls: ["http://localhost:5953"],
    pids: [],
    commandHints: [],
  };

  it("keeps provider runs while detection has not covered their URL yet", () => {
    expect(
      filterUnresolvedProviderBackgroundRuns({
        providerBackgroundRuns: [providerUrlRun],
        detectedBackgroundRuns: [],
      }),
    ).toEqual([providerUrlRun]);
  });

  it("removes provider runs once a detected run covers their URL", () => {
    expect(
      filterUnresolvedProviderBackgroundRuns({
        providerBackgroundRuns: [providerUrlRun],
        detectedBackgroundRuns: [{ urls: ["http://localhost:5953"] }],
      }),
    ).toEqual([]);
  });

  it("removes tracked runs whose process was detected through the shell-snapshot wrapper", () => {
    const command =
      "until gh run list --commit 75bdfb9 --json status | jq -e 'all(.status == \"completed\")'; do sleep 60; done";
    const trackedRun = {
      id: "provider:task-ci-watch",
      source: "provider" as const,
      label: "Watch CI for terminal tree-kill commit",
      command,
      detail: "Background Command task",
      statusLabel: "Running",
      urls: [],
      pids: [],
      commandHints: [command],
    };

    expect(
      filterUnresolvedProviderBackgroundRuns({
        providerBackgroundRuns: [trackedRun],
        detectedBackgroundRuns: [
          {
            urls: [],
            command:
              "zsh -c source /Users/demo/.claude/shell-snapshots/snapshot-zsh-123.sh 2>/dev/null || true && eval 'until gh run list --commit 75bdfb9 --json status | jq -e '\"'\"'all(.status == \"completed\")'\"'\"'; do sleep 60; done'",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("keeps provider rows without URLs until the provider task settles", () => {
    const providerRun = {
      id: "provider:unknown:1",
      source: "provider" as const,
      providerKind: "task" as const,
      label: "Provider background task",
      command: null,
      detail: "Provider-managed; stop handle not exposed.",
      statusLabel: "Tracked",
      urls: [],
      pids: [],
      commandHints: [],
    };

    expect(
      filterUnresolvedProviderBackgroundRuns({
        providerBackgroundRuns: [providerRun],
        detectedBackgroundRuns: [{ urls: ["http://localhost:5953"] }],
      }),
    ).toEqual([providerRun]);
  });

  it("removes provider runs once a detected run covers their PID", () => {
    const providerPidRun = {
      id: "provider:task-process",
      source: "provider" as const,
      label: "Background process",
      command: null,
      detail: "Provider-managed",
      statusLabel: "Running",
      urls: [],
      pids: [21820],
      commandHints: [],
    };

    expect(
      filterUnresolvedProviderBackgroundRuns({
        providerBackgroundRuns: [providerPidRun],
        detectedBackgroundRuns: [{ urls: [], pids: [21820] }],
      }),
    ).toEqual([]);
  });

  it("removes provider command rows once a detected run covers their command", () => {
    const command = 'node -e "let n=0; setInterval(() => console.log(n++), 1000)"';
    const providerCommandRun = {
      id: "provider:task-command",
      source: "provider" as const,
      label: "Run a 2-minute counter",
      command,
      detail: "Local Bash task",
      statusLabel: "Running",
      urls: [],
      pids: [],
      commandHints: [command],
    };

    expect(
      filterUnresolvedProviderBackgroundRuns({
        providerBackgroundRuns: [providerCommandRun],
        detectedBackgroundRuns: [{ urls: [], pids: [4242], command }],
      }),
    ).toEqual([]);
  });

  it("removes provider command rows when the detected command is compacted", () => {
    const command =
      "node -e \"let n=0; const t=setInterval(()=>console.log('background test', ++n), 1000); setTimeout(()=>{clearInterval(t); console.log('done')}, 120000)\"";
    const detectedCommand = `${command.slice(0, 96)}...`;
    const providerCommandRun = {
      id: "provider:task-command",
      source: "provider" as const,
      label: "Run a 2-minute counter",
      command,
      detail: "Local Bash task",
      statusLabel: "Running",
      urls: [],
      pids: [],
      commandHints: [command],
    };

    expect(
      filterUnresolvedProviderBackgroundRuns({
        providerBackgroundRuns: [providerCommandRun],
        detectedBackgroundRuns: [{ urls: [], pids: [43748], command: detectedCommand }],
      }),
    ).toEqual([]);
  });

  it("removes provider command rows when the provider command is a shell launcher wrapper", () => {
    const detectedCommand = 'node -e "let n=0; setInterval(() => console.log(n++), 1000)"';
    const wrappedCommand = String.raw`powershell -Command "node -e \"let n=0; setInterval(() => console.log(n++), 1000)\""`;
    const providerCommandRun = {
      id: "provider:command:tool-command",
      source: "provider" as const,
      providerKind: "command" as const,
      label: "Node inline script",
      command: wrappedCommand,
      detail: "Command tool",
      statusLabel: "Running",
      urls: [],
      pids: [],
      commandHints: [wrappedCommand],
    };

    expect(
      filterUnresolvedProviderBackgroundRuns({
        providerBackgroundRuns: [providerCommandRun],
        detectedBackgroundRuns: [{ urls: [], pids: [4242], command: detectedCommand }],
      }),
    ).toEqual([]);
  });
});

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps previously mounted open threads and adds the active open thread", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [ThreadId.make("thread-hidden"), ThreadId.make("thread-stale")],
        openThreadIds: [ThreadId.make("thread-hidden"), ThreadId.make("thread-active")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadTerminalOpen: true,
      }),
    ).toEqual([ThreadId.make("thread-hidden"), ThreadId.make("thread-active")]);
  });

  it("drops mounted threads once their terminal drawer is no longer open", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [ThreadId.make("thread-closed")],
        openThreadIds: [],
        activeThreadId: ThreadId.make("thread-closed"),
        activeThreadTerminalOpen: false,
      }),
    ).toEqual([]);
  });

  it("keeps only the most recently active hidden terminal threads", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [
          ThreadId.make("thread-1"),
          ThreadId.make("thread-2"),
          ThreadId.make("thread-3"),
        ],
        openThreadIds: [
          ThreadId.make("thread-1"),
          ThreadId.make("thread-2"),
          ThreadId.make("thread-3"),
          ThreadId.make("thread-4"),
        ],
        activeThreadId: ThreadId.make("thread-4"),
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual([ThreadId.make("thread-2"), ThreadId.make("thread-3"), ThreadId.make("thread-4")]);
  });

  it("moves the active thread to the end so it is treated as most recently used", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [
          ThreadId.make("thread-a"),
          ThreadId.make("thread-b"),
          ThreadId.make("thread-c"),
        ],
        openThreadIds: [
          ThreadId.make("thread-a"),
          ThreadId.make("thread-b"),
          ThreadId.make("thread-c"),
        ],
        activeThreadId: ThreadId.make("thread-a"),
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual([ThreadId.make("thread-b"), ThreadId.make("thread-c"), ThreadId.make("thread-a")]);
  });

  it("defaults to the hidden mounted terminal cap", () => {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => ThreadId.make(`thread-${index + 1}`),
    );

    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds,
        openThreadIds: currentThreadIds,
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
    ).toEqual(currentThreadIds.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_THREADS));
  });
});

describe("shouldWriteThreadErrorToCurrentServerThread", () => {
  it("routes errors to the active server thread when route and target match", () => {
    const threadId = ThreadId.make("thread-1");
    const routeThreadRef = scopeThreadRef(localEnvironmentId, threadId);

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: {
          environmentId: localEnvironmentId,
          id: threadId,
        },
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(true);
  });

  it("does not route draft-thread errors into server-backed state", () => {
    const threadId = ThreadId.make("thread-1");

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: undefined,
        routeThreadRef: scopeThreadRef(localEnvironmentId, threadId),
        targetThreadId: threadId,
      }),
    ).toBe(false);
  });
});

const makeThread = (input?: {
  id?: ThreadId;
  session?: Thread["session"];
  messages?: Thread["messages"];
  activities?: Thread["activities"];
  proposedPlans?: Thread["proposedPlans"];
  turnDiffSummaries?: Thread["turnDiffSummaries"];
  error?: string | null;
  latestTurn?: {
    turnId: TurnId;
    state: "running" | "completed";
    requestedAt: string;
    startedAt: string | null;
    completedAt: string | null;
  } | null;
}): Thread => ({
  id: input?.id ?? ThreadId.make("thread-1"),
  environmentId: localEnvironmentId,
  codexThreadId: null,
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  session: input?.session ?? null,
  messages: input?.messages ?? [],
  proposedPlans: input?.proposedPlans ?? [],
  error: input?.error ?? null,
  createdAt: "2026-03-29T00:00:00.000Z",
  archivedAt: null,
  pinnedAt: null,
  updatedAt: "2026-03-29T00:00:00.000Z",
  latestTurn: input?.latestTurn
    ? {
        ...input.latestTurn,
        assistantMessageId: null,
      }
    : null,
  branch: null,
  worktreePath: null,
  effectiveCwd: null,
  turnDiffSummaries: input?.turnDiffSummaries ?? [],
  activities: input?.activities ?? [],
});

describe("mergeLocalDraftThreadWithServerThread", () => {
  it("hydrates a promoted draft from the matching server thread without changing route ownership", () => {
    const threadId = ThreadId.make("thread-promoted");
    const localDraftThread = makeThread({
      id: threadId,
      messages: [],
    });
    const serverThread = makeThread({
      id: threadId,
      session: {
        provider: ProviderDriverKind.make("codex"),
        status: "connecting",
        orchestrationStatus: "starting",
        createdAt: "2026-03-29T00:00:01.000Z",
        updatedAt: "2026-03-29T00:00:01.000Z",
      },
      messages: [
        {
          id: "message-promoted" as never,
          role: "user",
          text: "keep this visible",
          createdAt: "2026-03-29T00:00:01.000Z",
          completedAt: "2026-03-29T00:00:01.000Z",
          streaming: false,
        },
      ],
    });

    const merged = mergeLocalDraftThreadWithServerThread(localDraftThread, serverThread);

    expect(merged).toMatchObject({
      id: threadId,
      session: {
        status: "connecting",
        orchestrationStatus: "starting",
      },
      messages: [
        {
          id: "message-promoted",
          text: "keep this visible",
        },
      ],
    });
  });

  it("ignores server state for a different thread", () => {
    const localDraftThread = makeThread({ id: ThreadId.make("thread-local") });
    const serverThread = makeThread({ id: ThreadId.make("thread-server") });

    expect(mergeLocalDraftThreadWithServerThread(localDraftThread, serverThread)).toBe(
      localDraftThread,
    );
  });
});

function setStoreThreads(threads: ReadonlyArray<ReturnType<typeof makeThread>>) {
  const projectId = ProjectId.make("project-1");
  const environmentState: EnvironmentState = {
    projectIds: [projectId],
    projectById: {
      [projectId]: {
        id: projectId,
        environmentId: localEnvironmentId,
        kind: "workspace" as const,
        name: "Project",
        cwd: "/tmp/project",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        createdAt: "2026-03-29T00:00:00.000Z",
        updatedAt: "2026-03-29T00:00:00.000Z",
        scripts: [],
      },
    },
    threadIds: threads.map((thread) => thread.id),
    threadIdsByProjectId: {
      [projectId]: threads.map((thread) => thread.id),
    },
    threadShellById: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        {
          id: thread.id,
          environmentId: thread.environmentId,
          codexThreadId: thread.codexThreadId,
          projectId: thread.projectId,
          title: thread.title,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          error: thread.error,
          createdAt: thread.createdAt,
          archivedAt: thread.archivedAt,
          pinnedAt: thread.pinnedAt,
          updatedAt: thread.updatedAt,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          effectiveCwd: thread.effectiveCwd,
        },
      ]),
    ),
    threadSessionById: Object.fromEntries(threads.map((thread) => [thread.id, thread.session])),
    threadTurnStateById: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        {
          latestTurn: thread.latestTurn,
          ...(thread.pendingSourceProposedPlan
            ? { pendingSourceProposedPlan: thread.pendingSourceProposedPlan }
            : {}),
        },
      ]),
    ),
    messageIdsByThreadId: Object.fromEntries(
      threads.map((thread) => [thread.id, thread.messages.map((message) => message.id)]),
    ),
    messageByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        Object.fromEntries(thread.messages.map((message) => [message.id, message])),
      ]),
    ),
    activityIdsByThreadId: Object.fromEntries(
      threads.map((thread) => [thread.id, thread.activities.map((activity) => activity.id)]),
    ),
    activityByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        Object.fromEntries(thread.activities.map((activity) => [activity.id, activity])),
      ]),
    ),
    proposedPlanIdsByThreadId: Object.fromEntries(
      threads.map((thread) => [thread.id, thread.proposedPlans.map((plan) => plan.id)]),
    ),
    proposedPlanByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        Object.fromEntries(thread.proposedPlans.map((plan) => [plan.id, plan])),
      ]),
    ),
    turnDiffIdsByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        thread.turnDiffSummaries.map((summary) => summary.turnId),
      ]),
    ),
    turnDiffSummaryByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        Object.fromEntries(thread.turnDiffSummaries.map((summary) => [summary.turnId, summary])),
      ]),
    ),
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  };
  useStore.setState({
    activeEnvironmentId: localEnvironmentId,
    environmentStateById: {
      [localEnvironmentId]: environmentState,
    },
  });
}

describe("threadHasPromotableServerActivity", () => {
  const readySession = {
    provider: ProviderDriverKind.make("codex"),
    status: "ready" as const,
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:05.000Z",
    orchestrationStatus: "ready" as const,
  };

  it("does not treat server metadata or the echoed user message as turn activity", () => {
    expect(
      threadHasPromotableServerActivity(
        makeThread({
          session: readySession,
          messages: [
            {
              id: "message-1" as never,
              role: "user",
              text: "start this",
              createdAt: "2026-03-29T00:00:04.000Z",
              completedAt: "2026-03-29T00:00:04.000Z",
              streaming: false,
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("does not promote on a running session before turn details arrive", () => {
    expect(
      threadHasPromotableServerActivity(
        makeThread({
          session: {
            ...readySession,
            status: "running",
            orchestrationStatus: "running",
          },
        }),
      ),
    ).toBe(false);
  });

  it("promotes once provider turn activity or failure state is visible", () => {
    expect(
      threadHasPromotableServerActivity(
        makeThread({
          latestTurn: {
            turnId: TurnId.make("turn-activity"),
            state: "running",
            requestedAt: "2026-03-29T00:00:04.000Z",
            startedAt: "2026-03-29T00:00:05.000Z",
            completedAt: null,
          },
        }),
      ),
    ).toBe(true);

    expect(threadHasPromotableServerActivity(makeThread({ error: "Failed to start" }))).toBe(true);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setStoreThreads([]);
});

describe("waitForStartedServerThread", () => {
  it("resolves immediately when the thread is already started", async () => {
    const threadId = ThreadId.make("thread-started");
    setStoreThreads([
      makeThread({
        id: threadId,
        latestTurn: {
          turnId: TurnId.make("turn-started"),
          state: "running",
          requestedAt: "2026-03-29T00:00:01.000Z",
          startedAt: "2026-03-29T00:00:01.000Z",
          completedAt: null,
        },
      }),
    ]);

    await expect(
      waitForStartedServerThread(scopeThreadRef(localEnvironmentId, threadId)),
    ).resolves.toBe(true);
  });

  it("waits for the thread to start via subscription updates", async () => {
    const threadId = ThreadId.make("thread-wait");
    setStoreThreads([makeThread({ id: threadId })]);

    const promise = waitForStartedServerThread(scopeThreadRef(localEnvironmentId, threadId), 500);

    setStoreThreads([
      makeThread({
        id: threadId,
        latestTurn: {
          turnId: TurnId.make("turn-started"),
          state: "running",
          requestedAt: "2026-03-29T00:00:01.000Z",
          startedAt: "2026-03-29T00:00:01.000Z",
          completedAt: null,
        },
      }),
    ]);

    await expect(promise).resolves.toBe(true);
  });

  it("handles the thread starting between the initial read and subscription setup", async () => {
    const threadId = ThreadId.make("thread-race");
    setStoreThreads([makeThread({ id: threadId })]);

    const originalSubscribe = useStore.subscribe.bind(useStore);
    let raced = false;
    vi.spyOn(useStore, "subscribe").mockImplementation((listener) => {
      if (!raced) {
        raced = true;
        setStoreThreads([
          makeThread({
            id: threadId,
            latestTurn: {
              turnId: TurnId.make("turn-race"),
              state: "running",
              requestedAt: "2026-03-29T00:00:01.000Z",
              startedAt: "2026-03-29T00:00:01.000Z",
              completedAt: null,
            },
          }),
        ]);
      }
      return originalSubscribe(listener);
    });

    await expect(
      waitForStartedServerThread(scopeThreadRef(localEnvironmentId, threadId), 500),
    ).resolves.toBe(true);
  });

  it("returns false after the timeout when the thread never starts", async () => {
    vi.useFakeTimers();

    const threadId = ThreadId.make("thread-timeout");
    setStoreThreads([makeThread({ id: threadId })]);
    const promise = waitForStartedServerThread(scopeThreadRef(localEnvironmentId, threadId), 500);

    await vi.advanceTimersByTimeAsync(500);

    await expect(promise).resolves.toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  const projectId = ProjectId.make("project-1");
  const previousLatestTurn = {
    turnId: TurnId.make("turn-1"),
    state: "completed" as const,
    requestedAt: "2026-03-29T00:00:00.000Z",
    startedAt: "2026-03-29T00:00:01.000Z",
    completedAt: "2026-03-29T00:00:10.000Z",
    assistantMessageId: null,
  };

  const previousSession = {
    provider: ProviderDriverKind.make("codex"),
    status: "ready" as const,
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:10.000Z",
    orchestrationStatus: "idle" as const,
  };

  it("does not clear local dispatch before server state changes", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      effectiveCwd: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: previousLatestTurn,
        session: previousSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("clears local dispatch when a new turn is already settled", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      effectiveCwd: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: {
          ...previousLatestTurn,
          turnId: TurnId.make("turn-2"),
          requestedAt: "2026-03-29T00:01:00.000Z",
          startedAt: "2026-03-29T00:01:01.000Z",
          completedAt: "2026-03-29T00:01:30.000Z",
        },
        session: {
          ...previousSession,
          updatedAt: "2026-03-29T00:01:30.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("does not clear local dispatch while the session is running a newer turn than latestTurn", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      effectiveCwd: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: previousLatestTurn,
        session: {
          ...previousSession,
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.make("turn-2"),
          updatedAt: "2026-03-29T00:01:00.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("does not clear local dispatch while the session is running but latestTurn has not advanced yet", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      effectiveCwd: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: previousLatestTurn,
        session: {
          ...previousSession,
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: undefined,
          updatedAt: "2026-03-29T00:01:00.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("clears local dispatch once the running latestTurn matches the active session turn", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      effectiveCwd: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: {
          ...previousLatestTurn,
          turnId: TurnId.make("turn-2"),
          state: "running",
          requestedAt: "2026-03-29T00:01:00.000Z",
          startedAt: "2026-03-29T00:01:01.000Z",
          completedAt: null,
        },
        session: {
          ...previousSession,
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.make("turn-2"),
          updatedAt: "2026-03-29T00:01:01.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("clears local dispatch when the session changes without an observed running phase", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      pinnedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      effectiveCwd: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: previousLatestTurn,
        session: {
          ...previousSession,
          updatedAt: "2026-03-29T00:00:11.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });
});

describe("reconcileSteeringHandoffStatuses", () => {
  const queuedMessage = {
    id: "message-steer",
    threadKey: "environment-local:thread-1",
    createdAt: "2026-03-29T00:01:00.000Z",
    status: "queued" as const,
    text: "adjust the current answer",
  };

  it("marks a queued steering handoff read as soon as the server message is visible", () => {
    const messagesById = {
      [queuedMessage.id]: queuedMessage,
    };

    const next = reconcileSteeringHandoffStatuses({
      messagesById,
      activeThreadKey: queuedMessage.threadKey,
      latestTurn: {
        requestedAt: "2026-03-29T00:00:00.000Z",
      },
      serverMessageIds: new Set([queuedMessage.id]),
    });

    expect(next[queuedMessage.id]?.status).toBe("read");
  });

  it("keeps a queued steering handoff while neither the turn nor server message has acknowledged it", () => {
    const messagesById = {
      [queuedMessage.id]: queuedMessage,
    };

    const next = reconcileSteeringHandoffStatuses({
      messagesById,
      activeThreadKey: queuedMessage.threadKey,
      latestTurn: {
        requestedAt: "2026-03-29T00:00:00.000Z",
      },
      serverMessageIds: new Set(),
    });

    expect(next).toBe(messagesById);
    expect(next[queuedMessage.id]?.status).toBe("queued");
  });
});
describe("buildRevertConfirmView", () => {
  const basePlan = {
    threadId: "thread-1" as never,
    turnCount: 1,
    currentTurnCount: 3,
    mode: "selective" as const,
    revertPaths: ["TODO.md", "docs/notes.md"],
    revertFileCount: 2,
    conflicts: [],
    conflictCount: 0,
    unattributedPathCount: 4,
    hasProviderSession: true,
  };

  it("falls back to generic shared-checkout copy without a plan", () => {
    const view = buildRevertConfirmView({ turnCount: 2, isWorktreeThread: false, plan: null });
    expect(view.title).toBe("Revert this thread to checkpoint 2?");
    expect(view.summary).toBe("This will discard newer messages and turn diffs in this thread.");
    expect(view.notes).toContain("Files changed by other threads or sessions are preserved.");
    expect(view.notes.at(-1)).toBe("This action cannot be undone.");
    expect(view.revertPaths).toEqual([]);
    expect(view.conflicts).toEqual([]);
  });

  it("omits the shared-checkout reassurance for worktree threads without a plan", () => {
    const view = buildRevertConfirmView({ turnCount: 0, isWorktreeThread: true, plan: null });
    expect(view.title).toBe("Revert this thread back to its start?");
    expect(view.notes).not.toContain("Files changed by other threads or sessions are preserved.");
  });

  it("describes workspace-mode reverts as whole-checkout restores", () => {
    const view = buildRevertConfirmView({
      turnCount: 1,
      isWorktreeThread: true,
      plan: { ...basePlan, mode: "workspace" as const },
    });
    expect(view.summary).toBe(
      "This thread owns its worktree, so the entire checkout will be restored.",
    );
    expect(view.revertPaths).toEqual([]);
  });

  it("lists the files that will revert with counts and preserved-work reassurance", () => {
    const view = buildRevertConfirmView({ turnCount: 1, isWorktreeThread: false, plan: basePlan });
    expect(view.summary).toBe("2 files from this thread will be reverted:");
    expect(view.revertPaths).toEqual(["TODO.md", "docs/notes.md"]);
    expect(view.revertPathOverflowCount).toBe(0);
    expect(view.conflictsLabel).toBeNull();
    expect(view.notes).toContain(
      "Changes from other threads, sessions, and manual edits are preserved.",
    );
  });

  it("caps the revert path list and counts the overflow", () => {
    const paths = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const view = buildRevertConfirmView({
      turnCount: 1,
      isWorktreeThread: false,
      plan: { ...basePlan, revertPaths: paths, revertFileCount: 9 },
    });
    expect(view.revertPaths).toHaveLength(6);
    expect(view.revertPathOverflowCount).toBe(3);
  });

  it("lists conflict paths with reason labels and an overflow count", () => {
    const view = buildRevertConfirmView({
      turnCount: 1,
      isWorktreeThread: false,
      plan: {
        ...basePlan,
        conflicts: [
          { path: "a.md", reason: "changed-after-thread" as const },
          { path: "b.md", reason: "interleaved" as const },
          { path: "c.md", reason: "unsupported" as const },
          { path: "d.md", reason: "interleaved" as const },
          { path: "e.md", reason: "interleaved" as const },
          { path: "f.md", reason: "interleaved" as const },
          { path: "g.md", reason: "interleaved" as const },
        ],
        conflictCount: 8,
      },
    });
    expect(view.conflictsLabel).toBe("8 files with conflicting edits will be left untouched:");
    expect(view.conflicts).toHaveLength(6);
    expect(view.conflicts[0]).toEqual({
      path: "a.md",
      reason: "changed after this thread's last edit",
    });
    expect(view.conflicts[1]).toEqual({
      path: "b.md",
      reason: "interleaved with another session's edits",
    });
    expect(view.conflictOverflowCount).toBe(2);
  });

  it("notes when no files need reverting and warns about missing provider sessions", () => {
    const view = buildRevertConfirmView({
      turnCount: 1,
      isWorktreeThread: false,
      plan: { ...basePlan, revertPaths: [], revertFileCount: 0, hasProviderSession: false },
    });
    expect(view.summary).toBe("No file changes need to be reverted.");
    expect(view.notes.some((note) => note.startsWith("No active provider session"))).toBe(true);
  });
});
