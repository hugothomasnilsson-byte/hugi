import { describe, expect, it } from 'vitest';
import {
  COLOUR_FAMILIES,
  COLOUR_WORDS,
  NAMED_COLOUR_TABLE,
  ciede2000,
  colourFamily,
  deltaE,
  extractPalette,
  hexToRgb,
  isLight,
  mergePalettes,
  nameColour,
  rgbToHex,
  rgbToLab,
  type PixelData,
} from '../../src/lib/colour';
import type { Swatch } from '../../src/types';

type Rgba = [number, number, number, number?];

/** Builds ImageData-shaped pixels (jsdom has no ImageData constructor). */
function image(width: number, height: number, paint: (x: number, y: number, i: number) => Rgba): PixelData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const [r, g, b, a = 255] = paint(x, y, p);
      data.set([r, g, b, a], p * 4);
    }
  }
  return { data, width, height };
}

const solid = (rgb: [number, number, number], width = 20, height = 20) => image(width, height, () => rgb);

/** Deterministic pseudo-random numbers so fixtures are stable. */
function lcg(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

/** A photo-like scene: sky, foliage and sand bands with sensor noise. */
function scene(width = 200, height = 200): PixelData {
  const rnd = lcg(42);
  return image(width, height, (_x, y) => {
    const n = (rnd() - 0.5) * 30;
    if (y < height * 0.4) return [90 + n, 150 + n, 210 + n];
    if (y < height * 0.7) return [60 + n, 110 + n, 50 + n];
    return [180 + n, 150 + n, 100 + n];
  });
}

function sum(swatches: Swatch[]): number {
  return swatches.reduce((s, w) => s + w.weight, 0);
}

function swatch(hex: string, weight: number): Swatch {
  const rgb = hexToRgb(hex)!;
  return { hex, rgb, ...nameColour(rgb), weight };
}

describe('hexToRgb', () => {
  it('parses long and short forms, with or without "#", in any case', () => {
    expect(hexToRgb('#ffffff')).toEqual([255, 255, 255]);
    expect(hexToRgb('#000')).toEqual([0, 0, 0]);
    expect(hexToRgb('c0392B')).toEqual([192, 57, 43]);
    expect(hexToRgb('#AbC')).toEqual([170, 187, 204]);
    expect(hexToRgb('  #0a0B0c ')).toEqual([10, 11, 12]);
  });

  it('returns null for anything that is not a 3- or 6-digit hex colour', () => {
    for (const bad of ['', '#', '#ff', '#ffff', '#fffff', '#1234567', '#gggggg', 'red', '12 34 56', '##fff']) {
      expect(hexToRgb(bad), bad).toBeNull();
    }
    expect(hexToRgb(undefined as unknown as string)).toBeNull();
  });
});

describe('rgbToHex', () => {
  it('formats lowercase #rrggbb', () => {
    expect(rgbToHex([255, 255, 255])).toBe('#ffffff');
    expect(rgbToHex([0, 0, 0])).toBe('#000000');
    expect(rgbToHex([192, 57, 43])).toBe('#c0392b');
    expect(rgbToHex([1, 2, 3])).toBe('#010203');
  });

  it('rounds and clamps out-of-range or non-finite channels', () => {
    expect(rgbToHex([300, -5, 127.6])).toBe('#ff0080');
    expect(rgbToHex([Number.NaN, Infinity, 0.4])).toBe('#000000');
  });

  it('round-trips with hexToRgb', () => {
    const rnd = lcg(7);
    for (let i = 0; i < 200; i++) {
      const rgb: [number, number, number] = [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)];
      expect(hexToRgb(rgbToHex(rgb))).toEqual(rgb);
    }
  });
});

