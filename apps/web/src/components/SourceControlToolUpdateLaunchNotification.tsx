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
  collectSourceControlToolUpdateWarnings,
  sourceControlToolUpdateWarningSetKey,
} from "./SourceControlToolUpdateLaunchNotification.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

const seenSourceControlToolWarningSetKeys = new Set<string>();
type SourceControlToolWarningToastId = ReturnType<typeof toastManager.add>;

interface ActiveSourceControlToolWarningToast {
  readonly key: string;
  readonly toastId: SourceControlToolWarningToastId;
}

export function SourceControlToolUpdateLaunchNotification() {
  const navigate = useNavigate();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const discovery = useSourceControlDiscovery({ environmentId: activeEnvironmentId });
  const firstRunSetupPending = useActiveEnvironmentFirstRunSetupPending();
  const activeToastRef = useRef<ActiveSourceControlToolWarningToast | null>(null);
  const { dismissedNotificationKeys, dismissNotificationKeys } =
    useDismissedSourceControlToolAdvisoryKeys();

  const warnings = useMemo(() => {
    if (!activeEnvironmentId || !discovery.data) {
      return [];
    }
    return collectSourceControlToolUpdateWarnings({
      discovery: discovery.data,
      environmentKey: `environment:${activeEnvironmentId}`,
    }).filter((warning) => !dismissedNotificationKeys.has(warning.dismissalKey));
  }, [activeEnvironmentId, discovery.data, dismissedNotificationKeys]);
  const warningSetKey = useMemo(() => sourceControlToolUpdateWarningSetKey(warnings), [warnings]);

  useEffect(() => {
    const activeToast = activeToastRef.current;
    if (activeToast && activeToast.key !== warningSetKey) {
      toastManager.close(activeToast.toastId);
      activeToastRef.current = null;
    }

    if (
      warningSetKey === null ||
      firstRunSetupPending ||
      activeToastRef.current !== null ||
      seenSourceControlToolWarningSetKeys.has(warningSetKey)
    ) {
      return;
    }

    seenSourceControlToolWarningSetKeys.add(warningSetKey);
    const dismissalKeys = warnings.map((warning) => warning.dismissalKey);
    const labels = warnings.map((warning) => warning.label).join(" and ");
    const directUpdateAction =
      warnings.length === 1
        ? warnings[0]!.advisory.actions.find((action) => action.kind === "runUpdate")
        : undefined;
    const title =
      warnings.length === 1
        ? `${warnings[0]!.label} update recommended`
        : `${warnings.length} source control updates recommended`;
    const description =
      warnings.length === 1
        ? (warnings[0]!.advisory.message ?? "A source control tool update is recommended.")
        : `${labels} should be updated for a known security or reliability issue.`;

    let toastId!: SourceControlToolWarningToastId;
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
      const warning = warnings[0]!;
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
                ? `${warning.label} updated`
                : result.status === "started"
                  ? `${warning.label} update started`
                  : `${warning.label} is unchanged`,
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
              title: `Could not update ${warning.label}`,
              description:
                error instanceof Error ? error.message : "The verified update command failed.",
            }),
          );
        });
    };

    toastId = toastManager.add(
      stackedThreadToast({
        type: "warning",
        title,
        description,
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
    activeToastRef.current = { key: warningSetKey, toastId };
  }, [dismissNotificationKeys, firstRunSetupPending, navigate, warningSetKey, warnings]);

  return null;
}
