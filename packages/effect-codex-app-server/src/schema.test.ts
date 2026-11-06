import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as CodexSchema from "./schema.ts";

// Keep older multi-agent histories readable when refreshing the protocol.
it("accepts Codex 0.150 multi-agent values", () => {
  const schemas = [
    CodexSchema.ServerNotification__SubAgentActivityKind,
    CodexSchema.V2ItemStartedNotification__SubAgentActivityKind,
    CodexSchema.V2ItemCompletedNotification__SubAgentActivityKind,
    CodexSchema.V2ThreadReadResponse__SubAgentActivityKind,
    CodexSchema.V2ThreadResumeResponse__SubAgentActivityKind,
  ];

  for (const schema of schemas) {
    assert.equal(Schema.is(schema)("completed"), true);
  }

  for (const tool of ["sendMessage", "followupTask", "interruptAgent", "listAgents"]) {
    assert.equal(Schema.is(CodexSchema.ServerNotification__CollabAgentTool)(tool), true);
    assert.equal(Schema.is(CodexSchema.V2ThreadResumeResponse__CollabAgentTool)(tool), true);
  }

  assert.equal(
    Schema.is(CodexSchema.ServerNotification__CollabAgentToolCallStatus)("interrupted"),
    true,
  );
  assert.equal(
    Schema.is(CodexSchema.V2ThreadResumeResponse__CollabAgentToolCallStatus)("interrupted"),
    true,
  );

  const resumeResponse = {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: "/tmp/project",
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    sandbox: { type: "dangerFullAccess" },
    thread: {
      cliVersion: "0.150.0",
      createdAt: 0,
      cwd: "/tmp/project",
      ephemeral: false,
      id: "root-thread",
      modelProvider: "openai",
      preview: "",
      projectId: null,
      sessionId: "session-1",
      source: "cli",
      status: { type: "idle" },
      turns: [
        {
          id: "turn-1",
          status: "completed",
          items: [
            {
              agentsStates: {},
              id: "item-1",
              receiverThreadIds: ["child-thread"],
              senderThreadId: "root-thread",
              status: "interrupted",
              tool: "followupTask",
              type: "collabAgentToolCall",
            },
            {
              agentPath: "/root-thread/child-thread",
              agentThreadId: "child-thread",
              id: "item-2",
              kind: "completed",
              type: "subAgentActivity",
            },
          ],
        },
      ],
      updatedAt: 0,
    },
  };

  assert.equal(Schema.is(CodexSchema.V2ThreadResumeResponse)(resumeResponse), true);
});

it("preserves async questions in streamed items and restored conversation history", () => {
  const item = {
    type: "agentMessage",
    id: "question-message",
    text: "Please sign into Codex and Claude.",
    phase: "commentary",
    questions: [
      { title: "Are both signed in?", options: ["Both are signed in", "Only one worked"] },
    ],
  } satisfies CodexSchema.V2ItemCompletedNotification__ThreadItem;
  for (const schema of [
    CodexSchema.V2ItemStartedNotification__ThreadItem,
    CodexSchema.V2ItemCompletedNotification__ThreadItem,
    CodexSchema.V2ThreadReadResponse__ThreadItem,
    CodexSchema.V2ThreadResumeResponse__ThreadItem,
  ]) {
    assert.deepEqual(Schema.decodeUnknownSync(schema)(item), item);
  }
});

// Codex 0.164+ can send a generated image as an attachment id with no inline data.
it("accepts generated images with inline data or only an attachment id", () => {
  const base = {
    type: "imageGeneration",
    id: "image-1",
    status: "completed",
    savedPath: "/tmp/project/image.png",
  } as const;
  for (const schema of [
    CodexSchema.V2ItemCompletedNotification__ThreadItem,
    CodexSchema.V2ThreadReadResponse__ThreadItem,
    CodexSchema.V2ThreadTurnsListResponse__ThreadItem,
    CodexSchema.V2ThreadItemsListResponse__ThreadItem,
  ]) {
    for (const item of [
      { ...base, result: "aGVsbG8=" },
      { ...base, fileId: "file-1" },
    ]) {
      assert.deepEqual(Schema.decodeUnknownSync(schema)(item), item);
    }
  }
});

it("accepts legacy questions without a blocking flag and preserves explicit false", () => {
  const payload = { itemId: "item", threadId: "thread", turnId: "turn", questions: [] };
  for (const schema of [
    CodexSchema.ToolRequestUserInputParams,
    CodexSchema.ServerRequest__ToolRequestUserInputParams,
  ]) {
    assert.deepEqual(Schema.decodeUnknownSync(schema)(payload), payload);
    assert.deepEqual(Schema.decodeUnknownSync(schema)({ ...payload, isBlocking: false }), {
      ...payload,
      isBlocking: false,
    });
  }
});

// Codex adds plans and hook events often; one new word must not fail the whole
// account read or hooks list (the generator's OPEN_ENUM_DEFINITIONS), and keys
// a newer Codex adds are dropped rather than refused.
const decodeAccountReply = Schema.decodeUnknownSync(CodexSchema.V2GetAccountResponse);
const decodeHooksReply = Schema.decodeUnknownSync(CodexSchema.V2HooksListResponse);
it("keeps a reply whole when Codex sends a word or a key it didn't have before", () => {
  const account = {
    account: { type: "chatgpt" as const, email: "a@b.c", planType: "a_plan_from_next_year" },
    requiresOpenaiAuth: false,
  };
  assert.deepEqual(decodeAccountReply(account), account);
  assert.deepEqual(decodeAccountReply({ ...account, newField: 1 }), account);

  const hooks = {
    data: [
      {
        cwd: "/tmp/project",
        errors: [],
        warnings: [],
        hooks: [
          {
            key: "hook-1",
            handlerType: "command" as const,
            command: "echo hi",
            eventName: "anEventFromNextYear",
            source: "aSourceFromNextYear",
            trustStatus: "aTrustFromNextYear",
            currentHash: "hash",
            displayOrder: 0,
            enabled: true,
            isManaged: false,
            sourcePath: "/tmp/project/.codex/hooks.json",
            timeoutSec: 30,
          },
        ],
      },
    ],
  };
  assert.deepEqual(decodeHooksReply(hooks), hooks);
});
