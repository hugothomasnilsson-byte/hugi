# OCR and image check (real browser)

```bash
node tests/ocr/run-ocr-check.mjs           # against the Vite dev server
node tests/ocr/run-ocr-check.mjs --build   # against a production build (vite build + vite preview)
```

The driver serves the project on port 5179, opens `ocr-harness.html` in Chromium and runs the
cases in `harness.ts` through the real `src/lib/images.ts` and `src/lib/ocr.ts`:

- text drawn on canvases (light, dark mode, small, white on transparency, a screenshot with photos
  and icons, a poster, mixed light/dark layouts, a 1080×6000 scrolling screenshot, a blank image)
  must be recognised, with monotonic progress ending at 1;
- a 6000×4500 PNG is re-encoded to 4096×3072 with a 720 px thumbnail, and a tall screenshot is kept
  as the original file;
- JPEGs tagged with each EXIF orientation (1–8) come out upright, both natively and in simulated
  browsers that ignore EXIF in `createImageBitmap`, lack it entirely, or (like older Safari) reject
  `imageOrientation: 'from-image'`;
- transparent PNGs keep their alpha as WebP, or sit on white as JPEG in a simulated Safari (no WebP
  encoding, no OffscreenCanvas); six images prepared in parallel with OCR running all succeed;
- every request must stay on localhost. Other hosts are blocked and logged, and a dead proxy
  catches anything that slips past.

Chromium is found at `/opt/pw-browsers/chromium` when present; set `CHROMIUM_PATH` to override.
