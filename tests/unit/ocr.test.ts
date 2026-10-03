import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OcrModule from '../../src/lib/ocr';

/* ------------------------------------------------------------------ */
/* Fakes: the image decoder and the tesseract.js engine                */
/* ------------------------------------------------------------------ */

interface FakeThreadLike extends EventTarget {
  terminated: boolean;
}

const fake = vi.hoisted(() => ({
  /** A Tesseract line whose words all share one confidence. */
  line: (text: string, confidence = 95) => ({
    text: `${text}\n`,
    confidence,
    words: text.split(' ').map((w) => ({ text: w, confidence })),
  }),
  /** Pixels the fake decoder returns (RGBA, width × height). */
  pixels: { data: new Uint8ClampedArray(0), width: 0, height: 0 },
  workers: [] as Array<{ terminate: ReturnType<typeof vi.fn> }>,
  options: [] as Array<Record<string, unknown>>,
  active: 0,
  maxActive: 0,
  /** Overrides the next recognize() call. */
  recognizeOnce: null as null | ((jobId: string, logger: (m: Record<string, unknown>) => void) => Promise<unknown>),
  /** Builds a default fake engine (set by the tesseract.js mock). */
  makeWorker: null as unknown as (options: Record<string, unknown>) => unknown,
  /** Worker threads spawned while a fake global Worker is installed. */
  threads: [] as FakeThreadLike[],
  /** Overrides the next createWorker() call. */
  createOnce: null as null | ((options: Record<string, unknown>) => Promise<unknown>),
}));

const LINE = fake.line;

vi.mock('../../src/lib/images', () => ({
  loadImageDataSized: vi.fn(async () => fake.pixels),
}));

vi.mock('tesseract.js', () => {
  function makeWorker(options: Record<string, unknown>) {
    const logger = options.logger as (m: Record<string, unknown>) => void;
    const worker = {
      setParameters: vi.fn(async () => ({})),
      terminate: vi.fn(async () => ({})),
      recognize: vi.fn(async (_image: Blob, _opts: unknown, _output: unknown, jobId: string) => {
        fake.active++;
        fake.maxActive = Math.max(fake.maxActive, fake.active);
        try {
          logger({ status: 'recognizing text', progress: 0.9, userJobId: 'someone-else' });
          logger({ status: 'recognizing text', progress: 0.5, userJobId: jobId });
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (fake.recognizeOnce) {
            const run = fake.recognizeOnce;
            fake.recognizeOnce = null;
            return await run(jobId, logger);
          }
          return { data: { blocks: [{ paragraphs: [{ lines: [fake.line('Syble reads film grain')] }] }] } };
        } finally {
          fake.active--;
        }
      }),
    };
    fake.workers.push(worker);
    return worker;
  }
  fake.makeWorker = makeWorker;

  return {
    OEM: { LSTM_ONLY: 1 },
    PSM: { AUTO: '3' },
    createWorker: vi.fn(async (_langs: string, _oem: number, options: Record<string, unknown>) => {
      // Like tesseract.js, spawn the thread synchronously, before the first await.
      const Thread = (globalThis as unknown as { Worker?: new (url: string) => FakeThreadLike }).Worker;
      if (Thread) fake.threads.push(new Thread(options.workerPath as string));
      fake.options.push(options);
      if (fake.createOnce) {
        const create = fake.createOnce;
        fake.createOnce = null;
        return create(options);
      }
      return makeWorker(options);
    }),
  };
});

/** Opaque RGBA pixels from a per-pixel grey value. */
function greyPixels(width: number, height: number, value: (x: number, y: number) => number, alpha = 255) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data.fill(value(x, y), i, i + 3);
      data[i + 3] = alpha;
    }
  }
  return { data, width, height };
}

/** Light page with a dark stripe of "text". */
const page = () => greyPixels(40, 20, (_x, y) => (y >= 8 && y < 12 ? 20 : 240));

let ocr: typeof OcrModule;

