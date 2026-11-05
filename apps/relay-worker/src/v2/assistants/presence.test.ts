import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AssistantPresence } from "./presence.ts";

const OPTIONS = { holdMs: 5_000, recentMs: 120_000, maxWaiting: 2 };

describe("AssistantPresence", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for a computer that's just reconnecting, and only that", () => {
    const presence = new AssistantPresence(OPTIONS);
    // Never seen go, no socket open: gone a while (asleep), answered at once.
    expect(presence.mayComeBack(0, false)).toBe(false);
    // One of its sockets is still open: coming back.
    expect(presence.mayComeBack(0, true)).toBe(true);
    presence.socketGone(1_000);
    expect(presence.mayComeBack(1_000 + 120_000, false)).toBe(true);
    expect(presence.mayComeBack(1_000 + 120_001, false)).toBe(false);
  });

  it("hands over the socket as soon as it's back, and gives up after the hold", async () => {
    const presence = new AssistantPresence(OPTIONS);
    let socket: string | null = null;
    const back = presence.wait(() => socket);
    await vi.advanceTimersByTimeAsync(1_000);
    socket = "assistant-socket";
    presence.changed();
    await expect(back).resolves.toBe("assistant-socket");

    socket = null;
    const gone = presence.wait(() => socket);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(gone).resolves.toBeNull();
  });

  it("answers at once when too many requests are already waiting", () => {
    const presence = new AssistantPresence(OPTIONS);
    void presence.wait(() => null);
    void presence.wait(() => null);
    expect(presence.mayComeBack(0, true)).toBe(false);
  });
});
