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
    id: "dunes",
    name: "Dunes",
    base: "light",
    hasArt: true,
    colors: { background: "#fbf6ee", foreground: "#2a1f16", accent: "#6e2c10" },
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
    id: "night-rain",
    name: "Night Rain",
    base: "dark",
    hasArt: true,
    colors: { background: "#0b0f17", foreground: "#e3e8f0", accent: "#f2a65a" },
  },
  {
    id: "ember",
    name: "Ember",
    base: "dark",
    hasArt: true,
    colors: { background: "#140c09", foreground: "#f6e8de", accent: "#ff8a3d" },
  },
];
