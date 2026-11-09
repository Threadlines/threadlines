import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Custom themes (docs/design/custom-themes.md). A theme is one file: a base
 * (light or dark), a dozen seed colors the app expands into its full token
 * set, optional fonts, glass, and optional live backdrop art. Each computer's
 * server keeps a library of entries; content is stored once per hash and
 * never changes. Which theme a device shows is that device's own choice.
 */

/** The `format` every theme file carries. */
export const THEME_FILE_FORMAT = "threadlines-theme@1";
/** The file extension themes are exported with. */
export const THEME_FILE_EXTENSION = ".threadlines-theme";
/** Largest theme file accepted, in bytes of JSON. */
export const THEME_MAX_FILE_BYTES = 3 * 1024 * 1024;
/** Largest backdrop script, in characters. */
export const THEME_MAX_SCRIPT_CHARS = 200_000;
/** Largest embedded font, in bytes before base64. */
export const THEME_MAX_FONT_BYTES = 400 * 1024;
/** Largest still image, in characters of its data URL. */
export const THEME_MAX_STILL_CHARS = 1_500_000;
/** The highest frame rate a backdrop may ask for. */
export const THEME_MAX_FPS = 30;

export const ThemeBase = Schema.Literals(["light", "dark"]);
export type ThemeBase = typeof ThemeBase.Type;

/** A color in a theme file: `#rrggbb`, or `#rrggbbaa` for a translucent one. */
export const ThemeColor = Schema.String.check(
  Schema.isPattern(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/),
);
export type ThemeColor = typeof ThemeColor.Type;

/** A fraction from 0 to 1. */
const UnitInterval = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

/**
 * The colors a theme chooses; packages/shared themes/tokens.ts derives the
 * rest. `background` is the reading canvas; the frame, rails, cards and
 * popovers step from it the way the built-in themes do.
 */
export const ThemeSeedColors = Schema.Struct({
  background: ThemeColor,
  foreground: ThemeColor,
  mutedForeground: ThemeColor,
  /** Selected, on, send: the theme's one accent. */
  accent: ThemeColor,
  /** Text and icons drawn on the accent. */
  accentForeground: ThemeColor,
  border: Schema.optional(ThemeColor),
  success: Schema.optional(ThemeColor),
  warning: Schema.optional(ThemeColor),
  danger: Schema.optional(ThemeColor),
  info: Schema.optional(ThemeColor),
  codeBackground: Schema.optional(ThemeColor),
  selection: Schema.optional(ThemeColor),
});
export type ThemeSeedColors = typeof ThemeSeedColors.Type;

/** Syntax colors for code blocks and diffs. Missing ones use the base's built-in theme. */
export const ThemeCodePalette = Schema.Struct({
  foreground: Schema.optional(ThemeColor),
  comment: Schema.optional(ThemeColor),
  keyword: Schema.optional(ThemeColor),
  string: Schema.optional(ThemeColor),
  number: Schema.optional(ThemeColor),
  function: Schema.optional(ThemeColor),
  type: Schema.optional(ThemeColor),
  variable: Schema.optional(ThemeColor),
  operator: Schema.optional(ThemeColor),
  punctuation: Schema.optional(ThemeColor),
});
export type ThemeCodePalette = typeof ThemeCodePalette.Type;

/** The 16 terminal colors: black, red, green, yellow, blue, magenta, cyan, white, then the bright eight. */
export const ThemeTerminalPalette = Schema.Array(ThemeColor).check(
  Schema.isMinLength(16),
  Schema.isMaxLength(16),
);
export type ThemeTerminalPalette = typeof ThemeTerminalPalette.Type;

/**
 * A font. An agent names a family from a font host; the server downloads it
 * once when the theme is first saved and embeds it (`data`, base64 woff2),
 * so a saved theme is self-contained and never fetches anything at runtime.
 * `system` names a stack the computer already has and carries no data.
 */
const FontWeight = Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 900 }));

