#!/usr/bin/env node
/**
 * Real-browser check of on-device OCR and image preparation.
 *
 *   node tests/ocr/run-ocr-check.mjs           # against the Vite dev server
 *   node tests/ocr/run-ocr-check.mjs --build   # against a production build (vite build + preview)
 *
 * Serves the project with Vite, opens tests/ocr/ocr-harness.html in Chromium with every
 * non-localhost request blocked (and a dead proxy as a second net), then asserts that text
 * drawn on canvases is recognised, that images are sized and oriented correctly, and that no
 * request ever left the machine. Set CHROMIUM_PATH to use a specific Chromium binary.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { build, createServer, preview } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 5179;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

let failures = 0;
function check(ok, label, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

const words = (text) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
function expectWords(label, text, expectation) {
  const [required, optional = []] = expectation.split('|').map((part) => part.trim().split(/\s+/).filter(Boolean));
  const found = words(text);
  const missing = required.filter((w) => !found.has(w));
  const bonus = optional.filter((w) => found.has(w));
  const extra = optional.length ? `; best-effort ${bonus.length}/${optional.length}${bonus.length < optional.length ? ` (missed: ${optional.filter((w) => !found.has(w)).join(', ')})` : ''}` : '';
  check(missing.length === 0, label, (missing.length ? `missing: ${missing.join(', ')}` : `${required.length} words found`) + extra);
}

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  for (const candidate of ['/opt/pw-browsers/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome']) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined; // Playwright's own download
}

if (!existsSync(join(root, 'public', 'tesseract', 'lang', 'eng.traineddata.gz'))) {
  execFileSync(process.execPath, [join(root, 'scripts', 'copy-ocr-assets.mjs')], { stdio: 'inherit' });
}

const production = process.argv.includes('--build');
const configFile = join(root, 'vite.config.ts');
const serverOptions = { host: '127.0.0.1', port: PORT, strictPort: true };
let outDir;
let server;
if (production) {
  // The production bundle handles the CommonJS engine package differently from the dev server.
  outDir = mkdtempSync(join(tmpdir(), 'syble-ocr-'));
  await build({ root, configFile, logLevel: 'warn', build: { outDir, emptyOutDir: true, rollupOptions: { input: join(root, 'tests', 'ocr', 'ocr-harness.html') } } });
  server = await preview({ root, configFile, logLevel: 'warn', build: { outDir }, preview: serverOptions });
} else {
  server = await createServer({
    root,
    configFile,
    logLevel: 'warn',
    server: serverOptions,
    // The harness page isn't an app entry, so name the lazily imported engine up front:
    // discovering it mid-run would make Vite reload the page.
    optimizeDeps: { include: ['tesseract.js'] },
  });
  await server.listen();
}
console.log(`Serving ${production ? 'a production build' : 'the dev server'} at ${ORIGIN}\n`);

const browser = await chromium.launch({
  executablePath: chromiumPath(),
  // Anything that slipped past request routing would go to a proxy that doesn't exist.
  proxy: { server: 'http://127.0.0.1:9', bypass: '127.0.0.1,localhost,[::1]' },
});

const requested = new Set();
const blocked = [];
const failed = [];

/** Opens the harness in a fresh context; `init` runs before any page script (to simulate browsers). */
async function openHarness(init) {
  const context = await browser.newContext();
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (LOCAL_HOSTS.has(url.hostname)) return route.continue();
    blocked.push(url.href);
    return route.abort('blockedbyclient');
  });
  context.on('request', (request) => requested.add(request.url()));
  context.on('requestfailed', (request) => {
    if (!LOCAL_HOSTS.has(new URL(request.url()).hostname)) failed.push(request.url());
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log(`  [page error] ${error.message}`));
  if (init) await page.addInitScript(init);
  await page.goto(`${ORIGIN}/tests/ocr/ocr-harness.html`);
  await page.waitForFunction(() => window.__harnessReady === true, null, { timeout: 120_000 });
  return { page, context };
}

// Words that must be recognised, and (after "|") words reported but not required. Tesseract
// reads mixed-polarity details (light text on a small dark bar or button inside a light image)
// and text crowded by heavy display type only some of the time.
const OCR_EXPECTATIONS = {
  light: 'syble reads film grain 1987 kodak portra 400 pushed one stop',
  dark: 'dark mode screenshot ektar hp5 at dusk 2024',
  small: 'small caption text 42 chromogenic print',
  transparent: 'white on transparent 77',
  screenshot: 'archive index notes on film grain silver halide crystals photographic emulsion credit museum photography 1987 | journal',
  poster: 'bold mw 1968 of modern lettering | exhibition',
  banner: 'tickets are free for members summer exhibition opens prints negatives and contact sheets gallery seven second floor | subscribe',
  darkcard: 'moodboard saved yesterday from the archive cyanotype on cotton paper prussian blue and white tap to open collection',
  tall: 'scrolling screenshot chiaroscuro section final line reads burnt umber',
};

