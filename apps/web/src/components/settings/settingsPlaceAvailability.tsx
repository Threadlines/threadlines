import type { AppPlace } from "@threadlines/shared/appPlaces";
import { placeById } from "@threadlines/shared/appPlaces";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { useDictationStatus } from "../../dictation/dictationStatusStore";
import {
  usePrimaryEnvironmentDescriptor,
  usePrimaryEnvironmentId,
} from "../../environments/primary/context";
import { useSavedEnvironmentRegistryStore } from "../../environments/runtime";
import { isElectron } from "../../env";
import { usePrimarySessionAccess } from "../../hooks/useAuthAccess";
import { pushAlertsSupport, relayLinkOf, usePushAlertsStore } from "../../pushAlerts/pushAlerts";
import {
  canSetDesktopBackgroundOptions,
  useDesktopBackgroundOptions,
} from "./desktopBackgroundOptions";
import { isRemotelyReachable } from "./connections/serverReach";
import { selectSettingsSearchActive, useSettingsSearchStore } from "./settingsSearchStore";

/**
 * Which settings places are on screen here (docs/design/settings-search.md).
 * A page and the settings search ask the same question, so search counts and
 * results never include a row the page doesn't draw.
 */

type SettingsPageSpec = Extract<
  AppPlace,
  { readonly kind: "page"; readonly route: { readonly to: `/settings/${string}` } }
>;
type SettingsSectionSpec = Extract<
  AppPlace,
  { readonly kind: "section"; readonly parent: SettingsPageSpec["id"] }
>;
type SettingsRowSpec = Extract<
  AppPlace,
  { readonly kind: "row"; readonly parent: SettingsSectionSpec["id"] }
>;

export type SettingsPagePlaceId = SettingsPageSpec["id"];
export type SettingsSectionPlaceId = SettingsSectionSpec["id"];
export type SettingsRowPlaceId = SettingsRowSpec["id"];
/** Every place inside Settings: its pages, sections and rows. */
export type SettingsPlaceSearchId =
  | SettingsPagePlaceId
  | SettingsSectionPlaceId
  | SettingsRowPlaceId;

/** "phone" is the hosted phone app, which shows some pages differently. */
export type SettingsSurface = "full" | "phone";

/** Set by the settings layout from how the app was opened. */
export const SettingsSurfaceContext = createContext<SettingsSurface>("full");

export const useSettingsSurface = (): SettingsSurface => useContext(SettingsSurfaceContext);

/** What the rules below read: how Settings is shown, and live facts some rows depend on. */
interface PlaceSignals {
  readonly phone: boolean;
  readonly desktopApp: boolean;
  readonly keepAwakeForTasks: boolean;
  readonly runInBackground: boolean;
  readonly dictationSupported: boolean;
  readonly dictationModelsDownloaded: boolean;
  readonly alertsShown: boolean;
  readonly alertKindsShown: boolean;
  readonly owner: boolean;
  readonly outsideAgents: boolean;
  /** Other devices can reach this computer directly (the one-time link needs it). */
  readonly remotelyReachable: boolean;
}

/**
 * Places a page draws only sometimes. Everything else is always on its page,
 * except where the catalog's `appliesWhen` says desktop app only. Where a
 * page draws a place on a condition, it asks `ShownPlace`, so the two agree.
 */
const SHOWN_WHEN: Partial<Record<SettingsPlaceSearchId, (signals: PlaceSignals) => boolean>> = {
  "general.alerts": (s) => s.alertsShown,
  "general.alertsOnThisDevice": (s) => s.alertsShown,
  "general.alertNeedsYou": (s) => s.alertKindsShown,
  "general.alertFinished": (s) => s.alertKindsShown,
  "general.alertFailed": (s) => s.alertKindsShown,
  // On a phone the panel covers the conversation, so it never opens itself.
  "general.agentsPanel": (s) => !s.phone,
  "general.speechModel": (s) => s.dictationSupported,
  "general.holdToRecord": (s) => s.dictationSupported,
  "general.downloadedModels": (s) => s.dictationSupported && s.dictationModelsDownloaded,
  "general.keepAwakeForScheduledTasks": (s) => !s.phone && s.keepAwakeForTasks,
  "general.runInBackground": (s) => !s.phone && s.runInBackground,
  "general.addProjectStartsIn": (s) => !s.phone,
  "general.clearBrowserData": (s) => !s.phone,
  "general.diagnostics": (s) => !s.phone,
  "general.phoneSettings": (s) => s.phone,
  "settings.keybindings": (s) => !s.phone,
  "connections.thisComputer": (s) => !s.phone,
  "connections.devices": (s) => !s.phone,
  "connections.connectDevice": (s) => !s.phone && s.owner,
  "connections.agents": (s) => !s.phone && s.owner && s.outsideAgents,
  "connections.agentsUsingThis": (s) => !s.phone && s.owner && s.outsideAgents,
  "connections.agentAddress": (s) => !s.phone && s.owner && s.outsideAgents,
  "connections.connectAgent": (s) => !s.phone && s.owner && s.outsideAgents,
  "connections.threadlinesCommand": (s) => !s.phone && s.owner && s.outsideAgents,
  "connections.options": (s) => !s.phone && s.owner,
  "connections.sameNetwork": (s) => !s.phone && s.owner,
  "connections.tailscale": (s) => !s.phone && s.owner,
  "connections.oneTimeLink": (s) => !s.phone && s.owner && s.remotelyReachable,
};

