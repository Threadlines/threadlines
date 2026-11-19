/**
 * A project's brief on the web side (docs/design/project-brief-notes.md):
 * following each computer's briefs while the page that shows them is open,
 * saving one text on every computer that has the project, and the words that
 * say where it went. Each computer keeps its own briefs and counts its own
 * saves (`revision`), so every save names the revision this app last saw
 * there, and a save from behind another device's is refused, not lost.
 */
import type {
  EnvironmentId,
  ProjectBrief,
  ProjectBriefSetResult,
  ProjectContextSnapshot,
  ProjectId,
} from "@threadlines/contracts";
import { PROJECT_BRIEF_MAX_CHARS } from "@threadlines/contracts";
import type { PlaceId } from "@threadlines/shared/appPlaces";
import { useCallback, useEffect, useState } from "react";

import { nextPlaceArrivalHash } from "./appPlaceLinks";
import { usePrimaryEnvironmentDescriptor } from "./environments/primary";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
  useSavedEnvironmentRuntimeStore,
} from "./environments/runtime";

/** The place the brief's section is, which every way in opens. */
export const PROJECT_BRIEF_PLACE: PlaceId = "instructions.brief";

/** What the project menu, the palette and the lead's card call the way in. */
export const PROJECT_BRIEF_MENU_LABEL = "Project brief";

/** From here up, the page shows how many characters the brief has. */
export const PROJECT_BRIEF_COUNT_FROM = Math.round(PROJECT_BRIEF_MAX_CHARS * 0.9);

/**
 * Where Settings › Instructions opens on one project's brief: the project's
 * computer and folder in the search (usePlaceScopeArrival picks it), and an
 * arrival at the section.
 */
export function projectBriefLocation(project: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}) {
  return {
    to: "/settings/instructions" as const,
    search: { environment: project.environmentId, project: project.cwd },
    hash: nextPlaceArrivalHash(PROJECT_BRIEF_PLACE),
    // The hash names a place, not an element id; usePlaceArrival scrolls.
    hashScrollIntoView: false,
  };
}

/**
 * Whether a computer's server keeps briefs (the `projectContext` capability),
 * as its server last said; again when that changes. An older Threadlines, or
 * one that hasn't said yet, is a no.
 */
export function useProjectBriefSupport(): (environmentId: EnvironmentId) => boolean {
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const runtimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  return useCallback(
    (environmentId) =>
      primaryDescriptor?.environmentId === environmentId
        ? primaryDescriptor.capabilities.projectContext === true
        : runtimeById[environmentId]?.descriptor?.capabilities.projectContext === true,
    [primaryDescriptor, runtimeById],
  );
}

/** A project's brief on one computer, or the empty one a computer without it would answer. */
export function briefIn(
  snapshot: ProjectContextSnapshot | undefined,
  projectId: ProjectId,
): ProjectBrief | null {
  if (snapshot === undefined) return null;
  return (
    snapshot.briefs.find((brief) => brief.projectId === projectId) ?? {
      projectId,
      text: "",
      revision: 0,
      updatedAt: null,
    }
  );
}

/**
 * Each listed computer's latest briefs, followed while mounted. A computer
 * whose connection is replaced (a reconnect) is followed again on the new
 * one; one that drops keeps its last snapshot until it comes back.
 */
export function useProjectBriefSnapshots(
  environmentIds: readonly EnvironmentId[],
): Readonly<Record<string, ProjectContextSnapshot>> {
  const [byEnvironment, setByEnvironment] = useState<Record<string, ProjectContextSnapshot>>({});
  const environmentKey = environmentIds.join("\0");

  useEffect(() => {
    const ids = (environmentKey === "" ? [] : environmentKey.split("\0")) as EnvironmentId[];
    const active = new Map<
      EnvironmentId,
      { readonly connection: object; readonly unsubscribe: () => void }
    >();
    const sync = () => {
      for (const environmentId of ids) {
        const connection = readEnvironmentConnection(environmentId);
        const current = active.get(environmentId);
        if (current?.connection === connection) continue;
        current?.unsubscribe();
        active.delete(environmentId);
        if (!connection) continue;
        active.set(environmentId, {
          connection,
          unsubscribe: connection.client.projectContext.subscribe((snapshot) =>
            setByEnvironment((previous) => ({ ...previous, [environmentId]: snapshot })),
          ),
        });
      }
    };
    sync();
    const stopWatching = subscribeEnvironmentConnections(sync);
    return () => {
      stopWatching();
      for (const entry of active.values()) entry.unsubscribe();
    };
  }, [environmentKey]);

  return byEnvironment;
}

/** One computer's copy of the project, as a save reaches it. */
export interface BriefTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** The computer's name as the app shows it. */
  readonly label: string;
  /** Its server keeps briefs (the `projectContext` capability), as far as this app knows. */
  readonly supported: boolean;
}

/** What one computer did with a save. */
export type BriefSaveOutcome =
  | { readonly kind: "saved"; readonly label: string; readonly brief: ProjectBrief }
  | { readonly kind: "stale"; readonly label: string; readonly brief: ProjectBrief }
  | { readonly kind: "offline"; readonly label: string }
  | { readonly kind: "unsupported"; readonly label: string }
  | { readonly kind: "failed"; readonly label: string; readonly detail: string };

/**
 * Saves a brief on one computer, sending the revision this app last saw
 * there. Never throws: what happened is the outcome.
 */
export async function saveBriefOn(
  target: BriefTarget,
  text: string,
  expectedRevision: number,
): Promise<BriefSaveOutcome> {
  const { label } = target;
  // Offline first: a computer not reached since the app started hasn't said
  // what it supports either.
  const connection = readEnvironmentConnection(target.environmentId);
  if (connection === null) return { kind: "offline", label };
  if (!target.supported) return { kind: "unsupported", label };
  let result: ProjectBriefSetResult;
  try {
    result = await connection.client.projectContext.setBrief({
      projectId: target.projectId,
      text,
      expectedRevision,
    });
  } catch (error) {
    return {
      kind: "failed",
      label,
      detail: error instanceof Error && error.message.length > 0 ? error.message : "It failed.",
    };
  }
  return { kind: result.outcome, label, brief: result.brief };
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** A computer's name inside a sentence: the generic "This device" reads as "this device". */
export function computerInSentence(label: string): string {
  return label === "This device" ? "this device" : label;
}

/**
 * The line under the box after a save: where it went, then each computer it
 * didn't reach and why ("Saved on this device and Studio. Not saved on
 * Laptop. It is offline.").
 */
export function describeBriefSave(outcomes: readonly BriefSaveOutcome[]): string {
  const unique = (labels: readonly string[]) =>
    labels.filter((label, index) => labels.indexOf(label) === index).map(computerInSentence);
  const saved = unique(outcomes.filter((o) => o.kind === "saved").map((o) => o.label));
  const parts: string[] = [];
  if (saved.length > 0) parts.push(`Saved on ${joinNames(saved)}.`);
  for (const outcome of outcomes) {
    const where = computerInSentence(outcome.label);
    switch (outcome.kind) {
      case "saved":
        break;
      case "offline":
        parts.push(`Not saved on ${where}. It is offline.`);
        break;
      case "unsupported":
        parts.push(`Not saved on ${where}. Update Threadlines there to keep a brief.`);
        break;
      case "stale":
        parts.push(`Not saved on ${where}. Its brief changed there first.`);
        break;
      case "failed":
        parts.push(`Not saved on ${where}. ${outcome.detail}`);
        break;
    }
  }
  return parts.join(" ");
}
