// Stages deterministic data in the REAL app's renderer only. These are not real CI results.
// No server commands, private history, provider turns, or GitHub writes are made.
// Run after setup-capture and desktop startup. --clear restores this renderer's baseline.
// The fixture expires after 30 minutes; re-run to start a fresh capture session.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const captureRoot = "C:/Users/Public/Documents/Threadlines Release Studio";
if (!fs.existsSync(`${captureRoot}/.release-capture-owned`))
  throw new Error("The owned capture workspace is missing.");
const captureFiles = ["docs/stable-release.md", "apps/marketing/src/pages/index.astro"];
function readDiff(args) {
  const result = spawnSync(
    "git",
    ["-C", `${captureRoot}/Threadlines`, "diff", "HEAD", ...args, "--", ...captureFiles],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  if (result.status !== 0) throw new Error("Could not read the isolated capture diff.");
  return result.stdout;
}
const mainDiff = {
  patch: readDiff([]),
  reviewLine:
    fs
      .readFileSync(`${captureRoot}/Threadlines/apps/marketing/src/pages/index.astro`, "utf8")
      .split("\n")
      .findIndex((line) => line.includes("<h1")) + 1,
  files: readDiff(["--numstat"])
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [additions, deletions, file] = line.trim().split("\t");
      return { path: file, additions: Number(additions), deletions: Number(deletions) };
    }),
};
if (
  mainDiff.files.length !== 2 ||
  mainDiff.files.some((f) => !Number.isFinite(f.additions + f.deletions))
)
  throw new Error("Expected the two reviewed text files in the capture diff.");
const targets = await (await fetch("http://127.0.0.1:9225/json/list")).json();
const target = targets.find(
  (item) => item.type === "page" && item.url.startsWith("http://127.0.0.1:6039/"),
);
if (!target) throw new Error("Isolated release renderer not found on port 6039.");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let nextId = 0;
const pending = new Map();
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});
function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: {
          expression,
          awaitPromise: true,
          returnByValue: true,
        },
      }),
    );
  });
}