/**
 * Without the settings layout around them (a lone panel in a test), places
 * answer from what is known without asking: rows that depend on live facts
 * still check those themselves.
 */
const STATIC_SIGNALS: PlaceSignals = {
  phone: false,
  desktopApp: isElectron,
  keepAwakeForTasks: true,
  runInBackground: true,
  dictationSupported: true,
  dictationModelsDownloaded: true,
  alertsShown: true,
  alertKindsShown: true,
  owner: true,
  outsideAgents: true,
  remotelyReachable: true,
};

const PlaceSignalsContext = createContext<PlaceSignals | null>(null);

/**
 * Whether the desktop app's computer is reachable from other devices, read
 * from the desktop app each time a search starts (Connections can change it
 * in between). Unknown, so not offered, until this search's read answers.
 */
function useDesktopReach(enabled: boolean): boolean {
  const search = useSettingsSearchStore((state) => state.searchesStarted);
  const [answer, setAnswer] = useState<{
    readonly search: number;
    readonly reachable: boolean;
  } | null>(null);
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!enabled || bridge === undefined) return;
    let cancelled = false;
    void Promise.all([bridge.getServerExposureState(), bridge.getAdvertisedEndpoints()])
      .then(([state, endpoints]) => {
        if (cancelled) return;
        setAnswer({
          search,
          reachable: isRemotelyReachable({
            networkAccessible: state.mode === "network-accessible",
            endpoints,
          }),
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled, search]);
  return enabled && answer?.search === search && answer.reachable;
}

function usePlaceSignals(): PlaceSignals {
  const phone = useSettingsSurface() === "phone";
  const background = useDesktopBackgroundOptions();
  const dictation = useDictationStatus(usePrimaryEnvironmentId());
  const alertsEnabled = usePushAlertsStore((state) => state.enabled);
  const alertsPermission = usePushAlertsStore((state) => state.permission);
  const alertComputers = useSavedEnvironmentRegistryStore(
    (state) => Object.values(state.byId).filter((record) => relayLinkOf(record) !== null).length,
  );
  const { role, authPolicy } = usePrimarySessionAccess(!phone);
  const searching = useSettingsSearchStore(selectSettingsSearchActive);
  const desktopReach = useDesktopReach(isElectron && !phone && role === "owner" && searching);
  const outsideAgents = usePrimaryEnvironmentDescriptor()?.capabilities.outsideAgents === true;
  const alertsSupport = pushAlertsSupport();
  const alertsShown = alertsSupport !== "unsupported" && alertComputers > 0;
  const canSetBackground = background !== null && canSetDesktopBackgroundOptions();
  return useMemo(
    () => ({
      phone,
      desktopApp: isElectron,
      keepAwakeForTasks: canSetBackground,
      runInBackground: canSetBackground && background.runInBackgroundSupported,
      dictationSupported: dictation?.runtime.supported !== false,
      dictationModelsDownloaded: (dictation?.models ?? []).some((model) => model.state === "ready"),
      alertsShown,
      alertKindsShown:
        alertsShown &&
        alertsSupport === "supported" &&
        alertsEnabled &&
        alertsPermission === "granted",
      owner: role === "owner",
      outsideAgents,
      remotelyReachable: isElectron ? desktopReach : authPolicy === "remote-reachable",
    }),
    [
      alertsEnabled,
      alertsPermission,
      alertsShown,
      alertsSupport,
      authPolicy,
      background,
      canSetBackground,
      desktopReach,
      dictation,
      outsideAgents,
      phone,
      role,
    ],
  );
}

/**
 * Gathers the live facts once for all of Settings (the layout mounts it), so
 * a page full of places doesn't ask the server once per row.
 */
export function SettingsPlaceSignalsProvider({ children }: { readonly children: ReactNode }) {
  const signals = usePlaceSignals();
  return <PlaceSignalsContext.Provider value={signals}>{children}</PlaceSignalsContext.Provider>;
}

/** Answers whether a settings place is on screen here; follows the live facts. */
export function useSettingsPlaceShown(): (id: SettingsPlaceSearchId) => boolean {
  const gathered = useContext(PlaceSignalsContext) ?? STATIC_SIGNALS;
  // The nearest surface wins: a page drawn as the phone's says so itself.
  const phone = useSettingsSurface() === "phone";
  const signals = useMemo(
    () => (gathered.phone === phone ? gathered : { ...gathered, phone }),
    [gathered, phone],
  );
  return useCallback(
    (id) => {
      const place = placeById(id);
      if ("appliesWhen" in place && place.appliesWhen === "desktop" && !signals.desktopApp) {
        return false;
      }
      return SHOWN_WHEN[id]?.(signals) ?? true;
    },
    [signals],
  );
}

/** Draws its children only where `place` is on screen (see SHOWN_WHEN). */
export function ShownPlace({
  place,
  children,
}: {
  readonly place: SettingsPlaceSearchId;
  readonly children: ReactNode;
}) {
  return useSettingsPlaceShown()(place) ? children : null;
}
