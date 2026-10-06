// @effect-diagnostics nodeBuiltinImport:off - builds a download that runs the mock agent
import * as NodeFS from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { AcpRegistrySettings } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import { acpRegistryAgentState } from "../acpRegistry/AcpRegistryAgentState.ts";
import {
  acpRegistryAgentRoot,
  makeAcpRegistryInstaller,
} from "../acpRegistry/AcpRegistryInstaller.ts";
import {
  type AcpRegistryDownloadRecipe,
  acpRegistryRecipeDigest,
} from "../acpRegistry/AcpRegistryRecipe.ts";
import { makeTar } from "../testUtils/archiveFixtures.ts";
import { makeAcpRegistryDescriptor } from "./AcpRegistrySupport.ts";

const mockAgentPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/acp-mock-agent.ts",
);
const settings = Schema.decodeSync(AcpRegistrySettings)({});
/** Real processes and files; a status check never has a reason to reach the network. */
const services = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("A community agent's status check doesn't use the network")),
  ),
);

const tempDir = Effect.acquireRelease(
  Effect.promise(() => NodeFS.mkdtemp(path.join(os.tmpdir(), "threadlines-acp-descriptor-"))),
  (dir) => Effect.promise(() => NodeFS.rm(dir, { recursive: true, force: true })),
);

let agentCount = 0;

/**
 * A community agent whose download is a script that runs the mock agent,
 * with its installer and the descriptor a driver would build for it. Every
 * start of the agent adds an `initialize` line to its request log.
 */
const makeAgent = (mockEnv: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    agentCount += 1;
    const agentId = `descriptor-test-${process.pid}-${agentCount}`;
    const requestLog = path.join(dir, "requests.ndjson");
    const exports = Object.entries({ ...mockEnv, T3_ACP_REQUEST_LOG_PATH: requestLog })
      .map(([name, value]) => `export ${name}=${JSON.stringify(value)}`)
      .join("\n");
    const program = `#!/bin/sh\n${exports}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"\n`;
    const archive = zlib.gzipSync(makeTar([{ name: "bin/agent", data: Buffer.from(program) }]));
    const recipe: AcpRegistryDownloadRecipe = {
      kind: "download",
      agentId,
      version: "1.0.0",
      args: [],
      env: {},
      url: "https://downloads.test/agent.tar.gz",
      sha256: null,
      format: "tar.gz",
      cmd: "bin/agent",
    };
    const toolsDir = path.join(dir, "acp");
    const installer = makeAcpRegistryInstaller({
      agentId,
      label: "Test Agent",
      toolsDir,
      nodeToolsDir: path.join(dir, "node"),
      fetch: async () => new Response(new Uint8Array(archive)),
    });
    const state = acpRegistryAgentState(agentId);
    const descriptor = makeAcpRegistryDescriptor({
      agentId,
      displayName: "Test Agent",
      agentRoot: acpRegistryAgentRoot(toolsDir, agentId),
      installer,
      state,
      instanceVariableNames: new Set(),
      listing: null,
      authMethodId: "",
      allowsEnvName: () => true,
    });
    const starts = Effect.promise(() =>
      NodeFS.readFile(requestLog, "utf8").then(
        (log) => log.split("\n").filter((line) => line.includes('"initialize"')).length,
        () => 0,
      ),
    );
    return {
      recipe,
      digest: acpRegistryRecipeDigest(recipe),
      installer,
      state,
      descriptor,
      starts,
      probe: descriptor.probe(settings, process.env),
      community: () => descriptor.snapshotExtras?.().community,
      maintenance: Effect.suspend(
        () => descriptor.resolveMaintenance?.(settings) ?? Effect.die("no maintenance"),
      ),
      spawn: Effect.suspend(() => {
        const spawned = descriptor.spawn(settings, os.tmpdir(), process.env);
        return Effect.isEffect(spawned) ? spawned : Effect.succeed(spawned);
      }),
    };
  });

