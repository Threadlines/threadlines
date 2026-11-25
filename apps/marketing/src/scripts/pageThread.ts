/**
 * An inner page's line (components/kit/KitFrame.astro): the trunk or an agent's thread down the
 * frame's left gutter, its strands and its taps, drawn from the data-k-* attributes described at
 * the top of styles/kit.css, and drawn in as the page scrolls. The ring nodes are CSS; this only
 * hides each one until the line reaches it. With motion off, all of it is drawn at once.
 *
 * No heartbeat and no pullable strings: those are the homepage's alone. The curves are the
 * homepage's (scripts/threads/geometry.ts): vertical at both ends, a quarter turn into a button.
 *
 * Everything is measured in layout coordinates (offsetLeft/offsetTop up to the frame), so an
 * entrance's translateY never shifts the line. The frame is measured again whenever its size
 * changes (a question opening, a font arriving, a resize) or a script shows or hides part of it.
 */
type Pt = readonly [number, number];

interface Track {
  readonly el: SVGPathElement;
  readonly length: number;
  /** [distance along the path, the scroll depth that draws it] at each point. */
  readonly samples: ReadonlyArray<readonly [number, number]>;
}

interface Box {
  readonly l: number;
  readonly t: number;
  readonly r: number;
  readonly b: number;
  readonly cx: number;
  readonly cy: number;
}

const NS = "http://www.w3.org/2000/svg";

const round = (v: number) => Math.round(v * 10) / 10;
const poly = (pts: ReadonlyArray<Pt>) =>
  "M" + pts.map((p) => `${round(p[0])} ${round(p[1])}`).join("L");

function bezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, step = 3): Pt[] {
  const n = Math.max(8, Math.ceil(Math.hypot(p3[0] - p0[0], p3[1] - p0[1]) / step));
  const out: Pt[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}

/** From a to b, vertical at both ends. */
const sbend = (a: Pt, b: Pt, k = 0.55) => {
  const dy = b[1] - a[1];
  return bezier(a, [a[0], a[1] + dy * k], [b[0], b[1] - dy * k], b);
};

/** Down, then a quarter turn to the right. */
const quarter = (a: Pt, b: Pt) =>
  bezier(a, [a[0], a[1] + (b[1] - a[1]) * 0.552], [b[0] - (b[0] - a[0]) * 0.552, b[1]], b);

const tone = (name: string | undefined) =>
  !name || name === "ink" ? "var(--nt-ink)" : `var(--t${name})`;

const shown = (el: HTMLElement) => el.offsetParent !== null || el.getClientRects().length > 0;

function start(frame: HTMLElement, svg: SVGSVGElement) {
  const root = document.documentElement;
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const phoneQuery = matchMedia("(max-width: 640px)");
  let tracks: Track[] = [];
  let lit: { el: Element; y: number }[] = [];
  let dots: { el: SVGCircleElement; y: number }[] = [];
  let reach = 0;

  const px = (el: Element, name: string) =>
    parseFloat(getComputedStyle(el).getPropertyValue(name)) || 0;

  /** An element's box in the frame's layout coordinates, transforms ignored. */
  const box = (el: Element): Box => {
    let l = 0;
    let t = 0;
    let node = el as HTMLElement | null;
    while (node && node !== frame) {
      l += node.offsetLeft;
      t += node.offsetTop;
      node = node.offsetParent as HTMLElement | null;
    }
    const html = el as HTMLElement;
    let w = html.offsetWidth;
    let h = html.offsetHeight;
    if (node !== frame) {
      // Not laid out under the frame (an SVG element, say): fall back to the screen's boxes.
      const r = el.getBoundingClientRect();
      const o = frame.getBoundingClientRect();
      l = r.left - o.left;
      t = r.top - o.top;
      w = r.width;
      h = r.height;
    }
    return { l, t, r: l + w, b: t + h, cx: l + w / 2, cy: t + h / 2 };
  };
  const firstLine = (el: Element) => {
    const style = getComputedStyle(el);
    const lh = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
    return box(el).t + lh / 2;
  };
  const mk = <K extends keyof SVGElementTagNameMap>(
    tag: K,
    attrs: Record<string, string | number>,
    parent: Element,
  ) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    parent.append(el);
    return el;
  };

  function build() {
    const W = frame.offsetWidth;
    const H = frame.offsetHeight;
    svg.setAttribute("width", String(W));
    svg.setAttribute("height", String(H));
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.replaceChildren();
    tracks = [];
    lit = [];
    dots = [];
    const under = mk("g", {}, svg);
    const lines = mk("g", {}, svg);
    const dotLayer = mk("g", {}, svg);
    const phone = phoneQuery.matches;
    const railOff = px(root, "--k-inset") - px(root, "--gut");

    // `drawAt` maps a point to the scroll depth that draws it: its y, unless a run across should draw across.
    const path = (
      pts: ReadonlyArray<Pt>,
      color: string,
      cls: string,
      layer: Element = lines,
      drawAt = (p: Pt) => p[1],
    ) => {
      const el = mk("path", { d: poly(pts), class: cls }, layer);
      el.style.stroke = color;
      const samples: [number, number][] = [];
      let acc = 0;
      let low = -Infinity;
      pts.forEach((p, i) => {
        const prev = pts[i - 1];
        if (prev) acc += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
        low = Math.max(low, drawAt(p));
        samples.push([acc, low]);
      });
      tracks.push({ el, length: acc, samples });
    };
    const dot = (x: number, y: number, color: string) => {
      const el = mk("circle", { cx: round(x), cy: round(y), class: "k-dot" }, dotLayer);
      el.style.stroke = color;
      dots.push({ el, y });
    };

    let prev: { x: number; y: number; name: string } | null = null;
    for (const reg of frame.querySelectorAll<HTMLElement>("[data-k-region]")) {
      if (!shown(reg)) continue;
      const name = reg.dataset.kRegion ?? "ink";
      const color = tone(name);
      const cls = name === "ink" ? "k-trunk" : "k-thread";
      const anchor =
        [...reg.querySelectorAll<HTMLElement>("[data-k-node]:not([data-k-steps] > li)")].find(
          shown,
        ) ?? reg;
      const x = box(anchor).l + railOff;
      const r = box(reg);
      const pts: Pt[] = [];
      if (prev) {
        if (prev.name !== name) dot(prev.x, prev.y, color);
        pts.push([prev.x, prev.y]);
        if (Math.abs(prev.x - x) > 1) {
          // The line moves over in the space above the region (the homepage's sweep to the gutter).
          const from: Pt = [prev.x, prev.y + 14];
          pts.push(from, ...sbend(from, [x, r.t - 10], 0.62));
        }
      } else {
        const begin = reg.querySelector<HTMLElement>("[data-k-start]") ?? anchor;
        pts.push([x, begin.dataset.kStart === "chip" ? box(begin).b : firstLine(begin)]);
      }

      const end = [...reg.querySelectorAll<HTMLElement>("[data-k-end]")].find(shown);
      const rise = reg.querySelector<HTMLElement>('[data-k-taps="up"]');
      if (end) {
        const e = box(end);
        const R = phone ? 12 : 18;
        pts.push([x, e.cy - R], ...quarter([x, e.cy - R], [x + R, e.cy]), [e.l + 14, e.cy]);
        prev = null;
      } else if (rise && shown(rise)) {
        const y = box(rise).t;
        pts.push([x, y]);
        // Where the line began: each root rises from its chip into the line's end.
        for (const chip of rise.querySelectorAll<HTMLElement>("[data-k-tap]")) {
          const c = box(chip);
          const a: Pt = [x, y];
          const b: Pt = [c.cx, c.t];
          path(
            Math.abs(b[0] - a[0]) < 1 ? [a, b] : [a, ...sbend(a, b, 0.6)],
            tone(chip.dataset.kTap),
            "k-strand",
            under,
          );
        }
        prev = null;
      } else {
        pts.push([x, r.b]);
        prev = { x, y: r.b, name };
      }
      path(pts, color, cls);

      // Nodes: each shows once the line reaches it.
      for (const el of reg.querySelectorAll<HTMLElement>("[data-k-node]")) {
        if (!el.matches("[data-k-steps] > li")) lit.push({ el, y: firstLine(el) });
      }

      // Steps: in a row, a branch leaves the line and runs through the stops; stacked, they sit on the line.
      for (const ol of reg.querySelectorAll<HTMLElement>("[data-k-steps]")) {
        const items = [...ol.children] as HTMLElement[];
        const first = items[0];
        const lastItem = items.at(-1);
        if (!first || !lastItem) continue;
        const size = px(first, "--k-node");
        const boxes = items.map(box);
        const inRow = Math.abs(box(first).t - box(lastItem).t) < 2;
        if (inRow) {
          const y = box(first).t + size / 2;
          const R = 18;
          const last = box(lastItem).l + size / 2;
          const across = (p: Pt) => p[1] + Math.max(0, p[0] - x - R) * 0.4;
          path(
            [[x, y - R], ...quarter([x, y - R], [x + R, y]), [last, y]],
            color,
            "k-strand",
            under,
            across,
          );
          items.forEach((el, i) => lit.push({ el, y: across([boxes[i]!.l + size / 2, y]) }));
        } else {
          for (const el of items) lit.push({ el, y: firstLine(el) });
        }
      }

      // Taps: chips whose strands fall and join the line below them, the nearest chip first.
      for (const group of reg.querySelectorAll<HTMLElement>('[data-k-taps="down"]')) {
        if (!shown(group)) continue;
        const chips = [...group.querySelectorAll<HTMLElement>("[data-k-tap]")]
          .map((el) => ({ el, c: box(el) }))
          .sort((a, b) => Math.abs(a.c.cx - x) - Math.abs(b.c.cx - x));
        if (chips.length === 0) continue;
        const bottom = Math.max(...chips.map(({ c }) => c.b));
        chips.forEach(({ el, c }, i) => {
          const join = bottom + (phone ? 26 : 30) + i * 18;
          const a: Pt = [c.cx, c.b];
          const ink = tone(el.dataset.kTap);
          path([a, ...sbend(a, [x, join], 0.6)], ink, "k-strand", under);
          dot(x, join, ink);
        });
      }
    }
    paint();
  }

  // The line draws in down to a little above the bottom of the screen, and never draws back.
  function paint() {
    const motion = !still.matches;
    root.classList.toggle("k-armed", motion);
    // At the bottom of the page all of it draws, however tall the screen.
    const atBottom = scrollY + innerHeight >= document.documentElement.scrollHeight - 2;
    reach = Math.max(
      reach,
      atBottom ? Infinity : -frame.getBoundingClientRect().top + innerHeight * 0.82,
    );
    for (const t of tracks) {
      if (!motion) {
        t.el.style.strokeDasharray = "";
        t.el.style.strokeDashoffset = "";
        continue;
      }
      const s = t.samples;
      const lastSample = s[s.length - 1];
      const firstSample = s[0];
      let drawn = 0;
      if (!lastSample || !firstSample) continue;
      if (reach >= lastSample[1]) drawn = t.length;
      else if (reach > firstSample[1]) {
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
      t.el.style.strokeDasharray = `${t.length + 1} ${t.length + 1}`;
      t.el.style.strokeDashoffset = String(t.length + 1 - drawn);
    }
    for (const n of lit) n.el.classList.toggle("k-lit", !motion || n.y <= reach);
    for (const d of dots) d.el.style.opacity = !motion || d.y <= reach ? "1" : "0";
  }

  /** Once per frame at most. */
  const perFrame = (fn: () => void) => {
    let frameId = 0;
    return () => {
      if (frameId) return;
      frameId = requestAnimationFrame(() => {
        frameId = 0;
        fn();
      });
    };
  };
  const rebuild = perFrame(build);
  addEventListener("scroll", perFrame(paint), { passive: true });
  // Opening a question, a font arriving or a resize moves what follows: build again.
  new ResizeObserver(rebuild).observe(frame);
  // A script showing or hiding part of the page (the download choices) can move the line's end.
  // (Not a node lighting up: that's this script's own class change, and nothing moves.)
  const litOnly = (r: MutationRecord) => {
    if (r.attributeName !== "class" || !(r.target as Element).matches("[data-k-node]"))
      return false;
    const before = new Set((r.oldValue ?? "").split(/\s+/).filter((c) => c && c !== "k-lit"));
    const after = [...(r.target as Element).classList].filter((c) => c !== "k-lit");
    return before.size === after.length && after.every((c) => before.has(c));
  };
  new MutationObserver((records) => {
    if (!records.every(litOnly)) rebuild();
  }).observe(frame, {
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden", "class", "open"],
    attributeOldValue: true,
  });
  still.addEventListener("change", paint);
  build();
  void document.fonts?.ready.then(build);
}

const frame = document.querySelector<HTMLElement>(".k-frame");
const svg = frame?.querySelector<SVGSVGElement>(":scope > .k-art");
if (frame && svg) start(frame, svg);
