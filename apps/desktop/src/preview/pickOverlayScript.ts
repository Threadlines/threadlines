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
    ".note{position:fixed;display:flex;flex-direction:column;gap:4px;" +
    "padding:8px;border-radius:6px;background:#16181c;pointer-events:auto;" +
    "border:1px solid rgba(255,255,255,0.14);box-shadow:0 4px 16px rgba(0,0,0,0.45)}" +
    ".input{width:260px;padding:5px 7px;border-radius:4px;background:#0f1115;" +
    "border:1px solid #4c8dff;color:#e8e6e1;outline:none;" +
    "font:400 12px/1.4 ui-sans-serif,system-ui,sans-serif}" +
    ".input::placeholder{color:rgba(232,230,225,0.4)}" +
    ".hint{color:rgba(232,230,225,0.45);" +
    "font:400 10px/1.3 ui-sans-serif,system-ui,sans-serif}" +
    ".tweaks{display:flex;align-items:center;gap:10px}" +
    ".tweak{display:flex;align-items:center;gap:4px;color:rgba(232,230,225,0.6);" +
    "font:400 10px/1.3 ui-sans-serif,system-ui,sans-serif}" +
    ".size{width:44px;padding:2px 4px;border-radius:3px;background:#0f1115;" +
    "border:1px solid rgba(255,255,255,0.16);color:#e8e6e1;outline:none;" +
    "font:400 11px ui-monospace,SFMono-Regular,Menlo,monospace}" +
    ".unit{color:rgba(232,230,225,0.4)}" +
    ".colour{width:22px;height:18px;padding:0;border:1px solid rgba(255,255,255,0.16);" +
    "border-radius:3px;background:none;cursor:pointer}" +
    ".reset{margin-left:auto;padding:2px 6px;border-radius:3px;cursor:pointer;" +
    "background:none;border:1px solid rgba(255,255,255,0.16);color:rgba(232,230,225,0.7);" +
    "font:400 10px ui-sans-serif,system-ui,sans-serif}" +
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

  // Where the note input sits once an element is chosen. Until then the
  // overlay only tracks the pointer.
  let chosen = null;

  const showNoteInput = (point) => {
    const field = document.createElement("div");
    field.className = "note";
    field.innerHTML =
      "<input class='input' type='text' placeholder='What about this element?' />" +
      "<div class='tweaks'>" +
      "<label class='tweak'>size<input class='size' type='number' min='1' max='200' step='1' /><span class='unit'>px</span></label>" +
      "<label class='tweak'>colour<input class='colour' type='color' /></label>" +
      "<button type='button' class='reset' hidden>reset</button>" +
      "</div>" +
      "<span class='hint'>Enter to attach · Esc to cancel</span>";
    root.appendChild(field);
    const input = field.querySelector(".input");

    // Style tweaks are applied to the element as you make them, so the note can
    // say "like this" instead of describing a value in words. They are recorded
    // as before-and-after and sent as a proposal: the page is a scratch pad, and
    // nothing here changes the source until the agent does it.
    const sizeInput = field.querySelector(".size");
    const colourInput = field.querySelector(".colour");
    const resetButton = field.querySelector(".reset");
    const computed = getComputedStyle(chosen);
    const originals = {
      "font-size": computed.fontSize,
      color: computed.color,
    };
    // The colour input only speaks hex, and computed colour is rgb().
    // Deliberately regex-free. This script lives in a template literal, where a
    // backslash escape collapses to the bare letter before the page ever sees
    // it -- which turned a digit class into a literal, left the pattern with an
    // unbalanced group, and took the whole overlay down with a syntax error.
    const toHex = (value) => {
      const open = value.indexOf("(");
      const close = value.indexOf(")");
      if (open < 0 || close < 0) return "#000000";
      const parts = value.slice(open + 1, close).split(",");
      if (parts.length < 3) return "#000000";
      return (
        "#" +
        parts
          .slice(0, 3)
          .map((part) => {
            const channel = Math.max(0, Math.min(255, Math.round(Number(part.trim()) || 0)));
            return channel.toString(16).padStart(2, "0");
          })
          .join("")
      );
    };
    sizeInput.value = String(Math.round(parseFloat(originals["font-size"])) || 16);
    colourInput.value = toHex(originals.color);

    const tweaks = new Map();
    const recordTweak = (property, from, to) => {
      if (from === to) {
        tweaks.delete(property);
      } else {
        tweaks.set(property, { property, from, to });
      }
      resetButton.hidden = tweaks.size === 0;
    };
    sizeInput.addEventListener("input", () => {
      const next = sizeInput.value + "px";
      chosen.style.fontSize = next;
      recordTweak("font-size", originals["font-size"], next);
    });
    colourInput.addEventListener("input", () => {
      chosen.style.color = colourInput.value;
      recordTweak("color", toHex(originals.color), colourInput.value);
    });
    resetButton.addEventListener("click", () => {
      chosen.style.fontSize = "";
      chosen.style.color = "";
      sizeInput.value = String(Math.round(parseFloat(originals["font-size"])) || 16);
      colourInput.value = toHex(originals.color);
      tweaks.clear();
      resetButton.hidden = true;
      input.focus();
    });
    // Typing in a number field must not submit the annotation.
    for (const control of [sizeInput, colourInput]) {
      control.addEventListener("keydown", (event) => event.stopPropagation());
    }

    const rect = chosen.getBoundingClientRect();
    // Below the element, or above it when there is no room underneath.
    const below = rect.bottom + 8;
    field.style.left =
      Math.max(8, Math.min(rect.left, innerWidth - field.offsetWidth - 8)) + "px";
    field.style.top =
      (below + field.offsetHeight > innerHeight ? Math.max(8, rect.top - field.offsetHeight - 8) : below) +
      "px";

    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        const note = input.value.trim();
        const styleChanges = [...tweaks.values()];
        dispose();
        window[BINDING](
          JSON.stringify({
            x: point.x,
            y: point.y,
            note: note === "" ? null : note,
            styleChanges,
          }),
        );
      } else if (event.key === "Escape") {
        event.preventDefault();
        dispose();
        window[BINDING](JSON.stringify({ cancelled: true }));
      }
    });
    // The page may hold focus aggressively; take it on the next frame.
    requestAnimationFrame(() => input.focus());
  };

  const onClick = (event) => {
    // Capture phase and fully swallowed: picking a "Delete" button must not
    // also press it.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (chosen !== null) {
      return;
    }
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element || element === host) {
      return;
    }
    chosen = element;
    paint(element);
    // Stop following the pointer: the highlight now belongs to the choice.
    document.removeEventListener("mousemove", onMove, true);
    showNoteInput({ x: event.clientX, y: event.clientY });
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