// Displayed quadrant colours for a raw [red green / blue yellow] image under each EXIF orientation.
const ORIENTATIONS = {
  1: { width: 400, height: 200, tl: 'red', tr: 'green', bl: 'blue', br: 'yellow' },
  2: { width: 400, height: 200, tl: 'green', tr: 'red', bl: 'yellow', br: 'blue' },
  3: { width: 400, height: 200, tl: 'yellow', tr: 'blue', bl: 'green', br: 'red' },
  4: { width: 400, height: 200, tl: 'blue', tr: 'yellow', bl: 'red', br: 'green' },
  5: { width: 200, height: 400, tl: 'red', tr: 'blue', bl: 'green', br: 'yellow' },
  6: { width: 200, height: 400, tl: 'blue', tr: 'red', bl: 'yellow', br: 'green' },
  7: { width: 200, height: 400, tl: 'yellow', tr: 'green', bl: 'blue', br: 'red' },
  8: { width: 200, height: 400, tl: 'green', tr: 'yellow', bl: 'red', br: 'blue' },
};

const isWhite = (rgba) => rgba[0] >= 250 && rgba[1] >= 250 && rgba[2] >= 250 && rgba[3] === 255;
const isClear = (rgba) => rgba[3] === 0;

/** Transparent sources: WebP keeps alpha; JPEG (when WebP can't be encoded) sits on white. */
async function checkTransparency(page, label, webp) {
  const t = await page.evaluate(() => window.__harness.transparency());
  const ground = webp ? isClear : isWhite;
  const want = webp ? 'image/webp' : 'image/jpeg';
  check(t.small.fullType === 'image/png' && t.small.thumbType === want && ground(t.small.thumbCorner), `${label}: small transparent PNG kept, thumbnail ${want} on ${webp ? 'transparency' : 'white'}`, `full ${t.small.fullType}, thumb ${t.small.thumbType} corner ${t.small.thumbCorner}`);
  check(
    t.large.fullType === want && t.large.mime === want && ground(t.large.fullCorner) && ground(t.large.thumbCorner) && t.large.width < 6000 && t.large.width * t.large.height <= 4096 * 3072 * 1.001,
    `${label}: oversized transparent PNG re-encoded as ${want}`,
    `${t.large.width}×${t.large.height} ${t.large.fullType}, corners full ${t.large.fullCorner} thumb ${t.large.thumbCorner}`,
  );
}

async function checkOrientations(page, label) {
  for (const [value, want] of Object.entries(ORIENTATIONS)) {
    const got = await page.evaluate((v) => window.__harness.orientation(v), Number(value));
    const sameLayout = (q) => q.tl === want.tl && q.tr === want.tr && q.bl === want.bl && q.br === want.br;
    check(
      got.width === want.width && got.height === want.height && sameLayout(got.full) && sameLayout(got.thumb),
      `${label}: EXIF orientation ${value}`,
      `${got.width}×${got.height}, full ${got.full.tl}/${got.full.tr}/${got.full.bl}/${got.full.br}, thumb ${got.thumb.width}×${got.thumb.height} ${got.thumb.tl}/${got.thumb.tr}/${got.thumb.bl}/${got.thumb.br}`,
    );
  }
}

async function checkOcr(page, name, label = name) {
  const result = await page.evaluate((n) => window.__harness.ocrCase(n), name);
  console.log(`\n  [${label}] ${result.ms} ms, ${result.prepared.width}×${result.prepared.height} ${result.prepared.mime}`);
  console.log(`  ${JSON.stringify(result.text)}`);
  const expected = OCR_EXPECTATIONS[name];
  if (expected) expectWords(`${label}: recognised`, result.text, expected);
  else check(result.text === '', `${label}: nothing recognised`, JSON.stringify(result.text));
  const p = result.progress;
  const monotonic = p.every((v, i) => i === 0 || v > p[i - 1]);
  check(p.length > 0 && monotonic && p.at(-1) === 1 && p.every((v) => v >= 0 && v <= 1), `${label}: progress 0..1, monotonic, ends at 1`, `${p.length} updates`);
  return result;
}

