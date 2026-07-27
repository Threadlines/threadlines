/**
 * Ink drawn over the page, and the eraser that takes it back off.
 *
 * Unlike picking, this is not a question with an answer -- nothing is reported
 * back and nothing is attached. The marks are for the screenshot: they are real
 * nodes in the page, so Page.captureScreenshot renders them, and circling the
 * broken thing and capturing it is the whole point. Turning the mode off clears
 * them, which is also how you start over.
 *
 * SVG rather than a canvas so each stroke stays a node the eraser can hit-test.
 * On a canvas, erasing one line means remembering every stroke and repainting
 * the rest, which is a worse version of what the DOM already does.
 *
 * Positioned in document coordinates rather than the viewport, so a mark stays
 * on the thing it was drawn on when the page scrolls.
 */

import { coveredBoxIndicesSource } from "./regionSelection.ts";

const DRAW_OVERLAY_ID = "__threadlines-draw-overlay";
/** Reported when the user attaches a drawing, mirroring the picker's binding. */
export const DRAW_OVERLAY_BINDING = "__threadlinesAttachDrawing";
/** Where the elements the strokes enclose are left, for the caller to describe. */
export const DRAW_OVERLAY_STASH = "__threadlinesDrawnElements";
/** How much of an element a stroke has to enclose to count as circled. */
const DRAW_COVERAGE = 0.7;
/** A scribble across a page should not attach forty chips. */
const DRAW_MAX_ELEMENTS = 8;
/** The highlight blue the picker uses, so the whole feature reads as one thing. */
const INK = "#4c8dff";
const INK_WIDTH = 3;
/** The invisible twin that catches the click: three pixels of line is not a target. */
const ERASE_HIT_WIDTH = 18;

export const DRAW_OVERLAY_TEARDOWN_SCRIPT = `
document.getElementById(${JSON.stringify(DRAW_OVERLAY_ID)})?.__threadlinesDispose?.();
document.getElementById(${JSON.stringify(DRAW_OVERLAY_ID)})?.remove();
`;

/**
 * Arms the overlay, or switches the mode of one already on the page.
 *
 * Switching keeps the ink: the point of the eraser is to fix a stroke you just
 * drew, and clearing on the way there would leave nothing to fix.
 */
