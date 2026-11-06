/**
 * The calm zones the backdrop frame frosts and tints (docs/design/custom-themes.md,
 * "Where the art shows" and "Frosting and tint happen in the frame"),
 * measured from the live layout in window CSS px.
 *
 * - Hard rectangles: the title row, the rail, the thread list, the composer,
 *   and any opaque panel beside the chat (right panel, browser, terminal).
 * - The reading column: the composer's width plus a margin, the full height
 *   of the chat column, feathered outside a core that covers the messages.
 * - The new-thread screen: a soft patch around the heading, the composer
 *   and the line under it, and one around each line of text under them.
 * - The home screen with no thread open: a soft patch around each block of
 *   its text (the heading, line and buttons; the links under them).
 *
 * Every zone's core holds all the text the app can draw there, so the
 * feather never thins the tint under text.
 */
import { BACKDROP_MAX_ZONES, type BackdropRect, type BackdropZone } from "@threadlines/contracts";
import { composite, formatHex, parseColor } from "@threadlines/shared/themeColor";
import type { ThemeTokens } from "@threadlines/shared/themeTokens";

import type { GlassFloors } from "./glass";

/** How far the reading column's frost reaches past the composer on each side. */
export const COLUMN_MARGIN_PX = 48;

/** How far the home screen's text rises as it fades in (index.css `no-thread-rise`), plus a px. */
const HOME_RISE_PX = 8;

export interface MeasuredBackdropLayout {
  readonly zones: ReadonlyArray<BackdropZone>;
  /** A screen the art shows behind (a thread, a new thread, home); any other page covers it. */
  readonly chatShown: boolean;
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

const toBox = (rect: DOMRectReadOnly): Box => ({
  left: rect.left,
  top: rect.top,
  right: rect.right,
  bottom: rect.bottom,
});

function clip(box: Box, bounds: Box): Box | null {
  const left = Math.max(box.left, bounds.left);
  const top = Math.max(box.top, bounds.top);
  const right = Math.min(box.right, bounds.right);
  const bottom = Math.min(box.bottom, bounds.bottom);
  return right - left >= 1 && bottom - top >= 1 ? { left, top, right, bottom } : null;
}

function union(boxes: ReadonlyArray<Box>): Box | null {
  if (boxes.length === 0) return null;
  return {
    left: Math.min(...boxes.map((box) => box.left)),
    top: Math.min(...boxes.map((box) => box.top)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  };
}

function grow(box: Box, x: number, y: number): Box {
  return { left: box.left - x, top: box.top - y, right: box.right + x, bottom: box.bottom + y };
}

const toRect = (box: Box): BackdropRect => ({
  x: Math.round(box.left),
  y: Math.round(box.top),
  w: Math.max(0, Math.round(box.right - box.left)),
  h: Math.max(0, Math.round(box.bottom - box.top)),
});

/** The element's box on screen, or null when it isn't laid out or has no size. */
function visibleBox(element: Element | null, bounds: Box): Box | null {
  if (!(element instanceof HTMLElement)) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  return clip(toBox(rect), bounds);
}

/**
 * The tight box around the text an element shows: every visible text node's
 * own box, so a wide wrapper with a short line in it frosts only the line.
 * Leaves out text inside `skip`. Null when it shows no text.
 */
function textBox(element: Element | null, bounds: Box, skip?: Element | null): Box | null {
  return union(textBoxes(element, bounds, skip));
}

/**
 * The boxes of the text an element shows, one per line of text. With
 * `fading`, text at zero opacity counts too: text that fades in is there a
 * moment later.
 */
function textBoxes(
  element: Element | null,
  bounds: Box,
  skip?: Element | null,
  fading = false,
): Box[] {
  if (!element) return [];
  const doc = element.ownerDocument;
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  const boxes: Box[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    const parent = node.parentElement;
    if (!parent || (skip && skip.contains(parent))) continue;
    const style = doc.defaultView?.getComputedStyle(parent);
    if (style && (style.visibility === "hidden" || (!fading && Number(style.opacity) === 0))) {
      continue;
    }
    // Text inside a folded list is laid out but clipped away: only what an
    // ancestor's overflow leaves on screen counts.
    let shown: Box | null = bounds;
    for (
      let at: Element | null = parent;
      at && shown && at !== element.parentElement;
      at = at.parentElement
    ) {
      const overflow = doc.defaultView?.getComputedStyle(at);
      if (overflow && (overflow.overflowX !== "visible" || overflow.overflowY !== "visible")) {
        shown = clip(toBox(at.getBoundingClientRect()), shown);
      }
    }
    if (!shown) continue;
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.width < 1 || rect.height < 1) continue;
      const clipped = clip(toBox(rect), shown);
      if (clipped) boxes.push(clipped);
    }
  }
  return boxes;
}

