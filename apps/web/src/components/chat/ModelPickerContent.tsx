import {
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@threadlines/contracts";
import { resolveSelectableModel } from "@threadlines/shared/model";
import {
  Fragment,
  memo,
  useMemo,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { SearchIcon, StarIcon, XIcon } from "lucide-react";
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
import { useMediaQuery } from "~/hooks/useMediaQuery";
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
  isDefault?: boolean | undefined;
};

const EMPTY_MODEL_JUMP_LABELS = new Map<string, string>();
const EMPTY_MODEL_PICKER_ITEMS: ReadonlyArray<ModelPickerItem> = [];
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

/**
 * One provider section of global search results. Searching ignores the
 * active tab: matches are ranked across every eligible instance, then
 * grouped back into instance sections for display.
 */
type ModelPickerSearchGroup = {
  instanceId: ProviderInstanceId;
  label: string;
  driverKind: ProviderDriverKind;
  accentColor?: string | undefined;
  models: ReadonlyArray<ModelPickerItem>;
};

const EMPTY_SEARCH_GROUPS: ReadonlyArray<ModelPickerSearchGroup> = [];

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
  // Search is collapsed to an icon until the user types or clicks the
  // toggle. The input keeps focus for combobox keyboard nav even while
  // visually hidden, so the first printable key lands in the query and
  // expands the field.
  const [searchOpenedManually, setSearchOpenedManually] = useState(false);
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

  // On touch devices, programmatic focus pops the on-screen keyboard over the
  // picker, so leave the search input blurred until the user taps into it.
  const isCoarsePointer = useMediaQuery({ pointer: "coarse" });
  const focusSearchInput = useCallback(() => {
    if (isCoarsePointer) {
      return;
    }
    searchInputRef.current?.focus({ preventScroll: true });
  }, [isCoarsePointer]);

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
          ...(model.isDefault === true ? { isDefault: true } : {}),
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
    const defaultTab = tabs.find((tab) => tab.id === defaultActiveTabId);
    return (
      manualTab ?? defaultTab ?? tabs.find((tab) => tab.kind === "instance") ?? tabs[0] ?? null
    );
  }, [defaultActiveTabId, manualActiveTabId, showTabList, tabs]);
  const activeTabId = activeTab?.id ?? null;

  const activeTabModels = activeTab?.models ?? providerTabs[0]?.models ?? EMPTY_MODEL_PICKER_ITEMS;

  // Global search: rank across every eligible instance, then group back
  // into instance sections (in configured order) for display. Ranking
  // within a group is preserved from the global pass, so favorites still
  // float via their score boost.
  const searchGroups = useMemo((): ReadonlyArray<ModelPickerSearchGroup> => {
    if (!isSearching) {
      return EMPTY_SEARCH_GROUPS;
    }
    const rankedModels = rankModelPickerSearchMatches(
      eligibleModels,
      normalizedSearchQuery,
      favoritesSet,
    );
    const grouped = new Map<ProviderInstanceId, ModelPickerItem[]>();
    for (const model of rankedModels) {
      const models = grouped.get(model.instanceId);
      if (models) {
        models.push(model);
      } else {
        grouped.set(model.instanceId, [model]);
      }
    }
    const groups: ModelPickerSearchGroup[] = [];
    for (const instanceId of instanceOrder) {
      const models = grouped.get(instanceId);
      const entry = entryByInstanceId.get(instanceId);
      if (!models || !entry) {
        continue;
      }
      groups.push({
        instanceId,
        label: entry.displayName,
        driverKind: entry.driverKind,
        ...(entry.accentColor ? { accentColor: entry.accentColor } : {}),
        models,
      });
    }
    return groups;
  }, [
    eligibleModels,
    entryByInstanceId,
    favoritesSet,
    instanceOrder,
    isSearching,
    normalizedSearchQuery,
  ]);

  const orderedModels = useMemo(
    () => (isSearching ? searchGroups.flatMap((group) => group.models) : activeTabModels),
    [activeTabModels, isSearching, searchGroups],
  );

  const emptyMessage = isSearching
    ? "No models match"
    : activeTab?.kind === "favorites"
      ? "No favorite models"
      : "No models available";

  const tabModelCountLabel = (count: number) => `${count} ${count === 1 ? "model" : "models"}`;

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

  const searchActive = searchOpenedManually || isSearching;
  const openSearch = useCallback(() => {
    setSearchOpenedManually(true);
    // Explicit intent: focus even on coarse pointers, where the on-screen
    // keyboard is expected after tapping the search toggle.
    searchInputRef.current?.focus({ preventScroll: true });
  }, []);
  const closeSearch = useCallback(() => {
    setSearchOpenedManually(false);
    setSearchQuery("");
    focusSearchInput();
  }, [focusSearchInput]);

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

  const renderModelRow = (model: ModelPickerItem, modelIndex: number) => {
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
        showProvider={!isSearching && activeTab?.kind === "favorites"}
        preferShortName={!isLocked}
        useProviderScopedLabel
        useTriggerLabel={lockedToSingleInstance}
        jumpLabel={modelJumpLabelByKey.get(modelKey) ?? null}
        onToggleFavorite={() => toggleFavorite(model.instanceId, model.slug)}
      />
    );
  };

  return (
    <TooltipProvider delay={0}>
      {/* Height hugs the visible rows; the list pane caps low and scrolls
          longer lists (favorites with 2-3 models stays tiny, Claude's 8
          scroll). The card also clamps to the positioner's
          --available-height so rows can't extend past the window edge,
          where the inner scroller (with overscroll-contain) would leave
          them unreachable. --keyboard-inset (set by ProviderModelPicker
          while an overlay keyboard is up) shrinks the cap so the lifted
          popup's top edge stays on screen. */}
      <div className="relative flex max-h-[calc(var(--available-height)-var(--keyboard-inset,0px))] w-screen max-w-[26rem] flex-col overflow-hidden rounded-lg border bg-popover not-dark:bg-clip-padding text-popover-foreground shadow-lg/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
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
            {/* Header: provider tabs (or the locked-provider label — the
                turn's driver cannot change) share one row with the search
                control; the search field expands over the tabs while active. */}
            <div className="flex h-10 min-w-0 shrink-0 items-center gap-1.5 border-b px-2">
              {!searchActive &&
                (showTabList ? (
                  <div
                    role="tablist"
                    aria-label="Model tabs"
                    className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
                  >
                    {tabs.map((tab) => {
                      const isActive = activeTab?.id === tab.id;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          role="tab"
                          aria-selected={isActive}
                          data-model-picker-tab={tab.id}
                          title={`${tab.label} · ${tabModelCountLabel(tab.modelCount)}`}
                          className={cn(
                            "flex max-w-40 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-left text-xs font-medium transition-colors",
                            "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
                            isActive
                              ? "bg-accent text-foreground"
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
                          <span className="min-w-0 truncate">{tab.label}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : lockedToSingleInstance && LockedProviderIcon && lockedHeaderLabel ? (
                  <div className="flex min-w-0 flex-1 items-center gap-2 px-1.5">
                    <LockedProviderIcon className="size-4 shrink-0" />
                    <span className="truncate text-sm font-medium">{lockedHeaderLabel}</span>
                  </div>
                ) : (
                  <div className="min-w-0 flex-1" />
                ))}
              {!searchActive && (
                <button
                  type="button"
                  aria-label="Search models"
                  data-model-picker-search-toggle
                  className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={openSearch}
                >
                  <SearchIcon className="size-4" />
                </button>
              )}
              {/* Always mounted so the combobox keeps its keyboard nav while
                  collapsed; sr-only hides the field without giving up focus. */}
              <div
                className={searchActive ? "flex min-w-0 flex-1 items-center gap-1.5" : "sr-only"}
              >
                <ComboboxInput
                  ref={searchInputRef}
                  className="min-w-0 flex-1 [&_input]:font-sans"
                  inputClassName="border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0"
                  placeholder="Search models..."
                  showTrigger={false}
                  startAddon={<SearchIcon className="size-4 shrink-0 text-muted-foreground/50" />}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      // First escape collapses the search back to browsing;
                      // a second one closes the picker.
                      if (searchActive) {
                        closeSearch();
                      } else {
                        props.onRequestClose?.();
                      }
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
                <button
                  type="button"
                  aria-label="Clear search"
                  className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={closeSearch}
                >
                  <XIcon className="size-4" />
                </button>
              </div>
            </div>

            {/* Fixed pane height of ~3 two-line favorite rows (160px) so tab
                switches never move the popup — longer lists (Claude's 8
                models, broad searches) scroll behind it. It still shrinks
                with the card's --available-height clamp on short windows. */}
            <div className="model-picker-list flex h-40 min-h-0 w-full shrink flex-col overflow-y-auto overscroll-contain">
              <ComboboxListVirtualized className="w-full px-1.5 py-1">
                {isSearching
                  ? (() => {
                      let modelIndex = -1;
                      return searchGroups.map((group) => {
                        const GroupIcon = PROVIDER_ICON_BY_PROVIDER[group.driverKind] ?? null;
                        return (
                          <Fragment key={group.instanceId}>
                            <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">
                              {GroupIcon ? (
                                <GroupIcon className="size-3 shrink-0 opacity-70" />
                              ) : null}
                              {group.accentColor ? (
                                <span
                                  aria-hidden
                                  className="size-1.5 shrink-0 rounded-full"
                                  style={{ backgroundColor: group.accentColor }}
                                />
                              ) : null}
                              <span className="truncate">{group.label}</span>
                              <span className="tabular-nums text-muted-foreground/60">
                                {group.models.length}
                              </span>
                            </div>
                            {group.models.map((model) => {
                              modelIndex += 1;
                              return renderModelRow(model, modelIndex);
                            })}
                          </Fragment>
                        );
                      });
                    })()
                  : orderedModels.map((model, modelIndex) => renderModelRow(model, modelIndex))}
              </ComboboxListVirtualized>
              <ComboboxEmpty className="not-empty:flex not-empty:flex-1 not-empty:items-center not-empty:justify-center not-empty:p-6 empty:h-0 text-xs font-normal leading-snug">
                {emptyMessage}
              </ComboboxEmpty>
            </div>
          </div>
        </Combobox>
      </div>
    </TooltipProvider>
  );
});
