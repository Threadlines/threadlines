import { assert, beforeEach, it } from "vite-plus/test";
import type { SourceControlDiscoveryResult } from "@threadlines/contracts";
import * as Option from "effect/Option";
import { AtomRegistry } from "effect/unstable/reactivity";

import {
  EMPTY_SOURCE_CONTROL_DISCOVERY_STATE,
  createSourceControlDiscoveryManager,
} from "./sourceControlDiscoveryState.ts";

const EMPTY_RESULT: SourceControlDiscoveryResult = {
  versionControlSystems: [],
  sourceControlProviders: [],
};

const GIT_AVAILABLE_RESULT: SourceControlDiscoveryResult = {
  versionControlSystems: [
    {
      kind: "git",
      label: "Git",
      executable: "git",
      implemented: true,
      status: "available",
      version: Option.some("git version 2.54.0.windows.1"),
      installHint: "Install Git.",
      detail: Option.none(),
    },
  ],
  sourceControlProviders: [],
};

function unresolvedDiscovery() {
  throw new Error("Discovery resolver was not initialized.");
}

let registry = AtomRegistry.make();

beforeEach(() => {
  registry.dispose();
  registry = AtomRegistry.make();
});

it("stores refreshed discovery data in an atom snapshot", async () => {
  const manager = createSourceControlDiscoveryManager({
    getRegistry: () => registry,
    getClient: () => ({
      discoverSourceControl: async () => EMPTY_RESULT,
    }),
  });

  assert.deepStrictEqual(manager.getSnapshot({ key: null }), EMPTY_SOURCE_CONTROL_DISCOVERY_STATE);

  const result = await manager.refresh({ key: "primary" });

  assert.strictEqual(result, EMPTY_RESULT);
  assert.deepStrictEqual(manager.getSnapshot({ key: "primary" }), {
    data: EMPTY_RESULT,
    error: null,
    isPending: false,
  });
});

it("stores discovery returned by a related server operation", () => {
  const manager = createSourceControlDiscoveryManager({
    getRegistry: () => registry,
    getClient: () => null,
  });

  manager.storeResult({ key: "primary" }, EMPTY_RESULT);

  assert.deepStrictEqual(manager.getSnapshot({ key: "primary" }), {
    data: EMPTY_RESULT,
    error: null,
    isPending: false,
  });
});

it("deduplicates in-flight discovery refreshes by target key", async () => {
  let resolveDiscovery: (result: SourceControlDiscoveryResult) => void = unresolvedDiscovery;
  let calls = 0;
  const manager = createSourceControlDiscoveryManager({
    getRegistry: () => registry,
    getClient: () => ({
      discoverSourceControl: () => {
        calls += 1;
        return new Promise<SourceControlDiscoveryResult>((resolve) => {
          resolveDiscovery = resolve;
        });
      },
    }),
  });

  const first = manager.refresh({ key: "primary" });
  const second = manager.refresh({ key: "primary" });

  assert.strictEqual(first, second);
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(manager.getSnapshot({ key: "primary" }), {
    data: null,
    error: null,
    isPending: true,
  });

  resolveDiscovery(EMPTY_RESULT);
  await first;

  assert.deepStrictEqual(manager.getSnapshot({ key: "primary" }), {
    data: EMPTY_RESULT,
    error: null,
    isPending: false,
  });
});

it("forces a fresh probe after reconnect without letting the old result overwrite it", async () => {
  const resolvers: Array<(result: SourceControlDiscoveryResult) => void> = [];
  const manager = createSourceControlDiscoveryManager({
    getRegistry: () => registry,
    getClient: () => ({
      discoverSourceControl: () =>
        new Promise<SourceControlDiscoveryResult>((resolve) => {
          resolvers.push(resolve);
        }),
    }),
  });

  const beforeReconnect = manager.refresh({ key: "primary" });
  const afterReconnect = manager.refresh({ key: "primary" }, undefined, { force: true });

  assert.notStrictEqual(beforeReconnect, afterReconnect);
  assert.strictEqual(resolvers.length, 2);

  resolvers[1]!(GIT_AVAILABLE_RESULT);
  await afterReconnect;
  resolvers[0]!(EMPTY_RESULT);
  await beforeReconnect;

  assert.strictEqual(manager.getSnapshot({ key: "primary" }).data, GIT_AVAILABLE_RESULT);
});

it("keeps the previous snapshot when refresh fails", async () => {
  let shouldFail = false;
  const manager = createSourceControlDiscoveryManager({
    getRegistry: () => registry,
    getClient: () => ({
      discoverSourceControl: async () => {
        if (shouldFail) {
          throw new Error("probe failed");
        }
        return EMPTY_RESULT;
      },
    }),
  });

  await manager.refresh({ key: "primary" });
  shouldFail = true;

  const result = await manager.refresh({ key: "primary" });

  assert.strictEqual(result, EMPTY_RESULT);
  assert.deepStrictEqual(manager.getSnapshot({ key: "primary" }), {
    data: EMPTY_RESULT,
    error: "probe failed",
    isPending: false,
  });
});