/**
 * Text boxes grouped into blocks: a gap taller than `gap` px starts a new
 * block, so two lines far apart (the recent threads and the footer links)
 * each get a patch instead of one spanning the art between them.
 */
function textBlocks(boxes: ReadonlyArray<Box>, gap: number): Box[] {
  const blocks: Box[] = [];
  for (const box of boxes.toSorted((first, second) => first.top - second.top)) {
    const last = blocks.at(-1);
    if (last && box.top - last.bottom <= gap) blocks[blocks.length - 1] = union([last, box])!;
    else blocks.push(box);
  }
  return blocks;
}

/**
 * Reads the zones from the document. `tokens` gives each zone the color of
 * the surface it stands for; `floors` its tint floor.
 */
export function measureBackdropZones(
  root: ParentNode,
  viewport: { readonly width: number; readonly height: number },
  tokens: ThemeTokens,
  floors: GlassFloors,
): MeasuredBackdropLayout {
  const screen: Box = { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
  const zones: BackdropZone[] = [];
  // A surface color as it shows: laid over the solid base, never its alpha dropped.
  const base = { ...(parseColor(tokens["surface-solid"]) ?? { r: 0, g: 0, b: 0 }), a: 1 };
  const color = (token: keyof ThemeTokens) => {
    const value = parseColor(tokens[token]);
    return value ? formatHex({ ...composite(value, base), a: 1 }) : formatHex(base);
  };
  // A hard zone reaches one px past its box: the 1px borders between
  // neighbors (the panel's edge beside the rail) frost with them instead of
  // letting a line of crisp art through.
  const hard = (id: string, box: Box | null, tint: number, tintColor: string) => {
    if (!box) return;
    const inner = toRect(box);
    if (inner.w < 1 || inner.h < 1) return;
    const rect = { x: inner.x - 1, y: inner.y - 1, w: inner.w + 2, h: inner.h + 2 };
    zones.push({ id, edge: "hard", shape: "rect", rect, core: rect, tint, tintColor });
  };

  hard(
    "title",
    visibleBox(root.querySelector('[data-slot="app-titlebar"]'), screen),
    floors.frame,
    color("frame"),
  );
  const rails = [...root.querySelectorAll('[data-slot="navigation-rail"]')];
  rails.forEach((rail, index) =>
    hard(`rail-${index}`, visibleBox(rail, screen), floors.frame, color("frame")),
  );

  // The thread list slides out inside the work panel, which clips it.
  const panel = visibleBox(root.querySelector('[data-slot="app-panel"]'), screen) ?? screen;
  hard(
    "list",
    visibleBox(
      root.querySelector(
        '[data-slot="app-panel"] > [data-slot="sidebar"] [data-slot="sidebar-inner"]',
      ),
      panel,
    ),
    floors.list,
    color("sidebar"),
  );

  const chatView = root.querySelector("[data-chat-view]");
  const column = chatView?.querySelector("[data-chat-column]") ?? null;
  const columnBox = visibleBox(column, panel);
  const composerForm = column?.querySelector("[data-chat-composer-form]") ?? null;
  const composerBox = visibleBox(composerForm, panel);
  const hero = column?.querySelector("[data-draft-hero]") ?? null;

  if (column && columnBox && hero) {
    // The new-thread screen: a frosted patch behind the heading, the
    // composer and the line under it (the input bar holds both); the art
    // shows at full strength around it.
    // Text boxes, not the wrappers: the input bar spans the whole column, and
    // frosting all of it would hide the art the new-thread screen is for.
    const heading = textBox(hero, columnBox);
    let inputBar: Element | null = composerForm;
    while (inputBar && inputBar.parentElement !== column) inputBar = inputBar.parentElement;
    const underComposer = textBox(inputBar, columnBox, composerForm);
    const core = union(
      [heading, composerBox, underComposer].filter((box): box is Box => box !== null),
    );
    if (core) {
      // A soft rectangle: it fades evenly from the text's edge outward. An
      // ellipse snug enough to leave the art room would cut the core's corners.
      const rect = clip(grow(core, 96, 64), columnBox);
      if (rect) {
        zones.push({
          id: "hero",
          edge: "soft",
          shape: "rect",
          rect: toRect(rect),
          core: toRect(core),
          tint: floors.column,
          tintColor: color("background"),
        });
      }
    }
    // Under it: the recent threads and the footer links, each frosted around
    // its own text only.
    const below = inputBar?.nextElementSibling ?? null;
    textBlocks(textBoxes(below, columnBox), 48).forEach((words, index) => {
      const rect = clip(grow(words, 36, 18), columnBox);
      if (rect) {
        zones.push({
          id: `hero-below-${index}`,
          edge: "soft",
          shape: "rect",
          rect: toRect(rect),
          core: toRect(words),
          tint: floors.column,
          tintColor: color("background"),
        });
      }
    });
  } else if (column && columnBox) {
    // In a thread: the reading column, as wide as the composer plus a margin,
    // its core covering the messages and the composer alike.
    const messages = visibleBox(column.querySelector("[data-timeline-root]"), columnBox);
    const textBoxes = [composerBox, messages].filter((box): box is Box => box !== null);
    const left =
      textBoxes.length > 0 ? Math.min(...textBoxes.map((box) => box.left)) : columnBox.left;
    const right =
      textBoxes.length > 0 ? Math.max(...textBoxes.map((box) => box.right)) : columnBox.right;
    const core = clip({ left, top: columnBox.top, right, bottom: columnBox.bottom }, columnBox);
    const rect = clip(
      grow({ left, top: columnBox.top, right, bottom: columnBox.bottom }, COLUMN_MARGIN_PX, 0),
      columnBox,
    );
    if (core && rect) {
      zones.push({
        id: "column",
        edge: "soft",
        shape: "rect",
        rect: toRect(rect),
        core: toRect(core),
        tint: floors.column,
        tintColor: color("background"),
      });
    }
  }
  if (composerBox) hard("composer", composerBox, floors.composer, color("card"));
  // The chat's own header, where there is no title row to hold it (phones).
  hard(
    "header",
    visibleBox(chatView?.querySelector(":scope > header") ?? null, panel),
    floors.column,
    color("background"),
  );

  // Home with no thread open: the first screen a new user sees. Each block of
  // its text gets a patch, the heading's block a wider one, like the
  // new-thread screen's. Its text fades in rising HOME_RISE_PX, so the
  // patches count it from the start and cover the whole rise.
  const emptyHome = chatView ? null : root.querySelector("[data-empty-home]");
  const homeBox = visibleBox(emptyHome, panel);
  if (emptyHome && homeBox) {
    textBlocks(textBoxes(emptyHome, homeBox, null, true), 48).forEach((words, index) => {
      const core = clip(grow(words, 0, HOME_RISE_PX), homeBox);
      const rect = clip(index === 0 ? grow(words, 96, 64) : grow(words, 36, 18), homeBox);
      if (core && rect) {
        zones.push({
          id: `home-${index}`,
          edge: "soft",
          shape: "rect",
          rect: toRect(rect),
          core: toRect(core),
          tint: floors.column,
          tintColor: color("background"),
        });
      }
    });
  }

  // Opaque panels beside or under the chat: the art behind them never shows.
  if (chatView) {
    const panels = [
      ...root.querySelectorAll(
        '[data-chat-right-panel], [data-testid="browser-panel"], .thread-terminal-drawer',
      ),
    ];
    panels.forEach((element, index) =>
      hard(`panel-${index}`, visibleBox(element, panel), 1, color("rail")),
    );
  }

  return {
    zones: zones.slice(0, BACKDROP_MAX_ZONES),
    chatShown: chatView !== null || homeBox !== null,
  };
}

/** Whether two zone lists would draw the same. */
export function sameBackdropZones(
  first: ReadonlyArray<BackdropZone>,
  second: ReadonlyArray<BackdropZone>,
): boolean {
  if (first.length !== second.length) return false;
  return first.every((zone, index) => JSON.stringify(zone) === JSON.stringify(second[index]));
}
