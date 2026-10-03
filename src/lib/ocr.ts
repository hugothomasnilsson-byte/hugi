/**
 * On-device text recognition with tesseract.js (LSTM engine, English).
 *
 * The engine — worker script, WASM core and language data — is served by the app itself from
 * `tesseract/` (see scripts/copy-ocr-assets.mjs) and precached by the service worker; every URL
 * is given explicitly so tesseract.js never falls back to its CDN defaults, and its IndexedDB
 * cache is disabled because the service worker already keeps the files offline.
 *
 * One worker is created on first use and reused. Jobs run one at a time, in call order.
 */
import type Tesseract from 'tesseract.js';
import { loadImageDataSized } from './images';

export type OcrProgress = (progress: number) => void;

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/** Recognition input: 2400 px on the long edge, or the pixel count of a 2400 × 1800 frame for long,
 *  narrow images (scrolling screenshots) so their text isn't shrunk into illegibility. */
const OCR_MAX_EDGE = 2400;
const OCR_MAX_AREA = 2400 * 1800;
const OCR_ABSOLUTE_MAX_EDGE = 8000;
/** Smaller images (about 1000 × 1000 or less) are upscaled 2× — Tesseract reads small text poorly. */
const OCR_UPSCALE_BELOW_AREA = 1_000_000;
/** Mean luminance below which an image is treated as light-on-dark and inverted. */
const DARK_MEAN = 0.45 * 255;
/** Images whose grey levels span less than this hold nothing to read. */
const MIN_CONTRAST = 24;

/** Lines Tesseract is less sure of than this (0–100) are noise: textures, icons, photo detail. */
const MIN_LINE_CONFIDENCE = 40;
/** Short words without letters or digits ("|", "»", "~") must be at least this confident to stay. */
const MIN_SYMBOL_CONFIDENCE = 60;

/** A job that reports nothing for this long is assumed wedged (e.g. the worker was killed). */
const STALL_TIMEOUT_MS = 90_000;
/** Start-up is silent while each engine file downloads (a 4 MB core, 3 MB of language data). On a
 *  first visit over a slow connection, competing with the service worker's precache, that can take
 *  minutes, so the engine gets longer before it is declared wedged. */
const STARTUP_STALL_TIMEOUT_MS = 300_000;
/** Share of the first job's progress bar spent starting the engine. */
const STARTUP_SHARE = 0.1;
const STARTUP_STAGES: Record<string, [start: number, span: number]> = {
  'loading tesseract core': [0, 0.3],
  'initializing tesseract': [0.3, 0.2],
  'loading language traineddata': [0.5, 0.4],
  'initializing api': [0.9, 0.1],
};

const HAS_ALNUM = /[\p{L}\p{N}]/u;
const LIGATURES: Record<string, string> = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };
const LIGATURE_RE = /[ﬀ-ﬆ]/g;

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

let queueTail: Promise<unknown> = Promise.resolve();

/**
 * Reads the text in an image. Resolves to '' when nothing readable is found; rejects when the
 * image can't be decoded or the engine fails (the engine is then restarted on the next call).
 * `onProgress` receives 0..1 for this job only.
 */
export function recognizeText(blob: Blob, onProgress?: OcrProgress): Promise<string> {
  const run = queueTail.then(() => runJob(blob, onProgress));
  queueTail = run.catch(() => undefined);
  return run;
}

/** Terminates the OCR worker (failing the job in progress, if any). A later call starts a new one. */
export async function disposeOcr(): Promise<void> {
  activeJob?.fail(new Error('Text recognition was stopped'));
  resetEngine();
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

interface ActiveJob {
  id: string;
  /** True when this job is waiting for the engine to start; start-up then counts as progress. */
  coldStart: boolean;
  report(progress: number): void;
  /** Restarts the stall watchdog. */
  touch(): void;
  fail(error: Error): void;
}

let activeJob: ActiveJob | null = null;
let jobCounter = 0;

async function runJob(blob: Blob, onProgress?: OcrProgress): Promise<string> {
  const report = progressReporter(onProgress);
  const image = await prepareForOcr(blob);
  if (!image) {
    report(1);
    return '';
  }

  let failJob!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => (failJob = reject));
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const job: ActiveJob = {
    id: `syble-ocr-${++jobCounter}`,
    coldStart: !engineReady,
    report,
    touch() {
      clearTimeout(watchdog);
      const limit = engineReady ? STALL_TIMEOUT_MS : STARTUP_STALL_TIMEOUT_MS;
      watchdog = setTimeout(() => job.fail(new Error('Text recognition stopped responding')), limit);
    },
    fail: (error) => failJob(error),
  };
  activeJob = job;
  job.touch();

  try {
    const worker = await Promise.race([getEngine(), failed]);
    const result = await Promise.race([
      worker.recognize(image, {}, { text: false, blocks: true }, job.id),
      failed,
    ]);
    report(1);
    return textFromBlocks(result.data.blocks);
  } catch (error) {
    // A failed engine may be wedged or half-dead; start afresh on the next call.
    resetEngine();
    throw asError(error);
  } finally {
    clearTimeout(watchdog);
    if (activeJob === job) activeJob = null;
  }
}

