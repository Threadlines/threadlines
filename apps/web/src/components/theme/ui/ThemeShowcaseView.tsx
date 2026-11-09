/**
 * The Showcase on the Appearance page (docs/design/custom-themes.md,
 * "Showcase"): themes people shared, reviewed before they're listed. A tile
 * starts a trial, the same as an agent's offer, so nothing changes until the
 * person keeps it. Filters narrow it to featured, dark or light themes.
 */
import type { EnvironmentId, ThemeShowcaseEntry } from "@threadlines/contracts";
import { type ReactNode, useId, useState } from "react";

import { cn } from "~/lib/utils";
import { useActiveTheme } from "~/theme/themeStore";
import { describeTheme } from "~/themeLibrary/themeCatalog";
import {
  loadShowcase,
  tryShowcaseTheme,
  useShowcase,
  useShowcaseEnvironments,
  useShowcasePicture,
} from "~/themeLibrary/themeShowcase";
import { moveBetweenTabs, pageTabId } from "../../ui/page-tabs";
import { Spinner } from "../../ui/spinner";
import { failureNotice, toastManager } from "../../ui/toast";
import { ThemeTileView } from "./ThemeTileView";

type ShowcaseFilter = "all" | "featured" | "dark" | "light";

const SHOWCASE_FILTERS: ReadonlyArray<{ readonly value: ShowcaseFilter; readonly label: string }> =
  [
    { value: "all", label: "All" },
    { value: "featured", label: "Featured" },
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
  ];

/** Who the tile credits: the author's own name, else the account that shared it. */
const creditLine = (entry: ThemeShowcaseEntry) =>
  entry.credits?.author !== undefined
    ? `by ${entry.credits.author}`
    : entry.sharedBy !== null
      ? `by @${entry.sharedBy}`
      : describeTheme({ base: entry.base, hasArt: entry.hasArt });

function ShowcaseTile({
  environmentId,
  entry,
  selected,
}: {
  readonly environmentId: EnvironmentId;
  readonly entry: ThemeShowcaseEntry;
  readonly selected: boolean;
}) {
  const picture = useShowcasePicture(environmentId, entry.id);
  const [opening, setOpening] = useState(false);
  return (
    <ThemeTileView
      tile={{
        key: `showcase:${entry.id}`,
        name: entry.name,
        detail: creditLine(entry),
        swatch: { base: entry.base, ...entry.colors },
        thumbnail: picture === null || picture === "failed" ? null : picture,
      }}
      selected={selected}
      className={cn("w-full", opening && "opacity-70")}
      onSelect={() => {
        if (selected || opening) return;
        setOpening(true);
        void tryShowcaseTheme(environmentId, entry)
          .catch((error: unknown) =>
            toastManager.add(
              failureNotice({
                title: `Couldn't try ${entry.name}`,
                reason: error instanceof Error ? error.message : "Try again.",
              }),
            ),
          )
          .finally(() => setOpening(false));
      }}
    />
  );
}

export function ThemeShowcaseView({ switcher }: { readonly switcher: ReactNode }) {
  const environments = useShowcaseEnvironments();
  const environmentId = environments[0]?.environmentId ?? null;
  const { listing, loading } = useShowcase(environmentId);
  const active = useActiveTheme();
  const [filter, setFilter] = useState<ShowcaseFilter>("all");
  const panelId = useId();

  if (environmentId === null) {
    return (
      <>
        <div className="flex items-center">{switcher}</div>
        <p className="px-1 text-[12.5px] text-muted-foreground">
          Update Threadlines on this computer to see the Showcase.
        </p>
      </>
    );
  }

  const themes = listing?.themes ?? [];
  const featured = themes.some((entry) => entry.featured);
  const filters = SHOWCASE_FILTERS.filter(({ value }) => value !== "featured" || featured);
  const current = filters.some(({ value }) => value === filter) ? filter : "all";
  const shown = themes
    .filter((entry) =>
      current === "featured"
        ? entry.featured
        : current === "dark" || current === "light"
          ? entry.base === current
          : true,
    )
    .toSorted((a, b) => b.addedAt.localeCompare(a.addedAt));
  const tryAgain = (
    <button
      type="button"
      disabled={loading}
      className="font-medium text-primary-readable underline-offset-2 hover:underline disabled:opacity-60"
      onClick={() => void loadShowcase(environmentId, true)}
    >
      Try again
    </button>
  );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        {switcher}
        <div
          role="tablist"
          aria-label="Show Showcase themes"
          className="flex flex-wrap items-center gap-0.5"
        >
          {filters.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              role="tab"
              id={pageTabId(panelId, label)}
              aria-selected={current === value}
              aria-controls={panelId}
              tabIndex={current === value ? 0 : -1}
              className={cn(
                "cursor-pointer rounded-md px-2 py-0.5 text-[12.5px] leading-5 font-medium transition-colors focus-ring",
                current === value
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setFilter(value)}
              onKeyDown={moveBetweenTabs}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={pageTabId(
          panelId,
          filters.find(({ value }) => value === current)?.label ?? "All",
        )}
        className="flex flex-col gap-1.5"
      >
        {listing?.issue === "unreachable" ? (
          <p className="inline-flex flex-wrap items-center gap-x-2 px-1 text-[12.5px] text-muted-foreground">
            {themes.length > 0
              ? "Couldn't reach the Showcase, so this list may be old."
              : "Couldn't reach the Showcase."}
            {tryAgain}
          </p>
        ) : listing?.issue === "updateNeeded" ? (
          <p className="px-1 text-[12.5px] text-muted-foreground">
            The Showcase changed. Update Threadlines to see what's new in it.
          </p>
        ) : null}
        {listing === null && loading ? (
          <div className="flex items-center gap-2 px-1 text-[12.5px] text-muted-foreground">
            <Spinner className="size-3.5" />
            Loading the Showcase…
          </div>
        ) : shown.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-1">
            {shown.map((entry) => (
              <ShowcaseTile
                key={entry.id}
                environmentId={environmentId}
                entry={entry}
                selected={active.hash === entry.hash}
              />
            ))}
          </div>
        ) : listing !== null && listing.issue === null ? (
          <p className="px-1 text-[12.5px] text-muted-foreground">
            {themes.length === 0
              ? "Nothing here yet. Share one of your themes from its menu."
              : "No themes like that yet."}
          </p>
        ) : null}
        <p className="px-1 text-[12px] leading-[18px] text-muted-foreground">
          Themes people shared, reviewed before they're listed. Trying one changes nothing until you
          keep it.
        </p>
      </div>
    </>
  );
}
