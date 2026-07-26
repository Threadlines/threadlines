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
    ".input{width:250px;flex:1;padding:5px 7px;border-radius:4px;background:#0f1115;" +
    "border:1px solid #4c8dff;color:#e8e6e1;outline:none;" +
    "font:400 12px/1.4 ui-sans-serif,system-ui,sans-serif}" +
    ".input::placeholder{color:rgba(232,230,225,0.4)}" +
    ".hint{color:rgba(232,230,225,0.45);" +
    "font:400 10px/1.3 ui-sans-serif,system-ui,sans-serif}" +
    ".row{display:flex;align-items:center;gap:6px}" +
    ".toggle{display:flex;align-items:center;justify-content:center;width:24px;" +
    "height:24px;padding:0;border-radius:4px;cursor:pointer;background:none;" +
    "border:1px solid rgba(255,255,255,0.16);color:rgba(232,230,225,0.65)}" +
    ".toggle:hover{color:#e8e6e1;background:rgba(255,255,255,0.06)}" +
    ".toggle.on{color:#4c8dff;border-color:#4c8dff;background:rgba(76,141,255,0.12)}" +
    // display in author CSS overrides the [hidden] rule from the UA sheet, so
    // hiding has to be stated explicitly or the attribute does nothing at all.
    "[hidden]{display:none !important}" +
    ".panel{display:flex;flex-direction:column;gap:2px;max-height:190px;" +
    "overflow-y:auto;padding:6px 2px 2px;margin-top:6px;" +
    "border-top:1px solid rgba(255,255,255,0.1)}" +
    ".panel::-webkit-scrollbar{width:8px}" +
    ".panel::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.14);border-radius:4px}" +
    ".prop{display:flex;align-items:center;gap:6px;padding:2px 4px;border-radius:3px}" +
    ".prop:hover{background:rgba(255,255,255,0.04)}" +
    ".prop-name{flex:1;color:rgba(232,230,225,0.6);" +
    "font:400 10px/1.4 ui-sans-serif,system-ui,sans-serif}" +
    // The native stepper is a light-mode Aqua control and cannot be themed;
    // the field keeps its arrow-key and scroll behaviour without it.
    ".num{width:42px;padding:2px 5px;border-radius:3px;background:#0f1115;" +
    "border:1px solid rgba(255,255,255,0.16);color:#e8e6e1;outline:none;" +
    "appearance:textfield;-moz-appearance:textfield;" +
    "font:400 10px ui-monospace,SFMono-Regular,Menlo,monospace}" +
    ".num::-webkit-outer-spin-button,.num::-webkit-inner-spin-button" +
    "{-webkit-appearance:none;margin:0}" +
    ".num:focus{border-color:#4c8dff}" +
    ".num{text-align:center;border-radius:0;border-left:none;border-right:none}" +
    ".stepper{display:flex;align-items:stretch}" +
    ".step{width:18px;padding:0;cursor:pointer;background:#0f1115;" +
    "border:1px solid rgba(255,255,255,0.16);color:rgba(232,230,225,0.7);" +
    "font:400 11px/1 ui-sans-serif,system-ui,sans-serif}" +
    ".step:first-child{border-radius:3px 0 0 3px}" +
    ".step:last-child{border-radius:0 3px 3px 0}" +
    ".step:hover{color:#e8e6e1;background:rgba(255,255,255,0.08)}" +
    ".colour{width:26px;height:18px;padding:0;border:1px solid rgba(255,255,255,0.16);" +
    "border-radius:3px;background:none;cursor:pointer}" +
    ".colour::-webkit-color-swatch-wrapper{padding:2px}" +
    ".colour::-webkit-color-swatch{border:none;border-radius:2px}" +
    ".unit{width:14px;color:rgba(232,230,225,0.4);" +
    "font:400 10px ui-sans-serif,system-ui,sans-serif}" +
    ".foot{display:flex;align-items:center;gap:8px;margin-top:6px}" +
    ".reset{margin-left:auto;padding:2px 6px;border-radius:3px;cursor:pointer;" +
    "background:none;border:1px solid rgba(255,255,255,0.16);color:rgba(232,230,225,0.7);" +
    "font:400 10px ui-sans-serif,system-ui,sans-serif}" +
    ".reset:hover{color:#e8e6e1;background:rgba(255,255,255,0.06)}" +
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

  // The properties worth trying on the spot. Enough to describe a visual
  // change precisely, not so many that the panel becomes a style editor: the
  // agent makes the real change, this only says what to aim for.
  const TWEAKS = [
    { key: "font-size", label: "font size", kind: "px" },
    { key: "font-weight", label: "font weight", kind: "number", min: 100, max: 900, step: 50 },
    { key: "color", label: "text colour", kind: "colour" },
    { key: "background-color", label: "background", kind: "colour" },
    { key: "opacity", label: "opacity", kind: "number", min: 0, max: 1, step: 0.05 },
    { key: "border-radius", label: "radius", kind: "px" },
    { key: "border-color", label: "border colour", kind: "colour" },
    { key: "padding", label: "padding", kind: "px" },
    { key: "letter-spacing", label: "letter spacing", kind: "px" },
    { key: "line-height", label: "line height", kind: "px" },
  ];

  const showNoteInput = (point) => {
    const field = document.createElement("div");
    field.className = "note";
    field.innerHTML =
      "<div class='row'>" +
      "<button type='button' class='toggle' title='Style options'>" +
      "<svg width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='currentColor' " +
      "stroke-width='2' stroke-linecap='round'><path d='M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0'/>" +
      "<circle cx='16' cy='6' r='2'/><circle cx='10' cy='12' r='2'/><circle cx='18' cy='18' r='2'/></svg>" +
      "</button>" +
      "<input class='input' type='text' placeholder='What about this element?' />" +
      "</div>" +
      "<div class='panel' hidden></div>" +
      "<div class='foot'><span class='hint'>Enter to attach · Esc to cancel</span>" +
      "<button type='button' class='reset' hidden>reset</button></div>";
    root.appendChild(field);
    const input = field.querySelector(".input");
    const panel = field.querySelector(".panel");
    const toggle = field.querySelector(".toggle");
    const resetButton = field.querySelector(".reset");

    const place = () => {
      const rect = chosen.getBoundingClientRect();
      const below = rect.bottom + 8;
      field.style.left =
        Math.max(8, Math.min(rect.left, innerWidth - field.offsetWidth - 8)) + "px";
      field.style.top =
        (below + field.offsetHeight > innerHeight
          ? Math.max(8, innerHeight - field.offsetHeight - 8)
          : below) + "px";
    };

    // A computed colour is whatever the page authored: rgb(), but just as
    // often oklch() or lab(). Neither string parsing nor canvas normalisation
    // handles those -- canvas accepts oklch and hands it straight back in the
    // same space -- so the colour is painted onto a single pixel and read back
    // as bytes. Whatever the browser can render, this can convert.
    const scratch = document.createElement("canvas");
    scratch.width = 1;
    scratch.height = 1;
    const scratchContext = scratch.getContext("2d", { willReadFrequently: true });
    const toHex = (value) => {
      if (!value) return "#000000";
      scratchContext.clearRect(0, 0, 1, 1);
      scratchContext.fillStyle = "#000000";
      try {
        scratchContext.fillStyle = value;
      } catch {
        return "#000000";
      }
      scratchContext.fillRect(0, 0, 1, 1);
      try {
        const pixel = scratchContext.getImageData(0, 0, 1, 1).data;
        return (
          "#" +
          [pixel[0], pixel[1], pixel[2]]
            .map((channel) => channel.toString(16).padStart(2, "0"))
            .join("")
        );
      } catch {
        return "#000000";
      }
    };

    const computed = getComputedStyle(chosen);
    const originals = {};
    const tweaks = new Map();
    const recordTweak = (property, from, to) => {
      if (from === to) {
        tweaks.delete(property);
      } else {
        tweaks.set(property, { property, from, to });
      }
      resetButton.hidden = tweaks.size === 0;
    };

    for (const tweak of TWEAKS) {
      const original = computed.getPropertyValue(tweak.key).trim();
      originals[tweak.key] = original;

      const row = document.createElement("label");
      row.className = "prop";
      const name = document.createElement("span");
      name.className = "prop-name";
      name.textContent = tweak.label;
      row.appendChild(name);

      const control = document.createElement("input");
      control.className = tweak.kind === "colour" ? "colour" : "num";
      if (tweak.kind === "colour") {
        control.type = "color";
        control.value = toHex(original);
      } else {
        control.type = "number";
        control.value = String(Math.round(parseFloat(original) * 100) / 100 || 0);
        if (tweak.min !== undefined) control.min = String(tweak.min);
        if (tweak.max !== undefined) control.max = String(tweak.max);
        control.step = String(tweak.step ?? 1);
      }
      control.addEventListener("input", () => {
        const next =
          tweak.kind === "colour"
            ? control.value
            : tweak.kind === "px"
              ? control.value + "px"
              : control.value;
        chosen.style.setProperty(tweak.key, next);
        recordTweak(tweak.key, tweak.kind === "colour" ? toHex(original) : original, next);
      });
      // Arrow keys and typing belong to the field, not to the annotation.
      control.addEventListener("keydown", (event) => event.stopPropagation());
      if (tweak.kind === "colour") {
        row.appendChild(control);
      } else {
        // A stepper of our own: the platform's is a light-mode control that
        // cannot be themed, but nudging a value one step at a time is the
        // point of a number field.
        const stepper = document.createElement("span");
        stepper.className = "stepper";
        const step = (direction) => {
          const amount = Number(control.step) || 1;
          const next = (Number(control.value) || 0) + direction * amount;
          const min = control.min === "" ? -Infinity : Number(control.min);
          const max = control.max === "" ? Infinity : Number(control.max);
          // Rounded because repeated fractional steps drift (0.05 at a time
          // reaches 0.30000000000000004).
          control.value = String(
            Math.round(Math.max(min, Math.min(max, next)) * 1000) / 1000,
          );
          control.dispatchEvent(new Event("input", { bubbles: true }));
        };
        const down = document.createElement("button");
        down.type = "button";
        down.className = "step";
        down.textContent = "\u2212";
        down.addEventListener("click", () => step(-1));
        const up = document.createElement("button");
        up.type = "button";
        up.className = "step";
        up.textContent = "+";
        up.addEventListener("click", () => step(1));
        stepper.appendChild(down);
        stepper.appendChild(control);
        stepper.appendChild(up);
        row.appendChild(stepper);
      }
      if (tweak.kind === "px") {
        const unit = document.createElement("span");
        unit.className = "unit";
        unit.textContent = "px";
        row.appendChild(unit);
      }
      panel.appendChild(row);
    }

    toggle.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      toggle.classList.toggle("on", !panel.hidden);
      place();
      input.focus();
    });

    resetButton.addEventListener("click", () => {
      for (const tweak of TWEAKS) {
        chosen.style.removeProperty(tweak.key);
      }
      for (const control of panel.querySelectorAll("input")) {
        const key = control.parentElement.querySelector(".prop-name").textContent;
        const tweak = TWEAKS.find((entry) => entry.label === key);
        if (!tweak) continue;
        const original = originals[tweak.key];
        control.value =
          tweak.kind === "colour"
            ? toHex(original)
            : String(Math.round(parseFloat(original) * 100) / 100 || 0);
      }
      tweaks.clear();
      resetButton.hidden = true;
      input.focus();
    });

    place();

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
    requestAnimationFrame(() => input.focus());
  };

  const onClick = (event) => {
    // Our own field is exempt. The handler below swallows every click so that
    // picking a "Delete" button does not also press it, and that same
    // swallowing silently disabled the buttons inside the annotation field --
    // composedPath is what sees through the shadow root to tell them apart.
    if (event.composedPath().includes(host)) {
      return;
    }
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
