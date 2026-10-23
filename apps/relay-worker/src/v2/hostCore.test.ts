import { RELAY_HOOK_HOLD_MS, RELAY_HOOK_INLINE_SEALED_BYTES } from "@threadlines/contracts/relay";
import { describe, expect, it } from "vite-plus/test";

import { CodeShardCore } from "./codeShardCore.ts";
import {
  DEFAULT_HOST_CORE_LIMITS,
  HostCore,
  HostCoreError,
  type HostEffect,
  type JoinInput,
  RETIRED_HOOK_KEEP_MS,
} from "./hostCore.ts";
import { LedgerCore } from "./ledgerCore.ts";
import { makeTestSql } from "./testSql.ts";

const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);
const MINUTE = 60_000;

function makeHost(limits = DEFAULT_HOST_CORE_LIMITS) {
  const core = new HostCore(makeTestSql(), limits, T0);
  core.initialize({
    hostId: "host-1",
    secretHash: "host-secret-hash",
    label: "Will's MacBook",
    environmentId: "env-mac",
    now: T0,
  });
  core.createInvite({
    inviteId: "invite-1",
    code: "482913",
    claimTokenHash: "claim-hash",
    now: T0,
  });
  return core;
}

let counter = 0;
function joinInput(overrides: Partial<JoinInput> = {}): JoinInput {
  counter += 1;
  return {
    inviteId: "invite-1",
    joinId: `join-${counter}`,
    deviceSecretHash: `device-hash-${counter}`,
    requestSecretHash: `request-hash-${counter}`,
    devicePublicKey: `device-key-${counter}`,
    commitment: `commitment-${counter}`,
    joiner: { label: "Will's Desktop", platform: "Windows", kind: "computer" },
    now: T0 + MINUTE,
    fresh: {
      requestId: `request-${counter}`,
      deviceId: `device-${counter}`,
    },
    ...overrides,
  };
}

function expectCoreError(run: () => unknown, code: string) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(HostCoreError);
    expect((error as HostCoreError).code).toBe(code);
    return;
  }
  throw new Error(`Expected HostCoreError ${code}`);
}

function watchStates(effects: ReadonlyArray<HostEffect>) {
  return effects.flatMap((effect) =>
    effect.type === "watch" && effect.event.type === "request.state" ? [effect.event.state] : [],
  );
}

