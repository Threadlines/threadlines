import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RELAY_HOOK_MAX_BODY_BYTES } from "@threadlines/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { ScheduledTasks } from "./ScheduledTasks.ts";
import { draft, makeComputer, setClock } from "./scheduledTestComputer.ts";
import { localHookRouteLayer } from "./webhookRoute.ts";

it.layer(NodeServices.layer)("event tasks' local address", (it) => {
  it.effect(
    "takes an event with the task's token, refuses a wrong one, and caps the body and the rate",
    () =>
      Effect.gen(function* () {
        const computer = yield* makeComputer;
        yield* setClock("2026-10-20T08:00:00.000Z");
        const service = yield* computer.boot();
        const task = yield* service.create(
          draft({
            name: "Deploys",
            cadence: {
              kind: "webhook",
              source: "any",
              signature: null,
              filters: [],
              includeEvent: true,
              maxLateMinutes: 60,
              dailyRunLimit: 50,
            },
          }),
        );
        const address = yield* service.webhookAddress({ id: task.id });
        const route = new URL(address.localUrl).pathname;
        yield* localHookRouteLayer.pipe(
          HttpRouter.serve,
          Layer.provide(Layer.succeed(ScheduledTasks, service)),
          Layer.build,
        );
        const server = yield* HttpServer.HttpServer;
        const origin = `http://127.0.0.1:${(server.address as HttpServer.TcpAddress).port}`;
        const post = (
          path: string,
          body: string | ReadableStream<Uint8Array>,
          headers: Record<string, string> = {},
        ) =>
          Effect.promise(() =>
            fetch(`${origin}${path}`, {
              method: "POST",
              headers: { "content-type": "application/json", ...headers },
              body,
              ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
            } as RequestInit).then(async (response) => ({
              status: response.status,
              text: await response.text(),
            })),
          );

        const accepted = yield* post(`${route}?ref=main`, '{"deploy": "done"}');
        assert.equal(accepted.status, 202);
        assert.deepEqual(JSON.parse(accepted.text), { accepted: true });
        const [event] = yield* computer.webhooks.listEvents({ taskId: task.id, limit: 10 });
        assert.equal(event?.source, "local");
        assert.equal(event?.query, "ref=main");
        assert.equal(new TextDecoder().decode(event?.body), '{"deploy": "done"}');

        // Only methods a sender uses.
        const read = yield* Effect.promise(() => fetch(`${origin}${route}`));
        assert.equal(read.status, 405);
        // A wrong token, or another task's id, is "not found" alike.
        const wrongToken = route.replace(/[^/]+$/, "A".repeat(43));
        assert.equal((yield* post(wrongToken, "{}")).status, 404);
        assert.equal(
          (yield* post(`/api/hooks/someone-else/${route.split("/").at(-1)}`, "{}")).status,
          404,
        );

        // Over 1 MiB, said up front or not, is refused.
        const big = "x".repeat(RELAY_HOOK_MAX_BODY_BYTES + 1);
        assert.equal((yield* post(route, big)).status, 413);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(big));
            controller.close();
          },
        });
        assert.equal((yield* post(route, stream)).status, 413);
        assert.equal(
          (yield* computer.webhooks.listEvents({ taskId: task.id, limit: 10 })).length,
          1,
        );

        // Sixty a minute, then 429.
        const statuses: Array<number> = [];
        for (let index = 0; index < 60; index += 1) {
          statuses.push((yield* post(route, `{"n": ${index}}`)).status);
        }
        assert.deepEqual(new Set(statuses), new Set([202, 429]));
        assert.equal(statuses.at(-1), 429);
      }).pipe(Effect.provide(NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0 }))),
  );
});