try {
  console.log('Native Chromium');
  const { page, context } = await openHarness();

  for (const name of ['light', 'dark', 'small', 'transparent', 'screenshot', 'poster', 'banner', 'darkcard', 'tall', 'blank']) await checkOcr(page, name);
  console.log('');

  const large = await page.evaluate(() => window.__harness.largePng());
  check(
    large.width === 4096 && large.height === 3072 && large.fullDims.width === 4096 && large.fullDims.height === 3072,
    'large PNG (6000×4500) re-encoded to 4096×3072',
    `${large.fullType}, ${(large.originalSize / 1e6).toFixed(1)} MB → ${(large.fullSize / 1e6).toFixed(1)} MB in ${large.ms} ms`,
  );
  check(large.thumbType === 'image/webp' && large.thumbDims.width === 720 && large.thumbDims.height === 540, 'large PNG thumbnail is 720×540 WebP', `${large.thumbDims.width}×${large.thumbDims.height}, ${(large.thumbSize / 1e3).toFixed(0)} kB`);

  const tall = await page.evaluate(() => window.__harness.tallPng());
  check(tall.keptOriginal && tall.mime === 'image/png' && tall.width === 1080 && tall.height === 6000, 'tall screenshot (1080×6000) kept as the original PNG', `${tall.width}×${tall.height} ${tall.mime}`);
  check(tall.thumbDims.width === 288 && tall.thumbDims.height === 1600, 'tall screenshot thumbnail keeps a legible width', `${tall.thumbDims.width}×${tall.thumbDims.height}`);

  await checkOrientations(page, 'createImageBitmap');
  await checkTransparency(page, 'native', true);

  const parallel = await page.evaluate(() => window.__harness.parallel());
  check(
    parallel.prepared.every((d) => d === '2400×1600') && parallel.texts.every((t, i) => words(t).has(String(i + 10))),
    'six images prepared in parallel while OCR runs',
    JSON.stringify(parallel.texts),
  );

  const unreadable = await page.evaluate(() => window.__harness.unreadable());
  check(unreadable.error === 'Could not read this image', 'undecodable file rejected with a friendly error', String(unreadable.error));

  const types = await page.evaluate(() => window.__harness.isImageFile());
  const wrong = types.filter((t) => t.actual !== t.expected);
  check(wrong.length === 0, 'isImageFile', wrong.length ? JSON.stringify(wrong) : `${types.length} cases`);

  await page.evaluate(() => window.__harness.dispose());
  await checkOcr(page, 'light', 'light (after disposeOcr)');
  await context.close();

  console.log('\nBrowser that decodes bitmaps without applying EXIF orientation (simulated)');
  {
    const { page, context } = await openHarness(() => {
      const native = window.createImageBitmap.bind(window);
      // Rewrites any EXIF Orientation tag in a JPEG to 1 before decoding.
      const strip = async (blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return blob;
        for (let i = 0; i + 10 < Math.min(bytes.length, 65536); i++) {
          if (bytes[i] === 0x01 && bytes[i + 1] === 0x12 && bytes[i + 2] === 0 && bytes[i + 3] === 3) [bytes[i + 8], bytes[i + 9]] = [0, 1];
          else if (bytes[i] === 0x12 && bytes[i + 1] === 0x01 && bytes[i + 2] === 3 && bytes[i + 3] === 0) [bytes[i + 8], bytes[i + 9]] = [1, 0];
        }
        return new Blob([bytes], { type: blob.type });
      };
      window.createImageBitmap = async (source, ...rest) => native(source instanceof Blob ? await strip(source) : source, ...rest);
    });
    await checkOrientations(page, 'manual orientation');
    await context.close();
  }

  console.log('\nBrowser without createImageBitmap (simulated): <img> fallback');
  {
    const { page, context } = await openHarness(() => {
      delete window.createImageBitmap;
      window.createImageBitmap = undefined;
    });
    // The harness itself measures thumbnails with createImageBitmap, so only orientation + OCR here.
    await checkOrientations(page, '<img> fallback');
    await checkOcr(page, 'dark', 'dark (<img> fallback)');
    await context.close();
  }

  console.log('\nSafari-like browser (simulated): no WebP encoding, no OffscreenCanvas, imageOrientation "from-image" rejected');
  {
    const { page, context } = await openHarness(() => {
      // Safari can't encode WebP: canvases quietly hand back PNG instead.
      const toBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
        return toBlob.call(this, callback, type === 'image/webp' ? 'image/png' : type, quality);
      };
      // Safari before 16.4 has no 2D OffscreenCanvas.
      delete window.OffscreenCanvas;
      window.OffscreenCanvas = undefined;
      // Browsers predating the "from-image" enum value reject it with a TypeError.
      const native = window.createImageBitmap.bind(window);
      window.createImageBitmap = (source, ...rest) => {
        const options = rest.length >= 4 ? rest[4] : rest[0];
        if (options && options.imageOrientation === 'from-image') {
          return Promise.reject(new TypeError("The provided value 'from-image' is not a valid enum value"));
        }
        return native(source, ...rest);
      };
    });
    await checkOrientations(page, 'Safari-like');
    await checkTransparency(page, 'Safari-like', false);
    await checkOcr(page, 'dark', 'dark (Safari-like)');
    await context.close();
  }

  console.log('\nNetwork');
  const engine = [...requested].filter((u) => u.includes('/tesseract/')).map((u) => new URL(u).pathname);
  console.log(`  engine assets loaded: ${[...new Set(engine)].join(', ')}`);
  check(engine.some((p) => p.endsWith('.traineddata.gz')) && engine.some((p) => p.includes('/core/')), 'engine assets were fetched from this server (and the request log sees worker requests)');
  const external = [...requested].filter((u) => /^https?:/.test(u) && !LOCAL_HOSTS.has(new URL(u).hostname));
  check(external.length === 0 && blocked.length === 0 && failed.length === 0, 'no request left localhost', [...external, ...blocked, ...failed].join(', '));
} finally {
  await browser.close();
  await server.close();
  if (outDir) rmSync(outDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
