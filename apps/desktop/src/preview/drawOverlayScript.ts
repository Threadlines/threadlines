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

const DRAW_OVERLAY_ID = "__threadlines-draw-overlay";
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
