// Shared setup for the ChatView browser specs (ChatView.<area>.browser.tsx):
// fixtures, the mock RPC server and service worker, and `mountChatView`, which
// renders the whole app at one thread. A spec calls registerChatViewSuiteHooks()
// first inside its describe, and repeats the `vi.mock("../lib/gitStatusState")`
// call the others make, since Vitest hoists mocks per spec file. The specs are
// split by area so they run in parallel browser tabs.

// Production CSS is part of the behavior under test because row height depends
// on it. Every spec gets it through this module.
import "../index.css";

import {
  EMPTY_AGENT_REQUEST_STATE,
  EMPTY_CHILD_REQUEST_STATE,
  EventId,
  ORCHESTRATION_WS_METHODS,
  EnvironmentId,
  type EnvironmentApi,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ProjectId,
  type ProjectSetupDestination,
  ProjectSetupId,
  type ProjectSetupInspectDestinationInput,
  type ProjectSetupJob,
  type ProjectSetupSource,
  type ProjectSetupStartInput,
  type RepositoryIdentity,
  type ScopedThreadRef,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerLifecycleWelcomePayload,
  type ThreadId,
  type TurnId,
  WS_METHODS,
  ChildRequestId,
  type ComputerLinkInvite,
  ComputerLinkId,
  type ComputerLinkPendingRequest,
  type ComputerLinksSnapshot,
  type OutboundComputerLink,
  RelayHostId,
  RelayInviteId,
  CheckpointRef,
  OrchestrationSessionStatus,
  DEFAULT_SERVER_SETTINGS,
  ServerConfig as ServerConfigSchema,
} from "@threadlines/contracts";
import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import { createModelCapabilities } from "@threadlines/shared/model";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { StrictMode, useEffect } from "react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { page } from "vite-plus/test/browser";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import {
  __resetComputerLinksForTests,
  type ComputerLinksClient,
} from "../environments/links/computerLinks";
import { __resetThreadMovesForTests } from "../environments/links/threadMoves";
import {
  __resetProjectSetupsForTests,
  type ProjectSetupsClient,
} from "../environments/projectSetups/projectSetups";
import { closeConnectComputerDialog } from "./settings/connections/JoinComputerDialog";
import { closeProjectSetupDialog } from "./ProjectSetupDialog";
import { closeThreadMoveDialog } from "./ThreadMoveDialog";
import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import { connectEnvironmentBrowserHost } from "./browser/previewAutomationHost";
import { closeThreadBrowser, useBrowserPageWatchers } from "./browser/BrowserHostLayer";
import {
  prepareThreadBrowser,
  resetThreadBrowserAutomationForTests,
  resolveThreadBrowserTarget,
} from "./browser/threadBrowserAutomation";
import { resetBrowserLiveStoreForTests, useBrowserLiveStore } from "../browserLiveStore";
import { __resetEnvironmentApiOverridesForTests } from "../environmentApi";
import {
  resetSavedEnvironmentRegistryStoreForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { type TerminalContextDraft } from "../lib/terminalContext";
import { isMacPlatform } from "../lib/utils";
import { __resetLocalApiForTests } from "../localApi";
import { useOptimisticThreadMessagesStore } from "../optimisticThreadMessages";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { getServerConfig } from "../rpc/serverState";
import { getRouter } from "../router";
import { deriveLogicalProjectKeyFromSettings } from "../logicalProject";
import { resetRightPanelTabsForTests } from "../rightPanelTabs";
import { __resetComposerPullRequestDismissalsForTests } from "../lib/composerPullRequestDismissals";
import {
  selectBootstrapCompleteForActiveEnvironment,
  selectThreadDetailLoaded,
  useStore,
} from "../store";
import { dismissFirstRunSetup } from "./setup/firstRunGate";
import { useTerminalStateStore } from "../terminalStateStore";
import { useUiStateStore } from "../uiStateStore";
import type { SidebarThreadSummary } from "../types";
import { createAuthenticatedSessionHandlers } from "../../test/authHttpHandlers";
import { BrowserWsRpcHarness, type NormalizedWsRpcRequestBody } from "../../test/wsRpcHarness";

import { DEFAULT_CLIENT_SETTINGS } from "@threadlines/contracts/settings";

export const THREAD_ID = "thread-browser-test" as ThreadId;
export const THREAD_TITLE = "Browser test thread";
/** A thread no other thread started, with no threads of its own. */
const NO_CHILD_THREAD_FIELDS = {
  parentThreadId: null,
  parentTurnId: null,
  attachedToParent: false,
  parentAttachmentEpoch: 0,
  handedBackAt: null,
  handedBackTurnId: null,
  archivedWithParentAt: null,
  childRequests: EMPTY_CHILD_REQUEST_STATE,
} as const;
const ARCHIVED_SECONDARY_THREAD_ID = "thread-secondary-project-archived" as ThreadId;
export const PROJECT_ID = "project-1" as ProjectId;
export const SECOND_PROJECT_ID = "project-2" as ProjectId;
export const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");

/**
 * The app-wide browser host, for one thread on screen, without the layer's
 * pages: the tests register stand-in webviews instead. Uses the per-thread
 * connection an older server would get, which the mocks below answer.
 */
export function BrowserHostHarness({
  threadRef,
  projectId = "project-browser-tests" as ProjectId,
  clientHosts = false,
  shown = true,
}: {
  threadRef: ScopedThreadRef;
  projectId?: ProjectId;
  /** Connect the way a current server is reached: one host for every thread. */
  clientHosts?: boolean;
  /** Whether the thread's panel is on screen. */
  shown?: boolean;
}) {
  useBrowserPageWatchers();
  useEffect(() => {
    resetThreadBrowserAutomationForTests();
    useBrowserLiveStore.getState().ensureLive(threadRef, projectId);
    if (shown) useBrowserLiveStore.getState().setShown(threadRef);
    const connection = connectEnvironmentBrowserHost({
      environmentId: threadRef.environmentId,
      machineLocal: true,
      clientHosts,
      resolveTarget: resolveThreadBrowserTarget,
      prepare: prepareThreadBrowser,
      onRelease: closeThreadBrowser,
      onReconnect: () => {},
      shownThread: { current: () => threadRef.threadId, subscribe: () => () => {} },
    });
    return () => {
      connection.disconnect();
      resetBrowserLiveStoreForTests();
    };
  }, [clientHosts, projectId, shown, threadRef]);
  return null;
}
export const REMOTE_ENVIRONMENT_ID = EnvironmentId.make("environment-remote");
export const THREAD_REF = scopeThreadRef(LOCAL_ENVIRONMENT_ID, THREAD_ID);
export const THREAD_KEY = scopedThreadKey(THREAD_REF);
/**
 * File a thread from a test without a server round-trip: the optimistic
 * overlay is exactly what the real Mark done action shows first.
 */
export function markThreadDoneInTest(threadKey: string, at: string) {
  useUiStateStore
    .getState()
    .setDoneOverlay(threadKey, { state: "done", at, baselineAt: null, settled: false });
}
export const UUID_ROUTE_RE =
  /^\/draft\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PROJECT_DRAFT_KEY = `${LOCAL_ENVIRONMENT_ID}:${PROJECT_ID}`;
export const PROJECT_LOGICAL_KEY = deriveLogicalProjectKeyFromSettings(
  {
    environmentId: LOCAL_ENVIRONMENT_ID,
    id: PROJECT_ID,
    cwd: "/repo/project",
    repositoryIdentity: null,
  },
  {
    sidebarProjectGroupingMode: DEFAULT_CLIENT_SETTINGS.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: DEFAULT_CLIENT_SETTINGS.sidebarProjectGroupingOverrides,
  },
);
// The fixture clock is "a few minutes ago", not a fixed date: the sidebar's
// lifecycle is relative (threads file themselves under Done once idle), so a
// pinned calendar date would age into the Done tail as real time moved on.
export const NOW_ISO = new Date(Date.now() - 10 * 60_000).toISOString();
export const BASE_TIME_MS = Date.parse(NOW_ISO);
const ATTACHMENT_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'></svg>";
export const ADD_PROJECT_SUBMENU_PLACEHOLDER = "Enter path (e.g. ~/projects/my-app)";

export interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: ServerLifecycleWelcomePayload;
}

export let fixture: TestFixture;
export const rpcHarness = new BrowserWsRpcHarness();
export const wsRequests = rpcHarness.requests;
let customWsRpcResolver: ((body: NormalizedWsRpcRequestBody) => unknown | undefined) | null = null;
let suppressInitialShellSnapshot = false;
/** What this computer's server streams for `links.subscribe`; null sends nothing. */
let primaryLinksSnapshot: ComputerLinksSnapshot | null = null;
const wsLink = ws.link(/ws(s)?:\/\/.*/);
export const encodeServerConfig = Schema.encodeSync(ServerConfigSchema);

interface ViewportSpec {
  name: string;
  width: number;
  height: number;
  textTolerancePx: number;
  attachmentTolerancePx: number;
}

export const DEFAULT_VIEWPORT: ViewportSpec = {
  name: "desktop",
  width: 960,
  height: 1_100,
  textTolerancePx: 44,
  attachmentTolerancePx: 56,
};
export const WIDE_FOOTER_VIEWPORT: ViewportSpec = {
  name: "wide-footer",
  width: 1_400,
  height: 1_100,
  textTolerancePx: 44,
  attachmentTolerancePx: 56,
};
export const COMPACT_FOOTER_VIEWPORT: ViewportSpec = {
  name: "compact-footer",
  width: 430,
  height: 932,
  textTolerancePx: 56,
  attachmentTolerancePx: 56,
};
/**
 * A finger drawn `dx` across an element in ten steps, then lifted, the way a
 * browser reports one: each step as a touch pointer event and then a touch
 * event. Row swipes follow the pointer events; a drawer follows the touch
 * events.
 */
export function touchSwipe(element: Element, dx: number): void {
  const rect = element.getBoundingClientRect();
  const x0 = rect.left + rect.width * 0.75;
  const y = rect.top + rect.height / 2;
  const fire = (phase: "start" | "move" | "end", x: number) => {
    element.dispatchEvent(
      new PointerEvent(
        phase === "start" ? "pointerdown" : phase === "move" ? "pointermove" : "pointerup",
        {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          pointerId: 21,
          pointerType: "touch",
          isPrimary: true,
          button: 0,
          buttons: phase === "end" ? 0 : 1,
        },
      ),
    );
    const touch = new Touch({ identifier: 21, target: element, clientX: x, clientY: y });
    const active = phase === "end" ? [] : [touch];
    element.dispatchEvent(
      new TouchEvent(`touch${phase}`, {
        bubbles: true,
        cancelable: true,
        touches: active,
        targetTouches: active,
        changedTouches: [touch],
      }),
    );
  };
  fire("start", x0);
  for (let step = 1; step <= 10; step += 1) fire("move", x0 + (dx * step) / 10);
  fire("end", x0 + dx);
}

export const PHONE_VIEWPORT: ViewportSpec = {
  name: "phone",
  width: 390,
  height: 844,
  textTolerancePx: 56,
  attachmentTolerancePx: 56,
};
/**
 * About the narrowest the right panel's drag limit lets a desktop composer
 * with the usual footer get (208px plus the footer's right-hand buttons).
 * Wider right-hand buttons, like a plan's Implement pair, raise that floor.
 */
export const NARROW_DESKTOP_COMPOSER_WIDTH = 400;