describe("HostCore joins and decisions", () => {
  it("approves a code join into an active device and uses up the code", () => {
    const core = makeHost();
    const input = joinInput();
    const joined = core.join(input);

    expect(joined.result).toMatchObject({
      hostId: "host-1",
      hostEnvironmentId: "env-mac",
      hostLabel: "Will's MacBook",
      autoApprove: false,
    });
    expect(joined.effects.some((effect) => effect.type === "control")).toBe(true);

    const decided = core.decide({
      requestId: joined.result.requestId,
      decision: "approve",
      now: T0 + 2 * MINUTE,
    });
    expect(decided.result.state).toBe("approved");
    expect(watchStates(decided.effects)).toEqual(["approved"]);
    expect(core.authenticateDevice(input.fresh.deviceId, input.deviceSecretHash)).toBe("active");
    expect(core.authenticateDevice(input.fresh.deviceId, "someone-elses-hash")).toBeNull();

    // The code is single use, but stays routable so a joiner whose first
    // response was lost can replay its joinId and learn it was approved.
    expect(decided.effects.some((effect) => effect.type === "release-code")).toBe(false);
    expect(core.join(input).result.requestId).toBe(joined.result.requestId);
    expectCoreError(() => core.join(joinInput()), "invalid-code");
  });

  it("returns the same request for a replayed join and rejects a reused joinId", () => {
    const core = makeHost();
    const input = joinInput();
    const first = core.join(input);
    const replay = core.join({ ...input, fresh: { ...input.fresh, requestId: "other" } });
    expect(replay.result.requestId).toBe(first.result.requestId);
    expect(replay.effects).toEqual([]);

    expectCoreError(() => core.join({ ...input, deviceSecretHash: "different" }), "invalid-invite");
  });

  it("keeps one pending request per code, and frees the code when the joiner cancels", () => {
    const core = makeHost();
    const first = joinInput();
    core.join(first);
    expectCoreError(() => core.join(joinInput()), "busy");

    const cancelled = core.cancelRequest({
      requestId: first.fresh.requestId,
      requestSecretHash: first.requestSecretHash,
      now: T0 + 2 * MINUTE,
    });
    expect(cancelled.result.state).toBe("cancelled");
    expect(core.join(joinInput({ now: T0 + 3 * MINUTE })).result.autoApprove).toBe(false);
  });

  it("burns the code when the host denies", () => {
    const core = makeHost();
    const joined = core.join(joinInput());
    const denied = core.decide({
      requestId: joined.result.requestId,
      decision: "deny",
      now: T0 + 2 * MINUTE,
    });
    expect(denied.result.state).toBe("denied");
    expectCoreError(() => core.join(joinInput()), "invalid-code");
  });

  it("returns recorded outcomes before checking expiry, and never revives a removed device", () => {
    const core = makeHost();
    const input = joinInput();
    const joined = core.join(input);
    core.decide({ requestId: joined.result.requestId, decision: "approve", now: T0 + 2 * MINUTE });

    // A retried Allow long after the deadline still reports the recorded approval.
    const retried = core.decide({
      requestId: joined.result.requestId,
      decision: "approve",
      now: T0 + 60 * MINUTE,
    });
    expect(retried.result.state).toBe("approved");

    core.revokeDevice(input.fresh.deviceId, T0 + 61 * MINUTE);
    core.decide({ requestId: joined.result.requestId, decision: "approve", now: T0 + 62 * MINUTE });
    expect(core.authenticateDevice(input.fresh.deviceId, input.deviceSecretHash)).toBe("revoked");
  });

  it("expires an undecided request instead of approving it late", () => {
    const core = makeHost();
    const joined = core.join(joinInput());
    const late = core.decide({
      requestId: joined.result.requestId,
      decision: "approve",
      now: T0 + 30 * MINUTE,
    });
    expect(late.result.state).toBe("expired");
    expect(watchStates(late.effects)).toEqual(["expired"]);
  });

  it("lets an in-flight request outlive its expiring code, but not a cancelled one", () => {
    const core = makeHost();
    const input = joinInput({ now: T0 + 9.5 * MINUTE });
    core.join(input);
    // The code's own deadline passes; the request keeps its own.
    core.expireDue(T0 + 10 * MINUTE + 1);
    const allowed = core.decide({
      requestId: input.fresh.requestId,
      decision: "approve",
      now: T0 + 10 * MINUTE + 5_000,
    });
    expect(allowed.result.state).toBe("approved");

    const other = makeHost();
    const pending = joinInput();
    other.join(pending);
    const cancel = other.cancelInvite("invite-1", T0 + 2 * MINUTE);
    expect(watchStates(cancel.effects)).toEqual(["cancelled"]);
  });

  it("joins instantly from a QR claim only with the right claim token, passing its proof on", () => {
    const core = makeHost();
    const claim = (overrides: Partial<JoinInput>): JoinInput => {
      const { commitment: _commitment, ...base } = joinInput(overrides);
      return { ...base, claimProof: "proof-1", ...overrides };
    };
    expectCoreError(() => core.join(claim({ claimTokenHash: "wrong-hash" })), "invalid-invite");
    const input = claim({ claimTokenHash: "claim-hash" });
    const claimed = core.join(input);
    expect(claimed.result.autoApprove).toBe(true);
    expect(claimed.effects).toContainEqual({
      type: "control",
      event: {
        type: "join.requested",
        request: expect.objectContaining({
          joinId: input.joinId,
          devicePublicKey: input.devicePublicKey,
          claimProof: "proof-1",
        }),
      },
    });
    // Link joins have no number to match.
    expectCoreError(
      () =>
        core.setHostNonce({
          requestId: input.fresh.requestId,
          hostNonce: "n",
          hostPublicKey: "k",
          now: T0 + 2 * MINUTE,
        }),
      "forbidden",
    );
  });

  it("takes the computer's nonce once, and the joiner's only after it", () => {
    const core = makeHost();
    const input = joinInput();
    core.join(input);
    const reveal = (deviceNonce: string) =>
      core.reveal({
        requestId: input.fresh.requestId,
        requestSecretHash: input.requestSecretHash,
        deviceNonce,
        now: T0 + 2 * MINUTE,
      });
    const setNonce = (hostNonce: string) =>
      core.setHostNonce({
        requestId: input.fresh.requestId,
        hostNonce,
        hostPublicKey: "host-key",
        now: T0 + 2 * MINUTE,
      });

    expectCoreError(() => reveal("device-nonce"), "forbidden");
    expect(setNonce("host-nonce").effects).toEqual([
      {
        type: "watch",
        requestId: input.fresh.requestId,
        event: {
          type: "request.host-nonce",
          hostNonce: { hostNonce: "host-nonce", hostPublicKey: "host-key" },
        },
      },
    ]);
    expect(setNonce("host-nonce").effects).toEqual([]);
    expectCoreError(() => setNonce("another-nonce"), "forbidden");

    expect(reveal("device-nonce").effects).toEqual([
      {
        type: "control",
        event: {
          type: "request.revealed",
          requestId: input.fresh.requestId,
          deviceNonce: "device-nonce",
        },
      },
    ]);
    expectCoreError(() => reveal("other-nonce"), "forbidden");
  });

  it("only lets a joiner poll or cancel its own request", () => {
    const core = makeHost();
    const input = joinInput();
    core.join(input);
    expectCoreError(
      () =>
        core.requestStatus({
          requestId: input.fresh.requestId,
          requestSecretHash: "not-mine",
          now: T0 + 2 * MINUTE,
        }),
      "forbidden",
    );
  });

  it("caps active devices per host", () => {
    const core = makeHost({ ...DEFAULT_HOST_CORE_LIMITS, maxDevices: 1 });
    const joined = core.join(joinInput());
    core.decide({ requestId: joined.result.requestId, decision: "approve", now: T0 + 2 * MINUTE });
    core.createInvite({
      inviteId: "invite-2",
      code: "111111",
      claimTokenHash: "h2",
      now: T0 + 3 * MINUTE,
    });
    expectCoreError(
      () => core.join(joinInput({ inviteId: "invite-2", now: T0 + 4 * MINUTE })),
      "too-many-devices",
    );
  });
});

