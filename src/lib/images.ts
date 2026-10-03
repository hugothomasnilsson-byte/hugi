/**
 * Image intake: decoding (EXIF-aware), size limits, re-encoding and thumbnails.
 *
 * Runs on the main thread. Decoding prefers createImageBitmap and falls back to an <img>
 * element; drawing prefers OffscreenCanvas and falls back to <canvas> (iOS Safari 16.0–16.3
 * has no 2D OffscreenCanvas). Nothing here touches the network.
 */

export interface PreparedImage {
  full: Blob;
  thumb: Blob;
  width: number;
  height: number;
  mime: string;
}

const READ_ERROR = 'Could not read this image';

const JPEG = 'image/jpeg';
const WEBP = 'image/webp';
const WHITE = '#ffffff';

/** Formats every target browser displays natively, so the user's original file is kept as-is. */
const KEEPABLE = new Set([JPEG, 'image/png', WEBP, 'image/gif', 'image/avif']);
/** Formats that can carry transparency; re-encodes of these use WebP (when the browser can
 *  encode it) so transparency survives. Everything else becomes JPEG. */
const MAY_HAVE_ALPHA = new Set(['image/png', WEBP, 'image/gif', 'image/avif', 'image/bmp', 'image/tiff', 'image/jxl', 'image/x-icon']);

/** Larger originals are re-encoded to keep the library (and its backups) a sensible size. */
const MAX_ORIGINAL_BYTES = 12 * 1024 * 1024;
const FULL_QUALITY = 0.92;

/** Stored images are at most 4096 px on the long edge — or, for long and narrow images such as
 *  scrolling screenshots, up to the pixel count of a 4096 × 3072 frame, so their text stays legible. */
const FULL_MAX_EDGE = 4096;
const FULL_MAX_AREA = 4096 * 3072;
/** WebP's dimension limit, and within every browser's canvas limits. */
const ABSOLUTE_MAX_EDGE = 16383;
/** iOS Safari refuses to allocate canvases larger than this many pixels. */
const MAX_CANVAS_AREA = 4096 * 4096;

const THUMB_EDGE = 720;
const THUMB_MAX_EDGE = 4096;
/** Grid cards crop extreme aspect ratios to roughly this range; very long images get a thumbnail
 *  sized so that the visible crop still has THUMB_EDGE pixels, like any ordinary image. */
const THUMB_MIN_RATIO = 0.4;
const THUMB_MAX_RATIO = 2.5;
const THUMB_WEBP_QUALITY = 0.82;
const THUMB_JPEG_QUALITY = 0.85;

/** Enough bytes to cover the APP segments of any JPEG, where EXIF lives. */
const EXIF_SCAN_BYTES = 256 * 1024;

/** A 2×1 px JPEG tagged with EXIF orientation 6 (rotate 90°); decodes to 1×2 when the browser
 *  applies EXIF orientation itself. */
const ORIENTATION_PROBE =
  '/9j/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAFA3PEY8MlBGQUZaVVBfeMiCeG5uePWvuZHI////' +
  '////////////////////////////////////////////////2wBDAVVaWnhpeOuCguv/////////////////////////////' +
  '////////////////////////////////////////////wAARCAABAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAA' +
  'AAT/xAAZEAEAAgMAAAAAAAAAAAAAAAAAAQMzcrH/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAA' +
  'AP/aAAwDAQACEQMRAD8AqpwV6xwAH//Z';

const EXTENSION_TYPES: Record<string, string> = {
  jpg: JPEG,
  jpeg: JPEG,
  jpe: JPEG,
  jfif: JPEG,
  png: 'image/png',
  apng: 'image/png',
  gif: 'image/gif',
  webp: WEBP,
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  hif: 'image/heif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  jxl: 'image/jxl',
  ico: 'image/x-icon',
};

const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']);

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * True for raster images the app can try to read. SVG is refused (it is a document, not a
 * picture of one). Files with an empty or generic type are judged by their extension.
 */
export function isImageFile(f: Blob): boolean {
  const type = f.type.toLowerCase();
  if (type.startsWith('image/')) return !type.startsWith('image/svg');
  if (type && type !== 'application/octet-stream') return false;
  return typeFromName(f) !== '';
}

