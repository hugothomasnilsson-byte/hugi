/**
 * In-page half of the OCR / image check (driven by run-ocr-check.mjs). Each case builds its
 * test image on a canvas, runs the real modules and returns plain JSON for the driver to assert.
 */
import { isImageFile, loadImageData, prepareImage, type PreparedImage } from '../../src/lib/images';
import { disposeOcr, recognizeText } from '../../src/lib/ocr';

type Ctx = CanvasRenderingContext2D;

function canvasBlob(width: number, height: number, paint: (ctx: Ctx) => void, type = 'image/png', quality?: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  paint(canvas.getContext('2d')!);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), type, quality),
  );
}

function textScene(opts: { width: number; height: number; bg: string | null; fg: string; font: string; lines: string[]; x?: number; lineHeight: number }) {
  return (ctx: Ctx) => {
    if (opts.bg) {
      ctx.fillStyle = opts.bg;
      ctx.fillRect(0, 0, opts.width, opts.height);
    }
    ctx.fillStyle = opts.fg;
    ctx.font = opts.font;
    ctx.textBaseline = 'top';
    opts.lines.forEach((line, i) => ctx.fillText(line, opts.x ?? 40, 40 + i * opts.lineHeight));
  };
}

/** Coloured pixel noise, standing in for photographs inside a screenshot. */
function noise(ctx: Ctx, x: number, y: number, w: number, h: number, seed: number) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let yy = y; yy < y + h; yy += 4) {
    for (let xx = x; xx < x + w; xx += 4) {
      ctx.fillStyle = `rgb(${(rand() * 255) | 0},${(rand() * 255) | 0},${(rand() * 255) | 0})`;
      ctx.fillRect(xx, yy, 4, 4);
    }
  }
}

function describe(p: PreparedImage) {
  return { width: p.width, height: p.height, mime: p.mime, fullType: p.full.type, fullSize: p.full.size, thumbType: p.thumb.type, thumbSize: p.thumb.size };
}

async function dims(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  const out = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return out;
}

async function ocr(blob: Blob) {
  const progress: number[] = [];
  const started = performance.now();
  const text = await recognizeText(blob, (p) => progress.push(p));
  return { text, ms: Math.round(performance.now() - started), progress };
}

