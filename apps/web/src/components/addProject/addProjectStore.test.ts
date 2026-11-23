import { EnvironmentId, ProjectId } from "@threadlines/contracts";
import { scopeProjectRef } from "@threadlines/client-runtime";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  finishAddProject,
  useAddProjectStore,
  waitForAddProjectSessionEnd,
} from "./addProjectStore";

const PROJECT_REF = scopeProjectRef(EnvironmentId.make("environment-local"), ProjectId.make("p1"));

function openSession(onProjectSelected?: (ref: typeof PROJECT_REF) => void) {
  useAddProjectStore
    .getState()
    .open(onProjectSelected ? { selection: { onProjectSelected } } : undefined);
  return useAddProjectStore.getState().session!;
}

describe("add project store", () => {
  // Session ids only ever grow, as in the app.
  beforeEach(() => {
    useAddProjectStore.setState({ session: null });
  });

  it("hands a finished add to the session that started it, then closes", async () => {
    const onProjectSelected = vi.fn();
    const session = openSession(onProjectSelected);
    const openProject = vi.fn(async () => undefined);
    const announce = vi.fn();

    await finishAddProject({ session, projectRef: PROJECT_REF, openProject, announce });

    expect(onProjectSelected).toHaveBeenCalledWith(PROJECT_REF);
    expect(openProject).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
    expect(useAddProjectStore.getState().session).toBeNull();
  });

  it("opens the project and closes when nobody is picking a folder", async () => {
    const session = openSession();
    const openProject = vi.fn(async () => undefined);

    await finishAddProject({ session, projectRef: PROJECT_REF, openProject, announce: vi.fn() });

    expect(openProject).toHaveBeenCalledOnce();
    expect(useAddProjectStore.getState().session).toBeNull();
  });

  it("leaves a replacing session alone when an older one finishes", async () => {
    const firstCaller = vi.fn();
    const staleSession = openSession(firstCaller);
    useAddProjectStore.getState().close();
    const secondCaller = vi.fn();
    const currentSession = openSession(secondCaller);
    const openProject = vi.fn(async () => undefined);
    const announce = vi.fn();

    await finishAddProject({
      session: staleSession,
      projectRef: PROJECT_REF,
      openProject,
      announce,
    });

    expect(firstCaller).not.toHaveBeenCalled();
    expect(secondCaller).not.toHaveBeenCalled();
    expect(openProject).not.toHaveBeenCalled();
    expect(useAddProjectStore.getState().session).toBe(currentSession);
    // The user still hears what was added, with a way to open it.
    expect(announce).toHaveBeenCalledWith(openProject);
  });

  it("announces instead of navigating when its session was closed", async () => {
    const session = openSession();
    useAddProjectStore.getState().close();
    const openProject = vi.fn(async () => undefined);
    const announce = vi.fn();

    await finishAddProject({ session, projectRef: PROJECT_REF, openProject, announce });

    expect(openProject).not.toHaveBeenCalled();
    expect(announce).toHaveBeenCalledOnce();
  });

  it("says a session ended cancelled when it closed, and added when a project came through it", async () => {
    const closed = openSession();
    const closedEnd = waitForAddProjectSessionEnd(closed.id);
    useAddProjectStore.getState().close();
    await expect(closedEnd).resolves.toBe("cancelled");

    const finished = openSession();
    const finishedEnd = waitForAddProjectSessionEnd(finished.id);
    await finishAddProject({
      session: finished,
      projectRef: PROJECT_REF,
      openProject: async () => undefined,
      announce: vi.fn(),
    });
    await expect(finishedEnd).resolves.toBe("added");
  });
});
