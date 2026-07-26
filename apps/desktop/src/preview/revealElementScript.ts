/**
 * Shows again, in the page, an element that was picked earlier.
 *
 * The chip in the composer says what was picked but gives no way back to it,
 * and by the time you are writing the message the page may have scrolled
 * somewhere else entirely. This scrolls it back into view and flashes the same
 * blue box the picker drew, so the thing named in the chip and the thing on
 * screen are visibly the same.
 *
 * Found by selector rather than by node id: the id that identified the element
 * during picking died with that document, and the point of this is to work
 * after a reload.
 */

const REVEAL_ID = "__threadlines-reveal-overlay";
/** Long enough to follow the scroll and register, short enough not to linger. */
const REVEAL_VISIBLE_MS = 1600;

export function buildRevealElementScript(selector: string): string {
  return `
(() => {
  const SELECTOR = ${JSON.stringify(selector)};
  const OVERLAY_ID = ${JSON.stringify(REVEAL_ID)};
  const VISIBLE_MS = ${REVEAL_VISIBLE_MS};

  let element = null;
  try {
    element = document.querySelector(SELECTOR);
  } catch {
    // A selector that no longer parses is the same as one that finds nothing.
    return false;
  }
  if (!element) {
    return false;
  }

  document.getElementById(OVERLAY_ID)?.remove();

  const host = document.createElement("div");
  host.id = OVERLAY_ID;
  host.style.cssText =
    "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML =
    "<style>" +
    ":host{all:initial}" +
    ".box{position:fixed;border:2px solid #4c8dff;border-radius:3px;" +
    "background:rgba(76,141,255,0.14);pointer-events:none;" +
    "transition:opacity 220ms ease-out;opacity:1}" +
    ".fade{opacity:0}" +
    "</style><div class='box'></div>";
  const box = root.querySelector(".box");
  document.documentElement.appendChild(host);

  const place = () => {
    const rect = element.getBoundingClientRect();
    box.style.left = rect.left + "px";
    box.style.top = rect.top + "px";
    box.style.width = rect.width + "px";
    box.style.height = rect.height + "px";
  };
  place();

  // Only scrolls when it needs to: an element already on screen should not be
  // yanked to the middle just for being named.
  const rect = element.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  }

  // Track the element through the scroll so the box does not lag behind it.
  const follow = setInterval(place, 60);
  setTimeout(() => {
    clearInterval(follow);
    box.classList.add("fade");
    setTimeout(() => host.remove(), 260);
  }, VISIBLE_MS);

  return true;
})();
`;
}

export const REVEAL_TEARDOWN_SCRIPT = `
document.getElementById(${JSON.stringify(REVEAL_ID)})?.remove();
`;