describe("HostCore daily allowance", () => {
  it("limits on committed plus pending usage and resets at UTC midnight", () => {
    const core = makeHost({ ...DEFAULT_HOST_CORE_LIMITS, dailyAwakeSeconds: 30 });
    core.commitUsage(T0, { messages: 2, awakeSeconds: 20 });
    expect(core.usage(T0)).toMatchObject({ messages: 2, awakeSeconds: 20, limited: false });
    // Tallies still held on sockets count toward the limit before they're committed.
    expect(core.isLimited(T0, { messages: 1, awakeSeconds: 10 })).toBe(true);

    const tomorrow = Date.UTC(2026, 9, 4, 0, 0, 1);
    expect(core.usage(tomorrow)).toMatchObject({ messages: 0, awakeSeconds: 0, limited: false });
  });

  it("keeps committed usage when the object wakes up again", () => {
    const sql = makeTestSql();
    const first = new HostCore(sql, DEFAULT_HOST_CORE_LIMITS, T0);
    first.commitUsage(T0, { messages: 40, awakeSeconds: 30 });
    // A hibernated Durable Object comes back as a new instance over the same storage.
    const woken = new HostCore(sql, DEFAULT_HOST_CORE_LIMITS, T0 + MINUTE);
    expect(woken.usage(T0 + MINUTE)).toMatchObject({ messages: 40, awakeSeconds: 30 });
  });
});

