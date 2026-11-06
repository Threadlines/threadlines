/**
 * The starter themes' art (starters.ts): scripts for the backdrop's draw
 * contract (backdropWorkerPrelude.ts), kept as text because a theme's art is
 * theme content, hashed and shipped as written. They are also the guide's
 * reference art, so each one follows the art rules: calm motion, a seamless
 * loop, its palette taken from the picture, livelier while agents work
 * (`state.working`), a short flourish after a finished turn
 * (`state.sincePulse`), and far under the frame budget.
 */

/** An ASCII night sky: two aurora curtains ripple above a mountain line, stars twinkle. */
export const AURORA_ART = String.raw`// Aurora: an ASCII night sky. Glyph indices: 0 " " 1 "." 2 "·" 3 ":" 4 ";" 5 "+" 6 "=" 7 "x" 8 "X" 9 "%" 10 "#" 11 "^" 12 "A" 13 "*" 14 "-" 15 "/" 16 "\"
let cols = 0, rows = 0, noise, ground, edge1, edge2, rays1, rays2, calm, boost;
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
    const t = info.t + 40, state = info.state;
    // Agents at work quicken the rays; a finished turn sends a bright wave along the curtains.
    const speed = state.working > 0 ? 1.8 : 1;
    const front = state.sincePulse * 0.6 - 0.1;
    for (let i = 0; i < cols; i++) {
      const x = i / cols;
      edge1[i] = 0.34 + 0.07 * Math.sin(x * 4.6 + 1.2 + t * 0.045) + 0.03 * Math.sin(x * 15 - t * 0.1);
      edge2[i] = 0.52 + 0.05 * Math.sin(x * 3.7 + 3.1 - t * 0.04) + 0.025 * Math.sin(x * 12 + 1 + t * 0.08);
      const r1 = 0.5 + 0.5 * Math.sin(x * 88 + Math.sin(x * 7 + t * 0.21) * 5 + t * 0.35 * speed);
      const r2 = 0.5 + 0.5 * Math.sin(x * 61 + 2 + Math.sin(x * 5 - t * 0.17) * 4 - t * 0.3 * speed);
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
let cols = 0, rows = 0, baseGlyph, baseFg, baseBg, flakes, count = 0, groundTop = 0;
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
    // Heavier, quicker snow while agents work; a finished turn sends a sparkling gust.
    const fall = state.working > 0 ? 1.7 : 1;
    const gust = state.pulse;
    const glyph = grid.glyph, fg = grid.fg;
    const visible = state.working > 0 ? count : Math.round(count * 0.65);
    for (let f = 0; f < count; f++) {
      const p = f * 5, size = flakes[p + 4];
      flakes[p + 1] += flakes[p + 2] * dt * fall * (1 + gust);
      flakes[p] += (Math.sin(t * 0.6 + flakes[p + 3]) * 0.3 + gust * 9 * (0.4 + size)) * dt;
      if (flakes[p + 1] >= groundTop) { flakes[p + 1] -= groundTop; flakes[p] = hash(f, t) * cols; }
      if (flakes[p] >= cols) flakes[p] -= cols;
      if (flakes[p] < 0) flakes[p] += cols;
      if (f >= visible) continue;
      const i = Math.floor(flakes[p]), j = Math.floor(flakes[p + 1]);
      const k = j * cols + i, o = k * 4;
      if (baseGlyph[k] >= 0 && baseBg[o + 3] > 0) continue;
      glyph[k] = gust > 0.4 && size > 0.5 ? 3 : size > 0.85 ? 3 : size > 0.45 ? 2 : 1;
      fg[o] = 112; fg[o + 1] = 138; fg[o + 2] = 170; fg[o + 3] = 110 + 120 * size;
    }
  },
});
`;

/** Painted dunes under a low sun; wind combs streaks of sand across them. */
export const DUNES_ART = String.raw`// Dunes: painted dunes and wind, drawn small and scaled up smoothly.
let W = 0, H = 0, sky, ramps, ridges, grain;
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
    const t = info.t + 40, state = info.state;
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
    // Wind: soft streaks combing across the dunes. Stronger while agents work; a gust after a finished turn.
    const wind = state.working > 0 ? 1.6 : 1;
    const gust = state.pulse;
    const streaks = (state.working > 0 ? 34 : 22) + Math.round(gust * 16);
    for (let s = 0; s < streaks; s++) {
      const y0 = H * (0.16 + 0.72 * hash(s, 3)), length = (34 + 60 * hash(s, 5)) * W / 360;
      const travel = W + length * 2, pace = (10 + 16 * hash(s, 7)) * wind * (1 + gust * 2.5);
      const x0 = ((hash(s, 9) * travel + t * pace) % travel) - length;
      const alpha = (0.22 + 0.25 * hash(s, 4)) * (1 + gust * 0.8);
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
let W = 0, H = 0, base, sparks, bed, lastPulse = 1e9;
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
    // Sparks rise, sway and cool; more of them, a little faster, while agents work.
    const active = state.working > 0 ? BUSY : CALM;
    const lift = state.working > 0 ? 1.4 : 1;
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
      if (n >= active && n < BUSY) continue;
      const color = heatColor(Math.max(0, s.heat));
      const x = s.x | 0, y = s.y | 0, glow = Math.min(1, s.heat * 1.4);
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
