/**
 * Settings › Appearance, the theme parts (docs/design/custom-themes.md,
 * "Switching" and "Library actions"): New theme and Import, Glass and Motion
 * side by side, what the running art costs on this computer, and the gallery
 * (your themes across computers, the starters and the built-ins, under
 * filters, each library theme with its menu). The settings search draws Glass
 * and Motion as ordinary rows with the same controls.
 */
import { THEME_GLASS_LEVEL_DEFAULT, type ThemeMotion } from "@threadlines/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@threadlines/contracts/settings";
import { placeById, type SettingsPlaceId } from "@threadlines/shared/appPlaces";
import { EllipsisIcon, PlusIcon, UploadIcon } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";

import { useGeneralChats } from "~/components/chats/useGeneralChats";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { useSavedGlassLevel } from "~/theme/glassLevel";
import {
  chooseTheme,
  retryBackdrop,
  useActiveTheme,
  useBackdropStatus,
  useThemeChoice,
  useThemeUnavailable,
} from "~/theme/themeStore";
import {
  loadTileManifest,
  sameThemeChoice,
  switchToTheme,
  type ThemeTile,
  useThemeTiles,
} from "~/themeLibrary/themeCatalog";
import { exportThemeFile, importThemeFile } from "~/themeLibrary/themeFiles";
import {
  deleteLibraryTheme,
  duplicateLibraryTheme,
  renameLibraryTheme,
  restoreLibraryTheme,
  saveThemeToLibrary,
  useLibraryEntry,
} from "~/themeLibrary/themeLibraryState";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../ui/menu";
import { SegmentedControl, SegmentedControlItem } from "../../ui/segmented-control";
import { failureNotice, toastManager } from "../../ui/toast";
import { SettingResetButton, SettingsGroup, SettingsRow } from "../../settings/settingsLayout";
import { moveBetweenTabs, pageTabId } from "../../ui/page-tabs";
import { NEW_THEME_PROMPT } from "./NewThemeHint";
import { ThemeGlassSlider } from "./ThemeGlassSlider";
import { ThemeTileView } from "./ThemeTileView";

const failed = (title: `Couldn't ${string}`) => (error: unknown) =>
  toastManager.add(
    failureNotice({
      title,
      reason: error instanceof Error ? error.message : "Something went wrong. Try again.",
    }),
  );

const ENERGY_WORDS = { light: "a light", medium: "a medium", heavy: "a heavy" } as const;

/** One line about the running theme's art: its cost here, or why it isn't moving. */
function ArtStatusLine() {
  const status = useBackdropStatus();
  const active = useActiveTheme();
  if (status === null || active.manifest?.backdrop === undefined) return null;
  if (status.kind === "running") {
    return (
      <span>
        Live art is on, {ENERGY_WORDS[status.energy]} load on this computer
        {status.throttled ? ", slowed down to save power" : ""}.
      </span>
    );
  }
  if (status.kind === "still") {
    return <span>Showing a still picture of the art.</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2">
      {status.reason === "too-heavy"
        ? "Paused: this theme's art is too heavy for this computer."
        : "Paused: this theme's art stopped working."}
      <button
        type="button"
        className="font-medium text-primary-readable underline-offset-2 hover:underline"
        onClick={retryBackdrop}
      >
        Try again
      </button>
    </span>
  );
}

/** "Not in your library anymore": the device still wears a theme deleted elsewhere. */
function DeletedElsewhereNotice() {
  const choice = useThemeChoice();
  const entry = useLibraryEntry(choice.kind === "library" ? choice.entryId : null);
  const active = useActiveTheme();
  if (choice.kind !== "library" || entry === null || !entry.deleted) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2">
      {choice.name} isn't in your library anymore.
      <button
        type="button"
        className="font-medium text-primary-readable underline-offset-2 hover:underline"
        onClick={() =>
          void restoreLibraryTheme(choice.entryId).catch(failed("Couldn't save it again"))
        }
      >
        Save again
      </button>
      <button
        type="button"
        className="font-medium text-primary-readable underline-offset-2 hover:underline"
        onClick={() => chooseTheme({ kind: "builtin", id: active.base })}
      >
        Switch to {active.base === "dark" ? "Dark" : "Light"}
      </button>
    </span>
  );
}