/**
 * Decodes an image (respecting EXIF orientation) and returns what the library stores: the
 * original file when it is a widely displayable format within the size limits, otherwise a
 * re-encoded copy; plus a thumbnail for grids. `width`/`height` describe `full` as displayed.
 */
export async function prepareImage(file: Blob): Promise<PreparedImage> {
  await acquireDecodeSlot();
  try {
    return await prepare(file);
  } finally {
    releaseDecodeSlot();
  }
}

/** Decodes an image and returns its pixels scaled so the long edge is at most `maxSide`. */
export function loadImageData(blob: Blob, maxSide: number): Promise<ImageData> {
  return loadImageDataSized(blob, (width, height) => {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    return { width: width * scale, height: height * scale };
  });
}

/**
 * Decodes an image and returns its pixels at the size `size` picks from the displayed
 * dimensions (rounded, at least 1 px; may upscale). Transparency is preserved.
 */
export async function loadImageDataSized(
  blob: Blob,
  size: (width: number, height: number) => { width: number; height: number },
): Promise<ImageData> {
  await acquireDecodeSlot();
  try {
    const image = await decode(blob);
    try {
      const target = size(image.width, image.height);
      const width = Math.max(1, Math.round(target.width));
      const height = Math.max(1, Math.round(target.height));
      const surface = render(image, width, height);
      try {
        return surface.ctx.getImageData(0, 0, width, height);
      } finally {
        releaseCanvas(surface.canvas);
      }
    } finally {
      image.release();
    }
  } catch {
    throw unreadable();
  } finally {
    releaseDecodeSlot();
  }
}

/* ------------------------------------------------------------------ */
/* Size rules (exported for tests)                                     */
/* ------------------------------------------------------------------ */

/** Scale (≤ 1) applied to an image of these displayed dimensions before it is stored. */
export function fullImageScale(width: number, height: number): number {
  const long = Math.max(width, height);
  const byEdge = FULL_MAX_EDGE / long;
  const byArea = Math.sqrt(FULL_MAX_AREA / (width * height));
  return Math.min(1, ABSOLUTE_MAX_EDGE / long, Math.max(byEdge, byArea));
}

