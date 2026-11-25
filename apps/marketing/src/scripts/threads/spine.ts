/**
 * The trunk: out of the window's bottom ring, one sweep to the gutter, and
 * down the page to the last Download button. At Rooms, Threads and Fleet
 * colored strands leave it and tap back in, each starting at the logo of the
 * agent it stands for at every width. Each of the six tools hangs off it on a
 * short branch. It draws itself in as the page scrolls, and its pulses share
 * the hero's clock.
 *
 * Started once the lower page's markup exists; built again on resize. The
 * tool and panel listeners are attached once and read the current build.
 */
import { bez, f, lengthOf, poly, type Pt, quarter, sbend } from "./geometry";
import { flash, mk, motion, offBox, phoneQuery, resolveColor, threadColor } from "./dom";
import type { Hero } from "./hero";
import type { Heartbeat } from "./pulses";

interface Track {
  readonly el: SVGElement;
  readonly L: number;
  /** [distance, furthest y so far]: how much is drawn at a scroll position. */
  readonly samples: [number, number][];
}

interface ToolBranch {
  readonly tool: Element;
  readonly el: SVGPathElement;
  readonly dot: SVGCircleElement;
  readonly color: string;
}

export interface Spine {
  rebuild(): void;
}

/** The trunk's x: this far right of the window's left edge. */
const TRUNK_INSET = { phone: 12, wide: 26 } as const;
/** The Rooms guest chip beside the trunk needs this much room to its left. */
const GUEST_SIDE_ROOM = 76;