interface MountedChatView {
  [Symbol.asyncDispose]: () => Promise<void>;
  cleanup: () => Promise<void>;
  setViewport: (viewport: ViewportSpec) => Promise<void>;
  setContainerSize: (viewport: Pick<ViewportSpec, "width" | "height">) => Promise<void>;
  /**
   * Narrows the app until the composer is `width` px wide, keeping the
   * viewport (and so the desktop layout): what panels beside the chat do.
   */
  setComposerWidth: (width: number) => Promise<void>;
  router: ReturnType<typeof getRouter>;
}

export function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TIME_MS + offsetSeconds * 1_000).toISOString();
}

function createBaseServerConfig(): ServerConfig {
  return {
    environment: {
      environmentId: EnvironmentId.make("environment-local"),
      label: "Local environment",
      platform: { os: "darwin" as const, arch: "arm64" as const },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: "threadlines_session",
    },
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.threadlines/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        instanceId: ProviderInstanceId.make("codex"),
        enabled: true,
        installed: true,
        version: "0.116.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: NOW_ISO,
        models: [],
        slashCommands: [],
        skills: [],
      },
    ],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/repo/project/.threadlines/logs",
      localTracingEnabled: true,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      ...DEFAULT_CLIENT_SETTINGS,
    },
  };
}

export function createMockEnvironmentApi(input: {
  browse: EnvironmentApi["filesystem"]["browse"];
  dispatchCommand: EnvironmentApi["orchestration"]["dispatchCommand"];
  getRevertPlan?: EnvironmentApi["orchestration"]["getRevertPlan"];
  warmUpTurn?: EnvironmentApi["orchestration"]["warmUpTurn"];
  previewAutomation?: EnvironmentApi["previewAutomation"];
}): EnvironmentApi {
  return {
    terminal: {} as EnvironmentApi["terminal"],
    projects: {} as EnvironmentApi["projects"],
    attachments: {} as EnvironmentApi["attachments"],
    previewAutomation: input.previewAutomation ?? ({} as EnvironmentApi["previewAutomation"]),
    previewLoopback: {} as EnvironmentApi["previewLoopback"],
    filesystem: {
      browse: input.browse,
    },
    sourceControl: {} as EnvironmentApi["sourceControl"],
    vcs: {} as EnvironmentApi["vcs"],
    git: {} as EnvironmentApi["git"],
    pullRequests: {} as EnvironmentApi["pullRequests"],
    realtime: {} as EnvironmentApi["realtime"],
    dictation: {
      // The composer subscribes on mount, so this one has to be callable.
      subscribeStatus: () => () => undefined,
      downloadModel: async () => undefined,
      cancelDownload: async () => undefined,
      removeModel: async () => undefined,
      warmUp: async () => undefined,
      transcribe: async () => ({ text: "" }),
    },
    orchestration: {
      dispatchCommand: input.dispatchCommand,
      warmUpTurn: input.warmUpTurn ?? (async () => undefined),
      getTurnDiff: (() => {
        throw new Error("Not implemented in browser test.");
      }) as EnvironmentApi["orchestration"]["getTurnDiff"],
      getFullThreadDiff: (() => {
        throw new Error("Not implemented in browser test.");
      }) as EnvironmentApi["orchestration"]["getFullThreadDiff"],
      getRevertPlan:
        input.getRevertPlan ??
        ((() =>
          Promise.reject(
            new Error("Not implemented in browser test."),
          )) as EnvironmentApi["orchestration"]["getRevertPlan"]),
      searchThreads: (async () => ({
        matches: [],
        truncated: false,
      })) as EnvironmentApi["orchestration"]["searchThreads"],
      getTurnActivities: (async () => ({
        activities: [],
      })) as EnvironmentApi["orchestration"]["getTurnActivities"],
      getArchivedShellSnapshot: (() => {
        throw new Error("Not implemented in browser test.");
      }) as EnvironmentApi["orchestration"]["getArchivedShellSnapshot"],
      subscribeShell: (() => () => undefined) as EnvironmentApi["orchestration"]["subscribeShell"],
      subscribeThread: (() => () =>
        undefined) as EnvironmentApi["orchestration"]["subscribeThread"],
    },
  };
}