export function buildDrawOverlayScript(mode: "draw" | "erase"): string {
  return `
(() => {
  const OVERLAY_ID = ${JSON.stringify(DRAW_OVERLAY_ID)};
  const MODE = ${JSON.stringify(mode)};
  const INK = ${JSON.stringify(INK)};
  const INK_WIDTH = ${INK_WIDTH};
  const HIT_WIDTH = ${ERASE_HIT_WIDTH};
  const SVG_NS = "http://www.w3.org/2000/svg";
  const BINDING = ${JSON.stringify("__threadlinesAttachDrawing")};
  const STASH = ${JSON.stringify("__threadlinesDrawnElements")};
  const COVERAGE = ${DRAW_COVERAGE};
  const MAX_ELEMENTS = ${DRAW_MAX_ELEMENTS};

  // The same rule the region tool uses, inlined so the page runs exactly what
  // the tests cover.
  ${coveredBoxIndicesSource()}

  const existing = document.getElementById(OVERLAY_ID);
  if (existing) {
    existing.__threadlinesSetMode(MODE);
    return true;
  }

  const host = document.createElement("div");
  host.id = OVERLAY_ID;
  // Below the pick overlay, above everything the page has: marks belong on top
  // of the content they are about.
  host.style.cssText =
    "position:absolute;left:0;top:0;z-index:2147483646;pointer-events:auto;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML =
    "<style>" +
    ":host{all:initial}" +
    "svg{display:block;overflow:visible}" +
    ".ink{fill:none;stroke:" + INK + ";stroke-width:" + INK_WIDTH + ";" +
    "stroke-linecap:round;stroke-linejoin:round;pointer-events:none}" +
    // The stroke the eraser actually hits, invisible and much wider. Only it
    // takes pointer events, and only in erase mode.
    ".hit{fill:none;stroke:transparent;stroke-width:" + HIT_WIDTH + ";" +
    "stroke-linecap:round;stroke-linejoin:round;pointer-events:none}" +
    ":host([data-mode='erase']) .hit{pointer-events:stroke;cursor:pointer}" +
    // The same card the picker uses, so attaching a drawing and attaching an
    // element look like the same act.
    // One row: a field and the two things you can do with it. The keys still
    // work and the hint still says so, but quietly -- a line of instructions is
    // not what you want to read every time you draw a circle.
    ".note{position:fixed;display:flex;align-items:center;gap:6px;" +
    "padding:6px;border-radius:8px;background:#16181c;pointer-events:auto;" +
    "border:1px solid rgba(255,255,255,0.14);box-shadow:0 4px 16px rgba(0,0,0,0.45)}" +
    ".input{width:220px;padding:5px 8px;border-radius:5px;background:#0f1115;" +
    "border:1px solid rgba(255,255,255,0.16);color:#e8e6e1;outline:none;" +
    "font:400 12px/1.4 ui-sans-serif,system-ui,sans-serif}" +
    ".input:focus{border-color:" + INK + "}" +
    ".input::placeholder{color:rgba(232,230,225,0.4)}" +
    ".act{padding:5px 10px;border-radius:5px;cursor:pointer;border:1px solid transparent;" +
    "font:500 12px/1.2 ui-sans-serif,system-ui,sans-serif}" +
    ".attach{background:" + INK + ";color:#0b1220}" +
    ".attach:hover{filter:brightness(1.08)}" +
    ".cancel{background:none;color:rgba(232,230,225,0.7);" +
    "border-color:rgba(255,255,255,0.16)}" +
    ".cancel:hover{color:#e8e6e1;background:rgba(255,255,255,0.06)}" +
    ".hint{margin-left:2px;white-space:nowrap;color:rgba(232,230,225,0.3);" +
    "font:400 10px/1.2 ui-sans-serif,system-ui,sans-serif}" +
    "[hidden]{display:none !important}" +
    "</style>" +
    "<svg xmlns='" + SVG_NS + "'></svg>";
  const svg = root.querySelector("svg");

  // The overlay has to cover the scrollable page, not just what is on screen,
  // or a mark made at the top would be gone by the time you scrolled down.
  const resize = () => {
    const width = Math.max(
      document.documentElement.scrollWidth,
      document.body ? document.body.scrollWidth : 0,
    );
    const height = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
    );
    host.style.width = width + "px";
    host.style.height = height + "px";
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
  };
  resize();
  document.documentElement.appendChild(host);

  let mode = MODE;
  const setMode = (next) => {
    mode = next;
    host.setAttribute("data-mode", next);
    // Drawing wants the whole surface; erasing wants only the strokes, so the
    // page underneath stays scrollable and clickable between them.
    host.style.pointerEvents = next === "draw" ? "auto" : "none";
    host.style.cursor = next === "draw" ? "crosshair" : "default";
  };
  host.__threadlinesSetMode = setMode;
  setMode(MODE);

  let stroke = null;
  let points = [];

  const pathData = () => {
    let data = "";
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      data += (index === 0 ? "M" : "L") + point.x + " " + point.y;
    }
    // A single tap is a dot, which needs a second point to render at all.
    if (points.length === 1) {
      data += "L" + (points[0].x + 0.01) + " " + points[0].y;
    }
    return data;
  };

  const onDown = (event) => {
    if (mode !== "draw" || event.button !== 0) return;
    event.preventDefault();
    points = [{ x: Math.round(event.pageX), y: Math.round(event.pageY) }];
    stroke = document.createElementNS(SVG_NS, "g");
    const hit = document.createElementNS(SVG_NS, "path");
    hit.setAttribute("class", "hit");
    const ink = document.createElementNS(SVG_NS, "path");
    ink.setAttribute("class", "ink");
    stroke.appendChild(hit);
    stroke.appendChild(ink);
    svg.appendChild(stroke);
    const data = pathData();
    hit.setAttribute("d", data);
    ink.setAttribute("d", data);
    host.setPointerCapture?.(event.pointerId);
  };

  const onMove = (event) => {
    if (stroke === null) return;
    event.preventDefault();
    const point = { x: Math.round(event.pageX), y: Math.round(event.pageY) };
    const last = points[points.length - 1];
    // Skip points the line would not bend at: fewer nodes, same shape.
    if (Math.abs(point.x - last.x) < 2 && Math.abs(point.y - last.y) < 2) return;
    points.push(point);
    const data = pathData();
    for (const path of stroke.children) {
      path.setAttribute("d", data);
    }
  };

  const onUp = () => {
    stroke = null;
    points = [];
    showNote();
  };

  // Erasing is a click on a stroke, which only reaches us because the hit twin
  // is the one element taking pointer events in this mode.
  const onErase = (event) => {
    if (mode !== "erase") return;
    const target = event.target;
    if (target && target.parentNode && target.parentNode !== svg.parentNode) {
      event.preventDefault();
      event.stopPropagation();
      target.parentNode.remove();
    }
  };

  /**
   * What the strokes are drawn around.
   *
   * Per stroke rather than over all of them together: circling two things in
   * different corners means those two things, and a box around the pair would
   * sweep up everything between them.
   */
  const enclosedElements = () => {
    const strokes = [...svg.children].map((group) => {
      const box = group.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    });
    if (strokes.length === 0) {
      return [];
    }
    const candidates = [];
    for (const element of document.body.querySelectorAll("*")) {
      if (host.contains(element) || element === host) continue;
      const tagName = element.tagName;
      if (tagName === "SCRIPT" || tagName === "STYLE" || tagName === "BR") continue;
      const rect = element.getBoundingClientRect();
      if (rect.width * rect.height < 64) continue;
      if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) {
        continue;
      }
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") {
        continue;
      }
      candidates.push({ element, rect });
    }
    const found = [];
    for (const strokeBox of strokes) {
      const boxes = candidates.map((candidate) => candidate.rect);
      for (const index of coveredBoxIndices(boxes, strokeBox, COVERAGE)) {
        const element = candidates[index].element;
        if (!found.includes(element)) {
          found.push(element);
        }
      }
    }
    // Outermost only, for the same reason the region tool does it: a circle
    // around a card means the card, not the card and its children.
    return found
      .filter((element) => !found.some((other) => other !== element && other.contains(element)))
      .slice(0, MAX_ELEMENTS);
  };

  let noteField = null;

  /**
   * Appears once there is something to attach.
   *
   * Every other tool here ends with the same question, so this one does too --
   * the drawing says which thing, and the note says what about it.
   */
  const showNote = () => {
    if (noteField !== null || svg.children.length === 0) {
      return;
    }
    noteField = document.createElement("div");
    noteField.className = "note";
    noteField.innerHTML =
      "<input class='input' type='text' placeholder='Describe the change…' />" +
      "<button type='button' class='act attach'>Attach</button>" +
      "<button type='button' class='act cancel'>Cancel</button>" +
      "<span class='hint'>⏎ · esc</span>";
    root.appendChild(noteField);
    const input = noteField.querySelector(".input");

    // Parked in a corner rather than hung off the strokes: the drawing grows
    // while you make it, and a bar that chased it would move under the cursor
    // exactly when you were reaching for it.
    noteField.style.right = "16px";
    noteField.style.bottom = "16px";

    const attach = () => {
      const note = input.value.trim();
      // The elements are read and the bar removed before the caller hears
      // anything, because the next thing it does is photograph the page and the
      // bar must not be in the picture.
      window[STASH] = enclosedElements();
      noteField.remove();
      noteField = null;
      window[BINDING](
        JSON.stringify({ note: note === "" ? null : note, count: window[STASH].length }),
      );
    };
    const cancel = () => {
      window[BINDING](JSON.stringify({ cancelled: true }));
    };

    noteField.querySelector(".attach").addEventListener("click", attach);
    noteField.querySelector(".cancel").addEventListener("click", cancel);
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        attach();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    });
    requestAnimationFrame(() => input.focus());
  };

  host.addEventListener("pointerdown", onDown);
  host.addEventListener("pointermove", onMove);
  host.addEventListener("pointerup", onUp);
  host.addEventListener("pointercancel", onUp);
  root.addEventListener("pointerdown", onErase, true);
  window.addEventListener("resize", resize);

  host.__threadlinesDispose = () => {
    window.removeEventListener("resize", resize);
  };

  return true;
})();
`;
}
