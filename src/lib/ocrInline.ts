/**
 * The OCR engine packed into the standalone single-file build (VITE_SINGLEFILE=1),
 * which runs from a local file with no server: the worker and engine become blob
 * URLs and the English model is embedded. Never imported by the normal build.
 */
import workerSource from 'tesseract.js/dist/worker.min.js?raw';
// The plain LSTM build runs in every browser; the SIMD variants are only faster.
import coreSource from 'tesseract.js-core/tesseract-core-lstm.wasm.js?raw';
import engData from '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?inline';

// A page opened from disk can't let its worker load further scripts, so the engine
// and the worker run as one script: the engine defines TesseractCore first, and the
// worker then finds it already loaded instead of fetching it from corePath.
export const workerPath = URL.createObjectURL(
  new Blob([coreSource, '\n;\n', workerSource], { type: 'text/javascript' }),
);
// Never fetched (see above); a file name keeps tesseract.js from appending one.
export const corePath = 'tesseract-core-lstm.wasm.js';

export async function languageData(code: string): Promise<Uint8Array> {
  if (code !== 'eng') throw new Error('This standalone copy of Syble reads English only.');
  return new Uint8Array(await (await fetch(engData)).arrayBuffer());
}