export function createUserMessage(options: {
  id: MessageId;
  text: string;
  offsetSeconds: number;
  attachments?: Array<{
    type: "image";
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}) {
  return {
    id: options.id,
    role: "user" as const,
    text: options.text,
    ...(options.attachments ? { attachments: options.attachments } : {}),
    turnId: null,
    streaming: false,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

export function createAssistantMessage(options: {
  id: MessageId;
  text: string;
  offsetSeconds: number;
}) {
  return {
    id: options.id,
    role: "assistant" as const,
    text: options.text,
    turnId: null,
    streaming: false,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

export function createTerminalContext(input: {
  id: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}): TerminalContextDraft {
  return {
    id: input.id,
    threadId: THREAD_ID,
    terminalId: `terminal-${input.id}`,
    terminalLabel: input.terminalLabel,
    lineStart: input.lineStart,
    lineEnd: input.lineEnd,
    text: input.text,
    createdAt: NOW_ISO,
  };
}

export function createSnapshotForTargetUser(options: {
  targetMessageId: MessageId;
  targetText: string;
  targetAttachmentCount?: number;
  threadPinnedAt?: string | null;
  threadPullRequestAutoFix?: boolean;
  sessionActiveTurnId?: TurnId | null;
  sessionStatus?: OrchestrationSessionStatus;
}): OrchestrationReadModel {
  const messages: Array<OrchestrationReadModel["threads"][number]["messages"][number]> = [];

  for (let index = 0; index < 22; index += 1) {
    const isTarget = index === 3;
    const userId = `msg-user-${index}` as MessageId;
    const assistantId = `msg-assistant-${index}` as MessageId;
    const attachments =
      isTarget && (options.targetAttachmentCount ?? 0) > 0
        ? Array.from({ length: options.targetAttachmentCount ?? 0 }, (_, attachmentIndex) => ({
            type: "image" as const,
            id: `attachment-${attachmentIndex + 1}`,
            name: `attachment-${attachmentIndex + 1}.png`,
            mimeType: "image/png",
            sizeBytes: 128,
            previewUrl: `/attachments/attachment-${attachmentIndex + 1}`,
          }))
        : undefined;

    messages.push(
      createUserMessage({
        id: isTarget ? options.targetMessageId : userId,
        text: isTarget ? options.targetText : `filler user message ${index}`,
        offsetSeconds: messages.length * 3,
        ...(attachments ? { attachments } : {}),
      }),
    );
    messages.push(
      createAssistantMessage({
        id: assistantId,
        text: `assistant filler ${index}`,
        offsetSeconds: messages.length * 3,
      }),
    );
  }

  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        kind: "workspace" as const,
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5",
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: THREAD_TITLE,
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: "main",
        worktreePath: null,
        effectiveCwd: null,
        goal: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        archivedAt: null,
        pinnedAt: options.threadPinnedAt ?? null,
        pullRequestAutoFix: options.threadPullRequestAutoFix ?? false,
        pullRequestAutoMerge: null,
        linkedPullRequests: [],
        participants: [],
        doneOverride: null,
        lastSeenAt: null,
        deletedAt: null,
        messages,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        diffStatBaselineTurnCount: 0,
        agentRequests: EMPTY_AGENT_REQUEST_STATE,
        ...NO_CHILD_THREAD_FIELDS,
        session: {
          threadId: THREAD_ID,
          providerThreadId: null,
          providerSessionId: null,
          status: options.sessionStatus ?? "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: options.sessionActiveTurnId ?? null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

function buildFixture(snapshot: OrchestrationReadModel): TestFixture {
  return {
    snapshot,
    serverConfig: createBaseServerConfig(),
    welcome: {
      environment: {
        environmentId: EnvironmentId.make("environment-local"),
        label: "Local environment",
        platform: { os: "darwin" as const, arch: "arm64" as const },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      },
      cwd: "/repo/project",
      projectName: "Project",
      bootstrapProjectId: PROJECT_ID,
      bootstrapThreadId: THREAD_ID,
    },
  };
}

export const PULL_REQUEST_NUMBER = 234;
export const PULL_REQUEST_REPOSITORY = "Threadlines/threadlines";
// The fixture thread is checked out on `main`, which is what links it to the
// listing row the way the sidebar badge and the Pull request tab do.
export const PULL_REQUEST_HEAD_BRANCH = "main";
export const PULL_REQUEST_URL = `https://github.com/${PULL_REQUEST_REPOSITORY}/pull/${PULL_REQUEST_NUMBER}`;

/**
 * A workspace whose project sits on GitHub, whose server can list pull
 * requests, and whose version skew raises a notice, so the dock has both kinds
 * of row to hold at once.
 */
export function withPullRequestFixture(nextFixture: TestFixture): void {
  const capabilities = { repositoryIdentity: true, pullRequests: true } as const;
  nextFixture.serverConfig = {
    ...nextFixture.serverConfig,
    environment: {
      ...nextFixture.serverConfig.environment,
      serverVersion: "9.9.9",
      capabilities,
    },
  };
  nextFixture.welcome = {
    ...nextFixture.welcome,
    environment: { ...nextFixture.welcome.environment, capabilities },
  };
  nextFixture.snapshot = {
    ...nextFixture.snapshot,
    projects: nextFixture.snapshot.projects.map((project) => ({
      ...project,
      repositoryIdentity: {
        canonicalKey: `github.com/${PULL_REQUEST_REPOSITORY}`.toLowerCase(),
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: `https://github.com/${PULL_REQUEST_REPOSITORY}.git`,
        },
        displayName: PULL_REQUEST_REPOSITORY,
        provider: "github",
        owner: "Threadlines",
        name: "threadlines",
      },
    })),
  };
}

/** The listing row and the detail behind the composer's docked pull request. */
export function resolvePullRequestRpc(body: NormalizedWsRpcRequestBody): unknown | undefined {
  if (body._tag === WS_METHODS.pullRequestsList) {
    const state = (body as { state?: string }).state;
    return {
      viewer: "badcuban",
      errors: [],
      entries:
        state === "open"
          ? [
              {
                provider: "github",
                projectId: PROJECT_ID,
                projectTitle: "threadlines",
                repository: PULL_REQUEST_REPOSITORY,
                number: PULL_REQUEST_NUMBER,
                title: "fix(server): migration 050 no longer stalls startup",
                url: PULL_REQUEST_URL,
                author: { login: "badcuban", isBot: false, avatarUrl: null },
                headBranch: PULL_REQUEST_HEAD_BRANCH,
                baseBranch: "main",
                state: "open",
                isDraft: false,
                additions: 26,
                deletions: 25,
                createdAt: NOW_ISO,
                updatedAt: NOW_ISO,
                viewerIsAuthor: true,
                viewerReviewRequested: false,
                labels: [],
                origin: "workspace",
              },
            ]
          : [],
    };
  }
  if (body._tag === WS_METHODS.pullRequestsDetail) {
    return {
      provider: "github",
      projectId: PROJECT_ID,
      projectTitle: "threadlines",
      workspaceRoot: "/repo/project",
      repository: PULL_REQUEST_REPOSITORY,
      number: PULL_REQUEST_NUMBER,
      title: "fix(server): migration 050 no longer stalls startup",
      body: "",
      url: PULL_REQUEST_URL,
      author: { login: "badcuban", isBot: false, avatarUrl: null },
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      additions: 26,
      deletions: 25,
      changedFiles: 2,
      headBranch: PULL_REQUEST_HEAD_BRANCH,
      baseBranch: "main",
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
      mergedAt: null,
      closedAt: null,
      viewerIsAuthor: true,
      reviewers: [],
      labels: [],
      checks: [
        { name: "build", status: "pending", description: null, url: null },
        { name: "test", status: "pending", description: null, url: null },
        { name: "lint", status: "success", description: null, url: null },
      ],
      checksState: "pending",
      viewer: { canWrite: true, canReview: false, canManage: true },
      mergeMethods: ["squash"],
      capabilities: {
        diff: true,
        comment: true,
        actions: ["merge", "close", "enable-auto-merge", "disable-auto-merge"],
        mergeMethods: ["squash"],
        updateMethods: ["merge"],
        reactions: true,
        review: {
          inlineComment: true,
          reply: true,
          resolve: true,
          verdicts: ["approve", "comment"],
        },
        reviewers: { request: true, listCandidates: true },
        edit: { pullRequest: true, comment: true },
      },
      baseComparison: "up-to-date",
      behindBy: 0,
      autoMergeEnabled: false,
      isStacked: false,
      defaultBranch: "main",
    };
  }
  return undefined;
}

export function addThreadToSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationReadModel {
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    threads: [
      ...snapshot.threads,
      {
        id: threadId,
        projectId: PROJECT_ID,
        title: "New thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: "main",
        worktreePath: null,
        effectiveCwd: null,
        goal: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        archivedAt: null,
        pinnedAt: null,
        pullRequestAutoFix: false,
        pullRequestAutoMerge: null,
        linkedPullRequests: [],
        participants: [],
        doneOverride: null,
        lastSeenAt: null,
        deletedAt: null,
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        diffStatBaselineTurnCount: 0,
        agentRequests: EMPTY_AGENT_REQUEST_STATE,
        ...NO_CHILD_THREAD_FIELDS,
        session: {
          threadId,
          providerThreadId: null,
          providerSessionId: null,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
  };
}

function toShellThread(thread: OrchestrationReadModel["threads"][number]) {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestTurn: thread.latestTurn,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    doneOverride: thread.doneOverride,
    lastSeenAt: thread.lastSeenAt,
    session: thread.session,
    latestUserMessageAt:
      thread.messages.findLast((message) => message.role === "user")?.createdAt ?? null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...(thread.move ? { move: thread.move } : {}),
    ...(thread.movedFrom ? { movedFrom: thread.movedFrom } : {}),
  };
}

export function toShellSnapshot(snapshot: OrchestrationReadModel) {
  return {
    snapshotSequence: snapshot.snapshotSequence,
    projects: snapshot.projects.map((project) => ({
      id: project.id,
      kind: project.kind,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      repositoryIdentity: project.repositoryIdentity ?? null,
      defaultModelSelection: project.defaultModelSelection,
      scripts: project.scripts,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    })),
    threads: snapshot.threads.map(toShellThread),
    updatedAt: snapshot.updatedAt,
  };
}

/**
 * Puts a thread to work, or has it wait on the user, the way the shell
 * stream's next summary would, without a server round trip. Use it on a
 * thread that is not open: the open one's detail stream re-derives its row.
 */
export function setSidebarThreadWork(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  work: "working" | "needs-you",
  overrides: Partial<SidebarThreadSummary> = {},
): void {
  useStore.setState((state) => {
    const environment = state.environmentStateById[environmentId];
    const summary = environment?.sidebarThreadSummaryById[threadId];
    if (!environment || !summary) {
      throw new Error(`No sidebar summary for ${environmentId}/${threadId}.`);
    }
    const next: SidebarThreadSummary =
      work === "working"
        ? {
            ...summary,
            latestTurn: {
              turnId: `turn-${threadId}` as TurnId,
              state: "running",
              requestedAt: NOW_ISO,
              startedAt: NOW_ISO,
              completedAt: null,
              assistantMessageId: null,
            },
            session: summary.session
              ? { ...summary.session, status: "running", orchestrationStatus: "running" }
              : summary.session,
            ...overrides,
          }
        : { ...summary, hasPendingApprovals: true, ...overrides };
    return {
      environmentStateById: {
        ...state.environmentStateById,
        [environmentId]: {
          ...environment,
          sidebarThreadSummaryById: { ...environment.sidebarThreadSummaryById, [threadId]: next },
        },
      },
    };
  });
}

/**
 * A second computer's threads, as its shell stream would leave them in the
 * store: a copy of this computer's state holding only the given threads.
 */
export function injectRemoteEnvironmentThreads(
  environmentId: EnvironmentId,
  threads: ReadonlyArray<{ readonly id: ThreadId; readonly title: string }>,
): void {
  useStore.setState((state) => {
    const local = state.environmentStateById[LOCAL_ENVIRONMENT_ID]!;
    const template = local.sidebarThreadSummaryById[THREAD_ID]!;
    const shellTemplate = local.threadShellById[THREAD_ID]!;
    const project = local.projectById[PROJECT_ID]!;
    return {
      environmentStateById: {
        ...state.environmentStateById,
        [environmentId]: {
          ...local,
          projectIds: [PROJECT_ID],
          projectById: { [PROJECT_ID]: { ...project, environmentId } },
          threadIds: threads.map((thread) => thread.id),
          threadIdsByProjectId: { [PROJECT_ID]: threads.map((thread) => thread.id) },
          sidebarThreadSummaryById: Object.fromEntries(
            threads.map((thread) => [
              thread.id,
              { ...template, id: thread.id, environmentId, title: thread.title },
            ]),
          ),
          threadShellById: Object.fromEntries(
            threads.map((thread) => [
              thread.id,
              { ...shellTemplate, id: thread.id, environmentId, title: thread.title },
            ]),
          ),
        },
      },
    };
  });
}

export const FLEET_REMOTE_ENVIRONMENT_ID = EnvironmentId.make("environment-windows");
export const FLEET_OFFLINE_ENVIRONMENT_ID = EnvironmentId.make("environment-mac-mini");

/**
 * Saves computers the way Settings › Connections does, then sets what the
 * connection service would report for each, once its first (credential-less)
 * attempt has settled.
 */
export async function saveFleetComputers(
  computers: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly os: "darwin" | "windows" | "linux";
    readonly state: "connected" | "connecting" | "disconnected";
    readonly lastConnectedAt?: string;
  }>,
): Promise<void> {
  for (const computer of computers) {
    useSavedEnvironmentRegistryStore.getState().upsert({
      environmentId: computer.environmentId,
      label: computer.label,
      httpBaseUrl: `https://${computer.environmentId}.example.test`,
      wsBaseUrl: `wss://${computer.environmentId}.example.test/ws`,
      createdAt: NOW_ISO,
      lastConnectedAt: computer.lastConnectedAt ?? NOW_ISO,
    });
  }
  await vi.waitFor(
    () => {
      for (const computer of computers) {
        expect(
          useSavedEnvironmentRuntimeStore.getState().byId[computer.environmentId]?.authState,
        ).toBe("requires-auth");
      }
    },
    { timeout: 8_000, interval: 16 },
  );
  for (const computer of computers) {
    useSavedEnvironmentRuntimeStore.getState().patch(computer.environmentId, {
      connectionState: computer.state,
      authState: "authenticated",
      lastError: null,
      route: computer.state === "connected" ? "direct" : null,
      descriptor: {
        ...fixture.serverConfig.environment,
        environmentId: computer.environmentId,
        label: computer.label,
        platform: { os: computer.os, arch: "x64" },
      },
      ...(computer.state === "disconnected"
        ? { disconnectedAt: computer.lastConnectedAt ?? NOW_ISO }
        : {}),
    });
  }
}

/** This computer's server, and the computers saved from its config, take links. */
export function withComputerLinksFixture(nextFixture: TestFixture): void {
  const capabilities = {
    ...nextFixture.serverConfig.environment.capabilities,
    computerLinks: true,
  };
  nextFixture.serverConfig = {
    ...nextFixture.serverConfig,
    environment: { ...nextFixture.serverConfig.environment, capabilities },
  };
  nextFixture.welcome = {
    ...nextFixture.welcome,
    environment: { ...nextFixture.welcome.environment, capabilities },
  };
}

export function fleetLinksSnapshot(parts: Partial<ComputerLinksSnapshot>): ComputerLinksSnapshot {
  return { outbound: [], inbound: [], pending: [], ...parts };
}

/** This computer's own link to `remote`. */
export function fleetOutboundLink(
  remote: EnvironmentId,
  remoteLabel: string,
  overrides: Partial<OutboundComputerLink> = {},
): OutboundComputerLink {
  return {
    linkId: ComputerLinkId.make(`link-to-${remote}`),
    remoteEnvironmentId: remote,
    remoteLabel,
    remotePlatform: null,
    state: "active",
    connection: "idle",
    route: null,
    createdAt: NOW_ISO,
    lastConnectedAt: null,
    lastError: null,
    ...overrides,
  };
}

export function fleetPendingRequest(
  from: EnvironmentId,
  requestId: string,
  title: string,
): ComputerLinkPendingRequest {
  return {
    deviceId: `device-${from}`,
    requestId: ChildRequestId.make(requestId),
    fromLabel: "Mac mini",
    parentEnvironmentId: from,
    parentThreadId: `thread-asking-${requestId}` as ThreadId,
    parentThreadTitle: "Release checklist",
    askedBy: "Codex",
    title,
    prompt: "Run the tests and tell me what fails.",
    projectName: "Orbit",
    agent: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "auto",
    createdAt: NOW_ISO,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
}

export function fleetInvite(environmentId: EnvironmentId, label: string): ComputerLinkInvite {
  return {
    hostId: RelayHostId.make(`host-${environmentId}`),
    relayOrigin: "https://relay.example.test",
    inviteId: RelayInviteId.make(`invite-${environmentId}`),
    inviteSecret: "secret",
    hostPublicKey: "key",
    directOrigins: [],
    environmentId,
    label,
    expiresAt: "2099-01-01T00:10:00.000Z",
  };
}

/** A saved computer's links calls, as its server would take them. */
export function fakeComputerLinksClient() {
  const setAccess = vi.fn(async () => ({}));
  const accept = vi.fn(async () => ({ state: "active" }));
  const remove = vi.fn(async () => ({ otherComputer: "confirmed" as const }));
  const respondRequest = vi.fn(async () => undefined);
  const createInvite = vi.fn(async () => fleetInvite(FLEET_REMOTE_ENVIRONMENT_ID, "Windows PC"));
  return {
    setAccess,
    accept,
    remove,
    respondRequest,
    createInvite,
    client: {
      subscribe: () => () => undefined,
      setAccess,
      accept,
      remove,
      respondRequest,
      createInvite,
    } as unknown as ComputerLinksClient,
  };
}

/** This computer's server, and the computers saved from its config, set up projects. */
export function withProjectSetupFixture(nextFixture: TestFixture): void {
  const capabilities = {
    ...nextFixture.serverConfig.environment.capabilities,
    projectSetup: true,
  };
  nextFixture.serverConfig = {
    ...nextFixture.serverConfig,
    environment: { ...nextFixture.serverConfig.environment, capabilities },
  };
  nextFixture.welcome = {
    ...nextFixture.welcome,
    environment: { ...nextFixture.welcome.environment, capabilities },
  };
}

export const PROJECT_REPOSITORY_KEY = "github.com/acme/project";

/** The test project's repository, as its computer resolves it. */
export function projectRepositoryIdentity(
  overrides: Partial<RepositoryIdentity> = {},
): RepositoryIdentity {
  return {
    canonicalKey: PROJECT_REPOSITORY_KEY,
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:acme/project.git",
    },
    rootPath: "/repo/project",
    ...overrides,
  };
}

/** The test project with a git repository behind it, so it can be set up elsewhere. */
export function withProjectRepository(snapshot: OrchestrationReadModel): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === PROJECT_ID
        ? { ...project, repositoryIdentity: projectRepositoryIdentity() }
        : project,
    ),
  };
}

/**
 * A second computer's projects, as its shell stream would leave them in the
 * store: a copy of this computer's state holding only the given projects.
 */
export function injectRemoteEnvironmentProjects(
  environmentId: EnvironmentId,
  projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly name: string;
    readonly cwd: string;
    readonly repositoryIdentity: RepositoryIdentity | null;
  }>,
): void {
  useStore.setState((state) => {
    const local = state.environmentStateById[LOCAL_ENVIRONMENT_ID]!;
    const template = local.projectById[PROJECT_ID]!;
    return {
      environmentStateById: {
        ...state.environmentStateById,
        [environmentId]: {
          ...local,
          projectIds: projects.map((project) => project.id),
          projectById: Object.fromEntries(
            projects.map((project) => [project.id, { ...template, ...project, environmentId }]),
          ),
          threadIds: [],
          threadIdsByProjectId: {},
          sidebarThreadSummaryById: {},
          threadShellById: {},
        },
      },
    };
  });
}

/** What the test project's computer says another computer needs to copy it. */
export const PROJECT_SETUP_SOURCE: ProjectSetupSource = {
  projectId: PROJECT_ID,
  title: "Project",
  repositoryKey: PROJECT_REPOSITORY_KEY,
  subdirectory: "",
  remotes: [{ name: "origin", url: "git@github.com:acme/project.git", protocol: "ssh" }],
  primaryRemoteName: "origin",
  scripts: [],
  homeRelativePath: "code/project",
  folderName: "project",
  files: [
    { path: "notes.txt", size: 120, suggested: false, tooLarge: false },
    { path: ".env", size: 64, suggested: true, tooLarge: false },
    { path: "fixtures/big.bin", size: 3_000_000, suggested: false, tooLarge: true },
    { path: "apps/web/.env.local", size: 2_048, suggested: true, tooLarge: false },
  ],
  filesTruncated: false,
  sizeBytes: 50 * 1024 * 1024,
};

/** A job on the computer that gets the copy, as its stream would list it. */
export function projectSetupJob(overrides: Partial<ProjectSetupJob> = {}): ProjectSetupJob {
  return {
    setupId: ProjectSetupId.make("setup-browser"),
    source: { environmentId: LOCAL_ENVIRONMENT_ID, projectId: PROJECT_ID, label: "This Mac" },
    title: "Project",
    repositoryKey: PROJECT_REPOSITORY_KEY,
    subdirectory: "",
    protocol: "ssh",
    destinationPath: "~/code/project",
    filePaths: [],
    stage: "cloning",
    progress: { phase: null, percent: null, detail: null, stalled: false },
    projectId: null,
    error: null,
    warnings: [],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

/**
 * A saved computer's projectSetups calls, as its server would take them. A
 * start answers a job that has begun cloning; `push` sends the computer's
 * job list down its stream.
 */
export function fakeProjectSetupsClient(options?: {
  readonly destination?: (
    input: ProjectSetupInspectDestinationInput,
  ) => ProjectSetupDestination["state"];
}) {
  let listener: ((snapshot: { readonly jobs: ReadonlyArray<ProjectSetupJob> }) => void) | null =
    null;
  const inspectDestination = vi.fn(async (input: ProjectSetupInspectDestinationInput) => ({
    resolvedPath: input.path.replace(/^~/, "/Users/me"),
    state: options?.destination?.(input) ?? ("missing" as const),
  }));
  const start = vi.fn(async (input: ProjectSetupStartInput) =>
    projectSetupJob({
      setupId: input.setupId,
      source: input.source,
      title: input.title,
      destinationPath: input.destinationPath,
      protocol: input.protocol,
      filePaths: input.files.map((file) => file.path),
      ...(input.expectedBytes !== undefined ? { expectedBytes: input.expectedBytes } : {}),
      progress: {
        phase: "Receiving objects",
        percent: 12,
        detail: "1.20 MiB | 600 KiB/s",
        stalled: false,
      },
    }),
  );
  const cancel = vi.fn(async () => undefined);
  const dismiss = vi.fn(async () => undefined);
  return {
    inspectDestination,
    start,
    cancel,
    dismiss,
    /** The job list the computer streams, as it changes. */
    push: (jobs: ReadonlyArray<ProjectSetupJob>) => listener?.({ jobs }),
    subscribed: () => listener !== null,
    client: {
      source: async () => {
        throw new Error("Not the source computer.");
      },
      readFiles: async () => {
        throw new Error("Not the source computer.");
      },
      inspectDestination,
      start,
      cancel,
      dismiss,
      subscribe: (next: (snapshot: { readonly jobs: ReadonlyArray<ProjectSetupJob> }) => void) => {
        listener = next;
        return () => {
          if (listener === next) listener = null;
        };
      },
    } as unknown as ProjectSetupsClient,
  };
}

function updateThreadSessionInSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
  session: OrchestrationReadModel["threads"][number]["session"],
): OrchestrationReadModel {
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    threads: snapshot.threads.map((thread) =>
      thread.id === threadId
        ? {
            ...thread,
            session,
            updatedAt: NOW_ISO,
          }
        : thread,
    ),
  };
}

function addUserMessageToThreadInSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationReadModel {
  const messageId = `msg-user-promoted-${threadId}` as MessageId;
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    threads: snapshot.threads.map((thread) =>
      thread.id === threadId
        ? {
            ...thread,
            messages: thread.messages.some((message) => message.id === messageId)
              ? thread.messages
              : [
                  ...thread.messages,
                  createUserMessage({
                    id: messageId,
                    text: "promoted draft user message",
                    offsetSeconds: 0,
                  }),
                ],
            updatedAt: NOW_ISO,
          }
        : thread,
    ),
  };
}

function setPromotedServerLatestTurnInSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationReadModel {
  const turnId = `turn-${threadId}` as TurnId;
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    threads: snapshot.threads.map((thread) =>
      thread.id === threadId
        ? {
            ...thread,
            latestTurn: {
              turnId,
              state: "running",
              requestedAt: NOW_ISO,
              startedAt: NOW_ISO,
              completedAt: null,
              assistantMessageId: null,
            },
            updatedAt: NOW_ISO,
          }
        : thread,
    ),
  };
}

