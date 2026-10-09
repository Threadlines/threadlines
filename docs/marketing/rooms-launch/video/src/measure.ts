import { useSyncExternalStore } from "react";
import { continueRender, delayRender } from "remotion";
import { fontsReady } from "./theme";

// Layout that depends on text width (the wordmark growing out of the glyph,
// caption line breaks) must wait for the web fonts, or the first frame a
// render tab captures would be laid out with a fallback font. The render waits
// on this store, and components re-render once it flips.

let ready = false;
const listeners = new Set<() => void>();

if (typeof document !== "undefined") {
  const handle = delayRender("Loading fonts for text measurement");
  void fontsReady.then(() => {
    ready = true;
    for (const listener of listeners) listener();
    // Let React commit the re-render before the frame is captured.
    setTimeout(() => continueRender(handle), 0);
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** False until the fonts are loaded; measure text only when true. */
export const useFontsReady = () => useSyncExternalStore(subscribe, () => ready);

export type TextStyle = {
  family: string;
  weight: number;
  size: number;
  /** Letter spacing in em. */
  tracking: number;
};

let context: CanvasRenderingContext2D | null = null;

/** Rendered width of a single line of text, in px. */
export const textWidth = (text: string, style: TextStyle): number => {
  context ??= document.createElement("canvas").getContext("2d");
  if (!context) return 0;
  context.font = `${style.weight} ${style.size}px ${style.family}`;
  context.letterSpacing = `${style.tracking * style.size}px`;
  return context.measureText(text).width;
};

/**
 * Break text into as few lines as fit `maxWidth`, keeping the lines close
 * in length (so "Ask Sol while / Opus keeps working." rather than leaving
 * one word on its own).
 */
export const balancedLines = (text: string, maxWidth: number, style: TextStyle): string[] => {
  const words = text.split(" ");
  if (textWidth(text, style) <= maxWidth || words.length < 2) return [text];
  let best: { lines: string[]; widest: number } | null = null;
  for (let i = 1; i < words.length; i++) {
    const lines = [words.slice(0, i).join(" "), words.slice(i).join(" ")];
    const widest = Math.max(...lines.map((line) => textWidth(line, style)));
    if (!best || widest < best.widest) best = { lines, widest };
  }
  if (best && best.widest <= maxWidth) return best.lines;
  // Three or more lines: fill greedily.
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && textWidth(next, style) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  lines.push(current);
  return lines;
};
