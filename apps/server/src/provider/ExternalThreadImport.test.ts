import assert from "node:assert/strict";

import {
  type OrchestrationCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, it, vi } from "vite-plus/test";

import { importExternalProviderThread } from "./ExternalThreadImport.ts";

describe("importExternalProviderThread", () => {
  it("backfills the transcript in order and requires the exact native Codex session", async () => {
    const providerInstanceId = ProviderInstanceId.make("codex");
    const projectId = ProjectId.make("project-1");
    const threadId = ThreadId.make("thread-imported");
    const commands: OrchestrationCommand[] = [];
    const dispatch = vi.fn((command: OrchestrationCommand) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }),
    );
    const startSession = vi.fn((_threadId, input) =>
      Effect.succeed({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId,
        status: "ready" as const,
        runtimeMode: input.runtimeMode,
        cwd: input.cwd,
        model: input.modelSelection?.model,
        threadId,
        resumeCursor: { threadId: "native-thread" },
        createdAt: "2026-07-20T12:00:00.000Z",
        updatedAt: "2026-07-20T12:00:00.000Z",
      }),
    );
    const stopSession = vi.fn((_input: { readonly threadId: ThreadId }) => Effect.void);
    const services: Parameters<typeof importExternalProviderThread>[1] = {
      projectionSnapshotQuery: {
        getProjectShellById: () =>
          Effect.succeed(
            Option.some({
              id: projectId,
              kind: "workspace",
              title: "Badcode",
              workspaceRoot: "/workspace/badcode",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-07-01T00:00:00.000Z",
              updatedAt: "2026-07-01T00:00:00.000Z",
            }),
          ),
      },
      providerService: {
        readExternalThread: (input) => {
          assert.equal(input.expectedCwd, "/workspace/badcode");
          return Effect.succeed({
            candidate: {
              providerInstanceId,
              providerThreadId: "native-thread",
              sessionId: "native-session",
              source: "cli",
              name: "Fix the parser",
              preview: "Fix the parser edge case",
              cwd: "/workspace/badcode",
              cliVersion: "0.145.0",
              createdAt: "2026-07-19T10:00:00.000Z",
              updatedAt: "2026-07-19T10:05:00.000Z",
              status: "idle",
              canImport: true,
            },
            messages: [
              {
                providerItemId: "item-user",
                providerTurnId: "turn-1",
                role: "user",
                text: "Fix the parser",
                createdAt: "2026-07-19T10:00:00.000Z",
              },
              {
                providerItemId: "item-assistant",
                providerTurnId: "turn-1",
                role: "assistant",
                text: "I fixed the parser.",
                createdAt: "2026-07-19T10:05:00.000Z",
              },
            ],
          });
        },
        startSession,
        stopSession,
      },
      orchestrationEngine: { dispatch },
    };

    const result = await Effect.runPromise(
      importExternalProviderThread(
        {
          providerInstanceId,
          providerThreadId: "native-thread",
          projectId,
          threadId,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.6-sol" },
          runtimeMode: "full-access",
        },
        services,
      ),
    );

    assert.deepStrictEqual(result, { threadId, importedMessageCount: 2 });
    assert.deepStrictEqual(
      commands.map((command) => command.type),
      [
        "thread.create",
        "thread.message.user.record",
        "thread.message.assistant.delta",
        "thread.message.assistant.complete",
        "thread.session.set",
      ],
    );
    const createCommand = commands.find((command) => command.type === "thread.create");
    assert.equal(createCommand?.createdAt, "2026-07-19T10:00:00.000Z");
    assert.equal(startSession.mock.calls.length, 1);
    assert.deepStrictEqual(startSession.mock.calls[0]?.[1].resumeCursor, {
      threadId: "native-thread",
    });
    assert.equal(startSession.mock.calls[0]?.[1].resumePolicy, "required");
    assert.deepStrictEqual(stopSession.mock.calls[0]?.[0], { threadId });
    const settledSession = commands.find((command) => command.type === "thread.session.set");
    assert.equal(settledSession?.session.status, "stopped");
    assert.equal(settledSession?.session.providerThreadId, "native-thread");
  });
});
