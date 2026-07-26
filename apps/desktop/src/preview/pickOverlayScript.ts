/**
 * The highlight drawn while picking an element.
 *
 * DevTools' own highlight cannot be styled: with its info card on it is a large
 * white panel listing the class chain, and with it off there is no label at all
 * -- and its outline is painted per CSS box region, so an element with no
 * border gets no outline, which is most of them. This draws the highlight in
 * the page instead: one rounded box and a short label.
 *
 * Injected with Runtime.evaluate rather than a preload. That reaches the page's
 * main world directly, so the guest keeps its preload stripped and its context
 * isolation on, which the session isolation elsewhere depends on.
 *
 * Everything lives in a shadow root so the page's own CSS cannot reach it, and
 * the overlay never takes pointer events -- the element under the cursor has to
 * stay hit-testable for this to work at all.
 */

/**
 * The pointer used while picking.
 *
 * The page's own cursors leak through otherwise -- an I-beam over text, a hand
 * over links -- which says "interact with this" at the moment interaction is
 * disabled. One cursor over everything fixes that.
 *
 * The shape is the arrow from the toolbar's pick icon, so the mode looks like
 * the button that started it, and it is drawn small: a cursor is furniture, not
 * a graphic. The fill follows the app's theme and the outline is the highlight
 * blue, which is what keeps it legible either way.
 */
const ARROW_CURSOR_FILL = { dark: "#16181c", light: "#ffffff" } as const;

function arrowCursorCss(colorScheme: "light" | "dark"): string {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">',
    // lucide's mouse-pointer, body only -- its tail would read as clutter at
    // cursor size.
    '<path d="M3.688 3.037a.497.497 0 0 0-.651.651l6.5 15.999a.501.501 0 0 0 .947-.062l1.569-6.083',
    'a2 2 0 0 1 1.448-1.479l6.124-1.579a.5.5 0 0 0 .063-.947z"',
    ` fill="${ARROW_CURSOR_FILL[colorScheme]}" stroke="#4c8dff" stroke-width="1.6"`,
    ' stroke-linejoin="round"/>',
    "</svg>",
  ].join("");
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  // Hotspot on the tip, so what you point at is what gets picked, and `default`
  // stays as a fallback in case the image is ever refused.
  return `url("${dataUrl}") 2 2, default`;
}

export const PICK_OVERLAY_BINDING = "__threadlinesPickElement";
const OVERLAY_ID = "__threadlines-pick-overlay";

/** Removes any previous overlay, so re-arming never stacks two of them. */
export const PICK_OVERLAY_TEARDOWN_SCRIPT = `
(() => {
  const existing = document.getElementById(${JSON.stringify(OVERLAY_ID)});
  if (existing) {
    existing.__threadlinesDispose?.();
    existing.remove();
  }
  document.getElementById(${JSON.stringify(OVERLAY_ID)} + "-cursor")?.remove();
})();
`;

export function buildPickOverlayScript(colorScheme: "light" | "dark"): string {
  return `
(() => {
  const OVERLAY_ID = ${JSON.stringify(OVERLAY_ID)};
  const BINDING = ${JSON.stringify(PICK_OVERLAY_BINDING)};

  const previous = document.getElementById(OVERLAY_ID);
  if (previous) {
    previous.__threadlinesDispose?.();
    previous.remove();
  }

  // The page's own cursors leak through while picking -- an I-beam over text,
  // a hand over links -- which reads as "interact with this" at exactly the
  // moment interaction is disabled. One cursor over everything fixes that. It
  // has to live in the page's own stylesheet: the overlay is in a shadow root
  // and its styles cannot reach out.
  const cursorStyle = document.createElement("style");
  cursorStyle.id = OVERLAY_ID + "-cursor";
  cursorStyle.textContent =
    "*,*::before,*::after{cursor:" + ${JSON.stringify(arrowCursorCss(colorScheme))} + " !important}";
  document.documentElement.appendChild(cursorStyle);

  const host = document.createElement("div");
  host.id = OVERLAY_ID;
  // Fixed and inert: the overlay must never intercept the pointer, or
  // elementFromPoint would only ever return the overlay itself.
  host.style.cssText =
    "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML =
    "<style>" +
    ":host{all:initial}" +
    ".box{position:fixed;border:2px solid #4c8dff;border-radius:3px;" +
    "background:rgba(76,141,255,0.14);pointer-events:none;" +
    "transition:all 60ms ease-out}" +
    ".tag{position:fixed;display:flex;gap:8px;align-items:baseline;" +
    "padding:3px 7px;border-radius:4px;background:#16181c;color:#e8e6e1;" +
    "border:1px solid rgba(255,255,255,0.14);pointer-events:none;" +
    "font:500 11px/1.3 ui-sans-serif,system-ui,sans-serif;white-space:nowrap;" +
    "box-shadow:0 2px 8px rgba(0,0,0,0.35)}" +
    ".name{color:#4c8dff;font-weight:600}" +
    ".dim{color:rgba(232,230,225,0.55);" +
    "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px}" +
    "</style>" +
    "<div class='box' hidden></div><div class='tag' hidden></div>";
  const box = root.querySelector(".box");
  const tag = root.querySelector(".tag");
  document.documentElement.appendChild(host);

  let current = null;

  const describe = (element) => {
    const parts = [element.tagName.toLowerCase()];
    if (element.id) parts.push("#" + element.id);
    return parts.join("");
  };

  const paint = (element) => {
    const rect = element.getBoundingClientRect();
    box.hidden = false;
    box.style.left = rect.left + "px";
    box.style.top = rect.top + "px";
    box.style.width = rect.width + "px";
    box.style.height = rect.height + "px";

    tag.hidden = false;
    tag.innerHTML =
      "<span class='name'></span><span class='dim'></span>";
    tag.querySelector(".name").textContent = describe(element);
    tag.querySelector(".dim").textContent =
      Math.round(rect.width) + "×" + Math.round(rect.height);

    // Above the element by default, tucked below when it would sit off-screen.
    const tagRect = tag.getBoundingClientRect();
    const above = rect.top - tagRect.height - 6;
    tag.style.top = (above < 4 ? Math.min(rect.bottom + 6, innerHeight - tagRect.height - 4) : above) + "px";
    tag.style.left = Math.max(4, Math.min(rect.left, innerWidth - tagRect.width - 4)) + "px";
  };

  const hide = () => {
    box.hidden = true;
    tag.hidden = true;
    current = null;
  };

  const onMove = (event) => {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element || element === host) {
      hide();
      return;
    }
    current = element;
    paint(element);
  };

  const onClick = (event) => {
    // Capture phase and fully swallowed: picking a "Delete" button must not
    // also press it.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    dispose();
    window[BINDING](JSON.stringify({ x: event.clientX, y: event.clientY }));
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      dispose();
      window[BINDING](JSON.stringify({ cancelled: true }));
    }
  };

  const onScroll = () => {
    if (current) paint(current);
  };

  function dispose() {
    cursorStyle.remove();
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onScroll, true);
    host.remove();
  }
  host.__threadlinesDispose = dispose;

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScroll, true);
})();
`;
}
