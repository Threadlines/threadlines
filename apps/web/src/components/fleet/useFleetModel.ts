import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@threadlines/client-runtime";
import {
  type ExecutionEnvironmentDescriptor,
  type ModelSelection,
  RELAY_DEVICE_SESSION_SUBJECT,
} from "@threadlines/contracts";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  usePrimaryEnvironmentDescriptor,
  usePrimaryEnvironmentId,
} from "../../environments/primary";
import {
  type SavedEnvironmentRecord,
  type SavedEnvironmentRuntimeState,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { useAuthAccess, usePrimarySessionAccess } from "../../hooks/useAuthAccess";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { useThreadSeenSources } from "../../lib/threadInboxSync";
import {
  type AppState,
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../../store";
import type { ServerClientSessionRecord } from "../../environments/primary";
import type { SidebarThreadSummary } from "../../types";
import { resolveSeenThreadStatus, resolveThreadAttention } from "../Sidebar.logic";
import {
  buildFleetModel,
  type FleetComputerInput,
  type FleetConnection,
  type FleetGlyph,
  type FleetModel,
  type FleetThreadInput,
} from "./fleet.logic";

function glyphForPlatform(descriptor: ExecutionEnvironmentDescriptor | null): FleetGlyph {
  switch (descriptor?.platform.os) {
    case "darwin":
      return "laptop";
    case "linux":
      return "server";
    default:
      return "monitor";
  }
}

function savedComputerInput(
  record: SavedEnvironmentRecord,
  runtime: SavedEnvironmentRuntimeState | undefined,
): FleetComputerInput {
  const connectionState = runtime?.connectionState ?? "disconnected";
  const connection: FleetConnection =
    connectionState === "connected"
      ? "connected"
      : connectionState === "connecting" || runtime?.waitingToReconnect === true
        ? "reconnecting"
        : "offline";
  return {
    id: record.environmentId,
    environmentId: record.environmentId,
    kind: "computer",
    label: runtime?.descriptor?.label ?? record.label,
    glyph: glyphForPlatform(runtime?.descriptor ?? null),
    connection,
    route:
      runtime?.route === "direct"
        ? "network"
        : runtime?.route === "relay"
          ? "relay"
          : record.desktopSsh
            ? "ssh"
            : null,
    lastSeenAt: runtime?.disconnectedAt ?? record.lastConnectedAt,
  };
}

function deviceLabel(session: ServerClientSessionRecord): string {
  return (
    session.client.label ??
    ([session.client.os, session.client.browser].filter(Boolean).join(" · ") ||
      (session.client.deviceType === "tablet" ? "Tablet" : "Phone"))
  );
}

/**
 * The phones and tablets linked to this computer, one node each: a device
 * that paired more than once shows once, as its most recent session.
 */
function linkedDeviceInputs(
  sessions: ReadonlyArray<ServerClientSessionRecord>,
): FleetComputerInput[] {
  const byLabel = new Map<string, FleetComputerInput>();
  for (const session of sessions) {
    if (session.current) continue;
    if (session.client.deviceType !== "mobile" && session.client.deviceType !== "tablet") continue;
    const label = deviceLabel(session);
    const existing = byLabel.get(label);
    // Sessions arrive connected first, then newest first: keep the first seen.
    if (existing) continue;
    byLabel.set(label, {
      id: `device:${session.sessionId}`,
      environmentId: null,
      kind: "device",
      label,
      glyph: session.client.deviceType === "tablet" ? "tablet" : "phone",
      connection: session.connected ? "connected" : "offline",
      route: session.subject === RELAY_DEVICE_SESSION_SUBJECT ? "relay" : "network",
      lastSeenAt: session.lastConnectedAt,
    });
  }
  return [...byLabel.values()];
}

/** Every thread's model, by scoped thread key; references are stable, so a shallow compare holds. */
function selectThreadModelSelections(state: AppState): Record<string, ModelSelection> {
  const byKey: Record<string, ModelSelection> = {};
  for (const [environmentId, environment] of Object.entries(state.environmentStateById)) {
    for (const shell of Object.values(environment.threadShellById)) {
      if (shell.archivedAt !== null) continue;
      byKey[`${environmentId}:${shell.id}`] = shell.modelSelection;
    }
  }
  return byKey;
}

/**
 * The Fleet page's model, from what this app already holds: this computer and
 * the computers saved under Settings › Connections with their live connection
 * state, the phones and tablets linked to this computer (its owner only), and
 * every connected computer's threads.
 */
export function useFleetModel(): {
  readonly model: FleetModel;
  /** Each listed thread's summary, for the status words its row shares with the inbox. */
  readonly summaryByThreadKey: ReadonlyMap<string, SidebarThreadSummary>;
  /** Whether this window may manage this computer's devices (the Connect dialog). */
  readonly isOwner: boolean;
} {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const savedRecords = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedRuntime = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const { role } = usePrimarySessionAccess(primaryEnvironmentId !== null);
  const isOwner = role === "owner";
  const { clientSessions } = useAuthAccess(isOwner);
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const modelSelections = useStore(useShallow(selectThreadModelSelections));
  const seenSources = useThreadSeenSources();
  const isMobile = useIsMobile();

  const model = useMemo(() => {
    const projectByKey = new Map(
      projects.map(
        (project) =>
          [scopedProjectKey(scopeProjectRef(project.environmentId, project.id)), project] as const,
      ),
    );
    const titleByThreadKey = new Map(
      threads.map(
        (thread) =>
          [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread.title] as const,
      ),
    );
    const threadInputs = threads.flatMap((thread): FleetThreadInput[] => {
      if (thread.archivedAt !== null) return [];
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const { lastVisitedAt, status } = resolveSeenThreadStatus(thread, threadKey, seenSources);
      const attention = resolveThreadAttention(
        { ...thread, ...(lastVisitedAt !== undefined ? { lastVisitedAt } : {}) },
        status,
      );
      const session = thread.session;
      const modelSelection = modelSelections[`${thread.environmentId}:${thread.id}`] ?? null;
      const instanceId = session?.providerInstanceId ?? modelSelection?.instanceId ?? null;
      const driverKind = session?.provider ?? "";
      const project = projectByKey.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      return [
        {
          threadKey,
          environmentId: thread.environmentId,
          threadId: thread.id,
          title: thread.title,
          projectLabel: project
            ? project.kind === "general-chat"
              ? "General chat"
              : project.name
            : null,
          status,
          attention,
          sessionLive:
            session !== null &&
            (session.status === "ready" ||
              session.status === "running" ||
              session.status === "connecting"),
          provider: instanceId === null && driverKind === "" ? null : { instanceId, driverKind },
          modelSelection,
          startedByTitle:
            thread.parentThreadId == null
              ? null
              : (titleByThreadKey.get(
                  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.parentThreadId)),
                ) ?? null),
        },
      ];
    });

    const center: FleetComputerInput =
      primaryEnvironmentId !== null
        ? {
            id: primaryEnvironmentId,
            environmentId: primaryEnvironmentId,
            kind: "this",
            label: primaryDescriptor?.label ?? "This computer",
            glyph: glyphForPlatform(primaryDescriptor),
            connection: "connected",
            route: null,
            lastSeenAt: null,
          }
        : {
            // The phone app has no server of its own: it is the device in
            // hand, and every computer is one it connects to.
            id: "this-device",
            environmentId: null,
            kind: "this",
            label: isMobile ? "This phone" : "This device",
            glyph: isMobile ? "phone" : "laptop",
            connection: "connected",
            route: null,
            lastSeenAt: null,
          };
    const savedComputers = Object.values(savedRecords)
      .filter((record) => record.environmentId !== primaryEnvironmentId)
      .map((record) => savedComputerInput(record, savedRuntime[record.environmentId]));
    return buildFleetModel({
      center,
      others: [...savedComputers, ...linkedDeviceInputs(clientSessions)],
      threads: threadInputs,
    });
  }, [
    clientSessions,
    isMobile,
    modelSelections,
    primaryDescriptor,
    primaryEnvironmentId,
    projects,
    savedRecords,
    savedRuntime,
    seenSources,
    threads,
  ]);

  const summaryByThreadKey = useMemo(
    () =>
      new Map(
        threads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [threads],
  );

  return { model, summaryByThreadKey, isOwner };
}