/** Thumbnail dimensions for an image of these displayed dimensions. */
export function thumbSize(width: number, height: number): { width: number; height: number } {
  const ratio = width / height;
  const visibleWidth = ratio > THUMB_MAX_RATIO ? height * THUMB_MAX_RATIO : width;
  const visibleHeight = ratio < THUMB_MIN_RATIO ? width / THUMB_MIN_RATIO : height;
  const scale = Math.min(
    1,
    THUMB_EDGE / Math.max(visibleWidth, visibleHeight),
    THUMB_MAX_EDGE / Math.max(width, height),
  );
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/* ------------------------------------------------------------------ */
/* Format detection (exported for tests)                               */
/* ------------------------------------------------------------------ */

/** Identifies an image format from its first bytes; '' when unrecognised. */
export function sniffImageType(head: Uint8Array): string {
  const bytesAt = (offset: number, ...expected: number[]) => expected.every((b, i) => head[offset + i] === b);
  const asciiAt = (offset: number, text: string) => bytesAt(offset, ...Array.from(text, (c) => c.charCodeAt(0)));

  if (bytesAt(0, 0xff, 0xd8, 0xff)) return JPEG;
  if (bytesAt(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (asciiAt(0, 'GIF87a') || asciiAt(0, 'GIF89a')) return 'image/gif';
  if (asciiAt(0, 'RIFF') && asciiAt(8, 'WEBP')) return WEBP;
  if (asciiAt(4, 'ftyp')) return isoImageType(head);
  if (bytesAt(0, 0x49, 0x49, 0x2a, 0x00) || bytesAt(0, 0x4d, 0x4d, 0x00, 0x2a)) return 'image/tiff';
  if (bytesAt(0, 0xff, 0x0a) || (bytesAt(0, 0, 0, 0, 0x0c) && asciiAt(4, 'JXL '))) return 'image/jxl';
  if (asciiAt(0, 'BM') && head.length >= 26) return 'image/bmp';
  if (bytesAt(0, 0, 0, 1, 0)) return 'image/x-icon';
  return '';
}

/** HEIF-family files (AVIF, HEIC) are ISO-BMFF containers named by brands in their `ftyp` box. */
function isoImageType(head: Uint8Array): string {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const boxEnd = Math.min(head.length, view.getUint32(0) || head.length);
  const brands: string[] = [];
  // Major brand at 8, minor version at 12, compatible brands from 16.
  for (let at = 8; at + 4 <= boxEnd; at += 4) {
    if (at !== 12) brands.push(String.fromCharCode(...head.subarray(at, at + 4)));
  }
  if (brands.some((b) => b === 'avif' || b === 'avis')) return 'image/avif';
  if (brands.some((b) => HEIC_BRANDS.has(b))) return 'image/heic';
  if (brands.some((b) => b === 'mif1' || b === 'msf1')) return 'image/heif';
  return '';
}

/** Reads the EXIF orientation (1–8) of a JPEG from its leading bytes; 1 when absent. */
export function readJpegOrientation(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return 1;
  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return 1;
    const marker = view.getUint8(offset + 1);
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    // Image data (or its end) starts: EXIF always precedes it.
    if (marker === 0xda || marker === 0xd9) return 1;
    const length = view.getUint16(offset + 2);
    const end = Math.min(view.byteLength, offset + 2 + length);
    const isExif = marker === 0xe1 && offset + 10 <= end && view.getUint32(offset + 4) === 0x45786966 && view.getUint16(offset + 8) === 0;
    if (isExif) return readTiffOrientation(view, offset + 10, end);
    offset += 2 + length;
  }
  return 1;
}

function readTiffOrientation(view: DataView, tiff: number, end: number): number {
  if (tiff + 8 > end) return 1;
  const order = view.getUint16(tiff);
  const little = order === 0x4949;
  if (!little && order !== 0x4d4d) return 1;
  if (view.getUint16(tiff + 2, little) !== 42) return 1;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return 1;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return 1;
    if (view.getUint16(entry, little) === 0x0112) {
      const value = view.getUint16(entry + 8, little);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function typeFromName(f: Blob): string {
  const name = 'name' in f && typeof f.name === 'string' ? f.name : '';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : (EXTENSION_TYPES[name.slice(dot + 1).toLowerCase()] ?? '');
}

/** The type the file claims to be, from its MIME type or else its extension. */
function declaredType(f: Blob): string {
  const type = f.type.toLowerCase().split(';')[0].trim();
  return type.startsWith('image/') ? type : typeFromName(f);
}

/* ------------------------------------------------------------------ */
/* Preparation                                                         */
/* ------------------------------------------------------------------ */

async function prepare(file: Blob): Promise<PreparedImage> {
  const declared = declaredType(file);
  if (declared.startsWith('image/svg')) throw unreadable();

  // Copy the bytes now: a picked file can become unreadable later (Android revokes access to
  // content URIs, iOS cleans up temporary copies) and the entry may be saved minutes from now.
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw unreadable();
  }
  const sniffed = sniffImageType(bytes.subarray(0, 64));
  const mime = sniffed || declared;
  const original = new Blob([bytes], { type: mime });

  const image = await decode(original, bytes).catch(() => {
    throw unreadable();
  });
  try {
    const scale = fullImageScale(image.width, image.height);
    if (KEEPABLE.has(sniffed) && bytes.byteLength <= MAX_ORIGINAL_BYTES && scale >= 1) {
      const thumb = await encodeThumb(image);
      return { full: original, thumb, width: image.width, height: image.height, mime };
    }

    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const keepAlpha = MAY_HAVE_ALPHA.has(mime) && (await canEncodeWebp());
    const surface = render(image, width, height, keepAlpha ? undefined : WHITE);
    try {
      const full = await encode(surface.canvas, keepAlpha ? WEBP : JPEG, FULL_QUALITY);
      // The thumbnail comes from the already-reduced copy: cheaper than going back to the original.
      const thumb = await encodeThumb({ source: surface.canvas, width, height, orientation: 1 });
      return { full, thumb, width, height, mime: full.type };
    } finally {
      releaseCanvas(surface.canvas);
    }
  } catch {
    throw unreadable();
  } finally {
    image.release();
  }
}

async function encodeThumb(image: Drawable): Promise<Blob> {
  const { width, height } = thumbSize(image.width, image.height);
  const webp = await canEncodeWebp();
  // JPEG has no alpha: composite onto white rather than the encoder's default black.
  const surface = render(image, width, height, webp ? undefined : WHITE);
  try {
    return await encode(surface.canvas, webp ? WEBP : JPEG, webp ? THUMB_WEBP_QUALITY : THUMB_JPEG_QUALITY);
  } finally {
    releaseCanvas(surface.canvas);
  }
}

function unreadable() {
  return new Error(READ_ERROR);
}

/* ------------------------------------------------------------------ */
/* Concurrency                                                         */
/* ------------------------------------------------------------------ */

// A decoded photo costs ~4 bytes per pixel (≈190 MB for 48 MP); bounding concurrent decodes
// keeps a batch of camera-roll picks from exhausting a phone's memory.
const MAX_PARALLEL_DECODES = 2;
let activeDecodes = 0;
const waitingDecodes: Array<() => void> = [];

function acquireDecodeSlot(): Promise<void> {
  if (activeDecodes < MAX_PARALLEL_DECODES) {
    activeDecodes++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitingDecodes.push(resolve));
}

/** Hands the slot straight to the next waiter, so a newcomer can't jump the queue. */
function releaseDecodeSlot() {
  const next = waitingDecodes.shift();
  if (next) next();
  else activeDecodes--;
}

/* ------------------------------------------------------------------ */
/* Decoding                                                            */
/* ------------------------------------------------------------------ */

interface Drawable {
  source: CanvasImageSource;
  /** Displayed dimensions, after orientation. */
  width: number;
  height: number;
  /** EXIF orientation still to apply while drawing; 1 when the browser already applied it. */
  orientation: number;
}

interface Decoded extends Drawable {
  release(): void;
}

/** Decodes with EXIF orientation applied — by the browser when it does so, otherwise by us. */
async function decode(blob: Blob, bytes?: Uint8Array): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      // Fall back to <img>: some browsers can't build bitmaps from every format (e.g. HEIC in Safari).
    }
    if (bitmap) {
      const b = bitmap;
      const pending = (await bitmapsApplyExif()) ? 1 : await exifOrientation(blob, bytes);
      return decoded(b, b.width, b.height, pending, () => b.close());
    }
  }
  if (typeof Image === 'function') {
    const img = await loadImageElement(blob);
    if (img) {
      const pending = (await imagesApplyExif()) ? 1 : await exifOrientation(blob, bytes);
      return decoded(img.element, img.element.naturalWidth, img.element.naturalHeight, pending, img.release);
    }
  }
  throw unreadable();
}

