/**
 * Where a user is in setup, per environment, kept across reloads and
 * relaunches. Desktop reopens at its own start address rather than the last
 * URL, so the step in the address bar alone cannot resume setup.
 *
 * Picks are stored once the user has touched them, so a resumed setup shows
 * their choice rather than a fresh scan's. They last only as long as the
 * visit: leaving setup forgets them, and finishing clears the whole entry.
 *
 * @module setupProgress
 */
import type { EnvironmentId } from "@threadlines/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

export const SETUP_PROGRESS_STORAGE_KEY = "threadlines:agent-setup-progress:v1";

const SetupProgressEntrySchema = Schema.Struct({
  step: Schema.Literals(["agents", "connect", "folder"]),
  /** Driver kinds the user picked; absent until they touched a tile. */
  picks: Schema.optional(Schema.Array(Schema.String)),
  connectSkipped: Schema.Boolean,
  /** The folder chosen on the Folder step, when it isn't the workspace's first. */
  projectId: Schema.optional(Schema.String),
});

export type SetupProgressEntry = typeof SetupProgressEntrySchema.Type;

const SetupProgressDocumentSchema = Schema.Struct({
  byEnvironmentId: Schema.Record(Schema.String, SetupProgressEntrySchema),
});

type SetupProgressDocument = typeof SetupProgressDocumentSchema.Type;

function readDocument(): SetupProgressDocument {
  try {
    return (
      getLocalStorageItem(SETUP_PROGRESS_STORAGE_KEY, SetupProgressDocumentSchema) ?? {
        byEnvironmentId: {},
      }
    );
  } catch {
    return { byEnvironmentId: {} };
  }
}

function writeDocument(document: SetupProgressDocument): void {
  try {
    setLocalStorageItem(SETUP_PROGRESS_STORAGE_KEY, document, SetupProgressDocumentSchema);
  } catch {
    // Best-effort: losing progress only means starting setup from the top.
  }
}

const INITIAL_SETUP_PROGRESS: SetupProgressEntry = {
  step: "agents",
  connectSkipped: false,
};

interface SetupProgressStore {
  readonly byEnvironmentId: Readonly<Record<string, SetupProgressEntry>>;
  readonly update: (environmentId: EnvironmentId, patch: Partial<SetupProgressEntry>) => void;
  readonly clear: (environmentId: EnvironmentId) => void;
  /** Drops saved picks, leaving the step and folder; a no-op without an entry. */
  readonly forgetPicks: (environmentId: EnvironmentId) => void;
}

export const useSetupProgressStore = create<SetupProgressStore>((set, get) => ({
  byEnvironmentId: readDocument().byEnvironmentId,
  update: (environmentId, patch) => {
    const key = String(environmentId);
    const next = {
      ...get().byEnvironmentId,
      [key]: { ...(get().byEnvironmentId[key] ?? INITIAL_SETUP_PROGRESS), ...patch },
    };
    writeDocument({ byEnvironmentId: next });
    set({ byEnvironmentId: next });
  },
  clear: (environmentId) => {
    const key = String(environmentId);
    if (!(key in get().byEnvironmentId)) return;
    const { [key]: _removed, ...rest } = get().byEnvironmentId;
    writeDocument({ byEnvironmentId: rest });
    set({ byEnvironmentId: rest });
  },
  forgetPicks: (environmentId) => {
    const key = String(environmentId);
    const entry = get().byEnvironmentId[key];
    if (entry?.picks === undefined) return;
    const { picks: _picks, ...rest } = entry;
    const next = { ...get().byEnvironmentId, [key]: rest };
    writeDocument({ byEnvironmentId: next });
    set({ byEnvironmentId: next });
  },
}));

export function useSetupProgress(environmentId: EnvironmentId | null): SetupProgressEntry {
  return useSetupProgressStore((store) =>
    environmentId
      ? (store.byEnvironmentId[String(environmentId)] ?? INITIAL_SETUP_PROGRESS)
      : INITIAL_SETUP_PROGRESS,
  );
}