export const ThemeFont = Schema.Struct({
  family: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  source: Schema.Literals(["system", "google", "bunny"]),
  weight: Schema.optional(FontWeight),
  data: Schema.optional(Schema.String),
  /** Set when `data` is a variable font: the weights it draws, so bold text keeps its weight. */
  weights: Schema.optional(Schema.Struct({ min: FontWeight, max: FontWeight })),
});
export type ThemeFont = typeof ThemeFont.Type;

export const ThemeFonts = Schema.Struct({
  ui: Schema.optional(ThemeFont),
  mono: Schema.optional(ThemeFont),
});
export type ThemeFonts = typeof ThemeFonts.Type;

/**
 * How readable text over the art must stay: `standard` keeps 4.5:1 (normal
 * text), `relaxed` 3:1 (large text), for themes made for the art more than
 * long reading. Text on solid surfaces keeps its checks either way.
 */
export const GlassReadability = Schema.Literals(["standard", "relaxed"]);
export type GlassReadability = typeof GlassReadability.Type;

/**
 * How much tint each glass surface gets over the backdrop (0 clear, 1
 * opaque) and the frost blur in CSS px. These are floors: the user's Glass
 * slider moves them, and readability can raise a tint, never lower it.
 */
export const ThemeGlass = Schema.Struct({
  frame: UnitInterval,
  list: UnitInterval,
  column: UnitInterval,
  composer: UnitInterval,
  blur: Schema.Int.check(Schema.isBetween({ minimum: 8, maximum: 48 })),
  readability: Schema.optional(GlassReadability),
});
export type ThemeGlass = typeof ThemeGlass.Type;

/** How a backdrop draws (docs/design/custom-themes.md, "The backdrop runtime"). */
export const ThemeBackdropMode = Schema.Literals(["grid", "pixels", "canvas"]);
export type ThemeBackdropMode = typeof ThemeBackdropMode.Type;

export const ThemeBackdrop = Schema.Struct({
  mode: ThemeBackdropMode,
  /** The art: a script that calls `threadlines.backdrop({...})`. Runs only in the walled-off worker. */
  script: Schema.String.check(Schema.isMaxLength(THEME_MAX_SCRIPT_CHARS)),
  /** The most frames a second it asks for; the runtime may give fewer. */
  maxFps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: THEME_MAX_FPS })),
  /** A frame of the art as a PNG data URL, captured by the runtime. Shown on phones, in Still, and if the art fails. */
  still: Schema.optional(Schema.String.check(Schema.isMaxLength(THEME_MAX_STILL_CHARS))),
});
export type ThemeBackdrop = typeof ThemeBackdrop.Type;

export const ThemeOrigin = Schema.Struct({
  kind: Schema.Literals(["agent", "user", "imported", "starter"]),
  /** The agent's name, when an agent made it. */
  agent: Schema.optional(TrimmedNonEmptyString),
  /** The thread it was made in. */
  threadId: Schema.optional(TrimmedNonEmptyString),
});
export type ThemeOrigin = typeof ThemeOrigin.Type;

/** A theme file. `name`, `prompt`, `createdBy` and `createdAt` are not part of the content hash. */
export const ThemeManifest = Schema.Struct({
  format: Schema.Literal(THEME_FILE_FORMAT),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  base: ThemeBase,
  colors: ThemeSeedColors,
  /** Replaces derived tokens by name (without `--`); only names in THEME_OVERRIDABLE_TOKENS. */
  overrides: Schema.optional(Schema.Record(Schema.String, ThemeColor)),
  code: Schema.optional(ThemeCodePalette),
  terminal: Schema.optional(ThemeTerminalPalette),
  fonts: Schema.optional(ThemeFonts),
  glass: Schema.optional(ThemeGlass),
  backdrop: Schema.optional(ThemeBackdrop),
  /** What was asked for, for "Copy prompt". */
  prompt: Schema.optional(Schema.String.check(Schema.isMaxLength(8000))),
  createdBy: Schema.optional(ThemeOrigin),
  createdAt: Schema.optional(IsoDateTime),
});
export type ThemeManifest = typeof ThemeManifest.Type;

