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
import { coveredBoxIndicesSource } from "./regionSelection.ts";

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
/**
 * Where the overlay leaves the elements it chose, for the caller to describe.
 *
 * The alternative -- reporting coordinates and hit-testing them again from the
 * main process -- runs the test twice against a page that may have moved in
 * between, so the box the user saw and the element that gets attached are only
 * probably the same one. Handing over the elements themselves removes the
 * question, and it is the only workable answer for a region, where the choice
 * is a set that no single point identifies.
 */
export const PICK_OVERLAY_STASH = "__threadlinesPickedElements";
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
  delete window[${JSON.stringify(PICK_OVERLAY_STASH)}];
})();
`;

/**
 * How much of an element the rectangle has to cover to count as selected.
 *
 * Full containment reads as the honest rule but punishes an imprecise drag: cut
 * two pixels off a card and it drops out, which feels broken. Most of the way
 * covered is what the gesture means.
 */
const REGION_COVERAGE = 0.8;
/** A sloppy drag across a long page should not attach eighty chips. */
const REGION_MAX_ELEMENTS = 12;
/** Below this a box is a hairline or a spacer, not something to talk about. */
const REGION_MIN_AREA = 64;

export function buildPickOverlayScript(
  colorScheme: "light" | "dark",
  mode: "element" | "region",
): string {
  return `
