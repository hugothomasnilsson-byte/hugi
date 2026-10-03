import type { Swatch } from '../types';

/** The ImageData shape (jsdom and workers may lack the ImageData class itself). */
export interface PixelData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

type Rgb = [number, number, number];
type Lab = [number, number, number];

/** Colour families, in a stable display order. */
export const COLOUR_FAMILIES = [
  'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink',
  'brown', 'beige', 'black', 'grey', 'white',
] as const;
export type ColourFamily = (typeof COLOUR_FAMILIES)[number];

/** Families that carry no hue: an image made only of these reads as monochrome. */
export const NEUTRAL_FAMILIES: ReadonlySet<string> = new Set(['black', 'grey', 'white']);

/** Swatches closer than this (CIEDE2000) are treated as the same colour. */
const MERGE_DELTA_E = 10;

/* ------------------------------------------------------------------ */
/* Colour space conversions                                            */
/* ------------------------------------------------------------------ */

const SRGB_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function channel(v: number): number {
  return Number.isFinite(v) ? Math.min(255, Math.max(0, Math.round(v))) : 0;
}

function linear(rgb: Rgb): [number, number, number] {
  return [SRGB_TO_LINEAR[channel(rgb[0])], SRGB_TO_LINEAR[channel(rgb[1])], SRGB_TO_LINEAR[channel(rgb[2])]];
}

const LAB_EPSILON = 216 / 24389;
const LAB_KAPPA = 24389 / 27;

function labF(t: number): number {
  return t > LAB_EPSILON ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116;
}