beforeEach(async () => {
  vi.resetModules();
  fake.pixels = page();
  fake.workers = [];
  fake.options = [];
  fake.active = 0;
  fake.maxActive = 0;
  fake.recognizeOnce = null;
  fake.createOnce = null;
  fake.threads = [];
  ocr = await import('../../src/lib/ocr');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A stand-in for the browser's Worker: tesseract.js spawns one per engine. */
class FakeThread extends EventTarget implements FakeThreadLike {
  terminated = false;
  constructor(readonly url: string) {
    super();
  }
  terminate() {
    this.terminated = true;
  }
  postMessage() {}
}

/** Resolves once the fake engine is inside recognize(). */
async function recognising() {
  await vi.waitFor(() => expect(fake.active).toBe(1));
}

const RESULT = (text: string) => ({ data: { blocks: [{ paragraphs: [{ lines: [LINE(text)] }] }] } });

/* ------------------------------------------------------------------ */
/* Engine lifecycle                                                    */
/* ------------------------------------------------------------------ */

describe('recognizeText', () => {
  it('returns the recognised text and reports this job’s progress only', async () => {
    const progress: number[] = [];
    const text = await ocr.recognizeText(new Blob(['x']), (p) => progress.push(p));
    expect(text).toBe('Syble reads film grain');
    // Recognition at 50% after start-up (the first 10%), then done; the other job's 90% is ignored.
    expect(progress).toHaveLength(2);
    expect(progress[0]).toBeCloseTo(0.55);
    expect(progress[1]).toBe(1);
  });

  it('points the engine only at the app’s own files, never a CDN or IndexedDB cache', async () => {
    await ocr.recognizeText(new Blob(['x']));
    const options = fake.options[0];
    const base = document.baseURI;
    expect(options.workerPath).toBe(new URL('tesseract/worker.min.js', base).href);
    expect(options.corePath).toBe(new URL('tesseract/core', base).href);
    expect(options.langPath).toBe(new URL('tesseract/lang', base).href);
    expect(options).toMatchObject({ gzip: true, cacheMethod: 'none', workerBlobURL: false });
  });

  it('creates one worker lazily and runs jobs one at a time', async () => {
    expect(fake.workers).toHaveLength(0);
    const results = await Promise.all([1, 2, 3].map(() => ocr.recognizeText(new Blob(['x']))));
    expect(results).toEqual(['Syble reads film grain', 'Syble reads film grain', 'Syble reads film grain']);
    expect(fake.workers).toHaveLength(1);
    expect(fake.maxActive).toBe(1);
  });

  it('skips the engine for blank images', async () => {
    fake.pixels = greyPixels(30, 30, () => 200);
    await expect(ocr.recognizeText(new Blob(['x']))).resolves.toBe('');
    expect(fake.workers).toHaveLength(0);
  });

  it('restarts the engine after a failure', async () => {
    await ocr.recognizeText(new Blob(['x']));
    fake.recognizeOnce = () => Promise.reject('RuntimeError: Aborted(OOM)');
    await expect(ocr.recognizeText(new Blob(['x']))).rejects.toThrow('Aborted(OOM)');
    expect(fake.workers[0].terminate).toHaveBeenCalled();
    await expect(ocr.recognizeText(new Blob(['x']))).resolves.toBe('Syble reads film grain');
    expect(fake.workers).toHaveLength(2);
  });

  it('fails instead of hanging when the engine can’t start', async () => {
    // tesseract.js never settles createWorker() when loading the language data fails; it only
    // calls the error handler.
    fake.createOnce = (options) => {
      (options.errorHandler as (e: unknown) => void)('Network error while fetching eng.traineddata.gz');
      return new Promise(() => {});
    };
    await expect(ocr.recognizeText(new Blob(['x']))).rejects.toThrow('eng.traineddata.gz');
    await expect(ocr.recognizeText(new Blob(['x']))).resolves.toBe('Syble reads film grain');
  });

  it('gives up on an engine start-up that stops responding', async () => {
    vi.useFakeTimers();
    fake.createOnce = () => new Promise(() => {});
    const pending = ocr.recognizeText(new Blob(['x']));
    const outcome = expect(pending).rejects.toThrow('stopped responding');
    await vi.advanceTimersByTimeAsync(300_000);
    await outcome;
  });

  it('allows a slow start-up minutes of silence (each engine file downloads without progress)', async () => {
    vi.useFakeTimers();
    fake.createOnce = async (options) => {
      await new Promise((resolve) => setTimeout(resolve, 200_000)); // a slow first download
      return fake.makeWorker(options);
    };
    const pending = ocr.recognizeText(new Blob(['x']));
    const outcome = expect(pending).resolves.toBe('Syble reads film grain');
    await vi.advanceTimersByTimeAsync(200_100);
    await outcome;
  });

  it('gives up on a recognition that stops responding', async () => {
    await ocr.recognizeText(new Blob(['x'])); // engine ready
    vi.useFakeTimers();
    fake.recognizeOnce = () => new Promise(() => {});
    const pending = ocr.recognizeText(new Blob(['x']));
    const outcome = expect(pending).rejects.toThrow('stopped responding');
    await vi.advanceTimersByTimeAsync(90_000);
    await outcome;
  });

  it('propagates decoding errors', async () => {
    const images = await import('../../src/lib/images');
    vi.mocked(images.loadImageDataSized).mockRejectedValueOnce(new Error('Could not read this image'));
    await expect(ocr.recognizeText(new Blob(['x']))).rejects.toThrow('Could not read this image');
  });

  it('disposeOcr terminates the worker; the next job starts a new one', async () => {
    await ocr.recognizeText(new Blob(['x']));
    await ocr.disposeOcr();
    expect(fake.workers[0].terminate).toHaveBeenCalled();
    await ocr.recognizeText(new Blob(['x']));
    expect(fake.workers).toHaveLength(2);
  });
});

describe('recognizeText under stress', () => {
  it('fails the running job when the worker thread crashes, then starts afresh', async () => {
    vi.stubGlobal('Worker', FakeThread);
    await ocr.recognizeText(new Blob(['x']));
    fake.recognizeOnce = () => new Promise(() => {}); // wedged by the crash
    const crashed = ocr.recognizeText(new Blob(['x']));
    await recognising();
    fake.threads[0].dispatchEvent(new ErrorEvent('error', { message: 'RuntimeError: memory access out of bounds' }));
    await expect(crashed).rejects.toThrow('memory access out of bounds');
    expect(fake.threads[0].terminated).toBe(true);
    await expect(ocr.recognizeText(new Blob(['x']))).resolves.toBe('Syble reads film grain');
    expect(fake.threads).toHaveLength(2);
  });

  it('ignores errors from a worker thread it has already replaced', async () => {
    vi.stubGlobal('Worker', FakeThread);
    await ocr.recognizeText(new Blob(['x']));
    await ocr.disposeOcr();
    let finish!: () => void;
    fake.recognizeOnce = () => new Promise((resolve) => (finish = () => resolve(RESULT('Second engine'))));
    const job = ocr.recognizeText(new Blob(['x']));
    await recognising();
    fake.threads[0].dispatchEvent(new ErrorEvent('error', { message: 'late error from the old thread' }));
    finish();
    await expect(job).resolves.toBe('Second engine');
  });

  it('disposeOcr fails the running job; jobs queued behind it run on a fresh worker', async () => {
    vi.stubGlobal('Worker', FakeThread);
    fake.recognizeOnce = () => new Promise(() => {});
    const running = ocr.recognizeText(new Blob(['x']));
    const queued = ocr.recognizeText(new Blob(['x']));
    await recognising();
    await ocr.disposeOcr();
    await expect(running).rejects.toThrow('stopped');
    expect(fake.threads[0].terminated).toBe(true);
    await expect(queued).resolves.toBe('Syble reads film grain');
    expect(fake.workers).toHaveLength(2);
  });

  it('a progress listener that throws cannot fail recognition or restart the engine', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const listener = vi.fn(() => {
      throw new Error('listener bug');
    });
    await expect(ocr.recognizeText(new Blob(['x']), listener)).resolves.toBe('Syble reads film grain');
    expect(listener).toHaveBeenCalled();
    await ocr.recognizeText(new Blob(['x']), listener);
    expect(fake.workers).toHaveLength(1);
    expect(fake.workers[0].terminate).not.toHaveBeenCalled();
  });

  it('a blank image with a throwing progress listener still resolves to ""', async () => {
    fake.pixels = greyPixels(30, 30, () => 200);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const listener = () => {
      throw new Error('listener bug');
    };
    await expect(ocr.recognizeText(new Blob(['x']), listener)).resolves.toBe('');
  });

  it('gives a readable error when the engine rejects without a reason', async () => {
    // tesseract.js rejects start-up with `event.message`, which is undefined when the
    // worker script itself fails to load.
    fake.createOnce = () => Promise.reject(undefined);
    const error = await ocr.recognizeText(new Blob(['x'])).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/text recognition/i);
    expect((error as Error).message).not.toMatch(/undefined/);
    await expect(ocr.recognizeText(new Blob(['x']))).resolves.toBe('Syble reads film grain');
  });

  it('spends the first 10% of a cold job on start-up, monotonically', async () => {
    fake.createOnce = async (options) => {
      const log = options.logger as (m: Record<string, unknown>) => void;
      for (const status of ['loading tesseract core', 'initializing tesseract', 'loading language traineddata', 'initializing api']) {
        for (const progress of [0, 0.5, 1]) log({ status, progress, userJobId: 'Job-0-start' });
      }
      return fake.makeWorker(options);
    };
    const progress: number[] = [];
    await ocr.recognizeText(new Blob(['x']), (p) => progress.push(p));
    const startup = progress.filter((p) => p <= 0.1 + 1e-9);
    expect(startup.length).toBeGreaterThanOrEqual(4);
    expect(startup.at(-1)).toBeGreaterThanOrEqual(0.08);
    expect(progress.every((p, i) => i === 0 || p > progress[i - 1])).toBe(true);
    expect(progress.at(-1)).toBe(1);

    // A warm job reports recognition alone, from 0.
    const warm: number[] = [];
    await ocr.recognizeText(new Blob(['x']), (p) => warm.push(p));
    expect(warm[0]).toBeCloseTo(0.5);
  });

  it('keeps a slow job alive for as long as the engine reports progress', async () => {
    vi.useFakeTimers();
    // Five minutes in all, but never more than a minute between progress reports.
    fake.recognizeOnce = async (jobId, log) => {
      for (let i = 1; i <= 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        log({ status: 'recognizing text', progress: 0.5 + i / 12, userJobId: jobId });
      }
      return RESULT('Slow but steady');
    };
    const job = ocr.recognizeText(new Blob(['x']));
    const outcome = expect(job).resolves.toBe('Slow but steady');
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);
    await outcome;
  });
});

