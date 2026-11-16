/**
 * The color editor (docs/design/custom-themes.md, "Editing colors"): a panel
 * beside the app for a theme's own colors. Every change shows at once, as a
 * held trial, so the whole app is the preview; Cancel or Esc puts back what
 * was there. Each color says where it's hard to read, and Fix for me moves
 * those colors (hue kept) until they pass. Pick from the app turns the next
 * click into a question: which of these colors paints that? Save updates a
 * library theme, or saves any theme as a new one.
 *
 * Loads only when it opens (themeEditorState.ts).
 */
import type { ThemeBase, ThemeManifest, ThemeSeedColors } from "@threadlines/contracts";
import { THEME_FILE_FORMAT } from "@threadlines/contracts";
import { BUILTIN_THEME_TOKENS } from "@threadlines/shared/themeBuiltinTokens";
import { color, formatHex } from "@threadlines/shared/themeColor";
import {
  THEME_CONTRAST_PAIRS,
  type ThemeContrastFailure,
  themeContrastFailures,
} from "@threadlines/shared/themeContrast";
import { fitThemeColors, themeTokenSeed } from "@threadlines/shared/themeFit";
import { checkThemeManifest } from "@threadlines/shared/themeManifest";
import { THEME_OPAQUE_TOKENS } from "@threadlines/shared/themeTokens";
import { themeContentHash } from "@threadlines/shared/themeManifestHash";
import type { ThemeTokenName } from "@threadlines/shared/themeTokenNames";
import { resolveThemeTokens } from "@threadlines/shared/themeTokens";
import { CrosshairIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import {
  chooseTheme,
  endThemeTrial,
  holdThemeTrial,
  readThemeState,
  rememberSystemPair,
  startThemeTrial,
  subscribeTheme,
  type ThemePairSide,
} from "~/theme/themeStore";
import { loadTileManifest, pairWithReplaced, type ThemeTile } from "~/themeLibrary/themeCatalog";
import {
  renameLibraryTheme,
  replaceLibraryTheme,
  saveThemeToLibrary,
} from "~/themeLibrary/themeLibraryState";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Spinner } from "../../ui/spinner";
import { failureNotice, toastManager } from "../../ui/toast";
import { builtinThemeStyle } from "./builtinThemeStyle";
import { useThemeEditorStore } from "./themeEditorState";
import { useThemePickerOpenStore } from "./themePickerOpen";
import { type PickedColor, type PickedRole, pickedRoles } from "./themeInspect";

type SeedKey = keyof ThemeSeedColors & string;

/** The theme's own colors, as the editor lists them; an optional one shows the app's until set. */
const SEED_ROWS: ReadonlyArray<{
  readonly key: SeedKey;
  readonly label: string;
  /** The app color shown while the theme leaves this one to the app. */
  readonly derived?: ThemeTokenName;
}> = [
  { key: "background", label: "Background" },
  { key: "foreground", label: "Text" },
  { key: "mutedForeground", label: "Quiet text" },
  { key: "accent", label: "Accent" },
  { key: "accentForeground", label: "Text on accent" },
  { key: "border", label: "Borders", derived: "border" },
  { key: "success", label: "Success", derived: "success" },
  { key: "warning", label: "Warning", derived: "warning" },
  { key: "danger", label: "Error", derived: "destructive" },
  { key: "info", label: "Info", derived: "info" },
  { key: "codeBackground", label: "Code background", derived: "code-background" },
  { key: "selection", label: "Selected text", derived: "text-selection" },
];

/** What a readability pair's text sits on, in words. */
const SURFACE_NAMES: Partial<Record<string, string>> = {
  background: "the page",
  frame: "the window frame",
  rail: "panels",
  sidebar: "the sidebar",
  card: "cards and the message box",
  popover: "menus",
  group: "settings groups",
  "sidebar-accent": "the selected row",
  secondary: "buttons",
  accent: "highlighted menu items",
  control: "buttons",
  "control-hover": "buttons",
  "control-pressed": "pressed buttons",
  "text-selection": "selected text",
  primary: "the accent",
  "primary-hover": "the accent",
  success: "success badges",
  warning: "warning badges",
  info: "info badges",
  destructive: "error badges",
};

/** How long a run of changes (a drag on the color picker) settles before it previews. */
const PREVIEW_SETTLE_MS = 150;

const titleOf = (token: string) =>
  token.charAt(0).toUpperCase() + token.slice(1).replaceAll("-", " ");

