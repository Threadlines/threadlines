import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";

import {
  updateSourceControlTool,
  useSourceControlDiscovery,
} from "../lib/sourceControlDiscoveryState";
import { useDismissedSourceControlToolAdvisoryKeys } from "../sourceControlToolAdvisoryDismissal";
import { useStore } from "../store";
import { useActiveEnvironmentFirstRunSetupPending } from "./chat/firstRunSetupState";
import {
  collectSourceControlToolUpdateNotices,
  sourceControlToolUpdateNoticeSetKey,
  sourceControlToolUpdateToastCopy,
} from "./SourceControlToolUpdateLaunchNotification.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

const seenSourceControlToolNoticeSetKeys = new Set<string>();
type SourceControlToolNoticeToastId = ReturnType<typeof toastManager.add>;

interface ActiveSourceControlToolNoticeToast {
  readonly key: string;
  readonly toastId: SourceControlToolNoticeToastId;
}

export function SourceControlToolUpdateLaunchNotification() {
  const navigate = useNavigate();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const discovery = useSourceControlDiscovery({ environmentId: activeEnvironmentId });
  const firstRunSetupPending = useActiveEnvironmentFirstRunSetupPending();
  const activeToastRef = useRef<ActiveSourceControlToolNoticeToast | null>(null);
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
    if (activeToast && activeToast.key !== noticeSetKey) {
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
    const dismiss = () => {
      dismissNotificationKeys(dismissalKeys);
      if (activeToastRef.current?.toastId === toastId) {
        activeToastRef.current = null;
      }
    };
    const openSettings = () => {
      dismiss();
      toastManager.close(toastId);
      void navigate({ to: "/settings/source-control" });
    };
    const runUpdate = () => {
      if (!directUpdateAction || !activeEnvironmentId) return;
      const notice = notices[0]!;
      dismiss();
      toastManager.close(toastId);

      void updateSourceControlTool({
        environmentId: activeEnvironmentId,
        target: directUpdateAction.target,
        ...(directUpdateAction.operation ? { operation: directUpdateAction.operation } : {}),
      })
        .then((result) => {
          toastManager.add({
            type: result.status === "succeeded" ? "success" : "info",
            title:
              result.status === "succeeded"
                ? `${notice.label} updated`
                : result.status === "started"
                  ? `${notice.label} update started`
                  : `${notice.label} is unchanged`,
            description:
              result.status === "succeeded"
                ? `${result.previousVersion ?? "Previous version"} to ${result.currentVersion ?? "updated"}`
                : result.status === "started"
                  ? "The official installer is running. Finish any Windows permission prompt, then check again."
                  : "The update command finished, but the detected version did not change.",
          });
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Could not update ${notice.label}`,
              description:
                error instanceof Error ? error.message : "The verified update command failed.",
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
    activeToastRef.current = { key: noticeSetKey, toastId };
  }, [dismissNotificationKeys, firstRunSetupPending, navigate, noticeSetKey, notices]);

  return null;
}
