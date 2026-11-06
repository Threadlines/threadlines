/**
 * The starter themes' art (starters.ts): scripts for the backdrop's draw
 * contract (backdropWorkerPrelude.ts), kept as text because a theme's art is
 * theme content, hashed and shipped as written. They are also the guide's
 * reference art, so each one follows the art rules: calm motion, a seamless
 * loop, its palette taken from the picture, livelier while agents work
 * (`state.working`), a short flourish after a finished turn
 * (`state.sincePulse`), and far under the frame budget. Motion adds up
 * speed × `dt` each frame and eases toward the working look, so nothing
 * jumps when agents start or stop.
 */

/** An ASCII night sky: two aurora curtains ripple above a mountain line, stars twinkle. */
export const AURORA_ART = String.raw`// Aurora: an ASCII night sky. Glyph indices: 0 " " 1 "." 2 "·" 3 ":" 4 ";" 5 "+" 6 "=" 7 "x" 8 "X" 9 "%" 10 "#" 11 "^" 12 "A" 13 "*" 14 "-" 15 "/" 16 "\"
let cols = 0, rows = 0, noise, ground, edge1, edge2, rays1, rays2, calm, boost, phase = -1, busy = 0;
const GREEN = [92, 255, 190], TEAL = [64, 214, 220], VIOLET = [150, 120, 255], PINK = [240, 140, 210];
function hash(a, b) { const h = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return h - Math.floor(h); }
function mixInto(out, o, a, b, k) { out[o] = a[0] + (b[0] - a[0]) * k; out[o + 1] = a[1] + (b[1] - a[1]) * k; out[o + 2] = a[2] + (b[2] - a[2]) * k; }

threadlines.backdrop({
  mode: "grid",
  cell: { width: 11, height: 15 },
  glyphs: " .·:;+=xX%#^A*-/\\",
  background: ["#02040f", "#070c24", "#111842"],
  setup(info) {
    cols = info.cols; rows = info.rows;
    noise = new Float32Array(cols * rows * 2);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      noise[k * 2] = hash(i, j);
      noise[k * 2 + 1] = hash(j + 0.5, i + 0.25);
    }
    ground = new Float32Array(cols);
    for (let i = 0; i < cols; i++) {
      const x = i / cols;
      ground[i] = 0.86 + 0.045 * Math.sin(x * 9 + 0.5) + 0.03 * Math.sin(x * 23) + 0.012 * Math.sin(x * 61 + 2);
    }
    edge1 = new Float32Array(cols); edge2 = new Float32Array(cols);
    rays1 = new Float32Array(cols); rays2 = new Float32Array(cols);
    calm = new Float32Array(cols); boost = new Float32Array(cols);
    // The middle of the sky, where the reading column usually sits, glows softer.
    for (let i = 0; i < cols; i++) {
      const d = Math.abs(i / cols - 0.55);
      calm[i] = 0.62 + 0.38 * Math.min(1, Math.max(0, (d - 0.12) / 0.2));
    }
  },
  draw(grid, info) {
    const t = info.t + 40, dt = info.dt, state = info.state;
    // Agents at work quicken the rays, easing in and out; a finished turn sends a bright wave along the curtains.
    busy += ((state.working > 0 ? 1 : 0) - busy) * Math.min(1, dt * 1.5);
    if (phase < 0) phase = t;
    phase += dt * (1 + 0.8 * busy);
    const front = state.sincePulse * 0.6 - 0.1;
    for (let i = 0; i < cols; i++) {
      const x = i / cols;
      edge1[i] = 0.34 + 0.07 * Math.sin(x * 4.6 + 1.2 + t * 0.045) + 0.03 * Math.sin(x * 15 - t * 0.1);
      edge2[i] = 0.52 + 0.05 * Math.sin(x * 3.7 + 3.1 - t * 0.04) + 0.025 * Math.sin(x * 12 + 1 + t * 0.08);
      const r1 = 0.5 + 0.5 * Math.sin(x * 88 + Math.sin(x * 7 + t * 0.21) * 5 + phase * 0.35);
      const r2 = 0.5 + 0.5 * Math.sin(x * 61 + 2 + Math.sin(x * 5 - t * 0.17) * 4 - phase * 0.3);
      rays1[i] = (0.45 + 0.55 * r1) * (0.62 + 0.38 * Math.sin(x * 9 + t * 0.07));
      rays2[i] = (0.4 + 0.6 * r2) * (0.6 + 0.4 * Math.sin(x * 6 + 2 - t * 0.06));
      const d = x - front;
      boost[i] = 1 + 0.8 * state.pulse * Math.exp(-(d * d) / 0.01);
    }
    const glyph = grid.glyph, fg = grid.fg, bg = grid.bg;
    for (let j = 0; j < rows; j++) {
      const y = j / rows;
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i, o = k * 4, h1 = noise[k * 2], h2 = noise[k * 2 + 1];
        bg[o + 3] = 0;
        if (y > ground[i]) {
          const ridge = y - ground[i] < 1.2 / rows;
          glyph[k] = ridge ? (h2 > 0.5 ? 15 : 16) : h2 > 0.7 ? 11 : h2 > 0.4 ? 12 : -1;
          fg[o] = 70; fg[o + 1] = 84; fg[o + 2] = 150; fg[o + 3] = ridge ? 200 : 90 + 60 * h1;
          bg[o] = 9; bg[o + 1] = 12; bg[o + 2] = 34; bg[o + 3] = 255;
          continue;
        }
        // Each curtain: bright along its lower edge, rays reaching up, a sharp fall below.
        const d1 = y - edge1[i], d2 = y - edge2[i];
        const c1 = (d1 < 0 ? Math.exp(d1 / 0.13) : Math.exp(-(d1 * d1) / 0.0009)) * rays1[i];
        const c2 = 0.8 * (d2 < 0 ? Math.exp(d2 / 0.09) : Math.exp(-(d2 * d2) / 0.0007)) * rays2[i];
        const level = Math.min(1, Math.max(c1, c2) * calm[i] * boost[i] * 1.5);
        if (level > 0.07) {
          const up = Math.min(1, -(c1 >= c2 ? d1 : d2) / 0.22);
          if (up < 0.35) mixInto(fg, o, GREEN, TEAL, Math.max(0, up) / 0.35);
          else if (up < 0.7) mixInto(fg, o, TEAL, VIOLET, (up - 0.35) / 0.35);
          else mixInto(fg, o, VIOLET, PINK, (up - 0.7) / 0.3);
          glyph[k] = Math.min(10, 1 + Math.floor(level * 9 + h1 * 1.2));
          fg[o + 3] = 255 * (0.3 + 0.7 * level);
          if (level > 0.5) { mixInto(bg, o, TEAL, VIOLET, Math.max(0, up)); bg[o + 3] = 255 * 0.14 * (level - 0.5) * 2; }
        } else if (h1 > 0.978) {
          const twinkle = 0.55 + 0.45 * Math.sin(t * 1.7 + h2 * 30);
          glyph[k] = h2 > 0.85 ? 5 : h2 > 0.4 ? 2 : 1;
          fg[o] = 225; fg[o + 1] = 232; fg[o + 2] = 255; fg[o + 3] = 255 * (0.35 + 0.55 * h2) * twinkle;
        } else {
          glyph[k] = -1; fg[o + 3] = 0;
        }
      }
    }
    // A shooting star crosses the upper sky after a finished turn.
    if (state.sincePulse < 1.4) {
      const p = state.sincePulse / 1.4;
      const hx = (0.1 + 0.6 * p) * cols, hy = (0.06 + 0.12 * p) * rows;
      for (let n = 0; n < 10; n++) {
        const ci = Math.round(hx - n * 1.7), cj = Math.round(hy - n * 0.35);
        if (ci < 0 || cj < 0 || ci >= cols || cj >= rows) continue;
        const k = cj * cols + ci, o = k * 4, fade = (1 - n / 10) * (1 - p * 0.6);
        glyph[k] = n === 0 ? 13 : n < 3 ? 2 : 14;
        fg[o] = 240; fg[o + 1] = 245; fg[o + 2] = 255; fg[o + 3] = 255 * fade;
      }
    }
  },
});
`;