/** sRGB (0–255) → CIELAB (D65). Channels are rounded to integers first. */
export function rgbToLab(rgb: Rgb): Lab {
  const [r, g, b] = linear(rgb);
  const fx = labF((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const fy = labF(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const fz = labF((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * sRGB (0–255) → OKLCH: lightness 0..1, chroma (≈0..0.32 in sRGB), hue in degrees.
 * OKLab's hue is far more even than CIELAB's (no blue→purple drift), so it is
 * what the family classifier reasons in.
 */
export function rgbToOklch(rgb: Rgb): [number, number, number] {
  const [r, g, b] = linear(rgb);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(A, B);
  let h = (Math.atan2(B, A) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [L, C, C < 1e-6 ? 0 : h];
}

/* ------------------------------------------------------------------ */
/* CIEDE2000                                                           */
/* ------------------------------------------------------------------ */

const DEG = Math.PI / 180;
const POW25_7 = 25 ** 7;

function hueAngle(b: number, a: number): number {
  if (a === 0 && b === 0) return 0;
  const h = Math.atan2(b, a) / DEG;
  return h < 0 ? h + 360 : h;
}

/** CIEDE2000 colour difference between two CIELAB colours (Sharma et al. 2005). */
export function ciede2000(lab1: Lab, lab2: Lab): number {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const cBar7 = cBar ** 7;
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + POW25_7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const h1p = hueAngle(b1, a1p);
  const h2p = hueAngle(b2, a2p);
  const chromaProduct = c1p * c2p;

  const dLp = L2 - L1;
  const dCp = c2p - c1p;
  let dhp = 0;
  if (chromaProduct !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(chromaProduct) * Math.sin((dhp / 2) * DEG);

  const lBarP = (L1 + L2) / 2;
  const cBarP = (c1p + c2p) / 2;
  let hBarP = h1p + h2p;
  if (chromaProduct !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hBarP /= 2;
    else hBarP = hBarP < 360 ? (hBarP + 360) / 2 : (hBarP - 360) / 2;
  }

  const t =
    1 -
    0.17 * Math.cos((hBarP - 30) * DEG) +
    0.24 * Math.cos(2 * hBarP * DEG) +
    0.32 * Math.cos((3 * hBarP + 6) * DEG) -
    0.2 * Math.cos((4 * hBarP - 63) * DEG);
  const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2));
  const cBarP7 = cBarP ** 7;
  const rC = 2 * Math.sqrt(cBarP7 / (cBarP7 + POW25_7));
  const lMid = (lBarP - 50) ** 2;
  const sL = 1 + (0.015 * lMid) / Math.sqrt(20 + lMid);
  const sC = 1 + 0.045 * cBarP;
  const sH = 1 + 0.015 * cBarP * t;
  const rT = -Math.sin(2 * dTheta * DEG) * rC;

  const l = dLp / sL;
  const c = dCp / sC;
  const h = dHp / sH;
  return Math.sqrt(l * l + c * c + h * h + rT * c * h);
}

/*
 * Search compares query colours against every swatch in the library, so the
 * sRGB → Lab step is memoised by packed colour. Bounded so it cannot grow
 * without limit; clearing wholesale is fine because entries are cheap.
 */
const labCache = new Map<number, Lab>();
const LAB_CACHE_LIMIT = 8192;

function cachedLab(rgb: Rgb): Lab {
  const key = (channel(rgb[0]) << 16) | (channel(rgb[1]) << 8) | channel(rgb[2]);
  let lab = labCache.get(key);
  if (!lab) {
    if (labCache.size >= LAB_CACHE_LIMIT) labCache.clear();
    lab = rgbToLab(rgb);
    labCache.set(key, lab);
  }
  return lab;
}

/** Perceptual difference between two sRGB colours (CIEDE2000; ~2 is just noticeable, 10 is clearly different). */
export function deltaE(a: [number, number, number], b: [number, number, number]): number {
  return ciede2000(cachedLab(a), cachedLab(b));
}

/* ------------------------------------------------------------------ */
/* Hex                                                                 */
/* ------------------------------------------------------------------ */

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function hexToRgb(hex: string): [number, number, number] | null {
  if (typeof hex !== 'string') return null;
  const m = HEX_RE.exec(hex.trim());
  if (!m) return null;
  let digits = m[1];
  if (digits.length === 3) digits = digits[0] + digits[0] + digits[1] + digits[1] + digits[2] + digits[2];
  const n = parseInt(digits, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(rgb: [number, number, number]): string {
  return '#' + ((1 << 24) | (channel(rgb[0]) << 16) | (channel(rgb[1]) << 8) | channel(rgb[2])).toString(16).slice(1);
}

/**
 * True when dark text reads better than light text on this colour. Uses WCAG
 * relative luminance; 0.179 is where contrast against black and white is equal.
 */
export function isLight(rgb: [number, number, number]): boolean {
  const [r, g, b] = linear(rgb);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179;
}

/* ------------------------------------------------------------------ */
/* Naming                                                              */
/* ------------------------------------------------------------------ */

/*
 * The curated vocabulary. Every name is filed under the family the classifier
 * assigns to its reference colour (a unit test guards this), so a swatch's
 * name always agrees with its family: searching "blue" finds "cobalt".
 */
const NAMED_COLOURS: Record<ColourFamily, Record<string, string>> = {
  white: { snow: '#fbfbf9', chalk: '#f1f0ea', ivory: '#f6f2e4' },
  grey: {
    mist: '#d9dad7', silver: '#bcbdba', ash: '#a3a29c', stone: '#8a857c',
    pewter: '#7d8384', smoke: '#6c6b69', slate: '#5f6b73', graphite: '#48494b',
  },
  black: { charcoal: '#2c2c2c', ink: '#14151c', jet: '#0b0b0b', soot: '#211e1c' },
  beige: {
    bone: '#e4dccb', linen: '#ebdfc8', cream: '#f3ead0', parchment: '#ece0c2',
    oat: '#ddd0b4', sand: '#d6c4a0', khaki: '#c2b08c',
  },
  brown: {
    taupe: '#8b7d6b', umber: '#5e4636', sienna: '#a0522d', chocolate: '#5a3825',
    walnut: '#6b4a33', coffee: '#6f4e37', chestnut: '#7f4a32', bronze: '#7d5d24',
  },
  red: {
    crimson: '#c21a37', vermilion: '#e0442e', scarlet: '#d0312d', oxblood: '#4f1216',
    carmine: '#9b0f22', brick: '#a63a2a', burgundy: '#741a2c',
  },
  orange: {
    rust: '#b4471c', terracotta: '#c4623f', coral: '#f88a5e', tangerine: '#f28a1c',
    apricot: '#f3a96b', peach: '#f7bf94', copper: '#b8703a', amber: '#e8920e',
  },
  yellow: {
    ochre: '#c9952b', mustard: '#d6a816', saffron: '#f2bf2f', lemon: '#f5e04a',
    butter: '#f4e39a', straw: '#e3d16e', gold: '#d4a92a',
  },
  green: {
    olive: '#717a2e', moss: '#6c7a3c', sage: '#9cab8a', forest: '#2b4d33', emerald: '#2a9d62',
    mint: '#a6dcb8', fern: '#557a46', jade: '#2e9a76', lime: '#a8d43c',
  },
  teal: { teal: '#1e7a78', petrol: '#1d5c66', turquoise: '#3fc7bd', aqua: '#6fd6d4', verdigris: '#4aa59a' },
  blue: {
    cobalt: '#1f4fa8', ultramarine: '#2a3c9e', navy: '#1c2848', cerulean: '#2a7db5', sky: '#8cc4e6',
    azure: '#3d8ee0', indigo: '#2e2f78', denim: '#3b5f8f', powder: '#a9c8e2',
  },
  purple: {
    lavender: '#b7a4dc', lilac: '#c4a3cf', plum: '#6e3366', aubergine: '#3e1c3a',
    violet: '#6f3ad0', mauve: '#b38aa6', amethyst: '#9467c4',
  },
  pink: {
    blush: '#ecc1bd', rose: '#d9809a', magenta: '#d4258a', fuchsia: '#e03ab0',
    flamingo: '#f08aa8', salmon: '#f2a294', raspberry: '#b8285a',
  },
};

interface NamedColour {
  name: string;
  family: ColourFamily;
  rgb: Rgb;
  lab: Lab;
}

const NAMES_BY_FAMILY = new Map<ColourFamily, NamedColour[]>();
for (const family of COLOUR_FAMILIES) {
  NAMES_BY_FAMILY.set(
    family,
    Object.entries(NAMED_COLOURS[family]).map(([name, hex]) => {
      const rgb = hexToRgb(hex)!;
      return { name, family, rgb, lab: rgbToLab(rgb) };
    }),
  );
}

/** The curated named colours with their reference hex values, grouped by family. */
export const NAMED_COLOUR_TABLE: ReadonlyArray<{ name: string; family: ColourFamily; hex: string }> = COLOUR_FAMILIES.flatMap(
  (family) => Object.entries(NAMED_COLOURS[family]).map(([name, hex]) => ({ name, family, hex })),
);

/** Every colour name and family the namer can produce (used for search hints). */
export const COLOUR_WORDS: ReadonlySet<string> = new Set([
  ...COLOUR_FAMILIES,
  ...NAMED_COLOUR_TABLE.map((c) => c.name),
]);

/**
 * Assigns a basic colour family from OKLCH. The thresholds were tuned against
 * the named table and the CSS named colours: neutrals by chroma (bluish greys
 * tolerate more chroma before they read as "blue"), then warm low-chroma
 * colours split into beige (light) and brown (dark), then hue sectors.
 */
export function colourFamily(rgb: [number, number, number]): ColourFamily {
  const [L, C, h] = rgbToOklch(rgb);
  const cool = h >= 180 && h < 300;
  const neutralChroma = cool ? 0.035 : L > 0.9 ? 0.024 : 0.022;

  if (L < 0.2 && C < 0.1) return 'black';
  if (C < neutralChroma || (L < 0.3 && C < 0.04)) return L < 0.33 ? 'black' : L > 0.92 ? 'white' : 'grey';

  if (h >= 15 && h < 112) {
    if (h >= 38 && L >= 0.75 && C < 0.07) return 'beige';
    // Muted yellow-oranges: tan and camel are browns, wheat and buff are beiges.
    if (h >= 62 && h < 100 && C < 0.09) return L >= 0.74 ? 'beige' : 'brown';
    if (h >= 35 && h < 100 && L < 0.75 && C < 0.07) return 'brown';
    if (h >= 35 && h < 75 && L < 0.6 && C < 0.14) return 'brown';
    if (h >= 75 && h < 100 && L < 0.55) return 'brown';
    if (h < 35 && L < 0.75 && C < 0.06) return 'brown';
  }
  if (h >= 15 && h < 38) return L >= 0.78 ? 'pink' : 'red';
  if (h >= 38 && h < 75) return 'orange';
  // Dark, greenish yellows read as olive.
  if (h >= 75 && h < 112) return h >= 100 && L < 0.7 ? 'green' : 'yellow';
  if (h >= 112 && h < 175) return 'green';
  if (h >= 175 && h < 225) return 'teal';
  if (h >= 225 && h < 285) return 'blue';
  // Vivid, light magentas read as pink rather than purple.
  if (h >= 285 && h < 340) return h >= 315 && L >= 0.65 && C >= 0.25 ? 'pink' : 'purple';
  return L < 0.45 ? 'red' : 'pink';
}

export function nameColour(rgb: [number, number, number]): { name: string; family: string } {
  const family = colourFamily(rgb);
  const lab = cachedLab(rgb);
  let best: NamedColour | null = null;
  let bestDistance = Infinity;
  for (const candidate of NAMES_BY_FAMILY.get(family)!) {
    const d = ciede2000(lab, candidate.lab);
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  return { name: best!.name, family };
}

/* ------------------------------------------------------------------ */
/* Palette extraction                                                  */
/* ------------------------------------------------------------------ */

/** A colour cluster: total weight and the weighted mean sRGB colour. */
interface Cluster {
  weight: number;
  rgb: Rgb;
  lab: Lab;
}

/**
 * Agglomerative merge: repeatedly fuses the closest pair of clusters while they
 * are within `threshold` (CIEDE2000). Inputs are small (tens of clusters), so a
 * cached distance matrix keeps this to O(n²) colour differences.
 */
function mergeSimilar(clusters: Cluster[], threshold: number): Cluster[] {
  const n = clusters.length;
  if (n < 2) return clusters.slice();
  const items = clusters.map((c) => ({ ...c, rgb: [...c.rgb] as Rgb }));
  const alive = new Uint8Array(n).fill(1);
  const dist = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) dist[i * n + j] = ciede2000(items[i].lab, items[j].lab);
  }

  for (;;) {
    let bi = -1;
    let bj = -1;
    let best = threshold;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (alive[j] && dist[i * n + j] < best) {
          best = dist[i * n + j];
          bi = i;
          bj = j;
        }
      }
    }
    if (bi < 0) break;

    const a = items[bi];
    const b = items[bj];
    const weight = a.weight + b.weight;
    // Zero-weight clusters (bad stored data) still merge, as a plain average.
    const wa = weight > 0 ? a.weight / weight : 0.5;
    const wb = 1 - wa;
    a.rgb = [a.rgb[0] * wa + b.rgb[0] * wb, a.rgb[1] * wa + b.rgb[1] * wb, a.rgb[2] * wa + b.rgb[2] * wb];
    a.weight = weight;
    a.lab = rgbToLab(a.rgb);
    alive[bj] = 0;
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === bi) continue;
      const d = ciede2000(a.lab, items[k].lab);
      if (k < bi) dist[k * n + bi] = d;
      else dist[bi * n + k] = d;
    }
  }
  return items.filter((_, i) => alive[i]);
}

function toSwatches(clusters: Cluster[], total: number, count: number): Swatch[] {
  return clusters
    .map((c) => ({ rgb: c.rgb.map(channel) as Rgb, weight: total > 0 ? c.weight / total : 0 }))
    .sort((a, b) => b.weight - a.weight || rgbToHex(a.rgb).localeCompare(rgbToHex(b.rgb)))
    .slice(0, Math.max(0, Math.floor(count)))
    .map(({ rgb, weight }) => ({
      hex: rgbToHex(rgb),
      rgb,
      ...nameColour(rgb),
      weight: Math.round(weight * 10000) / 10000,
    }));
}

const BIN_BITS = 5;
const BIN_SHIFT = 8 - BIN_BITS;
const BIN_COUNT = 1 << (3 * BIN_BITS);
/** Clusters smaller than this share of the image are specks, not palette colours. */
const MIN_SHARE = 0.004;
/** Upper bound on pixels visited; larger inputs are sampled on a fixed stride. */
const MAX_SAMPLES = 1 << 18;

/**
 * Dominant colours of an image.
 *
 * 1. Pixels are binned into a 32×32×32 histogram, keeping each bin's exact mean
 *    colour, so clustering works on a few thousand weighted points rather than
 *    every pixel. Pixels are weighted by alpha; fully transparent ones vanish.
 * 2. Weighted k-means in CIELAB with deterministic k-means++ seeding: the first
 *    seed is the heaviest bin, each next seed maximises weight × distance² to the
 *    seeds so far. No randomness, so the same image always gives the same palette.
 * 3. Deliberately over-clusters (count + 4), then merges clusters closer than
 *    ΔE00 10, so a large flat area is not split into near-identical swatches while
 *    small but distinct accents still get a seed of their own.
 *
 * Swatch weights are each colour's share of all (opaque) pixels.
 */
export function extractPalette(img: PixelData, count = 5): Swatch[] {
  const { data } = img;
  const pixels = Math.min(Math.max(0, img.width * img.height) || 0, data.length >> 2);
  if (pixels === 0 || count < 1) return [];

  const weight = new Float64Array(BIN_COUNT);
  const sumR = new Float64Array(BIN_COUNT);
  const sumG = new Float64Array(BIN_COUNT);
  const sumB = new Float64Array(BIN_COUNT);
  const stride = Math.max(1, Math.floor(pixels / MAX_SAMPLES));
  let total = 0;
  for (let p = 0; p < pixels; p += stride) {
    const i = p << 2;
    const a = data[i + 3];
    if (a === 0) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const bin = ((r >> BIN_SHIFT) << (2 * BIN_BITS)) | ((g >> BIN_SHIFT) << BIN_BITS) | (b >> BIN_SHIFT);
    weight[bin] += a;
    sumR[bin] += r * a;
    sumG[bin] += g * a;
    sumB[bin] += b * a;
    total += a;
  }
  if (total === 0) return [];

  // Compact the occupied bins into parallel arrays.
  let n = 0;
  for (let bin = 0; bin < BIN_COUNT; bin++) if (weight[bin] > 0) n++;
  const w = new Float64Array(n);
  const rgb = new Float64Array(n * 3);
  const lab = new Float64Array(n * 3);
  for (let bin = 0, k = 0; bin < BIN_COUNT; bin++) {
    const bw = weight[bin];
    if (bw === 0) continue;
    const mean: Rgb = [sumR[bin] / bw, sumG[bin] / bw, sumB[bin] / bw];
    const l = rgbToLab(mean);
    w[k] = bw;
    rgb.set(mean, k * 3);
    lab.set(l, k * 3);
    k++;
  }

  const k = Math.min(n, Math.floor(count) + 4);
  const centroids = seedCentroids(w, lab, n, k);
  const assignment = lloyd(w, lab, n, centroids);

  const clusterCount = centroids.length / 3;
  const clusters: Cluster[] = [];
  const cw = new Float64Array(clusterCount);
  const cr = new Float64Array(clusterCount);
  const cg = new Float64Array(clusterCount);
  const cb = new Float64Array(clusterCount);
  for (let i = 0; i < n; i++) {
    const c = assignment[i];
    cw[c] += w[i];
    cr[c] += rgb[i * 3] * w[i];
    cg[c] += rgb[i * 3 + 1] * w[i];
    cb[c] += rgb[i * 3 + 2] * w[i];
  }
  for (let c = 0; c < clusterCount; c++) {
    if (cw[c] === 0) continue;
    const mean: Rgb = [cr[c] / cw[c], cg[c] / cw[c], cb[c] / cw[c]];
    clusters.push({ weight: cw[c], rgb: mean, lab: rgbToLab(mean) });
  }

  const merged = mergeSimilar(clusters, MERGE_DELTA_E);
  const significant = merged.filter((c) => c.weight / total >= MIN_SHARE);
  return toSwatches(significant.length > 0 ? significant : merged, total, count);
}

function dist2(lab: Float64Array, i: number, centroids: Float64Array, c: number): number {
  const dl = lab[i * 3] - centroids[c * 3];
  const da = lab[i * 3 + 1] - centroids[c * 3 + 1];
  const db = lab[i * 3 + 2] - centroids[c * 3 + 2];
  return dl * dl + da * da + db * db;
}

/** Deterministic weighted k-means++ seeding (greedy argmax instead of sampling). */
function seedCentroids(w: Float64Array, lab: Float64Array, n: number, k: number): Float64Array {
  const seeds: number[] = [];
  let heaviest = 0;
  for (let i = 1; i < n; i++) if (w[i] > w[heaviest]) heaviest = i;
  seeds.push(heaviest);

  const nearest = new Float64Array(n).fill(Infinity);
  const centroid = new Float64Array(3);
  while (seeds.length < k) {
    const last = seeds[seeds.length - 1];
    centroid.set(lab.subarray(last * 3, last * 3 + 3));
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < n; i++) {
      const d = dist2(lab, i, centroid, 0);
      if (d < nearest[i]) nearest[i] = d;
      const score = w[i] * nearest[i];
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) break; // every remaining point coincides with a seed
    seeds.push(best);
  }

  const centroids = new Float64Array(seeds.length * 3);
  seeds.forEach((s, c) => centroids.set(lab.subarray(s * 3, s * 3 + 3), c * 3));
  return centroids;
}

/** Weighted Lloyd iterations in place; returns each point's cluster index. */
function lloyd(w: Float64Array, lab: Float64Array, n: number, centroids: Float64Array): Int32Array {
  const k = centroids.length / 3;
  const assignment = new Int32Array(n).fill(-1);
  const sums = new Float64Array(k * 4);
  for (let iteration = 0; iteration < 24; iteration++) {
    let changed = false;
    sums.fill(0);
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(lab, i, centroids, c);
        if (d < bestDistance) {
          bestDistance = d;
          best = c;
        }
      }
      if (assignment[i] !== best) {
        assignment[i] = best;
        changed = true;
      }
      const wi = w[i];
      sums[best * 4] += wi;
      sums[best * 4 + 1] += lab[i * 3] * wi;
      sums[best * 4 + 2] += lab[i * 3 + 1] * wi;
      sums[best * 4 + 3] += lab[i * 3 + 2] * wi;
    }
    if (!changed) break;
    for (let c = 0; c < k; c++) {
      const cw = sums[c * 4];
      if (cw === 0) continue; // an emptied cluster keeps its position and stays empty
      centroids[c * 3] = sums[c * 4 + 1] / cw;
      centroids[c * 3 + 1] = sums[c * 4 + 2] / cw;
      centroids[c * 3 + 2] = sums[c * 4 + 3] / cw;
    }
  }
  return assignment;
}

