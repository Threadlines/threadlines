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
import { useSettings } from "../../hooks/useSettings";
import { pushAlertsSupport, relayLinkOf, usePushAlertsStore } from "../../pushAlerts/pushAlerts";
import {
  canSetDesktopBackgroundOptions,
  useDesktopBackgroundOptions,
} from "./desktopBackgroundOptions";
import { isRemotelyReachable } from "./connections/serverReach";
import { deriveMaintainedProviderRows, isProviderRowEnabled } from "./providerEnablement";
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
export interface PlaceSignals {
  readonly phone: boolean;
  readonly desktopApp: boolean;
  readonly keepAwakeForTasks: boolean;
  readonly runInBackground: boolean;
  readonly dictationSupported: boolean;
  readonly dictationModelsDownloaded: boolean;
  /** Phone alerts work here and a paired computer can send them. */
  readonly alertsShown: boolean;
  readonly alertKindsShown: boolean;
  readonly owner: boolean;
  readonly outsideAgents: boolean;
  /** Other devices can reach this computer directly (the one-time link needs it). */
  readonly remotelyReachable: boolean;
  /** This computer keeps project briefs and notes. */
  readonly projectContext: boolean;
  /** This computer's server has devices (capability `devices`). */
  readonly devices: boolean;
  /** At least one Claude Code instance is turned on. */
  readonly claudeEnabled: boolean;
  /** At least one Codex instance is turned on. */
  readonly codexEnabled: boolean;
  /** At least one Antigravity instance is turned on. */
  readonly antigravityEnabled: boolean;
}

/**
 * Places a page draws only sometimes. Everything else is always on its page,
 * except where the catalog's `appliesWhen` says desktop app only. Where a
 * page draws a place on a condition, it asks `ShownPlace`, so the two agree.
 */
const SHOWN_WHEN: Partial<Record<SettingsPlaceSearchId, (signals: PlaceSignals) => boolean>> = {
  // The section always shows (Play a sound is on every device); phone alerts only where they work.
  "general.alertsOnThisDevice": (s) => s.alertsShown,
  "general.alertNeedsYou": (s) => s.alertKindsShown,
  "general.alertFinished": (s) => s.alertKindsShown,
  "general.alertFailed": (s) => s.alertKindsShown,
  "general.alertsQuietAtComputer": (s) => s.alertKindsShown,
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
  "connections.assistants": (s) => !s.phone && s.owner && s.outsideAgents,
  "connections.assistantsUsingThis": (s) => !s.phone && s.owner && s.outsideAgents,
  "connections.assistantAddress": (s) => !s.phone && s.owner && s.outsideAgents,
  "connections.addAssistant": (s) => !s.phone && s.owner && s.outsideAgents,
  "connections.assistantAlerts": (s) => !s.phone && s.owner && s.outsideAgents,
  "connections.options": (s) => !s.phone && s.owner,
  "connections.sameNetwork": (s) => !s.phone && s.owner,
  "connections.tailscale": (s) => !s.phone && s.owner,
  "connections.oneTimeLink": (s) => !s.phone && s.owner && s.remotelyReachable,
  "instructions.notesMode": (s) => s.projectContext,
  // The phone app has no Devices page; a server without devices draws only a note there.
  "settings.devices": (s) => !s.phone && s.devices,
  "devices.simulators": (s) => !s.phone && s.devices,
  "devices.enable": (s) => !s.phone && s.devices,
  "devices.agentAccess": (s) => !s.phone && s.devices,
  "devices.tools": (s) => !s.phone && s.devices,
  // Providers › Suggestions: only providers the user currently has turned on.
  "providers.suggestions": (s) => s.claudeEnabled || s.codexEnabled || s.antigravityEnabled,
  "providers.claudeSuggestions": (s) => s.claudeEnabled,
  "providers.codexSuggestions": (s) => s.codexEnabled,
  "providers.antigravitySuggestions": (s) => s.antigravityEnabled,
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
  projectContext: true,
  devices: true,
  claudeEnabled: true,
  codexEnabled: true,
  antigravityEnabled: true,
};

const PlaceSignalsContext = createContext<PlaceSignals | null>(null);

/**
 * Whether the desktop app's computer is reachable from other devices, read
 * from the desktop app each time a search starts (Connections can change it
 * in between). Unknown, so not offered, until this search's read answers.
 * `search` numbers the host's searches: Settings counts them, the palette
 * uses its opening.
 */