/** ASCII snow drifting over two stands of pines, a pale winter sky behind. */
export const SNOWFIELD_ART = String.raw`// Snowfield: ASCII snow over pines. Glyph indices: 0 " " 1 "." 2 "·" 3 "*" 4 "+" 5 "'" 6 "^" 7 "A" 8 "|" 9 "~" 10 "/" 11 "\" 12 "_"
let cols = 0, rows = 0, baseGlyph, baseFg, baseBg, flakes, count = 0, groundTop = 0, busy = 0;
function hash(a, b) { const h = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return h - Math.floor(h); }

function paint(k, glyph, fg, alpha, bg, bgAlpha) {
  baseGlyph[k] = glyph;
  baseFg[k * 4] = fg[0]; baseFg[k * 4 + 1] = fg[1]; baseFg[k * 4 + 2] = fg[2]; baseFg[k * 4 + 3] = alpha;
  baseBg[k * 4] = bg[0]; baseBg[k * 4 + 1] = bg[1]; baseBg[k * 4 + 2] = bg[2]; baseBg[k * 4 + 3] = bgAlpha;
}

// A pine: tiers of branches, outlined with slashes, snow resting on each tier's upper edge.
function tree(cx, height, ink, fill) {
  const top = groundTop - height;
  for (let r = 0; r < height; r++) {
    const j = top + r;
    if (j < 0 || j >= rows) continue;
    if (r >= height - 1) { const k = j * cols + cx; if (cx >= 0 && cx < cols) paint(k, 8, ink, 255, fill, 0); continue; }
    const tier = Math.max(3, Math.round(height / 3.5));
    const half = Math.round((r % tier) * 0.8 + r * 0.25);
    for (let dx = -half; dx <= half; dx++) {
      const i = cx + dx;
      if (i < 0 || i >= cols) continue;
      const k = j * cols + i;
      if (r === 0) { paint(k, 6, ink, 255, fill, 0); continue; }
      if (dx === -half) { paint(k, 10, ink, 255, fill, 150); continue; }
      if (dx === half) { paint(k, 11, ink, 255, fill, 150); continue; }
      const snowy = r % tier === 0 || hash(i, j) > 0.9;
      if (snowy) paint(k, 3, [255, 255, 255], 255, fill, 200);
      else paint(k, hash(j, i) > 0.5 ? 7 : 6, ink, 210, fill, 200);
    }
  }
}

threadlines.backdrop({
  mode: "grid",
  cell: { width: 10, height: 14 },
  glyphs: " .·*+'^A|~/\\_",
  background: ["#c9d6e5", "#dfe7f1", "#eef2f7"],
  setup(info) {
    cols = info.cols; rows = info.rows;
    const n = cols * rows;
    baseGlyph = new Int16Array(n).fill(-1); baseFg = new Uint8Array(n * 4); baseBg = new Uint8Array(n * 4);
    groundTop = rows - Math.max(2, Math.round(rows * 0.07));
    // Snow on the ground, drifts marked with tildes.
    for (let j = groundTop; j < rows; j++) for (let i = 0; i < cols; i++) {
      const k = j * cols + i, crest = j === groundTop;
      paint(k, crest ? 12 : hash(i, j) > 0.75 ? 9 : -1, [168, 186, 206], crest ? 200 : 150, [246, 249, 252], 255);
    }
    // Far pines low across the middle, pale with distance; near pines at the sides.
    const far = [0.31, 0.37, 0.44, 0.52, 0.6, 0.67];
    far.forEach((x, index) => tree(Math.round(x * cols), Math.round(rows * (0.07 + 0.05 * hash(index, 9))), [150, 172, 188], [226, 234, 240]));
    const near = [0.02, 0.075, 0.13, 0.19, 0.81, 0.865, 0.92, 0.975];
    near.forEach((x, index) => tree(Math.round(x * cols), Math.round(rows * (0.2 + 0.17 * hash(index, 3))), [52, 92, 98], [196, 214, 216]));
    count = Math.round(n / 14);
    flakes = new Float32Array(count * 5);
    for (let f = 0; f < count; f++) {
      flakes[f * 5] = hash(f, 1) * cols;
      flakes[f * 5 + 1] = hash(f, 2) * rows;
      flakes[f * 5 + 2] = 0.5 + hash(f, 3) * 1.3;
      flakes[f * 5 + 3] = hash(f, 4) * 6.283;
      flakes[f * 5 + 4] = hash(f, 5);
    }
  },
  draw(grid, info) {
    const t = info.t, dt = Math.min(0.2, info.dt), state = info.state;
    grid.glyph.set(baseGlyph); grid.fg.set(baseFg); grid.bg.set(baseBg);
    // Heavier, quicker snow while agents work, easing in and out; a finished turn sends a sparkling gust.
    busy += ((state.working > 0 ? 1 : 0) - busy) * Math.min(1, dt * 1.5);
    const fall = 1 + 0.7 * busy;
    const gust = state.pulse;
    const glyph = grid.glyph, fg = grid.fg;
    // The extra flakes fade in a band at a time rather than all at once.
    const calmCount = Math.round(count * 0.65), extra = count - calmCount, band = Math.max(1, extra * 0.25);
    for (let f = 0; f < count; f++) {
      const p = f * 5, size = flakes[p + 4];
      flakes[p + 1] += flakes[p + 2] * dt * fall * (1 + gust);
      flakes[p] += (Math.sin(t * 0.6 + flakes[p + 3]) * 0.3 + gust * 9 * (0.4 + size)) * dt;
      if (flakes[p + 1] >= groundTop) { flakes[p + 1] -= groundTop; flakes[p] = hash(f, t) * cols; }
      if (flakes[p] >= cols) flakes[p] -= cols;
      if (flakes[p] < 0) flakes[p] += cols;
      const fade = f < calmCount ? 1 : Math.min(1, (busy * (extra + band) - (f - calmCount)) / band);
      if (fade <= 0) continue;
      const i = Math.floor(flakes[p]), j = Math.floor(flakes[p + 1]);
      const k = j * cols + i, o = k * 4;
      if (baseGlyph[k] >= 0 && baseBg[o + 3] > 0) continue;
      glyph[k] = gust > 0.4 && size > 0.5 ? 3 : size > 0.85 ? 3 : size > 0.45 ? 2 : 1;
      fg[o] = 112; fg[o + 1] = 138; fg[o + 2] = 170; fg[o + 3] = (110 + 120 * size) * fade;
    }
  },
});
`;

