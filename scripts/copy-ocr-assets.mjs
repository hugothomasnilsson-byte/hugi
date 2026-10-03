// Copies the on-device OCR engine (tesseract.js worker, WASM core and English
// language data) into public/tesseract so the app never fetches them online.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = dirname(dirname(new URL(import.meta.url).pathname));
const out = join(root, 'public', 'tesseract');
const pkgDir = (name) => dirname(require.resolve(`${name}/package.json`));

const tesseract = pkgDir('tesseract.js');
const core = pkgDir('tesseract.js-core');
// English is always bundled; the others are optional and fetched from the app's
// own origin only when the user turns them on (see src/lib/ocrLanguages.ts).
const LANGS = ['eng', 'swe', 'deu', 'fra', 'spa', 'ita', 'nld', 'dan', 'nor', 'por'];

mkdirSync(join(out, 'core'), { recursive: true });
mkdirSync(join(out, 'lang'), { recursive: true });

cpSync(join(tesseract, 'dist', 'worker.min.js'), join(out, 'worker.min.js'));
// Only the LSTM builds are used (OEM 1); the worker picks one by SIMD support.
for (const f of [
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-relaxedsimd-lstm.wasm.js',
]) {
  cpSync(join(core, f), join(out, 'core', f));
}
for (const code of LANGS) {
  const dir = pkgDir(`@tesseract.js-data/${code}`);
  cpSync(join(dir, '4.0.0_best_int', `${code}.traineddata.gz`), join(out, 'lang', `${code}.traineddata.gz`));
}

if (!existsSync(join(out, 'lang', 'eng.traineddata.gz'))) process.exit(1);
console.log('OCR assets copied to public/tesseract');