export function sendShellThreadUpsert(
  threadId: ThreadId,
  options?: {
    readonly session?: OrchestrationReadModel["threads"][number]["session"];
  },
): void {
  const thread = fixture.snapshot.threads.find((entry) => entry.id === threadId);
  if (!thread) {
    throw new Error(`Expected thread ${threadId} in snapshot.`);
  }

  const shellThread =
    options?.session !== undefined
      ? toShellThread({ ...thread, session: options.session })
      : toShellThread(thread);
  rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeShell, {
    kind: "thread-upserted",
    sequence: fixture.snapshot.snapshotSequence,
    thread: shellThread,
  });
}

async function waitForWsClient(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        wsRequests.some((request) => request._tag === ORCHESTRATION_WS_METHODS.subscribeShell),
      ).toBe(true);
      expect(
        wsRequests.some((request) => request._tag === WS_METHODS.subscribeServerLifecycle),
      ).toBe(true);
      expect(wsRequests.some((request) => request._tag === WS_METHODS.subscribeServerConfig)).toBe(
        true,
      );
    },
    { timeout: 8_000, interval: 16 },
  );
}

export async function waitForThreadDetailSubscription(threadId: ThreadId): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        wsRequests.some(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.subscribeThread &&
            request.threadId === threadId,
        ),
      ).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

/**
 * Waits for a local thread's first detail snapshot to land. A page subscribes
 * to the details of the threads it shows, and that snapshot rewrites the
 * thread's summary: a thread marked working with `setSidebarThreadWork`
 * before then goes back to idle when the snapshot arrives, which on a slow
 * machine can be after the test has started looking.
 */
