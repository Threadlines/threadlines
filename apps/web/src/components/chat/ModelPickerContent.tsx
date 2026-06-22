import {
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@threadlines/contracts";
import { resolveSelectableModel } from "@threadlines/shared/model";
import { memo, useMemo, useState, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { SearchIcon, StarIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { ModelListRow } from "./ModelListRow";
import { buildModelPickerSearchText, scoreModelPickerSearch } from "./modelPickerSearch";
import { Combobox, ComboboxEmpty, ComboboxInput, ComboboxListVirtualized } from "../ui/combobox";
import { ModelEsque, PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { TooltipProvider } from "../ui/tooltip";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { providerModelKey, sortProviderModelItems } from "../../modelOrdering";

type ModelPickerItem = {
  slug: string;
  name: string;
  description?: string;
  shortName?: string;
  subProvider?: string;
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  instanceDisplayName: string;
  instanceAccentColor?: string | undefined;
  continuationGroupKey?: string | undefined;
};

const EMPTY_MODEL_JUMP_LABELS = new Map<string, string>();
const EMPTY_MODEL_PICKER_ITEMS: ReadonlyArray<ModelPickerItem> = [];
const EMPTY_SEARCHED_MODELS_BY_TAB_ID: ReadonlyMap<
  string,
  ReadonlyArray<ModelPickerItem>
> = new Map();
const EMPTY_FAVORITES: ReadonlyArray<{
  readonly provider: ProviderInstanceId;
  readonly model: string;
}> = [];

type ModelPickerTab = {
  id: string;
  label: string;
  kind: "favorites" | "instance";
  modelCount: number;
  models: ReadonlyArray<ModelPickerItem>;
  driverKind?: ProviderDriverKind;
  accentColor?: string | undefined;
};

// Split a `${instanceId}:${slug}` combobox key back into its pieces. Slugs
// can contain colons (e.g. some vendor model ids), so we only split on the
// first colon — anything after that is the slug.
function splitInstanceModelKey(key: string): { instanceId: ProviderInstanceId; slug: string } {
  const colonIndex = key.indexOf(":");
  if (colonIndex === -1) {
    return { instanceId: key as ProviderInstanceId, slug: "" };
  }
  return {
    instanceId: key.slice(0, colonIndex) as ProviderInstanceId,
    slug: key.slice(colonIndex + 1),
  };
}

function rankModelPickerSearchMatches(
  models: ReadonlyArray<ModelPickerItem>,
  searchQuery: string,
  favoriteModelKeys: ReadonlySet<string>,
): ReadonlyArray<ModelPickerItem> {
  const query = searchQuery.trim();
  if (!query) {
    return EMPTY_MODEL_PICKER_ITEMS;
  }

  const rankedMatches = models
    .map((model) => ({
      model,
      score: scoreModelPickerSearch(
        {
          name: model.name,
          ...(model.description ? { description: model.description } : {}),
          ...(model.shortName ? { shortName: model.shortName } : {}),
          ...(model.subProvider ? { subProvider: model.subProvider } : {}),
          driverKind: model.driverKind,
          providerDisplayName: model.instanceDisplayName,
          isFavorite: favoriteModelKeys.has(providerModelKey(model.instanceId, model.slug)),
        },
        query,
      ),
      isFavorite: favoriteModelKeys.has(providerModelKey(model.instanceId, model.slug)),
      tieBreaker: buildModelPickerSearchText({
        name: model.name,
        ...(model.description ? { description: model.description } : {}),
        ...(model.shortName ? { shortName: model.shortName } : {}),
        ...(model.subProvider ? { subProvider: model.subProvider } : {}),
        driverKind: model.driverKind,
        providerDisplayName: model.instanceDisplayName,
      }),
    }))
    .filter(
      (
        rankedModel,
      ): rankedModel is {
        model: ModelPickerItem;
        score: number;
        isFavorite: boolean;
        tieBreaker: string;
      } => rankedModel.score !== null,
    );

  return rankedMatches
    .toSorted((a, b) => {
      const scoreDelta = a.score - b.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      if (a.isFavorite !== b.isFavorite) {
        return a.isFavorite ? -1 : 1;
      }
      return a.tieBreaker.localeCompare(b.tieBreaker);
    })
    .map((rankedModel) => rankedModel.model);
}

export const ModelPickerContent = memo(function ModelPickerContent(props: {
  /** The instance currently selected in the composer (combobox "value"). */
  activeInstanceId: ProviderInstanceId;
  model: string;
  /**
   * When set, the picker is locked to the given driver kind — typically
   * because the user is editing a previously-sent message and can't change
   * which driver served the turn. Multiple instances of the same kind
   * remain selectable (e.g. locked to `codex` still lets the user switch
   * between the default Codex and a custom Codex Personal).
   */
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /**
   * All configured provider instances in display order. Used to render
   * the sidebar (one button per instance) and to resolve display names
   * for the locked-mode header.
   */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  /**
   * Model options per instance. Keyed by `ProviderInstanceId` so the
   * default Codex instance and any custom Codex instances each have their
   * own list (custom instances typically start with the same built-in
   * model set but are free to diverge via customModels).
   */
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  terminalOpen: boolean;
  onRequestClose?: () => void;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const {
    keybindings: providedKeybindings,
    modelOptionsByInstance,
    instanceEntries,
    onInstanceModelChange,
  } = props;
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const highlightedModelKeyRef = useRef<string | null>(null);
  const favorites = useSettings((s) => s.favorites ?? EMPTY_FAVORITES);
  // `null` means the smart default follows the current selection: Favorites
  // when the active model is favorited, otherwise the active provider tab.
  const [manualActiveTabId, setManualActiveTabId] = useState<string | null>(null);
  const keybindings = useMemo<ResolvedKeybindingsConfig>(
    () => providedKeybindings ?? [],
    [providedKeybindings],
  );
  const { updateSettings } = useUpdateSettings();

  const focusSearchInput = useCallback(() => {
    searchInputRef.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    focusSearchInput();
    const frame = window.requestAnimationFrame(() => {
      focusSearchInput();
    });
    const timeout = window.setTimeout(() => {
      focusSearchInput();
    }, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [focusSearchInput]);

  // Create a Set for efficient lookup. Favorites are keyed by
  // `${instanceId}:${slug}`; the storage schema widened from ProviderDriverKind
  // to ProviderInstanceId so pre-migration favorites keyed by driver slugs
  // (e.g. `"codex:gpt-5"`) still resolve — the default instance id equals
  // the driver slug.
  const favoritesSet = useMemo(() => {
    return new Set(favorites.map((fav) => providerModelKey(fav.provider, fav.model)));
  }, [favorites]);

  /**
   * Lookup table keyed by `instanceId`. Used for display name + driver
   * kind enrichment and for `ready`/enabled filtering before flattening
   * models into the search list.
   */
  const entryByInstanceId = useMemo(
    () => new Map(instanceEntries.map((entry) => [entry.instanceId, entry])),
    [instanceEntries],
  );
  const matchesLockedProvider = useCallback(
    (entry: Pick<ProviderInstanceEntry, "driverKind" | "continuationGroupKey">): boolean => {
      if (props.lockedProvider === null) return true;
      if (entry.driverKind !== props.lockedProvider) return false;
      if (!props.lockedContinuationGroupKey) return true;
      return entry.continuationGroupKey === props.lockedContinuationGroupKey;
    },
    [props.lockedContinuationGroupKey, props.lockedProvider],
  );

  const readyInstanceSet = useMemo(() => {
    const ready = new Set<ProviderInstanceId>();
    for (const entry of instanceEntries) {
      if (entry.status === "ready") {
        ready.add(entry.instanceId);
      }
    }
    return ready;
  }, [instanceEntries]);

  // Flatten models into a searchable array. One pass over the
  // instance-keyed map; each model carries its instance id + driver kind
  // so the list row can render the right icon and display name without
  // another lookup.
  const flatModels = useMemo(() => {
    const out: ModelPickerItem[] = [];
    for (const [instanceId, models] of modelOptionsByInstance) {
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        // Instance disappeared between renders (configuration change). Skip
        // its models — stale options shouldn't appear in the picker.
        continue;
      }
      if (!readyInstanceSet.has(instanceId)) {
        continue;
      }
      for (const model of models) {
        out.push({
          slug: model.slug,
          name: model.name,
          ...(model.description ? { description: model.description } : {}),
          ...(model.shortName ? { shortName: model.shortName } : {}),
          ...(model.subProvider ? { subProvider: model.subProvider } : {}),
          instanceId,
          driverKind: entry.driverKind,
          instanceDisplayName: entry.displayName,
          ...(entry.accentColor ? { instanceAccentColor: entry.accentColor } : {}),
          ...(entry.continuationGroupKey
            ? { continuationGroupKey: entry.continuationGroupKey }
            : {}),
        });
      }
    }
    return out;
  }, [modelOptionsByInstance, entryByInstanceId, readyInstanceSet]);

  const isLocked = props.lockedProvider !== null;
  const normalizedSearchQuery = searchQuery.trim();
  const isSearching = normalizedSearchQuery.length > 0;
  const lockedInstanceEntries = useMemo(
    () =>
      props.lockedProvider ? instanceEntries.filter((entry) => matchesLockedProvider(entry)) : [],
    [instanceEntries, matchesLockedProvider, props.lockedProvider],
  );
  // With one matching instance the lock banner already names the provider,
  // so rows can use their full trigger labels and groups need no headers.
  const lockedToSingleInstance = isLocked && lockedInstanceEntries.length <= 1;
  const instanceOrder = useMemo(
    () => instanceEntries.map((entry) => entry.instanceId),
    [instanceEntries],
  );

  const eligibleModels = useMemo(
    () => (isLocked ? flatModels.filter((model) => matchesLockedProvider(model)) : flatModels),
    [flatModels, isLocked, matchesLockedProvider],
  );
  const activeModelIsFavorite =
    !isLocked && favoritesSet.has(providerModelKey(props.activeInstanceId, props.model));

  const favoriteModels = useMemo(() => {
    if (isLocked) {
      return EMPTY_MODEL_PICKER_ITEMS;
    }
    return sortProviderModelItems(
      eligibleModels.filter((model) =>
        favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
      ),
      {
        favoriteModelKeys: favoritesSet,
        groupFavorites: false,
        instanceOrder,
      },
    );
  }, [eligibleModels, favoritesSet, instanceOrder, isLocked]);

  const modelsByInstance = useMemo(() => {
    const grouped = new Map<ProviderInstanceId, ModelPickerItem[]>();
    for (const model of eligibleModels) {
      const models = grouped.get(model.instanceId);
      if (models) {
        models.push(model);
      } else {
        grouped.set(model.instanceId, [model]);
      }
    }
    return grouped;
  }, [eligibleModels]);

  const providerTabs = useMemo((): ModelPickerTab[] => {
    const tabs: ModelPickerTab[] = [];
    for (const entry of instanceEntries) {
      const models = modelsByInstance.get(entry.instanceId);
      if (!models || models.length === 0) {
        continue;
      }
      const sortedModels = sortProviderModelItems(models, {
        favoriteModelKeys: favoritesSet,
        groupFavorites: isLocked,
        instanceOrder: [],
      });
      tabs.push({
        kind: "instance",
        id: entry.instanceId,
        label: entry.displayName,
        driverKind: entry.driverKind,
        ...(entry.accentColor ? { accentColor: entry.accentColor } : {}),
        modelCount: sortedModels.length,
        models: sortedModels,
      });
    }
    return tabs;
  }, [favoritesSet, instanceEntries, isLocked, modelsByInstance]);

  const showTabList = !lockedToSingleInstance && (!isLocked || providerTabs.length > 1);
  const tabs = useMemo((): ModelPickerTab[] => {
    if (!showTabList) {
      return [];
    }
    return [
      ...(!isLocked
        ? [
            {
              kind: "favorites" as const,
              id: "favorites",
              label: "Favorites",
              modelCount: favoriteModels.length,
              models: favoriteModels,
            },
          ]
        : []),
      ...providerTabs,
    ];
  }, [favoriteModels, isLocked, providerTabs, showTabList]);

  const defaultActiveTabId = activeModelIsFavorite ? "favorites" : props.activeInstanceId;
  const activeTab = useMemo(() => {
    if (!showTabList) {
      return null;
    }
    const manualTab = tabs.find((tab) => tab.id === manualActiveTabId);
    if (manualTab) {
      return manualTab;
    }
    const defaultTab = tabs.find((tab) => tab.id === defaultActiveTabId);
    if (defaultTab) {
      return defaultTab;
    }
    return tabs.find((tab) => tab.kind === "instance") ?? tabs[0] ?? null;
  }, [defaultActiveTabId, manualActiveTabId, showTabList, tabs]);
  const activeTabId = activeTab?.id ?? null;

  const activeTabModels = activeTab?.models ?? providerTabs[0]?.models ?? EMPTY_MODEL_PICKER_ITEMS;

  const searchedModelsByTabId = useMemo((): ReadonlyMap<string, ReadonlyArray<ModelPickerItem>> => {
    if (!isSearching || tabs.length === 0) {
      return EMPTY_SEARCHED_MODELS_BY_TAB_ID;
    }

    const searchResults = new Map<string, ReadonlyArray<ModelPickerItem>>();
    for (const tab of tabs) {
      searchResults.set(
        tab.id,
        rankModelPickerSearchMatches(tab.models, normalizedSearchQuery, favoritesSet),
      );
    }
    return searchResults;
  }, [favoritesSet, isSearching, normalizedSearchQuery, tabs]);

  // Tokenized fuzzy search stays scoped to the selected tab. During search,
  // tab badges switch to match counts so duplicate membership such as
  // Favorites + Claude is visible without duplicating rows in one pane.
  const searchedModels = useMemo(() => {
    if (!isSearching) {
      return EMPTY_MODEL_PICKER_ITEMS;
    }
    if (activeTab) {
      return searchedModelsByTabId.get(activeTab.id) ?? EMPTY_MODEL_PICKER_ITEMS;
    }
    return rankModelPickerSearchMatches(activeTabModels, normalizedSearchQuery, favoritesSet);
  }, [
    activeTab,
    activeTabModels,
    favoritesSet,
    isSearching,
    normalizedSearchQuery,
    searchedModelsByTabId,
  ]);

  const orderedModels = useMemo(
    () => (isSearching ? searchedModels : activeTabModels),
    [activeTabModels, isSearching, searchedModels],
  );

  const emptyMessage = isSearching
    ? activeTab
      ? `No matches in ${activeTab.label}`
      : "No models found"
    : activeTab?.kind === "favorites"
      ? "No favorite models"
      : "No models available";

  const tabModelCountLabel = (count: number) => `${count} ${count === 1 ? "model" : "models"}`;
  const tabSearchCountLabel = (count: number, total: number) =>
    `${count} ${count === 1 ? "match" : "matches"} of ${tabModelCountLabel(total)}`;

  const renderTabIcon = (tab: ModelPickerTab) => {
    if (tab.kind === "favorites") {
      return <StarIcon className="size-3.5 fill-current text-yellow-500/80" />;
    }
    const ProviderIcon = tab.driverKind
      ? (PROVIDER_ICON_BY_PROVIDER[tab.driverKind] ?? null)
      : null;
    return (
      <>
        {ProviderIcon ? <ProviderIcon className="size-3.5 opacity-70" /> : null}
        {tab.accentColor ? (
          <span
            aria-hidden
            className="absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full ring-1 ring-popover"
            style={{ backgroundColor: tab.accentColor }}
          />
        ) : null}
      </>
    );
  };

  const handleModelSelect = useCallback(
    (modelSlug: string, instanceId: ProviderInstanceId) => {
      const options = modelOptionsByInstance.get(instanceId);
      if (!options) {
        return;
      }
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        return;
      }
      // `resolveSelectableModel` uses the driver kind for normalization
      // (slug casing etc.). Custom instances share their driver's
      // normalization rules, so pass the driver kind here.
      const resolvedModel = resolveSelectableModel(entry.driverKind, modelSlug, options);
      if (resolvedModel) {
        onInstanceModelChange(instanceId, resolvedModel);
      }
    },
    [entryByInstanceId, modelOptionsByInstance, onInstanceModelChange],
  );

  const toggleFavorite = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      setManualActiveTabId((current) => current ?? activeTabId);
      const newFavorites = [...favorites];
      const index = newFavorites.findIndex((f) => f.provider === instanceId && f.model === model);
      if (index >= 0) {
        newFavorites.splice(index, 1);
      } else {
        newFavorites.push({ provider: instanceId, model });
      }
      updateSettings({ favorites: newFavorites });
    },
    [activeTabId, favorites, updateSettings],
  );

  const LockedProviderIcon =
    isLocked && props.lockedProvider ? PROVIDER_ICON_BY_PROVIDER[props.lockedProvider] : null;
  // Header label for locked mode. Use the active instance's displayName
  // when the lock narrows to exactly one instance (so "Codex Personal"
  // shows instead of the generic driver label); fall back to the first
  // matching entry otherwise.
  const lockedHeaderLabel = useMemo(() => {
    if (!isLocked || !props.lockedProvider) return null;
    const matches = instanceEntries.filter((entry) => matchesLockedProvider(entry));
    if (matches.length === 0) return null;
    const active = matches.find((entry) => entry.instanceId === props.activeInstanceId);
    return (active ?? matches[0])?.displayName ?? null;
  }, [
    isLocked,
    matchesLockedProvider,
    props.lockedProvider,
    props.activeInstanceId,
    instanceEntries,
  ]);
  const modelJumpCommandByKey = useMemo(() => {
    const mapping = new Map<
      string,
      NonNullable<ReturnType<typeof modelPickerJumpCommandForIndex>>
    >();
    for (const [visibleModelIndex, model] of orderedModels.entries()) {
      const jumpCommand = modelPickerJumpCommandForIndex(visibleModelIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(`${model.instanceId}:${model.slug}`, jumpCommand);
    }
    return mapping;
  }, [orderedModels]);
  const modelJumpModelKeys = useMemo(
    () => [...modelJumpCommandByKey.keys()],
    [modelJumpCommandByKey],
  );
  const orderedModelKeys = useMemo(
    (): string[] => orderedModels.map((model) => `${model.instanceId}:${model.slug}`),
    [orderedModels],
  );
  const modelJumpShortcutContext = useMemo(
    () =>
      ({
        terminalFocus: false,
        terminalOpen: props.terminalOpen,
        modelPickerOpen: true,
      }) as const,
    [props.terminalOpen],
  );
  const modelJumpLabelByKey = useMemo((): ReadonlyMap<string, string> => {
    if (modelJumpCommandByKey.size === 0) {
      return EMPTY_MODEL_JUMP_LABELS;
    }
    const shortcutLabelOptions = {
      platform: navigator.platform,
      context: modelJumpShortcutContext,
    };
    const mapping = new Map<string, string>();
    for (const [modelKey, command] of modelJumpCommandByKey) {
      const label = shortcutLabelForCommand(keybindings, command, shortcutLabelOptions);
      if (label) {
        mapping.set(modelKey, label);
      }
    }
    return mapping.size > 0 ? mapping : EMPTY_MODEL_JUMP_LABELS;
  }, [keybindings, modelJumpCommandByKey, modelJumpShortcutContext]);

  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: modelJumpShortcutContext,
      });
      const jumpIndex = modelPickerJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }

      const targetModelKey = modelJumpModelKeys[jumpIndex];
      if (!targetModelKey) {
        return;
      }
      const { instanceId, slug } = splitInstanceModelKey(targetModelKey);
      event.preventDefault();
      event.stopPropagation();
      handleModelSelect(slug, instanceId);
    };

    window.addEventListener("keydown", onWindowKeyDown, true);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
    };
  }, [handleModelSelect, keybindings, modelJumpModelKeys, modelJumpShortcutContext]);

  return (
    <TooltipProvider delay={0}>
      {/* Height hugs the visible rows; the list region caps and scrolls itself.
          The card also clamps to the positioner's --available-height so rows
          can't extend past the window edge, where the inner scroller (with
          overscroll-contain) would leave them unreachable. */}
      <div className="relative flex max-h-(--available-height) w-screen max-w-[34rem] flex-col overflow-hidden rounded-lg border bg-popover not-dark:bg-clip-padding text-popover-foreground shadow-lg/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
        {/* Locked provider banner: the turn's driver cannot change */}
        {lockedToSingleInstance && LockedProviderIcon && lockedHeaderLabel && (
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <LockedProviderIcon className="size-5 shrink-0" />
            <span className="text-sm font-medium">{lockedHeaderLabel}</span>
          </div>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {showTabList ? (
            <div className="border-b bg-muted/20 px-3 py-2">
              <div
                role="tablist"
                aria-label="Model tabs"
                className="flex min-w-0 gap-1 overflow-x-auto rounded-md bg-background/55 p-1"
              >
                {tabs.map((tab) => {
                  const isActive = activeTab?.id === tab.id;
                  const visibleModelCount = isSearching
                    ? (searchedModelsByTabId.get(tab.id)?.length ?? 0)
                    : tab.modelCount;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      data-model-picker-tab={tab.id}
                      title={`${tab.label} · ${
                        isSearching
                          ? tabSearchCountLabel(visibleModelCount, tab.modelCount)
                          : tabModelCountLabel(tab.modelCount)
                      }`}
                      className={cn(
                        "flex min-w-20 max-w-40 shrink-0 cursor-pointer items-center gap-1.5 rounded px-2.5 py-1.5 text-left text-xs font-medium transition-colors",
                        "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
                        isActive
                          ? "bg-accent text-foreground shadow-xs/5"
                          : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                      )}
                      onClick={() => {
                        setManualActiveTabId(tab.id);
                        focusSearchInput();
                      }}
                    >
                      <span className="relative flex size-4 shrink-0 items-center justify-center">
                        {renderTabIcon(tab)}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{tab.label}</span>
                      <span
                        className={cn(
                          "shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] leading-none tabular-nums",
                          isActive ? "text-foreground/75" : "text-muted-foreground/60",
                        )}
                      >
                        {isSearching ? `${visibleModelCount}/${tab.modelCount}` : tab.modelCount}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <Combobox
            inline
            items={orderedModelKeys}
            filteredItems={orderedModelKeys}
            filter={null}
            autoHighlight
            open
            value={`${props.activeInstanceId}:${props.model}`}
            onItemHighlighted={(modelKey) => {
              highlightedModelKeyRef.current = typeof modelKey === "string" ? modelKey : null;
            }}
            onValueChange={(modelKey) => {
              if (typeof modelKey !== "string") {
                return;
              }
              const { instanceId, slug } = splitInstanceModelKey(modelKey);
              handleModelSelect(slug, instanceId);
            }}
          >
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {/* Search bar */}
              <div className="border-b px-3 py-2">
                <ComboboxInput
                  ref={searchInputRef}
                  className="[&_input]:font-sans rounded-md"
                  inputClassName="border-0 shadow-none ring-0 focus-visible:ring-0"
                  placeholder="Search models..."
                  showTrigger={false}
                  startAddon={<SearchIcon className="size-4 shrink-0 text-muted-foreground/50" />}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      props.onRequestClose?.();
                      return;
                    }
                    if (
                      e.key === "Enter" &&
                      highlightedModelKeyRef.current &&
                      orderedModelKeys.includes(highlightedModelKeyRef.current)
                    ) {
                      (
                        e as typeof e & { preventBaseUIHandler?: () => void }
                      ).preventBaseUIHandler?.();
                      e.preventDefault();
                      e.stopPropagation();
                      const { instanceId, slug } = splitInstanceModelKey(
                        highlightedModelKeyRef.current,
                      );
                      handleModelSelect(slug, instanceId);
                      return;
                    }
                    e.stopPropagation();
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                  size="sm"
                />
              </div>

              {/* The region is its own scroller with a cap, so the popup hugs
                short lists and scrolls long ones (e.g. broad searches). */}
              <div className="model-picker-list min-h-0 max-h-80 flex-1 overflow-y-auto overscroll-contain bg-muted/40">
                <ComboboxListVirtualized className="w-full px-1.5 py-1">
                  {(() => {
                    let modelIndex = -1;
                    return orderedModels.map((model) => {
                      modelIndex += 1;
                      const modelKey = `${model.instanceId}:${model.slug}`;
                      return (
                        <ModelListRow
                          key={modelKey}
                          index={modelIndex}
                          model={model}
                          instanceId={model.instanceId}
                          driverKind={model.driverKind}
                          providerDisplayName={model.instanceDisplayName}
                          providerAccentColor={model.instanceAccentColor}
                          isFavorite={favoritesSet.has(modelKey)}
                          showProvider={activeTab?.kind === "favorites"}
                          preferShortName={!isLocked}
                          useTriggerLabel={lockedToSingleInstance}
                          jumpLabel={modelJumpLabelByKey.get(modelKey) ?? null}
                          onToggleFavorite={() => toggleFavorite(model.instanceId, model.slug)}
                        />
                      );
                    });
                  })()}
                </ComboboxListVirtualized>
              </div>
              <ComboboxEmpty className="not-empty:py-6 empty:h-0 text-xs font-normal leading-snug">
                {emptyMessage}
              </ComboboxEmpty>
            </div>
          </Combobox>
        </div>
      </div>
    </TooltipProvider>
  );
});
