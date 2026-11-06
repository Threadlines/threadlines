/**
 * The starter themes as pickers list them: id, name, light or dark, whether
 * they have art, and the three colors a tile's swatch draws. The full
 * starters (starters.ts) carry their art scripts, so apps load those only
 * when a starter is tried or used; starters.test.ts keeps this list in step.
 */
import type { ThemeBase } from "@threadlines/contracts";

export interface StarterSummary {
  readonly id: string;
  readonly name: string;
  readonly base: ThemeBase;
  readonly hasArt: boolean;
  readonly colors: {
    readonly background: string;
    readonly foreground: string;
    readonly accent: string;
  };
}

export const STARTER_SUMMARIES: ReadonlyArray<StarterSummary> = [
  {
    id: "aurora",
    name: "Aurora",
    base: "dark",
    hasArt: true,
    colors: { background: "#0a1029", foreground: "#e7ecff", accent: "#2fd6b0" },
  },
  {
    id: "meadow",
    name: "Meadow",
    base: "light",
    hasArt: true,
    colors: { background: "#f6f9f1", foreground: "#1e2a1c", accent: "#3b742a" },
  },
  {
    id: "phosphor",
    name: "Phosphor",
    base: "dark",
    hasArt: false,
    colors: { background: "#050b07", foreground: "#b9f7c9", accent: "#39ff88" },
  },
  {
    id: "snowfield",
    name: "Snowfield",
    base: "light",
    hasArt: true,
    colors: { background: "#f5f8fb", foreground: "#1b2430", accent: "#1d4f86" },
  },
  {
    id: "tokyo-rain",
    name: "Tokyo Rain",
    base: "dark",
    hasArt: true,
    colors: { background: "#0b0c17", foreground: "#e6e8f4", accent: "#ff4d94" },
  },
];