/** SHA-256 of a theme's canonical content, lowercase hex. */
export const ThemeContentHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export type ThemeContentHash = typeof ThemeContentHash.Type;

/** A library entry's id: a UUID minted once, the same on every computer the entry reaches. */
export const ThemeEntryId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type ThemeEntryId = typeof ThemeEntryId.Type;

/**
 * One library entry: what the user names, keeps and deletes. Two entries may
 * share content (Duplicate). Every change sets `revision` to one more than
 * the highest the computer has seen; the higher `(revision, revisedBy)` wins
 * everywhere, so computers always converge (packages/shared themes/library.ts).
 */
export const ThemeEntry = Schema.Struct({
  entryId: ThemeEntryId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  hash: ThemeContentHash,
  revision: NonNegativeInt,
  /** The computer that made this revision (its environment id). */
  revisedBy: TrimmedNonEmptyString,
  /** A tombstone: deleted at this revision. */
  deleted: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThemeEntry = typeof ThemeEntry.Type;

/** An entry with what a picker needs to draw it without reading the content. */
export const ThemeEntrySummary = Schema.Struct({
  ...ThemeEntry.fields,
  base: ThemeBase,
  background: ThemeColor,
  foreground: ThemeColor,
  accent: ThemeColor,
  backdropMode: Schema.NullOr(ThemeBackdropMode),
  /** A small still for thumbnails (PNG data URL), when the theme has art. */
  thumbnail: Schema.NullOr(Schema.String),
});
export type ThemeEntrySummary = typeof ThemeEntrySummary.Type;

export const ThemeLibrarySnapshot = Schema.Struct({
  /** Every entry, tombstones included, so clients can reconcile computers. */
  entries: Schema.Array(ThemeEntrySummary),
});
export type ThemeLibrarySnapshot = typeof ThemeLibrarySnapshot.Type;

export const ThemesSubscribeInput = Schema.Struct({});
export type ThemesSubscribeInput = typeof ThemesSubscribeInput.Type;

export const ThemeReadInput = Schema.Struct({ hash: ThemeContentHash });
export type ThemeReadInput = typeof ThemeReadInput.Type;

export const ThemeContent = Schema.Struct({
  hash: ThemeContentHash,
  manifest: ThemeManifest,
});
export type ThemeContent = typeof ThemeContent.Type;

/** Saves a theme as a new entry. The server validates it, embeds fonts, and mints the entry id. */
export const ThemeSaveInput = Schema.Struct({
  manifest: ThemeManifest,
  /** Defaults to the manifest's name. */
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(60))),
});
export type ThemeSaveInput = typeof ThemeSaveInput.Type;

export const ThemeRenameInput = Schema.Struct({
  entryId: ThemeEntryId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
});
export type ThemeRenameInput = typeof ThemeRenameInput.Type;

export const ThemeEntryIdInput = Schema.Struct({ entryId: ThemeEntryId });
export type ThemeEntryIdInput = typeof ThemeEntryIdInput.Type;

/**
 * Reconciliation between computers: brings an entry from another computer.
 * The server keeps whichever of its copy and this one wins the revision
 * order. `manifest` is required when the server doesn't hold the content.
 */
export const ThemeMergeInput = Schema.Struct({
  entry: ThemeEntry,
  manifest: Schema.optional(ThemeManifest),
});
export type ThemeMergeInput = typeof ThemeMergeInput.Type;

export class ThemeError extends Schema.TaggedError<ThemeError>()("ThemeError", {
  detail: TrimmedNonEmptyString,
}) {
  override get message(): string {
    return this.detail;
  }
}

// ---------------------------------------------------------------------------
// The backdrop bridge: messages between the app and the backdrop frame. Each
// side decodes only the direction it expects; the app accepts only messages
// whose source is its own frame's window, the frame only its parent's.

/** A rectangle in CSS px of the window. */
export const BackdropRect = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  w: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  h: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type BackdropRect = typeof BackdropRect.Type;