/** Painted dunes under a low sun; wind combs streaks of sand across them. */
export const DUNES_ART = String.raw`// Dunes: painted dunes and wind, drawn small and scaled up smoothly.
let W = 0, H = 0, sky, ramps, ridges, grain, drift = -1, busy = 0, blow = 0;
const LAYERS = [
  { base: 0.52, amp: 0.045, lit: [242, 206, 166], shade: [226, 178, 134], speed: 0.004 },
  { base: 0.62, amp: 0.055, lit: [236, 189, 144], shade: [214, 156, 108], speed: 0.008 },
  { base: 0.73, amp: 0.06, lit: [228, 170, 122], shade: [198, 134, 88], speed: 0.012 },
  { base: 0.85, amp: 0.066, lit: [216, 150, 102], shade: [178, 112, 70], speed: 0.016 },
];
const SHADES = 6;
function hash(a, b) { const h = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return h - Math.floor(h); }
function pack(r, g, b) { return 0xff000000 | (Math.max(0, Math.min(255, b)) << 16) | (Math.max(0, Math.min(255, g)) << 8) | Math.max(0, Math.min(255, r)); }

threadlines.backdrop({
  mode: "pixels",
  scale: 5,
  smooth: true,
  setup(info) {
    W = info.cols; H = info.rows;
    sky = new Uint32Array(W * H);
    grain = new Uint8Array(W * H);
    const sunX = W * 0.8, sunY = H * 0.22, radius = Math.min(W, H) * 0.34;
    const top = [251, 240, 224], mid = [248, 224, 194], low = [240, 200, 160];
    for (let y = 0; y < H; y++) {
      const v = y / H;
      const a = v < 0.45 ? top : mid, b = v < 0.45 ? mid : low, k = v < 0.45 ? v / 0.45 : (v - 0.45) / 0.55;
      for (let x = 0; x < W; x++) {
        let r = a[0] + (b[0] - a[0]) * k, g = a[1] + (b[1] - a[1]) * k, bl = a[2] + (b[2] - a[2]) * k;
        const d = Math.hypot(x - sunX, y - sunY) / radius;
        const disc = Math.max(0, Math.min(1, (0.2 - d) / 0.02));
        const glow = disc + (1 - disc) * Math.max(0, 1 - d) * 0.45;
        r += (255 - r) * glow; g += (251 - g) * glow; bl += (238 - bl) * glow * 0.9;
        grain[y * W + x] = Math.floor(hash(x, y) * 4);
        const fleck = (hash(y, x) - 0.5) * 4;
        sky[y * W + x] = pack(r + fleck, g + fleck, bl + fleck);
      }
    }
    // Each layer's colors by how far a pixel sits below its crest and how the slope faces the sun.
    ramps = LAYERS.map((layer) => {
      const ramp = new Uint32Array(SHADES * 4 * 256);
      for (let shade = 0; shade < SHADES; shade++) for (let variant = 0; variant < 4; variant++) for (let depth = 0; depth < 256; depth++) {
        const k = Math.min(1, depth / (H * 0.4)) * 0.7 + (shade / (SHADES - 1)) * 0.45;
        const crest = depth === 0 ? 0.22 : depth === 1 ? 0.08 : 0;
        const fleck = (variant - 1.5) * 2;
        const r = layer.lit[0] + (layer.shade[0] - layer.lit[0]) * k, g = layer.lit[1] + (layer.shade[1] - layer.lit[1]) * k, b = layer.lit[2] + (layer.shade[2] - layer.lit[2]) * k;
        ramp[(shade * 4 + variant) * 256 + depth] = pack(r + (255 - r) * crest + fleck, g + (247 - g) * crest + fleck, b + (230 - b) * crest + fleck);
      }
      return ramp;
    });
    ridges = LAYERS.map(() => new Float32Array(W + 2));
  },
  draw(pixels, info) {
    const t = info.t + 40, dt = info.dt, state = info.state;
    const u32 = pixels.u32, data = pixels.data;
    u32.set(sky);
    for (let n = 0; n < LAYERS.length; n++) {
      const layer = LAYERS[n], amp = layer.amp * H, ridge = ridges[n];
      for (let x = -1; x <= W; x++) {
        const fx = x / W;
        ridge[x + 1] = H * layer.base + amp * Math.sin(fx * (3.1 + n * 0.7) + n * 1.9 + t * layer.speed) + amp * 0.45 * Math.sin(fx * (7.3 + n) + n * 4.1);
      }
    }
    // Front to back, each dune shows from its crest down to the crest of the nearest dune in front of it,
    // so every pixel is painted once.
    for (let x = 0; x < W; x++) {
      let limit = H;
      for (let n = LAYERS.length - 1; n >= 0; n--) {
        const ridge = ridges[n], ramp = ramps[n];
        const top = Math.max(0, Math.ceil(ridge[x + 1]));
        if (top >= limit) continue;
        // Slopes rising toward the sun on the right are lit; the far sides fall into shade.
        const slope = (ridge[x + 2] - ridge[x]) * 0.5;
        const row = Math.max(0, Math.min(SHADES - 1, Math.round((SHADES - 1) * (0.5 + slope * 0.9)))) * 4;
        for (let y = top; y < limit; y++) {
          const i = y * W + x;
          u32[i] = ramp[((row + grain[i]) << 8) | Math.min(255, y - top)];
        }
        // Soften the crest: the pixel above it takes the sand in proportion to how much of it the dune covers.
        const above = top - 1, cover = top - ridge[x + 1];
        if (above >= 0 && cover > 0) {
          const sand = ramp[row << 8], a = cover * 0.9, p = (above * W + x) * 4;
          data[p] += ((sand & 255) - data[p]) * a; data[p + 1] += (((sand >> 8) & 255) - data[p + 1]) * a; data[p + 2] += (((sand >> 16) & 255) - data[p + 2]) * a;
        }
        limit = top;
      }
    }
    // Wind: soft streaks combing across the dunes. Stronger while agents work, easing in and out;
    // a gust that blows up over a moment after a finished turn. The wind's distance adds up frame
    // by frame, so a change of speed never moves a streak, and extra streaks fade in.
    busy += ((state.working > 0 ? 1 : 0) - busy) * Math.min(1, dt * 1.5);
    blow += (state.pulse - blow) * Math.min(1, dt * 4);
    if (drift < 0) drift = t;
    drift += dt * (1 + 0.6 * busy) * (1 + blow * 2.5);
    const level = 22 + 12 * busy + 16 * blow;
    for (let s = 0; s < level; s++) {
      const y0 = H * (0.16 + 0.72 * hash(s, 3)), length = (34 + 60 * hash(s, 5)) * W / 360;
      const travel = W + length * 2, pace = 10 + 16 * hash(s, 7);
      const x0 = ((hash(s, 9) * travel + drift * pace) % travel) - length;
      const alpha = (0.22 + 0.25 * hash(s, 4)) * (1 + blow * 0.8) * Math.min(1, level - s);
      const lift = 2 + 3 * hash(s, 2);
      for (let step = 0; step < length; step++) {
        const x = Math.round(x0 + step);
        if (x < 0 || x >= W) continue;
        const along = step / length;
        const yf = y0 - Math.sin(along * Math.PI) * lift;
        const y = Math.floor(yf), frac = yf - y;
        const a = Math.min(0.65, alpha * Math.sin(along * Math.PI));
        for (let dy = 0; dy < 2; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          const w = a * (dy === 0 ? 1 - frac : frac), o = (yy * W + x) * 4;
          data[o] += (255 - data[o]) * w; data[o + 1] += (252 - data[o + 1]) * w; data[o + 2] += (244 - data[o + 2]) * w;
        }
      }
    }
  },
});
`;

/** Rain on a window at night; the city's lights blur behind the glass. */
export const NIGHT_RAIN_ART = String.raw`// Night Rain: rain on a window with the city's lights blurred behind it.
let W = 0, H = 0, base, beads, runners, lights;
const COLORS = [[255, 179, 92], [255, 230, 196], [111, 211, 255], [255, 96, 96], [79, 224, 192], [255, 200, 120]];
function hash(a, b) { const h = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return h - Math.floor(h); }

function addDisc(buffer, cx, cy, radius, color, strength) {
  const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(W - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(H - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const d = Math.hypot(x - cx, y - cy) / radius;
    if (d >= 1) continue;
    const a = Math.pow(1 - d * d, 1.4) * strength, o = (y * W + x) * 3;
    buffer[o] += color[0] * a; buffer[o + 1] += color[1] * a; buffer[o + 2] += color[2] * a;
  }
}

threadlines.backdrop({
  mode: "pixels",
  scale: 5,
  smooth: true,
  setup(info) {
    W = info.cols; H = info.rows;
    const light = new Float32Array(W * H * 3);
    for (let y = 0; y < H; y++) {
      const v = y / H, haze = Math.pow(Math.max(0, v - 0.45) / 0.55, 2);
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 3;
        light[o] = 7 + 6 * v + 40 * haze; light[o + 1] = 10 + 6 * v + 22 * haze; light[o + 2] = 18 + 12 * v + 14 * haze;
      }
    }
    // Blurred city lights, thicker at the sides and low down; the middle stays calmer.
    lights = [];
    for (let n = 0; n < 70; n++) {
      let x = hash(n, 1);
      if (x > 0.38 && x < 0.62 && hash(n, 8) > 0.35) x = x < 0.5 ? x - 0.22 : x + 0.22;
      const y = 0.35 + 0.6 * Math.pow(hash(n, 2), 0.7);
      const radius = (5 + 14 * hash(n, 3)) * H / 225;
      const color = COLORS[Math.floor(hash(n, 4) * COLORS.length)];
      const strength = 0.18 + 0.32 * hash(n, 5);
      lights.push({ x: x * W, y: y * H, radius, color, strength });
      addDisc(light, x * W, y * H, radius, color, strength);
    }
    base = new Uint32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      base[i] = 0xff000000 | (Math.min(255, light[i * 3 + 2]) << 16) | (Math.min(255, light[i * 3 + 1]) << 8) | Math.min(255, light[i * 3]);
    }
    beads = [];
    for (let n = 0; n < Math.round(W * H / 380); n++) beads.push({ x: hash(n, 11) * W, y: hash(n, 12) * H, size: hash(n, 13) });
    runners = [];
    for (let n = 0; n < 12; n++) runners.push({ x: hash(n, 21) * W, y: hash(n, 22) * H, speed: 6 + 10 * hash(n, 23), wobble: hash(n, 24) * 6.28 });
  },
  draw(pixels, info) {
    const t = info.t, dt = Math.min(0.2, info.dt), state = info.state;
    const data = pixels.data, u32 = pixels.u32;
    u32.set(base);
    // Distant lightning after a finished turn: the sky brightens softly and fades.
    const flash = state.sincePulse < 1.5 ? Math.exp(-state.sincePulse * 4) * 34 : 0;
    if (flash > 1) {
      for (let o = 0; o < data.length; o += 4) { data[o] += flash * 0.7; data[o + 1] += flash * 0.8; data[o + 2] += flash; }
    }
    const read = (x, y, c) => data[((Math.max(0, Math.min(H - 1, y | 0)) * W) + Math.max(0, Math.min(W - 1, x | 0))) * 4 + c];
    // Beads on the glass: each shows a brighter, flipped bit of the lights above it.
    for (const bead of beads) {
      const x = bead.x | 0, y = bead.y | 0, o = (y * W + x) * 4;
      const lift = 1.5 + bead.size;
      data[o] = read(x, y - 4, 0) * lift + 10; data[o + 1] = read(x, y - 4, 1) * lift + 12; data[o + 2] = read(x, y - 4, 2) * lift + 16;
      if (bead.size > 0.6 && y + 1 < H) { const p = o + W * 4; data[p] *= 0.7; data[p + 1] *= 0.7; data[p + 2] *= 0.75; }
    }
    // Drops running down the glass, leaving a thin wet trail.
    const pace = state.working > 0 ? 1.7 : 1;
    for (const drop of runners) {
      drop.y += drop.speed * dt * pace * (0.6 + 0.4 * Math.sin(t * 1.3 + drop.wobble) ** 2);
      drop.x += Math.sin(t * 0.9 + drop.wobble) * 0.08;
      if (drop.y > H + 4) { drop.y = -4; drop.x = hash(drop.wobble, t) * W; }
      for (let k = 0; k < 18; k++) {
        const x = Math.round(drop.x), y = Math.round(drop.y - k * 1.2);
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        const o = (y * W + x) * 4, a = k === 0 ? 0.9 : 0.22 * (1 - k / 18);
        data[o] += (read(x, y - 5, 0) * 1.8 + 30 - data[o]) * a; data[o + 1] += (read(x, y - 5, 1) * 1.8 + 34 - data[o + 1]) * a; data[o + 2] += (read(x, y - 5, 2) * 1.8 + 40 - data[o + 2]) * a;
      }
    }
    // Rain falling outside, faint and slanted. Heavier while agents work.
    const streaks = state.working > 0 ? 140 : 80;
    for (let s = 0; s < streaks; s++) {
      const speed = 90 + 60 * hash(s, 31), length = 6 + 6 * hash(s, 32);
      const y0 = ((hash(s, 33) * (H + 40) + t * speed) % (H + 40)) - 20;
      const x0 = ((hash(s, 34) * W + t * speed * 0.18) % W);
      for (let k = 0; k < length; k++) {
        const x = Math.round(x0 + k * 0.18), y = Math.round(y0 + k);
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        const o = (y * W + x) * 4;
        data[o] += 9; data[o + 1] += 11; data[o + 2] += 15;
      }
    }
  },
});
`;

