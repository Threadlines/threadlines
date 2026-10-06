// @effect-diagnostics nodeBuiltinImport:off - builds a download that runs the mock agent
/**
 * A community agent for tests: its download is a script that runs the mock
 * ACP agent (`scripts/acp-mock-agent.ts`), installed through the real
 * installer into a temp folder.
 *
 * @module provider/testUtils/acpRegistryAgentFixture
 */
import * as NodeFS from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";

import * as Effect from "effect/Effect";

import type { AcpRegistryDescriptorInput } from "../acp/AcpRegistrySupport.ts";
import { acpRegistryAgentState } from "../acpRegistry/AcpRegistryAgentState.ts";
import {
  acpRegistryAgentRoot,
  makeAcpRegistryInstaller,
} from "../acpRegistry/AcpRegistryInstaller.ts";
import {
  type AcpRegistryDownloadRecipe,
  acpRegistryRecipeDigest,
} from "../acpRegistry/AcpRegistryRecipe.ts";
import { makeTar } from "./archiveFixtures.ts";

const mockAgentPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/acp-mock-agent.ts",
);

const tempDir = Effect.acquireRelease(
  Effect.promise(() => NodeFS.mkdtemp(path.join(os.tmpdir(), "threadlines-acp-agent-"))),
  (dir) => Effect.promise(() => NodeFS.rm(dir, { recursive: true, force: true })),
);

let agentCount = 0;

/**
 * A community agent named "Test Agent" with an installer of its own, not
 * installed yet. `mockEnv` are the mock agent's `T3_ACP_*` switches. Every
 * start of the agent adds an `initialize` line to its request log, counted
 * by `starts`. POSIX only: the download is a shell script.
 */
export const makeAcpRegistryTestAgent = (mockEnv: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const dir = yield* tempDir;
    agentCount += 1;
    const agentId = `test-agent-${process.pid}-${agentCount}`;
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
    const digest = acpRegistryRecipeDigest(recipe);
    const toolsDir = path.join(dir, "acp");
    const installer = makeAcpRegistryInstaller({
      agentId,
      label: "Test Agent",
      toolsDir,
      nodeToolsDir: path.join(dir, "node"),
      fetch: async () => new Response(new Uint8Array(archive)),
    });
    const state = acpRegistryAgentState(agentId);
    const descriptorInput: AcpRegistryDescriptorInput = {
      agentId,
      displayName: "Test Agent",
      agentRoot: acpRegistryAgentRoot(toolsDir, agentId),
      installer,
      state,
      instanceVariableNames: new Set(),
      listing: null,
      authMethodId: "",
      allowsEnvName: () => true,
    };
    return {
      recipe,
      digest,
      installer,
      state,
      descriptorInput,
      /** Confirms the recipe and installs it. */
      install: installer.confirm(recipe).pipe(Effect.andThen(installer.install(digest))),
      /** How many times the agent has been started. */
      starts: Effect.promise(() =>
        NodeFS.readFile(requestLog, "utf8").then(
          (log) => log.split("\n").filter((line) => line.includes('"initialize"')).length,
          () => 0,
        ),
      ),
    };
  });