export async function waitForThreadDetailLoaded(threadId: ThreadId): Promise<void> {
  await vi.waitFor(
    () => {
      expect(selectThreadDetailLoaded(useStore.getState(), threadRefFor(threadId))).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

export function threadRefFor(threadId: ThreadId) {
  return scopeThreadRef(LOCAL_ENVIRONMENT_ID, threadId);
}

function threadKeyFor(threadId: ThreadId): string {
  return scopedThreadKey(threadRefFor(threadId));
}

export function composerDraftFor(target: string) {
  const { draftsByThreadKey } = useComposerDraftStore.getState();
  return draftsByThreadKey[target] ?? draftsByThreadKey[threadKeyFor(target as ThreadId)];
}

export function draftIdFromPath(pathname: string) {
  const segments = pathname.split("/");
  const draftId = segments[segments.length - 1];
  if (!draftId) {
    throw new Error(`Expected thread path, received "${pathname}".`);
  }
  return DraftId.make(draftId);
}

export function draftThreadIdFor(draftId: ReturnType<typeof draftIdFromPath>): ThreadId {
  const draftSession = useComposerDraftStore.getState().getDraftSession(draftId);
  if (!draftSession) {
    throw new Error(`Expected draft session for "${draftId}".`);
  }
  return draftSession.threadId;
}

export function serverThreadPath(threadId: ThreadId): string {
  return `/${LOCAL_ENVIRONMENT_ID}/${threadId}`;
}

async function waitForAppBootstrap(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(getServerConfig()).not.toBeNull();
      expect(selectBootstrapCompleteForActiveEnvironment(useStore.getState())).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

export async function materializePromotedDraftThreadViaDomainEvent(
  threadId: ThreadId,
): Promise<void> {
  await waitForWsClient();
  fixture.snapshot = addThreadToSnapshot(fixture.snapshot, threadId);
  fixture.snapshot = updateThreadSessionInSnapshot(fixture.snapshot, threadId, null);
  sendShellThreadUpsert(threadId, { session: null });
}

export async function setPromotedServerThreadRunningViaDomainEvent(
  threadId: ThreadId,
): Promise<void> {
  fixture.snapshot = updateThreadSessionInSnapshot(fixture.snapshot, threadId, {
    threadId,
    providerThreadId: null,
    providerSessionId: null,
    status: "running",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: `turn-${threadId}` as TurnId,
    lastError: null,
    updatedAt: NOW_ISO,
  });
  sendShellThreadUpsert(threadId);
}

export async function addPromotedServerUserMessageViaDomainEvent(
  threadId: ThreadId,
): Promise<void> {
  fixture.snapshot = addUserMessageToThreadInSnapshot(fixture.snapshot, threadId);
  sendShellThreadUpsert(threadId);
}

export function emitPromotedServerUserMessageDetailEvent(threadId: ThreadId): void {
  const messageId = `msg-user-promoted-${threadId}` as MessageId;
  const event: OrchestrationEvent = {
    sequence: fixture.snapshot.snapshotSequence,
    eventId: EventId.make(`evt-user-promoted-${threadId}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: NOW_ISO,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.message-sent",
    payload: {
      threadId,
      messageId,
      role: "user",
      text: "promoted draft user message",
      turnId: null,
      streaming: false,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
  };
  rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
    kind: "event",
    event,
  });
}

export async function startPromotedServerTurnViaDomainEvent(threadId: ThreadId): Promise<void> {
  fixture.snapshot = setPromotedServerLatestTurnInSnapshot(fixture.snapshot, threadId);
  sendShellThreadUpsert(threadId);
}

async function startPromotedServerThreadViaDomainEvent(threadId: ThreadId): Promise<void> {
  fixture.snapshot = setPromotedServerLatestTurnInSnapshot(
    addUserMessageToThreadInSnapshot(
      updateThreadSessionInSnapshot(fixture.snapshot, threadId, {
        threadId,
        providerThreadId: null,
        providerSessionId: null,
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: `turn-${threadId}` as TurnId,
        lastError: null,
        updatedAt: NOW_ISO,
      }),
      threadId,
    ),
    threadId,
  );
  sendShellThreadUpsert(threadId);
}

export async function promoteDraftThreadViaDomainEvent(threadId: ThreadId): Promise<void> {
  await materializePromotedDraftThreadViaDomainEvent(threadId);
  await startPromotedServerThreadViaDomainEvent(threadId);
  await vi.waitFor(
    () => {
      expect(useComposerDraftStore.getState().draftThreadsByThreadKey[threadKeyFor(threadId)]).toBe(
        undefined,
      );
    },
    { timeout: 8_000, interval: 16 },
  );
}

export function createDraftOnlySnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-draft-target" as MessageId,
    targetText: "draft thread",
  });
  return {
    ...snapshot,
    threads: [],
  };
}

export function createSnapshotWithChangedFileSummary(): OrchestrationReadModel {
  const turnId = "turn-chat-diff" as TurnId;
  const assistantMessageId = "assistant-chat-diff" as MessageId;
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-chat-diff-target" as MessageId,
    targetText: "show changed files",
  });
  const thread = snapshot.threads[0];
  if (!thread) {
    return snapshot;
  }

  return {
    ...snapshot,
    threads: [
      {
        ...thread,
        messages: [
          createUserMessage({
            id: "user-chat-diff" as MessageId,
            text: "show changed files",
            offsetSeconds: 0,
          }),
          {
            ...createAssistantMessage({
              id: assistantMessageId,
              text: "I changed a diff panel.",
              offsetSeconds: 3,
            }),
            turnId,
          },
        ],
        checkpoints: [
          {
            turnId,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make(
              "refs/threadlines/checkpoints/thread-browser-test/turn/1",
            ),
            status: "ready",
            assistantMessageId,
            completedAt: isoAt(10),
            files: [
              {
                path: "apps/web/src/components/DiffPanel.tsx",
                kind: "modified",
                additions: 11,
                deletions: 12,
              },
            ],
          },
        ],
      },
    ],
  };
}

export function createSnapshotForRevertPreview(): OrchestrationReadModel {
  const snapshot = createSnapshotWithChangedFileSummary();
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) => ({
      ...thread,
      activities: [
        {
          id: EventId.make("activity-revert-conflict"),
          tone: "warning" as const,
          kind: "checkpoint.reverted",
          summary: "Reverted 1 file; left 1 file with conflicting edits untouched: REVERT_TEST.md",
          payload: {
            turnCount: 0,
            mode: "selective",
            revertedFileCount: 1,
            conflictPathCount: 1,
            conflicts: [{ path: "REVERT_TEST.md", reason: "interleaved" }],
          },
          turnId: null,
          createdAt: isoAt(12),
        },
      ],
    })),
  };
}

export function createProjectlessSnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-projectless-target" as MessageId,
    targetText: "projectless",
  });
  return {
    ...snapshot,
    projects: [],
    threads: [],
  };
}

export function withProjectScripts(
  snapshot: OrchestrationReadModel,
  scripts: OrchestrationReadModel["projects"][number]["scripts"],
): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === PROJECT_ID ? { ...project, scripts: Array.from(scripts) } : project,
    ),
  };
}

/** The test computer's Codex, listing models the model picker can show. */
export function withCodexModels(nextFixture: TestFixture): void {
  nextFixture.serverConfig = {
    ...nextFixture.serverConfig,
    providers: [
      {
        ...nextFixture.serverConfig.providers[0]!,
        models: ["gpt-5.6-sol", "gpt-6-astra"].map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: createModelCapabilities({ optionDescriptors: [] }),
        })),
      },
    ],
  };
}

export function setDraftThreadWithoutWorktree(): void {
  useComposerDraftStore.setState({
    draftThreadsByThreadKey: {
      [THREAD_KEY]: {
        threadId: THREAD_ID,
        environmentId: LOCAL_ENVIRONMENT_ID,
        projectId: PROJECT_ID,
        logicalProjectKey: PROJECT_DRAFT_KEY,
        createdAt: NOW_ISO,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        envMode: "local",
      },
    },
    logicalProjectDraftThreadKeyByLogicalProjectKey: {
      [PROJECT_DRAFT_KEY]: THREAD_KEY,
    },
  });
}

export function createSnapshotWithLongProposedPlan(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-plan-target" as MessageId,
    targetText: "plan thread",
  });
  const planMarkdown = [
    "# Ship plan mode follow-up",
    "",
    "- Step 1: capture the thread-open trace",
    "- Step 2: identify the main-thread bottleneck",
    "- Step 3: keep collapsed cards cheap",
    "- Step 4: render the full markdown only on demand",
    "- Step 5: preserve export and save actions",
    "- Step 6: add regression coverage",
    "- Step 7: verify route transitions stay responsive",
    "- Step 8: confirm no server-side work changed",
    "- Step 9: confirm short plans still render normally",
    "- Step 10: confirm long plans stay collapsed by default",
    "- Step 11: confirm preview text is still useful",
    "- Step 12: confirm plan follow-up flow still works",
    "- Step 13: confirm timeline virtualization still behaves",
    "- Step 14: confirm theme styling still looks correct",
    "- Step 15: confirm save dialog behavior is unchanged",
    "- Step 16: confirm download behavior is unchanged",
    "- Step 17: confirm code fences do not parse until expand",
    "- Step 18: confirm preview truncation ends cleanly",
    "- Step 19: confirm markdown links still open in editor after expand",
    "- Step 20: confirm deep hidden detail only appears after expand",
    "",
    "```ts",
    "export const hiddenPlanImplementationDetail = 'deep hidden detail only after expand';",
    "```",
  ].join("\n");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            proposedPlans: [
              {
                id: "plan-browser-test",
                turnId: null,
                planMarkdown,
                implementedAt: null,
                implementationThreadId: null,
                dismissedAt: null,
                createdAt: isoAt(1_000),
                updatedAt: isoAt(1_001),
              },
            ],
            updatedAt: isoAt(1_001),
          })
        : thread,
    ),
  };
}

export function createSnapshotWithSecondaryProject(options?: {
  includeSecondaryThread?: boolean;
  includeArchivedSecondaryThread?: boolean;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-secondary-project-target" as MessageId,
    targetText: "secondary project",
  });
  const includeSecondaryThread = options?.includeSecondaryThread ?? true;
  const includeArchivedSecondaryThread = options?.includeArchivedSecondaryThread ?? true;
  const secondaryThreads: OrchestrationReadModel["threads"] = includeSecondaryThread
    ? [
        {
          id: "thread-secondary-project" as ThreadId,
          projectId: SECOND_PROJECT_ID,
          title: "Release checklist",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: "release/docs-portal",
          worktreePath: null,
          effectiveCwd: null,
          goal: null,
          latestTurn: null,
          createdAt: isoAt(30),
          updatedAt: isoAt(31),
          deletedAt: null,
          pinnedAt: null,
          pullRequestAutoFix: false,
          pullRequestAutoMerge: null,
          linkedPullRequests: [],
          participants: [],
          doneOverride: null,
          lastSeenAt: null,
          messages: [],
          activities: [],
          proposedPlans: [],
          checkpoints: [],
          diffStatBaselineTurnCount: 0,
          agentRequests: EMPTY_AGENT_REQUEST_STATE,
          ...NO_CHILD_THREAD_FIELDS,
          session: {
            threadId: "thread-secondary-project" as ThreadId,
            providerThreadId: null,
            providerSessionId: null,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: isoAt(31),
          },
          archivedAt: null,
        },
      ]
    : [];
  const archivedSecondaryThreads: OrchestrationReadModel["threads"] = includeArchivedSecondaryThread
    ? [
        {
          id: ARCHIVED_SECONDARY_THREAD_ID,
          projectId: SECOND_PROJECT_ID,
          title: "Archived Docs Notes",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: "release/docs-archive",
          worktreePath: null,
          effectiveCwd: null,
          goal: null,
          latestTurn: null,
          createdAt: isoAt(24),
          updatedAt: isoAt(25),
          deletedAt: null,
          pinnedAt: null,
          pullRequestAutoFix: false,
          pullRequestAutoMerge: null,
          linkedPullRequests: [],
          participants: [],
          doneOverride: null,
          lastSeenAt: null,
          messages: [],
          activities: [],
          proposedPlans: [],
          checkpoints: [],
          diffStatBaselineTurnCount: 0,
          agentRequests: EMPTY_AGENT_REQUEST_STATE,
          ...NO_CHILD_THREAD_FIELDS,
          session: {
            threadId: ARCHIVED_SECONDARY_THREAD_ID,
            providerThreadId: null,
            providerSessionId: null,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: isoAt(25),
          },
          archivedAt: isoAt(26),
        },
      ]
    : [];

  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
      {
        id: SECOND_PROJECT_ID,
        kind: "workspace" as const,
        title: "Docs Portal",
        workspaceRoot: "/repo/clients/docs-portal",
        defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [...snapshot.threads, ...secondaryThreads, ...archivedSecondaryThreads],
  };
}

export function createSnapshotWithPendingUserInput(options?: {
  isBlocking?: boolean;
  running?: boolean;
  signIn?: boolean;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-pending-input-target" as MessageId,
    targetText: options?.signIn ? "Check that the VM is ready to use." : "question thread",
    ...(options?.running
      ? { sessionStatus: "running", sessionActiveTurnId: "turn-pending-input" as TurnId }
      : {}),
  });

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            interactionMode: "plan",
            ...(options?.signIn
              ? {
                  title: "Set up the VM",
                  messages: [
                    createUserMessage({
                      id: "msg-sign-in-user" as MessageId,
                      text: "Check that the VM is ready to use.",
                      offsetSeconds: 0,
                    }),
                    createAssistantMessage({
                      id: "msg-sign-in-agent" as MessageId,
                      text: options.isBlocking
                        ? "The repository is ready. I need your sign-in result before I can check the provider connections."
                        : "The repository is ready. I will check the workspace files while you sign into the providers.",
                      offsetSeconds: 1,
                    }),
                  ],
                }
              : {}),
            activities: [
              {
                id: EventId.make("activity-user-input-requested"),
                tone: "info",
                kind: "user-input.requested",
                summary: "User input requested",
                payload: {
                  requestId: "req-browser-user-input",
                  isBlocking: options?.isBlocking ?? true,
                  questions: options?.signIn
                    ? [
                        {
                          id: "sign_in",
                          header: "Provider sign-in",
                          question:
                            "Please sign into Codex and Claude using their buttons in the VM, then tell me when both are done.",
                          options: [
                            {
                              label: "Both are signed in",
                              description: "Ready to verify the clone picker.",
                            },
                            {
                              label: "Only one worked",
                              description: "One provider still needs help.",
                            },
                            {
                              label: "I am still signing in",
                              description: "Keep the VM page where it is.",
                            },
                          ],
                        },
                      ]
                    : [
                        {
                          id: "scope",
                          header: "Scope",
                          question: "What should this change cover?",
                          options: [
                            {
                              label: "Tight",
                              description: "Touch only the footer layout logic.",
                            },
                            {
                              label: "Broad",
                              description: "Also adjust the related composer controls.",
                            },
                          ],
                        },
                        {
                          id: "risk",
                          header: "Risk",
                          question: "How aggressive should the imaginary plan be?",
                          options: [
                            {
                              label: "Conservative",
                              description: "Favor reliability and low-risk changes.",
                            },
                            {
                              label: "Balanced",
                              description: "Mix quick wins with one structural improvement.",
                            },
                          ],
                        },
                      ],
                },
                turnId: null,
                sequence: 1,
                createdAt: isoAt(1_000),
              },
            ],
            updatedAt: isoAt(1_000),
          })
        : thread,
    ),
  };
}