/* ------------------------------------------------------------------ */
/* Pre- and post-processing                                            */
/* ------------------------------------------------------------------ */

describe('ocrScale', () => {
  it('upscales small images 2×', () => {
    expect(ocr.ocrScale(800, 600)).toBe(2);
    expect(ocr.ocrScale(1280, 720)).toBe(2);
  });

  it('leaves typical screenshots alone', () => {
    expect(ocr.ocrScale(1170, 2532)).toBe(1);
    expect(ocr.ocrScale(1920, 1080)).toBe(1);
  });

  it('limits photos to 2400 px on the long edge', () => {
    expect(ocr.ocrScale(4032, 3024) * 4032).toBeCloseTo(2400);
  });

  it('keeps long screenshots legible', () => {
    const scale = ocr.ocrScale(1080, 8000);
    expect(scale * 1080).toBeGreaterThan(700);
    expect(scale * 1080 * scale * 8000).toBeLessThanOrEqual(2400 * 1800 + 1);
  });
});

describe('toOcrGrey', () => {
  it('keeps light images as they are', () => {
    const { data, width, height } = page();
    const grey = ocr.toOcrGrey(data, width, height)!;
    expect(grey[0]).toBe(240);
    expect(grey[10 * width]).toBe(20);
  });

  it('inverts predominantly dark images', () => {
    const { data, width, height } = greyPixels(40, 20, (_x, y) => (y >= 8 && y < 12 ? 235 : 18));
    const grey = ocr.toOcrGrey(data, width, height)!;
    expect(grey[0]).toBe(255 - 18);
    expect(grey[10 * width]).toBe(255 - 235);
  });

  it('reads white text on transparency as dark text on light', () => {
    const { data, width, height } = greyPixels(40, 20, (_x, y) => (y >= 8 && y < 12 ? 255 : 0));
    for (let i = 3; i < data.length; i += 4) data[i] = data[i - 1] === 255 ? 255 : 0;
    const grey = ocr.toOcrGrey(data, width, height)!;
    expect(grey[0]).toBe(255);
    expect(grey[10 * width]).toBe(0);
  });

  it('returns null for blank or fully transparent images', () => {
    const flat = greyPixels(10, 10, () => 128);
    expect(ocr.toOcrGrey(flat.data, 10, 10)).toBeNull();
    const clear = greyPixels(10, 10, () => 0, 0);
    expect(ocr.toOcrGrey(clear.data, 10, 10)).toBeNull();
  });
});