/** "Only on this device": a kept theme that couldn't be saved to a library then. */
function UnsavedNotice() {
  const choice = useThemeChoice();
  const active = useActiveTheme();
  const [saving, setSaving] = useState(false);
  if (choice.kind !== "unsaved" || active.manifest === null) return null;
  const manifest = active.manifest;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2">
      {choice.name} is only on this device.
      <button
        type="button"
        disabled={saving}
        className="font-medium text-primary-readable underline-offset-2 hover:underline disabled:opacity-60"
        onClick={() => {
          setSaving(true);
          void saveThemeToLibrary(manifest, choice.name)
            .then(({ entry, environmentId }) =>
              chooseTheme(
                {
                  kind: "library",
                  entryId: entry.entryId,
                  hash: entry.hash,
                  name: entry.name,
                  environmentId,
                },
                manifest,
              ),
            )
            .catch(failed("Couldn't save it to your library"))
            .finally(() => setSaving(false));
        }}
      >
        Save to your library
      </button>
    </span>
  );
}

function RenameDialog({
  tile,
  onClose,
}: {
  readonly tile: ThemeTile;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState(tile.name);
  const trimmed = name.trim();
  const save = () => {
    if (!tile.library || trimmed === "" || trimmed === tile.name) return onClose();
    void renameLibraryTheme(tile.library.entry.entryId, trimmed.slice(0, 60))
      .catch(failed("Couldn't rename the theme"))
      .finally(onClose);
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename theme</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <Input
            autoFocus
            value={name}
            maxLength={60}
            aria-label="Theme name"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") save();
            }}
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={trimmed === ""}>
            Rename
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * A starter's or your theme's options: Duplicate (a copy in your themes, to
 * change), Export file and Copy prompt for both; Rename and Delete for your
 * own. Built-ins have none.
 */
function ThemeTileMenu({
  tile,
  inUse,
  onRename,
  onDelete,
}: {
  readonly tile: ThemeTile;
  readonly inUse: boolean;
  readonly onRename: () => void;
  readonly onDelete: () => void;
}) {
  const { copyToClipboard } = useCopyToClipboard();
  if (tile.group === "builtin") return null;
  const library = tile.library ?? null;
  const duplicate = () => {
    const name = `${tile.name} copy`.slice(0, 60);
    const saving = library
      ? duplicateLibraryTheme(library, name)
      : loadTileManifest(tile).then((manifest) => {
          if (!manifest) throw new Error("The theme couldn't be read.");
          return saveThemeToLibrary(manifest, name);
        });
    void saving.catch(failed("Couldn't duplicate the theme"));
  };
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`${tile.name} options`}
            className="absolute top-2 right-2 size-6 rounded-sm bg-popover/90 p-0 text-muted-foreground opacity-0 group-hover/tile:opacity-100 hover:text-foreground focus-visible:opacity-100 data-[popup-open]:opacity-100"
          >
            <EllipsisIcon aria-hidden />
          </Button>
        }
      />
      <MenuPopup align="end">
        {library ? <MenuItem onClick={onRename}>Rename</MenuItem> : null}
        <MenuItem onClick={duplicate}>Duplicate</MenuItem>
        <MenuItem
          onClick={() =>
            void loadTileManifest(tile)
              .then((manifest) => manifest && exportThemeFile(manifest, tile.name))
              .catch(failed("Couldn't export the theme"))
          }
        >
          Export file
        </MenuItem>
        <MenuItem
          onClick={() =>
            void loadTileManifest(tile)
              .then((manifest) => {
                if (manifest?.prompt) copyToClipboard(manifest.prompt);
                else
                  toastManager.add({
                    type: "info",
                    title: "This theme has no prompt saved with it",
                  });
              })
              .catch(failed("Couldn't read the theme"))
          }
        >
          Copy prompt
        </MenuItem>
        {library ? (
          <>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={onDelete}>
              {inUse ? "Delete…" : "Delete"}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** New theme (a general chat that starts the request) and Import: the Themes section's actions. */
export function ThemeActions() {
  const fileInput = useRef<HTMLInputElement>(null);
  // New theme opens a general chat that starts the request (NewThemeHint.tsx).
  const { startChat } = useGeneralChats();
  return (
    <>
      <input
        ref={fileInput}
        type="file"
        accept=".threadlines-theme,application/json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importThemeFile(file);
        }}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={startChat === null}
        onClick={() => startChat?.(NEW_THEME_PROMPT)}
      >
        <PlusIcon aria-hidden />
        New theme
      </Button>
      <Button
        size="sm"
        variant="outline"
        aria-label="Import theme file"
        onClick={() => fileInput.current?.click()}
      >
        <UploadIcon aria-hidden />
        {/* A phone's title line has room for the verb alone. */}
        Import<span className="max-sm:hidden"> theme file</span>
      </Button>
    </>
  );
}

