// @effect-diagnostics nodeBuiltinImport:off
import { createServer } from "node:http";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/unstable/http";

import { checkXaiApiKey } from "./GrokAuth.ts";

it.live("asks xAI about a key and shows xAI's reason for refusing it", () =>
  Effect.gen(function* () {
    const seen: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      seen.push(request.headers.authorization);
      const good = request.headers.authorization === "Bearer good";
      response.writeHead(good ? 200 : 400, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          good
            ? { data: [] }
            : {
                code: "Client specified an invalid argument",
                error: "Incorrect API key provided: ba***ad.",
              },
        ),
      );
    });
    yield* Effect.promise(() => new Promise<void>((done) => server.listen(0, "127.0.0.1", done)));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1/models`;
    const check = (key: string) =>
      checkXaiApiKey(key, url).pipe(Effect.provide(FetchHttpClient.layer));

    assert.deepEqual(yield* check("good"), { verdict: "accepted" });
    assert.deepEqual(yield* check("bad"), {
      verdict: "rejected",
      message: "Incorrect API key provided: ba***ad.",
    });
    assert.deepEqual(seen, ["Bearer good", "Bearer bad"]);
    yield* Effect.promise(() => new Promise<void>((done) => server.close(() => done())));
  }),
);
