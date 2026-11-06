/**
 * Settings › General › Appearance for themes (docs/design/custom-themes.md,
 * "Switching" and "Library actions"): the gallery (built-ins, starters, and
 * the library across computers, each library theme with its menu), what the
 * running art costs on this computer, and the two art settings.
 */
import type { ThemeArtInThreads, ThemeMotion } from "@threadlines/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@threadlines/contracts/settings";
import { EllipsisIcon, UploadIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
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
import { SettingResetButton, SettingsRow } from "../../settings/settingsLayout";
import { ThemeTileView } from "./ThemeTileView";

const failed = (title: `Couldn't ${string}`) => (error: unknown) =>
  toastManager.add(
    failureNotice({
      title,
      reason: error instanceof Error ? error.message : "Something went wrong. Try again.",
    }),
  );

const ENERGY_WORDS = { light: "Light", medium: "Medium", heavy: "Heavy" } as const;

/** One line about the running theme's art: its cost here, or why it isn't moving. */
function ArtStatusLine() {
  const status = useBackdropStatus();
  const active = useActiveTheme();
  if (status === null || active.manifest?.backdrop === undefined) return null;
  if (status.kind === "running") {
    return (
      <span>
        Live art: {ENERGY_WORDS[status.energy]} on this computer
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

function LibraryTileMenu({
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
  const library = tile.library;
  if (!library) return null;
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
        <MenuItem onClick={onRename}>Rename</MenuItem>
        <MenuItem
          onClick={() =>
            void duplicateLibraryTheme(library, `${tile.name} copy`.slice(0, 60)).catch(
              failed("Couldn't duplicate the theme"),
            )
          }
        >
          Duplicate
        </MenuItem>
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
        <MenuSeparator />
        <MenuItem variant="destructive" onClick={onDelete}>
          {inUse ? "Delete…" : "Delete"}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** The gallery: every theme this device can wear, the one it wears marked. */
export function ThemeRow() {
  const { builtins, starters, library } = useThemeTiles();
  const committed = useThemeChoice();
  const active = useActiveTheme();
  const unavailable = useThemeUnavailable();
  const fileInput = useRef<HTMLInputElement>(null);
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
  const section = (label: string, tiles: readonly ThemeTile[]) =>
    tiles.length === 0 ? null : (
      <div className="space-y-1.5">
        <div className="px-1 text-[12px] font-medium text-muted-foreground">{label}</div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-1">
          {tiles.map((tile) => (
            <div key={tile.key} className="group/tile relative">
              <ThemeTileView
                tile={tile}
                selected={sameThemeChoice(tile.choice, committed)}
                onSelect={() => pick(tile)}
                className="w-full"
              />
              {tile.group === "library" ? (
                <LibraryTileMenu
                  tile={tile}
                  inUse={sameThemeChoice(tile.choice, committed)}
                  onRename={() => setRenaming(tile)}
                  onDelete={() =>
                    sameThemeChoice(tile.choice, committed) ? setConfirmDelete(tile) : remove(tile)
                  }
                />
              ) : null}
            </div>
          ))}
        </div>
      </div>
    );
  return (
    <SettingsRow
      place="general.theme"
      resetAction={
        !(committed.kind === "builtin" && committed.id === "system") ? (
          <SettingResetButton
            label="theme"
            onClick={() => chooseTheme({ kind: "builtin", id: "system" })}
          />
        ) : null
      }
      status={
        unavailable !== null ? (
          <span>
            {unavailable.name} isn't on this device or any connected computer, so you're seeing
            {active.base === "dark" ? " Dark" : " Light"} for now.
          </span>
        ) : (
          <>
            <DeletedElsewhereNotice />
            <UnsavedNotice />
          </>
        )
      }
      control={
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
          <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()}>
            <UploadIcon aria-hidden />
            Import theme file
          </Button>
        </>
      }
    >
      <div className="space-y-3 pt-3 pb-3">
        <div className="px-1 text-[12px] text-muted-foreground">
          <ArtStatusLine />
        </div>
        {section("Built in", builtins)}
        {section("Starters", starters)}
        {section("Your themes", library) ?? (
          <p className="px-1 text-[12.5px] text-muted-foreground">
            Ask any agent to make you a theme, or type /theme in a chat. Themes you keep show up
            here on every device.
          </p>
        )}
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
    </SettingsRow>
  );
}

const ART_LABELS: Record<ThemeArtInThreads, string> = { none: "None", some: "Some", full: "Full" };

export function ThemeArtInThreadsRow() {
  const value = useSettings((settings) => settings.themeArtInThreads);
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      place="general.themeArtInThreads"
      resetAction={
        value !== DEFAULT_UNIFIED_SETTINGS.themeArtInThreads ? (
          <SettingResetButton
            label="art in threads"
            onClick={() =>
              updateSettings({ themeArtInThreads: DEFAULT_UNIFIED_SETTINGS.themeArtInThreads })
            }
          />
        ) : null
      }
      control={
        <SegmentedControl
          size="sm"
          value={value}
          onValueChange={(next) => updateSettings({ themeArtInThreads: next })}
          aria-label="Art in threads"
        >
          {(Object.keys(ART_LABELS) as ThemeArtInThreads[]).map((option) => (
            <SegmentedControlItem key={option} value={option}>
              {ART_LABELS[option]}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      }
    />
  );
}

const MOTION_LABELS: Record<ThemeMotion, string> = { live: "Live", still: "Still" };

export function ThemeMotionRow() {
  const value = useSettings((settings) => settings.themeMotion);
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      place="general.themeMotion"
      resetAction={
        value !== DEFAULT_UNIFIED_SETTINGS.themeMotion ? (
          <SettingResetButton
            label="motion"
            onClick={() => updateSettings({ themeMotion: DEFAULT_UNIFIED_SETTINGS.themeMotion })}
          />
        ) : null
      }
      control={
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
      }
    />
  );
}
