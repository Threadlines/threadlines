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

- Glyph or dot, never both: with the glyph, lowercase `threadlines` and no period (the node is
  the period). Standalone text wordmark is `threadlines.` In prose and UI labels: `Threadlines`.
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
   and `threadlines-icon-1024-opaque.png` (background `0D0D10FF`).

2. `powershell -File pipeline/resize-icons.ps1` — builds the 16–256 set + apple-touch 180.
3. `bun pipeline/pack-icons.ts` — packs `icons/*.ico` and `icons/*.icns`.

## Where the assets are deployed

- `assets/{dev,nightly,prod}/badcode-*` — channel masters consumed by
  `scripts/lib/brand-assets.ts`, `scripts/build-desktop-artifact.ts`, and
  `scripts/apply-web-brand-assets.ts` (filenames keep the `badcode-` prefix until the identity
  rename phase). All three channels currently share the same artwork.
- `apps/desktop/resources/icon.{ico,icns,png}` — desktop dev-runtime icons.
- `apps/web/public/` and `apps/marketing/public/` — favicons and apple-touch icons (the web
  app's boot shell logo is `/apple-touch-icon.png`).
- macOS installer `.icns` is regenerated on the Mac builder from the 1024 PNG by
  `build-desktop-artifact.ts`; the checked-in `resources/icon.icns` is for dev runs.
