import { placeById, placeHref, type PlaceId } from "@threadlines/shared/appPlaces";
import type { SearchQuery } from "@threadlines/shared/placeSearch";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";

import { nextPlaceArrivalHash, placeScope, resolvePlaceLink } from "../../appPlaceLinks";
import { PLACE_COPIES_ATTRIBUTE } from "../../hooks/usePlaceArrival";
import { usePrimaryEnvironmentId } from "../../environments/primary/context";
import { isElectron } from "../../env";
import { formatShortcutLabel } from "../../keybindings";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { commandLabel } from "./KeybindingsSettings.logic";
import { agentStatusLine, deriveAgentStatus } from "./agentStatus";
import { getDriverOption } from "./providerDriverMeta";
import {
  SearchHighlight,
  SettingsGroup,
  SettingsPageContainer,
  SettingsPageHeader,
  SettingsRow,
  SettingsSearchRowContext,
} from "./settingsLayout";
import { SETTINGS_NAV_ITEMS } from "./settingsNavigation";
import {
  type SettingsPagePlaceId,
  type SettingsPlaceSearchId,
  type SettingsRowPlaceId,
  useSettingsSurface,
} from "./settingsPlaceAvailability";
import { SETTINGS_ROWS } from "./settingsRowRegistry";
import {
  type SettingsSearchResult,
  type SettingsSearchResults as SearchResults,
  useSettingsSearch,
} from "./settingsSearchIndex";
import { useSettingsSearchStore } from "./settingsSearchStore";

/**
 * Settings search (docs/design/settings-search.md): the field, and the
 * results that stand in for the page while it holds a query. Each result is
 * the setting's own row, with a line under it saying where it lives; that
 * line opens the page at the setting.
 */

/**
 * Opens what a result names: its page, at the place, with the place
 * highlighted. The search clears first, so the page (not the result's copy
 * of the row) is what the arrival finds.
 */
function useOpenFromSearch() {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const clear = useSettingsSearchStore((state) => state.clear);
  const openPlace = useCallback(
    (placeId: PlaceId) => {
      const target = resolvePlaceLink({
        href: placeHref(placeId),
        threadEnvironmentId: null,
        primaryEnvironmentId,
        isDesktopApp: isElectron,
      });
      if (target?.kind !== "open") return;
      clear();
      void navigate({
        href: `${target.href}#${nextPlaceArrivalHash(placeId)}`,
        // The hash names a place, not an element id; usePlaceArrival scrolls.
        hashScrollIntoView: false,
        // Like the menu: moving within Settings replaces, so leaving it goes
        // back to where the user was before opening it.
        replace: true,
      });
    },
    [clear, navigate, primaryEnvironmentId],
  );
  const openHref = useCallback(
    (href: string) => {
      clear();
      void navigate({ href, replace: true });
    },
    [clear, navigate],
  );
  return { openPlace, openHref };
}

/** Each Settings page's glyph, drawn once: a result's line starts with its page's. */
const PAGE_ICONS: Readonly<Record<string, ReactNode>> = Object.fromEntries(
  SETTINGS_NAV_ITEMS.map((item) => [
    item.place,
    <item.icon key={item.place} aria-hidden className="size-3 shrink-0" />,
  ]),
);

/**
 * What a result opens: a place (highlighted on arrival), a page with its own
 * reveal, or Keybindings filtered to a shortcut.
 */
type ResultTarget =
  | { readonly placeId: PlaceId }
  | { readonly href: string }
  | { readonly shortcut: string };

/** Opens the result the control sits in (ResultFrame provides it). */
const ResultOpenContext = createContext<() => void>(() => undefined);

/** The plain chevron that opens a result that can't be changed where it stands. */
function OpenButton({ label }: { readonly label: string }) {
  const open = useContext(ResultOpenContext);
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
      aria-label={`Open ${label}`}
      onClick={open}
    >
      <ChevronRightIcon className="size-4" />
    </Button>
  );
}

let lastShortcutOpening = 0;

/**
 * Numbers each opening of a shortcut, so the Keybindings page filters again
 * for it. Taken from the clock, so a reload never repeats one still in the URL.
 */
function nextShortcutOpening(): number {
  lastShortcutOpening = Math.max(Date.now(), lastShortcutOpening + 1);
  return lastShortcutOpening;
}

