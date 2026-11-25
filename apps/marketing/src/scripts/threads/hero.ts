/**
 * The hero's nine threads: from each agent's logo, either side of the
 * headline, through the twist and into the ring on the top edge of the live
 * window, over the thread's name. Each carries a heartbeat; when one arrives,
 * the ring flashes, a ripple runs along the window's edge, the window's
 * working dots answer in that color, and the bottom ring answers 380ms later.
 *
 * Built once the hero's markup exists (inline, right after it), then measured
 * again, without replaying the entrance or resetting the pulses' timing, when
 * fonts load, the page resizes, or the window's thread name moves.
 */
import { f, heroDrawing, type HeroBoxes, ribbonOf, threadWidth } from "./geometry";
import {
  flash,
  mk,
  motion,
  offBox,
  phoneQuery,
  resolveColor,
  splitQuery,
  threadColor,
} from "./dom";
import type { Heartbeat } from "./pulses";
import { createStrings, type StringThread } from "./strings";

const ARRIVAL_PERIOD_MS = 9000;
const ARRIVAL_GAP_MS = 1000;
const FIRST_ARRIVAL_MS = 1800;
const BOTTOM_ANSWER_MS = 380;

export interface Hero {
  readonly element: HTMLElement;
  readonly window: HTMLElement;
  /** Measures and draws again. */
  rebuild(): void;
  /** The ring's x in page terms is the window's thread name; the trunk starts there. */
  titleElement(): HTMLElement | null;
  colors(): string[];
}

