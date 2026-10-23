/**
 * "Set up on another computer" (docs/design/fleet.md, Part 8): one dialog for
 * every entry point (the sidebar's project menu, the command palette, the
 * new thread's "Runs on" picker, Move's "Set it up there"). Each asks through
 * openProjectSetupDialog; the host mounted once at the root shows it, and
 * raises a toast when a setup this app started ends while the dialog is
 * closed.
 *
 * The dialog asks the project's computer what to clone and which ignored
 * files could go along, lets the user pick the other computer, the folder,
 * the protocol and the files, then starts the job there and follows it.
 */
import { scopeProjectRef } from "@threadlines/client-runtime";
import type { EnvironmentId, ProjectSetupId, ScopedProjectRef } from "@threadlines/contracts";
import { Suspense, useCallback, useEffect } from "react";
import { create } from "zustand";

import {
  onProjectSetupEnded,
  type ProjectSetupOnDone,
  waitForSetUpProject,
} from "../environments/projectSetups/projectSetups";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { lazyWithPreload } from "../lib/lazyWithPreload";
import { Dialog } from "./ui/dialog";
import { stackedThreadToast, toastManager } from "./ui/toast";

const ProjectSetupDialogContent = lazyWithPreload(() =>
  import("./ProjectSetupDialogContent").then((module) => module.ProjectSetupDialogContent),
);

/** Fetches the dialog's body ahead of its first open. */
export const preloadProjectSetupDialog = ProjectSetupDialogContent.preload;

export type ProjectSetupDialogRequest =
  | {
      /** Each ask starts fresh, even for the same project twice. */
      readonly id: number;
      readonly kind: "new";
      /** The project to copy, on the computer that has it. */
      readonly project: ScopedProjectRef;
      readonly targetEnvironmentId: EnvironmentId | null;
      readonly onDone: ProjectSetupOnDone | null;
    }
  | {
      readonly id: number;
      readonly kind: "job";
      /** The computer the job runs on. */
      readonly environmentId: EnvironmentId;
      readonly setupId: ProjectSetupId;
    };

type ProjectSetupDialogAsk =
  | Omit<Extract<ProjectSetupDialogRequest, { kind: "new" }>, "id">
  | Omit<Extract<ProjectSetupDialogRequest, { kind: "job" }>, "id">;

const useProjectSetupDialogStore = create<{ request: ProjectSetupDialogRequest | null }>(() => ({
  request: null,
}));

function openRequest(ask: ProjectSetupDialogAsk): void {
  const previous = useProjectSetupDialogStore.getState().request;
  useProjectSetupDialogStore.setState({ request: { ...ask, id: (previous?.id ?? 0) + 1 } });
}

/**
 * Opens the dialog to set `project` up on another computer: `target` comes
 * picked when it can take it, and `onDone` runs once the setup ends done (even
 * with the dialog closed by then), with the project it made there.
 */
export function openProjectSetupDialog(input: {
  readonly project: ScopedProjectRef;
  readonly targetEnvironmentId?: EnvironmentId;
  readonly onDone?: ProjectSetupOnDone;
}): void {
  openRequest({
    kind: "new",
    project: input.project,
    targetEnvironmentId: input.targetEnvironmentId ?? null,
    onDone: input.onDone ?? null,
  });
}

/** Opens the dialog on a job already running or finished, on the computer it runs on. */
export function showProjectSetupJob(environmentId: EnvironmentId, setupId: ProjectSetupId): void {
  openRequest({ kind: "job", environmentId, setupId });
}

export function closeProjectSetupDialog(): void {
  useProjectSetupDialogStore.setState({ request: null });
}

/** Mounted once at the root; shows whatever openProjectSetupDialog asks. */
export function ProjectSetupDialogHost() {
  const request = useProjectSetupDialogStore((state) => state.request);
  return (
    <>
      <Dialog
        open={request !== null}
        onOpenChange={(open) => {
          if (!open) closeProjectSetupDialog();
        }}
      >
        {request ? (
          <Suspense fallback={null}>
            <ProjectSetupDialogContent.Component key={request.id} request={request} />
          </Suspense>
        ) : null}
      </Dialog>
      <ProjectSetupEndToasts />
    </>
  );
}

/** Starts a thread in the project a setup made, once this app has heard of it. */
export function useStartThreadInSetUpProject() {
  const { handleNewThread } = useNewThreadHandler();
  return useCallback(
    async (ref: ScopedProjectRef): Promise<boolean> => {
      if (!(await waitForSetUpProject(ref))) return false;
      await handleNewThread(ref);
      return true;
    },
    [handleNewThread],
  );
}

/**
 * Tells of a setup this app started that ended while the dialog wasn't
 * showing it: ready, with a way to start a thread there, or failed, with a
 * way back to the dialog.
 */
function ProjectSetupEndToasts() {
  const startThread = useStartThreadInSetUpProject();
  useEffect(
    () =>
      onProjectSetupEnded(({ job, environmentId, label, shown }) => {
        if (shown) return;
        if (job.stage === "done" && job.projectId !== null) {
          const ref = scopeProjectRef(environmentId, job.projectId);
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `${job.title} is ready on ${label}`,
              ...(job.warnings.length > 0 ? { description: job.warnings.join(" ") } : {}),
              actionProps: {
                children: "Start a thread there",
                onClick: () =>
                  void startThread(ref).then((started) => {
                    if (started) return;
                    toastManager.add(
                      stackedThreadToast({
                        type: "error",
                        title: `${label} hasn't shown the new project yet`,
                        description: "Try again in a moment.",
                      }),
                    );
                  }),
              },
              actionVariant: "outline",
            }),
          );
          return;
        }
        if (job.stage === "failed") {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Couldn't set up ${job.title} on ${label}`,
              ...(job.error !== null ? { description: job.error } : {}),
              actionProps: {
                children: "Show",
                onClick: () => showProjectSetupJob(environmentId, job.setupId),
              },
              actionVariant: "outline",
            }),
          );
        }
      }),
    [startThread],
  );
  return null;
}