describe("HostCore hooks", () => {
  const KEY = "host-hook-public-key";
  const HOUR = 60 * MINUTE;

  function hostWithHook(limits = DEFAULT_HOST_CORE_LIMITS) {
    const core = makeHost(limits);
    core.mintHook({ hookId: "hook-1", revision: 1, publicKey: KEY, keptHeaders: [], now: T0 });
    return core;
  }

  function deliver(core: HostCore, deliveryId: string, sealed: string, now = T0 + MINUTE) {
    return core.storeHookDelivery({ deliveryId, hookId: "hook-1", sealed, now });
  }

  const handedOver = (effects: ReadonlyArray<HostEffect>) =>
    effects.flatMap((effect) =>
      effect.type === "control" && effect.event.type.startsWith("hook.") ? [effect.event.type] : [],
    );

  it("applies hook changes only in revision order", () => {
    const core = hostWithHook();
    const active = [{ hookId: "hook-1", keptHeaders: ["x-custom"] }];
    expect(core.setHooks({ revision: 3, publicKey: KEY, active, now: T0 })).toEqual({
      applied: true,
      revision: 3,
    });
    // A late, older state can't retire a hook, and a late mint can't add one.
    expect(core.setHooks({ revision: 2, publicKey: KEY, active: [], now: T0 })).toEqual({
      applied: false,
      revision: 3,
    });
    expect(
      core.mintHook({ hookId: "hook-2", revision: 3, publicKey: KEY, keptHeaders: [], now: T0 }),
    ).toEqual({ applied: false, revision: 3 });
    expect(core.admitHookDelivery({ hookId: "hook-1", now: T0 })).toMatchObject({
      ok: true,
      keptHeaders: ["x-custom"],
    });
    expect(core.admitHookDelivery({ hookId: "hook-2", now: T0 })).toMatchObject({ status: 404 });

    // Hooks it never minted are ignored; unnamed ones are retired at once.
    core.setHooks({
      revision: 4,
      publicKey: KEY,
      active: [{ hookId: "made-up", keptHeaders: [] }],
      now: T0,
    });
    expect(core.admitHookDelivery({ hookId: "made-up", now: T0 })).toMatchObject({ status: 404 });
    expect(core.admitHookDelivery({ hookId: "hook-1", now: T0 })).toMatchObject({ status: 404 });
  });

  it("refuses deliveries past the daily allowance or a full queue", () => {
    const core = hostWithHook({
      ...DEFAULT_HOST_CORE_LIMITS,
      dailyHooks: 3,
      maxPendingHookDeliveries: 2,
    });
    expect(deliver(core, "d1", "sealed-1").result.ok).toBe(true);
    expect(deliver(core, "d2", "sealed-2").result.ok).toBe(true);
    expect(deliver(core, "d3", "sealed-3").result).toMatchObject({
      ok: false,
      status: 429,
      reason: "queue-full",
    });
    core.ackHookDeliveries(["d1", "d2"]);
    expect(deliver(core, "d4", "sealed-4").result.ok).toBe(true);
    const refused = core.admitHookDelivery({ hookId: "hook-1", now: T0 + 2 * MINUTE });
    expect(refused).toMatchObject({ ok: false, status: 429, reason: "daily-limit" });
    // Retry-After points at UTC midnight, when the allowance resets.
    expect(refused.ok ? 0 : refused.retryAfterSeconds).toBe(12 * 60 * 60 - 2 * 60);
    expect(core.usage(T0 + 2 * MINUTE)).toMatchObject({ hooks: 3, hookLimit: 3, messages: 3 });
    expect(core.admitHookDelivery({ hookId: "hook-1", now: Date.UTC(2026, 9, 4, 0, 1) }).ok).toBe(
      true,
    );
  });

  it("counts deliveries against the daily message allowance too", () => {
    const core = hostWithHook({ ...DEFAULT_HOST_CORE_LIMITS, dailyMessages: 10 });
    core.commitUsage(T0, { messages: 9, awakeSeconds: 0 });
    expect(deliver(core, "d1", "sealed-1").result.ok).toBe(true);
    expect(core.admitHookDelivery({ hookId: "hook-1", now: T0 + MINUTE })).toMatchObject({
      reason: "daily-limit",
    });
  });

  it("hands small deliveries over whole and announces large ones", () => {
    const core = hostWithHook();
    const small = deliver(core, "small", "s".repeat(100));
    expect(handedOver(small.effects)).toEqual(["hook.delivery"]);
    const large = deliver(core, "large", "l".repeat(RELAY_HOOK_INLINE_SEALED_BYTES + 1));
    expect(handedOver(large.effects)).toEqual(["hook.pending"]);
    expect(large.effects).toContainEqual({
      type: "control",
      event: expect.objectContaining({
        type: "hook.pending",
        deliveryId: "large",
        size: RELAY_HOOK_INLINE_SEALED_BYTES + 1,
      }),
    });
    expect(core.hookDelivery("large")?.sealed.length).toBe(RELAY_HOOK_INLINE_SEALED_BYTES + 1);
  });

  it("replays unacknowledged deliveries oldest first, within an inline budget", () => {
    const core = hostWithHook();
    deliver(core, "first", "a".repeat(400), T0 + MINUTE);
    deliver(core, "second", "b".repeat(400), T0 + 2 * MINUTE);
    deliver(core, "third", "c".repeat(400), T0 + 3 * MINUTE);
    core.ackHookDeliveries(["second"]);

    const replay = core.hookReplay(T0 + 4 * MINUTE, 500);
    expect(
      replay.map((event) => [event.type, "delivery" in event ? event.delivery.deliveryId : ""]),
    ).toEqual([
      ["hook.delivery", "first"],
      ["hook.pending", ""],
    ]);
    expect(replay[1]).toMatchObject({ deliveryId: "third", size: 400 });
    expect(core.hookDelivery("second")).toBeNull();
  });

  it("drops deliveries after a day and retired hooks a day and an hour after retiring", () => {
    const core = hostWithHook();
    deliver(core, "old", "sealed", T0);
    core.setHooks({ revision: 2, publicKey: KEY, active: [], now: T0 + HOUR });
    core.expireDue(T0 + HOUR); // the test host's open invite
    expect(core.nextDeadline()).toBe(T0 + RELAY_HOOK_HOLD_MS);

    core.expireDue(T0 + RELAY_HOOK_HOLD_MS);
    expect(core.hookDelivery("old")).toBeNull();
    // The retired hook's row is kept, so it can still be named active again.
    expect(core.nextDeadline()).toBe(T0 + HOUR + RETIRED_HOOK_KEEP_MS);
    core.expireDue(T0 + HOUR + RETIRED_HOOK_KEEP_MS);
    core.setHooks({
      revision: 3,
      publicKey: KEY,
      active: [{ hookId: "hook-1", keptHeaders: [] }],
      now: T0 + 2 * RELAY_HOOK_HOLD_MS,
    });
    expect(
      core.admitHookDelivery({ hookId: "hook-1", now: T0 + 2 * RELAY_HOOK_HOLD_MS }),
    ).toMatchObject({ status: 404 });
  });
});

