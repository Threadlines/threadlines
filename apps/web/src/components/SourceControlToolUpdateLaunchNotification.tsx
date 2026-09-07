import { useNavigate } from "@tanstack/react-router";
import { isSourceControlToolBusy } from "@threadlines/client-runtime";
import type { EnvironmentId, SourceControlToolUpdateTarget } from "@threadlines/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  updateSourceControlTool,
  useSourceControlDiscovery,
  useSourceControlSetup,
} from "../lib/sourceControlDiscoveryState";
import {
  sourceControlToolUpdateErrorCopy,
  sourceControlToolUpdateResultCopy,
} from "../lib/sourceControlToolUpdateCopy";
import { useDismissedSourceControlToolAdvisoryKeys } from "../sourceControlToolAdvisoryDismissal";
import { useStore } from "../store";
import { useActiveEnvironmentFirstRunSetupPending } from "./chat/firstRunSetupState";
import {
  collectSourceControlToolUpdateNotices,
  sourceControlToolUpdateNoticeSetKey,
  sourceControlToolUpdateToastCopy,
} from "./SourceControlToolUpdateLaunchNotification.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

const SOURCE_CONTROL_UPDATE_SUCCESS_VISIBLE_MS = 3_000;

const seenSourceControlToolNoticeSetKeys = new Set<string>();
type SourceControlToolNoticeToastId = ReturnType<typeof toastManager.add>;

interface ActiveSourceControlToolNoticeToast {
  /** "prompt" follows the notice set and closes when it changes; "update" owns a run and finishes on its own. */
  readonly kind: "prompt" | "update";
  readonly key: string;
  readonly toastId: SourceControlToolNoticeToastId;
}

interface SourceControlToolUpdateInProgress {
  readonly toastId: SourceControlToolNoticeToastId;
  readonly environmentId: EnvironmentId;
  readonly target: SourceControlToolUpdateTarget;
}

/**
 * Mirrors the server's job message ("Updating. Windows will ask for
 * permission…", "Checking installation.") into the running toast. Mounted only
 * while an update toast is up, so the setup poll runs only then.
 */
function SourceControlToolUpdateToastProgress({
  toastId,
  environmentId,
  target,
}: SourceControlToolUpdateInProgress) {
  const setup = useSourceControlSetup({ environmentId });
  const job = setup.tools.find((tool) => tool.target === target);
  const message = job && isSourceControlToolBusy(job.status) ? job.message : null;

  useEffect(() => {
    if (message) {
      toastManager.update(toastId, { description: message });
    }
  }, [message, toastId]);

  return null;
}