const OCR_SCENES: Record<string, () => Promise<Blob>> = {
  light: () =>
    canvasBlob(1400, 260, textScene({ width: 1400, height: 260, bg: '#ffffff', fg: '#111111', font: '52px sans-serif', lineHeight: 90, lines: ['Syble reads film grain 1987', 'Kodak Portra 400, pushed one stop'] })),
  dark: () =>
    canvasBlob(1400, 260, textScene({ width: 1400, height: 260, bg: '#121212', fg: '#e8e8e8', font: '52px sans-serif', lineHeight: 90, lines: ['Dark mode screenshot', 'Ektar HP5 at dusk 2024'] })),
  small: () =>
    canvasBlob(520, 110, textScene({ width: 520, height: 110, bg: '#fafafa', fg: '#222222', font: '22px sans-serif', lineHeight: 34, x: 20, lines: ['small caption text 42', 'chromogenic print'] })),
  transparent: () =>
    canvasBlob(1200, 200, textScene({ width: 1200, height: 200, bg: null, fg: '#ffffff', font: 'bold 56px sans-serif', lineHeight: 80, lines: ['White on transparent 77'] })),
  blank: () => canvasBlob(800, 600, (ctx) => {
    ctx.fillStyle = '#f2efe8';
    ctx.fillRect(0, 0, 800, 600);
  }),
  screenshot: () =>
    canvasBlob(1280, 900, (ctx) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 1280, 900);
      ctx.fillStyle = '#1d1d1f';
      ctx.fillRect(0, 0, 1280, 70);
      ctx.fillStyle = '#f5f5f7';
      ctx.font = '26px sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText('Archive      Journal      Index', 40, 35);
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#111111';
      ctx.font = 'bold 44px serif';
      ctx.fillText('Notes on film grain', 40, 110);
      ctx.font = '26px serif';
      ctx.fillText('Grain is the visible texture of silver halide', 40, 180);
      ctx.fillText('crystals in a photographic emulsion.', 40, 218);
      noise(ctx, 40, 290, 360, 240, 7);
      noise(ctx, 460, 290, 360, 240, 11);
      noise(ctx, 880, 290, 360, 240, 13);
      ctx.strokeStyle = '#999999';
      ctx.lineWidth = 2;
      for (let i = 0; i < 6; i++) {
        ctx.beginPath();
        ctx.arc(60 + i * 50, 600, 14, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(40, 660);
      ctx.lineTo(1240, 660);
      ctx.stroke();
      ctx.fillStyle = '#666666';
      ctx.font = '20px sans-serif';
      ctx.fillText('Credit: Museum of Photography, 1987', 40, 690);
    }),
  /** Heavy display type: strokes far thicker than body text must not be mistaken for dark ground. */
  poster: () =>
    canvasBlob(1600, 1000, (ctx) => {
      ctx.fillStyle = '#f4efe6';
      ctx.fillRect(0, 0, 1600, 1000);
      ctx.fillStyle = '#0d0d0d';
      ctx.font = '900 210px sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText('BOLD', 60, 60);
      ctx.fillText('MW 1968', 60, 330);
      ctx.font = '34px serif';
      ctx.fillText('Exhibition of modern lettering', 60, 640);
    }),
  /** A light page with a dark band of white text and a dark button: mixed polarity. */
  banner: () =>
    canvasBlob(1200, 800, (ctx) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 1200, 800);
      ctx.fillStyle = '#202024';
      ctx.fillRect(0, 160, 1200, 260);
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#ffffff';
      ctx.font = '48px serif';
      ctx.fillText('Summer exhibition opens', 60, 220);
      ctx.font = '30px sans-serif';
      ctx.fillText('Prints, negatives and contact sheets', 60, 300);
      ctx.fillStyle = '#111111';
      ctx.font = '30px sans-serif';
      ctx.fillText('Tickets are free for members', 60, 60);
      ctx.fillStyle = '#2b4c7e';
      ctx.fillRect(60, 500, 300, 70);
      ctx.fillStyle = '#ffffff';
      ctx.font = '28px sans-serif';
      ctx.fillText('Subscribe', 140, 520);
      ctx.fillStyle = '#333333';
      ctx.font = '26px sans-serif';
      ctx.fillText('Gallery seven, second floor', 60, 640);
    }),
  /** A dark-mode screen with one light card: the inverse of the banner. */
  darkcard: () =>
    canvasBlob(1170, 1400, (ctx) => {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, 1170, 1400);
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#f0f0f0';
      ctx.font = 'bold 54px sans-serif';
      ctx.fillText('Moodboard', 50, 80);
      ctx.font = '36px sans-serif';
      ctx.fillStyle = '#a0a0a0';
      ctx.fillText('Saved yesterday from the archive', 50, 170);
      ctx.fillStyle = '#f7f3ea';
      ctx.fillRect(40, 300, 1090, 520);
      ctx.fillStyle = '#1a1a1a';
      ctx.font = '40px serif';
      ctx.fillText('Cyanotype on cotton paper', 90, 380);
      ctx.fillText('Prussian blue and white', 90, 450);
      noise(ctx, 90, 540, 980, 220, 5);
      ctx.fillStyle = '#e8e8e8';
      ctx.font = '36px sans-serif';
      ctx.fillText('Tap to open the collection', 50, 900);
    }),
  tall: () =>
    canvasBlob(1080, 6000, (ctx) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 1080, 6000);
      ctx.fillStyle = '#111111';
      ctx.font = '40px sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText('Scrolling screenshot opens on chiaroscuro', 40, 80);
      for (let i = 1; i < 9; i++) ctx.fillText(`Section ${i} of the long page`, 40, 80 + i * 650);
      ctx.fillText('The final line reads burnt umber', 40, 5850);
    }),
};

/** A JPEG of four coloured quadrants (raw 400×200) tagged with an EXIF orientation. */
async function orientedJpeg(orientation: number): Promise<Blob> {
  const jpeg = await canvasBlob(400, 200, (ctx) => {
    const quads: Array<[string, number, number]> = [['#e00000', 0, 0], ['#00c000', 200, 0], ['#0000e0', 0, 100], ['#f0e000', 200, 100]];
    for (const [colour, x, y] of quads) {
      ctx.fillStyle = colour;
      ctx.fillRect(x, y, 200, 100);
    }
  }, 'image/jpeg', 0.95);
  const bytes = new Uint8Array(await jpeg.arrayBuffer());
  const exif = new Uint8Array([
    0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0, // APP1 "Exif\0\0"
    0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, // big-endian TIFF header, IFD at 8
    0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, // one entry: Orientation
    0, 0, 0, 0,
  ]);
  return new Blob([bytes.subarray(0, 2), exif, bytes.subarray(2)], { type: 'image/jpeg' });
}

const REFERENCE: Record<string, [number, number, number]> = { red: [224, 0, 0], green: [0, 192, 0], blue: [0, 0, 224], yellow: [240, 224, 0] };

function colourAt(data: ImageData, x: number, y: number): string {
  const i = (y * data.width + x) * 4;
  let best = '';
  let bestDistance = Infinity;
  for (const [name, [r, g, b]] of Object.entries(REFERENCE)) {
    const d = (data.data[i] - r) ** 2 + (data.data[i + 1] - g) ** 2 + (data.data[i + 2] - b) ** 2;
    if (d < bestDistance) [best, bestDistance] = [name, d];
  }
  return best;
}