/** On the phone app, a setting stored on the paired computer says so: the rest are this phone's. */
const pairedComputerNote = (placeId: PlaceId): string | null =>
  placeScope(placeId) === "computer" ? "your paired computer" : null;

/**
 * Around one result: what opens it, and the gray line its row shows under
 * the description (where it lives, and why it matched when its name doesn't
 * say). `trail` null draws no line (a page result names itself).
 */
function ResultFrame({
  result,
  query,
  place,
  trail,
  extraNote = null,
  target,
  children,
}: {
  readonly result: SettingsSearchResult;
  readonly query: SearchQuery;
  /** The row's place, for rows that are one; rows built from data leave it unset. */
  readonly place?: SettingsRowPlaceId | undefined;
  readonly trail: ReadonlyArray<string> | null;
  readonly extraNote?: string | null;
  readonly target: ResultTarget;
  readonly children: ReactNode;
}) {
  const { openPlace, openHref } = useOpenFromSearch();
  const targetPlace = "placeId" in target ? target.placeId : null;
  const targetHref = "href" in target ? target.href : null;
  const targetShortcut = "shortcut" in target ? target.shortcut : null;
  const open = useCallback(() => {
    if (targetPlace !== null) openPlace(targetPlace);
    else if (targetHref !== null) openHref(targetHref);
    else if (targetShortcut !== null) {
      openHref(
        `/settings/keybindings?q=${encodeURIComponent(targetShortcut)}&n=${nextShortcutOpening()}`,
      );
    }
  }, [openHref, openPlace, targetHref, targetPlace, targetShortcut]);
  const page = placeById(result.item.page);
  const where = trail === null ? null : [page.title, ...trail].join(" › ");
  const note =
    [result.match.keyword === null ? null : `matches “${result.match.keyword}”`, extraNote]
      .filter((part) => part !== null)
      .join(" · ") || null;
  const inTitle = result.match.inTitle;
  const pageId = result.item.page;
  const info = useMemo(
    () => ({
      place,
      query,
      inTitle,
      path:
        where === null ? null : (
          <button
            type="button"
            onClick={open}
            className="mt-1 inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-[11.5px] leading-4 text-muted-foreground transition-colors hover:text-foreground focus-ring"
            aria-label={`Open ${where}`}
          >
            {PAGE_ICONS[pageId] ?? null}
            <span className="truncate">
              {where}
              {note ? <span> · {note}</span> : null}
            </span>
          </button>
        ),
    }),
    [inTitle, note, open, pageId, place, query, where],
  );
  return (
    <ResultOpenContext.Provider value={open}>
      <SettingsSearchRowContext.Provider value={info}>{children}</SettingsSearchRowContext.Provider>
    </ResultOpenContext.Provider>
  );
}

function PlaceResult({
  result,
  query,
  placeId,
  shownIn,
}: {
  readonly result: SettingsSearchResult;
  readonly query: SearchQuery;
  readonly placeId: SettingsPlaceSearchId;
  readonly shownIn: SettingsPlaceSearchId | null;
}) {
  const phone = useSettingsSurface() === "phone";
  const place = placeById(placeId);
  if (place.kind === "page") {
    return (
      <ResultFrame result={result} query={query} trail={null} target={{ placeId }}>
        <SettingsRow
          title={<SearchHighlight text={place.title} query={query} />}
          description={place.about}
          control={<OpenButton label={place.title} />}
        />
      </ResultFrame>
    );
  }
  const rowPlace = placeId as SettingsRowPlaceId;
  const entry = place.kind === "row" ? SETTINGS_ROWS[rowPlace] : null;
  const section = place.kind === "row" ? placeById(shownIn ?? (place.parent as PlaceId)) : null;
  return (
    <ResultFrame
      result={result}
      query={query}
      place={rowPlace}
      trail={section === null ? [] : [section.title]}
      extraNote={phone ? pairedComputerNote(placeId) : null}
      target={{ placeId }}
    >
      {entry?.kind === "live" ? (
        <entry.Row />
      ) : (
        <SettingsRow place={rowPlace} control={<OpenButton label={place.title} />} />
      )}
    </ResultFrame>
  );
}