export function SourceControlToolUpdateLaunchNotification() {
  const navigate = useNavigate();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const discovery = useSourceControlDiscovery({ environmentId: activeEnvironmentId });
  const firstRunSetupPending = useActiveEnvironmentFirstRunSetupPending();
  const activeToastRef = useRef<ActiveSourceControlToolNoticeToast | null>(null);
  const [updateInProgress, setUpdateInProgress] =
    useState<SourceControlToolUpdateInProgress | null>(null);
  const { dismissedNotificationKeys, dismissNotificationKeys } =
    useDismissedSourceControlToolAdvisoryKeys();

  const notices = useMemo(() => {
    if (!activeEnvironmentId || !discovery.data) {
      return [];
    }
    return collectSourceControlToolUpdateNotices({
      discovery: discovery.data,
      environmentKey: `environment:${activeEnvironmentId}`,
    }).filter((notice) => !dismissedNotificationKeys.has(notice.dismissalKey));
  }, [activeEnvironmentId, discovery.data, dismissedNotificationKeys]);
  const noticeSetKey = useMemo(() => sourceControlToolUpdateNoticeSetKey(notices), [notices]);

  useEffect(() => {
    const activeToast = activeToastRef.current;
    if (activeToast?.kind === "prompt" && activeToast.key !== noticeSetKey) {
      toastManager.close(activeToast.toastId);
      activeToastRef.current = null;
    }

    if (
      noticeSetKey === null ||
      firstRunSetupPending ||
      activeToastRef.current !== null ||
      seenSourceControlToolNoticeSetKeys.has(noticeSetKey)
    ) {
      return;
    }

    seenSourceControlToolNoticeSetKeys.add(noticeSetKey);
    const dismissalKeys = notices.map((notice) => notice.dismissalKey);
    const directUpdateAction =
      notices.length === 1
        ? notices[0]!.advisory.actions.find((action) => action.kind === "runUpdate")
        : undefined;
    const copy = sourceControlToolUpdateToastCopy(notices);

    let toastId!: SourceControlToolNoticeToastId;
    const release = () => {
      if (activeToastRef.current?.toastId === toastId) {
        activeToastRef.current = null;
      }
    };
    const dismiss = () => {
      dismissNotificationKeys(dismissalKeys);
      release();
    };
    const openSettings = () => {
      dismiss();
      toastManager.close(toastId);
      void navigate({ to: "/settings/source-control" });
    };
    const runUpdate = () => {
      if (!directUpdateAction || !activeEnvironmentId) return;
      const notice = notices[0]!;
      const operation = directUpdateAction.operation;

      // The toast stays up as the progress surface, then finishes in place.
      // If the user closes it mid-run, the outcome still gets its own toast.
      let toastOpen = true;
      activeToastRef.current = { kind: "update", key: noticeSetKey, toastId };
      toastManager.update(toastId, {
        type: "loading",
        title: `${operation === "install" ? "Installing" : "Updating"} ${notice.label}`,
        description: "Checking the available update before starting.",
        timeout: 0,
        actionProps: undefined,
        data: {
          hideCopyButton: true,
          onClose: () => {
            toastOpen = false;
            release();
          },
        },
      });
      setUpdateInProgress({
        toastId,
        environmentId: activeEnvironmentId,
        target: directUpdateAction.target,
      });

      const finish = (options: Parameters<typeof toastManager.add>[0]) => {
        setUpdateInProgress(null);
        if (toastOpen) {
          toastManager.update(toastId, options);
        } else {
          toastManager.add(options);
        }
      };

      updateSourceControlTool({
        environmentId: activeEnvironmentId,
        target: directUpdateAction.target,
        ...(operation ? { operation } : {}),
      })
        .then((result) => {
          const outcome = sourceControlToolUpdateResultCopy({ label: notice.label, result });
          finish(
            outcome.type === "success"
              ? {
                  type: outcome.type,
                  title: outcome.title,
                  description: outcome.description,
                  timeout: 0,
                  actionProps: undefined,
                  data: {
                    hideCopyButton: true,
                    onClose: dismiss,
                    dismissAfterVisibleMs: SOURCE_CONTROL_UPDATE_SUCCESS_VISIBLE_MS,
                  },
                }
              : stackedThreadToast({
                  type: outcome.type,
                  title: outcome.title,
                  description: outcome.description,
                  timeout: 0,
                  actionProps: { children: "Settings", onClick: openSettings },
                  actionVariant: "outline",
                  data: { hideCopyButton: true, onClose: dismiss },
                }),
          );
        })
        .catch((error: unknown) => {
          const failure = sourceControlToolUpdateErrorCopy({
            label: notice.label,
            operation,
            error,
          });
          finish(
            stackedThreadToast({
              type: "error",
              title: failure.title,
              description: failure.description,
              timeout: 0,
              actionProps: { children: "Settings", onClick: openSettings },
              actionVariant: "outline",
              data: { hideCopyButton: true, onClose: dismiss },
            }),
          );
        });
    };

    toastId = toastManager.add(
      stackedThreadToast({
        type: copy.type,
        title: copy.title,
        description: copy.description,
        timeout: 0,
        actionProps: {
          children: directUpdateAction?.label ?? "Settings",
          onClick: directUpdateAction ? runUpdate : openSettings,
        },
        actionVariant: "outline",
        data: {
          hideCopyButton: true,
          onClose: dismiss,
        },
      }),
    );
    activeToastRef.current = { kind: "prompt", key: noticeSetKey, toastId };
  }, [dismissNotificationKeys, firstRunSetupPending, navigate, noticeSetKey, notices]);

  return updateInProgress ? <SourceControlToolUpdateToastProgress {...updateInProgress} /> : null;
}
