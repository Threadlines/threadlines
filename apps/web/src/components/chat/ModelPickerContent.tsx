import {
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { memo, useMemo, useState, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { SearchIcon, StarIcon } from "lucide-react";
import { ModelListRow } from "./ModelListRow";
import { buildModelPickerSearchText, scoreModelPickerSearch } from "./modelPickerSearch";
import { Combobox, ComboboxEmpty, ComboboxInput, ComboboxList } from "../ui/combobox";
import { SectionLabel } from "../ui/threadline";
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

/** Display row in the grouped picker list: a section header or a model. */
type ModelPickerListRow =
  | {
      kind: "header";
      id: string;
      label: string;
      driverKind?: ProviderDriverKind;
      accentColor?: string;
    }
  | { kind: "model"; model: ModelPickerItem };

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
  const listRegionRef = useRef<HTMLDivElement>(null);
  const highlightedModelKeyRef = useRef<string | null>(null);
  const favorites = useSettings((s) => s.favorites ?? []);
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
  const isSearching = searchQuery.trim().length > 0;
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

  // Tokenized fuzzy search across the combined provider/model fields. While
  // searching the list is one flat ranked run (no group structure).
  const searchedModels = useMemo(() => {
    if (!searchQuery.trim()) {
      return [];
    }
    const rankedMatches = flatModels
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
            isFavorite: favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
          },
          searchQuery,
        ),
        isFavorite: favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
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

    const lockFiltered =
      props.lockedProvider !== null
        ? rankedMatches.filter((rankedModel) => matchesLockedProvider(rankedModel.model))
        : rankedMatches;

    return lockFiltered
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
  }, [favoritesSet, flatModels, matchesLockedProvider, props.lockedProvider, searchQuery]);

  // Default view: one list grouped by section — Favorites first, then each
  // instance in configured order. A favorited model lives in Favorites only
  // (never duplicated in its provider group) so combobox keys stay unique.
  const listRows = useMemo((): ModelPickerListRow[] => {
    if (isSearching) {
      return searchedModels.map((model) => ({ kind: "model" as const, model }));
    }

    const rows: ModelPickerListRow[] = [];
    const eligibleModels = isLocked
      ? flatModels.filter((model) => matchesLockedProvider(model))
      : flatModels;
    const favoriteModels: ModelPickerItem[] = [];
    const modelsByInstance = new Map<ProviderInstanceId, ModelPickerItem[]>();
    for (const model of eligibleModels) {
      if (!isLocked && favoritesSet.has(providerModelKey(model.instanceId, model.slug))) {
        favoriteModels.push(model);
        continue;
      }
      const group = modelsByInstance.get(model.instanceId);
      if (group) {
        group.push(model);
      } else {
        modelsByInstance.set(model.instanceId, [model]);
      }
    }

    if (favoriteModels.length > 0) {
      rows.push({ kind: "header", id: "favorites", label: "Favorites" });
      for (const model of sortProviderModelItems(favoriteModels, {
        favoriteModelKeys: favoritesSet,
        groupFavorites: false,
        instanceOrder,
      })) {
        rows.push({ kind: "model", model });
      }
    }

    const groupedInstances = instanceEntries.filter((entry) =>
      modelsByInstance.has(entry.instanceId),
    );
    const showGroupHeaders =
      !lockedToSingleInstance && (groupedInstances.length > 1 || favoriteModels.length > 0);
    for (const entry of groupedInstances) {
      const models = modelsByInstance.get(entry.instanceId);
      if (!models || models.length === 0) {
        continue;
      }
      if (showGroupHeaders) {
        rows.push({
          kind: "header",
          id: entry.instanceId,
          label: entry.displayName,
          driverKind: entry.driverKind,
          ...(entry.accentColor ? { accentColor: entry.accentColor } : {}),
        });
      }
      // Locked mode has no favorites section, so favorites float within the
      // group instead.
      for (const model of sortProviderModelItems(models, {
        favoriteModelKeys: favoritesSet,
        groupFavorites: isLocked,
        instanceOrder: [],
      })) {
        rows.push({ kind: "model", model });
      }
    }
    return rows;
  }, [
    favoritesSet,
    flatModels,
    instanceEntries,
    instanceOrder,
    isLocked,
    isSearching,
    lockedToSingleInstance,
    matchesLockedProvider,
    searchedModels,
  ]);

  const orderedModels = useMemo(
    () =>
      listRows
        .filter(
          (row): row is Extract<ModelPickerListRow, { kind: "model" }> => row.kind === "model",
        )
        .map((row) => row.model),
    [listRows],
  );

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
      const newFavorites = [...favorites];
      const index = newFavorites.findIndex((f) => f.provider === instanceId && f.model === model);
      if (index >= 0) {
        newFavorites.splice(index, 1);
      } else {
        newFavorites.push({ provider: instanceId, model });
      }
      updateSettings({ favorites: newFavorites });
    },
    [favorites, updateSettings],
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
  const allModelKeys = useMemo(
    (): string[] => flatModels.map((model) => `${model.instanceId}:${model.slug}`),
    [flatModels],
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

  useLayoutEffect(() => {
    const listRegion = listRegionRef.current;
    if (!listRegion) {
      return;
    }

    let cancelled = false;
    let frame = 0;
    let nestedFrame = 0;
    let timeout = 0;

    const measureScrollArea = () => {
      if (cancelled) {
        return;
      }
      const viewport = listRegion.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
      if (!viewport || viewport.scrollHeight <= viewport.clientHeight) {
        return;
      }
      const originalScrollTop = viewport.scrollTop;
      const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
      if (maxScrollTop <= 0) {
        return;
      }
      viewport.scrollTop = Math.min(originalScrollTop + 1, maxScrollTop);
      viewport.scrollTop = originalScrollTop;
    };

    queueMicrotask(measureScrollArea);
    frame = window.requestAnimationFrame(() => {
      measureScrollArea();
      nestedFrame = window.requestAnimationFrame(measureScrollArea);
    });
    timeout = window.setTimeout(measureScrollArea, 0);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(nestedFrame);
      window.clearTimeout(timeout);
    };
  }, [orderedModelKeys]);

  return (
    <TooltipProvider delay={0}>
      <div className="relative flex h-screen max-h-96 w-screen max-w-96 flex-col overflow-hidden rounded-lg border bg-popover not-dark:bg-clip-padding text-popover-foreground shadow-lg/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
        {/* Locked provider banner: the turn's driver cannot change */}
        {lockedToSingleInstance && LockedProviderIcon && lockedHeaderLabel && (
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <LockedProviderIcon className="size-5 shrink-0" />
            <span className="text-sm font-medium">{lockedHeaderLabel}</span>
          </div>
        )}

        <Combobox
          inline
          items={allModelKeys}
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
                  if (e.key === "Enter" && highlightedModelKeyRef.current) {
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

            {/* Model list: Favorites first, then one section per provider */}
            <div
              ref={listRegionRef}
              className="relative min-h-0 flex-1 before:pointer-events-none before:absolute before:inset-0 before:bg-muted/40"
            >
              <ComboboxList className="model-picker-list size-full px-1.5 py-1">
                {(() => {
                  let modelIndex = -1;
                  return listRows.map((row) => {
                    if (row.kind === "header") {
                      const HeaderIcon = row.driverKind
                        ? (PROVIDER_ICON_BY_PROVIDER[row.driverKind] ?? null)
                        : null;
                      return (
                        <div
                          key={`header:${row.id}`}
                          role="presentation"
                          data-model-picker-group={row.id}
                          className="flex items-center justify-between gap-2 px-2 pb-1 pt-3 first:pt-1.5"
                        >
                          <SectionLabel>{row.label}</SectionLabel>
                          <span className="flex shrink-0 items-center gap-1">
                            {row.accentColor ? (
                              <span
                                aria-hidden
                                className="size-1.5 rounded-full"
                                style={{ backgroundColor: row.accentColor }}
                              />
                            ) : null}
                            {row.id === "favorites" ? (
                              <StarIcon className="size-3 fill-current text-yellow-500/70" />
                            ) : HeaderIcon ? (
                              <HeaderIcon className="size-3 opacity-50" />
                            ) : null}
                          </span>
                        </div>
                      );
                    }
                    modelIndex += 1;
                    const modelKey = `${row.model.instanceId}:${row.model.slug}`;
                    return (
                      <ModelListRow
                        key={modelKey}
                        index={modelIndex}
                        model={row.model}
                        instanceId={row.model.instanceId}
                        driverKind={row.model.driverKind}
                        providerDisplayName={row.model.instanceDisplayName}
                        providerAccentColor={row.model.instanceAccentColor}
                        isFavorite={favoritesSet.has(modelKey)}
                        showProvider={isSearching}
                        preferShortName={!isLocked}
                        useTriggerLabel={lockedToSingleInstance}
                        jumpLabel={modelJumpLabelByKey.get(modelKey) ?? null}
                        onToggleFavorite={() =>
                          toggleFavorite(row.model.instanceId, row.model.slug)
                        }
                      />
                    );
                  });
                })()}
              </ComboboxList>
            </div>
            <ComboboxEmpty className="not-empty:py-6 empty:h-0 text-xs font-normal leading-snug">
              No models found
            </ComboboxEmpty>
          </div>
        </Combobox>
      </div>
    </TooltipProvider>
  );
});