export function startSpine(hero: Hero, heartbeat: Heartbeat): Spine | null {
  const page = document.querySelector<HTMLElement>(".page");
  const svg = page?.querySelector<SVGSVGElement>(".nt-spine");
  const endButton = document.querySelector<HTMLElement>(".own-copy .btn");
  if (!page || !svg || !endButton) return null;
  const win = hero.window;
  let tracks: Track[] = [];
  let toolBranches: ToolBranch[] = [];
  let reach = 0;

  function track(el: SVGElement, pts: ReadonlyArray<Pt>) {
    const samples: [number, number][] = [];
    let acc = 0;
    let lastY = -Infinity;
    pts.forEach((p, i) => {
      if (i) acc += Math.hypot(p[0] - pts[i - 1]![0], p[1] - pts[i - 1]![1]);
      lastY = Math.max(lastY, p[1]);
      samples.push([acc, lastY]);
    });
    tracks.push({ el, L: acc, samples });
  }

  function syncTools() {
    for (const b of toolBranches) {
      const on = b.tool.querySelector("input")?.checked ?? false;
      b.el.style.opacity = on ? "1" : "0.42";
      b.dot.setAttribute("fill", on ? b.color : "var(--bg)");
    }
  }
  for (const input of document.querySelectorAll('input[name="tool"]'))
    input.addEventListener("change", syncTools);

  // The last Download button's ring takes each pulse's color: opacity and scale only, so it never repaints.
  const buttonRing = document.createElement("span");
  buttonRing.className = "nt-btn-ring";
  buttonRing.setAttribute("aria-hidden", "true");
  endButton.append(buttonRing);
  function ringButton(j: number) {
    buttonRing.style.setProperty("--flash", hero.colors()[j]!);
    flash(
      buttonRing,
      [
        { opacity: 1, transform: "scale(1)" },
        { opacity: 0, transform: "scale(1.08, 1.25)" },
      ],
      950,
    );
  }

  function build() {
    const phone = phoneQuery.matches;
    const anim = motion();
    const w = offBox(win, page!);
    const title = hero.titleElement();
    const tx = title ? offBox(title, page!).cx : w.cx;
    const S = w.l + (phone ? TRUNK_INSET.phone : TRUNK_INSET.wide);
    const help = offBox(document.querySelector<HTMLElement>(".nt-help")!, page!);
    const r = phone ? 12 : 18;
    const sw = phone ? 1.7 : 2;
    const pulse = { width: sw + 0.6 };

    // Rooms: is there room for Codex's chip beside the trunk, or does it go in the space above the panel?
    const roomFeat = document.querySelector<HTMLElement>("#rooms.nt-feat");
    const guestBeside = !phone && S - GUEST_SIDE_ROOM >= 30;
    if (roomFeat) roomFeat.dataset.guest = guestBeside ? "beside" : "above";

    const end = offBox(endButton!, page!);
    // Measured without the old drawing, which would otherwise hold the page at its old height.
    svg!.setAttribute("height", "0");
    const H = Math.ceil(page!.scrollHeight);
    const W = page!.offsetWidth;
    svg!.replaceChildren();
    svg!.setAttribute("width", String(W));
    svg!.setAttribute("height", String(H));
    svg!.setAttribute("viewBox", `0 0 ${W} ${H}`);
    tracks = [];
    heartbeat.remove((lane) => lane.options.space === "page");
    const defs = mk("defs", {}, svg!);
    const mask = mk(
      "mask",
      { id: "nt-spine-under", maskUnits: "userSpaceOnUse", x: 0, y: 0, width: W, height: H },
      defs,
    );
    mk("rect", { x: 0, y: 0, width: W, height: H, fill: "#fff" }, mask);
    const under = mk("g", { "stroke-width": sw, fill: "none", "stroke-linecap": "round" }, svg!);
    const trunkEl = mk(
      "path",
      {
        stroke: "var(--nt-ink)",
        "stroke-width": phone ? 2.6 : 3,
        mask: "url(#nt-spine-under)",
        fill: "none",
        "stroke-linecap": "round",
      },
      svg!,
    );
    const over = mk("g", { fill: "none" }, svg!);
    const nodes = mk("g", {}, svg!);
    // Pulses on the trunk pass under the Codex strand where it crosses in front, as the trunk does.
    const trunkPulses = mk("g", { mask: "url(#nt-spine-under)" }, svg!);
    const pulseLayer = mk("g", {}, svg!);
    const strands: { el: SVGPathElement; pts: Pt[] }[] = [];
    const strand = (pts: Pt[], color: string) => {
      const el = mk("path", { d: poly(pts), stroke: color }, under);
      strands.push({ el, pts });
      return el;
    };
    const nodeAt = (x: number, y: number, color = "var(--nt-ink)") => {
      const inBand = y > help.t && y < help.b;
      return mk(
        "circle",
        {
          cx: f(x),
          cy: f(y),
          r: phone ? 3.4 : 4,
          fill: inBand ? "var(--nt-band)" : "var(--bg)",
          stroke: color,
          "stroke-width": phone ? 1.6 : 2,
          class: "nt-node",
          "data-y": f(y),
        },
        nodes,
      );
    };

    // The trunk.
    const sweepH = phone ? 52 : 64;
    const trunk: Pt[] = [
      [tx, w.b],
      [tx, w.b + 6],
      ...sbend([tx, w.b + 6], [S, w.b + sweepH], 0.62),
      [S, end.cy - r],
      ...quarter([S, end.cy - r], [S + r, end.cy], true),
      [end.l + 14, end.cy],
    ];
    const trunkFine: Pt[] = [];
    for (let i = 0; i < trunk.length; i++) {
      const p = trunk[i]!;
      const q = trunk[i - 1];
      if (q && p[0] === q[0] && p[1] - q[1] > 24) {
        for (let y = q[1] + 12; y < p[1]; y += 12) trunkFine.push([p[0], y]);
      }
      trunkFine.push(p);
    }
    trunkEl.setAttribute("d", poly(trunk));
    const after = (y: number, len: number) =>
      trunkFine.filter((p) => p[1] > y + 0.5 && p[1] <= y + len);
    const trunkFrom = (y: number) => trunkFine.filter((p) => p[1] > y + 0.5);

    // Rooms: Codex's thread comes in from its logo, winds round the trunk beside its answers, and stays.
    const join = document.querySelector<HTMLElement>("[data-nt-join]");
    const twistEnd = document.querySelector<HTMLElement>("[data-nt-twist-end]");
    const room = document.querySelector<HTMLElement>(".nt-room");
    const guest = document.querySelector<HTMLElement>(".nt-guest");
    if (join && twistEnd && room && guest) {
      const jn = offBox(join, page!);
      const te = offBox(twistEnd, page!);
      const rm = offBox(room, page!);
      const A = phone ? 6 : 9;
      const y0 = jn.cy;
      const y1 = te.b - 6;
      const omega = (Math.PI * 3) / (y1 - y0);
      const helix: [number, number, number][] = [];
      for (let y = y0; y <= y1 + 0.01; y += 1.5) {
        const th = -Math.PI / 2 + omega * (y - y0);
        helix.push([S + A * Math.sin(th), y, Math.cos(th)]);
      }
      // The guest chip: beside the trunk where there is room, otherwise in the space kept for it above the panel.
      let chip: Pt;
      let radius: number;
      if (guestBeside) {
        chip = [S - 74, y0 - 70];
        radius = 20;
      } else {
        const stage = offBox(room.parentElement!, page!);
        radius = 15;
        chip = [S + 30, stage.t + 8 + radius];
      }
      guest.dataset.size = guestBeside ? "beside" : "above";
      // The chip is placed inside its panel's stage; the drawing is in page terms.
      const host = offBox(guest.parentElement!, page!);
      guest.style.left = `${chip[0] - host.l}px`;
      guest.style.top = `${chip[1] - host.t}px`;
      guest.hidden = false;
      const from: Pt = [chip[0], chip[1] + radius - 2];
      const leadIn: Pt[] = [from, ...sbend(from, [S - A, y0], 0.62)];
      const last = helix[helix.length - 1]!;
      const yMerge = Math.max(y1 + 30, rm.b - 70);
      const merge = sbend([last[0], yMerge], [S, yMerge + 40], 0.55);
      const pts: Pt[] = [
        ...leadIn,
        ...helix.map((p): Pt => [p[0], p[1]]),
        [last[0], yMerge],
        ...merge,
      ];
      strand(pts, threadColor(0));
      nodeAt(S, yMerge + 40, threadColor(0));
      let run: Pt[] = [];
      const flush = () => {
        if (run.length > 2) {
          const d = poly(run);
          mk(
            "path",
            {
              d,
              fill: "none",
              stroke: "#000",
              "stroke-width": phone ? 5 : 6.5,
              "stroke-linecap": "butt",
            },
            mask,
          );
          mk(
            "path",
            { d, stroke: threadColor(0), "stroke-width": sw, "stroke-linecap": "round" },
            over,
          );
        }
        run = [];
      };
      helix.forEach((p, i) => {
        if (p[2] > 0.05) {
          if (!run.length && i > 0) run.push([helix[i - 1]![0], helix[i - 1]![1]]);
          run.push([p[0], p[1]]);
        } else flush();
      });
      flush();
      // Where the strand winds behind the trunk, the trunk hides its pulse too.
      const behind = mk(
        "mask",
        { id: "nt-strand-under", maskUnits: "userSpaceOnUse", x: 0, y: 0, width: W, height: H },
        defs,
      );
      mk("rect", { x: 0, y: 0, width: W, height: H, fill: "#fff" }, behind);
      let back: Pt[] = [];
      const cut = () => {
        if (back.length > 1) {
          mk(
            "path",
            {
              d: poly([
                [S, back[0]![1]],
                [S, back[back.length - 1]![1]],
              ]),
              stroke: "#000",
              "stroke-width": (phone ? 2.6 : 3) + 2,
              "stroke-linecap": "butt",
            },
            behind,
          );
        }
        back = [];
      };
      helix.forEach((p) => {
        if (p[2] <= 0.05 && Math.abs(p[0] - S) < 4) back.push([p[0], p[1]]);
        else cut();
      });
      cut();
      const roomsPulses = mk("g", { mask: "url(#nt-strand-under)" }, svg!);
      if (anim) {
        const L = lengthOf(pts);
        heartbeat.lane({
          parent: roomsPulses,
          pts: [...pts, ...after(yMerge + 40, 300)],
          color: threadColor(0),
          space: "page",
          start: heartbeat.t0 + 400,
          period: 6000,
          speed: 260,
          fade: [L + 60, L + 300],
          ...pulse,
        });
      }
    }

    // Threads: the trunk fans out to three child threads, each at its agent's mark, and they tap back in.
    const kids = [...document.querySelectorAll<HTMLElement>(".nt-kid")].map((el) => ({
      el,
      box: offBox(el, page!),
      mark: offBox(el.querySelector<HTMLElement>(".hw-who .hw-mark")!, page!),
      reply: offBox(el.querySelector<HTMLElement>(".nt-after") ?? el, page!),
    }));
    const lines = [...document.querySelectorAll<HTMLElement>(".nt-tstage .nt-line")].map((el) =>
      offBox(el, page!),
    );
    if (kids.length && lines.length === 2) {
      const inRow = Math.abs(kids[0]!.box.t - kids[kids.length - 1]!.box.t) < 4;
      if (inRow) {
        const top = lines[0]!.b + 10;
        const bottom = lines[1]!.t - 10;
        nodeAt(S, top);
        nodeAt(S, bottom);
        kids.forEach(({ el, box, mark }, k) => {
          const color = threadColor(el.dataset.ntKid ?? 0);
          const x = mark.cx;
          const pts: Pt[] = [
            [S, top],
            ...sbend([S, top], [x, box.t + 6], 0.62),
            [x, box.b - 6],
            ...sbend([x, box.b - 6], [S, bottom], 0.62),
          ];
          strand(pts, color);
          if (anim) {
            const L = lengthOf(pts);
            heartbeat.lane({
              parent: pulseLayer,
              pts: [...pts, ...after(bottom, 280)],
              color,
              space: "page",
              start: heartbeat.t0 + 900 + k * 700,
              period: 6000,
              speed: 250,
              fade: [L + 40, L + 280],
              ...pulse,
            });
          }
        });
      } else {
        // Stacked: out to the card's edge level with its agent's mark, and back in from its reply.
        kids.forEach(({ el, box, mark, reply }, k) => {
          const color = threadColor(el.dataset.ntKid ?? 0);
          const yo = mark.cy;
          const yb = reply.cy;
          // Just outside the card, so the node at the end shows whole.
          const edge = box.l - 6;
          const out: Pt[] = [
            [S, yo - 22],
            ...quarter([S, yo - 22], [S + 14, yo], true),
            [edge, yo],
          ];
          const back: Pt[] = [
            [edge, yb],
            [S + 14, yb],
            ...quarter([S + 14, yb], [S, yb + 22], false),
          ];
          strand(out, color);
          strand(back, color);
          nodeAt(S, yo - 22, color);
          nodeAt(S, yb + 22, color);
          nodeAt(edge, yo, color);
          nodeAt(edge, yb, color);
          if (anim) {
            // Out to the card, then (after the time a pulse would take inside it) back from the reply.
            const speed = 200;
            const start = heartbeat.t0 + 900 + k * 700;
            const inside = ((yb - yo) / speed) * 1000;
            const outL = lengthOf(out);
            const backL = lengthOf(back);
            const pulseStyle = {
              color,
              space: "page" as const,
              period: 6000,
              speed,
              width: sw + 0.6,
            };
            heartbeat.lane({ parent: pulseLayer, pts: out, start, ...pulseStyle });
            heartbeat.lane({
              parent: pulseLayer,
              pts: [...back, ...after(yb + 22, 200)],
              start: start + (outL / speed) * 1000 + inside,
              fade: [backL + 20, backL + 200],
              ...pulseStyle,
            });
          }
        });
      }
    }

    // Fleet: the strand leaves for the MacBook that asked, becomes the link to the Windows PC, and comes back.
    buildFleet({
      page: page!,
      S,
      r,
      phone,
      sw,
      strand,
      nodeAt,
      after,
      pulseLayer,
      heartbeat,
      anim,
    });

    // Tools: each hangs off the trunk on a short branch.
    toolBranches = [];
    const tones = [2, 4, 5, 6, 7, 8];
    [...document.querySelectorAll<HTMLElement>(".nt-in .tool")].forEach((tool, i) => {
      const b = offBox(tool, page!);
      const y = b.t + 27;
      const color = threadColor(tones[i % tones.length]!);
      const endX = b.l - (phone ? 7 : 12);
      const pts: Pt[] = [
        [S, y - (phone ? 14 : 22)],
        ...sbend([S, y - (phone ? 14 : 22)], [endX, y], 0.6),
      ];
      const el = strand(pts, color);
      const dot = nodeAt(endX, y, color);
      toolBranches.push({ tool, el, dot, color });
    });
    syncTools();

    // The end: every color comes down into the last Download button, and its ring takes each one.
    if (anim) {
      const toolsTop = offBox(
        document.querySelector<HTMLElement>(".tools-sec") ?? endButton!,
        page!,
      ).t;
      const tail = trunkFrom(toolsTop);
      const L = lengthOf(tail);
      for (let j = 0; j < 9; j++) {
        const speed = 330;
        heartbeat.lane({
          parent: trunkPulses,
          pts: tail,
          color: threadColor(j),
          space: "page",
          start: heartbeat.t0 + j * 1000 - (L / speed) * 1000,
          period: 9000,
          speed,
          width: sw + 0.8,
          hooks: [{ at: L - 6, fn: () => ringButton(j) }],
        });
      }
      // The pulse that reached the window carries on down the trunk, fading over a screen or so.
      for (let j = 0; j < 9; j++) {
        heartbeat.lane({
          parent: trunkPulses,
          pts: trunkFine,
          color: threadColor(j),
          space: "page",
          start: heartbeat.t0 + 1800 + j * 1000 + 380,
          period: 9000,
          speed: 330,
          fade: [380, phone ? 1100 : 1300],
          width: sw + 0.8,
        });
      }
    }

    track(trunkEl, trunk);
    for (const s of strands) track(s.el, s.pts);
    for (const p of over.children) {
      const d = p.getAttribute("d") ?? "";
      track(
        p as SVGElement,
        d
          .slice(1)
          .split("L")
          .map((xy): Pt => {
            const [x, y] = xy.split(" ").map(Number);
            return [x ?? 0, y ?? 0];
          }),
      );
    }
    paint();
  }

  // The trunk and its strands draw in down to a little above the bottom of the screen.
  function paint() {
    const origin = page!.getBoundingClientRect();
    reach = Math.max(reach, -origin.top + innerHeight * 0.82);
    heartbeat.setReach(reach);
    const still = !motion();
    for (const t of tracks) {
      if (still) {
        t.el.style.strokeDasharray = "";
        t.el.style.strokeDashoffset = "";
        continue;
      }
      const s = t.samples;
      let drawn = 0;
      if (reach >= s[s.length - 1]![1]) drawn = t.L;
      else if (reach > s[0]![1]) {
        let lo = 0;
        let hi = s.length - 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (s[mid]![1] <= reach) lo = mid;
          else hi = mid;
        }
        const [l0, y0] = s[lo]!;
        const [l1, y1] = s[hi]!;
        drawn = y1 > y0 ? l0 + ((reach - y0) / (y1 - y0)) * (l1 - l0) : l1;
      }
      t.el.style.strokeDasharray = `${t.L + 1} ${t.L + 1}`;
      t.el.style.strokeDashoffset = String(t.L + 1 - drawn);
    }
    for (const n of svg!.querySelectorAll<SVGElement>(".nt-node")) {
      n.style.opacity = still || Number(n.dataset.y) <= reach ? "1" : "0";
    }
  }
  let scrollFrame = 0;
  addEventListener(
    "scroll",
    () => {
      if (!scrollFrame) {
        scrollFrame = requestAnimationFrame(() => {
          scrollFrame = 0;
          paint();
        });
      }
    },
    { passive: true },
  );

  // Each panel plays once when it scrolls into view.
  if (motion() && "IntersectionObserver" in window) {
    for (const el of document.querySelectorAll<HTMLElement>("[data-play]")) {
      el.classList.add("nt-armed");
      const io = new IntersectionObserver(
        ([entry]) => {
          if (!entry?.isIntersecting) return;
          el.classList.add("play");
          io.disconnect();
        },
        { threshold: 0.35 },
      );
      io.observe(el);
    }
  }

  build();
  return { rebuild: build };
}

