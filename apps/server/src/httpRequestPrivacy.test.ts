import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { browserApiCorsLayer } from "./http.ts";
import {
  hasSecretPath,
  redactedRequestPath,
  requestPrivacy,
  requestTracingPrivacyLayer,
} from "./httpRequestPrivacy.ts";
import { ScheduledTasks } from "./scheduled/ScheduledTasks.ts";
import { localHookRouteLayer } from "./scheduled/webhookRoute.ts";

const TOKEN = "s3cr3t-token-that-must-never-be-logged-0000000";

describe("request privacy", () => {
  it("finds a credential-carrying path however it is written, and cuts it", () => {
    // Every spelling the router hands to the route.
    for (const url of [
      `/api/hooks/task-1/${TOKEN}`,
      `/api/hooks/task-1/${TOKEN}?ref=main`,
      `/api/hooks/task-1/${TOKEN};x=1`,
      `/api/hook%73/task-1/${TOKEN}`,
      `/API/HOOKS/task-1/${TOKEN}`,
      `/Api/Hooks/task-1/${TOKEN}/`,
      `/api//hooks/task-1/${TOKEN}`,
      `//api///hooks//task-1/${TOKEN}`,
      `http://127.0.0.1:3773/api/hooks/task-1/${TOKEN}`,
    ]) {
      assert.isTrue(hasSecretPath(url), url);
      assert.equal(redactedRequestPath(url), "/api/hooks/…");
    }
    assert.isFalse(hasSecretPath("/api/auth/session"));
    assert.equal(redactedRequestPath("/api/auth/session?x=1"), "/api/auth/session");
  });

  it.effect("never logs an event address's token, not even for a CORS preflight", () =>
    Effect.gen(function* () {
      const lines: Array<string> = [];
      const capture = Logger.make(({ message, fiber }) => {
        lines.push(
          JSON.stringify({
            message,
            annotations: fiber.getRef(References.CurrentLogAnnotations),
          }),
        );
      });
      yield* HttpRouter.serve(localHookRouteLayer.pipe(Layer.provide(browserApiCorsLayer)), {
        middleware: requestPrivacy(true),
      }).pipe(
        Layer.provide(requestTracingPrivacyLayer),
        Layer.provide(
          Layer.mock(ScheduledTasks)({ receiveLocalEvent: () => Effect.succeed(202 as const) }),
        ),
        Layer.provide(Logger.layer([capture], { mergeWithExisting: false })),
        Layer.build,
      );
      const server = yield* HttpServer.HttpServer;
      const origin = `http://127.0.0.1:${(server.address as HttpServer.TcpAddress).port}`;
      const path = `/api/hooks/task-1/${TOKEN}`;
      const preflight = yield* Effect.promise(() =>
        fetch(`${origin}${path}`, {
          method: "OPTIONS",
          headers: {
            origin: "https://example.com",
            "access-control-request-method": "POST",
          },
        }),
      );
      assert.isBelow(preflight.status, 300);
      const posted = yield* Effect.promise(() =>
        fetch(`${origin}${path}?ref=main`, { method: "POST", body: "{}" }),
      );
      assert.equal(posted.status, 202);
      // Spellings the router also routes here: a different case, doubled slashes.
      for (const spelling of [`/API/HOOKS/task-1/${TOKEN}`, `/api//hooks/task-1/${TOKEN}`]) {
        const response = yield* Effect.promise(() =>
          fetch(`${origin}${spelling}`, { method: "POST", body: "{}" }),
        );
        assert.equal(response.status, 202);
      }

      for (const line of lines) assert.notInclude(line, TOKEN);
      const responses = lines.filter((line) => line.includes("Sent HTTP response"));
      assert.equal(responses.length, 4);
      assert.isTrue(responses.every((line) => line.includes('"http.url":"/api/hooks/…"')));
    }).pipe(
      Effect.provide(NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0 })),
      Effect.scoped,
    ),
  );
});