/** A corner radius in CSS px, like `border-radius`. */
const BackdropCornerRadius = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }));

/**
 * Where the art is frosted. `core` holds all the text the app can draw in
 * the zone and gets the full tint; a `soft` zone feathers outside its core.
 * `tint` is the floor (the theme's glass, moved by the user's Glass slider).
 */
export const BackdropZone = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(40)),
  edge: Schema.Literals(["hard", "soft"]),
  shape: Schema.Literals(["rect", "ellipse"]),
  rect: BackdropRect,
  core: BackdropRect,
  /**
   * A hard rectangle's rounded corners (top left, top right, bottom right,
   * bottom left), so it matches the surface it sits under. Square without.
   */
  radii: Schema.optional(
    Schema.Tuple([
      BackdropCornerRadius,
      BackdropCornerRadius,
      BackdropCornerRadius,
      BackdropCornerRadius,
    ]),
  ),
  tint: UnitInterval,
  /** The tint color, normally the theme's background. */
  tintColor: ThemeColor,
});
export type BackdropZone = typeof BackdropZone.Type;

/** At most this many zones per update. */
export const BACKDROP_MAX_ZONES = 24;

export const BackdropActivity = Schema.Struct({
  /** Agents working across every connected computer. */
  working: NonNegativeInt,
  /** Agents waiting on the user. */
  waiting: NonNegativeInt,
});
export type BackdropActivity = typeof BackdropActivity.Type;

/** What the app tells the frame about running conditions. */
/**
 * How many times the desktop CPU watchdog may halve the art's rate before a
 * further verdict makes it still.
 */
export const BACKDROP_MAX_SLOWDOWN = 2;

export const BackdropConditions = Schema.Struct({
  /** The user's Motion setting, or Reduce Motion. */
  motion: Schema.Literals(["live", "still"]),
  /** The window can be seen (not hidden, minimized, covered or under a full-window page). */
  visible: Schema.Boolean,
  /** The user is resizing the window or dragging a divider: the art holds still. */
  busy: Schema.Boolean,
  /** No input and no agent working for two minutes. */
  idle: Schema.Boolean,
  /** The window is the one in front: the art runs at the theme's own rate. */
  focused: Schema.Boolean,
  power: Schema.Literals(["ac", "battery", "unknown"]),
  thermal: Schema.Literals(["nominal", "fair", "serious", "critical", "unknown"]),
  /** Times the desktop CPU watchdog halved the art's rate (0 to BACKDROP_MAX_SLOWDOWN). */
  slowdown: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: BACKDROP_MAX_SLOWDOWN })),
});
export type BackdropConditions = typeof BackdropConditions.Type;

/**
 * How far the glass has gone past the theme's own toward Clear, 0 to 1 (the
 * Glass slider's last quarter, web glass.ts glassClarity): the frost and the
 * tint readability adds both fade by it, so at 1 the art shows as it is and
 * only the floors (none at Clear) tint it.
 */
export const BackdropClarity = UnitInterval;