/** A built-in theme as a theme file the editor can change: its colors as seeds. */
function builtinManifest(base: ThemeBase, name: string): ThemeManifest {
  const tokens = BUILTIN_THEME_TOKENS[base];
  const hex = (value: string) => formatHex({ ...color(value), a: 1 });
  return {
    format: THEME_FILE_FORMAT,
    name,
    base,
    colors: {
      background: hex(tokens.background),
      foreground: hex(tokens.foreground),
      mutedForeground: hex(tokens["muted-foreground"]),
      accent: hex(tokens.primary),
      accentForeground: hex(tokens["primary-foreground"]),
    },
  };
}

/** The theme to edit, as a file: a built-in's colors, or the theme as saved. */
async function manifestToEdit(tile: ThemeTile): Promise<ThemeManifest> {
  if (tile.choice.kind === "builtin") {
    const base = tile.choice.id === "light" ? "light" : "dark";
    return builtinManifest(base, tile.name);
  }
  const manifest = await loadTileManifest(tile);
  if (manifest === null) throw new Error("The theme couldn't be read.");
  return manifest;
}

/** Which listed color a failing pair is about: a theme color, an override, or the code colors. */
function rowOfFailure(
  failure: ThemeContrastFailure,
  manifest: ThemeManifest,
): PickedColor | "code" | null {
  if (failure.id.startsWith("code/") || failure.id.startsWith("terminal/")) return "code";
  const pair = THEME_CONTRAST_PAIRS.find((item) => item.id === failure.id);
  if (pair === undefined) return null;
  const token = pair.fg === "white" ? (pair.bg as ThemeTokenName) : pair.fg;
  if (manifest.overrides?.[token] !== undefined) return { kind: "override", token };
  const key = themeTokenSeed(token, manifest.base);
  return key === null ? null : { kind: "seed", key };
}

/** A listed color's name, as its row shows it. */
const labelOf = (picked: PickedColor) =>
  picked.kind === "seed"
    ? (SEED_ROWS.find((row) => row.key === picked.key)?.label ?? picked.key)
    : titleOf(picked.token);

const sameColor = (first: PickedColor, second: PickedColor) =>
  first.kind === "seed"
    ? second.kind === "seed" && first.key === second.key
    : second.kind === "override" && first.token === second.token;

const problemText = (failure: ThemeContrastFailure) => {
  const pair = THEME_CONTRAST_PAIRS.find((item) => item.id === failure.id);
  const on = (pair && SURFACE_NAMES[pair.bg]) ?? "its background";
  return `Hard to read on ${on}: ${failure.ratio}:1, needs ${failure.min}:1`;
};

/** The worst problem on each surface, so a color hard to read on the accent and its hover says it once. */
const worstBySurface = (problems: ReadonlyArray<ThemeContrastFailure>) => {
  const worst = new Map<string, ThemeContrastFailure>();
  for (const problem of problems) {
    const words = problemText(problem).split(":")[0]!;
    const kept = worst.get(words);
    if (kept === undefined || problem.ratio < kept.ratio) worst.set(words, problem);
  }
  return [...worst.values()].slice(0, 2);
};

/** One color: its swatch (the system color picker), its hex, and what's wrong with it. */
function ColorRow(props: {
  readonly label: string;
  readonly value: string | undefined;
  /** Shown, quieter, while the theme leaves this color to the app. */
  readonly fallback?: string;
  readonly problems: ReadonlyArray<ThemeContrastFailure>;
  readonly picked: boolean;
  readonly onChange: (value: string | undefined) => void;
  /** Only `#rrggbb`: text sits on it or is drawn in it. */
  readonly opaque?: boolean;
  /** Takes the color back out: to the app's for an optional one, out of the theme for an override. */
  readonly clearLabel?: string;
}) {
  const shown = props.value ?? props.fallback ?? "#000000";
  const [draft, setDraft] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (props.picked) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [props.picked]);
  const commitDraft = () => {
    if (draft === null) return;
    const text = draft.trim().toLowerCase();
    const normalized = text.startsWith("#") ? text : `#${text}`;
    const pattern = props.opaque ? /^#[0-9a-f]{6}$/ : /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/;
    if (pattern.test(normalized)) props.onChange(normalized);
    setDraft(null);
  };
  return (
    <div
      ref={rowRef}
      data-picked={props.picked || undefined}
      className={cn(
        "grid gap-1 rounded-md px-2 py-1.5",
        props.picked && "bg-accent ring-1 ring-primary",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <label
          className="relative size-6 shrink-0 cursor-pointer overflow-hidden rounded-md ring-1 ring-border"
          style={{ background: shown }}
        >
          <span className="sr-only">{props.label}</span>
          <input
            type="color"
            value={shown.slice(0, 7)}
            onChange={(event) => props.onChange(event.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[13px]",
            props.value === undefined && "text-muted-foreground",
          )}
        >
          {props.label}
          {props.value === undefined ? " · from the app" : ""}
        </span>
        <Input
          size="sm"
          aria-label={`${props.label} hex`}
          className="w-[92px] shrink-0 font-mono text-[12px]"
          value={draft ?? props.value ?? ""}
          placeholder="auto"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitDraft();
          }}
        />
        {props.clearLabel !== undefined && props.value !== undefined ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={props.clearLabel}
            tooltip={props.clearLabel}
            onClick={() => props.onChange(undefined)}
          >
            <XIcon aria-hidden />
          </Button>
        ) : null}
      </div>
      {worstBySurface(props.problems).map((problem) => (
        <p key={problem.id} className="pl-8 text-[12px] leading-4 text-destructive-foreground">
          {problemText(problem)}
        </p>
      ))}
    </div>
  );
}