// ---------------------------------------------------------------------------
// Fleet: the app's Fleet view, drawn into its panel.

function buildFleet(o: {
  page: HTMLElement;
  S: number;
  r: number;
  phone: boolean;
  sw: number;
  strand: (pts: Pt[], color: string) => SVGPathElement;
  nodeAt: (x: number, y: number, color?: string) => SVGCircleElement;
  after: (y: number, len: number) => Pt[];
  pulseLayer: SVGGElement;
  heartbeat: Heartbeat;
  anim: boolean;
}) {
  const map = document.querySelector<HTMLElement>("[data-nt-map]");
  const svg = map?.querySelector("svg");
  if (!map || !svg) return;
  const box = offBox(map, o.page);
  const Wm = box.w;
  const Hm = box.h;
  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${Wm} ${Hm}`);
  svg.setAttribute("width", String(Wm));
  svg.setAttribute("height", String(Hm));
  const mac: Pt = [Math.max(78, Wm * 0.27), Hm * 0.5];
  const winP: Pt = [Math.min(Wm - 78, Wm * 0.73), Hm * 0.42];
  const color = threadColor(3);
  const R = o.phone ? 17 : 19;
  const inY = mac[1] - 5;
  const outY = mac[1] + 5;
  const pg = mk("g", { fill: "none", "stroke-linecap": "round" }, svg);
  const ties = mk(
    "g",
    { fill: "none", stroke: "var(--hw-sidebar-border)", "stroke-width": 1.4 },
    svg,
  );
  const agentsLayer = mk("g", {}, svg);
  const enter: Pt[] = [
    [0, inY],
    [mac[0] - R + 2, inY],
  ];
  const leave: Pt[] = [
    [mac[0] - R + 2, outY],
    [0, outY],
  ];
  const dx = winP[0] - mac[0];
  const ca = Math.cos(0.62) * R;
  const sa = Math.sin(0.62) * R;
  const goFrom: Pt = [mac[0] + ca, mac[1] - sa];
  const goTo: Pt = [winP[0] - ca, winP[1] - sa];
  const backFrom: Pt = [winP[0] - R, winP[1] + 2];
  const backTo: Pt = [mac[0] + ca, mac[1] + sa];
  const goArc = bez(
    goFrom,
    [mac[0] + dx * 0.32, mac[1] - 40],
    [winP[0] - dx * 0.32, winP[1] - 36],
    goTo,
  );
  const backArc = bez(
    backFrom,
    [winP[0] - dx * 0.34, winP[1] + 6],
    [mac[0] + dx * 0.36, mac[1] + 30],
    backTo,
  );
  mk("path", { d: poly(enter), stroke: color, "stroke-width": o.sw }, pg);
  mk("path", { d: poly(leave), stroke: color, "stroke-width": o.sw }, pg);
  mk(
    "path",
    {
      d: poly([goFrom, ...goArc]),
      stroke: color,
      "stroke-width": o.sw,
      "stroke-dasharray": "0.1 5.5",
    },
    pg,
  );
  mk(
    "path",
    {
      d: poly([backFrom, ...backArc]),
      stroke: color,
      "stroke-width": o.sw,
      "stroke-dasharray": "0.1 5.5",
    },
    pg,
  );
  // Agents at each computer, with their own logos.
  const agentAt = (x: number, y: number, href: string, tone: number, node: Pt) => {
    mk(
      "path",
      {
        d: `M${f(x)} ${f(y)}Q${f((x + node[0]) / 2)} ${f(y + 18)} ${f(node[0] + (x - node[0]) * 0.3)} ${f(node[1] - R + 2)}`,
        stroke: threadColor(tone),
      },
      ties,
    );
    const g = mk("g", { transform: `translate(${f(x)} ${f(y)})` }, agentsLayer);
    mk(
      "circle",
      { r: 12, fill: "var(--hw-card)", stroke: threadColor(tone), "stroke-width": 1.4 },
      g,
    );
    const src = document.querySelector(`.nt-agent[href="${href}"] .nt-chip svg`);
    if (src) {
      const c = src.cloneNode(true) as SVGSVGElement;
      for (const [k, v] of [
        ["x", "-7"],
        ["y", "-7"],
        ["width", "14"],
        ["height", "14"],
      ] as const)
        c.setAttribute(k, v);
      c.style.color = "var(--hw-foreground)";
      // Ids inside a cloned logo (a gradient) must stay unique.
      for (const el of c.querySelectorAll("[id]")) {
        const id = el.id;
        el.id = `${id}-fleet`;
        for (const user of c.querySelectorAll(`[stroke="url(#${id})"], [fill="url(#${id})"]`)) {
          for (const attr of ["stroke", "fill"]) {
            if (user.getAttribute(attr) === `url(#${id})`)
              user.setAttribute(attr, `url(#${id}-fleet)`);
          }
        }
      }
      g.append(c);
    }
  };
  agentAt(mac[0] - 40, mac[1] - 46, "/agents/claude-code", 1, mac);
  agentAt(mac[0] + 34, mac[1] - 52, "/agents/codex", 0, mac);
  agentAt(winP[0] + 42, winP[1] - 40, "/agents/cursor", 3, winP);
  let pcRing: SVGCircleElement | null = null;
  const computer = (p: Pt, laptop: boolean, name: string, sub: string) => {
    const g = mk("g", { transform: `translate(${f(p[0])} ${f(p[1])})` }, svg);
    const ring = mk(
      "circle",
      {
        r: R,
        fill: "var(--hw-card)",
        stroke: laptop ? "var(--hw-border)" : color,
        "stroke-width": 1.6,
      },
      g,
    );
    if (!laptop) pcRing = ring;
    mk(
      "path",
      {
        d: laptop ? "M-8 -5h16v9.5h-16zM-11 8h22" : "M-8 -7h16v11h-16zM-3 8.5h6M0 4v4.5",
        fill: "none",
        stroke: "var(--hw-foreground)",
        "stroke-width": 1.4,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      },
      g,
    );
    mk(
      "circle",
      {
        cx: R * 0.68,
        cy: R * 0.68,
        r: 4,
        fill: "var(--hw-success-foreground)",
        stroke: "var(--hw-card)",
        "stroke-width": 2,
      },
      g,
    );
    mk("text", { y: R + 17, "text-anchor": "middle", class: "nt-ft" }, g).textContent = name;
    mk("text", { y: R + 32, "text-anchor": "middle", class: "nt-fs" }, g).textContent = sub;
  };
  computer(mac, true, "MacBook Pro", "This computer");
  computer(winP, false, "Windows PC", "Connected");

  // Outside the panel: switch curves off and back onto the trunk.
  const ey = box.t + inY;
  const oy = box.t + outY;
  const ex = box.l;
  const outPts: Pt[] = [
    [o.S, ey - 40],
    ...sbend([o.S, ey - 40], [o.S + o.r * 1.6, ey], 0.6, 0, 0.6),
    [ex + 2, ey],
  ];
  const backPts: Pt[] = [
    [ex + 2, oy],
    [o.S + o.r * 1.6, oy],
    ...quarter([o.S + o.r * 1.6, oy], [o.S, oy + 36], false),
  ];
  o.strand(outPts, color);
  o.strand(backPts, color);
  o.nodeAt(o.S, ey - 40, color);
  o.nodeAt(o.S, oy + 36, color);

  if (o.anim) {
    const speed = 240;
    const inside: Pt[] = [
      ...enter,
      goFrom,
      ...goArc,
      backFrom,
      ...backArc,
      [mac[0] - R + 2, outY],
      [0, outY],
    ];
    const tA = (lengthOf(outPts) / speed) * 1000;
    const tB = (lengthOf(inside) / speed) * 1000;
    const start = o.heartbeat.t0 + 1500;
    const pulse = { width: o.sw + 0.6 };
    o.heartbeat.lane({
      parent: o.pulseLayer,
      pts: outPts,
      color,
      space: "page",
      start,
      period: 6500,
      speed,
      ...pulse,
    });
    o.heartbeat.lane({
      parent: mk("g", {}, svg),
      pts: inside,
      color,
      space: "page",
      yOffset: box.t,
      start: start + tA,
      period: 6500,
      speed,
      ...pulse,
      hooks: [
        {
          at: lengthOf([...enter, ...goArc]) + 10,
          fn: () =>
            flash(
              pcRing,
              [{ stroke: resolveColor(color), strokeWidth: 4 }, { strokeWidth: 1.6 }],
              700,
            ),
        },
        {
          at: lengthOf([...enter, ...goArc, ...backArc]) + 20,
          fn: () =>
            flash(
              document.querySelector(".nt-frows li:nth-child(2) .nt-fdot"),
              [{ background: resolveColor(color), transform: "scale(1.8)" }, {}],
              900,
            ),
        },
      ],
    });
    const backFull = [...backPts, ...o.after(oy + 36, 260)];
    o.heartbeat.lane({
      parent: o.pulseLayer,
      pts: backFull,
      color,
      space: "page",
      start: start + tA + tB,
      period: 6500,
      speed,
      fade: [lengthOf(backPts) + 30, lengthOf(backPts) + 260],
      ...pulse,
    });
  }
}
