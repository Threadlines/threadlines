import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";

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

  it.effect("keeps an outside agent's token and sign-in secrets out of traces and logs", () =>
    Effect.gen(function* () {
      const AGENT_TOKEN = `tlc1.connection-1.1.${"a".repeat(43)}`;
      const POLL_SECRET = "poll-secret-that-must-never-be-traced-000000";
      const lines: Array<string> = [];
      const capture = Logger.make(({ message, fiber }) => {
        lines.push(
          JSON.stringify({
            message,
            annotations: fiber.getRef(References.CurrentLogAnnotations),
          }),
        );
      });
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            spans.push(span);
          };
          return span;
        },
      });
      // Stand-ins for `/mcp/connect` and the waiting page's poll: what matters
      // is what the server's own logger and tracer record around them.
      const routes = Layer.mergeAll(
        HttpRouter.add("POST", "/mcp/connect", Effect.succeed(HttpServerResponse.text("ok"))),
        HttpRouter.add(
          "GET",
          "/oauth/authorize/status",
          Effect.succeed(HttpServerResponse.text("{}")),
        ),
      );
      yield* HttpRouter.serve(routes.pipe(Layer.provide(browserApiCorsLayer)), {
        middleware: requestPrivacy(true),
      }).pipe(
        Layer.provide(requestTracingPrivacyLayer),
        Layer.provide(Layer.succeed(Tracer.Tracer, tracer)),
        Layer.provide(Logger.layer([capture], { mergeWithExisting: false })),
        Layer.build,
      );
      const server = yield* HttpServer.HttpServer;
      const origin = `http://127.0.0.1:${(server.address as HttpServer.TcpAddress).port}`;
      const connect = yield* Effect.promise(() =>
        fetch(`${origin}/mcp/connect`, {
          method: "POST",
          headers: { authorization: `Bearer ${AGENT_TOKEN}` },
          body: "{}",
        }),
      );
      assert.equal(connect.status, 200);
      const poll = yield* Effect.promise(() =>
        fetch(`${origin}/oauth/authorize/status?request=r&poll=${POLL_SECRET}`),
      );
      assert.equal(poll.status, 200);
      // The tracer ends a request's span just after the response goes out.
      for (let attempt = 0; attempt < 50 && spans.length === 0; attempt++) {
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
      }

      const connectSpan = spans.find((span) => span.attributes.get("url.path") === "/mcp/connect");
      assert.isDefined(connectSpan);
      assert.equal(
        String(connectSpan?.attributes.get("http.request.header.authorization")),
        "<redacted>",
      );
      assert.isFalse(
        spans.some((span) => String(span.attributes.get("url.path")).startsWith("/oauth")),
      );
      const recorded = [
        ...lines,
        ...spans.map((span) =>
          JSON.stringify([...span.attributes].map(([key, value]) => [key, String(value)])),
        ),
      ];
      for (const entry of recorded) {
        assert.notInclude(entry, AGENT_TOKEN);
        assert.notInclude(entry, POLL_SECRET);
      }
    }).pipe(
      Effect.provide(NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0 })),
      Effect.scoped,
    ),
  );
});
