import { afterEach, expect, it, vi } from "vite-plus/test";
import type { SourceControlSetupState } from "@threadlines/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import {
  createSourceControlSetupManager,
  EMPTY_SOURCE_CONTROL_SETUP,
  sourceControlSetupStateAtom,
} from "./sourceControlSetupState.ts";

afterEach(() => vi.useRealTimers());

it("shares polling, restores jobs across mounts, and refreshes discovery when a job finishes", async () => {
  vi.useFakeTimers();
  const registry = AtomRegistry.make();
  let state: SourceControlSetupState = {
    ...EMPTY_SOURCE_CONTROL_SETUP,
    tools: [{ target: "git", operation: "install", status: "running", message: "Installing Git" }],
  };
  const getSourceControlSetup = vi.fn(async () => state);
  const onSettled = vi.fn();
  const manager = createSourceControlSetupManager({
    getRegistry: () => registry,
    getClient: () => ({ getSourceControlSetup }),
    onSettled,
  });
  const stopFirst = manager.watch("windows");
  const stopSecond = manager.watch("windows");
  await manager.refresh("windows");
  expect(getSourceControlSetup).toHaveBeenCalledTimes(1);
  expect(registry.get(sourceControlSetupStateAtom("windows")).tools[0]?.status).toBe("running");
  stopFirst();
  state = {
    ...state,
    tools: [{ target: "git", operation: "install", status: "succeeded", message: "Installed" }],
  };
  await vi.advanceTimersByTimeAsync(1_000);
  expect(onSettled).toHaveBeenCalledExactlyOnceWith("windows");
  stopSecond();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(getSourceControlSetup).toHaveBeenCalledTimes(2);
  const stopRemounted = manager.watch("windows");
  await manager.refresh("windows");
  expect(registry.get(sourceControlSetupStateAtom("windows")).tools[0]?.status).toBe("succeeded");
  expect(onSettled).toHaveBeenCalledTimes(1);
  stopRemounted();
  manager.reset();
  registry.dispose();
});

it("keeps setup progress scoped to its environment", async () => {
  const registry = AtomRegistry.make();
  const manager = createSourceControlSetupManager({
    getRegistry: () => registry,
    getClient: () => ({ getSourceControlSetup: async () => EMPTY_SOURCE_CONTROL_SETUP }),
    onSettled: () => {},
  });
  manager.markToolPending("remote", { target: "github-cli", operation: "install" });
  expect(registry.get(sourceControlSetupStateAtom("primary")).tools).toEqual([]);
  expect(registry.get(sourceControlSetupStateAtom("remote")).tools[0]?.status).toBe("queued");
  manager.reset();
  registry.dispose();
});

it("does not let an older poll replace a newly started sign-in", async () => {
  const registry = AtomRegistry.make();
  let finish: (state: SourceControlSetupState) => void = () => {};
  const pending = new Promise<SourceControlSetupState>((resolve) => {
    finish = resolve;
  });
  const manager = createSourceControlSetupManager({
    getRegistry: () => registry,
    getClient: () => ({ getSourceControlSetup: () => pending }),
    onSettled: () => {},
  });
  const request = manager.refresh("windows");
  manager.store("windows", {
    ...EMPTY_SOURCE_CONTROL_SETUP,
    githubAuth: {
      status: "running",
      verificationUrl: "https://github.com/login/device",
      userCode: "ABCD-1234",
      message: null,
    },
  });
  finish(EMPTY_SOURCE_CONTROL_SETUP);
  await request;
  expect(registry.get(sourceControlSetupStateAtom("windows")).githubAuth.status).toBe("running");
  manager.reset();
  registry.dispose();
});