async function stage(mainDiff) {
  if (location.origin !== "http://127.0.0.1:6039") throw new Error("Wrong renderer origin.");
  window.threadlinesCaptureStates?.stop();
  const [{ useStore }, apiModule, { useTerminalStateStore }, { pullRequestQueryKeys }, runtime] =
    await Promise.all([
      import("/src/store.ts"),
      import("/src/environmentApi.ts"),
      import("/src/terminalStateStore.ts"),
      import("/src/lib/pullRequestsReactQuery.ts"),
      import("/src/environments/runtime/service.ts"),
    ]);
  const state = useStore.getState();
  const environmentId = state.activeEnvironmentId;
  const baseline = state.environmentStateById[environmentId];
  if (!baseline) throw new Error("Wait for the isolated app to finish loading.");
  const allowedNames = new Set([
    "Threadlines",
    "facpmanuals-next",
    "game-idea",
    "wilfredoleon.com",
  ]);
  const projects = Object.values(baseline.projectById).filter((p) => p.kind !== "general-chat");
  if (
    projects.length !== 4 ||
    projects.some(
      (p) =>
        !allowedNames.has(p.name) ||
        !p.cwd
          .replaceAll("\\", "/")
          .startsWith("C:/Users/Public/Documents/Threadlines Release Studio/"),
    )
  )
    throw new Error("Refusing to stage outside the four isolated capture projects.");
  const queryClient = window.__TSR_ROUTER__?.options.context.queryClient;
  const originalApi = apiModule.readEnvironmentApi(environmentId);
  if (!queryClient || !originalApi) throw new Error("The capture app is not connected.");
  const byTitle = (title) => {
    const thread = Object.values(baseline.threadShellById).find((t) => t.title === title);
    if (!thread) throw new Error(`Missing recreated thread: ${title}`);
    return thread;
  };
  const main = byTitle("Refresh the stable release page");
  const game = byTitle("Balance idle progress");
  const facp = byTitle("Fix PDF titles and model numbers");
  const portfolio = byTitle("Refresh the selected work section");
  const ready = byTitle("Review the pull request workflow");
  const wrappedSetup = byTitle("Fix Windows first-run setup");
  // A second thread may hydrate only when the capture opens it later.
  let facpMessageBaseline = baseline.messageByThreadId[facp.id];
  const now = new Date().toISOString();
  const earlier = new Date(Date.now() - 45_000).toISOString();
  const older = new Date(Date.now() - 120_000).toISOString();
  const mainProject = baseline.projectById[main.projectId];
  const repository = "Threadlines/threadlines";
  const number = 301;
  const url = `https://github.com/${repository}/pull/${number}`;
  const actor = { login: "threadlines", isBot: false, avatarUrl: null };
  const entry = {
    provider: "github",
    projectId: main.projectId,
    projectTitle: "Threadlines",
    repository,
    number,
    title: "Refresh the release page and review flow",
    url,
    author: actor,
    headBranch: main.branch,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    additions: mainDiff.files.reduce((sum, f) => sum + f.additions, 0),
    deletions: mainDiff.files.reduce((sum, f) => sum + f.deletions, 0),
    createdAt: older,
    updatedAt: earlier,
    viewerIsAuthor: false,
    viewerReviewRequested: true,
    viewerCanWrite: true,
    checksState: "pending",
    mergeability: "mergeable",
    autoMergeEnabled: false,
    labels: [],
    origin: "workspace",
  };
  let detail = {
    ...entry,
    workspaceRoot: mainProject.cwd,
    body: "Recreated capture example. Review the homepage copy and source-control presentation.",
    changedFiles: mainDiff.files.length,
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    checks: [
      { name: "Format", status: "success", description: "Demo result", url: null },
      { name: "Lint", status: "success", description: "Demo result", url: null },
      { name: "Typecheck", status: "success", description: "Demo result", url: null },
      { name: "Unit tests", status: "success", description: "Demo result", url: null },
      { name: "Browser tests", status: "pending", description: "Demo running check", url: null },
      { name: "Build", status: "pending", description: "Demo running check", url: null },
    ],
    viewer: { canWrite: true, canReview: true, canManage: true },
    mergeMethods: ["squash", "merge"],
    baseComparison: "up-to-date",
    behindBy: 0,
    isStacked: false,
    defaultBranch: "main",
    capabilities: {
      diff: true,
      comment: false,
      actions: ["enable-auto-merge", "disable-auto-merge"],
      mergeMethods: ["squash", "merge"],
      updateMethods: [],
      reactions: false,
      review: {
        inlineComment: true,
        reply: true,
        resolve: true,
        verdicts: ["comment", "approve", "request-changes"],
      },
      reviewers: { request: false, listCandidates: false },
      edit: { pullRequest: false, comment: false },
    },
  };
  const reviewComment = {
    id: "capture-heading-comment",
    author: { login: "release-reviewer", isBot: false, avatarUrl: null },
    body: "Could we check this headline at phone width? Keep both provider names readable without pushing the download button too far down.",
    createdAt: earlier,
    url: null,
    reactions: [],
    viewerIsAuthor: true,
  };
  const activity = {
    comments: [
      {
        ...reviewComment,
        id: "capture-review-summary",
        kind: "issue-comment",
        reviewState: null,
        body: "The shorter headline reads well on desktop. I left one note about phone width.",
      },
    ],
    commits: [
      {
        oid: "cccccccccccccccccccccccccccccccccccccccc",
        messageHeadline: "docs: refresh the homepage and release notes",
        committedDate: older,
        authorLogin: "threadlines",
      },
    ],
    reviewThreads: [
      {
        id: "capture-heading-review",
        path: "apps/marketing/src/pages/index.astro",
        line: mainDiff.reviewLine || null,
        side: "right",
        isResolved: false,
        isOutdated: false,
        comments: [reviewComment],
      },
    ],
    reactions: [],
  };
  const mainTurnId = `capture:${main.id}`;
  const agentDefinitions = [
    {
      id: "capture-layout-review",
      role: "Layout review",
      status: "running",
      prompt:
        "Check the updated homepage at desktop and phone widths. Read only. Report any clipped text or overlapping controls.",
      text: "The desktop layout fits. I am checking the headline and download row at phone widths.",
    },
    {
      id: "capture-copy-review",
      role: "Copy review",
      status: "completed",
      prompt:
        "Review the homepage copy and release notes. Check that the download labels are clear and that the feature descriptions match the app.",
      text: "The headline names both providers. The release notes explain the workflow, and the download labels are clear.",
    },
  ];
  const demoActivities = [
    {
      id: "capture-plan",
      kind: "turn.plan.updated",
      summary: "Plan updated",
      tone: "info",
      turnId: mainTurnId,
      createdAt: older,
      payload: {
        plan: [
          { step: "Review the homepage and release notes", status: "completed" },
          { step: "Tighten the headline and download copy", status: "completed" },
          { step: "Check desktop and phone layouts", status: "inProgress" },
          { step: "Review the pull request checks", status: "pending" },
        ],
      },
    },
    ...agentDefinitions.map((agent) => ({
      id: `${agent.id}:activity`,
      kind: "tool.completed",
      summary: `${agent.role} subagent`,
      tone: "tool",
      turnId: mainTurnId,
      createdAt: agent.status === "running" ? older : earlier,
      payload: {
        itemType: "collab_agent_tool_call",
        status: "completed",
        toolCallId: `${agent.id}:spawn`,
        title: `${agent.role} subagent`,
        data: {
          subagentLiveText: agent.status === "running" ? agent.text : undefined,
          item: {
            id: `${agent.id}:spawn`,
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "completed",
            receiverThreadIds: [agent.id],
            prompt: agent.prompt,
            role: agent.role,
            model: "gpt-5.6-sol",
            reasoningEffort: "high",
            agentsStates: {
              [agent.id]: {
                status: agent.status,
                message: agent.status === "completed" ? agent.text : null,
              },
            },
          },
        },
      },
    })),
  ];
  const mergedEntry = {
    ...entry,
    number: 298,
    title: "Fix Windows first-run setup",
    url: `https://github.com/${repository}/pull/298`,
    headBranch: "fix/windows-first-run",
    state: "merged",
    settledAt: earlier,
    checksState: "success",
    additions: 26,
    deletions: 7,
  };
  const lists = {
    open: { viewer: "release-reviewer", entries: [entry], errors: [] },
    merged: { viewer: "release-reviewer", entries: [mergedEntry], errors: [] },
    closed: { viewer: "release-reviewer", entries: [], errors: [] },
  };
  const blocked = async () => {
    throw new Error("This is a renderer-only capture fixture.");
  };
  let autoFix = false;
  apiModule.__setEnvironmentApiOverrideForTests(environmentId, {
    ...originalApi,
    pullRequests: {
      ...originalApi.pullRequests,
      list: async ({ state: requested }) => lists[requested] ?? lists.open,
      detail: async (reference) =>
        reference.number === 298
          ? {
              ...detail,
              ...mergedEntry,
              mergedAt: earlier,
              checks: detail.checks.map((c) => ({ ...c, status: "success" })),
            }
          : detail,
      activity: async () => activity,
      diff: async () => ({ patch: mainDiff.patch, truncated: false }),
      comment: blocked,
      submitReview: blocked,
      replyToThread: blocked,
      setThreadResolution: blocked,
      setReaction: blocked,
      update: blocked,
      updateComment: blocked,
      reviewerCandidates: blocked,
      requestReviewers: blocked,
      runAction: async ({ action }) => {
        if (action !== "enable-auto-merge" && action !== "disable-auto-merge") return blocked();
        detail = { ...detail, autoMergeEnabled: action === "enable-auto-merge" };
        queryClient.setQueryData(
          pullRequestQueryKeys.detail(environmentId, main.projectId, number),
          detail,
        );
        return detail;
      },
    },
    orchestration: {
      ...originalApi.orchestration,
      dispatchCommand: async (command) => {
        if (command.type === "thread.pull-request-automation.set" && command.threadId === main.id) {
          autoFix = command.autoFix;
          apply();
          return { sequence: 0 };
        }
        return blocked();
      },
    },
  });
  const modes = new Map([
    [main.id, "working"],
    [game.id, "working"],
    [facp.id, "background"],
    [portfolio.id, "wrapped"],
    [ready.id, "ready"],
    [wrappedSetup.id, "wrapped"],
  ]);
  const terminalBaseline = useTerminalStateStore.getState().terminalStateByThreadKey;
  const terminalRef = { environmentId, threadId: facp.id };
  useTerminalStateStore
    .getState()
    .ensureTerminal(terminalRef, "capture-dev-server", { open: false, active: false });
  useTerminalStateStore.getState().setTerminalActivity(terminalRef, "capture-dev-server", true);
  const mainTerminalRef = { environmentId, threadId: main.id };
  useTerminalStateStore
    .getState()
    .ensureTerminal(mainTerminalRef, "capture-preview", { open: false, active: false });
  useTerminalStateStore.getState().setTerminalActivity(mainTerminalRef, "capture-preview", true);
  useTerminalStateStore
    .getState()
    .setTerminalSubmittedCommand(
      mainTerminalRef,
      "capture-preview",
      "pnpm exec vp run '@threadlines/marketing#dev'",
    );
  const connection = runtime.requireEnvironmentConnection(environmentId);
  const originalReadTranscript = connection.client.server.readSubagentTranscript;
  const originalSendInput = connection.client.server.sendSubagentInput;
  connection.client.server.readSubagentTranscript = async ({ agentId }) => {
    const agent = agentDefinitions.find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error("No recreated transcript for this agent.");
    return {
      entries: [
        { role: "user", text: agent.prompt, toolUses: [] },
        { role: "assistant", text: agent.text, toolUses: [] },
      ],
      truncated: false,
      agent: { id: agent.id, directInput: "unsupported" },
      offset: 0,
      totalEntries: 2,
    };
  };
  connection.client.server.sendSubagentInput = blocked;
  function apply() {
    const current = useStore.getState().environmentStateById[environmentId];
    const next = {
      ...current,
      projectById: {
        ...current.projectById,
        [main.projectId]: {
          ...current.projectById[main.projectId],
          repositoryIdentity: {
            canonicalKey: "github:Threadlines/threadlines",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "https://github.com/Threadlines/threadlines.git",
            },
            provider: "github",
            owner: "Threadlines",
            name: "threadlines",
            displayName: repository,
          },
        },
      },
      threadShellById: { ...current.threadShellById },
      threadSessionById: { ...current.threadSessionById },
      threadTurnStateById: { ...current.threadTurnStateById },
      sidebarThreadSummaryById: { ...current.sidebarThreadSummaryById },
      messageByThreadId: { ...current.messageByThreadId },
      activityIdsByThreadId: { ...current.activityIdsByThreadId },
      activityByThreadId: { ...current.activityByThreadId },
    };
    for (const [id, mode] of modes) {
      const shell = current.threadShellById[id];
      const working = mode === "working";
      const wrapped = mode === "wrapped";
      const latestTurn = {
        turnId: `capture:${id}`,
        state: working ? "running" : "completed",
        requestedAt: older,
        startedAt: older,
        completedAt: working ? null : mode === "ready" ? now : earlier,
        assistantMessageId: null,
      };
      const session = {
        provider: shell.modelSelection.instanceId === "codex" ? "codex" : "claudeAgent",
        providerInstanceId: shell.modelSelection.instanceId,
        status: working ? "running" : "ready",
        orchestrationStatus: working ? "running" : "ready",
        createdAt: older,
        updatedAt: earlier,
        ...(working ? { activeTurnId: latestTurn.turnId } : {}),
        pendingBackgroundTaskCount: mode === "background" ? 1 : 0,
      };
      const doneOverride = wrapped ? { state: "done", at: now } : null;
      const branch =
        id === wrappedSetup.id
          ? "fix/windows-first-run"
          : id === ready.id
            ? "review/pull-request-workflow"
            : shell.branch;
      next.threadShellById[id] = {
        ...shell,
        doneOverride,
        lastSeenAt: mode === "ready" ? older : now,
        branch,
        ...(id === main.id ? { pullRequestAutoFix: autoFix } : {}),
      };
      next.threadSessionById[id] = session;
      next.threadTurnStateById[id] = { ...current.threadTurnStateById[id], latestTurn };
      next.sidebarThreadSummaryById[id] = {
        ...current.sidebarThreadSummaryById[id],
        session,
        latestTurn,
        doneOverride,
        branch,
        lastSeenAt: mode === "ready" ? older : now,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasBlockingUserInput: false,
        hasActionableProposedPlan: false,
      };
    }
    const messages = current.messageByThreadId[main.id];
    if (messages)
      next.messageByThreadId[main.id] = Object.fromEntries(
        Object.entries(messages).map(([id, message]) => [
          id,
          {
            ...message,
            text:
              message.role === "user"
                ? "The homepage is behind the app now. Lead with Codex and Claude, tighten the copy, and check the download links."
                : message.role === "assistant"
                  ? "I've shortened the headline and updated the release notes. The two changed files are ready for review.\n\nI'm checking the layout at desktop and phone widths now. The PR checks are still running."
                  : message.text,
          },
        ]),
      );
    const facpMessages = current.messageByThreadId[facp.id];
    if (facpMessages && facpMessageBaseline === undefined) facpMessageBaseline = facpMessages;
    if (facpMessages)
      next.messageByThreadId[facp.id] = Object.fromEntries(
        Object.entries(facpMessages).map(([id, message]) => [
          id,
          {
            ...message,
            text:
              message.role === "assistant"
                ? "I'll review the title and model extraction together. A slash can be part of a model number, so SS/2ZE needs to stay intact.\n\nI'm checking the search results with long titles and model names next."
                : message.text,
          },
        ]),
      );
    next.activityIdsByThreadId[main.id] = [
      ...new Set([
        ...(baseline.activityIdsByThreadId[main.id] ?? []),
        ...demoActivities.map((entry) => entry.id),
      ]),
    ];
    next.activityByThreadId[main.id] = {
      ...baseline.activityByThreadId[main.id],
      ...Object.fromEntries(demoActivities.map((entry) => [entry.id, entry])),
    };
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      useStore.setState((s) => ({
        environmentStateById: { ...s.environmentStateById, [environmentId]: next },
      }));
    }
    for (const listState of ["open", "merged", "closed"]) {
      const key = pullRequestQueryKeys.list(environmentId, listState);
      if (queryClient.getQueryData(key) !== lists[listState])
        queryClient.setQueryData(key, lists[listState]);
    }
    const detailKey = pullRequestQueryKeys.detail(environmentId, main.projectId, number);
    if (queryClient.getQueryData(detailKey) !== detail) queryClient.setQueryData(detailKey, detail);
    queryClient.setQueryData(
      pullRequestQueryKeys.activity(environmentId, main.projectId, number),
      activity,
    );
  }
  apply();
  const timer = setInterval(apply, 1000);
  const expiry = setTimeout(() => window.threadlinesCaptureStates?.stop(), 30 * 60_000);
  window.threadlinesCaptureStates = {
    description:
      "Deterministic renderer fixtures. PR and CI values are recreated, not live results.",
    stop() {
      clearInterval(timer);
      clearTimeout(expiry);
      apiModule.__setEnvironmentApiOverrideForTests(environmentId, originalApi);
      useStore.setState((s) => ({
        environmentStateById: {
          ...s.environmentStateById,
          [environmentId]: {
            ...s.environmentStateById[environmentId],
            projectById: baseline.projectById,
            threadShellById: baseline.threadShellById,
            threadSessionById: baseline.threadSessionById,
            threadTurnStateById: baseline.threadTurnStateById,
            sidebarThreadSummaryById: baseline.sidebarThreadSummaryById,
            messageByThreadId: {
              ...s.environmentStateById[environmentId].messageByThreadId,
              [main.id]: baseline.messageByThreadId[main.id],
              ...(facpMessageBaseline ? { [facp.id]: facpMessageBaseline } : {}),
            },
            activityIdsByThreadId: {
              ...s.environmentStateById[environmentId].activityIdsByThreadId,
              [main.id]: baseline.activityIdsByThreadId[main.id],
            },
            activityByThreadId: {
              ...s.environmentStateById[environmentId].activityByThreadId,
              [main.id]: baseline.activityByThreadId[main.id],
            },
          },
        },
      }));
      useTerminalStateStore.setState({ terminalStateByThreadKey: terminalBaseline });
      useTerminalStateStore
        .getState()
        .clearTerminalSubmittedCommand(mainTerminalRef, "capture-preview");
      connection.client.server.readSubagentTranscript = originalReadTranscript;
      connection.client.server.sendSubagentInput = originalSendInput;
      void queryClient.invalidateQueries({ queryKey: pullRequestQueryKeys.all });
      delete window.threadlinesCaptureStates;
    },
  };
  return { staged: [...modes.values()], pullRequest: number, expiresInMinutes: 30 };
}

try {
  const result = await evaluate(
    process.argv.includes("--clear")
      ? "window.threadlinesCaptureStates?.stop(); 'Capture fixture cleared.'"
      : `window.__captureStagePromise = (${stage.toString()})(${JSON.stringify(mainDiff)})`,
  );
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  console.log(JSON.stringify(result.result.value));
} finally {
  socket.close();
}
