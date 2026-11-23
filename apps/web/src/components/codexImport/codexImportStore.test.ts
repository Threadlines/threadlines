import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@threadlines/contracts";
import { scopeThreadRef } from "@threadlines/client-runtime";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { finishCodexImport, useCodexImportStore } from "./codexImportStore";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_REF = scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("imported"));

function openSession(): number {
  return useCodexImportStore.getState().open({
    project: {
      environmentId: ENVIRONMENT_ID,
      projectId: ProjectId.make("p1"),
      projectName: "Project",
      cwd: "/repo/project",
    },
    accounts: [{ instanceId: ProviderInstanceId.make("codex"), displayName: "Codex" }],
    runtimeMode: "full-access",
  });
}

describe("codex import store", () => {
  beforeEach(() => {
    useCodexImportStore.setState({ session: null, lastSessionId: 0 });
  });

  it("closes and opens the thread when its session is still open", async () => {
    const sessionId = openSession();
    const openThread = vi.fn(async () => undefined);
    const announce = vi.fn();

    await finishCodexImport({ sessionId, threadRef: THREAD_REF, openThread, announce });

    expect(openThread).toHaveBeenCalledOnce();
    expect(announce).not.toHaveBeenCalled();
    expect(useCodexImportStore.getState().session).toBeNull();
  });

  it("does not navigate or close a newer session when an older import finishes", async () => {
    const staleSessionId = openSession();
    useCodexImportStore.getState().close();
    const currentSessionId = openSession();
    const openThread = vi.fn(async () => undefined);
    const announce = vi.fn();

    await finishCodexImport({
      sessionId: staleSessionId,
      threadRef: THREAD_REF,
      openThread,
      announce,
    });

    expect(openThread).not.toHaveBeenCalled();
    expect(useCodexImportStore.getState().session?.id).toBe(currentSessionId);
    expect(announce).toHaveBeenCalledWith(openThread);
  });
});