/** Reports monotonic progress in steps of at least 1%, so listeners aren't flooded. */
function progressReporter(onProgress?: OcrProgress): (progress: number) => void {
  let last = 0;
  return (progress) => {
    const value = Math.min(1, Math.max(0, progress));
    if (!onProgress || value <= last || (value < 1 && value - last < 0.01)) return;
    last = value;
    // A faulty listener must not discard finished text or restart a healthy engine.
    try {
      onProgress(value);
    } catch (error) {
      console.error('OCR progress listener failed', error);
    }
  };
}

/** tesseract.js rejects with strings, and with `undefined` when its worker script fails to load. */
function asError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(reason ? `Text recognition failed: ${String(reason)}` : 'Text recognition failed');
}

function onEngineLog(message: Tesseract.LoggerMessage) {
  const job = activeJob;
  if (!job) return;
  job.touch();
  if (message.status === 'recognizing text') {
    if (message.userJobId !== job.id) return;
    const offset = job.coldStart ? STARTUP_SHARE : 0;
    job.report(offset + (1 - offset) * message.progress);
    return;
  }
  const stage = STARTUP_STAGES[message.status];
  if (stage && job.coldStart) job.report(STARTUP_SHARE * (stage[0] + stage[1] * message.progress));
}

/* ------------------------------------------------------------------ */
/* Engine lifecycle                                                    */
/* ------------------------------------------------------------------ */

type TesseractModule = typeof Tesseract;

let engine: Promise<Tesseract.Worker> | null = null;
let engineReady = false;
/** The worker thread, held from the moment it is spawned so even a stalled start-up can be killed. */
let engineThread: Worker | undefined;
/** Bumped on every reset, so a start-up that was abandoned midway doesn't install itself. */
let engineGeneration = 0;

function getEngine(): Promise<Tesseract.Worker> {
  engine ??= startEngine(engineGeneration);
  return engine;
}

function resetEngine() {
  engineGeneration++;
  const pending = engine;
  engine = null;
  engineReady = false;
  engineThread?.terminate();
  engineThread = undefined;
  // Lets the wrapper drop its reference too; a start-up that never finished is already dead.
  pending?.then((worker) => worker.terminate()).catch(() => undefined);
}

async function startEngine(generation: number): Promise<Tesseract.Worker> {
  const tesseract = await loadTesseract();
  if (generation !== engineGeneration) throw new Error('Text recognition was restarted');

  // Absolute URLs from the document's base: the app may be served from a sub-path.
  const asset = (path: string) => new URL(`tesseract/${path}`, document.baseURI).href;
  const options: Partial<Tesseract.WorkerOptions> = {
    workerPath: asset('worker.min.js'),
    // A directory, so the worker picks the fastest core this device supports (relaxed SIMD, SIMD, plain).
    corePath: asset('core'),
    langPath: asset('lang'),
    gzip: true,
    cacheMethod: 'none',
    workerBlobURL: false,
    logger: onEngineLog,
    // Without a handler tesseract.js rethrows worker errors as uncaught exceptions, and a failed
    // start-up would never settle; route them to the job waiting on the engine instead.
    errorHandler: (error: unknown) => activeJob?.fail(new Error(`Text recognition failed: ${String(error)}`)),
  };

  const { result: starting, worker: thread } = captureSpawnedWorker(() =>
    tesseract.createWorker('eng', tesseract.OEM.LSTM_ONLY, options),
  );
  engineThread = thread;
  thread?.addEventListener('error', (event) => {
    if (thread === engineThread) activeJob?.fail(new Error(`Text recognition crashed: ${event.message || 'worker error'}`));
  });

  const worker = await starting;
  // Automatic page segmentation copes with the mixed layouts of screenshots and posters.
  await worker.setParameters({ tessedit_pageseg_mode: tesseract.PSM.AUTO });
  if (generation !== engineGeneration) {
    await worker.terminate();
    throw new Error('Text recognition was restarted');
  }
  engineReady = true;
  return worker;
}

async function loadTesseract(): Promise<TesseractModule> {
  const mod: unknown = await import('tesseract.js');
  // A CommonJS package: depending on the bundler's interop the API is the namespace or its default.
  const api = mod as TesseractModule & { default?: TesseractModule };
  return typeof api.createWorker === 'function' ? api : (api.default as TesseractModule);
}

/**
 * tesseract.js exposes its Web Worker only after start-up succeeds. It constructs it
 * synchronously inside createWorker(), so a momentary subclass of Worker can record it.
 */
function captureSpawnedWorker<T>(start: () => T): { result: T; worker: Worker | undefined } {
  const NativeWorker = globalThis.Worker;
  if (typeof NativeWorker !== 'function') return { result: start(), worker: undefined };
  let spawned: Worker | undefined;
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      spawned = this;
    }
  };
  try {
    return { result: start(), worker: spawned };
  } finally {
    globalThis.Worker = NativeWorker;
  }
}

