import assert from "node:assert/strict";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, it } from "vite-plus/test";
import { ThreadId, TurnId } from "@threadlines/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import {
  buildPermissionsApprovalResponse,
  buildTurnStartParams,
  classifyCodexStderrLine,
  enrichCollabAgentToolPayload,
  isRecoverableThreadResumeError,
  makeCodexStderrLineClassifier,
  openCodexThread,
  readCollabChildThreadMetadata,
  readCollabReceiverThreadIds,
  rememberCollabReceiverTurns,
  shouldAcceptCodexNotificationForSession,
  type CodexServerNotification,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: {
        state: "idle",
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        clientUserMessageId: "message-user-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      clientUserMessageId: "message-user-1",
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("preserves the model default reasoning effort in default collaboration mode", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          developer_instructions: CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("sends selected skills as structured app-server input", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Use $review to inspect this",
        skills: [
          {
            type: "skill",
            name: "review",
            path: "/tmp/project/.codex/skills/review/SKILL.md",
          },
        ],
      }),
    );

    assert.deepStrictEqual(params.input, [
      {
        type: "text",
        text: "Use $review to inspect this",
      },
      {
        type: "skill",
        name: "review",
        path: "/tmp/project/.codex/skills/review/SKILL.md",
      },
    ]);
  });

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });

  it("routes approvals to the auto reviewer in auto runtime mode", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto",
        prompt: "Ship it",
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Ship it",
        },
      ],
    });
  });
});

describe("shouldAcceptCodexNotificationForSession", () => {
  it("drops notifications for a different provider thread after the session is bound", () => {
    assert.equal(
      shouldAcceptCodexNotificationForSession({
        currentProviderThreadId: "provider-thread-1",
        notificationThreadId: "provider-thread-2",
      }),
      false,
    );
  });

  it("accepts notifications for the current provider thread and known child threads", () => {
    assert.equal(
      shouldAcceptCodexNotificationForSession({
        currentProviderThreadId: "provider-thread-1",
        notificationThreadId: "provider-thread-1",
      }),
      true,
    );
    assert.equal(
      shouldAcceptCodexNotificationForSession({
        currentProviderThreadId: "provider-thread-1",
        notificationThreadId: "provider-thread-child",
        isKnownChildThread: true,
      }),
      true,
    );
  });

  it("accepts unscoped notifications and notifications before the provider thread is known", () => {
    assert.equal(
      shouldAcceptCodexNotificationForSession({
        currentProviderThreadId: undefined,
        notificationThreadId: "provider-thread-1",
      }),
      true,
    );
    assert.equal(
      shouldAcceptCodexNotificationForSession({
        currentProviderThreadId: "provider-thread-1",
        notificationThreadId: undefined,
      }),
      true,
    );
  });
});

describe("collab child thread metadata", () => {
  it("seeds child-turn routing from native subagent activity", () => {
    const notification = {
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "turn-1",
        completedAtMs: 10,
        item: {
          id: "subagent-activity-1",
          type: "subAgentActivity",
          kind: "started",
          agentPath: "/root/implement_pull_server",
          agentThreadId: "child-thread-1",
        },
      },
    } as unknown as CodexServerNotification;

    assert.deepStrictEqual(readCollabReceiverThreadIds(notification), ["child-thread-1"]);

    const childTurns = new Map<string, TurnId>();
    rememberCollabReceiverTurns(childTurns, notification, TurnId.make("turn-1"));
    assert.equal(childTurns.get("child-thread-1"), "turn-1");
  });

  it("reads the runtime nickname and role from child thread starts", () => {
    const notification = {
      method: "thread/started",
      params: {
        thread: {
          id: "child-thread-1",
          agentNickname: " Euclid ",
          agentRole: " helper ",
          source: {
            subAgent: {
              thread_spawn: {
                agent_nickname: "Fallback",
                agent_role: "fallback-role",
                depth: 1,
                parent_thread_id: "parent-thread",
              },
            },
          },
        },
      },
    } as unknown as CodexServerNotification;

    assert.deepStrictEqual(readCollabChildThreadMetadata(notification), {
      threadId: "child-thread-1",
      metadata: {
        agentNickname: "Euclid",
        agentRole: "helper",
      },
    });
  });

  it("attaches child thread metadata to collab agent tool lifecycle payloads", () => {
    const notification = {
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        turnId: "turn-1",
        completedAtMs: 10,
        item: {
          id: "call-close",
          type: "collabAgentToolCall",
          tool: "closeAgent",
          status: "completed",
          receiverThreadIds: ["child-thread-1"],
          senderThreadId: "parent-thread",
          agentsStates: {
            "child-thread-1": {
              status: "completed",
              message: "Done",
            },
          },
        },
      },
    } as unknown as CodexServerNotification;

    const payload = enrichCollabAgentToolPayload(
      notification,
      new Map([
        [
          "child-thread-1",
          {
            agentNickname: "Euclid",
            agentRole: "helper",
          },
        ],
      ]),
    ) as {
      readonly item: {
        readonly agentNickname?: string;
        readonly agentRole?: string;
      };
    };

    assert.equal(payload.item.agentNickname, "Euclid");
    assert.equal(payload.item.agentRole, "helper");
  });
});

