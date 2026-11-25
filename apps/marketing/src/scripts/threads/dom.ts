/** DOM helpers for the threads drawing. */
import type { Box } from "./geometry";

const NS = "http://www.w3.org/2000/svg";

/** An SVG element with these attributes, appended to `parent`. */
export function mk<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  parent?: Element,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  parent?.append(node);
  return node;
}

const toBox = (l: number, t: number, w: number, h: number): Box => ({
  l,
  t,
  r: l + w,
  b: t + h,
  cx: l + w / 2,
  cy: t + h / 2,
  w,
  h,
});

/** A box relative to `origin`'s viewport box. */
export function boxOf(element: Element, origin: DOMRect): Box {
  const r = element.getBoundingClientRect();
  return toBox(r.left - origin.left, r.top - origin.top, r.width, r.height);
}

/**
 * A box relative to an ancestor, from layout offsets, so transforms (the
 * entrance's rise, a lifted chip) don't move it.
 */
export function offBox(element: HTMLElement, ancestor: HTMLElement): Box {
  let x = 0;
  let y = 0;
  let node: Element | null = element;
  while (node instanceof HTMLElement && node !== ancestor) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent;
  }
  if (node !== ancestor) return boxOf(element, ancestor.getBoundingClientRect());
  return toBox(x, y, element.offsetWidth, element.offsetHeight);
}

/** A thread's color, by index (the `--t0`..`--t8` tokens). */
export const threadColor = (j: number | string) => `var(--t${j})`;

let probe: HTMLElement | null = null;

/** A CSS color (light-dark and variables included) as a value the animation API takes. */
export function resolveColor(css: string): string {
  if (!probe) {
    probe = document.createElement("i");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    document.body.append(probe);
  }
  probe.style.color = css;
  return getComputedStyle(probe).color;
}

/** A one-off flash; nothing runs once it ends. */
export const flash = (element: Element | null | undefined, keyframes: Keyframe[], ms: number) =>
  element?.animate(keyframes, { duration: ms, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });

export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
export const motion = () => !reducedMotion.matches;
export const phoneQuery = matchMedia("(max-width: 640px)");
/** Two groups of logos either side of the headline. */
export const splitQuery = matchMedia("(min-width: 1060px)");