describe("CodeShardCore", () => {
  it("keeps live codes unique and only lets the owning invite release them", () => {
    const shard = new CodeShardCore(makeTestSql());
    const live = { code: "482913", hostId: "h1", inviteId: "i1", expiresAt: T0 + 10 * MINUTE };
    expect(shard.claim({ ...live, now: T0 })).toBe(true);
    expect(shard.claim({ ...live, hostId: "h2", inviteId: "i2", now: T0 })).toBe(false);

    shard.release({ code: "482913", hostId: "h2", inviteId: "i2" });
    expect(shard.lookup("482913", T0)).toEqual({ hostId: "h1", inviteId: "i1" });

    // Expired codes can be reallocated, and the old owner's late release can't free the new one.
    expect(
      shard.claim({
        ...live,
        hostId: "h2",
        inviteId: "i2",
        now: T0 + 11 * MINUTE,
        expiresAt: T0 + 30 * MINUTE,
      }),
    ).toBe(true);
    shard.release({ code: "482913", hostId: "h1", inviteId: "i1" });
    expect(shard.lookup("482913", T0 + 12 * MINUTE)).toEqual({ hostId: "h2", inviteId: "i2" });
  });
});

describe("LedgerCore", () => {
  it("turns busy at the daily budget and caps registrations per IP", () => {
    const sql = makeTestSql();
    const limits = { dailyMessageBudget: 100, registrationsPerIpPerDay: 2, dailyAlertBudget: 2 };
    const ledger = new LedgerCore(sql, limits, T0);
    expect(ledger.report(60, T0).busy).toBe(false);
    // An idle ledger can be evicted between reports; nothing reported is lost.
    const woken = new LedgerCore(sql, limits, T0 + 2 * MINUTE);
    expect(woken.report(40, T0 + 2 * MINUTE).busy).toBe(true);

    expect(woken.allowRegistration("ip", T0)).toBe(true);
    expect(woken.allowRegistration("ip", T0)).toBe(true);
    expect(woken.allowRegistration("ip", T0)).toBe(false);
    expect(woken.allowRegistration("ip", Date.UTC(2026, 9, 4, 1))).toBe(true);
  });

  it("caps push alerts relay-wide per day, across evictions", () => {
    const sql = makeTestSql();
    const limits = { dailyMessageBudget: 100, registrationsPerIpPerDay: 2, dailyAlertBudget: 2 };
    expect(new LedgerCore(sql, limits, T0).chargeAlert(T0)).toBe(true);
    const woken = new LedgerCore(sql, limits, T0 + MINUTE);
    expect(woken.chargeAlert(T0 + MINUTE)).toBe(true);
    expect(woken.chargeAlert(T0 + 2 * MINUTE)).toBe(false);
    expect(woken.chargeAlert(Date.UTC(2026, 9, 4, 1))).toBe(true);
  });
});

