/**
 * First-run setup card: what it says, when it shows, and when it stops.
 *
 * A brand-new install lands on an empty canvas with no guidance, even though
 * the client already holds everything needed to tell the user what is missing:
 * the provider snapshots Settings renders, and the project the server
 * bootstrapped from the launch folder (if any). This module turns those into
 * the rows the card draws, decides whether the card belongs on screen at all,
 * and owns the per-environment dismissal record.
 *
 * Which canvas depends on how Threadlines was started: `npx` bootstraps a
 * project from the launch folder and lands on a draft thread, while a fresh
 * desktop launch has no project and lands on the no-active-thread surface. See
 * `FirstRunSetupSurface`.
 *
 * Status language is borrowed from the settings page (`getProviderSummary`)
 * and the availability verdict from the model picker
 * (`getModelPickerProviderAvailability`), so a provider is never described one
 * way here and another way two clicks later.
 *
 * @module firstRunSetup
 */
import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@threadlines/contracts";
import { providerAuthReconnectCommand } from "@threadlines/shared/providerAuth";
import * as Schema from "effect/Schema";
import { useMemo } from "react";
import { create } from "zustand";

import {
  getLocalStorageItemWithLegacyKeys,
  setLocalStorageItem,
} from "../../hooks/useLocalStorage";
import { deriveProviderInstallView, type ProviderInstallView } from "../settings/providerInstall";
import {
  firstSentenceOf,
  getProviderSummary,
  getProviderVersionLabel,
  PROVIDER_STATUS_STYLES,
} from "../settings/providerStatus";
import { getModelPickerProviderAvailability } from "./modelPickerEmptyState";

export const FIRST_RUN_SETUP_DISMISSALS_STORAGE_KEY = "threadlines:first-run-setup-dismissals:v1";
/**
 * Empty today: this key was minted after the t3code rename, so nothing
 * predates it. Kept as the same shape the other dismissal records use so a
 * future key bump migrates without restructuring the reader.
 */
const LEGACY_FIRST_RUN_SETUP_DISMISSALS_STORAGE_KEYS: readonly string[] = [];

const FirstRunSetupDismissalsSchema = Schema.Struct({
  keys: Schema.Array(Schema.String),
});

type FirstRunSetupDismissals = typeof FirstRunSetupDismissalsSchema.Type;

export function buildFirstRunSetupDismissalKey(environmentId: EnvironmentId): string {
  return String(environmentId);
}

function readFirstRunSetupDismissals(): FirstRunSetupDismissals {
  try {
    return (
      getLocalStorageItemWithLegacyKeys(
        FIRST_RUN_SETUP_DISMISSALS_STORAGE_KEY,
        LEGACY_FIRST_RUN_SETUP_DISMISSALS_STORAGE_KEYS,
        FirstRunSetupDismissalsSchema,
      ) ?? { keys: [] }
    );
  } catch {
    return { keys: [] };
  }
}

function writeFirstRunSetupDismissals(document: FirstRunSetupDismissals): void {
  try {
    setLocalStorageItem(
      FIRST_RUN_SETUP_DISMISSALS_STORAGE_KEY,
      document,
      FirstRunSetupDismissalsSchema,
    );
  } catch {
    // Dismissal state is best-effort UI state; a storage failure must not
    // block the surface the user just asked to leave.
  }
}

export function isFirstRunSetupDismissed(dismissalKey: string | null | undefined): boolean {
  if (!dismissalKey) {
    return false;
  }
  return (
    useFirstRunSetupDismissalStore.getState().dismissedKeys.has(dismissalKey) ||
    readFirstRunSetupDismissals().keys.includes(dismissalKey)
  );
}

/**
 * The dismissal record, live.
 *
 * Storage alone is not enough: the card renders on two surfaces and the
 * provider-update prompt reads the same verdict, so "Skip for now" has to
 * reach every one of them in the same tick. A store does that; per-component
 * state would leave one surface showing a card the user just dismissed on
 * another.
 */
