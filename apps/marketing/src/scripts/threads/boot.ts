/**
 * The homepage's threads, inlined into the page as one script right after the
 * hero (astro.config.mjs compiles it), so the drawing starts as the hero
 * paints rather than after the whole document. The lower page calls
 * `window.tlThreads.lower()` once its own markup exists.
 *
 * The first measurement is provisional: the hero is measured again when fonts
 * load, on resize and rotation, when the window crosses its breakpoints, and
 * when the window's thread name moves (a theme with its own fonts). None of
 * that replays the entrance or resets the pulses' timing.
 */
import { phoneQuery, reducedMotion, splitQuery } from "./dom";
import { type Hero, startHero } from "./hero";
import { createHeartbeat } from "./pulses";
import { type Spine, startSpine } from "./spine";

declare global {
  interface Window {
    tlThreads?: { lower(): void };
  }
}

function boot() {
  const heroEl = () => document.querySelector<HTMLElement>(".nt-hero");
  const pageEl = () => document.querySelector<HTMLElement>(".page");
  const heartbeat = createHeartbeat({
    heroTop: () => heroEl()?.getBoundingClientRect().top ?? 0,
    pageTop: () => pageEl()?.getBoundingClientRect().top ?? 0,
  });
  const hero: Hero | null = startHero(heartbeat);
  if (!hero) return;
  let spine: Spine | null = null;

  // The hero is cheap to measure: again on the next frame. The trunk spans the page: after things settle.
  let heroFrame = 0;
  const rebuildHero = () => {
    if (heroFrame) return;
    heroFrame = requestAnimationFrame(() => {
      heroFrame = 0;
      hero.rebuild();
    });
  };
  let spineTimer = 0;
  const rebuildSpine = () => {
    clearTimeout(spineTimer);
    spineTimer = window.setTimeout(() => spine?.rebuild(), 120);
  };
  const rebuildAll = () => {
    rebuildHero();
    rebuildSpine();
  };

  // The window's thread name moves without the window's box changing: watch the name itself.
  const watchTitle = new ResizeObserver(rebuildAll);
  for (const el of hero.window.querySelectorAll(".hw-crumb-title, .hw-phone-head span"))
    watchTitle.observe(el);
  watchTitle.observe(hero.window);
  watchTitle.observe(hero.element);
  document.fonts.addEventListener("loadingdone", rebuildAll);
  void document.fonts.ready.then(rebuildAll);
  addEventListener("load", rebuildAll);
  addEventListener("resize", rebuildAll);
  addEventListener("orientationchange", rebuildAll);
  for (const query of [phoneQuery, splitQuery, reducedMotion])
    query.addEventListener("change", rebuildAll);

  window.tlThreads = {
    lower() {
      if (spine) return;
      spine = startSpine(hero, heartbeat);
      // Anything below the hero that changes height moves the trunk's joints.
      const main = document.querySelector(".main");
      if (main) {
        let seen = false;
        new ResizeObserver(() => {
          if (seen) rebuildSpine();
          seen = true;
        }).observe(main);
      }
    },
  };
}

boot();
