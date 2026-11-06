/**
 * The app's theme as the desktop window sees it (docs/design/custom-themes.md,
 * "Desktop"). The native preference stays apart from colors: built-in System
 * sets `system`, so the OS keeps driving light and dark; a custom theme sets
 * its base and gives the window its own background and title bar symbol
 * colors. Those colors outlive a native appearance change (a theme's window
 * stays its color when the OS flips) and a relaunch: they are kept in
 * `theme-appearance.json` beside the window state, so the window opens in the
 * right color before the page paints.
 */
import {
  type DesktopTheme,
  type DesktopThemeAppearance as DesktopThemeAppearanceInput,
  DesktopThemeColorsSchema,
  type DesktopThemeColors,
} from "@threadlines/contracts";
import { fromLenientJson } from "@threadlines/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";

export const THEME_APPEARANCE_FILE_NAME = "theme-appearance.json";

const LIGHT_WINDOW_BACKGROUND = "#ffffff";
const DARK_WINDOW_BACKGROUND = "#0a0a0a";
const LIGHT_TITLEBAR_SYMBOL = "#1f2937";
const DARK_TITLEBAR_SYMBOL = "#f8fafc";

/** The window's own colors: a custom theme's, else the built-in ones for the OS's look. */
export function windowAppearanceColors(
  shouldUseDarkColors: boolean,
  custom: DesktopThemeColors | null,
): DesktopThemeColors {
  if (custom) return custom;
  return shouldUseDarkColors
    ? { windowBackground: DARK_WINDOW_BACKGROUND, titleBarSymbol: DARK_TITLEBAR_SYMBOL }
    : { windowBackground: LIGHT_WINDOW_BACKGROUND, titleBarSymbol: LIGHT_TITLEBAR_SYMBOL };
}

/** Accepts today's appearance and the bare theme names older pages send. */
export const DesktopThemeAppearancePayload = Schema.Union([
  Schema.Literals(["light", "dark", "system"]),
  Schema.Struct({
    nativeSource: Schema.Literals(["light", "dark", "system"]),
    colors: Schema.optional(DesktopThemeColorsSchema),
  }),
]);

export function normalizeThemeAppearance(
  payload: DesktopTheme | DesktopThemeAppearanceInput,
): DesktopThemeAppearanceInput {
  return typeof payload === "string" ? { nativeSource: payload } : payload;
}

const PersistedColorsJson = fromLenientJson(Schema.NullOr(DesktopThemeColorsSchema));
const decodePersistedColors = Schema.decodeEffect(PersistedColorsJson);
const encodePersistedColors = Schema.encodeEffect(PersistedColorsJson);

export interface DesktopThemeAppearanceShape {
  /** A custom theme's window colors, or null under a built-in. */
  readonly colors: Effect.Effect<DesktopThemeColors | null>;
  /** Applies the app's theme: the native source now, the colors for every later sync. */
  readonly set: (appearance: DesktopThemeAppearanceInput) => Effect.Effect<void>;
}

export class DesktopThemeAppearance extends Context.Service<
  DesktopThemeAppearance,
  DesktopThemeAppearanceShape
>()("threadlines/desktop/ThemeAppearance") {}

export const layer = Layer.effect(
  DesktopThemeAppearance,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const electronTheme = yield* ElectronTheme.ElectronTheme;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(environment.stateDir, THEME_APPEARANCE_FILE_NAME);
    const stored = yield* fileSystem.readFileString(filePath).pipe(
      Effect.flatMap(decodePersistedColors),
      Effect.catch(() => Effect.succeed(null)),
    );
    const colors = yield* Ref.make<DesktopThemeColors | null>(stored);

    return DesktopThemeAppearance.of({
      colors: Ref.get(colors),
      set: (appearance) =>
        Effect.gen(function* () {
          const next = appearance.colors ?? null;
          const previous = yield* Ref.getAndSet(colors, next);
          yield* electronTheme.setSource(appearance.nativeSource);
          if (JSON.stringify(previous) === JSON.stringify(next)) return;
          yield* Effect.gen(function* () {
            const encoded = yield* encodePersistedColors(next);
            yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
            yield* fileSystem.writeFileString(filePath, `${encoded}\n`);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to keep the theme's window colors", cause),
            ),
          );
        }).pipe(Effect.withSpan("desktop.themeAppearance.set")),
    });
  }),
);

/** In memory, for tests: no file. */
export const layerTest = (initial: DesktopThemeColors | null = null) =>
  Layer.effect(
    DesktopThemeAppearance,
    Effect.gen(function* () {
      const electronTheme = yield* ElectronTheme.ElectronTheme;
      const colors = yield* Ref.make(initial);
      return DesktopThemeAppearance.of({
        colors: Ref.get(colors),
        set: (appearance) =>
          Ref.set(colors, appearance.colors ?? null).pipe(
            Effect.andThen(electronTheme.setSource(appearance.nativeSource)),
          ),
      });
    }),
  );