interface FirstRunSetupDismissalStore {
  readonly dismissedKeys: ReadonlySet<string>;
  readonly dismiss: (dismissalKey: string) => void;
}

export const useFirstRunSetupDismissalStore = create<FirstRunSetupDismissalStore>((set, get) => ({
  dismissedKeys: new Set(readFirstRunSetupDismissals().keys),
  dismiss: (dismissalKey) => {
    if (get().dismissedKeys.has(dismissalKey)) {
      return;
    }
    const document = readFirstRunSetupDismissals();
    if (!document.keys.includes(dismissalKey)) {
      writeFirstRunSetupDismissals({ keys: [...document.keys, dismissalKey] });
    }
    set((state) => ({ dismissedKeys: new Set(state.dismissedKeys).add(dismissalKey) }));
  },
}));

export function dismissFirstRunSetup(dismissalKey: string | null | undefined): void {
  if (!dismissalKey) {
    return;
  }
  useFirstRunSetupDismissalStore.getState().dismiss(dismissalKey);
}

/** Test seam: forgets in-memory dismissals so a suite can start from a cold install. */
export function resetFirstRunSetupDismissalsForTests(): void {
  useFirstRunSetupDismissalStore.setState({
    dismissedKeys: new Set(readFirstRunSetupDismissals().keys),
  });
}

/**
 * Reads this environment's dismissal, and writes one. Every caller shares the
 * store behind it, so skipping on one surface hides the card on all of them.
 */
export function useFirstRunSetupDismissal(environmentId: EnvironmentId | null | undefined): {
  readonly isDismissed: boolean;
  readonly dismiss: () => void;
} {
  const dismissalKey = environmentId ? buildFirstRunSetupDismissalKey(environmentId) : null;
  const isDismissed = useFirstRunSetupDismissalStore((store) =>
    dismissalKey === null ? false : store.dismissedKeys.has(dismissalKey),
  );
  const dismissKey = useFirstRunSetupDismissalStore((store) => store.dismiss);

  return useMemo(
    () => ({
      isDismissed,
      dismiss: () => {
        if (dismissalKey !== null) {
          dismissKey(dismissalKey);
        }
      },
    }),
    [dismissKey, dismissalKey, isDismissed],
  );
}

/**
 * The two empty canvases a cold start can land on.
 *
 * `npx` bootstraps a project from the launch folder, so it always lands on a
 * draft thread. A fresh desktop launch has no project at all and lands on the
 * no-active-thread canvas instead, which is why the card has to cover both.
 */
export type FirstRunSetupSurface =
  /** The draft thread's empty state, in place of "What's next in ...?". */
  | {
      readonly kind: "draftThread";
      readonly isDraftThread: boolean;
      readonly isGeneralChat: boolean;
    }
  /** The no-active-thread canvas, in place of "Start your first thread". */
  | { readonly kind: "noThread" };

/**
 * Whether this surface is a place the card belongs. A server thread is not
 * (the user is reading a conversation), and neither is a General Chat draft,
 * which has no project row to speak of.
 */
export function isFirstRunSetupSurfaceEligible(surface: FirstRunSetupSurface): boolean {
  return surface.kind === "noThread" || (surface.isDraftThread && !surface.isGeneralChat);
}

/**
 * Whether this environment is still in its first run, independent of which
 * surface is on screen.
 *
 * Every clause is a reason setup would be noise: a hosted phone has its own
 * pairing surface and no local provider to fix; an environment still
 * bootstrapping has not told us whether it has threads; an environment where
 * someone has already sent a message is not a first run; and a dismissal is
 * permanent.
 *
 * Split out from `shouldShowFirstRunSetupCard` because things that must stay
 * quiet during setup (the provider-update prompt) need the verdict without
 * caring which canvas the card is drawn on.
 */
export function isFirstRunSetupPending(input: {
  readonly isHostedStatic: boolean;
  readonly bootstrapComplete: boolean;
  readonly hasUserMessagedThread: boolean;
  readonly isDismissed: boolean;
}): boolean {
  return (
    !input.isHostedStatic &&
    input.bootstrapComplete &&
    !input.hasUserMessagedThread &&
    !input.isDismissed
  );
}