describe("buildPermissionsApprovalResponse", () => {
  const payload = {
    cwd: "/tmp/project",
    itemId: "item-permissions-1",
    permissions: {
      network: {
        enabled: true,
      },
      fileSystem: {
        write: ["/tmp/project"],
      },
    },
    reason: "Need network and write access",
    startedAtMs: 1_800_000_000_000,
    threadId: "provider-thread-1",
    turnId: "turn-1",
  };

  it("grants requested permissions for the current turn when accepted", () => {
    assert.deepStrictEqual(buildPermissionsApprovalResponse(payload, "accept"), {
      permissions: payload.permissions,
      scope: "turn",
    });
  });

  it("grants requested permissions for the session when accepted for session", () => {
    assert.deepStrictEqual(buildPermissionsApprovalResponse(payload, "acceptForSession"), {
      permissions: payload.permissions,
      scope: "session",
    });
  });

  it("returns no extra permissions when declined", () => {
    assert.deepStrictEqual(buildPermissionsApprovalResponse(payload, "decline"), {
      permissions: {},
    });
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("classifyCodexStderrLine", () => {
  it("filters benign Codex startup stderr noise", () => {
    const modelRefreshWarning =
      "2026-05-27T03:14:34.196768Z ERROR codex_models_manager::manager: failed to refresh available models: timeout while fetching models";
    const mcpWorkerClosedWarning =
      "2026-05-27T03:14:38.810814Z ERROR mcp-transport-worker: worker quit with fatal: Transport channel closed, when attempting to receive initialized notification";
    const currentMcpWorkerClosedWarning =
      '2026-05-29T05:34:54.565773Z ERROR mcp::transport::worker: worker quit with fatal: Transport channel closed, when Auth(TokenRefreshFailed("Failed to parse server response"))';
    const rmcpWorkerClosedWarning =
      '2026-06-01T18:44:20.841238Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer error=\\"invalid_request\\"", error_description=\\"No access token was provided in this request\\"" })';

    assert.equal(classifyCodexStderrLine(modelRefreshWarning), null);
    assert.equal(classifyCodexStderrLine(mcpWorkerClosedWarning), null);
    assert.equal(classifyCodexStderrLine(currentMcpWorkerClosedWarning), null);
    assert.equal(classifyCodexStderrLine(rmcpWorkerClosedWarning), null);
  });

  it("keeps actionable Codex stderr lines visible", () => {
    assert.deepStrictEqual(classifyCodexStderrLine("The filename or extension is too long."), {
      message: "The filename or extension is too long.",
    });
  });

  it("filters logged command failure output that is already represented as tool output", () => {
    const classifier = makeCodexStderrLineClassifier();

    assert.equal(
      classifier.classify(
        "2026-05-28T16:11:20.013735Z ERROR codex_core::tools::router: error=Exit code: 1",
      ),
      null,
    );
    assert.equal(classifier.classify("Wall time: 0.6 seconds"), null);
    assert.equal(classifier.classify("Output:"), null);
    assert.equal(
      classifier.classify(
        "Select-String : A positional parameter cannot be found that accepts argument '~/t3-env\\|provider: \\github\\'.",
      ),
      null,
    );
  });

  it("resumes stderr classification at the next Codex log line", () => {
    const classifier = makeCodexStderrLineClassifier();

    assert.equal(
      classifier.classify(
        "2026-05-28T16:11:20.013735Z ERROR codex_core::tools::router: error=Exit code: 1",
      ),
      null,
    );

    assert.deepStrictEqual(
      classifier.classify(
        "2026-05-28T16:11:21.013735Z ERROR codex_runtime::transport: provider disconnected",
      ),
      {
        message:
          "2026-05-28T16:11:21.013735Z ERROR codex_runtime::transport: provider disconnected",
      },
    );
  });

  it("keeps fatal transport stderr visible during suppressed tool output", () => {
    const classifier = makeCodexStderrLineClassifier();

    assert.equal(
      classifier.classify(
        "2026-05-28T16:11:20.013735Z ERROR codex_core::tools::router: error=Exit code: 1",
      ),
      null,
    );

    assert.deepStrictEqual(classifier.classify("failed to connect to websocket"), {
      message: "failed to connect to websocket",
    });
  });
});

describe("openCodexThread", () => {
  it("falls back to thread/start when resume fails recoverably", async () => {
    const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
    const started = makeThreadOpenResponse("fresh-thread");
    const client = {
      request: <M extends "thread/start" | "thread/resume">(
        method: M,
        payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        calls.push({ method, payload });
        if (method === "thread/resume") {
          return Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: "thread not found",
            }),
          );
        }
        return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
      },
    };

    const opened = await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }),
    );

    assert.equal(opened.thread.id, "fresh-thread");
    assert.deepStrictEqual(
      calls.map((call) => call.method),
      ["thread/resume", "thread/start"],
    );
    assert.deepStrictEqual(calls[0]?.payload, {
      threadId: "stale-thread",
      cwd: "/tmp/project",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model: "gpt-5.3-codex",
    });
  });

  it("propagates non-recoverable resume failures", async () => {
    const client = {
      request: <M extends "thread/start" | "thread/resume">(
        method: M,
        _payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        if (method === "thread/resume") {
          return Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: "timed out waiting for server",
            }),
          );
        }
        return Effect.succeed(
          makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
        );
      },
    };

    await assert.rejects(
      Effect.runPromise(
        openCodexThread({
          client,
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "full-access",
          cwd: "/tmp/project",
          requestedModel: "gpt-5.3-codex",
          serviceTier: undefined,
          resumeThreadId: "stale-thread",
        }),
      ),
      (error: unknown) =>
        isCodexAppServerRequestError(error) &&
        error.errorMessage === "timed out waiting for server",
    );
  });
});