function ResultRow({
  result,
  query,
}: {
  readonly result: SettingsSearchResult;
  readonly query: SearchQuery;
}) {
  const { item } = result;
  switch (item.type) {
    case "place":
      return (
        <PlaceResult result={result} query={query} placeId={item.place} shownIn={item.shownIn} />
      );
    case "provider": {
      const { provider } = item;
      const name = item.fields.title;
      const status = agentStatusLine({
        status: deriveAgentStatus({
          enabled: provider.enabled,
          driverKind: provider.driver,
          snapshot: provider,
        }),
        needs: getDriverOption(provider.driver)?.needs ?? "",
        snapshot: provider,
      });
      return (
        <ResultFrame
          result={result}
          query={query}
          trail={[]}
          target={{
            href: `/settings/providers?instance=${encodeURIComponent(provider.instanceId)}`,
          }}
        >
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                <ProviderInstanceIcon
                  instanceId={provider.instanceId}
                  driverKind={provider.driver}
                  displayName={name}
                  accentColor={provider.accentColor}
                  className="size-4"
                  iconClassName="size-4 text-foreground/80"
                />
                <SearchHighlight text={name} query={query} />
              </span>
            }
            description={status}
            control={<OpenButton label={name} />}
          />
        </ResultFrame>
      );
    }
    case "shortcut": {
      const label = commandLabel(item.binding.command);
      return (
        <ResultFrame result={result} query={query} trail={[]} target={{ shortcut: label }}>
          <SettingsRow
            title={<SearchHighlight text={label} query={query} />}
            description={item.binding.when ? `When ${item.binding.when}` : "Always"}
            control={
              <>
                <Kbd className="h-5 px-1.5 text-[11px]">
                  {formatShortcutLabel(item.binding.binding.shortcut)}
                </Kbd>
                <OpenButton label={label} />
              </>
            }
          />
        </ResultFrame>
      );
    }
    case "skill":
      return (
        <ResultFrame
          result={result}
          query={query}
          trail={["Skills"]}
          extraNote={item.providers.join(", ")}
          target={{ placeId: "plugins.skills" }}
        >
          <SettingsRow
            title={<SearchHighlight text={item.fields.title} query={query} />}
            description={item.fields.about ?? ""}
            control={<OpenButton label={item.fields.title} />}
          />
        </ResultFrame>
      );
  }
}

function resultsLine(search: SearchResults, scope: SettingsPagePlaceId | null, shown: number) {
  const total = search.results.length;
  const quoted = `“${search.query.text}”`;
  if (total === 0) return `Nothing in Settings matches ${quoted}.`;
  const matches = `${total === 1 ? "match" : "matches"} for ${quoted}`;
  return scope === null
    ? `${total} ${matches}.`
    : `${shown} of ${total} ${matches}, in ${placeById(scope).title}.`;
}

/** The results for the query: a header saying how many, then the rows. */
export function SettingsSearchResultsBody({ escHint = false }: { readonly escHint?: boolean }) {
  const query = useSettingsSearchStore((state) => state.query);
  const scope = useSettingsSearchStore((state) => state.scope);
  const setScope = useSettingsSearchStore((state) => state.setScope);
  const search = useSettingsSearch(query);
  const results =
    scope === null ? search.results : search.results.filter((result) => result.item.page === scope);
  const description: ReactNode = (
    <>
      {resultsLine(search, scope, results.length)}
      {scope !== null ? (
        <>
          {" "}
          <button
            type="button"
            className="cursor-pointer font-medium text-foreground underline-offset-2 hover:underline focus-ring"
            onClick={() => setScope(null)}
          >
            Show all
          </button>
        </>
      ) : escHint && results.length > 0 ? (
        " Esc clears the search."
      ) : null}
    </>
  );
  return (
    <>
      <SettingsPageHeader
        title={search.results.length === 0 ? "No matches" : "Search results"}
        description={description}
      />
      {results.length > 0 ? (
        <SettingsGroup data-testid="settings-search-results" {...{ [PLACE_COPIES_ATTRIBUTE]: "" }}>
          {results.map((result) => (
            <ResultRow key={result.item.key} result={result} query={search.query} />
          ))}
        </SettingsGroup>
      ) : null}
    </>
  );
}

/** The results in place of the page, where the settings menu holds the field. */
export function SettingsSearchResults() {
  return (
    <SettingsPageContainer>
      <SettingsSearchResultsBody escHint />
    </SettingsPageContainer>
  );
}
