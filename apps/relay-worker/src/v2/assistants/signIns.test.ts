import {
  ASSISTANT_SIGN_IN_TTL_MS,
  type RelayAssistantSignIn,
} from "@threadlines/contracts/relayAssistants";
import { describe, expect, it } from "vite-plus/test";

import { makeTestSql } from "../testSql.ts";
import { AssistantCodeShardCore } from "./codes.ts";
import { AssistantHostCore, MAX_REVOKED_CONNECTIONS } from "./hostAssistants.ts";
import {
  MAX_PENDING_SIGN_INS_PER_IP,
  type NewSignIn,
  redirectWithParams,
  SignInCore,
  typeAssistantCode,
} from "./signIns.ts";

const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);
const ORIGIN = "https://connect.test";
const HOST = "8911ad8a-f546-45e5-a2e8-7a6a8adfc65c";
const CODE = "K4D82PQX";

function newSignIn(signInId: string, overrides: Partial<NewSignIn> = {}): NewSignIn {
  return {
    signInId,
    ipHash: "ip-hash-1",
    pageSecretHash: `page-${signInId}`,
    clientId: "https://claude.ai/oauth/client.json",
    clientName: "Claude",
    identity: { kind: "cimd", host: "claude.ai", known: true },
    redirectUri: "https://claude.ai/api/mcp/auth_callback?tenant=a%20b",
    oauthState: "state-123",
    codeChallenge: "c".repeat(43),
    scopes: ["threads:read", "threads:start"],
    resource: `${ORIGIN}/mcp`,
    issuer: ORIGIN,
    place: { city: "Austin", country: "US" },
    ...overrides,
  };
}

