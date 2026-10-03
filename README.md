# Syble

*A personal creative almanac.* A private, offline library for the sources, references and
inspiration you collect — screenshots, images, passages, colour — tagged with hashtags and
found again instantly.

- **Search first.** Syble opens on one large search field. Results appear as you type and match
  the title, your notes, hashtags, the credit and link, the **text inside your images**, and
  their **colours**. Matched words are highlighted so you can see why each entry came up.
- **Fast to add.** Drop images on the window, paste with <kbd>⌘V</kbd>/<kbd>Ctrl V</kbd>, or pick
  from the camera roll. Each entry holds several images, a title, notes, a link or credit, and hashtags
  (autocompleted from the ones you've used).
- **Reads your images on the device.** Text in screenshots is extracted by an OCR engine bundled
  with the app, so nothing is ever uploaded. You can read and correct the text on each source page.
  Syble also suggests hashtags and pulls a small colour palette from each image.
- **Reads more than English.** In *Library → Reading text*, turn on Swedish, Danish, Norwegian,
  German, Dutch, French, Spanish, Italian or Portuguese so accents come out right. Each language
  model is served by Syble itself and cached for offline use when you switch it on. *Re-read all
  images* applies the new languages to your existing library, skipping any text you corrected by hand.
- **Yours alone.** Everything lives in your browser's storage (IndexedDB) on this device. There's no
  account, no server and no network access. Export the whole library as a `.zip` to back it up or
  move it to another device.

## Search syntax

| Query | Finds |
| --- | --- |
| `grain` | every entry containing “grain” anywhere — also *grainy*, *#film-grain*, text in an image |
| `grain #colour #film` | entries containing “grain” **and** tagged both `#colour` and `#film` |
| `"film grain"` | the exact phrase |
| `poster -swiss` | “poster” but not “swiss” |
| `ochre`, `blue` | entries whose images contain that colour |
| `#1f3a93` | entries with a colour close to that hex value |

Accents and case are ignored: `cafe` finds *Café*.

## Shortcuts

<kbd>/</kbd> search · <kbd>⌘V</kbd>/<kbd>Ctrl V</kbd> add from the clipboard · <kbd>N</kbd> new entry ·
<kbd>⌘↵</kbd>/<kbd>Ctrl ↵</kbd> save · <kbd>←</kbd> <kbd>→</kbd> step through images · <kbd>Esc</kbd> close or clear.

On a phone, the search bar and the **+** button sit in a dock at the bottom of the screen, within
thumb's reach. Tap hashtag chips to combine them and tap again to remove one; Back undoes a tap.

## Putting Syble on your phone

Syble is a Progressive Web App: it's served once like a website, then installs to your home screen
and runs fully offline.

1. **Publish it** (one time). The repository includes a GitHub Pages workflow
   (`.github/workflows/deploy.yml`). In the repository's *Settings → Pages*, set **Source** to
   *GitHub Actions*, then push to `main`. The site appears at
   `https://<your-user>.github.io/<repo>/`. (Pages on a private repository needs a paid GitHub plan.
   Any static host works too: upload the `dist/` folder.)
2. **Install it.** Open that address on your phone once.
   - iPhone (Safari): *Share → Add to Home Screen*.
   - Android (Chrome): *⋮ → Install app*.
3. **Use it offline.** On first load, the app caches itself, including the ~15 MB OCR engine. After
   that, it opens and works with no connection. Your library never leaves the device. Hosting only
   delivers the app's code.

Open **Library → Keep data on this device** to ask the browser not to clear storage under pressure, and
**export a backup** now and then. On iPhone, an app added to the Home Screen has its own storage,
separate from Safari tabs.

## Development

```bash
npm install          # also copies the OCR engine into public/tesseract
npm run dev          # http://localhost:5173
npm test             # unit tests (vitest, 363 tests)
npm run build        # production build in dist/ (type-checks first)
npm run e2e          # end-to-end tests in Chromium, desktop and phone (builds and serves the app)
node tests/ocr/run-ocr-check.mjs   # real OCR check in a browser, with the network blocked
```

### How it's built

- **Vite + React + TypeScript**, no backend. A hash router keeps it working from any sub-path.
- **IndexedDB** (`src/lib/db.ts`) holds three stores: entries, image metadata and image blobs. Only
  metadata is loaded at start-up, and thumbnails load lazily.
- **Search** (`src/lib/search.ts`): an in-memory index of folded (lower-cased, accent-free) fields,
  scanned on each keystroke and ranked by field (title › tags › notes/credit › image text › link),
  whole-word matches and recency. It is fast enough for thousands of entries on a phone.
- **OCR** (`src/lib/ocr.ts`): [tesseract.js](https://github.com/naptha/tesseract.js) running in a
  Web Worker. The WASM core and English model are served from the app itself, never a CDN. Dark-mode
  screenshots are inverted before recognition.
- **Colour** (`src/lib/colour.ts`): deterministic k-means in Lab space, with each swatch named from a
  curated list (ochre, slate, oxblood…) and grouped into a family (blue, brown…).
- **Hashtag suggestions** (`src/lib/suggest.ts`): tags you already use that appear in the content,
  salient keywords from the title, notes and image text, the source platform, and the dominant
  colour.
- **Backups** (`src/lib/backup.ts`): a `.zip` holding `manifest.json` plus the original images and
  thumbnails. Import can merge (newer edits win) or replace.
- **Offline**: `vite-plugin-pwa` precaches every asset, including the fonts and the OCR engine.
