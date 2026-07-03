import type {
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusStreamEvent,
} from "@threadlines/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("./wsTransport", () => ({
  WsTransport: class WsTransport {
    dispose = vi.fn(async () => undefined);
    reconnect = vi.fn(async () => undefined);
    request = vi.fn();
    requestStream = vi.fn();
    subscribe = vi.fn(() => () => undefined);
  },
}));

import {
  createWsRpcClient,
  dispatchCommandRetryOptions,
  estimateCommandUploadChars,
} from "./wsRpcClient";
import { type WsTransport } from "./wsTransport";

const baseLocalStatus: VcsStatusLocalResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/demo",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

const baseRemoteStatus: VcsStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

describe("wsRpcClient", () => {
  it("reduces vcs status stream events into flat status snapshots", () => {
    const subscribe = vi.fn(<TValue>(_connect: unknown, listener: (value: TValue) => void) => {
      for (const event of [
        {
          _tag: "snapshot",
          local: baseLocalStatus,
          remote: null,
        },
        {
          _tag: "remoteUpdated",
          remote: baseRemoteStatus,
        },
        {
          _tag: "localUpdated",
          local: {
            ...baseLocalStatus,
            hasWorkingTreeChanges: true,
          },
        },
      ] satisfies VcsStatusStreamEvent[]) {
        listener(event as TValue);
      }
      return () => undefined;
    });

    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      request: vi.fn(),
      requestStream: vi.fn(),
      subscribe,
    } satisfies Pick<
      WsTransport,
      "dispose" | "reconnect" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport);
    const listener = vi.fn();

    client.vcs.onStatus({ cwd: "/repo" }, listener);

    expect(listener.mock.calls).toEqual([
      [
        {
          ...baseLocalStatus,
          hasUpstream: false,
          aheadCount: 0,
          behindCount: 0,
          aheadOfDefaultCount: 0,
          pr: null,
        },
      ],
      [
        {
          ...baseLocalStatus,
          ...baseRemoteStatus,
        },
      ],
      [
        {
          ...baseLocalStatus,
          ...baseRemoteStatus,
          hasWorkingTreeChanges: true,
        },
      ],
    ]);
  });

  it("dispatches orchestration commands through the reconnect-retrying request path", () => {
    const requestWithReconnectRetry = vi.fn(async (_execute: unknown, _options?: unknown) => ({
      sequence: 1,
    }));
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      request: vi.fn(),
      requestStream: vi.fn(),
      requestWithReconnectRetry,
      subscribe: vi.fn(() => () => undefined),
    };

    const client = createWsRpcClient(transport as unknown as WsTransport);
    void client.orchestration.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: "11111111-1111-4111-8111-111111111111",
      threadId: "22222222-2222-4222-8222-222222222222",
      createdAt: "2026-07-03T00:00:00.000Z",
    } as Parameters<typeof client.orchestration.dispatchCommand>[0]);

    expect(requestWithReconnectRetry).toHaveBeenCalledTimes(1);
    expect(requestWithReconnectRetry.mock.calls[0]?.[1]).toMatchObject({
      label: "orchestration.dispatchCommand",
      attemptTimeoutMs: 25_000,
    });
  });
});

describe("dispatchCommandRetryOptions", () => {
  it("uses the base attempt timeout for commands without uploads", () => {
    expect(
      dispatchCommandRetryOptions({ type: "thread.turn.interrupt", threadId: "t" }),
    ).toMatchObject({
      label: "orchestration.dispatchCommand",
      attemptTimeoutMs: 25_000,
    });
  });

  it("scales the attempt timeout with inline attachment payload size", () => {
    const command = {
      type: "thread.turn.start",
      message: {
        attachments: [
          { type: "image", dataUrl: "x".repeat(2_000_000) },
          { type: "image", dataUrl: "y".repeat(500_000) },
        ],
      },
    };
    expect(estimateCommandUploadChars(command)).toBe(2_500_000);
    const options = dispatchCommandRetryOptions(command);
    // 25s base + ceil(2.5MB) * 20s per MB.
    expect(options.attemptTimeoutMs).toBe(85_000);
    expect(options.totalBudgetMs).toBe(85_000 * 3 + 15_000);
  });

  it("caps the attempt timeout for very large payloads", () => {
    const command = {
      type: "thread.turn.start",
      message: {
        attachments: [{ type: "image", dataUrl: "x".repeat(30_000_000) }],
      },
    };
    expect(dispatchCommandRetryOptions(command).attemptTimeoutMs).toBe(180_000);
  });

  it("ignores stored attachment references without inline data", () => {
    expect(
      estimateCommandUploadChars({
        type: "thread.turn.start",
        message: {
          attachments: [{ type: "image", id: "a", name: "image.png" }],
        },
      }),
    ).toBe(0);
  });
});