function decoded(source: CanvasImageSource, rawWidth: number, rawHeight: number, orientation: number, release: () => void): Decoded {
  if (!rawWidth || !rawHeight) {
    release();
    throw unreadable();
  }
  const swap = orientation >= 5;
  return { source, width: swap ? rawHeight : rawWidth, height: swap ? rawWidth : rawHeight, orientation, release };
}

async function loadImageElement(blob: Blob): Promise<{ element: HTMLImageElement; release: () => void } | null> {
  const url = URL.createObjectURL(blob);
  const element = new Image();
  element.decoding = 'async';
  const release = () => {
    element.removeAttribute('src');
    URL.revokeObjectURL(url);
  };
  const loaded = await new Promise<boolean>((resolve) => {
    element.onload = () => resolve(true);
    element.onerror = () => resolve(false);
    element.src = url;
  });
  if (loaded) return { element, release };
  release();
  return null;
}

async function exifOrientation(blob: Blob, bytes?: Uint8Array): Promise<number> {
  try {
    const head = bytes ?? new Uint8Array(await blob.slice(0, EXIF_SCAN_BYTES).arrayBuffer());
    return readJpegOrientation(head);
  } catch {
    return 1;
  }
}

function probeBlob(): Blob {
  const bytes = Uint8Array.from(atob(ORIENTATION_PROBE), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: JPEG });
}

// Whether each decoding path applies EXIF orientation is detected once, with the probe image.
// (A probe that fails to decode is taken as "applies": every current browser does.)
let bitmapExifProbe: Promise<boolean> | undefined;
let imageExifProbe: Promise<boolean> | undefined;

function bitmapsApplyExif(): Promise<boolean> {
  bitmapExifProbe ??= createImageBitmap(probeBlob(), { imageOrientation: 'from-image' }).then(
    (bitmap) => {
      const applied = bitmap.height > bitmap.width;
      bitmap.close();
      return applied;
    },
    () => true,
  );
  return bitmapExifProbe;
}

