import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { OutsideAgentConnectionId, type PeerOutsideAgent } from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { AssistantsWithoutRelayLive } from "../assistants/AssistantsLive.ts";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
import { OutsideAgentConnections, outsideAgentOrigin } from "./OutsideAgentConnections.ts";
import { OutsideAgentConnectionsLive } from "./OutsideAgentConnectionsLive.ts";
import { type OutsideAgentLink, OutsideAgentLinks } from "./OutsideAgentLinks.ts";
import { OutsideAgentSignIn } from "./OutsideAgentSignIn.ts";

describe("outsideAgentOrigin", () => {
  const local = { port: 3773, remoteAddress: "127.0.0.1", headers: {} };

  it("takes this computer's loopback names on the server's port", () => {
    assert.strictEqual(
      outsideAgentOrigin({ ...local, host: "127.0.0.1:3773" }),
      "http://127.0.0.1:3773",
    );
    assert.strictEqual(
      outsideAgentOrigin({ ...local, host: "LOCALHOST:3773", remoteAddress: "::1" }),
      "http://localhost:3773",
    );
    assert.strictEqual(outsideAgentOrigin({ ...local, host: "[::1]:3773" }), "http://[::1]:3773");
  });

  it("refuses anything that didn't come from this computer", () => {
    // A LAN client reaching a network-exposed server, claiming loopback.
    assert.isNull(
      outsideAgentOrigin({ ...local, host: "127.0.0.1:3773", remoteAddress: "192.168.1.20" }),
    );
    // Tailscale Serve connects from loopback on someone else's behalf.
    assert.isNull(
      outsideAgentOrigin({
        ...local,
        host: "127.0.0.1:3773",
        headers: { "tailscale-user-login": "someone@example.com" },
      }),
    );
    assert.isNull(
      outsideAgentOrigin({
        ...local,
        host: "127.0.0.1:3773",
        headers: { "x-forwarded-for": "1.2.3.4" },
      }),
    );
    // A DNS-rebinding page, another port, no Host, an unknown socket.
    assert.isNull(outsideAgentOrigin({ ...local, host: "evil.example:3773" }));
    assert.isNull(outsideAgentOrigin({ ...local, host: "127.0.0.1:3774" }));
    assert.isNull(outsideAgentOrigin({ ...local, host: undefined }));
    assert.isNull(
      outsideAgentOrigin({ ...local, host: "127.0.0.1:3773", remoteAddress: undefined }),
    );
  });
});

describe("agents from linked computers", () => {
  const MAC: OutsideAgentLink = {
    deviceId: "device-mac",
    environmentId: "env-mac",
    computer: "Mac",
  };
  const grok: PeerOutsideAgent = {
    connectionId: OutsideAgentConnectionId.make("connection-on-mac"),
    name: "Grok Bot",
    givenName: "Cursor",
    assistant: "grok-bot",
    kind: "assistant",
    access: "start",
    maxRuntimeMode: "auto",
  };
  const services = Layer.build(
    OutsideAgentConnectionsLive.pipe(
      Layer.provide(AssistantsWithoutRelayLive),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provide(ServerSecretStoreLive),
      Layer.provide(
        Layer.succeed(AnalyticsService, { record: () => Effect.void, flush: Effect.void }),
      ),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "outside-agents-linked-test-" }),
      ),
    ),
  );

  it.effect(
    "asks the user here, allows no more than it has there, runs its calls as its row, and lets it go",
    () =>
      Effect.gen(function* () {
        const context = yield* services;
        const links = Context.get(context, OutsideAgentLinks);
        const signIn = Context.get(context, OutsideAgentSignIn);
        const connections = Context.get(context, OutsideAgentConnections);
        const snapshot = signIn.changes.pipe(Stream.runHead, Effect.map(Option.getOrThrow));

        assert.deepStrictEqual(yield* links.ask(MAC, grok), { status: "asked" });
        const [ask] = (yield* snapshot).linkedAsks;
        assert.strictEqual(ask?.fromComputer, "Mac");
        assert.strictEqual(ask?.requestedAccess, "start");
        // Not before the user allows it here.
        assert.isTrue("refused" in (yield* links.callerFor(MAC, grok)));

        const grant = { maxRuntimeMode: "auto" as const, projectIds: null };
        const tooMuch = yield* signIn
          .approve({ requestId: ask!.requestId, access: "work", ...grant })
          .pipe(Effect.flip);
        assert.include(tooMuch.detail, "can't do more here than it can on Mac");
        const allowed = yield* signIn.approve({
          requestId: ask!.requestId,
          access: "start",
          ...grant,
        });
        assert.deepStrictEqual(allowed.via, {
          environmentId: "env-mac",
          computer: "Mac",
          connectionId: grok.connectionId,
        });
        assert.strictEqual(allowed.name, "Grok Bot");
        assert.deepStrictEqual(yield* links.ask(MAC, grok), { status: "allowed" });

        // Its calls run as the row here, capped by what it has there now.
        const linked = yield* links.callerFor(MAC, { ...grok, access: "see" });
        assert.isFalse("refused" in linked);
        if (!("refused" in linked)) {
          assert.strictEqual(linked.caller.connectionId, allowed.connectionId);
          assert.deepStrictEqual(linked.cap, {
            connectionId: allowed.connectionId,
            access: "see",
            maxRuntimeMode: "auto",
          });
          assert.isTrue((yield* connections.grant(allowed.connectionId))?.linked === true);
        }
        // Another link's call for the same agent finds nothing.
        assert.isTrue(
          "refused" in (yield* links.callerFor({ ...MAC, deviceId: "device-other" }, grok)),
        );

        yield* links.forget(MAC, grok.connectionId);
        assert.isNull(yield* connections.grant(allowed.connectionId));
        assert.deepStrictEqual(yield* links.status(MAC, [grok.connectionId]), { entries: [] });

        // A removed link takes what it brought, and its asks.
        yield* links.ask(MAC, grok);
        const [again] = (yield* snapshot).linkedAsks;
        const back = yield* signIn.approve({
          requestId: again!.requestId,
          access: "see",
          ...grant,
        });
        yield* links.ask(MAC, { ...grok, connectionId: OutsideAgentConnectionId.make("other") });
        yield* links.dropLink(MAC.deviceId);
        assert.isNull(yield* connections.grant(back.connectionId));
        assert.deepStrictEqual((yield* snapshot).linkedAsks, []);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