/** While picking: the outline on the spot under the pointer, and the click that answers. */
function useInspector(
  active: boolean,
  manifest: ThemeManifest | null,
  onPicked: (roles: ReadonlyArray<PickedRole>) => void,
) {
  const [outline, setOutline] = useState<DOMRect | null>(null);
  const latest = useRef({ manifest, onPicked });
  useLayoutEffect(() => {
    latest.current = { manifest, onPicked };
  });
  useEffect(() => {
    if (!active) return;
    const outside = (target: EventTarget | null): target is Element =>
      target instanceof Element && target.closest("[data-theme-editor]") === null;
    let frame = 0;
    const onMove = (event: PointerEvent) => {
      const target = event.target;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setOutline(outside(target) ? target.getBoundingClientRect() : null),
      );
    };
    // The app under the pointer must not react to the press that picks.
    const swallow = (event: Event) => {
      if (!outside(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    const onClick = (event: MouseEvent) => {
      if (!outside(event.target)) return;
      swallow(event);
      const current = latest.current.manifest;
      if (current === null) return;
      const styleOf = (element: Element) => {
        const style = getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          color: style.color,
          borderTopColor: style.borderTopColor,
          borderTopWidth: style.borderTopWidth,
        };
      };
      const behind = [];
      for (
        let parent = event.target.parentElement;
        parent !== null;
        parent = parent.parentElement
      ) {
        behind.push(styleOf(parent));
      }
      latest.current.onPicked(
        pickedRoles({
          style: styleOf(event.target),
          behind,
          tokens: resolveThemeTokens(current),
          base: current.base,
          overrides: current.overrides ?? {},
        }),
      );
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerdown", swallow, true);
    window.addEventListener("mousedown", swallow, true);
    window.addEventListener("pointerup", swallow, true);
    window.addEventListener("mouseup", swallow, true);
    window.addEventListener("click", onClick, true);
    document.documentElement.style.cursor = "crosshair";
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerdown", swallow, true);
      window.removeEventListener("mousedown", swallow, true);
      window.removeEventListener("pointerup", swallow, true);
      window.removeEventListener("mouseup", swallow, true);
      window.removeEventListener("click", onClick, true);
      document.documentElement.style.cursor = "";
      setOutline(null);
    };
  }, [active]);
  return active ? outline : null;
}

const PART_WORDS: Record<PickedRole["part"], string> = {
  background: "background",
  text: "text",
  border: "border",
};

export function ThemeColorEditor({ tile }: { readonly tile: ThemeTile }) {
  const close = useThemeEditorStore((state) => state.close);
  const [original, setOriginal] = useState<ThemeManifest | null>(null);
  const [manifest, setManifest] = useState<ThemeManifest | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState(tile.group === "library" ? tile.name : `${tile.name} edited`);
  const [inspecting, setInspecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlyArray<PickedRole> | null>(null);
  const [saving, setSaving] = useState(false);
  const [fixNote, setFixNote] = useState<string | null>(null);
  const trialId = useRef<string | null>(null);
  const library = tile.group === "library" && tile.choice.kind === "library" ? tile.choice : null;

  useEffect(() => {
    let current = true;
    manifestToEdit(tile).then(
      (loaded) => {
        if (!current) return;
        setOriginal(loaded);
        setManifest(loaded);
      },
      (error: unknown) => {
        if (current) setLoadError(error instanceof Error ? error.message : "Try again.");
      },
    );
    return () => {
      current = false;
    };
  }, [tile]);

  // The whole app is the preview: each change becomes a held trial, newest
  // wins. A drag on the color picker settles first: each preview restarts a
  // theme's art.
  const starting = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    if (manifest === null) return;
    let current = true;
    const timer = window.setTimeout(
      () => {
        void themeContentHash(manifest).then((hash) => {
          if (!current || !alive.current) return;
          starting.current = true;
          const trial = startThemeTrial({
            choice: { kind: "unsaved", hash, name: manifest.name },
            manifest,
          });
          holdThemeTrial(trial.id, true);
          starting.current = false;
          trialId.current = trial.id;
          useThemeEditorStore.getState().setTrialId(trial.id);
        });
      },
      trialId.current === null ? 0 : PREVIEW_SETTLE_MS,
    );
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [manifest]);

  /** Leaving without saving puts back what was there; a save still on its way then changes nothing here. */
  const putBack = () => {
    alive.current = false;
    const id = trialId.current;
    trialId.current = null;
    if (id !== null && readThemeState().trial?.id === id) endThemeTrial(id);
  };

  const cancel = () => {
    putBack();
    close();
  };
  // Also when the editor goes away another way (a reload of the page, say).
  const cancelLatest = useRef(cancel);
  useLayoutEffect(() => {
    cancelLatest.current = cancel;
  });
  const putBackLatest = useRef(putBack);
  useLayoutEffect(() => {
    putBackLatest.current = putBack;
  });
  useEffect(() => {
    // Mounted again (React's development double mount): alive until left once more.
    alive.current = true;
    return () => putBackLatest.current();
  }, []);

  // Something else took over the theme (another theme picked, a pick from
  // another device, another window's choice): the preview is gone, so the
  // editor closes rather than show colors the app isn't wearing. The /theme
  // strip opening does the same: it would take the preview for its own.
  useEffect(() => {
    // Before the first preview, what was on screen when the editor opened is the mark.
    const opened = readThemeState();
    const openedChoice = JSON.stringify(opened.committed);
    const stopTheme = subscribeTheme(() => {
      if (starting.current) return;
      const state = readThemeState();
      const ours = trialId.current;
      const takenOver =
        ours === null
          ? state.trial !== opened.trial || JSON.stringify(state.committed) !== openedChoice
          : state.trial?.id !== ours;
      if (!takenOver) return;
      trialId.current = null;
      alive.current = false;
      close();
    });
    const stopStrip = useThemePickerOpenStore.subscribe((state) => {
      if (state.open) cancelLatest.current();
    });
    // The strip open already: the two can't share the preview.
    if (useThemePickerOpenStore.getState().open) cancelLatest.current();
    return () => {
      stopTheme();
      stopStrip();
    };
  }, [close]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (inspecting) setInspecting(false);
      else cancelLatest.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [inspecting]);

  const outline = useInspector(inspecting, manifest, (roles) => {
    setPicked(roles);
    setInspecting(false);
  });

  const failures = useMemo(
    () => (manifest === null ? [] : themeContrastFailures(manifest)),
    [manifest],
  );
  const tokens = useMemo(
    () => (manifest === null ? null : resolveThemeTokens(manifest)),
    [manifest],
  );
  const problemsFor = (row: PickedColor) =>
    manifest === null
      ? []
      : failures.filter((failure) => {
          const owner = rowOfFailure(failure, manifest);
          return owner !== null && owner !== "code" && sameColor(owner, row);
        });
  const otherProblems =
    manifest === null
      ? []
      : failures.filter((failure) => {
          const owner = rowOfFailure(failure, manifest);
          return owner === null || owner === "code";
        });
  const isPicked = (row: PickedColor) =>
    picked?.some((role) => sameColor(role.color, row)) ?? false;

  const setSeed = (key: SeedKey, value: string | undefined) => {
    setFixNote(null);
    setManifest((current) => {
      if (current === null) return current;
      const colors: Record<string, string | undefined> = { ...current.colors, [key]: value };
      if (value === undefined) delete colors[key];
      return { ...current, colors: colors as ThemeSeedColors };
    });
  };
  const setOverride = (token: string, value: string | undefined) => {
    setFixNote(null);
    setManifest((current) => {
      if (current === null) return current;
      const overrides: Record<string, string> = { ...current.overrides };
      if (value === undefined) delete overrides[token];
      else overrides[token] = value;
      const { overrides: _overrides, ...rest } = current;
      return Object.keys(overrides).length === 0 ? rest : { ...rest, overrides };
    });
  };

  const fix = () => {
    if (manifest === null) return;
    const fitted = fitThemeColors(manifest);
    if (!fitted.ok) {
      setFixNote("Some colors can't be fixed this way. Change them by hand.");
      return;
    }
    setManifest(fitted.manifest);
    setFixNote(
      fitted.adjusted === 1
        ? "Moved 1 color a little."
        : `Moved ${fitted.adjusted} colors a little.`,
    );
  };

  const save = (asNew: boolean) => {
    if (manifest === null || saving) return;
    const trimmed = name.trim().slice(0, 60) || tile.name;
    const named: ThemeManifest = { ...manifest, name: trimmed };
    const check = checkThemeManifest(named);
    if (!check.ok) {
      setFixNote(check.errors[0] ?? "This theme can't be saved yet.");
      return;
    }
    setSaving(true);
    const saved =
      library !== null && !asNew
        ? replaceLibraryTheme(library.entryId, check.manifest).then(async (result) => {
            if (trimmed !== tile.name) await renameLibraryTheme(library.entryId, trimmed);
            return result;
          })
        : saveThemeToLibrary({ ...check.manifest, createdBy: { kind: "user" } }, trimmed);
    void saved
      .then(({ entry, environmentId }) => {
        // Cancelled while it saved: it's in the library, and the theme stays as it was.
        if (!alive.current) return;
        alive.current = false;
        const savedChoice: ThemePairSide = {
          kind: "library",
          entryId: entry.entryId,
          hash: entry.hash,
          name: trimmed,
          environmentId,
        };
        // A theme System's pair shows stays in the pair as saved, on the side(s) it was on.
        const { committed, systemPair } = readThemeState();
        if (systemPair !== null) {
          rememberSystemPair(pairWithReplaced(systemPair, tile.choice, savedChoice).pair);
        }
        const inPair =
          committed.kind === "pair" ? pairWithReplaced(committed, tile.choice, savedChoice) : null;
        if (inPair !== null && inPair.modes.length > 0) {
          chooseTheme(
            inPair.pair,
            undefined,
            Object.fromEntries(inPair.modes.map((mode) => [mode, check.manifest])),
          );
        } else {
          chooseTheme(savedChoice, check.manifest);
        }
        // Saved and in use: nothing to put back.
        trialId.current = null;
        close();
      })
      .catch((error: unknown) =>
        toastManager.add(
          failureNotice({
            title: "Couldn't save the theme",
            reason: error instanceof Error ? error.message : "Try again.",
          }),
        ),
      )
      .finally(() => setSaving(false));
  };

  const changed = manifest !== null && JSON.stringify(manifest) !== JSON.stringify(original);
  const check = useMemo(
    () => (manifest === null ? null : checkThemeManifest(manifest)),
    [manifest],
  );
  const readable = failures.length === 0 && check !== null && check.ok;
  // A problem past readability (a size, an opaque color): the first one, in the checker's words.
  const otherCheckError =
    check !== null && !check.ok && failures.length === 0 ? (check.errors[0] ?? null) : null;

  return (
    <>
      {outline !== null ? (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[60] rounded-sm ring-2 ring-primary"
          style={{
            left: outline.left,
            top: outline.top,
            width: outline.width,
            height: outline.height,
          }}
        />
      ) : null}
      <section
        data-theme-editor
        // The built-in colors inside: the editor stays readable whatever the colors being tried.
        style={builtinThemeStyle(original?.base ?? "dark")}
        aria-label={`Edit colors of ${tile.name}`}
        className="fixed top-12 right-3 bottom-3 z-50 flex w-[340px] flex-col overflow-hidden rounded-[var(--app-radius-large)] border border-border bg-popover text-popover-foreground shadow-lg max-sm:inset-x-2 max-sm:top-auto max-sm:bottom-2 max-sm:max-h-[62vh] max-sm:w-auto"
      >
        <header className="flex items-center gap-2 border-b border-border px-3 py-2">
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">Edit colors</h2>
          <Button size="icon-xs" variant="ghost" aria-label="Close" onClick={cancel}>
            <XIcon aria-hidden />
          </Button>
        </header>
        {manifest === null ? (
          <div className="flex items-center gap-2 p-3 text-[13px] text-muted-foreground">
            {loadError === null ? (
              <>
                <Spinner className="size-3.5" />
                Reading the theme…
              </>
            ) : (
              loadError
            )}
          </div>
        ) : (
          <>
            <div className="grid gap-2 border-b border-border px-3 py-2">
              <Input
                size="sm"
                aria-label="Theme name"
                value={name}
                maxLength={60}
                onChange={(event) => setName(event.target.value)}
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant={inspecting ? "default" : "outline"}
                  aria-pressed={inspecting}
                  onClick={() => {
                    setPicked(null);
                    setInspecting((value) => !value);
                  }}
                >
                  <CrosshairIcon aria-hidden />
                  {inspecting ? "Click anything…" : "Pick from the app"}
                </Button>
                {picked !== null ? (
                  <span className="min-w-0 flex-1 text-[12px] leading-4 text-muted-foreground">
                    {picked.length === 0
                      ? "That isn't one of the theme's colors."
                      : `${picked
                          .map(
                            (role, index) =>
                              `${index === 0 ? "Its" : "its"} ${PART_WORDS[role.part]} comes from ${labelOf(role.color)}`,
                          )
                          .join(", ")}.`}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
              {SEED_ROWS.map((row) => {
                const value = manifest.colors[row.key];
                const fallback =
                  row.derived !== undefined && tokens !== null ? tokens[row.derived] : undefined;
                const optional = row.derived !== undefined;
                return (
                  <ColorRow
                    key={row.key}
                    label={row.label}
                    value={value}
                    {...(fallback === undefined ? {} : { fallback })}
                    problems={problemsFor({ kind: "seed", key: row.key })}
                    picked={isPicked({ kind: "seed", key: row.key })}
                    onChange={(next) =>
                      // A required color can't be taken out, only changed.
                      next === undefined && !optional ? undefined : setSeed(row.key, next)
                    }
                    {...(optional
                      ? { clearLabel: `Use the app's ${row.label.toLowerCase()}` }
                      : {})}
                  />
                );
              })}
              {Object.entries(manifest.overrides ?? {}).length > 0 ? (
                <p className="px-2 pt-2 pb-1 text-[12px] text-muted-foreground">
                  Set directly by this theme
                </p>
              ) : null}
              {Object.entries(manifest.overrides ?? {}).map(([token, value]) => (
                <ColorRow
                  key={`override:${token}`}
                  label={titleOf(token)}
                  value={value}
                  problems={problemsFor({ kind: "override", token: token as ThemeTokenName })}
                  picked={isPicked({ kind: "override", token: token as ThemeTokenName })}
                  onChange={(next) => setOverride(token, next)}
                  opaque={THEME_OPAQUE_TOKENS.has(token as ThemeTokenName)}
                  clearLabel={`Let the theme's colors set ${titleOf(token).toLowerCase()}`}
                />
              ))}
              {otherProblems.length > 0 ? (
                <p className="px-2 pt-2 text-[12px] leading-4 text-destructive-foreground">
                  {otherProblems.length === 1
                    ? "1 code or terminal color is hard to read."
                    : `${otherProblems.length} code or terminal colors are hard to read.`}{" "}
                  Fix for me moves them.
                </p>
              ) : null}
            </div>
            <footer className="grid gap-2 border-t border-border px-3 py-2">
              {failures.length > 0 ? (
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 text-[12.5px] text-muted-foreground">
                    {failures.length === 1
                      ? "1 thing is hard to read."
                      : `${failures.length} things are hard to read.`}
                  </span>
                  <Button size="sm" variant="outline" onClick={fix}>
                    Fix for me
                  </Button>
                </div>
              ) : null}
              {otherCheckError !== null ? (
                <p className="text-[12.5px] text-destructive-foreground">{otherCheckError}</p>
              ) : null}
              {fixNote !== null ? (
                <p className="text-[12.5px] text-muted-foreground">{fixNote}</p>
              ) : null}
              <div className="flex items-center justify-end gap-2">
                <Button size="sm" variant="outline" onClick={cancel}>
                  Cancel
                </Button>
                {library !== null ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!readable || saving}
                    onClick={() => save(true)}
                  >
                    Save as new
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  disabled={
                    !readable ||
                    saving ||
                    (library !== null && !changed && name.trim() === tile.name)
                  }
                  onClick={() => save(false)}
                >
                  {library !== null ? "Save" : "Save as new theme"}
                </Button>
              </div>
            </footer>
          </>
        )}
      </section>
    </>
  );
}