/** Slow sparks rising from a bed of embers in the dark. */
export const EMBER_ART = String.raw`// Ember: slow sparks rising off a bed of embers.
let W = 0, H = 0, base, sparks, bed, lastPulse = 1e9, busy = 0;
const CALM = 100, BUSY = 160, BURST = 40;
function hash(a, b) { const h = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return h - Math.floor(h); }
function heatColor(h) {
  if (h > 0.66) { const k = (h - 0.66) / 0.34; return [255, 179 + 62 * k, 71 + 122 * k]; }
  if (h > 0.33) { const k = (h - 0.33) / 0.33; return [255, 106 + 73 * k, 43 + 28 * k]; }
  const k = h / 0.33; return [163 + 92 * k, 38 + 68 * k, 15 + 28 * k];
}
function spawn(s, burst) {
  s.x = burst ? (0.25 + 0.5 * Math.random()) * W : Math.random() * W;
  s.y = H - 1 - Math.random() * H * 0.06;
  s.rise = (burst ? 24 : 7) + Math.random() * (burst ? 20 : 11);
  s.drift = (Math.random() - 0.5) * (burst ? 9 : 3);
  s.wobble = Math.random() * 6.28;
  s.heat = 0.7 + Math.random() * 0.3;
  s.cool = (burst ? 0.12 : 0.06) + Math.random() * 0.1;
  s.on = true;
}

threadlines.backdrop({
  mode: "pixels",
  scale: 5,
  smooth: true,
  setup(info) {
    W = info.cols; H = info.rows;
    base = new Uint32Array(W * H);
    for (let y = 0; y < H; y++) {
      const k = Math.pow(y / H, 2.2);
      const r = 12 + 38 * k, g = 6 + 12 * k, b = 5 + 6 * k;
      for (let x = 0; x < W; x++) base[y * W + x] = 0xff000000 | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0);
    }
    bed = new Float32Array(W);
    sparks = [];
    for (let n = 0; n < BUSY + BURST; n++) {
      const s = {};
      spawn(s, false);
      s.y = Math.random() * H;
      s.heat *= 0.5 + Math.random() * 0.5;
      s.on = n < BUSY;
      sparks.push(s);
    }
  },
  draw(pixels, info) {
    const t = info.t + 20, dt = Math.min(0.2, info.dt), state = info.state;
    const data = pixels.data;
    pixels.u32.set(base);
    // The ember bed glows and breathes along the bottom edge.
    const bedHeight = Math.max(4, Math.round(H * 0.12));
    for (let x = 0; x < W; x++) {
      const fx = x / W;
      bed[x] = 0.45 + 0.25 * Math.sin(fx * 23 + t * 0.7) * Math.sin(fx * 7 - t * 0.31) + 0.2 * Math.sin(fx * 61 + t * 1.3);
    }
    for (let y = H - bedHeight; y < H; y++) {
      const depth = (y - (H - bedHeight)) / bedHeight;
      for (let x = 0; x < W; x++) {
        const a = Math.max(0, Math.min(1, bed[x] * depth * depth * 1.6)), o = (y * W + x) * 4;
        data[o] += (255 - data[o]) * a; data[o + 1] += (96 - data[o + 1]) * a; data[o + 2] += (28 - data[o + 2]) * a;
      }
    }
    // A finished turn throws a burst of quick sparks up from the middle of the bed.
    if (state.sincePulse < lastPulse && state.sincePulse < 0.5) {
      for (let n = BUSY; n < BUSY + BURST; n++) spawn(sparks[n], true);
    }
    lastPulse = state.sincePulse;
    // Sparks rise, sway and cool; more of them, a little faster, while agents work. The extra sparks fade in and out.
    busy += ((state.working > 0 ? 1 : 0) - busy) * Math.min(1, dt * 1.5);
    const lift = 1 + 0.4 * busy;
    for (let n = 0; n < sparks.length; n++) {
      const s = sparks[n];
      if (!s.on) continue;
      s.y -= s.rise * dt * lift;
      s.x += (s.drift + Math.sin(t * 1.1 + s.wobble) * 2.2) * dt;
      s.heat -= s.cool * dt;
      if (s.y < -2 || s.heat <= 0) {
        if (n < BUSY) spawn(s, false);
        else { s.on = false; continue; }
      }
      const fade = n < CALM || n >= BUSY ? 1 : Math.min(1, (busy * (BUSY - CALM + 12) - (n - CALM)) / 12);
      if (fade <= 0) continue;
      const color = heatColor(Math.max(0, s.heat));
      const x = s.x | 0, y = s.y | 0, glow = Math.min(1, s.heat * 1.4) * fade;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const px = x + dx, py = y + dy;
        if (px < 0 || px >= W || py < 0 || py >= H) continue;
        const a = (dx === 0 && dy === 0 ? 1 : dx === 0 || dy === 0 ? 0.35 : 0.15) * glow, o = (py * W + px) * 4;
        data[o] += (color[0] - data[o]) * a; data[o + 1] += (color[1] - data[o + 1]) * a; data[o + 2] += (color[2] - data[o + 2]) * a;
      }
    }
  },
});
`;

