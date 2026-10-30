import type {
  ProviderInstanceId,
  ServerConfig,
  ServerProvider,
  ServerProviderSkill,
} from "@threadlines/contracts";
import { APP_PLACES, type AppPlace, type PlaceId, placeById } from "@threadlines/shared/appPlaces";
import {
  matchSearchFields,
  parseSearchQuery,
  type SearchFields,
  type SearchMatch,
  type SearchQuery,
} from "@threadlines/shared/placeSearch";
import { useMemo } from "react";

import { useServerKeybindings, useServerProviders } from "../../rpc/serverState";
import { buildKeybindingRows, commandLabel, type KeybindingRow } from "./KeybindingsSettings.logic";
import { getDriverOption } from "./providerDriverMeta";
import {
  type SettingsPagePlaceId,
  type SettingsPlaceSearchId,
  type SettingsSurface,
  useSettingsPlaceShown,
  useSettingsSurface,
} from "./settingsPlaceAvailability";
import { SETTINGS_NAV_ITEMS } from "./settingsNavigation";

/**
 * What the settings search finds and how it ranks it
 * (docs/design/settings-search.md): the settings places, plus the things
 * Settings lists that aren't places of their own (providers, keyboard
 * shortcuts, skills).
 */

interface SearchItemBase {
  /** Unique among results, for React keys. */
  readonly key: string;
  /** The Settings page the item is on: the menu counts by it. */
  readonly page: SettingsPagePlaceId;
  readonly fields: SearchFields;
  /** Rows before what holds them: a row says where exactly. */
  readonly kindRank: number;
  /** Catalog order, so equal matches keep the order of the pages. */
  readonly order: number;
}

export type SettingsSearchItem =
  | (SearchItemBase & {
      readonly type: "place";
      readonly place: SettingsPlaceSearchId;
      /** The section it sits in on this surface, when that isn't its catalog parent. */
      readonly shownIn: SettingsPlaceSearchId | null;
    })
  | (SearchItemBase & {
      readonly type: "provider";
      readonly instanceId: ProviderInstanceId;
      readonly provider: ServerProvider;
    })
  | (SearchItemBase & { readonly type: "shortcut"; readonly binding: KeybindingRow })
  | (SearchItemBase & {
      readonly type: "skill";
      readonly skill: ServerProviderSkill;
      /** The providers that offer it, by name. */
      readonly providers: ReadonlyArray<string>;
    });

export interface SettingsSearchResult {
  readonly item: SettingsSearchItem;
  readonly match: SearchMatch;
}

export interface SettingsSearchResults {
  readonly query: SearchQuery;
  readonly results: ReadonlyArray<SettingsSearchResult>;
  /** Results per Settings page, for the menu's counts. */
  readonly countByPage: ReadonlyMap<SettingsPagePlaceId, number>;
}

/** The Settings pages in the menu (Diagnostics, opened from General, is not one). */
const MENU_PAGES: ReadonlyMap<string, SettingsPagePlaceId> = new Map(
  SETTINGS_NAV_ITEMS.map((item) => [item.place, item.place]),
);

/**
 * Where the phone app shows a row elsewhere than the catalog says: its
 * paired computer's settings gather under This computer.
 */
const PHONE_SECTION: Partial<Record<SettingsPlaceSearchId, SettingsPlaceSearchId>> = {
  "general.streamReplies": "general.thisComputer",
  "general.usageAnalytics": "general.thisComputer",
};

const keywordsOf = (id: PlaceId): ReadonlyArray<string> => placeById(id).keywords ?? [];

/** The catalog's settings places as search items, for one surface. */
function placeItems(surface: SettingsSurface): ReadonlyArray<SettingsSearchItem> {
  const places = APP_PLACES as ReadonlyArray<AppPlace>;
  const sectionsWithRows = new Set<string>(
    places.flatMap((place) => (place.kind === "row" ? [place.parent] : [])),
  );
  const items: SettingsSearchItem[] = [];
  places.forEach((place, order) => {
    if (place.kind === "page") {
      const page = MENU_PAGES.get(place.id);
      if (page === undefined) return;
      items.push({
        type: "place",
        key: place.id,
        place: page,
        shownIn: null,
        page,
        kindRank: 3,
        order,
        fields: { title: place.title, keywords: keywordsOf(place.id), about: place.about },
      });
      return;
    }
    const sectionId = place.kind === "row" ? place.parent : place.id;
    const pageId = MENU_PAGES.get(placeById(sectionId).parent ?? "");
    if (pageId === undefined) return;
    const id = place.id as SettingsPlaceSearchId;
    if (place.kind === "section") {
      // A section with rows is found through them; one without is its own result.
      if (sectionsWithRows.has(place.id)) return;
      items.push({
        type: "place",
        key: id,
        place: id,
        shownIn: null,
        page: pageId,
        kindRank: 2,
        order,
        fields: {
          title: place.title,
          keywords: keywordsOf(place.id),
          page: placeById(pageId).title,
          about: place.about,
        },
      });
      return;
    }
    const shownIn = surface === "phone" ? (PHONE_SECTION[id] ?? null) : null;
    const section = placeById(shownIn ?? sectionId);
    items.push({
      type: "place",
      key: id,
      place: id,
      shownIn,
      page: pageId,
      kindRank: 0,
      order,
      fields: {
        title: place.title,
        keywords: keywordsOf(place.id),
        // A section's words find its rows as its title does, below a row's own.
        section: [section.title, ...(section.keywords ?? [])].join(" "),
        page: placeById(pageId).title,
        about: place.about,
      },
    });
  });
  return items;
}