function useDesktopReach(enabled: boolean, search: number): boolean {
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

/** What a host of the settings search tells the rules: is a search showing, and which one. */
export interface SettingsSearchHost {
  readonly searchActive: boolean;
  /** Changes for each new search, so facts read per search are read again. */
  readonly searchSession: number;
}

function useEnabledSuggestionProviders() {
  const providers = useSettings((settings) => settings.providers);
  const providerInstances = useSettings((settings) => settings.providerInstances);
  return useMemo(() => {
    const rows = deriveMaintainedProviderRows({ providers, providerInstances });
    let claudeEnabled = false;
    let codexEnabled = false;
    let antigravityEnabled = false;
    for (const row of rows) {
      if (!isProviderRowEnabled(row)) continue;
      if (row.driver === "claudeAgent") claudeEnabled = true;
      else if (row.driver === "codex") codexEnabled = true;
      else if (row.driver === "antigravity") antigravityEnabled = true;
    }
    return { claudeEnabled, codexEnabled, antigravityEnabled };
  }, [providerInstances, providers]);
}

function usePlaceSignals(phone: boolean, host: SettingsSearchHost): PlaceSignals {
  const background = useDesktopBackgroundOptions();
  const dictation = useDictationStatus(usePrimaryEnvironmentId());
  const alertsEnabled = usePushAlertsStore((state) => state.enabled);
  const alertsPermission = usePushAlertsStore((state) => state.permission);
  const alertComputers = useSavedEnvironmentRegistryStore(
    (state) => Object.values(state.byId).filter((record) => relayLinkOf(record) !== null).length,
  );
  const { role, authPolicy } = usePrimarySessionAccess(!phone);
  const desktopReach = useDesktopReach(
    isElectron && !phone && role === "owner" && host.searchActive,
    host.searchSession,
  );
  const primaryCapabilities = usePrimaryEnvironmentDescriptor()?.capabilities;
  const outsideAgents = primaryCapabilities?.outsideAgents === true;
  const projectContext = primaryCapabilities?.projectContext === true;
  const devices = primaryCapabilities?.devices === true;
  const alertsSupport = pushAlertsSupport();
  const alertsShown = alertsSupport !== "unsupported" && alertComputers > 0;
  const canSetBackground = background !== null && canSetDesktopBackgroundOptions();
  const { claudeEnabled, codexEnabled, antigravityEnabled } = useEnabledSuggestionProviders();
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
      projectContext,
      devices,
      claudeEnabled,
      codexEnabled,
      antigravityEnabled,
    }),
    [
      alertsEnabled,
      alertsPermission,
      alertsShown,
      alertsSupport,
      antigravityEnabled,
      authPolicy,
      background,
      canSetBackground,
      claudeEnabled,
      codexEnabled,
      desktopReach,
      devices,
      dictation,
      outsideAgents,
      phone,
      projectContext,
      role,
    ],
  );
}

/** Whether a place is on screen under these facts. */
function placeShown(signals: PlaceSignals, id: SettingsPlaceSearchId): boolean {
  const place = placeById(id);
  if ("appliesWhen" in place && place.appliesWhen === "desktop" && !signals.desktopApp) {
    return false;
  }
  return SHOWN_WHEN[id]?.(signals) ?? true;
}

/**
 * Which settings places exist here, for a host of the settings search:
 * Settings (through SettingsAvailabilityProvider) and the command palette,
 * which asks with the same inputs so it never offers a row Settings hides.
 */
export function useSettingsAvailability(
  surface: SettingsSurface,
  host: SettingsSearchHost,
): { readonly signals: PlaceSignals; readonly shown: (id: SettingsPlaceSearchId) => boolean } {
  const signals = usePlaceSignals(surface === "phone", host);
  const shown = useCallback((id: SettingsPlaceSearchId) => placeShown(signals, id), [signals]);
  return { signals, shown };
}

/** The settings search as Settings hosts it: its own store says what is being searched. */
export function useSettingsStoreSearchHost(): SettingsSearchHost {
  const searchActive = useSettingsSearchStore(selectSettingsSearchActive);
  const searchSession = useSettingsSearchStore((state) => state.searchesStarted);
  return useMemo(() => ({ searchActive, searchSession }), [searchActive, searchSession]);
}

/**
 * How Settings is shown and the live facts its places depend on, gathered
 * once for everything inside (the settings layout mounts it), so a page full
 * of places doesn't ask the server once per row.
 */
export function SettingsAvailabilityProvider({
  surface,
  host,
  children,
}: {
  readonly surface: SettingsSurface;
  readonly host: SettingsSearchHost;
  readonly children: ReactNode;
}) {
  const { signals } = useSettingsAvailability(surface, host);
  return (
    <SettingsSurfaceContext.Provider value={surface}>
      <PlaceSignalsContext.Provider value={signals}>{children}</PlaceSignalsContext.Provider>
    </SettingsSurfaceContext.Provider>
  );
}

/** Answers whether a settings place is on screen here; follows the live facts. */
export function useSettingsPlaceShown(): (id: SettingsPlaceSearchId) => boolean {
  const fromProvider = useContext(PlaceSignalsContext);
  const fallbackProviders = useEnabledSuggestionProviders();
  // The nearest surface wins: a page drawn as the phone's says so itself.
  const phone = useSettingsSurface() === "phone";
  const signals = useMemo(() => {
    const base =
      fromProvider ?? ({ ...STATIC_SIGNALS, ...fallbackProviders } satisfies PlaceSignals);
    return base.phone === phone ? base : { ...base, phone };
  }, [fallbackProviders, fromProvider, phone]);
  return useCallback((id) => placeShown(signals, id), [signals]);
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