/** One sign-in shard, one code shard and one computer, wired the way the objects are. */
function makeWorld() {
  let now = T0;
  const signIns = new SignInCore(makeTestSql());
  const codes = new AssistantCodeShardCore(makeTestSql());
  const host = new AssistantHostCore(makeTestSql());
  const handed: RelayAssistantSignIn[] = [];
  const deps = {
    takeCode: async (code: string) => codes.take(code, now),
    // What RelayHost.beginAssistantSignIn does.
    handToHost: async (hostId: string, signIn: RelayAssistantSignIn, code: string) => {
      expect(hostId).toBe(HOST);
      if (!host.claimCode(code, now)) throw new Error("That code was cancelled or replaced.");
      host.addSignIn(signIn);
      handed.push(signIn);
    },
    now: () => now,
  };
  /** What `POST .../assistants/code` does: one live code per computer. */
  const mintCode = (code: string) => {
    expect(
      codes.claim({ code, hostId: HOST, expiresAt: now + ASSISTANT_SIGN_IN_TTL_MS, now }),
    ).toBe(true);
    const replaced = host.setCode(code, now + ASSISTANT_SIGN_IN_TTL_MS);
    if (replaced) codes.release({ code: replaced, hostId: HOST });
  };
  const type = (signInId: string, code: string) =>
    typeAssistantCode(signIns, deps, { signInId, pageSecretHash: `page-${signInId}`, code });
  return {
    signIns,
    codes,
    host,
    handed,
    deps,
    mintCode,
    type,
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}

describe("assistant sign-ins before a computer is known", () => {
  it("waits in its shard for a code, readable only with its page's secret", () => {
    const { signIns } = makeWorld();
    expect(signIns.create(newSignIn("1.a"), T0)).toEqual({
      ok: true,
      expiresAt: T0 + ASSISTANT_SIGN_IN_TTL_MS,
    });
    expect(signIns.status("1.a", "page-1.a", T0)).toEqual({
      state: "waiting-for-code",
      triesLeft: 3,
    });
    expect(signIns.status("1.a", "someone-else", T0)).toEqual({ state: "unknown" });
  });

  it("lets at most 10 wait per network", () => {
    const { signIns } = makeWorld();
    for (let index = 0; index < MAX_PENDING_SIGN_INS_PER_IP; index += 1) {
      expect(signIns.create(newSignIn(`1.${index}`), T0).ok).toBe(true);
    }
    expect(signIns.create(newSignIn("1.extra"), T0).ok).toBe(false);
    expect(signIns.create(newSignIn("1.other", { ipHash: "ip-hash-2" }), T0).ok).toBe(true);
    // Once one has timed out, another may start.
    expect(signIns.create(newSignIn("1.later"), T0 + ASSISTANT_SIGN_IN_TTL_MS).ok).toBe(true);
  });
});

describe("typing the app's code into the page", () => {
  it("binds only the sign-in whose page typed it, and uses the code up", async () => {
    const world = makeWorld();
    world.signIns.create(newSignIn("1.mine"), T0);
    world.signIns.create(newSignIn("1.other"), T0);
    world.mintCode(CODE);

    expect(await world.type("1.mine", "k4d8-2pqx")).toEqual({
      status: { state: "waiting-for-approval" },
    });
    expect(world.handed.map((signIn) => signIn.signInId)).toEqual(["1.mine"]);
    expect(world.handed[0]).toMatchObject({
      clientName: "Claude",
      identity: { kind: "cimd", host: "claude.ai", known: true },
      resource: `${ORIGIN}/mcp`,
      issuer: ORIGIN,
      place: { city: "Austin", country: "US" },
    });
    expect(world.host.signIns(world.now()).map((signIn) => signIn.signInId)).toEqual(["1.mine"]);
    expect(world.host.code(world.now())).toBeNull();

    // The other page can't reuse it, and isn't bound to anything.
    expect(await world.type("1.other", CODE)).toEqual({
      status: { state: "waiting-for-code", triesLeft: 2 },
      mismatch: true,
    });
    expect(world.signIns.status("1.other", "page-1.other", world.now()).state).toBe(
      "waiting-for-code",
    );
  });

  it("gives each sign-in 3 tries, malformed codes included", async () => {
    const world = makeWorld();
    world.signIns.create(newSignIn("1.a"), T0);
    world.mintCode(CODE);
    expect(await world.type("1.a", "AAAAAAAA")).toEqual({
      status: { state: "waiting-for-code", triesLeft: 2 },
      mismatch: true,
    });
    expect(await world.type("1.a", "short")).toEqual({
      status: { state: "waiting-for-code", triesLeft: 1 },
      mismatch: true,
    });
    expect(await world.type("1.a", "BBBBBBBB")).toEqual({
      status: { state: "over" },
      mismatch: true,
    });
    // Even the right code is too late now, and it stays the computer's.
    expect(await world.type("1.a", CODE)).toEqual({ status: { state: "over" } });
    expect(world.handed).toEqual([]);
    expect(world.codes.take(CODE, world.now())).toBe(HOST);
  });

  it("checks one code at a time per sign-in, and gives the try back when the relay fails", async () => {
    const world = makeWorld();
    world.signIns.create(newSignIn("1.a"), T0);
    let release: (hostId: string | null) => void = () => undefined;
    const slow = typeAssistantCode(
      world.signIns,
      { ...world.deps, takeCode: () => new Promise((resolve) => (release = resolve)) },
      { signInId: "1.a", pageSecretHash: "page-1.a", code: CODE },
    );
    expect(await world.type("1.a", CODE)).toMatchObject({ busy: true });
    release(null);
    expect(await slow).toMatchObject({ status: { triesLeft: 2 }, mismatch: true });

    const failing = await typeAssistantCode(
      world.signIns,
      {
        ...world.deps,
        takeCode: async () => {
          throw new Error("shard unavailable");
        },
      },
      { signInId: "1.a", pageSecretHash: "page-1.a", code: CODE },
    );
    expect(failing).toEqual({
      status: { state: "waiting-for-code", triesLeft: 2 },
      unavailable: true,
    });
  });

  it("starts nothing with a code the computer replaced before its shard heard", async () => {
    const world = makeWorld();
    world.signIns.create(newSignIn("1.a"), T0);
    world.mintCode(CODE);
    // The replacement's release to the old code's shard is late (or failed).
    world.host.setCode("ZZZZ1111", world.now() + ASSISTANT_SIGN_IN_TTL_MS);
    expect(await world.type("1.a", CODE)).toMatchObject({ status: { state: "failed" } });
    expect(world.handed).toEqual([]);
  });

  it("keeps one live code per computer: a new one replaces the old", () => {
    const world = makeWorld();
    world.mintCode(CODE);
    world.mintCode("ZZZZ1111");
    expect(world.host.code(world.now())?.code).toBe("ZZZZ1111");
    expect(world.codes.take(CODE, world.now())).toBeNull();
    expect(world.codes.take("ZZZZ1111", world.now())).toBe(HOST);
  });
});

describe("the computer's decision", () => {
  async function approvalWaiting() {
    const world = makeWorld();
    world.signIns.create(newSignIn("1.a"), T0);
    world.mintCode(CODE);
    await world.type("1.a", CODE);
    return world;
  }

  it("sends the page back with code, state and iss, after the registered query", async () => {
    const world = await approvalWaiting();
    const code = "tlac1.authorization-code";
    expect(
      world.signIns.decide(
        { signInId: "1.a", hostId: HOST, decision: "allow", authorizationCode: code },
        world.now(),
      ),
    ).toBe("applied");
    expect(world.signIns.status("1.a", "page-1.a", world.now())).toEqual({
      state: "done",
      redirectUrl: `https://claude.ai/api/mcp/auth_callback?tenant=a%20b&code=${code}&state=state-123&iss=${encodeURIComponent(ORIGIN)}`,
    });
  });

  it("takes the same decision again after a lost reply, and no other", async () => {
    const world = await approvalWaiting();
    const allow = {
      signInId: "1.a",
      hostId: HOST,
      decision: "allow" as const,
      authorizationCode: "tlac1.authorization-code",
    };
    expect(world.signIns.decide(allow, world.now())).toBe("applied");
    expect(world.signIns.decide(allow, world.now())).toBe("applied");
    expect(
      world.signIns.decide({ signInId: "1.a", hostId: HOST, decision: "deny" }, world.now()),
    ).toBe("gone");
  });

  it("says access_denied on deny, and only the computer it was handed to can decide", async () => {
    const world = await approvalWaiting();
    expect(
      world.signIns.decide({ signInId: "1.a", hostId: "another-host", decision: "deny" }, T0),
    ).toBe("gone");
    expect(world.signIns.decide({ signInId: "1.a", hostId: HOST, decision: "deny" }, T0)).toBe(
      "applied",
    );
    const status = world.signIns.status("1.a", "page-1.a", T0);
    expect(status.state === "done" && new URL(status.redirectUrl).searchParams.get("error")).toBe(
      "access_denied",
    );
  });

  it("times out after 10 minutes: the page says so and the computer hears it's gone", async () => {
    const world = await approvalWaiting();
    world.advance(ASSISTANT_SIGN_IN_TTL_MS);
    world.signIns.expireDue(world.now());
    expect(world.signIns.status("1.a", "page-1.a", world.now())).toEqual({ state: "expired" });
    expect(world.host.expireDue(world.now())).toEqual(["1.a"]);
    expect(world.host.signIns(world.now())).toEqual([]);
    expect(
      world.signIns.decide({ signInId: "1.a", hostId: HOST, decision: "deny" }, world.now()),
    ).toBe("expired");
  });
});

describe("redirectWithParams", () => {
  it("keeps the registered URI byte for byte and appends after any query", () => {
    const params = [
      ["code", "a b"],
      ["state", "x&y"],
    ] as const;
    expect(redirectWithParams("https://app.test/cb", params)).toBe(
      "https://app.test/cb?code=a%20b&state=x%26y",
    );
    expect(redirectWithParams("https://app.test/cb?x=1", params)).toBe(
      "https://app.test/cb?x=1&code=a%20b&state=x%26y",
    );
    expect(redirectWithParams("https://app.test/cb?", params)).toBe(
      "https://app.test/cb?code=a%20b&state=x%26y",
    );
  });
});

describe("removed connections at the relay", () => {
  it("counts a retried removal once, and stops tagging before the list could fill", () => {
    const host = new AssistantHostCore(makeTestSql());
    expect(host.revoke(["c1", "c1", "c2"], T0)).toBe(true);
    expect(host.revoke(["c1", "c2"], T0)).toBe(true);
    expect(host.isRevoked("c2")).toBe(true);
    for (let index = 0; index < MAX_REVOKED_CONNECTIONS - 3; index += 1) {
      host.noteTagged(`live-${index}`);
    }
    expect(host.canTagConnections()).toBe(true);
    host.noteTagged("last");
    expect(host.canTagConnections()).toBe(false);
    // Every tagged connection still fits when it's removed.
    expect(host.revoke(["last", "live-0"], T0)).toBe(true);
  });
});
