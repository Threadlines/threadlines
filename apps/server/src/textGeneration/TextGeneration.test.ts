import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  TextGenerationError,
} from "@threadlines/contracts";
import { createModelSelection } from "@threadlines/shared/model";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { ProviderInstanceRegistryShape } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { TextGenerationShape } from "./TextGeneration.ts";

import { makeTextGenerationFromRegistry } from "./TextGeneration.ts";

const makeStubTextGeneration = (overrides: Partial<TextGenerationShape>): TextGenerationShape => ({
  generateCommitMessage: () =>
    Effect.die("generateCommitMessage stub not configured for this test"),
  generatePrContent: () => Effect.die("generatePrContent stub not configured for this test"),
  generateBranchName: () => Effect.die("generateBranchName stub not configured for this test"),
  generateThreadTitle: () => Effect.die("generateThreadTitle stub not configured for this test"),
  ...overrides,
});

const makeStubInstance = (
  instanceId: ProviderInstanceId,
  textGeneration: TextGenerationShape,
  driverKind: ProviderDriverKind = ProviderDriverKind.make(instanceId),
): ProviderInstance =>
  ({
    instanceId,
    driverKind,
    continuationIdentity: {
      driverKind,
      continuationKey: `${instanceId}:test`,
    },
    displayName: undefined,
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    adapter: {} as ProviderInstance["adapter"],
    textGeneration,
  }) satisfies ProviderInstance;