export function createSnapshotWithPlanFollowUpPrompt(options?: {
  modelSelection?: { instanceId: ProviderInstanceId; model: string };
  planMarkdown?: string;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-plan-follow-up-target" as MessageId,
    targetText: "plan follow-up thread",
  });
  const modelSelection = options?.modelSelection ?? {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5",
  };
  const planMarkdown =
    options?.planMarkdown ?? "# Follow-up plan\n\n- Keep the composer footer stable on resize.";

  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === PROJECT_ID ? { ...project, defaultModelSelection: modelSelection } : project,
    ),
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            modelSelection,
            interactionMode: "plan",
            latestTurn: {
              turnId: "turn-plan-follow-up" as TurnId,
              state: "completed",
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: isoAt(1_010),
              assistantMessageId: null,
            },
            proposedPlans: [
              {
                id: "plan-follow-up-browser-test",
                turnId: "turn-plan-follow-up" as TurnId,
                planMarkdown,
                implementedAt: null,
                implementationThreadId: null,
                dismissedAt: null,
                createdAt: isoAt(1_002),
                updatedAt: isoAt(1_003),
              },
            ],
            session: {
              ...thread.session,
              status: "ready",
              updatedAt: isoAt(1_010),
            },
            updatedAt: isoAt(1_010),
          })
        : thread,
    ),
  };
}

export const CLAUDE_TEST_PROVIDER: ServerConfig["providers"][number] = {
  driver: ProviderDriverKind.make("claudeAgent"),
  instanceId: ProviderInstanceId.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.1.117",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: NOW_ISO,
  models: [],
  slashCommands: [],
  skills: [],
};

/** A Claude thread whose last turn completed and left a prompt suggestion behind. */
export function createSnapshotWithPromptSuggestion(suggestion: string): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-prompt-suggestion-target" as MessageId,
    targetText: "prompt suggestion thread",
  });
  const modelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus-4-7",
  };
  const turnId = "turn-prompt-suggestion" as TurnId;

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            modelSelection,
            latestTurn: {
              turnId,
              state: "completed",
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: isoAt(1_010),
              assistantMessageId: null,
            },
            activities: [
              {
                id: EventId.make("activity-prompt-suggestion"),
                tone: "info" as const,
                kind: "prompt-suggestion.updated",
                summary: "Prompt suggestion updated",
                payload: { suggestion },
                turnId,
                createdAt: isoAt(1_011),
              },
            ],
            session: {
              ...thread.session,
              providerName: "claudeAgent",
              status: "ready",
              updatedAt: isoAt(1_010),
            },
            updatedAt: isoAt(1_011),
          })
        : thread,
    ),
  };
}

function resolveWsRpc(body: NormalizedWsRpcRequestBody): unknown {
  const customResult = customWsRpcResolver?.(body);
  if (customResult !== undefined) {
    return customResult;
  }
  const tag = body._tag;
  // Accept commands by default, the way a connected server does. Optimistic UI
  // rolls back on a rejected dispatch, so without this every action that goes
  // through the orchestration command path silently snaps back.
  if (tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
    return { sequence: fixture.snapshot.snapshotSequence + 1 };
  }
  if (tag === WS_METHODS.serverGetConfig) {
    return encodeServerConfig(fixture.serverConfig);
  }
  if (tag === WS_METHODS.serverDiscoverSourceControl) {
    return {
      versionControlSystems: [],
      sourceControlProviders: [
        {
          kind: "github",
          label: "GitHub",
          executable: "gh",
          status: "available",
          version: Option.some("gh version 2.0.0"),
          installHint: "Install GitHub CLI.",
          detail: Option.none(),
          auth: {
            status: "authenticated",
            account: Option.some("t3-oss"),
            host: Option.some("github.com"),
            detail: Option.none(),
          },
        },
        {
          kind: "gitlab",
          label: "GitLab",
          executable: "glab",
          status: "available",
          version: Option.some("glab version 1.0.0"),
          installHint: "Install GitLab CLI.",
          detail: Option.none(),
          auth: {
            status: "authenticated",
            account: Option.some("t3-oss"),
            host: Option.some("gitlab.com"),
            detail: Option.none(),
          },
        },
        {
          kind: "bitbucket",
          label: "Bitbucket",
          executable: "Bitbucket REST API",
          status: "available",
          version: Option.none(),
          installHint: "Set Bitbucket API token environment variables.",
          detail: Option.none(),
          auth: {
            status: "authenticated",
            account: Option.some("t3-oss"),
            host: Option.some("bitbucket.org"),
            detail: Option.none(),
          },
        },
        {
          kind: "azure-devops",
          label: "Azure DevOps",
          executable: "az",
          status: "available",
          version: Option.some("azure-cli 2.0.0"),
          installHint: "Install Azure CLI.",
          detail: Option.none(),
          auth: {
            status: "authenticated",
            account: Option.some("t3-oss"),
            host: Option.some("dev.azure.com"),
            detail: Option.none(),
          },
        },
      ],
    };
  }
  if (tag === WS_METHODS.sourceControlListRepositories) {
    return {
      repositories: [
        {
          provider: "github",
          nameWithOwner: "t3-oss/t3-env",
          url: "https://github.com/t3-oss/t3-env",
          sshUrl: "git@github.com:t3-oss/t3-env.git",
        },
      ],
    };
  }
  if (tag === WS_METHODS.vcsListRefs) {
    return {
      isRepo: true,
      hasPrimaryRemote: true,
      nextCursor: null,
      totalCount: 1,
      refs: [
        {
          name: "main",
          current: true,
          isDefault: true,
          worktreePath: null,
        },
      ],
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return {
      entries: [],
      truncated: false,
    };
  }
  if (tag === WS_METHODS.shellOpenInEditor) {
    return null;
  }
  if (tag === WS_METHODS.terminalOpen) {
    // A script names tabs it may go into; here the first is always free.
    const reuseTerminalIds = Array.isArray(body.reuseTerminalIds) ? body.reuseTerminalIds : [];
    return {
      threadId: typeof body.threadId === "string" ? body.threadId : THREAD_ID,
      terminalId:
        typeof reuseTerminalIds[0] === "string"
          ? reuseTerminalIds[0]
          : typeof body.terminalId === "string"
            ? body.terminalId
            : "default",
      cwd: typeof body.cwd === "string" ? body.cwd : "/repo/project",
      worktreePath:
        typeof body.worktreePath === "string"
          ? body.worktreePath
          : body.worktreePath === null
            ? null
            : null,
      status: "running",
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: NOW_ISO,
    };
  }
  return {};
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    void rpcHarness.connect(client);
    client.addEventListener("message", (event) => {
      const rawData = event.data;
      if (typeof rawData !== "string") return;
      void rpcHarness.onMessage(rawData);
    });
  }),
  ...createAuthenticatedSessionHandlers(() => fixture.serverConfig.auth),
  http.get("*/attachments/:attachmentId", () =>
    HttpResponse.text(ATTACHMENT_SVG, {
      headers: {
        "Content-Type": "image/svg+xml",
      },
    }),
  ),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

export async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await nextFrame();
}

async function setViewport(viewport: ViewportSpec): Promise<void> {
  await page.viewport(viewport.width, viewport.height);
  await waitForLayout();
}

async function waitForProductionStyles(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      ).not.toBe("");
      expect(getComputedStyle(document.body).marginTop).toBe("0px");
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );
}

export async function waitForElement<T extends Element>(
  query: () => T | null,
  errorMessage: string | (() => string),
): Promise<T> {
  // Lazy messages read the DOM at failure time, so a timeout reports what
  // actually rendered instead of only what was expected.
  const resolveMessage = () => (typeof errorMessage === "string" ? errorMessage : errorMessage());
  let element: T | null = null;
  await vi.waitFor(
    () => {
      element = query();
      expect(element, resolveMessage()).toBeTruthy();
    },
    {
      timeout: 8_000,
      interval: 16,
    },
  );
  if (!element) {
    throw new Error(resolveMessage());
  }
  return element;
}

export async function waitForURL(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = "";
  await vi.waitFor(
    () => {
      pathname = router.state.location.pathname;
      expect(predicate(pathname), errorMessage).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
  return pathname;
}

export async function waitForComposerEditor(): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>('[contenteditable="true"]'),
    "Unable to find composer editor.",
  );
}

export async function pressComposerKey(key: string): Promise<void> {
  const composerEditor = await waitForComposerEditor();
  composerEditor.focus();
  const keydownEvent = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  composerEditor.dispatchEvent(keydownEvent);
  if (keydownEvent.defaultPrevented) {
    await waitForLayout();
    return;
  }

  const beforeInputEvent = new InputEvent("beforeinput", {
    data: key,
    inputType: "insertText",
    bubbles: true,
    cancelable: true,
  });
  composerEditor.dispatchEvent(beforeInputEvent);
  if (beforeInputEvent.defaultPrevented) {
    await waitForLayout();
    return;
  }

  if (
    typeof document.execCommand === "function" &&
    document.execCommand("insertText", false, key)
  ) {
    await waitForLayout();
    return;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    throw new Error("Unable to resolve composer selection for text input.");
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const textNode = document.createTextNode(key);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  composerEditor.dispatchEvent(
    new InputEvent("input", {
      data: key,
      inputType: "insertText",
      bubbles: true,
    }),
  );
  await waitForLayout();
}

export async function pressComposerUndo(): Promise<void> {
  const composerEditor = await waitForComposerEditor();
  const useMetaForMod = isMacPlatform(navigator.platform);
  composerEditor.focus();
  composerEditor.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "z",
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
  await waitForLayout();
}

export async function replaceComposerSelectionWithNativeSpellcheckText(
  replacement: string,
): Promise<void> {
  const composerEditor = await waitForComposerEditor();
  const beforeInputEvent = new InputEvent("beforeinput", {
    data: replacement,
    inputType: "insertReplacementText",
    bubbles: true,
    cancelable: true,
  });
  composerEditor.dispatchEvent(beforeInputEvent);
  if (
    !beforeInputEvent.defaultPrevented &&
    !document.execCommand("insertText", false, replacement)
  ) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      throw new Error("Unable to resolve composer selection for native replacement.");
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const textNode = document.createTextNode(replacement);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    composerEditor.dispatchEvent(
      new InputEvent("input", {
        data: replacement,
        inputType: "insertReplacementText",
        bubbles: true,
      }),
    );
  }
  await waitForLayout();
}

export async function waitForComposerText(expectedText: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt ?? "").toBe(
        expectedText,
      );
    },
    { timeout: 8_000, interval: 16 },
  );
}

