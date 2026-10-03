/**
 * Languages the on-device text reader can use. English ships inside the app's
 * offline bundle; the others are served by the app itself and cached for offline
 * use the first time they are turned on. Nothing is fetched from anywhere else.
 */
export const OCR_LANGUAGES = [
  { code: 'eng', name: 'English' },
  { code: 'swe', name: 'Svenska' },
  { code: 'dan', name: 'Dansk' },
  { code: 'nor', name: 'Norsk' },
  { code: 'deu', name: 'Deutsch' },
  { code: 'nld', name: 'Nederlands' },
  { code: 'fra', name: 'Français' },
  { code: 'spa', name: 'Español' },
  { code: 'ita', name: 'Italiano' },
  { code: 'por', name: 'Português' },
] as const;

export type OcrLanguage = (typeof OCR_LANGUAGES)[number]['code'];

const KEY = 'syble:ocr-langs';
const KNOWN = new Set<string>(OCR_LANGUAGES.map((l) => l.code));

/** The chosen languages, English always first. */
export function getOcrLanguages(): OcrLanguage[] {
  let saved: string[] = [];
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    /* unavailable or malformed: English only */
  }
  const extra = Array.isArray(saved) ? saved.filter((c) => c !== 'eng' && KNOWN.has(c)) : [];
  return ['eng', ...new Set(extra)] as OcrLanguage[];
}

export function saveOcrLanguages(codes: readonly string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(codes.filter((c) => c !== 'eng' && KNOWN.has(c))));
  } catch {
    /* ignore */
  }
}

export function ocrLanguageUrl(code: string) {
  return new URL(`tesseract/lang/${code}.traineddata.gz`, document.baseURI).href;
}