function imagesApplyExif(): Promise<boolean> {
  imageExifProbe ??= loadImageElement(probeBlob()).then((img) => {
    if (!img) return true;
    const applied = img.element.naturalHeight > img.element.naturalWidth;
    img.release();
    return applied;
  });
  return imageExifProbe;
}

/* ------------------------------------------------------------------ */
/* Drawing and encoding                                                */
/* ------------------------------------------------------------------ */

type Canvas = OffscreenCanvas | HTMLCanvasElement;
type Context2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

interface Surface {
  canvas: Canvas;
  ctx: Context2D;
}

function createSurface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (ctx) return { canvas, ctx };
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx) return { canvas, ctx };
  }
  throw unreadable();
}

/** Frees a canvas's backing store now rather than at garbage collection (iOS caps the total). */
function releaseCanvas(canvas: Canvas) {
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * Draws `image` at width × height. Large reductions go through successive halvings — each a
 * clean 2×2 average — so downscales stay smooth in browsers whose "high" smoothing is plain
 * bilinear. `background` fills the canvas first (for encoders without alpha).
 */
function render(image: Drawable, width: number, height: number, background?: string): Surface {
  let current: Drawable = image;
  let intermediate: Surface | null = null;
  for (;;) {
    let stepWidth = width;
    let stepHeight = height;
    if (current.width / 2 >= width && current.height / 2 >= height) {
      stepWidth = Math.round(current.width / 2);
      stepHeight = Math.round(current.height / 2);
      const area = stepWidth * stepHeight;
      if (area > MAX_CANVAS_AREA) {
        const shrink = Math.sqrt(MAX_CANVAS_AREA / area);
        stepWidth = Math.max(width, Math.floor(stepWidth * shrink));
        stepHeight = Math.max(height, Math.floor(stepHeight * shrink));
      }
    }
    const final = stepWidth === width && stepHeight === height;
    const surface = drawStep(current, stepWidth, stepHeight, final ? background : undefined);
    if (intermediate) releaseCanvas(intermediate.canvas);
    if (final) return surface;
    intermediate = surface;
    current = { source: surface.canvas, width: stepWidth, height: stepHeight, orientation: 1 };
  }
}

function drawStep(image: Drawable, width: number, height: number, background?: string): Surface {
  const surface = createSurface(width, height);
  const { ctx } = surface;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  applyOrientation(ctx, image.orientation, width, height);
  // Orientations 5–8 rotate by 90°: the source's width runs along the canvas's height.
  const swap = image.orientation >= 5;
  ctx.drawImage(image.source, 0, 0, swap ? height : width, swap ? width : height);
  return surface;
}

/** Sets the transform that maps an un-rotated source onto a width × height (displayed) canvas. */
function applyOrientation(ctx: Context2D, orientation: number, width: number, height: number) {
  switch (orientation) {
    case 2: return ctx.setTransform(-1, 0, 0, 1, width, 0); // mirror horizontally
    case 3: return ctx.setTransform(-1, 0, 0, -1, width, height); // rotate 180°
    case 4: return ctx.setTransform(1, 0, 0, -1, 0, height); // mirror vertically
    case 5: return ctx.setTransform(0, 1, 1, 0, 0, 0); // transpose
    case 6: return ctx.setTransform(0, 1, -1, 0, width, 0); // rotate 90° clockwise
    case 7: return ctx.setTransform(0, -1, -1, 0, width, height); // transverse
    case 8: return ctx.setTransform(0, -1, 1, 0, 0, height); // rotate 90° anticlockwise
    default: return ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}

async function encode(canvas: Canvas, type: string, quality: number): Promise<Blob> {
  const blob =
    'convertToBlob' in canvas
      ? await canvas.convertToBlob({ type, quality })
      : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob || !blob.size) throw unreadable();
  return blob;
}

/** Safari can't encode WebP: asked for it, canvases quietly return PNG instead. */
let webpSupport: Promise<boolean> | undefined;

function canEncodeWebp(): Promise<boolean> {
  webpSupport ??= (async () => {
    try {
      const { canvas } = createSurface(2, 2);
      const blob = await encode(canvas, WEBP, 0.8);
      return blob.type === WEBP;
    } catch {
      return false;
    }
  })();
  return webpSupport;
}