describe('rgbToLab', () => {
  it('matches reference CIELAB values (D65)', () => {
    const close = (actual: number[], expected: number[]) =>
      actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 1));
    close(rgbToLab([255, 255, 255]), [100, 0, 0]);
    close(rgbToLab([0, 0, 0]), [0, 0, 0]);
    close(rgbToLab([255, 0, 0]), [53.24, 80.09, 67.2]);
    close(rgbToLab([0, 0, 255]), [32.3, 79.19, -107.86]);
  });
});

describe('deltaE (CIEDE2000)', () => {
  // Reference pairs from Sharma, Wu & Dalal (2005), "The CIEDE2000 color-difference formula".
  const sharma: [number[], number[], number][] = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
    [[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
    [[50, -0.001, 2.49], [50, 0.0011, -2.49], 4.7461],
    [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 2.5, 0], [61, -5, 29], 22.8977],
    [[50, 2.5, 0], [56, -27, -3], 31.903],
    [[50, 2.5, 0], [58, 24, 15], 19.4535],
    [[50, 2.5, 0], [50, 3.1736, 0.5854], 1.0],
    [[50, 2.5, 0], [50, 3.2972, 0], 1.0],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
    [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
    [[36.4612, 47.858, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
    [[90.8027, -2.0831, 1.441], [91.1528, -1.6435, 0.0447], 1.4441],
    [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
    [[6.7747, -0.2908, -2.4247], [5.8714, -0.0985, -2.2286], 0.6377],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ];

  it.each(sharma)('matches the published value for %j vs %j', (a, b, expected) => {
    expect(ciede2000(a as [number, number, number], b as [number, number, number])).toBeCloseTo(expected, 4);
    expect(ciede2000(b as [number, number, number], a as [number, number, number])).toBeCloseTo(expected, 4);
  });

  it('is zero for identical colours and symmetric', () => {
    expect(deltaE([12, 200, 99], [12, 200, 99])).toBe(0);
    expect(deltaE([200, 40, 40], [40, 40, 200])).toBeCloseTo(deltaE([40, 40, 200], [200, 40, 40]), 10);
  });

  it('is small for imperceptible changes and large for distinct colours', () => {
    expect(deltaE([255, 0, 0], [253, 2, 2])).toBeLessThan(2);
    expect(deltaE([255, 255, 255], [0, 0, 0])).toBeCloseTo(100, 0);
    expect(deltaE([200, 40, 40], [40, 40, 200])).toBeGreaterThan(30);
  });
});

describe('isLight', () => {
  it('chooses dark text on light colours and light text on dark ones', () => {
    expect(isLight([255, 255, 255])).toBe(true);
    expect(isLight([255, 255, 0])).toBe(true);
    expect(isLight([240, 230, 210])).toBe(true);
    expect(isLight([128, 128, 128])).toBe(true);
    expect(isLight([0, 0, 0])).toBe(false);
    expect(isLight([0, 0, 255])).toBe(false);
    expect(isLight([28, 40, 72])).toBe(false);
    expect(isLight([90, 90, 90])).toBe(false);
  });
});

describe('colour vocabulary', () => {
  it('has a curated list of 60–90 lowercase single-word names', () => {
    expect(NAMED_COLOUR_TABLE.length).toBeGreaterThanOrEqual(60);
    expect(NAMED_COLOUR_TABLE.length).toBeLessThanOrEqual(90);
    const names = NAMED_COLOUR_TABLE.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+$/);
  });

  it('gives every family at least two names', () => {
    for (const family of COLOUR_FAMILIES) {
      expect(NAMED_COLOUR_TABLE.filter((c) => c.family === family).length, family).toBeGreaterThanOrEqual(2);
    }
  });

  it('files every reference colour under the family the classifier gives it', () => {
    for (const { name, family, hex } of NAMED_COLOUR_TABLE) {
      expect(nameColour(hexToRgb(hex)!), `${name} ${hex}`).toEqual({ name, family });
    }
  });

  it('exports all names and families as COLOUR_WORDS', () => {
    for (const family of COLOUR_FAMILIES) expect(COLOUR_WORDS.has(family)).toBe(true);
    for (const { name } of NAMED_COLOUR_TABLE) expect(COLOUR_WORDS.has(name)).toBe(true);
    for (const word of ['ochre', 'slate', 'ivory', 'charcoal', 'ink', 'cobalt', 'oxblood', 'sage', 'terracotta']) {
      expect(COLOUR_WORDS.has(word), word).toBe(true);
    }
    expect(COLOUR_WORDS.size).toBe(new Set([...COLOUR_FAMILIES, ...NAMED_COLOUR_TABLE.map((c) => c.name)]).size);
  });
});

describe('nameColour', () => {
  const cases: [string, string][] = [
    ['#ffffff', 'white'],
    ['#f2f2f2', 'white'],
    ['#000000', 'black'],
    ['#262626', 'black'],
    ['#808080', 'grey'],
    ['#c0c0c0', 'grey'],
    ['#708090', 'grey'],
    ['#ff0000', 'red'],
    ['#800000', 'red'],
    ['#dc143c', 'red'],
    ['#ff8c00', 'orange'],
    ['#d2691e', 'orange'],
    ['#ffff00', 'yellow'],
    ['#ffd700', 'yellow'],
    ['#228b22', 'green'],
    ['#808000', 'green'],
    ['#98fb98', 'green'],
    ['#008080', 'teal'],
    ['#40e0d0', 'teal'],
    ['#0000ff', 'blue'],
    ['#000080', 'blue'],
    ['#87ceeb', 'blue'],
    ['#800080', 'purple'],
    ['#8f00ff', 'purple'],
    ['#ff69b4', 'pink'],
    ['#ffc0cb', 'pink'],
    ['#ff00ff', 'pink'],
    ['#8b4513', 'brown'],
    ['#a0522d', 'brown'],
    ['#8b7d6b', 'brown'],
    ['#f5f5dc', 'beige'],
    ['#d2b48c', 'beige'],
    ['#f5deb3', 'beige'],
  ];

  it.each(cases)('%s belongs to the %s family', (hex, family) => {
    expect(nameColour(hexToRgb(hex)!).family).toBe(family);
  });

  it('only produces known families and names', () => {
    const rnd = lcg(11);
    for (let i = 0; i < 2000; i++) {
      const rgb: [number, number, number] = [rnd() * 255, rnd() * 255, rnd() * 255].map(Math.round) as [number, number, number];
      const { name, family } = nameColour(rgb);
      expect(COLOUR_FAMILIES).toContain(family);
      expect(COLOUR_WORDS.has(name)).toBe(true);
      expect(colourFamily(rgb)).toBe(family);
      expect(NAMED_COLOUR_TABLE.find((c) => c.name === name)!.family).toBe(family);
    }
  });

  it('picks the nearest name within the family', () => {
    expect(nameColour([255, 255, 255]).name).toBe('snow');
    expect(nameColour([8, 8, 8]).name).toBe('jet');
    expect(nameColour([200, 150, 45]).name).toBe('ochre');
    expect(nameColour([30, 80, 168]).name).toBe('cobalt');
    expect(nameColour([30, 122, 120]).name).toBe('teal');
  });
});

describe('extractPalette', () => {
  it('returns nothing for empty or fully transparent images', () => {
    expect(extractPalette({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toEqual([]);
    expect(extractPalette(image(10, 10, () => [255, 0, 0, 0]))).toEqual([]);
  });

  it('returns nothing when asked for no colours', () => {
    expect(extractPalette(solid([10, 20, 30]), 0)).toEqual([]);
  });

  it('describes a solid colour with a single full-weight swatch', () => {
    const palette = extractPalette(solid([200, 40, 40]));
    expect(palette).toEqual([{ hex: '#c82828', rgb: [200, 40, 40], ...nameColour([200, 40, 40]), weight: 1 }]);
  });

  it('handles a single pixel', () => {
    const palette = extractPalette(solid([10, 200, 40], 1, 1));
    expect(palette).toHaveLength(1);
    expect(palette[0].hex).toBe('#0ac828');
    expect(palette[0].weight).toBe(1);
  });

  it('weights colours by their share of pixels, heaviest first', () => {
    const palette = extractPalette(image(100, 100, (x) => (x < 70 ? [20, 60, 160] : [240, 200, 40])));
    expect(palette.map((s) => s.hex)).toEqual(['#143ca0', '#f0c828']);
    expect(palette[0].weight).toBeCloseTo(0.7, 3);
    expect(palette[1].weight).toBeCloseTo(0.3, 3);
  });

  it('ignores fully transparent pixels and weights partial alpha', () => {
    const palette = extractPalette(image(10, 10, (x) => (x < 5 ? [255, 0, 0, 0] : [0, 0, 255, 255])));
    expect(palette).toHaveLength(1);
    expect(palette[0].hex).toBe('#0000ff');
    expect(palette[0].weight).toBe(1);

    const faint = extractPalette(image(10, 10, (x) => (x < 5 ? [255, 0, 0, 85] : [0, 0, 255, 255])));
    expect(faint[0].hex).toBe('#0000ff');
    expect(faint[0].weight).toBeCloseTo(0.75, 3);
    expect(faint[1].weight).toBeCloseTo(0.25, 3);
  });

  it('merges near-duplicate colours into one swatch', () => {
    const palette = extractPalette(image(40, 40, (x, y) => ((x + y) % 2 ? [200, 40, 40] : [206, 44, 38])));
    expect(palette).toHaveLength(1);
    expect(palette[0].weight).toBe(1);
    expect(deltaE(palette[0].rgb, [203, 42, 39])).toBeLessThan(1);
  });

  it('keeps every returned swatch distinct (ΔE00 ≥ 10)', () => {
    for (const palette of [extractPalette(scene()), extractPalette(scene(), 8)]) {
      for (let i = 0; i < palette.length; i++) {
        for (let j = i + 1; j < palette.length; j++) {
          expect(deltaE(palette[i].rgb, palette[j].rgb)).toBeGreaterThanOrEqual(10);
        }
      }
    }
  });

  it('finds the main colours of a noisy photo-like scene', () => {
    const palette = extractPalette(scene());
    expect(palette).toHaveLength(3);
    expect(palette.map((s) => s.family)).toEqual(['blue', 'green', 'brown']);
    expect(palette.map((s) => s.weight)).toEqual([0.4, 0.3, 0.3]);
    expect(deltaE(palette[0].rgb, [90, 150, 210])).toBeLessThan(3);
  });

  it('handles grayscale gradients with neutral swatches only', () => {
    const palette = extractPalette(image(200, 200, (x) => {
      const v = Math.round((x * 255) / 199);
      return [v, v, v];
    }));
    expect(palette.length).toBeGreaterThan(1);
    expect(palette.length).toBeLessThanOrEqual(5);
    for (const s of palette) {
      expect(['black', 'grey', 'white']).toContain(s.family);
      expect(s.rgb[0]).toBe(s.rgb[1]);
      expect(s.rgb[1]).toBe(s.rgb[2]);
    }
    expect(sum(palette)).toBeLessThanOrEqual(1.0001);
    expect(sum(palette)).toBeGreaterThan(0.9);
  });

  it('keeps small accents in screenshots dominated by white', () => {
    const shot = image(200, 200, (x, y) => {
      if (x >= 150 && y >= 180) return [30, 80, 200]; // 2.5% button
      if (y % 10 === 5 && x % 4 !== 0 && x < 140) return [20, 20, 20]; // lines of text
      return [255, 255, 255];
    });
    const palette = extractPalette(shot);
    expect(palette[0]).toMatchObject({ hex: '#ffffff', family: 'white' });
    expect(palette[0].weight).toBeGreaterThan(0.85);
    expect(palette.map((s) => s.family)).toEqual(expect.arrayContaining(['blue', 'black']));
    expect(sum(palette)).toBeCloseTo(1, 3);
  });

  it('drops specks smaller than half a percent', () => {
    const palette = extractPalette(image(100, 100, (_x, _y, i) => (i < 20 ? [255, 0, 0] : [240, 240, 235])));
    expect(palette).toHaveLength(1);
    expect(palette[0].family).toBe('white');
  });

  it('returns at most `count` swatches, sorted by weight', () => {
    const colours: [number, number, number][] = [
      [230, 30, 30], [30, 160, 60], [30, 60, 200], [240, 210, 40],
      [140, 40, 160], [20, 20, 20], [250, 250, 250], [240, 120, 20],
    ];
    const stripes = image(160, 20, (x) => colours[Math.floor(x / 20)]);
    for (const count of [1, 3, 5, 8]) {
      const palette = extractPalette(stripes, count);
      expect(palette).toHaveLength(count);
      for (let i = 1; i < palette.length; i++) expect(palette[i - 1].weight).toBeGreaterThanOrEqual(palette[i].weight);
    }
    expect(extractPalette(stripes, 8).map((s) => s.weight)).toEqual(Array(8).fill(0.125));
  });

  it('produces well-formed swatches', () => {
    for (const s of extractPalette(scene(), 6)) {
      expect(s.hex).toMatch(/^#[0-9a-f]{6}$/);
      expect(hexToRgb(s.hex)).toEqual(s.rgb);
      expect(s.rgb.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)).toBe(true);
      expect({ name: s.name, family: s.family }).toEqual(nameColour(s.rgb));
      expect(s.weight).toBeGreaterThan(0);
      expect(s.weight).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic and independent of pixel order', () => {
    const img = scene(120, 120);
    const first = extractPalette(img);
    expect(extractPalette(img)).toEqual(first);

    // Reverse the pixels: same colours, different layout.
    const reversed = new Uint8ClampedArray(img.data.length);
    for (let p = 0, n = img.data.length / 4; p < n; p++) reversed.set(img.data.subarray(p * 4, p * 4 + 4), (n - 1 - p) * 4);
    expect(extractPalette({ data: reversed, width: img.width, height: img.height })).toEqual(first);
  });

  it('tolerates a data buffer shorter than width × height', () => {
    const data = new Uint8ClampedArray([10, 20, 30, 255]);
    expect(extractPalette({ data, width: 50, height: 50 })).toHaveLength(1);
  });

  it('is fast enough for a 200×200 thumbnail (< 30 ms)', () => {
    const photo = scene();
    const rnd = lcg(3);
    const noise = image(200, 200, () => [rnd() * 255, rnd() * 255, rnd() * 255]);
    extractPalette(photo); // warm up
    const time = (img: PixelData) => {
      const runs: number[] = [];
      for (let i = 0; i < 7; i++) {
        const t = performance.now();
        extractPalette(img);
        runs.push(performance.now() - t);
      }
      return runs.sort((a, b) => a - b)[3];
    };
    expect(time(photo)).toBeLessThan(30);
    // Pure noise is the worst case for the histogram (every bin occupied).
    expect(time(noise)).toBeLessThan(60);
  });
});

describe('mergePalettes', () => {
  it('returns nothing for no palettes', () => {
    expect(mergePalettes([])).toEqual([]);
    expect(mergePalettes([[], []])).toEqual([]);
    expect(mergePalettes([[swatch('#ff0000', 1)]], 0)).toEqual([]);
  });

  it('passes a single palette through', () => {
    const palette = [swatch('#1e50c8', 0.6), swatch('#f0f0f0', 0.4)];
    expect(mergePalettes([palette])).toEqual(palette);
  });

  it('weights each image equally', () => {
    const merged = mergePalettes([[swatch('#c82828', 1)], [swatch('#1e50c8', 0.5), swatch('#fafafa', 0.5)]]);
    expect(merged.map((s) => [s.hex, s.weight])).toEqual([
      ['#c82828', 0.5],
      ['#1e50c8', 0.25],
      ['#fafafa', 0.25],
    ]);
  });

  it('skips empty palettes when weighting', () => {
    const merged = mergePalettes([[], [swatch('#c82828', 1)]]);
    expect(merged).toHaveLength(1);
    expect(merged[0].weight).toBe(1);
  });

  it('merges similar colours across images and renames the result', () => {
    const merged = mergePalettes([[swatch('#c82828', 1)], [swatch('#cc2a26', 1)], [swatch('#1e50c8', 1)]]);
    expect(merged).toHaveLength(2);
    expect(merged[0].weight).toBeCloseTo(2 / 3, 3);
    expect(deltaE(merged[0].rgb, [202, 41, 39])).toBeLessThan(1);
    expect({ name: merged[0].name, family: merged[0].family }).toEqual(nameColour(merged[0].rgb));
    expect(merged[0].hex).toBe(rgbToHex(merged[0].rgb));
  });

  it('returns the heaviest `count` colours', () => {
    const palettes = [
      [swatch('#c82828', 0.5), swatch('#28c850', 0.3), swatch('#2850c8', 0.2)],
      [swatch('#f0c828', 0.6), swatch('#8c28a0', 0.3), swatch('#141414', 0.1)],
    ];
    const merged = mergePalettes(palettes, 3);
    expect(merged.map((s) => s.hex)).toEqual(['#f0c828', '#c82828', '#28c850']);
    expect(mergePalettes(palettes)).toHaveLength(6);
  });

  it('treats a palette without usable weights as equal shares', () => {
    const merged = mergePalettes([[swatch('#c82828', 0), swatch('#1e50c8', 0)]]);
    expect(merged.map((s) => s.weight)).toEqual([0.5, 0.5]);
  });

  it('falls back to the hex when rgb is missing', () => {
    const broken = { ...swatch('#1e50c8', 1), rgb: undefined } as unknown as Swatch;
    expect(mergePalettes([[broken]])[0].rgb).toEqual([30, 80, 200]);
  });
});

describe('review regressions', () => {
  it('mergePalettes treats missing or non-finite weights as zero', () => {
    const blue = swatch('#1f4fa8', 0.5);
    for (const weight of [Number.NaN, undefined, -1, Infinity - Infinity]) {
      const merged = mergePalettes([[blue, { ...swatch('#c82828', 0.5), weight: weight as number }]]);
      expect(merged).toHaveLength(2);
      for (const s of merged) expect(Number.isFinite(s.weight)).toBe(true);
      expect(merged[0]).toMatchObject({ hex: '#1f4fa8', weight: 0.5 });
      expect(merged[1].weight).toBe(0);
    }
  });

  it('extractPalette stays bounded when asked for an absurd number of colours', () => {
    const rnd = lcg(5);
    const noise = image(100, 100, () => [rnd() * 255, rnd() * 255, rnd() * 255]);
    const t = performance.now();
    const palette = extractPalette(noise, Infinity);
    expect(performance.now() - t).toBeLessThan(2000);
    expect(palette.length).toBeGreaterThan(5);
    expect(palette.length).toBeLessThanOrEqual(64);
    for (let i = 1; i < palette.length; i++) expect(palette[i - 1].weight).toBeGreaterThanOrEqual(palette[i].weight);
  });

  it('extractPalette accepts a fractional count', () => {
    const colours: [number, number, number][] = [[230, 30, 30], [30, 160, 60], [30, 60, 200], [240, 210, 40]];
    const stripes = image(80, 10, (x) => colours[Math.floor(x / 20)]);
    expect(extractPalette(stripes, 2.7)).toHaveLength(2);
  });
});