const makeStubRegistry = (
  instances: ReadonlyArray<ProviderInstance>,
): ProviderInstanceRegistryShape => {
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance] as const));
  return {
    getInstance: (id) => Effect.succeed(byId.get(id)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    // Tests never drive changes through this stub; acquire a throwaway
    // subscription on an unused PubSub so the shape is satisfied.
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};

describe("makeTextGenerationFromRegistry", () => {
  it.effect("delegates to the matching instance's textGeneration closure", () =>
    Effect.gen(function* () {
      const personalId = ProviderInstanceId.make("codex_personal");
      const personalCalls: string[] = [];
      const personal = makeStubInstance(
        personalId,
        makeStubTextGeneration({
          generateBranchName: (input) => {
            personalCalls.push(input.message);
            return Effect.succeed({ branch: "personal-branch" });
          },
        }),
      );

      const workId = ProviderInstanceId.make("codex_work");
      const work = makeStubInstance(
        workId,
        makeStubTextGeneration({
          generateBranchName: () => Effect.succeed({ branch: "work-branch" }),
        }),
      );

      const tg = makeTextGenerationFromRegistry(makeStubRegistry([personal, work]));

      const result = yield* tg.generateBranchName({
        cwd: process.cwd(),
        message: "Refactor the routing layer",
        modelSelection: createModelSelection(ProviderInstanceId.make("codex_personal"), "gpt-5"),
      });

      expect(result.branch).toBe("personal-branch");
      expect(personalCalls).toEqual(["Refactor the routing layer"]);
    }),
  );

  it.effect("retries with a backup instance on a different provider when primary fails", () =>
    Effect.gen(function* () {
      const primaryId = ProviderInstanceId.make("codex");
      const backupId = ProviderInstanceId.make("claudeAgent");
      const calls: string[] = [];
      const primary = makeStubInstance(
        primaryId,
        makeStubTextGeneration({
          generateThreadTitle: () =>
            Effect.fail(
              new TextGenerationError({
                operation: "generateThreadTitle",
                detail: "primary limit reached",
              }),
            ),
        }),
        ProviderDriverKind.make("codex"),
      );
      const backup = makeStubInstance(
        backupId,
        makeStubTextGeneration({
          generateThreadTitle: (input) => {
            calls.push(`${input.modelSelection.instanceId}:${input.modelSelection.model}`);
            return Effect.succeed({ title: "Backup title" });
          },
        }),
        ProviderDriverKind.make("claudeAgent"),
      );

      const tg = makeTextGenerationFromRegistry(makeStubRegistry([primary, backup]));

      const result = yield* tg.generateThreadTitle({
        cwd: process.cwd(),
        message: "Summarize this thread",
        modelSelection: createModelSelection(primaryId, "gpt-5.4-mini"),
        backupModelSelection: createModelSelection(backupId, "claude-haiku-4-5"),
      });

      expect(result.title).toBe("Backup title");
      expect(calls).toEqual(["claudeAgent:claude-haiku-4-5"]);
    }),
  );

  it.effect("does not retry a backup instance from the same provider driver", () =>
    Effect.gen(function* () {
      const primaryId = ProviderInstanceId.make("codex_personal");
      const backupId = ProviderInstanceId.make("codex_work");
      const backupCalls: string[] = [];
      const primary = makeStubInstance(
        primaryId,
        makeStubTextGeneration({
          generateBranchName: () =>
            Effect.fail(
              new TextGenerationError({
                operation: "generateBranchName",
                detail: "primary failed",
              }),
            ),
        }),
        ProviderDriverKind.make("codex"),
      );
      const backup = makeStubInstance(
        backupId,
        makeStubTextGeneration({
          generateBranchName: (input) => {
            backupCalls.push(input.message);
            return Effect.succeed({ branch: "backup-branch" });
          },
        }),
        ProviderDriverKind.make("codex"),
      );

      const tg = makeTextGenerationFromRegistry(makeStubRegistry([primary, backup]));

      const result = yield* tg
        .generateBranchName({
          cwd: process.cwd(),
          message: "anything",
          modelSelection: createModelSelection(primaryId, "gpt-5.4-mini"),
          backupModelSelection: createModelSelection(backupId, "gpt-5.4"),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      expect(backupCalls).toEqual([]);
      if (Result.isFailure(result)) {
        expect(result.failure.detail).toBe("primary failed");
      }
    }),
  );

  it.effect("reports both failures when the backup provider also fails", () =>
    Effect.gen(function* () {
      const primaryId = ProviderInstanceId.make("codex");
      const backupId = ProviderInstanceId.make("claudeAgent");
      const primary = makeStubInstance(
        primaryId,
        makeStubTextGeneration({
          generateCommitMessage: () =>
            Effect.fail(
              new TextGenerationError({
                operation: "generateCommitMessage",
                detail: "primary limit reached",
              }),
            ),
        }),
        ProviderDriverKind.make("codex"),
      );
      const backup = makeStubInstance(
        backupId,
        makeStubTextGeneration({
          generateCommitMessage: () =>
            Effect.fail(
              new TextGenerationError({
                operation: "generateCommitMessage",
                detail: "backup auth missing",
              }),
            ),
        }),
        ProviderDriverKind.make("claudeAgent"),
      );

      const tg = makeTextGenerationFromRegistry(makeStubRegistry([primary, backup]));

      const result = yield* tg
        .generateCommitMessage({
          cwd: process.cwd(),
          branch: "main",
          stagedSummary: "M src/file.ts",
          stagedPatch: "diff --git a/src/file.ts b/src/file.ts",
          modelSelection: createModelSelection(primaryId, "gpt-5.4-mini"),
          backupModelSelection: createModelSelection(backupId, "claude-haiku-4-5"),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.detail).toContain("primary limit reached");
        expect(result.failure.detail).toContain("backup auth missing");
      }
    }),
  );

  it.effect("fails with TextGenerationError when the instance is unknown", () =>
    Effect.gen(function* () {
      const tg = makeTextGenerationFromRegistry(makeStubRegistry([]));

      const result = yield* tg
        .generateBranchName({
          cwd: process.cwd(),
          message: "anything",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("missing_instance"),
            "gpt-5",
          ),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("TextGenerationError");
        expect(result.failure.operation).toBe("generateBranchName");
        expect(result.failure.detail).toContain("missing_instance");
      }
    }),
  );
});
