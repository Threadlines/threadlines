import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@threadlines/client-runtime";
import {
  type EnvironmentId,
  type ModelSelection,
  RELAY_DEVICE_SESSION_SUBJECT,
} from "@threadlines/contracts";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useComputerLinksStore } from "../../environments/links/computerLinks";
import {
  usePrimaryEnvironmentDescriptor,
  usePrimaryEnvironmentId,
} from "../../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { useAuthAccess, usePrimarySessionAccess } from "../../hooks/useAuthAccess";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { useThreadSeenSources } from "../../lib/threadInboxSync";
import { getWsConnectionUiState, useWsConnectionStatus } from "../../rpc/wsConnectionState";
import {
  type AppState,
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../../store";
import type { SidebarThreadSummary } from "../../types";
import { resolveSeenThreadStatus, resolveThreadAttention } from "../Sidebar.logic";
import {
  buildFleetModel,
  type FleetComputerInput,
  type FleetConnection,
  type FleetGlyph,
  type FleetModel,
  type FleetThreadInput,
  glyphForPlatform,
  linkedDeviceInputs,
  primaryConnectionFrom,
  savedComputerInput,
} from "./fleet.logic";
import {
  buildFleetDirectory,
  buildFleetGraphEdges,
  collectFleetCrossWork,
  crossWorkAttentionOf,
  type FleetCrossWorkThread,
  type FleetDirectoryEntry,
  type FleetGraphEdge,
  type FleetLinkReach,
  type FleetLinksByEnvironment,
  trustedOriginEnvironment,
} from "./fleetLinks.logic";

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

/** A computer's glyph from the system name a link reports ("macOS", "Windows", "Linux"). */
function glyphForLinkPlatform(platform: string | null): FleetGlyph {
  const name = platform?.toLowerCase() ?? "";
  if (name.includes("mac") || name === "darwin") return "laptop";
  if (name.includes("linux")) return "server";
  return "monitor";
}

/**
 * A linked computer this app doesn't connect to, as the graph draws it: its
 * connection is the best any of its links reports.
 */
function linkedComputerInput(
  entry: FleetDirectoryEntry,
  links: FleetLinksByEnvironment,
): FleetComputerInput {
  let connection: FleetConnection = "offline";
  let platform: string | null = null;
  for (const holder of Object.values(links)) {
    for (const link of holder.snapshot.outbound) {
      if (link.remoteEnvironmentId !== entry.environmentId) continue;
      platform ??= link.remotePlatform;
      if (!holder.live || link.state !== "active") continue;
      if (link.connection === "connected" || link.connection === "idle") connection = "connected";
      else if (
        connection !== "connected" &&
        (link.connection === "connecting" || link.connection === "reconnecting")
      ) {
        connection = "reconnecting";
      }
    }
    for (const link of holder.snapshot.inbound) {
      if (link.environmentId === entry.environmentId) platform ??= link.platform;
    }
  }
  return {
    id: entry.key,
    environmentId: entry.environmentId,
    kind: "linked",
    label: entry.label,
    linkedWith: entry.linkedWith,
    glyph: glyphForLinkPlatform(platform),
    connection,
    route: null,
    lastSeenAt: null,
  };
}

export interface FleetData {
  readonly model: FleetModel;
  /** The list of computers beside the rail, this one first. */
  readonly directory: readonly FleetDirectoryEntry[];
  /** The graph's lines between computers. */
  readonly edges: readonly FleetGraphEdge[];
  /** What this app can do with each computer's links right now, by environment id. */
  readonly reach: ReadonlyMap<EnvironmentId, FleetLinkReach>;
  /** Each connected computer's links, last heard. */
  readonly links: FleetLinksByEnvironment;
  /** Each listed thread's summary, for the status words its row shares with the inbox. */
  readonly summaryByThreadKey: ReadonlyMap<string, SidebarThreadSummary>;
  /** Whether this window may manage this computer's devices. */
  readonly isOwner: boolean;
  /** Phones, tablets, browsers and linked computers with access to this computer (owner only). */
  readonly deviceCount: number;
  /**
   * Threads `asker`'s agents started on `worker` that are still running,
   * among the threads this app can see.
   */
  readonly runningStartedBy: (asker: EnvironmentId, worker: EnvironmentId) => number;
}

/**
 * The Fleet page's data, from what this app already holds: this computer and
 * the computers saved in this app with their live connection state, every
 * computer they are linked with, the phones and tablets using this computer
 * (its owner only), every connected computer's threads and links, and the
 * work computers asked of each other.
 */
export function useFleetModel(): FleetData {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const savedRecords = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedRuntime = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const links = useComputerLinksStore((state) => state.byEnvironmentId);
  const { role } = usePrimarySessionAccess(primaryEnvironmentId !== null);
  const isOwner = role === "owner";
  const { clientSessions } = useAuthAccess(isOwner);
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const modelSelections = useStore(useShallow(selectThreadModelSelections));
  const seenSources = useThreadSeenSources();
  const isMobile = useIsMobile();
  // This computer's own link: the state the connection banner shows.
  const wsStatus = useWsConnectionStatus();
  const primaryConnection = primaryConnectionFrom(getWsConnectionUiState(wsStatus));
  const primaryLastSeenAt = wsStatus.disconnectedAt;

  const labelOfEnvironment = useMemo(() => {
    const labels = new Map<string, string>();
    for (const record of Object.values(savedRecords)) {
      labels.set(record.environmentId, record.label.trim() || record.environmentId);
    }
    if (primaryEnvironmentId !== null) {
      labels.set(primaryEnvironmentId, primaryDescriptor?.label ?? "This computer");
    }
    return labels;
  }, [primaryDescriptor?.label, primaryEnvironmentId, savedRecords]);

  const directory = useMemo(
    () =>
      buildFleetDirectory({
        primary:
          primaryEnvironmentId === null
            ? null
            : {
                environmentId: primaryEnvironmentId,
                label: primaryDescriptor?.label ?? "This computer",
              },
        saved: Object.values(savedRecords).map((record) => ({
          environmentId: record.environmentId,
          label:
            record.label.trim() ||
            savedRuntime[record.environmentId]?.descriptor?.label ||
            "Computer",
        })),
        links,
      }),
    [links, primaryDescriptor?.label, primaryEnvironmentId, savedRecords, savedRuntime],
  );

  const reach = useMemo(() => {
    const byEnvironment = new Map<EnvironmentId, FleetLinkReach>();
    for (const entry of directory) {
      if (entry.environmentId === null) continue;
      const environmentId = entry.environmentId;
      const runtime = savedRuntime[environmentId];
      const descriptor = entry.kind === "this" ? primaryDescriptor : (runtime?.descriptor ?? null);
      byEnvironment.set(environmentId, {
        environmentId,
        label: entry.displayLabel,
        reachable:
          entry.kind === "this"
            ? primaryConnection === "connected"
            : entry.kind === "saved" && runtime?.connectionState === "connected",
        known: entry.kind === "this" || entry.kind === "saved",
        supportsLinks: descriptor === null ? null : descriptor.capabilities.computerLinks === true,
        links: links[environmentId] ?? null,
      });
    }
    return byEnvironment;
  }, [directory, links, primaryConnection, primaryDescriptor, savedRuntime]);

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
      const origin = thread.remoteOrigin ?? null;
      const asker =
        origin === null ? null : trustedOriginEnvironment(origin, thread.environmentId, links);
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
            origin !== null
              ? origin.threadTitle
              : thread.parentThreadId == null
                ? null
                : (titleByThreadKey.get(
                    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.parentThreadId)),
                  ) ?? null),
          startedByComputer:
            origin === null
              ? null
              : ((asker === null ? undefined : labelOfEnvironment.get(asker)) ??
                origin.environmentLabel),
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
            connection: primaryConnection,
            route: null,
            lastSeenAt: primaryConnection === "connected" ? null : primaryLastSeenAt,
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
    const linkedComputers = directory
      .filter((entry) => entry.kind === "linked")
      .map((entry) => linkedComputerInput(entry, links));
    return buildFleetModel({
      center,
      others: [
        ...savedComputers,
        ...linkedComputers,
        ...linkedDeviceInputs(clientSessions, RELAY_DEVICE_SESSION_SUBJECT),
      ],
      threads: threadInputs,
    });
  }, [
    clientSessions,
    directory,
    isMobile,
    labelOfEnvironment,
    links,
    modelSelections,
    primaryConnection,
    primaryDescriptor,
    primaryEnvironmentId,
    primaryLastSeenAt,
    projects,
    savedRecords,
    savedRuntime,
    seenSources,
    threads,
  ]);

  // Work computers asked of each other: the real threads first (their status
  // wins), then what parents remember of children this app can't see.
  const crossWorkThreads = useMemo(() => {
    const attentionByKey = new Map<string, "working" | "needs-you" | null>();
    for (const computer of [model.center, ...model.others]) {
      for (const thread of computer.threads) attentionByKey.set(thread.threadKey, thread.attention);
    }
    const real: FleetCrossWorkThread[] = [];
    const remembered: FleetCrossWorkThread[] = [];
    for (const thread of threads) {
      if (thread.archivedAt !== null) continue;
      const origin = thread.remoteOrigin ?? null;
      // Work over a link whose computer isn't confirmed is drawn to no computer.
      const asker =
        origin === null ? null : trustedOriginEnvironment(origin, thread.environmentId, links);
      if (asker !== null) {
        real.push({
          askerEnvironmentId: asker,
          workerEnvironmentId: thread.environmentId,
          threadId: thread.id,
          attention:
            attentionByKey.get(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))) ??
            null,
        });
      }
      for (const child of thread.remoteChildren ?? []) {
        remembered.push({
          askerEnvironmentId: thread.environmentId,
          workerEnvironmentId: child.environmentId,
          threadId: child.threadId,
          attention: crossWorkAttentionOf(child.cachedStatus),
        });
      }
      for (const start of thread.remoteChildStarts ?? []) {
        remembered.push({
          askerEnvironmentId: thread.environmentId,
          workerEnvironmentId: start.environmentId,
          threadId: `start:${start.requestId}`,
          attention: start.status === "awaiting_approval" ? "needs-you" : "working",
        });
      }
    }
    return [...real, ...remembered];
  }, [links, model, threads]);

  const edges = useMemo(
    () =>
      buildFleetGraphEdges({
        model,
        links,
        crossWork: collectFleetCrossWork(crossWorkThreads),
      }),
    [crossWorkThreads, links, model],
  );

  const runningStartedBy = useMemo(() => {
    const counts = new Map<string, number>();
    const seen = new Set<string>();
    for (const thread of crossWorkThreads) {
      // Threads that exist and run (a start still waiting has no thread to stop),
      // each once: the real thread comes before its parent's record of it.
      const threadKey = `${thread.workerEnvironmentId}:${thread.threadId}`;
      if (seen.has(threadKey)) continue;
      seen.add(threadKey);
      if (thread.threadId.startsWith("start:") || thread.attention !== "working") continue;
      const key = `${thread.askerEnvironmentId}>${thread.workerEnvironmentId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return (asker: EnvironmentId, worker: EnvironmentId) => counts.get(`${asker}>${worker}`) ?? 0;
  }, [crossWorkThreads]);

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

  const deviceCount = useMemo(
    () => clientSessions.filter((session) => !session.current).length,
    [clientSessions],
  );

  return useMemo(
    () => ({
      model,
      directory,
      edges,
      reach,
      links,
      summaryByThreadKey,
      isOwner,
      deviceCount,
      runningStartedBy,
    }),
    [
      deviceCount,
      directory,
      edges,
      isOwner,
      links,
      model,
      reach,
      runningStartedBy,
      summaryByThreadKey,
    ],
  );
}
