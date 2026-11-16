/**
 * VS Code themes on the Appearance page (docs/design/custom-themes.md, "VS
 * Code themes"): color themes from extensions on the Open VSX store, under
 * an open license. A tile opens its extension's themes; trying one starts a
 * trial like a Showcase theme, and several can be added to the library at
 * once. Loads only when its tab is picked.
 */
import type { EnvironmentId, ThemeVsCodeExtension, ThemeVsCodeSort } from "@threadlines/contracts";
import { type ReactNode, useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import {
  addVsCodeThemes,
  loadVsCodePackage,
  tryVsCodeTheme,
  useVsCodeEnvironments,
  useVsCodePackage,
  useVsCodeSearch,
  vsCodeExtensionKey,
} from "~/themeLibrary/themeVsCode";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import { failureNotice, toastManager } from "../../ui/toast";
import { ThemeSwatch, ThemeTileView } from "./ThemeTileView";

const SORTS: ReadonlyArray<{ readonly value: ThemeVsCodeSort; readonly label: string }> = [
  { value: "downloads", label: "Most downloaded" },
  { value: "rating", label: "Best rated" },
  { value: "relevance", label: "Best match" },
];

/** How long typing settles before a search goes out. */
const SEARCH_DELAY_MS = 350;

/** A tile's picture before its extension is read: the app's own quiet colors. */
const PENDING_SWATCH = {
  base: "dark",
  background: "var(--muted)",
  foreground: "var(--muted-foreground)",
  accent: "var(--muted-foreground)",
} as const;

const versions = (count: number) => (count === 1 ? "" : ` · ${count} versions`);

function VsCodeTile({
  environmentId,
  extension,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly extension: ThemeVsCodeExtension;
  readonly onOpen: () => void;
}) {
  const read = useVsCodePackage(environmentId, extension);
  const first = read !== null && "themes" in read ? read.themes[0] : undefined;
  const failed = read !== null && ("failed" in read || read.themes.length === 0);
  return (
    <ThemeTileView
      tile={{
        key: `vscode:${vsCodeExtensionKey(extension)}`,
        name: extension.displayName,
        detail: failed
          ? "Can't be brought in"
          : `by ${extension.publisher}${versions(extension.themeCount)}`,
        swatch: first === undefined ? PENDING_SWATCH : { base: first.base, ...first.colors },
        thumbnail: null,
      }}
      selected={false}
      className={cn("w-full", failed && "opacity-60")}
      onSelect={onOpen}
    />
  );
}

/** An extension's themes: pick one to try, or several to add to the library. */
function VsCodeThemesDialog({
  environmentId,
  extension,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly extension: ThemeVsCodeExtension;
  readonly onClose: () => void;
}) {
  const read = useVsCodePackage(environmentId, extension);
  const themes = read !== null && "themes" in read ? read.themes : [];
  // By position: two themes in one extension can share a name.
  const [picked, setPicked] = useState<ReadonlySet<number> | null>(null);
  const [busy, setBusy] = useState(false);
  // The first theme is picked once they arrive, until the person picks for themselves.
  const chosen = picked ?? new Set(themes.length > 0 ? [0] : []);
  const selected = themes.filter((_theme, index) => chosen.has(index));
  const adjusted = selected.reduce((sum, theme) => sum + theme.adjusted, 0);
  const author = themes[0]?.manifest.credits?.author;

  const toggle = (index: number, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(index);
    else next.delete(index);
    setPicked(next);
  };

  const confirm = () => {
    if (selected.length === 0 || busy) return;
    setBusy(true);
    if (selected.length === 1) {
      void tryVsCodeTheme(selected[0]!)
        .then(onClose)
        .catch((error: unknown) =>
          toastManager.add(
            failureNotice({
              title: `Couldn't try ${selected[0]!.label}`,
              reason: error instanceof Error ? error.message : "Try again.",
            }),
          ),
        )
        .finally(() => setBusy(false));
      return;
    }
    void addVsCodeThemes(selected)
      .then((count) => {
        toastManager.add({
          type: "success",
          title: `Added ${count} themes to your library`,
        });
        onClose();
      })
      .catch((error: unknown) =>
        toastManager.add(
          failureNotice({
            title: "Couldn't add the themes",
            reason: error instanceof Error ? error.message : "Try again.",
          }),
        ),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-md" data-testid="theme-vscode-dialog">
        <DialogHeader>
          <DialogTitle>{extension.displayName}</DialogTitle>
          <DialogDescription>
            by {extension.publisher} · {extension.license}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          {read === null ? (
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Spinner className="size-3.5" />
              Reading its themes…
            </div>
          ) : "failed" in read ? (
            <p className="text-[13px] text-muted-foreground">
              {read.failed}{" "}
              <button
                type="button"
                className="font-medium text-primary-readable underline-offset-2 hover:underline"
                onClick={() => void loadVsCodePackage(environmentId, extension)}
              >
                Try again
              </button>
            </p>
          ) : (
            <>
              {themes.length > 0 ? (
                <div className="flex flex-col">
                  {themes.map((theme, index) => (
                    // A label: the whole row picks the theme.
                    <label
                      key={`${theme.file}\u0000${theme.label}`}
                      className="flex cursor-pointer items-center gap-3 border-border py-1.5 not-first:border-t"
                    >
                      <Checkbox
                        checked={chosen.has(index)}
                        onCheckedChange={(checked) => toggle(index, checked === true)}
                      />
                      <div className="aspect-[5/3] w-16 shrink-0 overflow-hidden rounded-[var(--app-radius-control)] ring-1 ring-border">
                        <ThemeSwatch swatch={{ base: theme.base, ...theme.colors }} />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-[13.5px] font-medium">{theme.label}</div>
                        <div className="text-[12px] text-muted-foreground">
                          {theme.base === "dark" ? "Dark" : "Light"}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              ) : null}
              {read.skipped.length > 0 ? (
                <p className="text-[12px] leading-[18px] text-muted-foreground">
                  {read.skipped.length === 1
                    ? "One theme can't"
                    : `${read.skipped.length} themes can't`}{" "}
                  be brought in: {read.skipped.map((entry) => entry.label).join(", ")}.{" "}
                  {read.skipped[0]!.reason}
                </p>
              ) : null}
              {themes.length > 0 ? (
                <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[12.5px]">
                  <dt className="text-muted-foreground">Comes over</dt>
                  <dd>Colors for the app, code and terminal. No fonts or art.</dd>
                  <dt className="text-muted-foreground">Readability</dt>
                  <dd>
                    {adjusted === 0
                      ? "Passes as it is."
                      : `Passes. ${adjusted === 1 ? "1 color" : `${adjusted} colors`} moved a little to stay readable.`}
                  </dd>
                  <dt className="text-muted-foreground">License</dt>
                  <dd>
                    {extension.license}
                    {author === undefined ? "" : ` · ${author} credited on the theme`}
                  </dd>
                </dl>
              ) : null}
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={selected.length === 0 || busy} onClick={confirm}>
            {selected.length > 1
              ? `Add ${selected.length} themes`
              : `Try ${selected[0]?.label ?? "it"}`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function ThemeVsCodeView({ switcher }: { readonly switcher: ReactNode }) {
  const environments = useVsCodeEnvironments();
  const environmentId = environments[0]?.environmentId ?? null;
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ThemeVsCodeSort>("downloads");
  const [open, setOpen] = useState<ThemeVsCodeExtension | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(typed.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [typed]);
  const search = useVsCodeSearch(environmentId, query, sort);

  if (environmentId === null) {
    return (
      <>
        <div className="flex items-center">{switcher}</div>
        <p className="px-1 text-[12.5px] text-muted-foreground">
          Update Threadlines on this computer to bring in VS Code themes.
        </p>
      </>
    );
  }

  return (
    <>
      <div className="flex items-center">{switcher}</div>
      <div className="flex items-center gap-2">
        <Input
          size="sm"
          type="search"
          placeholder="Search VS Code themes"
          aria-label="Search VS Code themes"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
        <Select value={sort} onValueChange={(value) => value !== null && setSort(value)}>
          <SelectTrigger size="sm" className="w-auto shrink-0" aria-label="Order themes by">
            <SelectValue>{SORTS.find((option) => option.value === sort)?.label}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {SORTS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {search.error !== null ? (
        <p className="inline-flex flex-wrap items-center gap-x-2 px-1 text-[12.5px] text-muted-foreground">
          {search.error}
          <button
            type="button"
            className="font-medium text-primary-readable underline-offset-2 hover:underline"
            onClick={search.retry}
          >
            Try again
          </button>
        </p>
      ) : null}
      {search.incomplete && search.error === null && !search.loading ? (
        <p className="inline-flex flex-wrap items-center gap-x-2 px-1 text-[12.5px] text-muted-foreground">
          The store didn't answer for some themes, so a few may be missing.
          <button
            type="button"
            className="font-medium text-primary-readable underline-offset-2 hover:underline"
            onClick={search.retry}
          >
            Try again
          </button>
        </p>
      ) : null}
      {search.extensions.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-1">
          {search.extensions.map((extension) => (
            <VsCodeTile
              key={vsCodeExtensionKey(extension)}
              environmentId={environmentId}
              extension={extension}
              onOpen={() => setOpen(extension)}
            />
          ))}
        </div>
      ) : search.loading ? (
        <div className="flex items-center gap-2 px-1 text-[12.5px] text-muted-foreground">
          <Spinner className="size-3.5" />
          Searching…
        </div>
      ) : search.error === null ? (
        <p className="px-1 text-[12.5px] text-muted-foreground">No VS Code themes match that.</p>
      ) : null}
      {search.more !== null ? (
        <div>
          <Button variant="outline" size="sm" onClick={search.more}>
            Show more
          </Button>
        </div>
      ) : search.loading && search.extensions.length > 0 ? (
        <div className="flex items-center gap-2 px-1 text-[12.5px] text-muted-foreground">
          <Spinner className="size-3.5" />
          Loading more…
        </div>
      ) : null}
      <p className="px-1 text-[12px] leading-[18px] text-muted-foreground">
        From the Open VSX store. Only themes under an open license are listed. Trying one changes
        nothing until you keep it. Import takes VS Code theme files too.
      </p>
      {open !== null ? (
        <VsCodeThemesDialog
          environmentId={environmentId}
          extension={open}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}