/** The card takes over an eligible empty canvas on a genuine cold start. */
export function shouldShowFirstRunSetupCard(
  input: {
    readonly surface: FirstRunSetupSurface;
  } & Parameters<typeof isFirstRunSetupPending>[0],
): boolean {
  return isFirstRunSetupSurfaceEligible(input.surface) && isFirstRunSetupPending(input);
}

/** What the user has to do next about one provider, if anything. */
export type FirstRunProviderRowState = "ready" | "needsSignIn" | "notInstalled";

/**
 * The slice of a `ProviderInstanceEntry` a row needs. Declared structurally so
 * entries pass through unchanged and tests can build a minimal fixture.
 */
export interface FirstRunSetupProvider {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly snapshot: ServerProvider;
}

export interface FirstRunProviderRow {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly name: string;
  readonly versionLabel: string | null;
  readonly description: string;
  readonly state: FirstRunProviderRowState;
  readonly dotClassName: string;
  /**
   * The driver's login command. Threadlines runs it for the user in a
   * server-side session rather than showing it, so this is really the test for
   * "can this driver be signed in from here": null means the row falls back to
   * the install guide instead of offering a sign-in that cannot run.
   */
  readonly signInCommand: string | null;
  /**
   * The one-click install Threadlines can run for a missing CLI, or null when
   * it cannot (the CLI is already there, or the server found no package
   * manager to install it with). Null is what sends the row back to the
   * install guide, so the two are never offered together.
   */
  readonly install: ProviderInstallView | null;
}

const PROVIDER_ROW_DOT_CLASS_NAMES: Record<FirstRunProviderRowState, string> = {
  ready: PROVIDER_STATUS_STYLES.ready.dot,
  needsSignIn: PROVIDER_STATUS_STYLES.warning.dot,
  notInstalled: PROVIDER_STATUS_STYLES.error.dot,
};

function providerRowState(snapshot: ServerProvider): FirstRunProviderRowState {
  switch (getModelPickerProviderAvailability(snapshot)) {
    case "available":
      return "ready";
    case "notInstalled":
      return "notInstalled";
    case "notAuthenticated":
      return "needsSignIn";
  }
}

/**
 * One line under the provider name. A signed-in provider names the account
 * plan the snapshot reported and nothing more (we never invent account
 * details); everything else reuses the settings page's headline and detail so
 * the two surfaces agree, with an action clause when the server gave no
 * detail of its own.
 */
function providerRowDescription(
  provider: FirstRunSetupProvider,
  state: FirstRunProviderRowState,
): string {
  if (state === "ready") {
    const authLabel = provider.snapshot.auth.label ?? provider.snapshot.auth.type ?? null;
    return authLabel ? `Signed in · ${authLabel}` : "Signed in";
  }

  const summary = getProviderSummary(provider.snapshot);
  const detail = firstSentenceOf(summary.detail);
  if (detail) {
    return `${summary.headline}. ${detail}`;
  }
  return state === "notInstalled"
    ? `${summary.headline}. Install ${provider.displayName}, then sign in.`
    : `${summary.headline}. Sign in to use ${provider.displayName} here.`;
}

/**
 * The card is a checklist, so rows are ordered by how close the provider is
 * to working: sign-in is one browser window away, an install is a bigger
 * ask, and a ready provider is just confirmation. Within a state, the
 * caller's (settings) order is kept.
 */
const PROVIDER_ROW_STATE_PRIORITY: Record<FirstRunProviderRowState, number> = {
  needsSignIn: 0,
  notInstalled: 1,
  ready: 2,
};

/** The card never grows past this many provider rows; the rest collapse. */
export const MAX_VISIBLE_FIRST_RUN_PROVIDER_ROWS = 3;