/** A summer meadow: grass and dandelion seeds, clouds over hills with a lone tree, butterflies, a few birds now and then. */
export const MEADOW_ART = String.raw`// Meadow: soft grass swaying along the bottom under a pale summer sky, clouds
// drifting over hills with a lone tree, dandelion seeds floating up and
// butterflies near the edges; now and then a few birds cross. Agents at work
// stir a breeze; a finished turn sends a puff of seeds and lifts the
// butterflies. Motion adds up speed x dt.
let W = 0, H = 0, base, blades, seeds, clouds, flies, phase = -1, busy = 0, blow = 0, spawned = 0, lastPulse = 1e9;
let birds = null, nextBirds = 12, sky = null, skyKey = "";
const SEEDS = 110, CALM = 26, BUSY = 44, PUFF = 40;
function hash(a, b) { const h = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return h - Math.floor(h); }
function pack(r, g, b) { return 0xff000000 | (Math.max(0, Math.min(255, b | 0)) << 16) | (Math.max(0, Math.min(255, g | 0)) << 8) | Math.max(0, Math.min(255, r | 0)); }
function put(data, x, y, c, a) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
  const o = (y * W + x) * 4;
  data[o] += (c[0] - data[o]) * a; data[o + 1] += (c[1] - data[o + 1]) * a; data[o + 2] += (c[2] - data[o + 2]) * a;
}
function spawnSeed(s, puffAt) {
  spawned += 1;
  if (puffAt) { s.x = puffAt.x + (hash(spawned, 1) - 0.5) * 14; s.y = puffAt.y + (hash(spawned, 2) - 0.5) * 6; }
  else { s.x = hash(spawned, 1) * W; s.y = H * (0.82 + hash(spawned, 2) * 0.16); }
  s.rise = 3 + hash(spawned, 3) * 4;
  s.drift = 4 + hash(spawned, 4) * 7;
  s.wob = hash(spawned, 5) * 6.283;
  s.size = 1 + hash(spawned, 6) * 1.2;
}

threadlines.backdrop({
  mode: "pixels",
  scale: 4,
  smooth: true,
  setup(info) {
    W = info.cols; H = info.rows;
    base = new Uint32Array(W * H);
    const top = [226, 238, 249], mid = [242, 246, 240], low = [244, 245, 230];
    for (let y = 0; y < H; y++) {
      const v = y / H;
      const a = v < 0.55 ? top : mid, b = v < 0.55 ? mid : low, k = v < 0.55 ? v / 0.55 : (v - 0.55) / 0.45;
      for (let x = 0; x < W; x++) {
        const f = (hash(x, y) - 0.5) * 2;
        let r = a[0] + (b[0] - a[0]) * k, g = a[1] + (b[1] - a[1]) * k, bl = a[2] + (b[2] - a[2]) * k;
        // A warm sun just off the top left.
        const d = Math.hypot(x - W * 0.16, (y - H * 0.08) * 1.3) / (Math.min(W, H) * 0.55), glow = Math.max(0, 1 - d);
        r += (255 - r) * glow * glow * 0.8; g += (250 - g) * glow * glow * 0.7; bl += (226 - bl) * glow * glow * 0.6;
        base[y * W + x] = pack(r + f, g + f, bl + f);
      }
    }
    // Two soft rows of hills, paler with distance.
    const hills = [{ y: 0.66, amp: 0.05, c: [206, 222, 196], f: 2.1, o: 0.4 }, { y: 0.74, amp: 0.045, c: [184, 210, 170], f: 3.3, o: 2.2 }];
    for (const hill of hills) {
      for (let x = 0; x < W; x++) {
        const fx = x / W;
        const top = H * (hill.y + hill.amp * Math.sin(fx * hill.f * 3.14 + hill.o) + hill.amp * 0.4 * Math.sin(fx * 9 + hill.o * 3));
        for (let y = Math.max(0, Math.floor(top)); y < H; y++) {
          const f = (hash(x, y + 7) - 0.5) * 3, i = y * W + x;
          // The crest pixel takes the hill in proportion to how much it covers.
          const cover = y === Math.floor(top) ? 1 - (top - Math.floor(top)) : 1;
          const v = base[i], r = v & 255, g = (v >> 8) & 255, b = (v >> 16) & 255;
          base[i] = pack(r + (hill.c[0] + f - r) * cover, g + (hill.c[1] + f - g) * cover, b + (hill.c[2] + f - b) * cover);
        }
      }
    }
    // A lone tree on the far hill, toward the right.
    {
      const tx = W * 0.84, fx = tx / W, hill = hills[0];
      const ty = H * (hill.y + hill.amp * Math.sin(fx * hill.f * 3.14 + hill.o) + hill.amp * 0.4 * Math.sin(fx * 9 + hill.o * 3));
      const u = H / 300;
      for (let y = 0; y < 9 * u; y++) for (let dx = -1; dx <= 1; dx++) {
        const i = Math.round(ty - y) * W + Math.round(tx + dx * 0.6 * u);
        if (i >= 0 && i < base.length) base[i] = pack(122, 108, 92);
      }
      for (let n = 0; n < 9; n++) {
        const cx = tx + (hash(n, 61) - 0.5) * 12 * u, cy = ty - 12 * u + (hash(n, 62) - 0.5) * 8 * u, rr = (4 + hash(n, 63) * 3) * u;
        for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) {
          const d = Math.hypot(dx, dy);
          if (d > rr) continue;
          const x = Math.round(cx + dx), y = Math.round(cy + dy);
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const shade = 0.85 + 0.15 * (-dy / rr), f = (hash(x, y + 3) - 0.5) * 8;
          base[y * W + x] = pack(118 * shade + f, 156 * shade + f, 104 * shade + f);
        }
      }
    }
    // The meadow floor under the grass.
    const ground = Math.floor(H * 0.86), soft = Math.round(H * 0.06);
    for (let y = ground - soft; y < H; y++) for (let x = 0; x < W; x++) {
      const f = (hash(x, y + 13) - 0.5) * 8, i = y * W + x;
      const k = Math.min(1, (y - (ground - soft)) / soft);
      const v = base[i], r = v & 255, g = (v >> 8) & 255, b = (v >> 16) & 255;
      base[i] = pack(r + (128 + f - r) * k, g + (168 + f - g) * k, b + (104 + f - b) * k);
    }
    blades = [];
    const count = Math.round(W * 0.9);
    for (let n = 0; n < count; n++) {
      const x = hash(n, 41) * W;
      // Shorter across the middle, where the message box sits.
      const middle = 1 - 0.45 * Math.max(0, 1 - Math.abs(x / W - 0.5) / 0.25);
      const shades = [[118, 166, 92], [98, 148, 80], [140, 182, 106], [108, 158, 98]];
      blades.push({
        x, root: ground + 2 + hash(n, 42) * (H - ground),
        len: (8 + hash(n, 43) * 16) * (H / 300) * middle,
        lean: (hash(n, 44) - 0.5) * 0.5, wob: hash(n, 45) * 6.283,
        c: shades[Math.floor(hash(n, 46) * shades.length)],
        flower: hash(n, 47) > 0.96 ? (hash(n, 48) > 0.5 ? [250, 250, 244] : [246, 214, 92]) : null,
      });
    }
    // Clouds: soft puffs made once, drifting at their own heights and speeds.
    clouds = [];
    for (let n = 0; n < 5; n++) {
      const w = Math.round(W * (0.11 + hash(n, 71) * 0.09)), h = Math.round(w * 0.38);
      const alpha = new Float32Array(w * h), shade = new Float32Array(w * h);
      const puffs = 6 + Math.floor(hash(n, 72) * 4);
      for (let q = 0; q < puffs; q++) {
        const px = w * (0.15 + 0.7 * hash(n * 9 + q, 73)), py = h * (0.45 + 0.25 * hash(n * 9 + q, 74));
        const pr = h * (0.28 + 0.22 * hash(n * 9 + q, 75));
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const d = Math.hypot(x - px, (y - py) * 1.15) / pr;
          if (d < 1.2) {
            const a = Math.min(1, (1.2 - d) * 2.2);
            const i = y * w + x;
            if (a > alpha[i]) alpha[i] = a;
          }
        }
      }
      // Flat-ish bottoms, a little shade underneath.
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, v = y / h;
        if (v > 0.72) alpha[i] *= Math.max(0, 1 - (v - 0.72) * 5);
        shade[i] = Math.max(0, v - 0.35) * 0.35;
      }
      // Only the pixels the cloud covers, with each one's color and alpha.
      const cells = [];
      for (let i = 0; i < w * h; i++) {
        const a = alpha[i] * 0.88;
        if (a < 0.02) continue;
        cells.push(i % w, (i / w) | 0, a, 252 - 30 * shade[i], 253 - 26 * shade[i], 255 - 18 * shade[i]);
      }
      clouds.push({ w, h, cells: Float32Array.from(cells), x: hash(n, 76) * (W + w) - w, y: H * (0.04 + 0.34 * hash(n, 77)), speed: 1.2 + hash(n, 78) * 2.6 });
    }
    // Butterflies near the edges of the meadow.
    flies = [
      { home: 0.07, c: [255, 255, 250], o: 0.3 },
      { home: 0.93, c: [250, 214, 96], o: 2.1 },
      { home: 0.17, c: [244, 160, 84], o: 4.4 },
      { home: 0.84, c: [255, 255, 250], o: 5.6 },
    ];
    if (!seeds) {
      seeds = [];
      for (let n = 0; n < SEEDS; n++) { const s = {}; spawnSeed(s, null); s.y = H * (0.2 + hash(n, 9) * 0.75); seeds.push(s); }
    }
  },
  draw(pixels, info) {
    const dt = info.dt, state = info.state;
    const data = pixels.data;
    busy += ((state.working > 0 ? 1 : 0) - busy) * Math.min(1, dt * 1.5);
    blow += (state.pulse - blow) * Math.min(1, dt * 4);
    if (phase < 0) phase = info.t + 10;
    phase += dt * (1 + 0.6 * busy + 1.4 * blow);
    const breeze = 0.12 + 0.08 * busy + 0.18 * blow;
    // Clouds drift by, the nearer ones a little faster. They move less than a
    // pixel a frame, so the sky with its clouds is redrawn only when one has.
    const cloudPace = (1 + 0.5 * busy + 1.5 * blow) * dt;
    let key = "";
    for (const c of clouds) {
      c.x += c.speed * cloudPace;
      if (c.x > W + 2) c.x = -c.w - 2;
      key += Math.round(c.x) + ",";
    }
    if (!sky || sky.length !== base.length) { sky = new Uint32Array(base.length); skyKey = ""; }
    if (key !== skyKey) {
      skyKey = key;
      sky.set(base);
      for (const c of clouds) {
        const x0 = Math.round(c.x), y0 = Math.round(c.y), cells = c.cells;
        for (let q = 0; q < cells.length; q += 6) {
          const xx = x0 + cells[q], yy = y0 + cells[q + 1];
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const i = yy * W + xx, v = sky[i], a = cells[q + 2];
          const r = v & 255, g = (v >> 8) & 255, b = (v >> 16) & 255;
          sky[i] = pack(r + (cells[q + 3] - r) * a, g + (cells[q + 4] - g) * a, b + (cells[q + 5] - b) * a);
        }
      }
    }
    pixels.u32.set(sky);
    // Grass: each blade a short curve from its root, swaying with the breeze.
    for (const b of blades) {
      const sway = b.lean + Math.sin(phase * 1.3 + b.wob + b.x * 0.04) * breeze;
      const steps = Math.ceil(b.len), bend = (sway * 1.6) / steps;
      let x = b.x, y = b.root;
      for (let s = 0; s < steps; s++) {
        const k = s / steps;
        // A small bend: each step leans a little more than the last.
        x += bend * s;
        y -= 1;
        const xi = x | 0, yi = y | 0;
        if (xi < 0 || yi < 0 || xi >= W || yi >= H) continue;
        const o = (yi * W + xi) * 4, a = 0.95 - k * 0.25, light = k * 40;
        data[o] += (b.c[0] + light - data[o]) * a; data[o + 1] += (b.c[1] + light - data[o + 1]) * a; data[o + 2] += (b.c[2] + light * 0.6 - data[o + 2]) * a;
      }
      if (b.flower) { put(data, x, y - 1, b.flower, 0.95); put(data, x + 1, y - 1, b.flower, 0.6); put(data, x - 1, y - 1, b.flower, 0.6); put(data, x, y - 2, b.flower, 0.6); }
    }
    // A finished turn: a puff of seeds from one side of the meadow.
    if (state.sincePulse < lastPulse && state.sincePulse < 0.5) {
      const at = { x: (hash(info.frame, 3) < 0.5 ? 0.12 : 0.88) * W, y: H * 0.86 };
      for (let n = BUSY; n < SEEDS; n++) spawnSeed(seeds[n], at);
    }
    lastPulse = state.sincePulse;
    // Seeds: up and away on the breeze; the extra ones fade in and out.
    const level = CALM + (BUSY - CALM) * busy;
    for (let n = 0; n < SEEDS; n++) {
      const s = seeds[n];
      s.y -= s.rise * dt * (1 + 0.4 * busy + 1.5 * blow);
      s.x += (s.drift * (1 + 1.5 * blow) + Math.sin(phase * 1.7 + s.wob) * 5) * dt;
      if (s.y < -4 || s.x > W + 4) { if (n < BUSY) spawnSeed(s, null); else { s.y = -99; continue; } }
      const fade = n < BUSY ? Math.min(1, level - n) : Math.max(0, Math.min(1, (s.y + 4) / 20)) * (blow > 0.02 || s.y > 0 ? 1 : 0);
      if (fade <= 0 || s.y < -4) continue;
      // Quieter across the middle, where the reading column sits.
      const edge = 0.5 + 0.5 * Math.min(1, Math.abs(s.x / W - 0.5) / 0.3);
      const a = 0.9 * fade * edge, c = [255, 255, 252];
      put(data, s.x, s.y, c, a);
      for (let r = 1; r <= (s.size > 1.6 ? 2 : 1); r++) {
        const fall = a * (0.5 - r * 0.12);
        put(data, s.x + r, s.y, c, fall); put(data, s.x - r, s.y, c, fall); put(data, s.x, s.y - r, c, fall); put(data, s.x, s.y + r, c, fall * 0.6);
      }
      put(data, s.x, s.y + 2, [176, 166, 140], a * 0.5);
    }
    // Butterflies: wandering loops near the edges, wings beating; a finished turn lifts them.
    for (const f of flies) {
      const x = W * f.home + Math.sin(phase * 0.45 + f.o) * W * 0.05 + Math.sin(phase * 1.3 + f.o * 2) * W * 0.012;
      const y = H * (0.8 - 0.12 * blow) + Math.sin(phase * 0.9 + f.o) * H * 0.05 + Math.sin(phase * 2.6 + f.o) * H * 0.01;
      const open = Math.abs(Math.sin(phase * 9 + f.o * 3));
      const span = 1 + Math.round(open * 2);
      put(data, x, y, [92, 78, 70], 0.9);
      for (let k = 1; k <= span; k++) {
        put(data, x - k, y - (k > 1 ? 1 : 0), f.c, 0.95); put(data, x + k, y - (k > 1 ? 1 : 0), f.c, 0.95);
        put(data, x - k, y + 1, f.c, 0.7); put(data, x + k, y + 1, f.c, 0.7);
      }
    }
    // Now and then a few birds cross the upper sky, near an edge.
    if (!birds && info.t > nextBirds) {
      const left = hash(info.frame, 11) < 0.5;
      birds = { x: left ? -12 : W + 12, y: H * (0.08 + hash(info.frame, 12) * 0.16), v: (left ? 1 : -1) * (14 + hash(info.frame, 13) * 8), flap: 0 };
    }
    if (birds) {
      birds.x += birds.v * dt;
      birds.flap += dt * 8;
      const gone = birds.v > 0 ? birds.x > W * 0.3 : birds.x < W * 0.7;
      if (gone) { birds = null; nextBirds = info.t + 22 + hash(info.frame, 14) * 28; }
      else {
        for (let k = 0; k < 4; k++) {
          const bx = birds.x - Math.sign(birds.v) * (k * 8 + (k % 2) * 3), by = birds.y + k * 3 * (k % 2 ? 1 : -0.5) + Math.sin(birds.flap + k) * 0.6;
          const wing = Math.sin(birds.flap + k * 1.3) > 0 ? 1 : 0;
          for (const [dx, dy] of [[0, 0], [-1, -1 - wing], [1, -1 - wing], [-2, -1 - wing * 2], [2, -1 - wing * 2]]) put(data, bx + dx, by + dy, [84, 92, 96], 0.75);
        }
      }
    }
  },
});
`;