const CATALOG_SIZE = APP_PLACES.length;

/** Each provider this computer has, by its name, its driver's and its models'. */
function providerItems(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<SettingsSearchItem> {
  return providers.map((provider, index) => {
    const driverLabel = getDriverOption(provider.driver)?.label ?? String(provider.driver);
    return {
      type: "provider",
      key: `provider:${provider.instanceId}`,
      instanceId: provider.instanceId,
      provider,
      page: "settings.providers",
      kindRank: 1,
      order: CATALOG_SIZE + index,
      fields: {
        title: provider.displayName ?? driverLabel,
        keywords: [
          driverLabel,
          "provider",
          ...provider.models.flatMap((model) => [model.name, model.slug]),
        ],
        page: "Providers",
      },
    };
  });
}

/** Each keyboard shortcut, by what its command does. */
function shortcutItems(
  keybindings: ServerConfig["keybindings"],
): ReadonlyArray<SettingsSearchItem> {
  return buildKeybindingRows(keybindings, "").map((binding, index) => ({
    type: "shortcut",
    key: `shortcut:${binding.id}`,
    binding,
    page: "settings.keybindings",
    kindRank: 1,
    order: CATALOG_SIZE + 1_000 + index,
    fields: {
      title: commandLabel(binding.command),
      keywords: ["shortcut", "keyboard shortcut", "hotkey", binding.command],
      page: "Keybindings",
    },
  }));
}

/** Each skill the providers report, once per name, with who offers it. */
function skillItems(providers: ReadonlyArray<ServerProvider>): ReadonlyArray<SettingsSearchItem> {
  const byName = new Map<string, { skill: ServerProviderSkill; providers: string[] }>();
  for (const provider of providers) {
    const providerName =
      provider.displayName ?? getDriverOption(provider.driver)?.label ?? String(provider.driver);
    for (const skill of provider.skills) {
      const entry = byName.get(skill.name);
      if (entry === undefined) byName.set(skill.name, { skill, providers: [providerName] });
      else if (!entry.providers.includes(providerName)) entry.providers.push(providerName);
    }
  }
  return [...byName.values()].map(({ skill, providers: offeredBy }, index) => ({
    type: "skill",
    key: `skill:${skill.name}`,
    skill,
    providers: offeredBy,
    page: "settings.plugins",
    kindRank: 1,
    order: CATALOG_SIZE + 2_000 + index,
    fields: {
      title: skill.displayName ?? skill.name,
      keywords: ["skill", skill.name],
      page: "Skills",
      about: skill.shortDescription ?? skill.description ?? "",
    },
  }));
}

/**
 * Settings are what people search Settings for: a shortcut named by the
 * query ("Terminal: Toggle" for "terminal") ranks below the settings of a
 * section the query names, and above settings that only mention it.
 */
const SHORTCUT_WEIGHT = 0.3;

/** Ranks the items for a query: best match first, then rows before what holds them, then page order. */
export function rankSettingsSearch(
  items: ReadonlyArray<SettingsSearchItem>,
  text: string,
): SettingsSearchResults {
  const query = parseSearchQuery(text);
  const results: SettingsSearchResult[] = [];
  for (const item of items) {
    const match = matchSearchFields(query, item.fields);
    if (match === null) continue;
    results.push({
      item,
      match: item.type === "shortcut" ? { ...match, score: match.score * SHORTCUT_WEIGHT } : match,
    });
  }
  results.sort(
    (left, right) =>
      right.match.score - left.match.score ||
      left.item.kindRank - right.item.kindRank ||
      left.item.order - right.item.order,
  );
  const countByPage = new Map<SettingsPagePlaceId, number>();
  for (const { item } of results) countByPage.set(item.page, (countByPage.get(item.page) ?? 0) + 1);
  return { query, results, countByPage };
}

/** Everything Settings shows here that a search can find. */
export function settingsSearchItems(input: {
  readonly surface: SettingsSurface;
  readonly shown: (id: SettingsPlaceSearchId) => boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly keybindings: ServerConfig["keybindings"];
}): ReadonlyArray<SettingsSearchItem> {
  return [
    ...placeItems(input.surface).filter((item) => item.type === "place" && input.shown(item.place)),
    ...providerItems(input.providers),
    ...(input.shown("settings.keybindings") ? shortcutItems(input.keybindings) : []),
    ...skillItems(input.providers),
  ];
}

/** Searches what Settings shows here for `text`; follows live changes (a provider added). */
export function useSettingsSearch(text: string): SettingsSearchResults {
  const surface = useSettingsSurface();
  const shown = useSettingsPlaceShown();
  const providers = useServerProviders();
  const keybindings = useServerKeybindings();
  const items = useMemo(
    () => settingsSearchItems({ surface, shown, providers, keybindings }),
    [keybindings, providers, shown, surface],
  );
  return useMemo(() => rankSettingsSearch(items, text), [items, text]);
}