(() => {
  const OVERLAY_ID = ${JSON.stringify(OVERLAY_ID)};
  const BINDING = ${JSON.stringify(PICK_OVERLAY_BINDING)};
  const STASH = ${JSON.stringify(PICK_OVERLAY_STASH)};
  const REGION_MODE = ${mode === "region"};
  const COVERAGE = ${REGION_COVERAGE};
  const MAX_ELEMENTS = ${REGION_MAX_ELEMENTS};
  const MIN_AREA = ${REGION_MIN_AREA};

  // The selection rule itself, inlined from regionSelection.ts so the page runs
  // exactly what the tests cover.
  ${coveredBoxIndicesSource()}

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
    "*,*::before,*::after{cursor:" +
    (REGION_MODE ? "crosshair" : ${JSON.stringify(arrowCursorCss(colorScheme))}) +
    " !important}";
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
    // Outline, not border. The box is placed at the element's own rect, and a
    // border would be drawn outside that rect on the right and bottom while
    // overlapping it on the left and top -- so the highlight sat a couple of
    // pixels down and to the right of the thing it was pointing at. An outline
    // takes no space and surrounds the rect evenly, which is the whole job.
    ".box{position:fixed;outline:2px solid #4c8dff;border-radius:3px;" +
    "background:rgba(76,141,255,0.14);pointer-events:none;" +
    "transition:all 60ms ease-out}" +
    // No transition on region members: they appear and disappear as the drag
    // crosses them, and easing a box in from its neighbour's position reads as
    // the selection sliding around rather than changing.
    ".box.member{transition:none;outline-width:1.5px}" +
    // The dragged rectangle itself, distinct from what it has caught.
    ".band{position:fixed;box-sizing:border-box;border:1px dashed #4c8dff;border-radius:2px;" +
    "background:rgba(76,141,255,0.07);pointer-events:none}" +
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
    ".input{width:250px;flex:1;box-sizing:border-box;padding:5px 7px;border-radius:4px;" +
    "background:#0f1115;border:1px solid #4c8dff;color:#e8e6e1;outline:none;resize:none;" +
    "overflow-y:auto;font:400 12px/1.4 ui-sans-serif,system-ui,sans-serif}" +
    ".input::placeholder{color:rgba(232,230,225,0.4)}" +
    // The stock scrollbar is a chunky OS control with arrow buttons; the note
    // gets the same quiet thumb the style panel below already uses. The
    // cursor is stated because the bar otherwise inherits the textarea's
    // I-beam, which says "type here" over a control you grab.
    ".input::-webkit-scrollbar{width:8px;cursor:default}" +
    ".input::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.14);border-radius:4px;" +
    "cursor:default}" +
    ".input::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.26)}" +
    ".input::-webkit-scrollbar-thumb:active{background:rgba(255,255,255,0.34)}" +
    ".input::-webkit-scrollbar-button{display:none}" +
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
    ".panel::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.26)}" +
    ".panel::-webkit-scrollbar-thumb:active{background:rgba(255,255,255,0.34)}" +
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
    ".foot{display:flex;align-items:center;gap:6px;margin-top:6px}" +
    // The two things you can do, said as buttons, each carrying its key
    // quietly: the shortcut is taught where the action lives, not in a
    // separate line of instructions.
    ".act{display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border-radius:5px;" +
    "cursor:pointer;border:1px solid transparent;" +
    "font:500 11px/1.2 ui-sans-serif,system-ui,sans-serif}" +
    // Worn as a small centred chip rather than trailing text, which dangled
    // off the label's baseline at a different size.
    ".key{display:inline-flex;align-items:center;justify-content:center;height:14px;" +
    "padding:0 3px;border-radius:3px;" +
    "font:600 8px/1 ui-monospace,SFMono-Regular,Menlo,monospace;" +
    "letter-spacing:0.05em;text-transform:uppercase}" +
    ".attach .key{background:rgba(11,18,32,0.16)}" +
    // Caps-only mono sits optically high when its line box is centred; with
    // border-box height, 2px of top padding nets a 1px drop of the glyphs.
    ".cancel .key{background:rgba(255,255,255,0.09);box-sizing:border-box;padding-top:2px}" +
    ".attach{background:#4c8dff;color:#0b1220}" +
    ".attach:hover{filter:brightness(1.08)}" +
    ".cancel{margin-left:auto;background:none;color:rgba(232,230,225,0.7);" +
    "border-color:rgba(255,255,255,0.16)}" +
    ".cancel:hover{color:#e8e6e1;background:rgba(255,255,255,0.06)}" +
    ".reset{padding:2px 6px;border-radius:3px;cursor:pointer;" +
    "background:none;border:1px solid rgba(255,255,255,0.16);color:rgba(232,230,225,0.7);" +
    "font:400 10px ui-sans-serif,system-ui,sans-serif}" +
    ".reset:hover{color:#e8e6e1;background:rgba(255,255,255,0.06)}" +
    "</style>" +
    "<div class='band' hidden></div><div class='tag' hidden></div>";
  const band = root.querySelector(".band");
  const tag = root.querySelector(".tag");
  document.documentElement.appendChild(host);

  // One box per highlighted element, kept in a pool: element mode uses one,
  // a region uses as many as it caught, and reusing them keeps the drag from
  // churning nodes on every frame.
  const boxes = [];
  const paintBoxes = (elements) => {
    while (boxes.length < elements.length) {
      const box = document.createElement("div");
      box.className = "box" + (REGION_MODE ? " member" : "");
      root.appendChild(box);
      boxes.push(box);
    }
    boxes.forEach((box, index) => {
      const element = elements[index];
      if (!element) {
        box.hidden = true;
        return;
      }
      const rect = element.getBoundingClientRect();
      box.hidden = false;
      box.style.left = rect.left + "px";
      box.style.top = rect.top + "px";
      box.style.width = rect.width + "px";
      box.style.height = rect.height + "px";
    });
  };

  const describe = (element) => {
    const parts = [element.tagName.toLowerCase()];
    if (element.id) parts.push("#" + element.id);
    return parts.join("");
  };

  // Above the anchor by default, tucked below when it would sit off-screen.
  const placeTag = (rect) => {
    const tagRect = tag.getBoundingClientRect();
    const above = rect.top - tagRect.height - 6;
    tag.style.top =
      (above < 4 ? Math.min(rect.bottom + 6, innerHeight - tagRect.height - 4) : above) + "px";
    tag.style.left = Math.max(4, Math.min(rect.left, innerWidth - tagRect.width - 4)) + "px";
  };

  const paint = (element) => {
    paintBoxes([element]);
    const rect = element.getBoundingClientRect();
    tag.hidden = false;
    tag.innerHTML = "<span class='name'></span><span class='dim'></span>";
    tag.querySelector(".name").textContent = describe(element);
    tag.querySelector(".dim").textContent =
      Math.round(rect.width) + "×" + Math.round(rect.height);
    placeTag(rect);
  };

  const hide = () => {
    paintBoxes([]);
    tag.hidden = true;
    current = null;
  };

  let current = null;

  const onMove = (event) => {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element || element === host) {
      hide();
      return;
    }
    current = element;
    paint(element);
  };

  // The elements chosen so far. One in element mode, however many the
  // rectangle caught in region mode; the note field appears once it is filled.
  let chosen = [];

  // Registered while the note field is open, removed on settle: if the
  // document dies mid-note, what was typed attaches rather than vanishing.
  let onPageHide = null;

  // Set while the note field is open. Escape backs out one level: an open
  // note is discarded and picking resumes; with nothing chosen it ends the
  // mode. Cancelling a note must not end the session, because the next
  // annotation is usually the reason the mode is still armed.
  let discardNote = null;

  // Also set while the note field is open: one rebuilds the card when the
  // selection changes under it, keeping the text; the other re-places it as
  // the page scrolls, so the card stays with the elements it is about.
  let updateNoteSelection = null;
  let placeNote = null;

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

  const attach = (note, styleChanges) => {
    window[STASH] = chosen;
    dispose();
    window[BINDING](
      JSON.stringify({ count: chosen.length, note: note === "" ? null : note, styleChanges }),
    );
  };

  const cancel = () => {
    dispose();
    window[BINDING](JSON.stringify({ cancelled: true }));
  };

  /** The box the note field hangs off: the element, or the whole selection. */
  const anchorRect = () => {
    const rects = chosen.map((element) => element.getBoundingClientRect());
    return {
      left: Math.min(...rects.map((rect) => rect.left)),
      right: Math.max(...rects.map((rect) => rect.right)),
      top: Math.min(...rects.map((rect) => rect.top)),
      bottom: Math.max(...rects.map((rect) => rect.bottom)),
    };
  };

  /** Repaints the selection and its tag: one element's name, or a count. */
  const paintChosen = () => {
    paintBoxes(chosen);
    if (chosen.length === 0) return;
    if (chosen.length === 1) {
      paint(chosen[0]);
      return;
    }
    tag.hidden = false;
    tag.innerHTML = "<span class='name'></span>";
    tag.querySelector(".name").textContent = chosen.length + " elements";
    placeTag(anchorRect());
  };

  const showNoteInput = (initialText) => {
    // Style tweaks are a conversation about one element: applied across a
    // selection they would say "make all of these 18px", which is a different
    // request and rarely the one being made.
    const styleable = chosen.length === 1;
    const placeholder = styleable
      ? "What about this element?"
      : "What about these " + chosen.length + " elements?";

    const field = document.createElement("div");
    field.className = "note";
    field.innerHTML =
      "<div class='row'>" +
      "<button type='button' class='toggle' title='Style options'>" +
      "<svg width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='currentColor' " +
      "stroke-width='2' stroke-linecap='round'><path d='M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0'/>" +
      "<circle cx='16' cy='6' r='2'/><circle cx='10' cy='12' r='2'/><circle cx='18' cy='18' r='2'/></svg>" +
      "</button>" +
      "<textarea class='input' rows='1'></textarea>" +
      "</div>" +
      "<div class='panel' hidden></div>" +
      "<div class='foot'>" +
      "<button type='button' class='reset' hidden>reset</button>" +
      "<button type='button' class='act cancel'>Cancel<span class='key'>esc</span></button>" +
      // The return glyph as drawn strokes rather than a font character: at
      // chip size the text glyph renders hairline-thin and ragged.
      "<button type='button' class='act attach'>Attach<span class='key'>" +
      "<svg width='9' height='9' viewBox='0 0 24 24' fill='none' stroke='currentColor' " +
      "stroke-width='3' stroke-linecap='round' stroke-linejoin='round'>" +
      "<path d='M20 4v7a4 4 0 0 1-4 4H4'/><path d='m9 10-5 5 5 5'/></svg>" +
      "</span></button></div>";
    root.appendChild(field);
    const input = field.querySelector(".input");
    const panel = field.querySelector(".panel");
    const toggle = field.querySelector(".toggle");
    const resetButton = field.querySelector(".reset");
    input.value = initialText === undefined ? "" : initialText;
    input.placeholder = placeholder;
    toggle.hidden = !styleable;

    // Tell the host what was chosen now, while the elements exist: the page
    // is free to reload out from under a half-written note (a dev server
    // rebuilding, most often), and a description taken at choose time is what
    // lets the annotation survive that.
    window[STASH] = chosen;
    window[BINDING](JSON.stringify({ chosen: chosen.length }));

    // The page going away is not the user changing their mind: attach what
    // was typed. Removed in dispose, so a settled pick leaves nothing armed.
    onPageHide = () => {
      attach(input.value.trim(), [...tweaks.values()]);
    };
    window.addEventListener("pagehide", onPageHide);

    const place = () => {
      const rect = anchorRect();
      const below = rect.bottom + 8;
      field.style.left =
        Math.max(8, Math.min(rect.left, innerWidth - field.offsetWidth - 8)) + "px";
      field.style.top =
        (below + field.offsetHeight > innerHeight
          ? Math.max(8, innerHeight - field.offsetHeight - 8)
          : below) + "px";
    };

    // One line tall until the note needs more, stopping at about five lines:
    // a long thought should stay visible while it is written, but the card
    // must not swallow the page it is annotating. Past the cap it scrolls.
    const grow = () => {
      input.style.height = "auto";
      // A border-box height includes the two 1px borders that scrollHeight
      // does not; without them the field is permanently overflowed by 2px
      // and shows a scrollbar from its first character.
      input.style.height = Math.min(input.scrollHeight + 2, 96) + "px";
      place();
    };
    input.addEventListener("input", grow);
    placeNote = place;

    const tweaks = new Map();
    // Filled in by the styleable branch: a discarded note takes its tried-on
    // styles with it, or the page keeps changes nobody asked it to keep.
    let revertTweaks = () => {};

    if (styleable) {
      const target = chosen[0];
      revertTweaks = () => {
        for (const tweak of TWEAKS) {
          target.style.removeProperty(tweak.key);
        }
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

      const computed = getComputedStyle(target);
      const originals = {};
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
          target.style.setProperty(tweak.key, next);
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
          down.textContent = "−";
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
          target.style.removeProperty(tweak.key);
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
    }

    grow();

    // Takes the card down without settling the pick: shared by backing out
    // of the note and by rebuilding it for a changed selection.
    const teardownNote = () => {
      revertTweaks();
      window.removeEventListener("pagehide", onPageHide);
      onPageHide = null;
      discardNote = null;
      updateNoteSelection = null;
      placeNote = null;
      field.remove();
    };

    // Backing out of this note, not out of annotating: the field and its
    // tried-on styles go, and the pointer returns to picking. Leaving the
    // mode is escape with nothing chosen, or the toolbar button.
    const discard = () => {
      teardownNote();
      chosen = [];
      hide();
      if (!REGION_MODE) {
        document.addEventListener("mousemove", onMove, true);
      }
    };
    discardNote = discard;

    // The selection changed under an open note: rebuild the card so its
    // title and style options describe what is now chosen, keeping the text.
    // Style tweaks were tried on the old selection, so they go with it.
    updateNoteSelection = () => {
      const text = input.value;
      teardownNote();
      paintChosen();
      showNoteInput(text);
    };

    field.querySelector(".attach").addEventListener("click", () => {
      attach(input.value.trim(), [...tweaks.values()]);
    });
    field.querySelector(".cancel").addEventListener("click", discard);
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      // Enter attaches; shift keeps the newline, as in the composer's editor.
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        attach(input.value.trim(), [...tweaks.values()]);
      } else if (event.key === "Escape") {
        event.preventDefault();
        discard();
      }
    });
    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  };

  const swallow = (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
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
    swallow(event);
    // The click that ends a region drag is the drag settling, not an edit to
    // the selection it just made.
    if (settlingDrag) {
      settlingDrag = false;
      return;
    }
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element || element === host) {
      return;
    }
    if (chosen.length > 0) {
      // An open note means clicking edits the selection: a new element joins
      // it -- one note can be about several things -- and a click anywhere
      // inside something already chosen takes that thing back out. Emptying
      // the selection this way is the same as backing out of the note.
      const existing = chosen.findIndex(
        (candidate) => candidate === element || candidate.contains(element),
      );
      chosen =
        existing >= 0
          ? chosen.filter((candidate, index) => index !== existing)
          : [...chosen, element];
      if (chosen.length === 0) {
        if (discardNote !== null) discardNote();
      } else if (updateNoteSelection !== null) {
        updateNoteSelection();
      }
      return;
    }
    if (REGION_MODE) {
      return;
    }
    chosen = [element];
    paint(element);
    // Stop following the pointer: the highlight now belongs to the choice.
    document.removeEventListener("mousemove", onMove, true);
    showNoteInput();
  };

  // --- Region -------------------------------------------------------------

  // Rects are measured once when the drag starts rather than every frame: the
  // page cannot move under a drag that is holding the mouse down, and reading
  // a few thousand boxes per frame would make the rectangle stutter on exactly
  // the dense pages worth selecting a region of.
  let candidates = [];
  let origin = null;
  let bandRect = null;
  let pending = false;
  // Raised when a drag settles into a selection, so the click event the
  // browser fires right after the mouseup is not read as editing it.
  let settlingDrag = false;

  // The rect a candidate is matched by: what it visibly paints. A block is
  // often far wider than what it shows -- a centred heading owns the whole
  // row while its ink is the text in the middle -- and matching on the box
  // makes a rectangle drawn tightly around everything visible come up empty.
  // An element that paints its own box (background, border, shadow) is
  // visible to its edges and keeps it; anything else is matched by its
  // contents' measured extent, clamped to the box, which is the shape the
  // user can actually see and aim at.
  const candidateRect = (element, rect, style) => {
    if (
      style.backgroundImage !== "none" ||
      style.boxShadow !== "none" ||
      (style.backgroundColor !== "transparent" &&
        style.backgroundColor !== "rgba(0, 0, 0, 0)") ||
      parseFloat(style.borderTopWidth) > 0 ||
      parseFloat(style.borderRightWidth) > 0 ||
      parseFloat(style.borderBottomWidth) > 0 ||
      parseFloat(style.borderLeftWidth) > 0
    ) {
      return rect;
    }
    const range = document.createRange();
    range.selectNodeContents(element);
    const ink = range.getBoundingClientRect();
    const left = Math.max(rect.left, ink.left);
    const top = Math.max(rect.top, ink.top);
    const right = Math.min(rect.right, ink.right);
    const bottom = Math.min(rect.bottom, ink.bottom);
    // Nothing measurable inside -- a replaced element, or an empty one --
    // keeps its box.
    if (right - left <= 0 || bottom - top <= 0) {
      return rect;
    }
    return { left, top, right, bottom };
  };

  const collectCandidates = () => {
    const found = [];
    for (const element of document.body.querySelectorAll("*")) {
      if (host.contains(element) || element === host) continue;
      const tagName = element.tagName;
      if (tagName === "SCRIPT" || tagName === "STYLE" || tagName === "BR" ||
          tagName === "NOSCRIPT" || tagName === "TEMPLATE") {
        continue;
      }
      const rect = element.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area < MIN_AREA) continue;
      // Off-screen boxes cannot be inside a rectangle drawn on screen, and
      // skipping them here keeps the per-frame work to what is visible.
      if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) {
        continue;
      }
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") {
        continue;
      }
      const matched = candidateRect(element, rect, style);
      // The sliver rule again, now on what is actually visible: an element
      // whose ink is a hairline is not something to talk about either.
      if ((matched.right - matched.left) * (matched.bottom - matched.top) < MIN_AREA) {
        continue;
      }
      found.push({ element, rect: matched });
    }
    return found;
  };

  const matchRegion = (region) => {
    const covered = coveredBoxIndices(
      candidates.map((candidate) => candidate.rect),
      region,
      COVERAGE,
    ).map((index) => candidates[index].element);
    // Only the outermost survive: a rectangle over a card means the card, not
    // the card and each of its forty descendants, which is what the agent
    // would otherwise be handed.
    return covered
      .filter((element) => !covered.some((other) => other !== element && other.contains(element)))
      .slice(0, MAX_ELEMENTS);
  };

  const paintBand = () => {
    pending = false;
    if (bandRect === null) return;
    band.hidden = false;
    band.style.left = bandRect.left + "px";
    band.style.top = bandRect.top + "px";
    band.style.width = (bandRect.right - bandRect.left) + "px";
    band.style.height = (bandRect.bottom - bandRect.top) + "px";

    const matched = matchRegion(bandRect);
    paintBoxes(matched);
    tag.hidden = false;
    tag.innerHTML = "<span class='name'></span><span class='dim'></span>";
    tag.querySelector(".name").textContent =
      matched.length === 1 ? "1 element" : matched.length + " elements";
    tag.querySelector(".dim").textContent =
      Math.round(bandRect.right - bandRect.left) + "×" + Math.round(bandRect.bottom - bandRect.top);
    placeTag(bandRect);
  };

  // Every pointer event outside our own field is swallowed for as long as the
  // mode is armed, including after the rectangle is drawn: the page must not
  // receive a stray press while the note is being written.
  const onRegionDown = (event) => {
    if (event.composedPath().includes(host)) return;
    swallow(event);
    if (chosen.length > 0) return;
    origin = { x: event.clientX, y: event.clientY };
    candidates = collectCandidates();
  };

  const onRegionMove = (event) => {
    if (event.composedPath().includes(host)) return;
    swallow(event);
    if (origin === null) return;
    bandRect = {
      left: Math.min(origin.x, event.clientX),
      right: Math.max(origin.x, event.clientX),
      top: Math.min(origin.y, event.clientY),
      bottom: Math.max(origin.y, event.clientY),
    };
    // One paint per frame: mousemove fires far faster than the screen updates
    // and each paint re-tests every candidate.
    if (!pending) {
      pending = true;
      requestAnimationFrame(paintBand);
    }
  };

  const onRegionUp = (event) => {
    if (event.composedPath().includes(host)) return;
    swallow(event);
    if (origin === null) return;
    const dragged = bandRect;
    origin = null;
    bandRect = null;
    band.hidden = true;
    // A click rather than a drag: too small to have meant a rectangle, and
    // treating it as one would select the whole page under the cursor.
    if (dragged === null || dragged.right - dragged.left < 6 || dragged.bottom - dragged.top < 6) {
      hide();
      return;
    }
    const matched = matchRegion(dragged);
    if (matched.length === 0) {
      hide();
      return;
    }
    chosen = matched;
    paintBoxes(matched);
    settlingDrag = true;
    showNoteInput();
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (discardNote !== null) {
        discardNote();
      } else {
        cancel();
      }
    }
  };

  const onScroll = () => {
    if (chosen.length > 0) {
      // The selection, its tag, and the note card all belong to elements in
      // the page, so they move with them rather than floating in place.
      paintChosen();
      if (placeNote !== null) {
        placeNote();
      }
    } else if (current) {
      paint(current);
    }
  };

  function dispose() {
    if (onPageHide !== null) {
      window.removeEventListener("pagehide", onPageHide);
      onPageHide = null;
    }
    cursorStyle.remove();
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mousedown", onRegionDown, true);
    document.removeEventListener("mousemove", onRegionMove, true);
    document.removeEventListener("mouseup", onRegionUp, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onScroll, true);
    host.remove();
  }
  host.__threadlinesDispose = dispose;

  if (REGION_MODE) {
    document.addEventListener("mousedown", onRegionDown, true);
    document.addEventListener("mousemove", onRegionMove, true);
    document.addEventListener("mouseup", onRegionUp, true);
  } else {
    document.addEventListener("mousemove", onMove, true);
  }
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScroll, true);
})();
`;
}
