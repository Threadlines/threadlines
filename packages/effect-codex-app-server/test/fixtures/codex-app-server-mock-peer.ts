let nextServerRequestId = 10_000;
let pendingSkillsListRequestId: number | string | null = null;
let pendingUserInputRequestId: number | null = null;

const writeMessage = (message: unknown) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const respond = (id: number | string, result: unknown) => {
  writeMessage({ id, result });
};

const respondError = (id: number | string, code: number, message: string) => {
  writeMessage({
    id,
    error: {
      code,
      message,
    },
  });
};

const sendRequest = (method: string, params: unknown) => {
  const id = nextServerRequestId++;
  writeMessage({ id, method, params });
  return id;
};

const handleMethod = (message: Record<string, unknown>) => {
  const method = message.method;
  if (typeof method !== "string") {
    return;
  }

  switch (method) {
    case "initialize": {
      const stderrBytes = Number(process.env.CODEX_APP_SERVER_TEST_STDERR_BYTES ?? 0);
      if (Number.isFinite(stderrBytes) && stderrBytes > 0) {
        process.stderr.write("x".repeat(stderrBytes), () => {
          respond(message.id as number | string, {
            userAgent: "mock-codex-app-server",
            codexHome: process.cwd(),
            platformFamily: process.platform === "win32" ? "windows" : "unix",
            platformOs: process.platform === "darwin" ? "macos" : process.platform,
          });
        });
        return;
      }
      respond(message.id as number | string, {
        userAgent: "mock-codex-app-server",
        codexHome: process.cwd(),
        platformFamily: process.platform === "win32" ? "windows" : "unix",
        platformOs: process.platform === "darwin" ? "macos" : process.platform,
      });
      return;
    }
    case "initialized": {
      writeMessage({
        method: "item/agentMessage/delta",
        params: {
          delta: "Mock server is ready.",
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      });
      return;
    }
    case "account/read": {
      respond(message.id as number | string, {
        account: {
          type: "chatgpt",
          email: "mock@example.com",
          planType: "plus",
        },
        requiresOpenaiAuth: false,
      });
      return;
    }
    case "thread/start": {
      respond(message.id as number | string, {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        cwd: process.cwd(),
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        sandbox: { type: "dangerFullAccess" },
        thread: {
          cliVersion: "0.153.4",
          createdAt: 0,
          cwd: process.cwd(),
          ephemeral: true,
          id: "thread-1",
          modelProvider: "openai",
          preview: "",
          projectId: null,
          sessionId: "session-1",
          source: "cli",
          status: { type: "idle" },
          turns: [],
          updatedAt: 0,
        },
      });
      return;
    }
    case "turn/start": {
      respond(message.id as number | string, {
        turn: { id: "turn-1", status: "inProgress", items: [] },
      });
      pendingUserInputRequestId = sendRequest("item/tool/requestUserInput", {
        itemId: "question-item",
        threadId: "thread-1",
        turnId: "turn-1",
        questions: [{ id: "proceed", header: "Proceed", question: "Continue?" }],
      });
      return;
    }
    case "turn/steer": {
      respond(message.id as number | string, { turnId: "turn-1" });
      const params = message.params as { input: Array<{ text?: string }> };
      if (params.input[0]?.text === "resolve") {
        writeMessage({
          method: "serverRequest/resolved",
          params: { threadId: "thread-1", requestId: pendingUserInputRequestId },
        });
      } else {
        writeMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", items: [] },
          },
        });
      }
      return;
    }
    case "skills/list": {
      pendingSkillsListRequestId = message.id as number | string;
      pendingUserInputRequestId = sendRequest("item/tool/requestUserInput", {
        itemId: "item-approval-1",
        threadId: "thread-1",
        turnId: "turn-1",
        isBlocking: true,
        questions: [
          {
            id: "approved",
            header: "Approve",
            question: "Continue with the mock skills request?",
            options: [
              {
                label: "yes",
                description: "Approve the request",
              },
            ],
          },
        ],
      });
      return;
    }
    default: {
      if (message.id !== undefined) {
        respondError(message.id as number | string, -32601, `Unhandled request: ${method}`);
      }
    }
  }
};

const handleResponse = (message: Record<string, unknown>) => {
  if (message.id !== pendingUserInputRequestId) {
    return;
  }

  pendingUserInputRequestId = null;

  if (pendingSkillsListRequestId === null) return;

  respond(pendingSkillsListRequestId!, {
    data: [
      {
        cwd: process.cwd(),
        errors: [],
        skills: [],
      },
    ],
  });
  pendingSkillsListRequestId = null;
};

let remainder = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  remainder += chunk;
  const lines = remainder.split("\n");
  remainder = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const message = JSON.parse(trimmed) as Record<string, unknown>;
    if ("method" in message) {
      handleMethod(message);
      continue;
    }
    if ("id" in message) {
      handleResponse(message);
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