/**
 * Combines the palettes of an entry's images. Each image counts equally
 * (its swatch weights are divided by the number of images), similar colours
 * (ΔE00 < 10) are fused, and the heaviest `count` colours are returned.
 */
export function mergePalettes(palettes: Swatch[][], count = 6): Swatch[] {
  const nonEmpty = palettes.filter((p) => Array.isArray(p) && p.length > 0);
  if (nonEmpty.length === 0 || count < 1) return [];

  const clusters: Cluster[] = [];
  for (const palette of nonEmpty) {
    const paletteTotal = palette.reduce((sum, s) => sum + (s.weight > 0 ? s.weight : 0), 0);
    for (const swatch of palette) {
      const rgb = validRgb(swatch);
      if (!rgb) continue;
      // A palette with no usable weights still counts: its swatches share equally.
      const share = paletteTotal > 0 ? Math.max(0, swatch.weight) : 1 / palette.length;
      clusters.push({ weight: share / nonEmpty.length, rgb, lab: rgbToLab(rgb) });
    }
  }
  return toSwatches(mergeSimilar(clusters, MERGE_DELTA_E), 1, count);
}

function validRgb(swatch: Swatch): Rgb | null {
  const { rgb } = swatch;
  if (Array.isArray(rgb) && rgb.length === 3 && rgb.every((v) => Number.isFinite(v))) {
    return [channel(rgb[0]), channel(rgb[1]), channel(rgb[2])];
  }
  return hexToRgb(swatch.hex);
}