/* ------------------------------------------------------------------ */
/* Pre-processing                                                      */
/* ------------------------------------------------------------------ */

/** Scale applied to an image of these displayed dimensions before recognition. */
export function ocrScale(width: number, height: number): number {
  const long = Math.max(width, height);
  const area = width * height;
  const limit = Math.min(
    OCR_ABSOLUTE_MAX_EDGE / long,
    Math.max(OCR_MAX_EDGE / long, Math.sqrt(OCR_MAX_AREA / area)),
  );
  return Math.min(area < OCR_UPSCALE_BELOW_AREA ? 2 : 1, limit);
}

/** Decodes, scales and greys an image for Tesseract; null when the image is blank. */
async function prepareForOcr(blob: Blob): Promise<Blob | null> {
  const pixels = await loadImageDataSized(blob, (width, height) => {
    const scale = ocrScale(width, height);
    return { width: width * scale, height: height * scale };
  });
  const grey = toOcrGrey(pixels.data, pixels.width, pixels.height);
  return grey && encodePgm(grey, pixels.width, pixels.height);
}

/**
 * Converts RGBA pixels into the 8-bit grey image Tesseract reads best: dark text on a light
 * ground. Transparent areas are composited onto whichever ground contrasts with the content
 * (so white text on transparency still reads), and predominantly dark images — dark-mode
 * screenshots — are inverted. Returns null when the image is blank.
 */
export function toOcrGrey(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array<ArrayBuffer> | null {
  const count = width * height;
  const grey = new Uint8Array(count);

  // Pass 1: luminance (Rec. 709, integer weights), and the alpha-weighted mean of visible content.
  let contentSum = 0;
  let alphaSum = 0;
  for (let i = 0, p = 0; i < count; i++, p += 4) {
    const lum = (rgba[p] * 54 + rgba[p + 1] * 183 + rgba[p + 2] * 19) >> 8;
    const alpha = rgba[p + 3];
    grey[i] = lum;
    contentSum += lum * alpha;
    alphaSum += alpha;
  }
  if (alphaSum === 0) return null;
  const ground = contentSum / alphaSum < 128 ? 255 : 0;

  // Pass 2: composite onto the ground; gather the range and mean.
  let sum = 0;
  let min = 255;
  let max = 0;
  for (let i = 0, p = 3; i < count; i++, p += 4) {
    const alpha = rgba[p];
    const value = alpha === 255 ? grey[i] : ((grey[i] * alpha + ground * (255 - alpha) + 127) / 255) | 0;
    grey[i] = value;
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (max - min < MIN_CONTRAST) return null;

  if (sum / count < DARK_MEAN) {
    for (let i = 0; i < count; i++) grey[i] = 255 - grey[i];
  }
  return grey;
}

/** Binary PGM: a header and raw grey bytes — no compression step, and Leptonica reads it natively. */
function encodePgm(grey: Uint8Array<ArrayBuffer>, width: number, height: number): Blob {
  const header = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`);
  return new Blob([header, grey], { type: 'image/x-portable-graymap' });
}

/* ------------------------------------------------------------------ */
/* Post-processing                                                     */
/* ------------------------------------------------------------------ */

/** The parts of Tesseract's block tree the text is rebuilt from. */
export interface OcrBlock {
  paragraphs?: Array<{
    lines?: Array<{
      text: string;
      confidence: number;
      words?: Array<{ text: string; confidence: number }>;
    }>;
  }>;
}

/**
 * Rebuilds readable text from Tesseract's blocks, dropping what is probably noise: low-confidence
 * lines, lines without a letter or digit, and stray low-confidence symbols. Lines keep their
 * breaks; paragraphs are separated by a blank line.
 */
export function textFromBlocks(blocks: readonly OcrBlock[] | null | undefined): string {
  const paragraphs: string[] = [];
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      const lines: string[] = [];
      for (const line of paragraph.lines ?? []) {
        const text = cleanLine(line);
        if (text) lines.push(text);
      }
      if (lines.length) paragraphs.push(lines.join('\n'));
    }
  }
  return tidyText(paragraphs.join('\n\n'));
}

function cleanLine(line: NonNullable<NonNullable<OcrBlock['paragraphs']>[number]['lines']>[number]): string {
  if (line.confidence < MIN_LINE_CONFIDENCE) return '';
  const words = line.words?.length
    ? line.words
        .filter((w) => HAS_ALNUM.test(w.text) || w.confidence >= MIN_SYMBOL_CONFIDENCE || w.text.trim().length > 2)
        .map((w) => w.text.trim())
        .filter(Boolean)
    : line.text.trim().split(/\s+/);
  return words.some((w) => HAS_ALNUM.test(w)) ? words.join(' ') : '';
}

/** Expands typographic ligatures (so "ﬁlm" is found by "film"), trims line ends, limits blank lines. */
export function tidyText(text: string): string {
  return text
    .replace(LIGATURE_RE, (c) => LIGATURES[c] ?? c)
    .normalize('NFC')
    .replace(/[ \t ]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
