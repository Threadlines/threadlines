import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  forgetConnectToken,
  readConnectCredential,
  writeConnectCredential,
} from "./connectCredentials.ts";

const RESOURCE = "http://127.0.0.1:3773/mcp/connect";

const credentialsPath = () =>
  join(mkdtempSync(join(tmpdir(), "threadlines-cli-credentials-")), "cli", "connections.json");

describe("the threadlines command's sign-ins", () => {
  it.live("a refused old token doesn't erase the newer one a later connect stored", () =>
    Effect.gen(function* () {
      const path = credentialsPath();
      yield* writeConnectCredential(path, RESOURCE, { clientId: "client-1", accessToken: "new" });
      // An older command, refused with the token it started with.
      yield* forgetConnectToken(path, RESOURCE, "old");
      assert.deepEqual(yield* readConnectCredential(path, RESOURCE), {
        clientId: "client-1",
        accessToken: "new",
      });
      yield* forgetConnectToken(path, RESOURCE, "new");
      assert.deepEqual(yield* readConnectCredential(path, RESOURCE), { clientId: "client-1" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("keeps every change when commands write at once", () =>
    Effect.gen(function* () {
      const path = credentialsPath();
      const resources = Array.from(
        { length: 12 },
        (_, index) => `http://127.0.0.1:${4000 + index}/mcp/connect`,
      );
      yield* Effect.all(
        resources.map((resource, index) =>
          writeConnectCredential(path, resource, {
            clientId: `client-${index}`,
            accessToken: `token-${index}`,
          }),
        ),
        { concurrency: "unbounded" },
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const stored = JSON.parse(readFileSync(path, "utf8")) as {
        readonly resources: Record<string, unknown>;
      };
      assert.deepEqual(Object.keys(stored.resources).toSorted(), resources.toSorted());
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