/**
 * What to know about the theme in use, one line each: that it couldn't be
 * found, or lives only here, or was deleted elsewhere; then what its art costs
 * on this computer. Nothing when there is nothing to say.
 */
export function ThemeStatusLines() {
  const unavailable = useThemeUnavailable();
  const active = useActiveTheme();
  return (
    <div className="flex flex-col gap-0.5 px-1 text-[12px] leading-[18px] text-muted-foreground empty:hidden">
      {unavailable !== null ? (
        <span>
          {unavailable.name} isn't on this device or any connected computer, so you're seeing
          {active.base === "dark" ? " Dark" : " Light"} for now.
        </span>
      ) : (
        <>
          <DeletedElsewhereNotice />
          <UnsavedNotice />
        </>
      )}
      <ArtStatusLine />
    </div>
  );
}

type ThemeFilter = "all" | "yours" | "starters" | "builtin";

const THEME_FILTERS: ReadonlyArray<{ readonly value: ThemeFilter; readonly label: string }> = [
  { value: "all", label: "All" },
  { value: "yours", label: "Yours" },
  { value: "starters", label: "Starters" },
  { value: "builtin", label: "Built in" },
];

/**
 * The gallery: every theme this device can wear, yours first, the one it
 * wears marked. Plain words above it narrow it to one kind; nothing is
 * remembered, so Settings always opens on All.
 */