describe("push alerts", () => {
  const DAY = 24 * 60 * MINUTE;
  const kinds = { needs_you: true, finished: false, failed: true };

  function phoneWithPush(limits = DEFAULT_HOST_CORE_LIMITS) {
    const core = makeHost(limits);
    const input = joinInput();
    const joined = core.join(input);
    core.decide({ requestId: joined.result.requestId, decision: "approve", now: T0 + 2 * MINUTE });
    const deviceId = input.fresh.deviceId;
    core.setDevicePush({
      deviceId,
      registrationId: "registration-1",
      endpoint: "https://web.push.apple.com/QGuQyavXutnMsuIk8Z0f",
      keyId: "key-nightly",
      kinds,
      now: T0 + 3 * MINUTE,
    });
    return { core, deviceId };
  }

  it("sends only the alerts the phone wants, to the subscription it registered last", () => {
    const { core, deviceId } = phoneWithPush();
    const admit = (kind: "needs_you" | "finished" | "failed" | "test", registrationId: string) =>
      core.admitAlert({ deviceId, registrationId, kind, now: T0 + 4 * MINUTE });

    expect(admit("needs_you", "registration-1")).toEqual({
      decision: "send",
      endpoint: "https://web.push.apple.com/QGuQyavXutnMsuIk8Z0f",
      keyId: "key-nightly",
    });
    expect(admit("finished", "registration-1")).toEqual({ decision: "muted" });
    // The test alert from Settings goes out whatever the switches say.
    expect(admit("test", "registration-1").decision).toBe("send");

    core.setDevicePush({
      deviceId,
      registrationId: "registration-2",
      endpoint: "https://web.push.apple.com/a-new-subscription",
      keyId: "key-nightly",
      kinds: { ...kinds, finished: true },
      now: T0 + 5 * MINUTE,
    });
    // An alert sealed for the old subscription can't reach the new one.
    expect(admit("failed", "registration-1")).toEqual({ decision: "stale" });
    expect(admit("finished", "registration-2").decision).toBe("send");
  });

  it("stops a removed phone's alerts and won't take its subscription again", () => {
    const { core, deviceId } = phoneWithPush();
    core.revokeDevice(deviceId, T0 + 10 * MINUTE);

    expect(
      core.admitAlert({
        deviceId,
        registrationId: "registration-1",
        kind: "needs_you",
        now: T0 + 11 * MINUTE,
      }),
    ).toEqual({ decision: "unavailable" });
    expectCoreError(
      () =>
        core.setDevicePush({
          deviceId,
          registrationId: "registration-1",
          endpoint: "https://web.push.apple.com/QGuQyavXutnMsuIk8Z0f",
          keyId: "key-nightly",
          kinds,
          now: T0 + 12 * MINUTE,
        }),
      "forbidden",
    );
  });

  it("forgets a dropped subscription only while it is still the current one", () => {
    const { core, deviceId } = phoneWithPush();
    const admit = (registrationId: string) =>
      core.admitAlert({ deviceId, registrationId, kind: "needs_you", now: T0 + 6 * MINUTE });

    core.forgetDevicePush(deviceId, "registration-0");
    expect(admit("registration-1").decision).toBe("send");
    core.forgetDevicePush(deviceId, "registration-1");
    expect(admit("registration-1")).toEqual({ decision: "unavailable" });
  });

  it("charges each alert before it goes out, and starts a fresh allowance each day", () => {
    const { core, deviceId } = phoneWithPush({
      ...DEFAULT_HOST_CORE_LIMITS,
      dailyAlertsPerDevice: 2,
    });
    const admit = (now: number) =>
      core.admitAlert({ deviceId, registrationId: "registration-1", kind: "failed", now }).decision;

    expect(admit(T0 + 4 * MINUTE)).toBe("send");
    expect(admit(T0 + 5 * MINUTE)).toBe("send");
    expect(admit(T0 + 6 * MINUTE)).toBe("limited");
    expect(admit(T0 + DAY)).toBe("send");
  });
});