describe('textFromBlocks', () => {
  it('keeps confident lines and paragraph breaks', () => {
    const text = ocr.textFromBlocks([
      { paragraphs: [{ lines: [LINE('Notes on film grain'), LINE('Kodak Portra 400')] }, { lines: [LINE('Credit: Museum, 1987')] }] },
      { paragraphs: [{ lines: [LINE('Second block')] }] },
    ]);
    expect(text).toBe('Notes on film grain\nKodak Portra 400\n\nCredit: Museum, 1987\n\nSecond block');
  });

  it('drops low-confidence lines and lines without letters or digits', () => {
    const text = ocr.textFromBlocks([
      { paragraphs: [{ lines: [LINE('OO0OO0O0O0', 4), LINE('— — —', 90), LINE('Real words here')] }] },
      { paragraphs: [{ lines: [LINE('ee ae TE', 25)] }] },
    ]);
    expect(text).toBe('Real words here');
  });

  it('drops stray low-confidence symbols but keeps confident punctuation', () => {
    const line = {
      text: '| Archive — Index »\n',
      confidence: 80,
      words: [
        { text: '|', confidence: 30 },
        { text: 'Archive', confidence: 92 },
        { text: '—', confidence: 88 },
        { text: 'Index', confidence: 90 },
        { text: '»', confidence: 20 },
      ],
    };
    expect(ocr.textFromBlocks([{ paragraphs: [{ lines: [line] }] }])).toBe('Archive — Index');
  });

  it('returns "" when nothing is readable', () => {
    expect(ocr.textFromBlocks(null)).toBe('');
    expect(ocr.textFromBlocks([])).toBe('');
    expect(ocr.textFromBlocks([{ paragraphs: [{ lines: [LINE('~~ ~~', 20)] }] }])).toBe('');
  });
});

describe('tidyText', () => {
  it('expands ligatures so words are searchable', () => {
    expect(ocr.tidyText('ﬁlm ﬂare ofﬁce')).toBe('film flare office');
  });

  it('trims line ends and collapses runs of blank lines', () => {
    expect(ocr.tidyText('  one  \ntwo\t\n\n\n\nthree \n\n')).toBe('one\ntwo\n\nthree');
  });
});
