/**
 * Event tasks on this computer's own port (docs/design/event-tasks.md,
 * "Directly, without the relay"): `POST /api/hooks/{taskId}/{localToken}`,
 * for senders that can reach the computer (a script here, a CI runner on the
 * network, a tunnel). No session sign-in: the 32-byte token in the path is
 * the sign-in, checked in constant time before the body is read. The body is
 * capped at 1 MiB and each task takes 60 requests a minute. The path is a
 * credential: httpRequestPrivacy keeps it out of the server's logs and
 * traces, for this route and anything else answering the same path.
 */
import { RELAY_HOOK_MAX_BODY_BYTES } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import { ScheduledTasks } from "./ScheduledTasks.ts";

export const LOCAL_HOOK_ROUTE = "/api/hooks/:taskId/:token";

/** Methods a sender may use, as through the relay. */
const METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH"]);

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (!METHODS.has(request.method)) return HttpServerResponse.empty({ status: 405 });
  const params = yield* HttpRouter.params;
  const scheduledTasks = yield* ScheduledTasks;
  const declared = request.headers["content-length"];
  const contentLength = declared !== undefined && /^\d+$/.test(declared) ? Number(declared) : null;
  const queryAt = request.url.indexOf("?");
  const status = yield* scheduledTasks.receiveLocalEvent({
    taskId: params.taskId ?? "",
    token: params.token ?? "",
    method: request.method,
    query: queryAt === -1 ? "" : request.url.slice(queryAt + 1),
    headers: request.headers,
    contentLength,
    readBody: request.arrayBuffer.pipe(
      Effect.map((buffer) => new Uint8Array(buffer)),
      Effect.provideService(
        HttpIncomingMessage.MaxBodySize,
        FileSystem.Size(RELAY_HOOK_MAX_BODY_BYTES),
      ),
      Effect.mapError(() => "too_large" as const),
    ),
  });
  return status === 202
    ? HttpServerResponse.jsonUnsafe({ accepted: true }, { status: 202 })
    : HttpServerResponse.empty({ status });
});

/** Every method lands here, so none falls through to a logged "not found" with the token. */
export const localHookRouteLayer = HttpRouter.add("*", LOCAL_HOOK_ROUTE, handler);