export async function setComposerSelectionByTextOffsets(options: {
  start: number;
  end: number;
  direction?: "forward" | "backward";
}): Promise<void> {
  const composerEditor = await waitForComposerEditor();
  composerEditor.focus();
  const resolvePoint = (targetOffset: number) => {
    const traversedRef = { value: 0 };

    const visitNode = (node: Node): { node: Node; offset: number } | null => {
      if (node.nodeType === Node.TEXT_NODE) {
        const textLength = node.textContent?.length ?? 0;
        if (targetOffset <= traversedRef.value + textLength) {
          return {
            node,
            offset: Math.max(0, Math.min(targetOffset - traversedRef.value, textLength)),
          };
        }
        traversedRef.value += textLength;
        return null;
      }

      if (node instanceof HTMLBRElement) {
        const parent = node.parentNode;
        if (!parent) {
          return null;
        }
        const siblingIndex = Array.prototype.indexOf.call(parent.childNodes, node);
        if (targetOffset <= traversedRef.value) {
          return { node: parent, offset: siblingIndex };
        }
        if (targetOffset <= traversedRef.value + 1) {
          return { node: parent, offset: siblingIndex + 1 };
        }
        traversedRef.value += 1;
        return null;
      }

      if (node instanceof Element || node instanceof DocumentFragment) {
        for (const child of node.childNodes) {
          const point = visitNode(child);
          if (point) {
            return point;
          }
        }
      }

      return null;
    };

    return (
      visitNode(composerEditor) ?? {
        node: composerEditor,
        offset: composerEditor.childNodes.length,
      }
    );
  };

  const startPoint = resolvePoint(options.start);
  const endPoint = resolvePoint(options.end);
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Unable to resolve window selection.");
  }
  selection.removeAllRanges();

  if (options.direction === "backward" && "setBaseAndExtent" in selection) {
    selection.setBaseAndExtent(endPoint.node, endPoint.offset, startPoint.node, startPoint.offset);
    await waitForLayout();
    return;
  }

  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  selection.addRange(range);
  await waitForLayout();
}

export async function selectAllComposerContent(): Promise<void> {
  const composerEditor = await waitForComposerEditor();
  composerEditor.focus();
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Unable to resolve window selection.");
  }
  selection.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(composerEditor);
  selection.addRange(range);
  await waitForLayout();
}

export async function waitForComposerMenuItem(itemId: string): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>(`[data-composer-item-id="${itemId}"]`),
    `Unable to find composer menu item "${itemId}".`,
  );
}
export async function waitForSendButton(): Promise<HTMLButtonElement> {
  return waitForElement(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
    "Unable to find send button.",
  );
}

export function findComposerProviderModelPicker(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-chat-provider-model-picker="true"]');
}

export function findVisibleComposerFooter(): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('[data-chat-composer-footer="true"]')).find(
      (candidate) => candidate.getBoundingClientRect().width > 0,
    ) ?? null
  );
}

function findVisibleComposerForm(): HTMLFormElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLFormElement>('[data-chat-composer-form="true"]')).find(
      (candidate) => candidate.getBoundingClientRect().width > 0,
    ) ?? null
  );
}

export async function setVisibleComposerFormWidth(targetWidth: number): Promise<void> {
  // Resize the element observed by ChatComposer. Shell chrome has a larger
  // min-content width in some renderers and is not part of this footer contract.
  const composerForm = await waitForElement(
    findVisibleComposerForm,
    "Unable to find visible composer form.",
  );
  composerForm.style.width = `${targetWidth}px`;
  composerForm.style.maxWidth = `${targetWidth}px`;
  await waitForLayout();
  await vi.waitFor(() => {
    expect(composerForm.clientWidth).toBe(targetWidth);
  });
}

export function findButtonByText(text: string): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === text,
  ) ?? null) as HTMLButtonElement | null;
}

export async function waitForButtonByText(text: string): Promise<HTMLButtonElement> {
  return waitForElement(() => findButtonByText(text), `Unable to find "${text}" button.`);
}

/**
 * A draft states where it will run as a sentence. The branch picker is the
 * underlined branch name in it, and the word before it says how the branch is
 * used: a new worktree starts "from" one, a checkout works "on" one.
 */
export async function waitForDraftBranchPicker(input: {
  preposition: "from" | "on";
  branch: string;
}): Promise<HTMLButtonElement> {
  return waitForElement(() => {
    const sentence = document.querySelector<HTMLElement>('[data-testid="branch-toolbar-sentence"]');
    if (!sentence?.textContent?.includes(`${input.preposition} ${input.branch}.`)) {
      return null;
    }
    return (Array.from(sentence.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === input.branch,
    ) ?? null) as HTMLButtonElement | null;
  }, `Unable to find the draft sentence reading "${input.preposition} ${input.branch}."`);
}

