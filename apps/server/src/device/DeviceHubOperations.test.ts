import * as Http from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient } from "effect/http";

import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";

/** A stand-in hub answering the two listings with fixed JSON. */
const startFakeHub = (routes: Record<string, unknown>) =>
  Effect.acquireRelease(
    Effect.callback<{ origin: string; close: () => void }>((resume) => {
      const server = Http.createServer((request, response) => {
        const body = routes[request.url ?? ""];
        if (body === undefined) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resume(Effect.succeed({ origin: `http://127.0.0.1:${port}`, close: () => server.close() }));
      });
    }),
    (hub) => Effect.sync(hub.close),
  );

describe("DeviceHubOperations list", () => {
  it.effect("adds simulators that were never booted, once, from serve-sim's grid", () =>
    Effect.gen(function* () {
      const hub = yield* startFakeHub({
        "/api/devices": {
          simulators: [
            {
              id: "AAAA-1",
              name: "iPhone 17",
              version: "iOS 27.2",
              platform: "ios",
              booted: true,
              physical: false,
            },
          ],
          emulators: [],
        },
        "/vendor/serve-sim/grid/api": {
          devices: [
            { device: "aaaa-1", name: "iPhone 17", runtime: "iOS-27-2", state: "Booted" },
            { device: "BBBB-2", name: "iPhone 17e", runtime: "iOS-27-2", state: "Shutdown" },
            { device: "CCCC-3", name: "Apple Watch", runtime: "watchOS-12-0", state: "Shutdown" },
          ],
        },
      });
      const operations = makeDeviceHubOperations({
        origin: hub.origin,
        token: "t",
        http: yield* HttpClient.HttpClient,
        run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
        platformAvailable: (platform) => Effect.succeed(platform === "ios"),
        scratchDir: "/nonexistent",
      });

      const listed = yield* operations.list;

      expect(listed.devices.map((device) => [device.id, device.version, device.booted])).toEqual([
        ["AAAA-1", "iOS 27.2", true],
        ["BBBB-2", "iOS 27.2", false],
      ]);
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  );
});