/** A narrow Tokyo alley at night: neon signs, rain in two layers, a wet street that reflects them. */
export const TOKYO_RAIN_ART = String.raw`// Tokyo Rain: a narrow alley at night. Vertical signs hang on the buildings
// at both sides, rain falls in two layers, the wet street at the bottom
// reflects the neon. Rare events: a sign that flickers, a taxi passing, a
// distant train crossing between the buildings.
//
// Cost: the grid buffers persist between frames, so the still parts (sky,
// buildings, signs) are written once and only what moves is touched later.

const DEF = [
  { fx: 0.04, fy: 0.10, text: "カラオケ", color: [255, 61, 139], box: 0, flick: 0 },
  { fx: 0.125, fy: 0.36, text: "居酒屋", color: [255, 74, 52], box: 1, flick: 0 },
  { fx: 0.258, fy: 0.40, text: "ホテル", color: [168, 110, 255], box: 0, flick: 0 },
  { fx: 0.318, fy: 0.17, text: "喫茶", color: [255, 176, 58], box: 0, flick: 1 },
  { fx: 0.884, fy: 0.25, text: "営業中", color: [47, 224, 255], box: 0, flick: 0 },
  { fx: 0.93, fy: 0.06, text: "やきとり", color: [255, 128, 64], box: 1, flick: 0 },
  { fx: 0.975, fy: 0.47, text: "酒場", color: [255, 61, 139], box: 0, flick: 1 },
];

let SIGN_CH = "";
for (const s of DEF) for (const ch of s.text) if (SIGN_CH.indexOf(ch) < 0) SIGN_CH += ch;
const GLYPHS = " │╎-.┌┐└┘─o▪·" + SIGN_CH;
const G = {};
for (let i = 0; i < GLYPHS.length; i++) G[GLYPHS[i]] = i;

const SIN = new Float32Array(256);
for (let i = 0; i < 256; i++) SIN[i] = Math.sin((i / 256) * Math.PI * 2);

function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(n) {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function c8(v) { return v > 255 ? 255 : v < 0 ? 0 : v; }

let C = 0, R = 0, N = 0, GR = 0, GH = 1, L = 0, RB = 0, TRAIN = 0;
let lit, sideW, signMask, reflCol, fade, signs, stGlyph, stFg, dirty, nDirty = 0;
let dX, dY, dS, dL, dF, dLand, nDrops, rnd;
let lastBg = null, frame = 0;
const RP = 96;
const rX = new Int16Array(RP), rY = new Int16Array(RP), rT = new Float32Array(RP);
let rHead = 0;

function spawnDrop(i, anywhere) {
  const far = rnd() < 0.6;
  dX[i] = (rnd() * C) | 0;
  dF[i] = far ? 1 : 0;
  dS[i] = far ? 8 + rnd() * 4 : 15 + rnd() * 7;
  dL[i] = far ? 1 : 2 + ((rnd() * 2) | 0);
  dLand[i] = (GR + (far ? rnd() * 0.5 : 0.25 + rnd() * 0.75) * GH) | 0;
  dY[i] = anywhere ? rnd() * dLand[i] : -rnd() * 8;
}

function build(cols, rows) {
  C = cols; R = rows; N = C * R;
  rnd = mulberry(20261106);
  GH = Math.max(4, Math.round(R * 0.13));
  GR = R - GH;
  L = Math.round(C * 0.36);
  RB = Math.round(C * 0.82);
  TRAIN = Math.max(2, GR - Math.max(3, Math.round(R * 0.15)));
  lit = new Float32Array(N * 3);
  sideW = new Float32Array(C);
  signMask = new Uint8Array(N);
  reflCol = new Float32Array(C * 3);
  stGlyph = new Int16Array(N).fill(-1);
  stFg = new Uint8Array(N * 4);
  dirty = new Int32Array(N);
  nDirty = 0;
  fade = new Float32Array(GH);
  for (let k = 0; k < GH; k++) fade[k] = 0.18 + 0.82 * Math.pow(1 - k / GH, 1.2);
  rT.fill(-99);
  lastBg = null;

  // The middle stays calm: text sits there on frosted glass.
  const mid = C * 0.56, half = C * 0.3;
  for (let x = 0; x < C; x++) {
    const d = Math.abs(x - mid) / half;
    sideW[x] = d >= 1 ? 1 : 0.28 + 0.72 * d * d;
  }

  // Skyline: tall facades at both sides, low hazy buildings far off in the middle.
  const top = new Int16Array(C), edge = new Uint8Array(C), far = new Uint8Array(C);
  const segs = [[0, 0.12, 0], [0.12, 0.25, 0], [0.25, 0.36, 0.13], [0.82, 0.9, 0.1], [0.9, 1.01, 0]];
  for (const [a, b, h] of segs) {
    const x0 = Math.round(a * C), x1 = Math.min(C, Math.round(b * C));
    for (let x = x0; x < x1; x++) top[x] = Math.round(h * R);
    if (x0 > 0 && x0 < C) edge[x0] = 1;
  }
  for (let x = L; x < RB;) {
    const w = 3 + ((rnd() * 7) | 0);
    const h = Math.round(GR * (0.5 + rnd() * 0.3));
    for (let k = 0; k < w && x < RB; k++, x++) { top[x] = h; far[x] = 1; }
  }

  const windows = [];
  for (let r = 0; r < R; r++) {
    for (let x = 0; x < C; x++) {
      const i = r * C + x, i3 = i * 3;
      let cr, cg, cb;
      const hz = Math.max(0, 1 - Math.pow((x - mid) / (C * 0.4), 2));
      if (r < GR) {
        const t = Math.pow(r / GR, 1.8);
        cr = 11 + 33 * t; cg = 12 + 10 * t; cb = 30 + 26 * t;
        const h3 = hz * t * t;
        cr += 30 * h3; cg += 8 * h3; cb += 22 * h3;
        if (r >= top[x]) {
          if (far[x]) {
            cr = cr * 0.35 + 12; cg = cg * 0.35 + 11; cb = cb * 0.35 + 22;
            if (r < GR - 1 && r > top[x] && (x & 1) === 0 && (r & 1) === 1 && rnd() < 0.22) windows.push(i, 1);
          } else {
            cr = 8; cg = 9; cb = 17;
            if (edge[x]) { cr = 5; cg = 6; cb = 11; }
            else if (r > top[x] + 1 && x % 3 === 1 && (r & 1) === 0 && rnd() < 0.16) windows.push(i, 0);
          }
        }
      } else {
        const t = Math.pow((r - GR) / GH, 0.7);
        cr = 26 - 19 * t; cg = 19 - 11 * t; cb = 38 - 25 * t;
        const h3 = hz * (1 - t);
        cr += 18 * h3; cg += 6 * h3; cb += 16 * h3;
      }
      lit[i3] = cr; lit[i3 + 1] = cg; lit[i3 + 2] = cb;
    }
  }

  // Signs: geometry, mask, and a glow field each (sky only; the street gets reflections).
  signs = [];
  DEF.forEach((d, id) => {
    const n = d.text.length;
    const x = Math.min(C - 2, Math.max(1, Math.round(d.fx * C)));
    let y = Math.round(d.fy * R);
    y = Math.max(1, Math.min(y, GR - 3 - n));
    const x0 = x - 1, x1 = x + 1, y0 = y - 1, y1 = y + n;
    if (y1 >= GR - 1) return;
    for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) signMask[py * C + px] = 1;
    const idx = [], ws = [];
    const RX = 10, RY = 8, k = 900, w0 = 1 / (1 + (RX * 12) * (RX * 12) / k);
    for (let gy = Math.max(0, y0 - RY); gy <= Math.min(GR - 1, y1 + RY); gy++) {
      for (let gx = Math.max(0, x0 - RX); gx <= Math.min(C - 1, x1 + RX); gx++) {
        if (gx >= x0 && gx <= x1 && gy >= y0 && gy <= y1) continue;
        const dx = Math.max(x0 - gx, 0, gx - x1) * 12;
        const dy = Math.max(y0 - gy, 0, gy - y1) * 16;
        const w = (1 / (1 + (dx * dx + dy * dy) / k) - w0) / (1 - w0);
        if (w > 0.004) { idx.push(gy * C + gx); ws.push(w); }
      }
    }
    const s = {
      id, x, y, n, x0, x1, y0, y1, text: d.text, color: d.color, box: d.box, flick: d.flick,
      per: 15 + id * 4.7, off: id * 3.1, b: 0, g: d.box ? 0.4 : 0.34,
      idx: Int32Array.from(idx), ws: Float32Array.from(ws),
    };
    signs.push(s);
    glow(s, 1, null);
  });

  // lit windows: small warm squares, static glyphs
  for (let k = 0; k < windows.length; k += 2) {
    const i = windows[k], farw = windows[k + 1];
    if (signMask[i]) continue;
    const j = i * 3, o = i << 2, a = farw ? 0.32 : 0.42;
    const wr = farw ? 190 : 230, wg = farw ? 150 : 165, wb = farw ? 120 : 90;
    stGlyph[i] = farw ? G["·"] : G["▪"];
    stFg[o] = c8(lit[j] + (wr - lit[j]) * a);
    stFg[o + 1] = c8(lit[j + 1] + (wg - lit[j + 1]) * a);
    stFg[o + 2] = c8(lit[j + 2] + (wb - lit[j + 2]) * a);
    stFg[o + 3] = 255;
  }

  nDrops = Math.max(40, Math.round(N * 0.032));
  dX = new Int16Array(nDrops); dY = new Float32Array(nDrops); dS = new Float32Array(nDrops);
  dL = new Uint8Array(nDrops); dF = new Uint8Array(nDrops); dLand = new Int16Array(nDrops);
  for (let i = 0; i < nDrops; i++) spawnDrop(i, true);
}

// Move a sign to brightness nb: shift its glow in "lit" and, if a grid is
// given, rewrite those cells of the background.
function glow(s, nb, grid) {
  const d = (nb - s.b) * s.g;
  s.b = nb;
  const cr = s.color[0] * d, cg = s.color[1] * d, cb = s.color[2] * d;
  const idx = s.idx, ws = s.ws, bg = grid && grid.bg;
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k], j = i * 3, w = ws[k];
    lit[j] += cr * w; lit[j + 1] += cg * w; lit[j + 2] += cb * w;
    if (bg && !signMask[i]) {
      const o = i << 2;
      bg[o] = c8(lit[j]); bg[o + 1] = c8(lit[j + 1]); bg[o + 2] = c8(lit[j + 2]);
    }
  }
}

function panel(grid, s) {
  const b = s.b, c = s.color, bg = grid.bg, fgA = grid.fg;
  for (let py = s.y0; py <= s.y1; py++) {
    for (let px = s.x0; px <= s.x1; px++) {
      const i = py * C + px, o = i << 2;
      if (s.box) { bg[o] = c8(c[0] * 0.78 * b); bg[o + 1] = c8(c[1] * 0.78 * b); bg[o + 2] = c8(c[2] * 0.78 * b); }
      else { bg[o] = c8(12 + c[0] * 0.09 * b); bg[o + 1] = c8(9 + c[1] * 0.09 * b); bg[o + 2] = c8(20 + c[2] * 0.09 * b); }
      bg[o + 3] = 255;
      let g = -1, fr = 0, fg = 0, fb = 0;
      if (px === s.x && py >= s.y && py < s.y + s.n) {
        g = G[s.text[py - s.y]];
        if (s.box) { fr = 30; fg = 9; fb = 16; }
        else { fr = (c[0] + (255 - c[0]) * 0.4) * b; fg = (c[1] + (255 - c[1]) * 0.4) * b; fb = (c[2] + (255 - c[2]) * 0.4) * b; }
      } else if (!s.box) {
        if (py === s.y0) g = px === s.x0 ? G["┌"] : px === s.x1 ? G["┐"] : G["─"];
        else if (py === s.y1) g = px === s.x0 ? G["└"] : px === s.x1 ? G["┘"] : G["─"];
        else if (px === s.x0 || px === s.x1) g = G["│"];
        fr = c[0] * 0.9 * b; fg = c[1] * 0.9 * b; fb = c[2] * 0.9 * b;
      }
      stGlyph[i] = g;
      if (g >= 0) {
        stFg[o] = c8(fr); stFg[o + 1] = c8(fg); stFg[o + 2] = c8(fb); stFg[o + 3] = 255;
        fgA[o] = stFg[o]; fgA[o + 1] = stFg[o + 1]; fgA[o + 2] = stFg[o + 2]; fgA[o + 3] = 255;
      }
      grid.glyph[i] = g;
    }
  }
}

function fullWrite(grid) {
  const bg = grid.bg;
  for (let i = 0, j = 0, o = 0; i < N; i++, j += 3, o += 4) {
    bg[o] = c8(lit[j]); bg[o + 1] = c8(lit[j + 1]); bg[o + 2] = c8(lit[j + 2]); bg[o + 3] = 255;
  }
  grid.glyph.set(stGlyph);
  grid.fg.set(stFg);
  for (const s of signs) panel(grid, s);
  nDirty = 0;
}

// dynamic glyph: fg mixed over the cell's background so alpha reads the same everywhere
function put(grid, i, g, r, gg, b, a) {
  const o = i << 2, bg = grid.bg, fg = grid.fg;
  grid.glyph[i] = g;
  const br = bg[o], bgc = bg[o + 1], bb = bg[o + 2];
  fg[o] = c8(br + (r - br) * a);
  fg[o + 1] = c8(bgc + (gg - bgc) * a);
  fg[o + 2] = c8(bb + (b - bb) * a);
  fg[o + 3] = 255;
  dirty[nDirty++] = i;
}

threadlines.backdrop({
  mode: "grid",
  cell: { width: 12, height: 16 },
  fontSize: 12,
  background: ["#0b0c1e", "#2c1838", "#07080d"],
  glyphs: GLYPHS,
  setup(info) { build(info.cols, info.rows); },
  draw(grid, info) {
    if (info.cols !== C || info.rows !== R || !lit) build(info.cols, info.rows);
    const t = info.t || 0;
    const dt = Math.min(Math.max(info.dt || 0, 0), 0.1);
    const st = info.state || {};
    const pulse = st.pulse || 0;
    const speed = 1 + 0.12 * Math.min(st.working || 0, 3);
    const bg = grid.bg;
    frame++;

    if (grid.bg !== lastBg) { fullWrite(grid); lastBg = grid.bg; }
    else for (let k = 0; k < nDirty; k++) grid.glyph[dirty[k]] = -1;
    nDirty = 0;

    // signs: steady, one or two flicker now and then, all glow brighter after a turn
    for (const s of signs) {
      let b = 1;
      if (s.flick) {
        const ph = (t + s.off) % s.per;
        if (ph < 0.9) b = hash(((t * 12) | 0) + s.id * 977) < 0.4 ? 0.5 : 1;
      }
      b *= 1 + 0.45 * pulse;
      if (Math.abs(b - s.b) > 0.004) { glow(s, b, grid); panel(grid, s); }
    }

    // wet street, half its rows each frame: each sign throws a wobbling streak
    reflCol.fill(0);
    for (const s of signs) {
      const g = s.b * (s.box ? 0.4 : 0.32);
      for (let dx = -2; dx <= 2; dx++) {
        const x = s.x + dx;
        if (x < 0 || x >= C) continue;
        const w = dx === 0 ? 1 : dx === 1 || dx === -1 ? 0.55 : 0.2;
        reflCol[x * 3] += s.color[0] * g * w;
        reflCol[x * 3 + 1] += s.color[1] * g * w;
        reflCol[x * 3 + 2] += s.color[2] * g * w;
      }
    }
    const tp = t % 43, taxi = tp < 7;
    const cx = C + 22 - (C + 44) * (tp / 7);
    const tx0 = taxi ? Math.max(0, (cx - 22) | 0) : C, tx1 = taxi ? Math.min(C - 1, (cx + 22) | 0) : -1;
    const tI = (t * 38) | 0, tJ = (t * 23) | 0;
    for (let k = frame & 1; k < GH; k += 2) {
      const r = GR + k, f = fade[k], rf = 1 - (k / GH) * 0.7, row = r * C;
      for (let x = 0; x < C; x++) {
        const wob = SIN[(r * 37 + tI + x * 5) & 255];
        let xs = wob > 0.55 ? x + 1 : wob < -0.55 ? x - 1 : x;
        if (xs < 0) xs = 0; else if (xs >= C) xs = C - 1;
        const m = f * (0.62 + 0.38 * SIN[(r * 53 + x * 11 + tJ) & 255]);
        const i = row + x, j = i * 3, q = xs * 3, o = i << 2;
        let vr = lit[j] + reflCol[q] * m, vg = lit[j + 1] + reflCol[q + 1] * m, vb = lit[j + 2] + reflCol[q + 2] * m;
        if (x >= tx0 && x <= tx1) {
          // a taxi passes: headlights first, red tail lights after
          const dx = x - cx, dh = dx + 3, dr = dx - 13;
          const wh = rf / (1 + (dh * dh) / 22), wr = rf / (1 + (dr * dr) / 7);
          vr += 70 * wh + 50 * wr; vg += 62 * wh + 8 * wr; vb += 46 * wh + 10 * wr;
        }
        bg[o] = c8(vr); bg[o + 1] = c8(vg); bg[o + 2] = c8(vb);
      }
    }

    // a distant train crosses between the buildings
    const trp = (t + 22) % 71;
    if (trp < 32) {
      const head = L - 30 + (RB - L + 60) * (trp / 32), j0 = TRAIN * C;
      const gT = G["▪"];
      for (let k = 0; k < 28; k++) {
        const x = Math.floor(head) - k;
        if (x < L || x >= RB || k % 5 === 0) continue;
        const i = j0 + x;
        if (stGlyph[i] >= 0) continue;
        put(grid, i, gT, 235, 210, 160, 0.55 * sideW[x]);
      }
    }

    // rain in two layers; each drop picks up the neon around it
    const gNear = G["│"], gFar = G["╎"];
    for (let i = 0; i < nDrops; i++) {
      dY[i] += dS[i] * dt * speed;
      if (dY[i] >= dLand[i]) {
        if (!dF[i] || rnd() < 0.35) {
          rX[rHead] = dX[i]; rY[rHead] = dLand[i]; rT[rHead] = t;
          rHead = (rHead + 1) % RP;
        }
        spawnDrop(i, false);
        continue;
      }
      const x = dX[i], hr = dY[i] | 0, far = dF[i], len = dL[i];
      const a0 = (far ? 0.42 : 0.72) * sideW[x];
      const lr = far ? 78 : 118, lg = far ? 92 : 136, lb = far ? 138 : 190;
      for (let k = 0; k < len; k++) {
        const r = hr - k;
        if (r < 0 || r >= R) continue;
        const ci = r * C + x;
        if (signMask[ci] || stGlyph[ci] >= 0) continue;
        const o = ci << 2;
        const a = k === 0 ? a0 : k === 1 ? a0 * 0.55 : a0 * 0.3;
        put(grid, ci, far || k === 2 ? gFar : gNear,
          lr + bg[o] * 0.8, lg + bg[o + 1] * 0.8, lb + bg[o + 2] * 0.8, a);
      }
    }

    // ripples where drops hit the street
    const gDot = G["."], gO = G["o"], gDash = G["-"];
    for (let p = 0; p < RP; p++) {
      const a = t - rT[p];
      if (a < 0 || a > 0.6) continue;
      const x = rX[p], r = rY[p];
      if (r < 0 || r >= R) continue;
      const al = (1 - a / 0.6) * 0.7 * sideW[x];
      if (a < 0.3) {
        const ci = r * C + x, o = ci << 2;
        put(grid, ci, a < 0.12 ? gDot : gO, 150 + bg[o] * 0.7, 165 + bg[o + 1] * 0.7, 210 + bg[o + 2] * 0.7, al);
      } else {
        for (let side = -1; side <= 1; side += 2) {
          const xx = x + side;
          if (xx < 0 || xx >= C) continue;
          const ci = r * C + xx, o = ci << 2;
          put(grid, ci, gDash, 150 + bg[o] * 0.7, 165 + bg[o + 1] * 0.7, 210 + bg[o + 2] * 0.7, al);
        }
      }
    }
  },
});
`;