export const BackdropHostMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("init"),
    mode: ThemeBackdropMode,
    script: Schema.String.check(Schema.isMaxLength(THEME_MAX_SCRIPT_CHARS)),
    maxFps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: THEME_MAX_FPS })),
    base: ThemeBase,
    /** The theme's resolved colors, by token name, handed to `draw` as `palette`. */
    palette: Schema.Record(Schema.String, Schema.String),
    /** Every text color the app draws over glass, for the tint bound. */
    textColors: Schema.Array(ThemeColor).check(Schema.isMaxLength(32)),
    /** The ratio each text color needs, same order: 3 to 21. */
    textRatios: Schema.Array(
      Schema.Number.check(Schema.isBetween({ minimum: 3, maximum: 21 })),
    ).check(Schema.isMaxLength(32)),
    blur: Schema.Int.check(Schema.isBetween({ minimum: 8, maximum: 48 })),
    /** How clear the glass is past the theme's own (BackdropClarity); 0 when left out. */
    clarity: Schema.optional(BackdropClarity),
    /** The theme's still (a data URL), shown until the art's first frame: the art fades in from it. */
    still: Schema.optional(Schema.String.check(Schema.isMaxLength(THEME_MAX_STILL_CHARS))),
  }),
  Schema.Struct({
    type: Schema.Literal("viewport"),
    width: Schema.Number,
    height: Schema.Number,
    dpr: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("zones"),
    zones: Schema.Array(BackdropZone).check(Schema.isMaxLength(BACKDROP_MAX_ZONES)),
  }),
  Schema.Struct({ type: Schema.Literal("activity"), activity: BackdropActivity }),
  Schema.Struct({ type: Schema.Literal("pulse"), kind: Schema.Literals(["turn-done"]) }),
  Schema.Struct({ type: Schema.Literal("conditions"), conditions: BackdropConditions }),
  /**
   * New text colors, ratios or clarity after `init` (the Glass slider moved,
   * or the theme's colors changed): the frame keeps running and tints by them.
   */
  Schema.Struct({
    type: Schema.Literal("glass"),
    textColors: Schema.Array(ThemeColor).check(Schema.isMaxLength(32)),
    textRatios: Schema.Array(
      Schema.Number.check(Schema.isBetween({ minimum: 3, maximum: 21 })),
    ).check(Schema.isMaxLength(32)),
    clarity: BackdropClarity,
  }),
  /** Asks for a still; the frame answers with `still`. */
  Schema.Struct({
    type: Schema.Literal("capture-still"),
    requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    width: Schema.Number,
    height: Schema.Number,
  }),
]);
export type BackdropHostMessage = typeof BackdropHostMessage.Type;

/** Work per second, by the runtime's measure, as the label Appearance shows. */
export const BackdropEnergy = Schema.Literals(["light", "medium", "heavy"]);
export type BackdropEnergy = typeof BackdropEnergy.Type;

export const BackdropFailureReason = Schema.Literals([
  "script-error",
  "worker-error",
  "too-heavy",
  "no-webgl",
  "context-lost",
  "bad-output",
]);
export type BackdropFailureReason = typeof BackdropFailureReason.Type;

export const BackdropFrameMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready") }),
  /** Sent at least every second; `frame` is the last frame drawn, so a stalled frame shows. */
  Schema.Struct({ type: Schema.Literal("heartbeat"), frame: NonNegativeInt }),
  Schema.Struct({
    type: Schema.Literal("stats"),
    fps: Schema.Number,
    /** Milliseconds of work per second of wall time, worker and frame together. */
    msPerSecond: Schema.Number,
    energy: BackdropEnergy,
    /** The frame stepped the rate down, or went still, to stay in budget. */
    throttled: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("still"),
    requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    dataUrl: Schema.String.check(Schema.isMaxLength(THEME_MAX_STILL_CHARS)),
  }),
  Schema.Struct({
    type: Schema.Literal("failure"),
    reason: BackdropFailureReason,
    detail: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  }),
]);
export type BackdropFrameMessage = typeof BackdropFrameMessage.Type;

// ---------------------------------------------------------------------------
// Device settings (client settings) that shape how a theme with art shows.

/**
 * The Glass slider: how much of a theme's art shows through the glass on
 * every page, 0 (solid) to 100 (clearest), with the theme's own glass at
 * `THEME_GLASS_LEVEL_DEFAULT`. Text over the art stays readable at any level.
 */
export const ThemeGlassLevel = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
export type ThemeGlassLevel = typeof ThemeGlassLevel.Type;
export const THEME_GLASS_LEVEL_DEFAULT = 50;

/** Before the Glass slider: how much art showed inside threads. Read only to carry the choice over. */
export const ThemeArtInThreads = Schema.Literals(["none", "some", "full"]);
export type ThemeArtInThreads = typeof ThemeArtInThreads.Type;

export const ThemeMotion = Schema.Literals(["live", "still"]);
export type ThemeMotion = typeof ThemeMotion.Type;
