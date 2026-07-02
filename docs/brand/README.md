# Threadlines brand kit

The mark is the product's empty-state thread graph: a main line with commit dots and a live
branch that curves down to the accent node. Geometry is lifted verbatim from
`apps/web/src/components/NoActiveThreadState.tsx` (and the marketing hero animation), so the
logo, the app, and the website all draw the same figure. Accent blue approximates
`oklch(0.7 0.17 264)` (`--accent-bright` / dark-mode `--primary-graph`).

Open `threadlines-brand-sheet.html` for the visual overview (`threadlines-brand-sheet.png` is
its rendered copy).

## Layout

- `svg/` — vector sources (the truth)
  - `threadlines-mark.svg` — full lockup-scale mark (exact empty-state paths)
  - `threadlines-glyph.svg` — bare nav/lockup glyph (no tile); inlined in marketing `Layout.astro`
  - `threadlines-icon.svg` — app icon tile, regular weight (used at 64px and up)
  - `threadlines-icon-small.svg` — app icon tile, bold strokes for 16/32/48 raster sizes
- `png/` — rendered size set (16–1024, opaque 1024 for iOS, apple-touch 180)
- `icons/` — packed containers (`.ico` for Windows/web favicon, `.icns` for macOS)
- `pipeline/` — regeneration tooling

## Usage rules

- Use `Threadlines` as the visible product wordmark in prose, UI labels, navigation, and
  marketing copy. Keep `threadlines` lowercase only where the medium requires it, such as
  domains, URLs, handles, package names, filenames, CSS identifiers, and generated asset paths.
- Glyph or dot, never both: with the glyph, use `Threadlines` and no period. Standalone text
  wordmark may use `Threadlines.` when the mark needs the terminal dot.
- Small variant only exists for rasterization; vector contexts (nav, in-app) use the regular
  mark at any size.

## Regenerating after editing the SVGs

1. Render masters with headless Edge (window sizes under ~128px hang or come out blank — always
   render large and downscale; `--force-device-scale-factor=1` is required on scaled displays):

   ```
   msedge --headless --disable-gpu --force-device-scale-factor=1 \
     --default-background-color=00000000 --virtual-time-budget=2000 \
     --screenshot=png/threadlines-icon-512.png --window-size=512,512 \
     "file:///<repo>/docs/brand/pipeline/export-icon.html?variant=regular"
   ```

   Same for `threadlines-icon-1024.png`, `threadlines-icon-small-512.png` (`?variant=small`),
   and `threadlines-icon-1024-opaque.png` (background `2C2C2CFF`, the plate color — the icon
   plate is `#2c2c2c`, matching the app's dark `--card` token and the macOS adaptive dark tile).

2. `powershell -File pipeline/resize-icons.ps1` — builds the 16–256 set + apple-touch 180.
3. `bun pipeline/pack-icons.ts` — packs `icons/*.ico` and `icons/*.icns`.

## Where the assets are deployed

- `assets/{dev,nightly,prod}/threadlines-*` — channel masters consumed by
  `scripts/lib/brand-assets.ts`, `scripts/build-desktop-artifact.ts`, and
  `scripts/apply-web-brand-assets.ts`. All three channels currently share the same artwork.
  The `*-macos-{dark,light}-1024.png` appearance masters are NOT rendered from these SVGs:
  they are tuned layer images for the macOS 26 adaptive icon (borderless, no node halo,
  softened stroke opacities) because the system draws the tile mask and edge itself. Only
  their plate colors (`#2c2c2c` dark / `#f8f8f8` light) must stay in sync with the SVG plate.
- `apps/desktop/resources/icon.{ico,icns,png}` — desktop dev-runtime icons. The macOS
  `icon.png` and `icon.icns` are padded for Dock display; keep the raw 1024px channel masters in
  `assets/{dev,nightly,prod}/`.
- `apps/web/public/` and `apps/marketing/public/` — favicons and apple-touch icons. The web
  app's boot shell logo is `/splash-icon.png`, a copy of the transparent
  `png/threadlines-icon-256.png` (the apple-touch icon is opaque and would show square
  corners against the page background).
- macOS installer `.icns` is regenerated on the Mac builder from the 1024 PNG by
  `build-desktop-artifact.ts`; the checked-in `resources/icon.icns` is for dev runs.