describe.skipIf(process.platform === "win32")("makeAcpRegistryDescriptor", () => {
  it.live("says what is installed, starts the agent once to see that it works", () =>
    Effect.gen(function* () {
      const agent = yield* makeAgent();

      // Nothing confirmed, nothing installed: no install to offer either.
      const missing = yield* agent.probe;
      assert.deepInclude(missing, {
        installed: false,
        status: "error",
        message: "Test Agent isn't installed.",
      });
      assert.isNull((yield* agent.maintenance).install ?? null);
      assert.equal(yield* agent.starts, 0);

      // Confirmed: the row can install it, and only the recipe that was asked for.
      yield* agent.installer.confirm(agent.recipe);
      const install = (yield* agent.maintenance).install;
      assert.isDefined(install?.run);
      assert.deepStrictEqual(yield* Effect.flip(install?.run ?? Effect.void), {
        message: "Look at Test Agent again before installing it.",
      });
      agent.state.requestedRecipeDigest = agent.digest;
      assert.deepStrictEqual(yield* install?.run ?? Effect.void, {
        output: "Test Agent 1.0.0 is installed.",
      });

      const ready = yield* agent.probe;
      assert.deepInclude(ready, { installed: true, version: "1.0.0", status: "ready" });
      // Ready is not "signed in": an agent that needs no sign-in looks the same.
      assert.deepStrictEqual(ready.auth, { status: "unknown" });
      assert.isAbove(ready.models?.length ?? 0, 0);
      assert.deepInclude(agent.community(), {
        source: "download",
        verification: "firstInstall",
        confirmedRecipeDigest: agent.digest,
        updateCandidate: null,
      });
      const maintenance = yield* agent.maintenance;
      assert.isNull(maintenance.install ?? null);
      assert.isNull(maintenance.update ?? null);

      // The next look at its status uses what the check found, without starting it again.
      assert.equal(yield* agent.starts, 1);
      assert.deepInclude(yield* agent.probe, { status: "ready" });
      assert.equal(yield* agent.starts, 1);
      // "Check again" starts it once more.
      agent.state.checkRequested = true;
      yield* agent.probe;
      assert.equal(yield* agent.starts, 2);

      // A newer listing is offered as an update of the row.
      agent.state.updateCandidate = { version: "1.1.0", recipeDigest: "f".repeat(64) };
      assert.equal((yield* agent.probe).latestVersion, "1.1.0");
      assert.isNotNull((yield* agent.maintenance).update ?? null);
    }).pipe(Effect.provide(services)),
  );

  it.live("a signed-out agent says so, and keeps the sign-in it offers", () =>
    Effect.gen(function* () {
      const agent = yield* makeAgent({ T3_ACP_AUTH_REQUIRED: "1" });
      yield* agent.installer.confirm(agent.recipe);
      yield* agent.installer.install(agent.digest);

      const signedOut = yield* agent.probe;
      assert.deepInclude(signedOut, {
        installed: true,
        status: "error",
        message: "Sign in to Test Agent to use it.",
      });
      assert.deepStrictEqual(signedOut.auth, { status: "unauthenticated" });
      // The method came with `initialize`, before any session could open.
      assert.deepStrictEqual(agent.community()?.signIn, {
        methods: [
          {
            id: "mock-login",
            name: "Log in to Mock",
            description: null,
            kind: "agent",
            envVars: [],
          },
        ],
        selected: "mock-login",
        canSignOut: false,
      });
    }).pipe(Effect.provide(services)),
  );

  it.live("no session starts while the agent is signing in or being removed", () =>
    Effect.gen(function* () {
      const agent = yield* makeAgent();
      yield* agent.installer.confirm(agent.recipe);
      yield* agent.installer.install(agent.digest);

      agent.state.gate.busy = true;
      const refused = yield* Effect.flip(Effect.scoped(agent.spawn));
      assert.include(
        String(refused.cause),
        "Test Agent is signing in, signing out or being removed. Try again when that's done.",
      );
      // The status check doesn't start it either, and says it is still looking.
      assert.deepInclude(yield* agent.probe, {
        installed: true,
        statusReason: "provider_probe_pending",
      });
      assert.equal(yield* agent.starts, 0);

      agent.state.gate.busy = false;
      const spawn = yield* Effect.scoped(
        Effect.gen(function* () {
          const input = yield* agent.spawn;
          // Held for as long as the process runs.
          assert.equal(agent.state.gate.holds, 1);
          return input;
        }),
      );
      assert.equal(agent.state.gate.holds, 0);
      assert.isTrue(spawn.command.endsWith(path.join("payload", "bin", "agent")));
      assert.isFalse(spawn.inheritEnv);
    }).pipe(Effect.provide(services)),
  );
});
