import { loadFont as loadHanken } from "@remotion/google-fonts/HankenGrotesk";
import { loadFont as loadJetBrains } from "@remotion/google-fonts/JetBrainsMono";

// Brand tokens, copied from the marketing site (apps/marketing/src/layouts/Layout.astro).
// The accents are the site's oklch values converted to sRGB hex.
export const colors = {
  bg: "#09090b",
  bgElev: "#0c0c0e",
  bgCard: "#111113",
  fg: "#fafafa",
  fgMuted: "#a1a1aa",
  fgDim: "#71717a",
  fgFaint: "#52525b",
  border: "rgba(255, 255, 255, 0.08)",
  borderStrong: "rgba(255, 255, 255, 0.14)",
  // oklch(0.62 0.19 264)
  accent: "#497ef7",
  // oklch(0.7 0.17 264)
  accentBright: "#6799ff",
  // The glyph's main line and dots (--line-strong and --node-strong on the site).
  lineStrong: "rgba(255, 255, 255, 0.32)",
  nodeStrong: "rgba(255, 255, 255, 0.45)",
} as const;

/** `rgba()` of the accent at a given alpha, for glows and rings. */
export const accentAlpha = (alpha: number) => `rgba(73, 126, 247, ${alpha})`;
export const accentBrightAlpha = (alpha: number) => `rgba(103, 153, 255, ${alpha})`;

const hanken = loadHanken("normal", {
  weights: ["400", "500", "600", "700"],
  subsets: ["latin"],
});
const jetbrains = loadJetBrains("normal", {
  weights: ["400", "500"],
  subsets: ["latin"],
});

export const fonts = {
  sans: `"${hanken.fontFamily}", -apple-system, system-ui, sans-serif`,
  mono: `"${jetbrains.fontFamily}", ui-monospace, Menlo, monospace`,
} as const;

/** Resolves once both families are ready, for code that measures text. */
export const fontsReady = Promise.all([hanken.waitUntilDone(), jetbrains.waitUntilDone()]);

/** Letter spacing (em), shared by rendering and measurement. */
export const tracking = {
  wordmark: -0.03,
  headline: -0.028,
} as const;