export function startHero(heartbeat: Heartbeat): Hero | null {
  const hero = document.querySelector<HTMLElement>(".nt-hero");
  const svg = hero?.querySelector<SVGSVGElement>(".nt-hero-art");
  const win = document.querySelector<HTMLElement>("[data-hero-window]");
  const wrap = win?.parentElement;
  if (!hero || !svg || !win || !wrap) return null;
  const agents = [...hero.querySelectorAll<HTMLAnchorElement>(".nt-agent")];
  const chipsEls = agents.map((agent) => agent.querySelector<HTMLElement>(".nt-chip")!);
  const h1 = hero.querySelector<HTMLElement>("#hero-title")!;
  const sub = hero.querySelector<HTMLElement>(".hero-sub")!;
  const cta = hero.querySelector<HTMLElement>(".hero-cta")!;
  const ports = {
    top: wrap.querySelector<HTMLElement>(".nt-port.top")!,
    bottom: wrap.querySelector<HTMLElement>(".nt-port.bottom")!,
    left: wrap.querySelector<HTMLElement>(".nt-ripple.l")!,
    right: wrap.querySelector<HTMLElement>(".nt-ripple.r")!,
  };
  const strings = createStrings(hero, heartbeat);
  let colors = agents.map((_, j) => resolveColor(threadColor(j)));
  let content: SVGGElement | null = null;

  const titleElement = () =>
    [...win.querySelectorAll<HTMLElement>(".hw-crumb-title, .hw-phone-head span")].find(
      (el) => el.offsetWidth > 0,
    ) ?? null;

  // A pulse reaches the window: the top ring flashes, a ripple runs along the edge, the window answers.
  const latestBump = new WeakMap<Element, Animation>();
  function arrive(j: number) {
    const c = colors[j]!;
    // Only opacity and transform animate, so a flash never repaints: the color is set once.
    const ring = ports.top.querySelector<HTMLElement>("i");
    ring?.style.setProperty("--flash", c);
    flash(
      ring,
      [
        { opacity: 1, transform: "scale(1)" },
        { opacity: 0, transform: "scale(1.55)" },
      ],
      900,
    );
    for (const [el, side] of [
      [ports.left, "left"],
      [ports.right, "right"],
    ] as const) {
      el.style.background = `linear-gradient(to ${side}, ${c}, transparent)`;
      flash(
        el,
        [
          { opacity: 0.95, transform: "scaleX(0.05)" },
          { opacity: 0, transform: "scaleX(1)" },
        ],
        900,
      );
    }
    // The window's working dots answer in the pulse's color: set once, and back once the bump ends.
    for (const dot of win!.querySelectorAll<HTMLElement>(
      ".hw-working-dots i, .hw-row.is-on .hw-dot",
    )) {
      dot.style.background = c;
      const bump = flash(
        dot,
        [
          { transform: "scale(1.5)" },
          { transform: "scale(1)", offset: 0.3 },
          { transform: "scale(1)" },
        ],
        1100,
      );
      if (!bump) continue;
      latestBump.set(dot, bump);
      bump.addEventListener(
        "finish",
        () => {
          // A later arrival may have recolored it already; only the latest bump puts the color back.
          if (latestBump.get(dot) === bump) dot.style.background = "";
        },
        { once: true },
      );
    }
    setTimeout(() => {
      // The page may have been hidden, or motion turned off, in the meantime.
      if (document.visibilityState !== "visible" || !motion()) return;
      const answer = ports.bottom.querySelector<HTMLElement>("i");
      answer?.style.setProperty("--flash", c);
      flash(
        answer,
        [
          { opacity: 1, transform: "scale(1)" },
          { opacity: 0, transform: "scale(1.5)" },
        ],
        800,
      );
    }, BOTTOM_ANSWER_MS);
  }

  function build() {
    const phone = phoneQuery.matches;
    const split = splitQuery.matches;
    const W = hero!.offsetWidth;
    const w = offBox(win!, hero!);
    const title = titleElement();
    const ringX = title ? offBox(title, hero!).cx : w.cx;
    const boxes: HeroBoxes = {
      chips: chipsEls.map((chip) => offBox(chip, hero!)),
      h1: offBox(h1, hero!),
      sub: offBox(sub, hero!),
      cta: offBox(cta, hero!),
      window: w,
      ringX,
    };

    // The rings sit on the window's edges, over the thread's name; outside the clipped window.
    const wb = offBox(win!, wrap!);
    const px = ringX - w.l + wb.l;
    ports.top.style.left = `${px}px`;
    ports.top.style.top = `${wb.t}px`;
    ports.bottom.style.left = `${px}px`;
    ports.bottom.style.top = `${wb.b}px`;
    const spread = Math.min(wb.w * 0.34, 360);
    ports.left.style.cssText = `left:${px - spread}px;width:${spread - 10}px;top:${wb.t - 1}px`;
    ports.right.style.cssText = `left:${px + 10}px;width:${spread - 10}px;top:${wb.t - 1}px`;
    for (const port of Object.values(ports)) port.hidden = false;

    const drawing = heroDrawing(boxes, { phone, split });
    const H = drawing.height;
    svg!.setAttribute("width", String(W));
    svg!.setAttribute("height", String(H));
    svg!.setAttribute("viewBox", `0 0 ${W} ${H}`);
    if (!content) {
      // Built once: the reveal that pours the drawing down on first paint, never replayed. The mask goes
      // once the reveal ends, so the drawing doesn't pay for it on every pulse.
      content = mk("g", {}, svg!);
      if (motion()) {
        const defs = mk("defs", {}, svg!);
        const reveal = mk(
          "mask",
          {
            id: "nt-reveal",
            maskUnits: "userSpaceOnUse",
            x: -50,
            y: 0,
            width: W + 100,
            height: H + 40,
          },
          defs,
        );
        const revealRect = mk(
          "rect",
          { x: -50, y: 0, width: W + 100, height: H + 40, fill: "#fff" },
          reveal,
        );
        content.setAttribute("mask", "url(#nt-reveal)");
        revealRect.style.transformBox = "fill-box";
        revealRect.style.transformOrigin = "50% 0";
        const pour = revealRect.animate([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], {
          duration: 1900,
          easing: "cubic-bezier(0.5, 0, 0.25, 1)",
          fill: "backwards",
        });
        const done = () => {
          content?.removeAttribute("mask");
          defs.remove();
        };
        pour.addEventListener("finish", done, { once: true });
        pour.addEventListener("cancel", done, { once: true });
      }
    }
    content.replaceChildren();
    // Each band is masked by the other where the other passes in front: its lines and pulses break cleanly under it.
    const local = mk("defs", {}, content);
    const masks = ([0, 1] as const).map((band) => {
      const m = mk(
        "mask",
        { id: `nt-under-${band}`, maskUnits: "userSpaceOnUse", x: 0, y: 0, width: W, height: H },
        local,
      );
      mk("rect", { x: 0, y: 0, width: W, height: H, fill: "#fff" }, m);
      return m;
    });
    const groups = ([0, 1] as const).map((band) =>
      mk("g", { mask: `url(#nt-under-${band})` }, content!),
    );
    const pulseGroups = ([0, 1] as const).map((band) =>
      mk("g", { mask: `url(#nt-under-${band})` }, content!),
    );
    const width = threadWidth(drawing);
    heartbeat.remove((lane) => lane.options.space === "hero");
    const threads: StringThread[] = drawing.threads.map((thread) => {
      const color = threadColor(thread.j);
      const all = [...thread.head, ...thread.tail];
      const restD = ribbonOf(all, width);
      const el = mk(
        "path",
        { d: restD, fill: color, class: "nt-s", "data-s": thread.j },
        groups[thread.band],
      );
      mk(
        "circle",
        {
          cx: f(thread.start[0]),
          cy: f(thread.start[1] + 0.5),
          r: drawing.drop / 2 + 0.3,
          fill: color,
          class: "nt-s",
          "data-s": thread.j,
        },
        groups[thread.band],
      );
      for (const run of thread.frontRuns) {
        mk(
          "path",
          {
            d: "M" + run.map((p) => `${f(p[0])} ${f(p[1])}`).join("L"),
            fill: "none",
            stroke: "#000",
            "stroke-width": drawing.strokeW + 3.2,
            "stroke-linecap": "butt",
            "stroke-linejoin": "round",
          },
          masks[1 - thread.band],
        );
      }
      // Heartbeats: each pulse rides its own thread and lands on the ring a second after the one before.
      let lane = null;
      if (motion()) {
        const speed = phone ? 240 : 310;
        let L = 0;
        for (let i = 1; i < all.length; i++)
          L += Math.hypot(all[i]![0] - all[i - 1]![0], all[i]![1] - all[i - 1]![1]);
        lane = heartbeat.lane({
          parent: pulseGroups[thread.band],
          pts: all,
          color,
          space: "hero",
          start: heartbeat.t0 + FIRST_ARRIVAL_MS + thread.j * ARRIVAL_GAP_MS - (L / speed) * 1000,
          period: ARRIVAL_PERIOD_MS,
          speed,
          className: "nt-s",
          dataS: thread.j,
          width: phone ? 1.4 : 1.7,
          hooks: [{ at: L - 4, fn: () => arrive(thread.j) }],
        });
      }
      return {
        j: thread.j,
        band: thread.band,
        head: thread.head,
        tail: thread.tail,
        width,
        el,
        restD,
        lane,
      };
    });
    strings.set(threads);
    applyActive();
  }

  // ---- an agent comes forward on hover or keyboard focus, and the window's message box shows it
  let active: number | null = null;
  const composerChip = win.querySelector<HTMLElement>(".hw-composer .hw-chip:not(.hw-chip-more)");
  const composerHold = composerChip?.innerHTML ?? "";
  const placeholder = win.querySelector<HTMLElement>(
    '.hw-composer .hw-for[data-for="default"] .hw-placeholder',
  );
  const placeholderHold = placeholder?.textContent ?? "";
  function applyActive() {
    if (active === null) delete svg!.dataset.active;
    else svg!.dataset.active = String(active);
    for (const node of svg!.querySelectorAll(".nt-s")) {
      node.classList.toggle("on", node.getAttribute("data-s") === String(active));
    }
  }
  function setActive(j: number | null) {
    active = j;
    applyActive();
    for (const [i, agent] of agents.entries()) agent.classList.toggle("is-active", i === j);
    if (!composerChip) return;
    if (j === null) {
      composerChip.innerHTML = composerHold;
      if (placeholder) placeholder.textContent = placeholderHold;
      return;
    }
    const agent = agents[j]!;
    const name = agent.dataset.name ?? "";
    const mark = agent.querySelector(".nt-chip")?.innerHTML ?? "";
    composerChip.innerHTML = `<span class="hw-mark hw-mark-codex">${mark}</span>${name}`;
    if (placeholder) placeholder.textContent = `Message ${name} · @ agents or files, / commands`;
  }
  agents.forEach((agent, j) => {
    agent.addEventListener("pointerenter", () => setActive(j));
    agent.addEventListener("focus", () => setActive(j));
    // Leaving or blurring hands the preview back to whichever agent still has focus or the pointer.
    const settle = () => {
      const focused = agents.findIndex((other) => other === document.activeElement);
      const hovered = agents.findIndex((other) => other.matches(":hover"));
      setActive(focused >= 0 ? focused : hovered >= 0 ? hovered : null);
    };
    agent.addEventListener("pointerleave", () => requestAnimationFrame(settle));
    agent.addEventListener("blur", () => requestAnimationFrame(settle));
  });

  document.addEventListener("tl-themechange", () => {
    colors = agents.map((_, j) => resolveColor(threadColor(j)));
  });

  hero.classList.add("nt-drawn");
  build();
  return {
    element: hero,
    window: win,
    rebuild: build,
    titleElement,
    colors: () => colors,
  };
}