export interface FirstRunProviderRowGroups {
  readonly visible: ReadonlyArray<FirstRunProviderRow>;
  /**
   * Providers past the cap, least actionable last. Present only when there
   * are more providers than visible rows; the card renders them as a single
   * "More agents" row pointing at Settings so the checklist stays a
   * checklist no matter how many drivers a build ships.
   */
  readonly overflow: ReadonlyArray<FirstRunProviderRow> | null;
}

export function groupFirstRunProviderRows(
  rows: ReadonlyArray<FirstRunProviderRow>,
): FirstRunProviderRowGroups {
  if (rows.length <= MAX_VISIBLE_FIRST_RUN_PROVIDER_ROWS) {
    return { visible: rows, overflow: null };
  }
  return {
    visible: rows.slice(0, MAX_VISIBLE_FIRST_RUN_PROVIDER_ROWS),
    overflow: rows.slice(MAX_VISIBLE_FIRST_RUN_PROVIDER_ROWS),
  };
}

/**
 * One row per enabled provider instance, ordered by actionability (see
 * `PROVIDER_ROW_STATE_PRIORITY`). Disabled instances are left out: the user
 * turned them off, so they are not part of getting started.
 */
export function deriveFirstRunProviderRows(
  providers: ReadonlyArray<FirstRunSetupProvider>,
): ReadonlyArray<FirstRunProviderRow> {
  return providers
    .filter((provider) => provider.enabled)
    .map((provider) => {
      const state = providerRowState(provider.snapshot);
      return {
        instanceId: provider.instanceId,
        driverKind: provider.driverKind,
        name: provider.displayName,
        versionLabel: getProviderVersionLabel(provider.snapshot.version),
        description: providerRowDescription(provider, state),
        state,
        dotClassName: PROVIDER_ROW_DOT_CLASS_NAMES[state],
        signInCommand:
          state === "needsSignIn"
            ? (providerAuthReconnectCommand(provider.driverKind) ?? null)
            : null,
        install: state === "notInstalled" ? deriveProviderInstallView(provider.snapshot) : null,
      } satisfies FirstRunProviderRow;
    })
    .toSorted(
      (left, right) =>
        PROVIDER_ROW_STATE_PRIORITY[left.state] - PROVIDER_ROW_STATE_PRIORITY[right.state],
    );
}

export type FirstRunProjectRowState = "ready" | "missing";

export interface FirstRunProjectRow {
  readonly state: FirstRunProjectRowState;
  readonly description: string;
  readonly dotClassName: string;
  readonly actionLabel: string;
}

/**
 * The folder row. "The folder you launched from" is only claimed when this is
 * the workspace's one and only project, which is exactly the shape the
 * server's launch-folder bootstrap leaves behind; anything else shows the path
 * instead of asserting something we cannot check from the client.
 */
export function deriveFirstRunProjectRow(input: {
  readonly projectName: string | null | undefined;
  readonly projectCwd: string | null | undefined;
  readonly isOnlyWorkspaceProject: boolean;
}): FirstRunProjectRow {
  const name = input.projectName?.trim();
  if (!name) {
    return {
      state: "missing",
      description: "No folder yet. Pick the repository you want to work in.",
      dotClassName: PROVIDER_STATUS_STYLES.warning.dot,
      actionLabel: "Choose a folder",
    };
  }

  const cwd = input.projectCwd?.trim();
  return {
    state: "ready",
    description: input.isOnlyWorkspaceProject
      ? `${name} · the folder you launched from`
      : cwd
        ? `${name} · ${cwd}`
        : name,
    dotClassName: PROVIDER_STATUS_STYLES.ready.dot,
    actionLabel: "Change",
  };
}

/**
 * "Start first thread" needs a provider that can actually serve a turn and a
 * folder to serve it in. Anything less would hand the user straight back to
 * the composer notice they were trying to get past.
 */
export function canStartFirstThread(input: {
  readonly providerRows: ReadonlyArray<FirstRunProviderRow>;
  readonly projectRow: FirstRunProjectRow;
}): boolean {
  return (
    input.projectRow.state === "ready" && input.providerRows.some((row) => row.state === "ready")
  );
}
