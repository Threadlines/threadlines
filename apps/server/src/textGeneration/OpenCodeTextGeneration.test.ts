import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import type { OpenCodeClient } from "../provider/opencode/OpenCodeClient.ts";
import type { OpenCodeServerManagerShape } from "../provider/opencode/OpenCodeServerManager.ts";
import { makeOpenCodeTextGeneration } from "./OpenCodeTextGeneration.ts";

const INSTANCE_ID = ProviderInstanceId.make("opencode");

describe("OpenCodeTextGeneration", () => {
  it.live("generates a thread title, passes a generous timeout, and removes the session", () =>
    Effect.gen(function* () {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "opencode-textgen-")));
      const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
      let generateSignalAborted = false;
      const client = {
        session: {
          create: async (input: unknown) => {
            calls.push({ method: "session.create", input });
            return { id: "ses_textgen" };
          },
          generate: async (input: unknown, options?: { readonly signal?: AbortSignal }) => {
            calls.push({ method: "session.generate", input });
            generateSignalAborted = options?.signal?.aborted ?? false;
            return { text: JSON.stringify({ title: "Fix OpenCode resume fallback" }) };
          },
          remove: async (input: unknown) => {
            calls.push({ method: "session.remove", input });
          },
        },
      } as unknown as OpenCodeClient;
      const active = {
        generation: 1,
        server: {
          url: "http://127.0.0.1:1",
          client,
          version: "2.3.2",
          external: false,
          exited: Effect.never,
          pid: null,
        },
        streamReady: Effect.void,
      };
      const manager: OpenCodeServerManagerShape = {
        server: Effect.succeed(active),
        lease: Effect.void,
        retire: Effect.void,
        withServer: (use) => Effect.scoped(use(active)),
        signals: Stream.empty,
        running: Effect.succeed(active.server),
      };

      const textGen = yield* makeOpenCodeTextGeneration(manager);
      const result = yield* textGen.generateThreadTitle({
        cwd,
        message: "Audit our OpenCode integration",
        modelSelection: { instanceId: INSTANCE_ID, model: "openai/gpt-5" },
      });

      expect(result.title).toBe("Fix OpenCode resume fallback");
      expect(generateSignalAborted).toBe(false);
      expect(calls.map((c) => c.method)).toEqual([
        "session.create",
        "session.generate",
        "session.remove",
      ]);
      expect(calls[0]!.input).toMatchObject({
        location: { directory: cwd },
        model: { providerID: "openai", id: "gpt-5" },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("cleans up the throwaway session when generation fails", () =>
    Effect.gen(function* () {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "opencode-textgen-fail-")));
      const removed: Array<unknown> = [];
      const client = {
        session: {
          create: async () => ({ id: "ses_fail" }),
          generate: async () => Promise.reject(new Error("upstream overloaded")),
          remove: async (input: unknown) => {
            removed.push(input);
          },
        },
      } as unknown as OpenCodeClient;
      const active = {
        generation: 1,
        server: {
          url: "http://127.0.0.1:1",
          client,
          version: "2.3.2",
          external: false,
          exited: Effect.never,
          pid: null,
        },
        streamReady: Effect.void,
      };
      const manager: OpenCodeServerManagerShape = {
        server: Effect.succeed(active),
        lease: Effect.void,
        retire: Effect.void,
        withServer: (use) => Effect.scoped(use(active)),
        signals: Stream.empty,
        running: Effect.succeed(active.server),
      };

      const textGen = yield* makeOpenCodeTextGeneration(manager);
      const error = yield* textGen
        .generateThreadTitle({
          cwd,
          message: "Audit our OpenCode integration",
          modelSelection: { instanceId: INSTANCE_ID, model: "openai/gpt-5" },
        })
        .pipe(Effect.flip);

      expect(error.detail).toContain("upstream overloaded");
      expect(removed).toEqual([{ sessionID: "ses_fail" }]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