export function ThemeGallery() {
  const { builtins, starters, library } = useThemeTiles();
  const committed = useThemeChoice();
  const active = useActiveTheme();
  const [filter, setFilter] = useState<ThemeFilter>("all");
  const panelId = useId();
  const [renaming, setRenaming] = useState<ThemeTile | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ThemeTile | null>(null);
  const pick = (tile: ThemeTile) => {
    if (sameThemeChoice(tile.choice, active.choice)) return;
    void switchToTheme(tile).catch(failed(`Couldn't switch to ${tile.name}`));
  };
  const remove = (tile: ThemeTile) => {
    if (!tile.library) return;
    void deleteLibraryTheme(tile.library.entry.entryId).catch(failed("Couldn't delete the theme"));
  };
  const tiles =
    filter === "yours"
      ? library
      : filter === "starters"
        ? starters
        : filter === "builtin"
          ? builtins
          : [...library, ...starters, ...builtins];
  const showHint = library.length === 0 && (filter === "all" || filter === "yours");
  return (
    <div data-place="appearance.theme" className="flex flex-col gap-1.5">
      <div role="tablist" aria-label="Show themes" className="flex flex-wrap items-center gap-0.5">
        {THEME_FILTERS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={pageTabId(panelId, label)}
            aria-selected={filter === value}
            aria-controls={panelId}
            tabIndex={filter === value ? 0 : -1}
            className={cn(
              "cursor-pointer rounded-md px-2 py-0.5 text-[12.5px] leading-5 font-medium transition-colors focus-ring",
              filter === value
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
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={pageTabId(
          panelId,
          THEME_FILTERS.find(({ value }) => value === filter)?.label ?? "All",
        )}
        className="flex flex-col gap-1.5"
      >
        {tiles.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-1">
            {tiles.map((tile) => (
              <div key={tile.key} className="group/tile relative">
                <ThemeTileView
                  tile={tile}
                  selected={sameThemeChoice(tile.choice, committed)}
                  onSelect={() => pick(tile)}
                  className="w-full"
                />
                {tile.group !== "builtin" ? (
                  <ThemeTileMenu
                    tile={tile}
                    inUse={sameThemeChoice(tile.choice, committed)}
                    onRename={() => setRenaming(tile)}
                    onDelete={() =>
                      sameThemeChoice(tile.choice, committed)
                        ? setConfirmDelete(tile)
                        : remove(tile)
                    }
                  />
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {showHint ? (
          <p className="px-1 text-[12.5px] text-muted-foreground">
            New theme asks an agent to make one from a few words, and you try it before you keep it.
            Themes you keep show up here on every device.
          </p>
        ) : null}
      </div>
      {renaming ? <RenameDialog tile={renaming} onClose={() => setRenaming(null)} /> : null}
      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => (open ? undefined : setConfirmDelete(null))}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {confirmDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This device is using it. It switches to {active.base === "dark" ? "Dark" : "Light"},
              and the theme leaves your library on every computer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button
              variant="destructive"
              onClick={() => {
                if (confirmDelete) {
                  chooseTheme({ kind: "builtin", id: active.base });
                  remove(confirmDelete);
                }
                setConfirmDelete(null);
              }}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

/** The Glass slider, with its ends and middle named under it. */
function GlassControl({ className = "w-full sm:w-56" }: { readonly className?: string }) {
  return (
    <div className={className}>
      <ThemeGlassSlider />
      <div className="mt-0.5 flex justify-between text-[11px] text-muted-foreground">
        <span>Solid</span>
        <span>Theme</span>
        <span>Clear</span>
      </div>
    </div>
  );
}

function GlassReset() {
  const level = useSavedGlassLevel();
  const { updateSettings } = useUpdateSettings();
  return level !== THEME_GLASS_LEVEL_DEFAULT ? (
    <SettingResetButton
      label="glass"
      onClick={() => updateSettings({ themeGlass: THEME_GLASS_LEVEL_DEFAULT })}
    />
  ) : null;
}

const MOTION_LABELS: Record<ThemeMotion, string> = { live: "Live", still: "Still" };

function MotionControl() {
  const value = useSettings((settings) => settings.themeMotion);
  const { updateSettings } = useUpdateSettings();
  return (
    <SegmentedControl
      size="sm"
      value={value}
      onValueChange={(next) => updateSettings({ themeMotion: next })}
      aria-label="Motion"
    >
      {(Object.keys(MOTION_LABELS) as ThemeMotion[]).map((option) => (
        <SegmentedControlItem key={option} value={option}>
          {MOTION_LABELS[option]}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

function MotionReset() {
  const value = useSettings((settings) => settings.themeMotion);
  const { updateSettings } = useUpdateSettings();
  return value !== DEFAULT_UNIFIED_SETTINGS.themeMotion ? (
    <SettingResetButton
      label="motion"
      onClick={() => updateSettings({ themeMotion: DEFAULT_UNIFIED_SETTINGS.themeMotion })}
    />
  ) : null;
}

/** Glass as a full row, for the settings search. */
export function ThemeGlassRow() {
  return (
    <SettingsRow place="appearance.glass" resetAction={<GlassReset />} control={<GlassControl />} />
  );
}

/** Motion as a full row, for the settings search. */
export function ThemeMotionRow() {
  return (
    <SettingsRow
      place="appearance.motion"
      resetAction={<MotionReset />}
      control={<MotionControl />}
    />
  );
}

/** One half of the strip: the setting's name (and reset) on the left, its control on the right. */
function ArtStripCell({
  place,
  reset,
  control,
  className,
}: {
  readonly place: SettingsPlaceId;
  readonly reset: ReactNode;
  readonly control: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      data-place={place}
      className={cn("relative flex items-center gap-3 px-3.5 py-2.5", className)}
    >
      <div className="flex shrink-0 items-center gap-1.5">
        <h3 className="text-[13.5px] leading-[19px] font-medium text-foreground">
          {placeById(place).title}
        </h3>
        <span className="inline-flex size-5 shrink-0 items-center justify-center">{reset}</span>
      </div>
      <div className="ms-auto flex min-w-0 flex-1 justify-end">{control}</div>
    </div>
  );
}

/**
 * Glass and Motion side by side in one group: the page's compact form of the
 * two rows (their descriptions are in the search and the guide). Stacked on a
 * phone, with the group's hairline between them.
 */
export function ThemeArtStrip() {
  return (
    <SettingsGroup className="grid sm:grid-cols-2">
      <ArtStripCell
        place="appearance.glass"
        reset={<GlassReset />}
        control={<GlassControl className="w-full max-w-56" />}
      />
      <ArtStripCell
        place="appearance.motion"
        reset={<MotionReset />}
        control={<MotionControl />}
        className="before:pointer-events-none before:absolute before:bg-group-divider max-sm:before:top-0 max-sm:before:right-0 max-sm:before:left-3.5 max-sm:before:h-px sm:before:top-2.5 sm:before:bottom-2.5 sm:before:left-0 sm:before:w-px"
      />
    </SettingsGroup>
  );
}
