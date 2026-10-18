import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@threadlines/contracts";
import { createModelSelection } from "@threadlines/shared/model";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import { isPiKeyEnvName } from "../pi/PiBinary.ts";
import {
  makeTestPiHome,
  resolveTestPiCli,
  startTestModelServer,
  testPiEnvironment,
} from "../pi/testing/PiTestServers.ts";
import {
  checkPiProviderStatus,
  piCatalogModels,
  piComposerCommands,
  piThinkingLevels,
} from "./PiProvider.ts";

const piCli = resolveTestPiCli();

describe("PiProvider", () => {
  it("offers each model the thinking levels Pi allows it, starting from Pi's own level", () => {
    expect(piThinkingLevels({ reasoning: false })).toEqual(["off"]);
    // `xhigh` and `max` only when the model maps them; a null mapping drops a level.
    expect(
      piThinkingLevels({ reasoning: true, thinkingLevelMap: { minimal: null, xhigh: "max" } }),
    ).toEqual(["off", "low", "medium", "high", "xhigh"]);

    const models = piCatalogModels({
      models: [
        { id: "claude-x", name: "Claude X", provider: "anthropic", reasoning: true },
        { id: "small", provider: "my-proxy", reasoning: false, contextWindow: 200_000 },
      ],
      current: { id: "claude-x", name: "Claude X", provider: "anthropic", reasoning: true },
      thinkingLevel: "minimal",
    });
    expect(models.map((model) => [model.slug, model.subProvider, model.isDefault])).toEqual([
      ["default", undefined, true],
      ["anthropic/claude-x", "Anthropic", undefined],
      ["my-proxy/small", "my-proxy", undefined],
    ]);
    const thinking = models[1]!.capabilities?.optionDescriptors?.[0];
    expect(thinking?.type === "select" && thinking.currentValue).toBe("minimal");
    expect(models[2]!.capabilities?.optionDescriptors).toEqual([]);
    expect(models[2]!.metaLabel).toBe("200K ctx");
    // Nothing usable: no picker entries at all, not even the default.
    expect(piCatalogModels({ models: [], current: undefined, thinkingLevel: "off" })).toEqual([]);
  });

  it("splits Pi's commands into skills and slash commands, leaving out internal ones", () => {
    const { slashCommands, skills } = piComposerCommands([
      {
        name: "skill:review",
        description: "Reviews a diff",
        source: "skill",
        sourceInfo: { path: "/home/me/.pi/agent/skills/review/SKILL.md", scope: "user" },
      },
      { name: "fix-tests", description: "Fix failing tests", source: "prompt" },
      { name: "threadlines-turn", source: "extension" },
      { name: "login", source: "extension", sourceInfo: { source: "builtin" } },
    ]);
    expect(skills).toEqual([
      {
        name: "review",
        path: "/home/me/.pi/agent/skills/review/SKILL.md",
        enabled: true,
        description: "Reviews a diff",
        scope: "user",
      },
    ]);
    expect(slashCommands).toEqual([{ name: "fix-tests", description: "Fix failing tests" }]);
  });
});

const run = <A, E>(body: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  body.pipe(Effect.provide(NodeServices.layer));

describe.skipIf(!piCli)("PiProvider with a real Pi", () => {
  const launch = Effect.succeed({ command: process.execPath, prefixArgs: [piCli!] });
  const settings = { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] };

  it.live(
    "is ready with the models Pi can use, and writes titles with the chosen model",
    () =>
      run(
        Effect.gen(function* () {
          const model = yield* Effect.acquireRelease(
            Effect.promise(() => startTestModelServer()),
            (server) => Effect.promise(() => server.close()),
          );
          const home = makeTestPiHome(model.url);
          const snapshot = yield* checkPiProviderStatus({
            settings,
            installation: { kind: "user", command: "pi", version: "1.3.0" },
            launch,
            launchArgs: [],
            cwd: home.projectDir,
            instanceEnvironment: undefined,
            baseEnvironment: testPiEnvironment(home.agentDir),
          });
          expect(snapshot.status).toBe("ready");
          expect(snapshot.auth).toMatchObject({ status: "authenticated", label: "test" });
          expect(snapshot.models.map((entry) => entry.slug)).toEqual([
            "default",
            "test/test-model",
          ]);

          const textGeneration = yield* makePiTextGeneration({
            launch,
            launchArgs: [],
            instanceEnvironment: undefined,
            baseEnvironment: testPiEnvironment(home.agentDir),
          });
          const { title } = yield* textGeneration.generateThreadTitle({
            cwd: home.projectDir,
            message: 'REPLY {"title":"Fix the login bug"}',
            modelSelection: createModelSelection(ProviderInstanceId.make("pi"), "test/test-model"),
          });
          expect(title).toBe("Fix the login bug");
          expect(model.requests.at(-1)?.model).toBe("test-model");
        }).pipe(Effect.scoped),
      ),
    60_000,
  );

  it.live("says to sign in when Pi has no model it can use", () =>
    run(
      Effect.gen(function* () {
        const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "threadlines-pi-empty-")));
        // No keys from this machine's environment: Pi would list their models.
        const environment = Object.fromEntries(
          Object.entries(testPiEnvironment(agentDir)).filter(([name]) => !isPiKeyEnvName(name)),
        );
        const snapshot = yield* checkPiProviderStatus({
          settings,
          installation: { kind: "user", command: "pi", version: "1.3.0" },
          launch,
          launchArgs: [],
          cwd: agentDir,
          instanceEnvironment: undefined,
          baseEnvironment: environment,
        });
        expect(snapshot.status).toBe("warning");
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.models).toEqual([]);
        expect(snapshot.message).toContain("/login");
      }),
    ),
  );
});