export async function waitForButtonByAriaLabel(label: string): Promise<HTMLButtonElement> {
  return waitForElement(
    () => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`),
    `Unable to find "${label}" button.`,
  );
}

/** The proposed-plan timeline card renders its own "Implement" button, so
 *  composer-footer assertions must scope their lookup to the footer. */
export async function waitForButtonByTextWithin(
  container: HTMLElement,
  text: string,
): Promise<HTMLButtonElement> {
  return waitForElement(
    () =>
      (Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === text,
      ) ?? null) as HTMLButtonElement | null,
    `Unable to find "${text}" button in scoped container.`,
  );
}

export function findButtonContainingText(text: string): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text),
  ) ?? null) as HTMLButtonElement | null;
}

export async function waitForButtonContainingText(text: string): Promise<HTMLButtonElement> {
  return waitForElement(
    () => findButtonContainingText(text),
    `Unable to find button containing "${text}".`,
  );
}

export async function waitForSelectItemContainingText(text: string): Promise<HTMLElement> {
  return waitForElement(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')).find((item) =>
        item.textContent?.includes(text),
      ) ?? null,
    `Unable to find select item containing "${text}".`,
  );
}

export async function clickSelectItemContainingText(text: string): Promise<void> {
  const item = await waitForSelectItemContainingText(text);
  item.click();
  await waitForLayout();
}

export async function clickComboboxItemContainingText(text: string): Promise<void> {
  const item = await waitForElement(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')).find(
        (entry) => entry.textContent?.includes(text),
      ) ?? null,
    `Unable to find combobox item containing "${text}".`,
  );
  item.click();
  await waitForLayout();
}

export async function expectComposerActionsContained(): Promise<void> {
  const footer = await waitForElement(
    () => document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]'),
    "Unable to find composer footer.",
  );
  const actions = await waitForElement(
    () => document.querySelector<HTMLElement>('[data-chat-composer-actions="right"]'),
    "Unable to find composer actions container.",
  );

  await vi.waitFor(
    () => {
      const footerRect = footer.getBoundingClientRect();
      const actionButtons = Array.from(actions.querySelectorAll<HTMLButtonElement>("button"));
      expect(actionButtons.length).toBeGreaterThanOrEqual(1);

      const buttonRects = actionButtons.map((button) => button.getBoundingClientRect());
      const firstTop = buttonRects[0]?.top ?? 0;

      for (const rect of buttonRects) {
        expect(rect.right).toBeLessThanOrEqual(footerRect.right + 0.5);
        expect(rect.bottom).toBeLessThanOrEqual(footerRect.bottom + 0.5);
        expect(Math.abs(rect.top - firstTop)).toBeLessThanOrEqual(4.5);
      }
    },
    { timeout: 8_000, interval: 16 },
  );
}

/** The question panel carries its own actions while the composer footer is
 *  hidden behind a blocking question, so containment is checked against the
 *  panel instead. */
export async function expectQuestionActionsContained(): Promise<void> {
  const panel = await waitForElement(
    () => document.querySelector<HTMLElement>('[data-composer-questions-expanded="true"]'),
    "Unable to find expanded question panel.",
  );

  await vi.waitFor(
    () => {
      const panelRect = panel.getBoundingClientRect();
      const actionButtons = Array.from(panel.querySelectorAll<HTMLButtonElement>("button")).filter(
        (button) =>
          /^(Previous|Next question|Submit answers?)$/.test(button.textContent?.trim() ?? ""),
      );
      expect(actionButtons.length).toBeGreaterThanOrEqual(1);

      const buttonRects = actionButtons.map((button) => button.getBoundingClientRect());
      const firstTop = buttonRects[0]?.top ?? 0;

      for (const rect of buttonRects) {
        expect(rect.right).toBeLessThanOrEqual(panelRect.right + 0.5);
        expect(rect.bottom).toBeLessThanOrEqual(panelRect.bottom + 0.5);
        expect(Math.abs(rect.top - firstTop)).toBeLessThanOrEqual(4.5);
      }
    },
    { timeout: 8_000, interval: 16 },
  );
}

/**
 * Drags the inline right panel's handle left a step per frame, far past where
 * the composer runs out of room, so its drag limit decides where it stops.
 * Fails unless the panel actually grew.
 */
export async function dragRightPanelFarWider(): Promise<void> {
  const rail = await waitForElement(
    () =>
      document.querySelector<HTMLElement>(
        '[data-slot="sidebar"][data-side="right"] [data-slot="sidebar-rail"]',
      ),
    "Unable to find the right panel's resize handle.",
  );
  const panel = rail.closest<HTMLElement>('[data-slot="sidebar"]')!;
  const startWidth = panel.getBoundingClientRect().width;
  const railRect = rail.getBoundingClientRect();
  const clientY = railRect.top + railRect.height / 2;
  let clientX = railRect.left + railRect.width / 2;
  const pointer = (type: "pointerdown" | "pointermove" | "pointerup") =>
    rail.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX,
        clientY,
      }),
    );
  pointer("pointerdown");
  for (let step = 0; step < 120; step += 1) {
    clientX -= 8;
    pointer("pointermove");
    await nextFrame();
  }
  pointer("pointerup");
  await waitForLayout();
  expect(panel.getBoundingClientRect().width).toBeGreaterThan(startWidth + 100);
}

export async function waitForInteractionModeButton(
  expectedLabel: "Build" | "Plan",
): Promise<HTMLButtonElement> {
  return waitForElement(
    () =>
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === expectedLabel,
      ) as HTMLButtonElement | null,
    `Unable to find ${expectedLabel} interaction mode button.`,
  );
}

export async function waitForServerConfigToApply(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(wsRequests.some((request) => request._tag === WS_METHODS.subscribeServerConfig)).toBe(
        true,
      );
    },
    { timeout: 8_000, interval: 16 },
  );
  await waitForLayout();
}

export const CHAT_FIND_KEYBINDING = {
  command: "chat.find",
  shortcut: {
    key: "f",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
  },
  whenAst: {
    type: "not",
    node: { type: "identifier", name: "terminalFocus" },
  },
} as const;

/** Cmd+F (Ctrl+F off a Mac), pressed where the reader's focus is. */
export function pressChatFindShortcut(target: HTMLElement): void {
  const useMetaForMod = isMacPlatform(navigator.platform);
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "f",
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

export function dispatchChatNewShortcut(): void {
  const useMetaForMod = isMacPlatform(navigator.platform);
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "o",
      shiftKey: true,
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

export function releaseModShortcut(key?: string): void {
  window.dispatchEvent(
    new KeyboardEvent("keyup", {
      key: key ?? (isMacPlatform(navigator.platform) ? "Meta" : "Control"),
      metaKey: false,
      ctrlKey: false,
      bubbles: true,
      cancelable: true,
    }),
  );
}

export async function triggerChatNewShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = router.state.location.pathname;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    dispatchChatNewShortcut();
    await waitForLayout();
    pathname = router.state.location.pathname;
    if (predicate(pathname)) {
      return pathname;
    }
  }
  throw new Error(`${errorMessage} Last path: ${pathname}`);
}

export async function openCommandPaletteFromTrigger(): Promise<void> {
  const trigger = page.getByTestId("command-palette-trigger");
  await expect.element(trigger).toBeInTheDocument();
  await trigger.click();
  await waitForElement(
    () => document.querySelector('[data-testid="command-palette"]'),
    "Command palette should have opened from the sidebar trigger.",
  );
}

export async function waitForNewThreadShortcutLabel(): Promise<void> {
  const newThreadButton = page.getByTestId("new-thread-button");
  await expect.element(newThreadButton).toBeInTheDocument();
  await newThreadButton.hover();
  // The rail's tooltip names the button, then its shortcut.
  const shortcutLabel = isMacPlatform(navigator.platform) ? "⇧⌘O" : "Ctrl+Shift+O";
  await expect.element(page.getByText(shortcutLabel, { exact: true })).toBeInTheDocument();
}

export async function waitForCommandPaletteShortcutLabel(): Promise<void> {
  await waitForElement(
    () => document.querySelector('[data-testid="command-palette-trigger"] kbd'),
    "Command palette shortcut label did not render.",
  );
}

export async function waitForCommandPaletteInput(placeholder: string): Promise<HTMLInputElement> {
  return waitForElement(
    () => document.querySelector(`input[placeholder="${placeholder}"]`) as HTMLInputElement | null,
    () => {
      const palette = document.querySelector('[data-testid="command-palette"]');
      const actual = palette?.querySelector("input")?.getAttribute("placeholder") ?? "<no input>";
      const paletteState = palette ? "open" : "closed";
      return `Command palette input with placeholder "${placeholder}" did not render (palette ${paletteState}, actual placeholder: "${actual}").`;
    },
  );
}

export async function clickCommandPaletteAction(label: string): Promise<void> {
  await waitForElement(() => {
    const palette = document.querySelector('[data-testid="command-palette"]');
    if (!palette) return null;
    const candidates = Array.from(
      palette.querySelectorAll<HTMLElement>('[data-slot="command-item"]'),
    ).filter((item) =>
      Array.from(item.querySelectorAll("span")).some(
        (content) => content.textContent?.trim() === label,
      ),
    );
    // A view transition can briefly leave an exit-animating copy of the row
    // in the DOM with its React handlers already gone; a synthetic click on
    // that ghost is silently lost (the source of the #117 flake). A real
    // pointer can only hit the live copy, so emulate hit-testing: click the
    // candidate that owns the pixels at its own center.
    const action =
      candidates.find((item) => {
        const rect = item.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return hit !== null && item.contains(hit);
      }) ??
      candidates.at(-1) ??
      null;
    if (!action) return null;
    action.click();
    return action;
  }, `Command palette action "${label}" did not render.`);
  // Dispatch in the same browser task that located the row. Async palette
  // refreshes may replace result nodes between Playwright's actionability
  // checks even though the action itself remains continuously available.
  await waitForLayout();
}

export async function selectLocalFolderAction(): Promise<void> {
  await waitForElement(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-slot="command-group-label"]')).find(
        (label) => label.textContent?.trim() === "Sources",
      ) ?? null,
    "Command palette Sources view did not render.",
  );
  await clickCommandPaletteAction("Local folder");
}

export function getCommandPaletteLegendEntries(): string[] {
  const footer = document.querySelector('[data-slot="command-footer"]');
  if (!footer) {
    return [];
  }

  return Array.from(footer.querySelectorAll('[data-slot="kbd-group"]'))
    .map((group) =>
      Array.from(group.children)
        .map((child) => child.textContent?.trim() ?? "")
        .filter((value) => value.length > 0)
        .join(" "),
    )
    .filter((value) => value.length > 0);
}

export async function dispatchInputKey(
  input: HTMLInputElement,
  init: Pick<KeyboardEventInit, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
): Promise<void> {
  input.focus();
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
  await waitForLayout();
}

export async function mountChatView(options: {
  viewport: ViewportSpec;
  snapshot: OrchestrationReadModel;
  configureFixture?: (fixture: TestFixture) => void;
  resolveRpc?: (body: NormalizedWsRpcRequestBody) => unknown | undefined;
  initialPath?: string;
  waitForBootstrap?: boolean;
  /** Mount under StrictMode, as main.tsx does, so mount-time effect cleanups run. */
  strictMode?: boolean;
}): Promise<MountedChatView> {
  fixture = buildFixture(options.snapshot);
  options.configureFixture?.(fixture);
  customWsRpcResolver = options.resolveRpc ?? null;
  await setViewport(options.viewport);
  await waitForProductionStyles();

  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.top = "0";
  host.style.left = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  // Block, like the app's #root. A grid host would stretch the app to its
  // narrowest unbreakable content and hide layouts that overflow their pane.
  host.style.display = "block";
  host.style.overflow = "hidden";
  document.body.append(host);

  const initialPath = options.initialPath ?? `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}`;

  const router = getRouter(
    createMemoryHistory({
      initialEntries: [initialPath],
    }),
  );

  const app = (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
    </AppAtomRegistryProvider>
  );
  const screen = await render(options.strictMode ? <StrictMode>{app}</StrictMode> : app, {
    container: host,
  });

  await waitForWsClient();
  if (options.waitForBootstrap !== false) {
    await waitForAppBootstrap();
  }
  await waitForLayout();

  const cleanup = async () => {
    customWsRpcResolver = null;
    await screen.unmount();
    host.remove();
    await waitForLayout();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    setViewport: async (viewport: ViewportSpec) => {
      await setViewport(viewport);
      await waitForProductionStyles();
    },
    setContainerSize: async (viewport) => {
      host.style.width = `${viewport.width}px`;
      host.style.height = `${viewport.height}px`;
      await waitForLayout();
    },
    setComposerWidth: async (width) => {
      // Sized through the composer's parent, the room it is offered: the
      // composer itself stops growing at its cap (max-w-4xl), so its own
      // width says nothing about how far the host is from the target.
      for (let pass = 0; pass < 3; pass += 1) {
        const form = document.querySelector<HTMLElement>('[data-chat-composer-form="true"]');
        const room = form?.parentElement;
        if (!form || !room) throw new Error("Unable to find the composer to resize.");
        if (Math.abs(form.getBoundingClientRect().width - width) < 0.5) return;
        const excess = room.getBoundingClientRect().width - width;
        host.style.width = `${host.getBoundingClientRect().width - excess}px`;
        await waitForLayout();
      }
      throw new Error(`Unable to make the composer ${width}px wide.`);
    },
    router,
  };
}

export async function openProjectMenu() {
  await page.getByRole("button", { name: /, project options$/ }).click();
}

export async function clickProjectMenuItem(label: string) {
  await openProjectMenu();
  await page.getByRole("menuitem", { name: label }).click();
}

/** Lets a spec hold back the first shell snapshot, to show the loading state. */
export function setSuppressInitialShellSnapshot(value: boolean): void {
  suppressInitialShellSnapshot = value;
}

/** Sets what this computer's server streams for `links.subscribe`; null sends nothing. */
export function setPrimaryLinksSnapshot(snapshot: ComputerLinksSnapshot | null): void {
  primaryLinksSnapshot = snapshot;
}

/**
 * Registers the hooks every ChatView browser spec shares: the mock service
 * worker, a fresh RPC harness for each test, and reset stores. Call it first
 * inside the spec's describe.
 */
export function registerChatViewSuiteHooks(): void {
  beforeAll(async () => {
    fixture = buildFixture(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-bootstrap" as MessageId,
        targetText: "bootstrap",
      }),
    );
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: {
        url: "/mockServiceWorker.js",
      },
    });
  });

  afterAll(async () => {
    await rpcHarness.disconnect();
    await worker.stop();
  });

  beforeEach(async () => {
    await rpcHarness.reset({
      resolveUnary: resolveWsRpc,
      getInitialStreamValues: (request) => {
        if (request._tag === WS_METHODS.subscribeServerLifecycle) {
          return [
            {
              version: 1,
              sequence: 1,
              type: "welcome",
              payload: fixture.welcome,
            },
          ];
        }
        if (request._tag === WS_METHODS.subscribeServerConfig) {
          return [
            {
              version: 1,
              type: "snapshot",
              config: encodeServerConfig(fixture.serverConfig),
            },
          ];
        }
        if (request._tag === WS_METHODS.linksSubscribe) {
          return primaryLinksSnapshot === null ? [] : [primaryLinksSnapshot];
        }
        if (request._tag === ORCHESTRATION_WS_METHODS.subscribeShell) {
          if (suppressInitialShellSnapshot) {
            return [];
          }
          return [
            {
              kind: "snapshot",
              snapshot: toShellSnapshot(fixture.snapshot),
            },
          ];
        }
        if (request._tag === ORCHESTRATION_WS_METHODS.subscribeThread) {
          const thread = fixture.snapshot.threads.find((entry) => entry.id === request.threadId);
          return thread
            ? [
                {
                  kind: "snapshot",
                  snapshot: {
                    snapshotSequence: fixture.snapshot.snapshotSequence,
                    thread,
                  },
                },
              ]
            : [];
        }
        return [];
      },
    });
    await __resetLocalApiForTests();
    await setViewport(DEFAULT_VIEWPORT);
    localStorage.clear();
    // Each spec is a fresh window: session storage would otherwise carry the
    // previous spec's history (like a reload does) into this one.
    sessionStorage.clear();
    // A computer that has finished setup: these specs exercise empty drafts
    // and threads, which a first run would leave for the setup screen.
    dismissFirstRunSetup(LOCAL_ENVIRONMENT_ID);
    document.body.innerHTML = "";
    wsRequests.length = 0;
    customWsRpcResolver = null;
    suppressInitialShellSnapshot = false;
    primaryLinksSnapshot = null;
    __resetComputerLinksForTests();
    closeConnectComputerDialog();
    closeThreadMoveDialog();
    __resetThreadMovesForTests();
    closeProjectSetupDialog();
    __resetProjectSetupsForTests();
    __resetEnvironmentApiOverridesForTests();
    resetSavedEnvironmentRegistryStoreForTests();
    resetSavedEnvironmentRuntimeStoreForTests();
    resetRightPanelTabsForTests();
    __resetComposerPullRequestDismissalsForTests();
    Reflect.deleteProperty(window, "desktopBridge");
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
    useOptimisticThreadMessagesStore.setState({ messagesByThreadKey: {} });
    useCommandPaletteStore.setState({
      open: false,
      openIntent: null,
    });
    useStore.setState({
      activeEnvironmentId: null,
      environmentStateById: {},
    });
    useUiStateStore.setState({
      projectExpandedById: {},
      projectOrder: [],
      seenThreadOverlays: {},
      threadSeedVisitedAtById: {},
      doneThreadOverlays: {},
      inboxProjectScopeKeys: [],
      collapsedInboxGroups: {},
      inboxWrappedOpen: false,
      sidebarListOpen: true,
    });
    useTerminalStateStore.persist.clearStorage();
    useTerminalStateStore.setState({
      terminalStateByThreadKey: {},
      terminalTabsByThreadKey: {},
      pendingTerminalIdsByThreadKey: {},
      terminalActivityCommandByKey: {},
      terminalActivityStartedAtByKey: {},
      terminalCommandPendingByKey: {},
    });
  });

  afterEach(() => {
    customWsRpcResolver = null;
    suppressInitialShellSnapshot = false;
    document.body.innerHTML = "";
  });
}