async function quadrants(blob: Blob) {
  const data = await loadImageData(blob, 400);
  const [w, h] = [data.width, data.height];
  return {
    width: w,
    height: h,
    tl: colourAt(data, Math.round(w / 4), Math.round(h / 4)),
    tr: colourAt(data, Math.round((3 * w) / 4), Math.round(h / 4)),
    bl: colourAt(data, Math.round(w / 4), Math.round((3 * h) / 4)),
    br: colourAt(data, Math.round((3 * w) / 4), Math.round((3 * h) / 4)),
  };
}

const harness = {
  async ocrCase(name: string) {
    const blob = await OCR_SCENES[name]();
    const prepared = await prepareImage(blob);
    return { ...(await ocr(prepared.full)), prepared: describe(prepared) };
  },

  async largePng() {
    const blob = await canvasBlob(6000, 4500, (ctx) => {
      const gradient = ctx.createLinearGradient(0, 0, 6000, 4500);
      gradient.addColorStop(0, '#d9c7a3');
      gradient.addColorStop(1, '#2f4858');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 6000, 4500);
      noise(ctx, 0, 3000, 6000, 1500, 3);
      ctx.fillStyle = '#111111';
      ctx.font = '220px serif';
      ctx.textBaseline = 'top';
      ctx.fillText('Large reference plate', 200, 400);
    });
    const started = performance.now();
    const prepared = await prepareImage(blob);
    return { originalSize: blob.size, ms: Math.round(performance.now() - started), ...describe(prepared), fullDims: await dims(prepared.full), thumbDims: await dims(prepared.thumb) };
  },

  async tallPng() {
    const blob = await OCR_SCENES.tall();
    const prepared = await prepareImage(blob);
    return { originalSize: blob.size, keptOriginal: prepared.full.size === blob.size, ...describe(prepared), thumbDims: await dims(prepared.thumb) };
  },

  async orientation(value: number) {
    const prepared = await prepareImage(await orientedJpeg(value));
    return { ...describe(prepared), full: await quadrants(prepared.full), thumb: await quadrants(prepared.thumb) };
  },

  /** Transparent PNGs: a small one (kept, thumbnail only) and an oversized one (re-encoded). */
  async transparency() {
    const scene = (width: number, height: number) =>
      canvasBlob(width, height, textScene({ width, height, bg: null, fg: '#ffffff', font: 'bold 96px sans-serif', lineHeight: 120, lines: ['Alpha'] }));
    const corner = async (blob: Blob) => {
      const data = await loadImageData(blob, 512);
      return Array.from(data.data.subarray(0, 4));
    };
    const small = await prepareImage(await scene(1200, 300));
    // 18 MP: over both the 4096 px edge and the 4096 × 3072 pixel-count allowance.
    const large = await prepareImage(await scene(6000, 3000));
    return {
      small: { ...describe(small), thumbCorner: await corner(small.thumb) },
      large: { ...describe(large), fullCorner: await corner(large.full), thumbCorner: await corner(large.thumb) },
    };
  },

  /** Several images prepared at once while OCR runs: nothing may fail or deadlock. */
  async parallel() {
    const blobs = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((i) =>
        canvasBlob(2400, 1600, textScene({ width: 2400, height: 1600, bg: '#ffffff', fg: '#111111', font: '80px sans-serif', lineHeight: 120, lines: [`Plate number ${i + 10}`] })),
      ),
    );
    const prepared = await Promise.all(blobs.map((b) => prepareImage(b)));
    const texts = await Promise.all(prepared.slice(0, 3).map((p) => recognizeText(p.full)));
    return { prepared: prepared.map((p) => `${p.width}×${p.height}`), texts };
  },

  async unreadable() {
    const junk = new File([new Uint8Array(4096).fill(7)], 'IMG_0001.HEIC', { type: 'image/heic' });
    try {
      await prepareImage(junk);
      return { error: null };
    } catch (error) {
      return { error: (error as Error).message };
    }
  },

  isImageFile() {
    const cases: Array<[string, string, boolean]> = [
      ['a.png', 'image/png', true],
      ['b.svg', 'image/svg+xml', false],
      ['IMG_1234.HEIC', '', true],
      ['photo.jpg', 'application/octet-stream', true],
      ['notes.txt', 'text/plain', false],
      ['clip.mp4', '', false],
    ];
    return cases.map(([name, type, expected]) => ({ name, type, expected, actual: isImageFile(new File(['x'], name, { type })) }));
  },

  dispose: () => disposeOcr(),
};

declare global {
  interface Window {
    __harness: typeof harness;
    __harnessReady: boolean;
  }
}

window.__harness = harness;
window.__harnessReady = true;
document.getElementById('status')!.textContent = 'Ready';
