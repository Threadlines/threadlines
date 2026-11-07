import {
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationCommand,
  type OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  SideTurnId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { settingsChangeStateOn } from "@threadlines/shared/settingsChangeState";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import type { McpInvocationScope } from "./McpSessionRegistry.ts";
import { roomToolsFor } from "./roomToolAccess.ts";
import { makeSettingsChangeToolHandler } from "./settingsChangeToolHandlers.ts";

const THREAD = ThreadId.make("thread-settings");
const TURN = TurnId.make("turn-1");
const AT = "2026-11-02T10:00:00.000Z";

const makeThread = (): OrchestrationThread =>
  ({
    id: THREAD,
    projectId: ProjectId.make("project-1"),
    title: "Settings",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    session: {
      threadId: THREAD,
      status: "running",
      providerName: "codex",
      runtimeMode: "auto-accept-edits",
      participantId: null,
      activeTurnId: TURN,
      lastError: null,
      updatedAt: AT,
    },
    archivedAt: null,
    deletedAt: null,
    settingsRequests: [],
  }) as unknown as OrchestrationThread;

const mainCaller = (): McpInvocationScope => ({
  threadId: THREAD,
  sessionKey: THREAD,
  participantId: null,
  generation: 1,
  agentId: "agent-test",
  browser: true,
  pages: true,
  commands: false,
  roomTools: new Set(roomToolsFor(undefined)),
});

const provider = (
  instanceId: string,
  driver: string,
  authType: string,
  ...slugs: ReadonlyArray<string>
) =>
  ({
    instanceId,
    driver,
    enabled: true,
    installed: true,
    status: "ready",
    availability: "available",
    auth: { status: "authenticated", type: authType },
    models: slugs.map((slug) => ({ slug, name: slug.toUpperCase() })),
  }) as unknown as ServerProvider;

const providers: ReadonlyArray<ServerProvider> = [
  provider("codex", "codex", "chatgpt", "gpt-test"),
  provider("claudeAgent", "claudeAgent", "oauth", "opus-test"),
  provider("claude-api", "claudeAgent", "apiKey", "opus-test"),
  provider("grok-key", "grok", "api_key", "grok-test"),
  provider("pi", "pi", "piProviders", "pi-test"),
  provider("community", "acpRegistry", "none", "their-model"),
];

/** The tool over an engine that keeps receipts by command id and records requests as the decider would. */
function harness(settings: Partial<ServerSettings> = {}, themeNames: ReadonlyArray<string> = []) {
  let thread = makeThread();
  const dispatched: OrchestrationCommand[] = [];
  const receipts = new Set<string>();
  const handler = makeSettingsChangeToolHandler({
    engine: {
      dispatch: (command) =>
        Effect.sync(() => {
          if (receipts.has(command.commandId)) return { sequence: 1 };
          receipts.add(command.commandId);
          dispatched.push(command);
          if (command.type === "thread.settings-change.request") {
            thread = {
              ...thread,
              settingsRequests: settingsChangeStateOn.requested(thread.settingsRequests ?? [], {
                requestId: command.requestId,
                participantId: command.participantId,
                turnId: command.turnId,
                changes: command.changes,
                status: "waiting",
                createdAt: command.createdAt,
                noted: false,
              }),
            };
          }
          return { sequence: dispatched.length };
        }),
    },
    readThread: () => Effect.sync(() => thread),
    settings: Effect.succeed({
      ...DEFAULT_SERVER_SETTINGS,
      enableAssistantStreaming: true,
      ...settings,
    }),
    providers: Effect.succeed(providers),
    themeNames: Effect.succeed(themeNames),
  });
  return { handler, dispatched, thread: () => thread };
}

describe("settings_change", () => {
  it("puts a card on the thread with each change, from what to what and where it lands", async () => {
    const { handler, dispatched } = harness();
    const result = await Effect.runPromise(
      handler(mainCaller(), {
        changes: [
          { place: "general.streamReplies", value: false },
          { place: "appearance.theme", value: "light" },
        ],
      }),
    );
    expect(result.outcome).toBe("asked_user");
    expect(result.changes).toEqual([
      expect.objectContaining({
        place: "general.streamReplies",
        from: "On",
        to: "Off",
        lands: "computer",
      }),
      expect.objectContaining({ place: "appearance.theme", to: "Light", lands: "device" }),
    ]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "thread.settings-change.request",
      turnId: TURN,
      changes: [
        { place: "general.streamReplies", value: false, from: true },
        { place: "appearance.theme", value: "light" },
      ],
    });
  });

  it("switches to a theme by name only when this computer has one by that name", async () => {
    const { handler, dispatched } = harness({}, ["Night Sky"]);
    for (const value of ["night sky", "Aurora", "system"]) {
      const asked = await Effect.runPromise(
        handler(mainCaller(), { changes: [{ place: "appearance.theme", value }] }),
      );
      expect(asked.outcome).toBe("asked_user");
    }
    const refused = await Effect.runPromise(
      handler(mainCaller(), { changes: [{ place: "appearance.theme", value: "Sepia" }] }),
    );
    expect(refused).toMatchObject({ outcome: "refused" });
    expect(refused.detail).toContain('"Night Sky"');
    expect(dispatched).toHaveLength(3);
  });

  it("makes one card for a retried call", async () => {
    const { handler, dispatched, thread } = harness();
    const call = { changes: [{ place: "appearance.theme", value: "dark" }] };
    await Effect.runPromise(handler(mainCaller(), call));
    const again = await Effect.runPromise(handler(mainCaller(), call));
    expect(again.outcome).toBe("asked_user");
    expect(dispatched).toHaveLength(1);
    expect(thread().settingsRequests).toHaveLength(1);
  });

  it("leaves a computer setting already at its value off, and asks nothing when that's all", async () => {
    const { handler, dispatched } = harness();
    const result = await Effect.runPromise(
      handler(mainCaller(), { changes: [{ place: "general.streamReplies", value: true }] }),
    );
    expect(result.outcome).toBe("unchanged");
    expect(result.detail).toContain("Stream replies is already On");
    expect(dispatched).toHaveLength(0);
  });

  it("refuses a setting that widens agents' reach, linking it for the user", async () => {
    const { handler, dispatched } = harness();
    const result = await Effect.runPromise(
      handler(mainCaller(), { changes: [{ place: "threads.agentThreads", value: "auto" }] }),
    );
    expect(result.outcome).toBe("refused");
    expect(result.detail).toContain("Only the user can change");
    expect(result.detail).toContain("(threadlines-place:threads.agentThreads)");
    expect(dispatched).toHaveLength(0);
  });

  it("is not for a side answer", async () => {
    const { handler } = harness();
    const result = await Effect.runPromise(
      handler(
        {
          ...mainCaller(),
          side: { sideTurnId: SideTurnId.make("side-1"), kind: "ask" },
          roomTools: new Set(roomToolsFor("ask")),
        },
        { changes: [{ place: "appearance.theme", value: "dark" }] },
      ),
    );
    expect(result.outcome).toBe("not_allowed");
  });

  const askFor = (changes: ReadonlyArray<{ place: string; value: string }>) => {
    const { handler } = harness();
    return Effect.runPromise(handler(mainCaller(), { changes }));
  };

  it("offers only models this computer can run on a plan it knows about", async () => {
    const picked = await askFor([{ place: "threads.agent", value: "claudeAgent/opus-test" }]);
    expect(picked.outcome).toBe("asked_user");
    expect(picked.changes?.[0]).toMatchObject({ from: "Last used", to: "opus-test" });
    // A card can't move someone's default onto per-use billing, nor where we can't tell.
    for (const value of [
      "claude-api/opus-test",
      "grok-key/grok-test",
      "pi/pi-test",
      "community/their-model",
    ]) {
      const refused = await askFor([{ place: "threads.agent", value }]);
      expect(refused.outcome, value).toBe("refused");
      expect(refused.detail, value).toContain("billed per use");
    }
    for (const value of ["nowhere/gpt-test", "codex/not-a-model"]) {
      expect((await askFor([{ place: "threads.agent", value }])).outcome, value).toBe("refused");
    }
  });

  it("keeps the writing model and its backup on different providers", async () => {
    const writing = { place: "threads.writingModel", value: "codex/gpt-test" };
    const onCodex = { place: "threads.backupWritingModel", value: "codex/gpt-test" };
    const onClaude = { place: "threads.backupWritingModel", value: "claudeAgent/opus-test" };
    expect((await askFor([writing, onCodex])).outcome).toBe("refused");
    expect((await askFor([writing, onClaude])).outcome).toBe("asked_user");
  });

  it("won't let a writing model change quietly swap a backup that's turned off", async () => {
    const { handler } = harness({
      textGenerationBackupModelSelection: {
        instanceId: ProviderInstanceId.make("gone"),
        model: "gone-model",
      },
    });
    const writing = { place: "threads.writingModel", value: "codex/gpt-test" };
    const asked = (changes: ReadonlyArray<{ place: string; value: string }>) =>
      Effect.runPromise(handler(mainCaller(), { changes }));
    expect((await asked([writing])).outcome).toBe("refused");
    expect(
      (await asked([writing, { place: "threads.backupWritingModel", value: "none" }])).outcome,
    ).toBe("asked_user");
  });

  it("won't turn off a source control model when that leaves a per-use writing model", async () => {
    const { handler } = harness({
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("claude-api"),
        model: "opus-test",
      },
      sourceControlWriterModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-test",
      },
    });
    const result = await Effect.runPromise(
      handler(mainCaller(), {
        changes: [{ place: "sourceControl.writerModel", value: "none" }],
      }),
    );
    expect(result.outcome).toBe("refused");
  });
});
