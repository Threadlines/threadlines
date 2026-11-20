// @effect-diagnostics nodeBuiltinImport:off - a stable session name from a sha256
/**
 * Where agent-device finds this server's daemon, and the session each thread
 * drives a device through (docs/design/devices.md). Ported from T3 Code's
 * AgentDeviceTarget, with one host per server.
 */
import { createHash } from "node:crypto";

import { DeviceOperationError } from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import type { AgentDeviceEndpoint } from "./DeviceHost.ts";
import { deviceStateDir } from "./DeviceToolchain.ts";

const encodeEndpoint = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      daemonBaseUrl: Schema.String,
      daemonAuthToken: Schema.String,
    }),
  ),
);

const key = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

/** The config file every launcher points agent-device at: the daemon's address and token. */
export const agentDeviceConfigPath = (path: Path.Path, stateDir: string) =>
  path.join(deviceStateDir(path, stateDir), "agent-device.json");

/** One agent-device session per thread and device, named so it never collides across them. */
export const agentDeviceSession = (threadId: string, deviceId: string): string =>
  `tl-${key(JSON.stringify([threadId, deviceId]))}`;

/** Writes the daemon's address and token where launchers read it, readable by this user only. */
export const writeAgentDeviceConfig = Effect.fn("AgentDeviceTarget.writeConfig")(function* (
  file: string,
  endpoint: Pick<AgentDeviceEndpoint, "baseUrl" | "token">,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  const content = yield* encodeEndpoint({
    daemonBaseUrl: endpoint.baseUrl,
    daemonAuthToken: endpoint.token,
  });
  if ((yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))) === content) return;
  const temporary = yield* fs.makeTempFile({ directory: path.dirname(file), prefix: ".endpoint-" });
  yield* Effect.gen(function* () {
    yield* fs.chmod(temporary, 0o600);
    yield* fs.writeFileString(temporary, content);
    yield* fs.rename(temporary, file);
  }).pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
});

const AgentCloseResult = Schema.Union([
  Schema.Struct({ result: Schema.Struct({ ok: Schema.Literal(true) }) }),
  Schema.Struct({
    error: Schema.Struct({
      data: Schema.Struct({ code: Schema.Literal("SESSION_NOT_FOUND") }),
    }),
  }),
]);

/**
 * Ends an agent-device session on a running daemon, which quits the app that
 * session opened and releases its claim on the device. An already-released
 * session succeeds.
 */
export const releaseAgentDeviceSession =
  (http: HttpClient.HttpClient, endpoint: Pick<AgentDeviceEndpoint, "baseUrl" | "token">) =>
  (session: string) =>
    HttpClientRequest.post(`${endpoint.baseUrl}/rpc`).pipe(
      HttpClientRequest.bearerToken(endpoint.token),
      HttpClientRequest.bodyJson({
        jsonrpc: "2.0",
        id: session,
        method: "agent_device.command",
        params: { command: "close", session, positionals: [], flags: {} },
      }),
      Effect.flatMap((request) => http.pipe(HttpClient.withScope).execute(request)),
      // agent-device reports an already-released session as HTTP 404.
      Effect.filterOrElse((response) => response.status === 404, HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(AgentCloseResult)),
      Effect.scoped,
      Effect.timeout(Duration.seconds(15)),
      Effect.asVoid,
      Effect.mapError(
        () => new DeviceOperationError({ operation: "close", reason: "request_failed" }),
      ),
    );
