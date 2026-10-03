// Renders the Syble app icons (PNG) from the wordmark typeface using headless Chromium.
// Run: node scripts/make-icons.mjs
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const font = readFileSync(
  join(root, 'node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2'),
).toString('base64');

const html = (size, inset) => `<!doctype html><html><head><style>
@font-face { font-family: IS; src: url(data:font/woff2;base64,${font}) format('woff2'); font-style: italic; }
html, body { margin: 0; width: ${size}px; height: ${size}px; }
.tile { position: relative; width: ${size}px; height: ${size}px; background: #f6f4ef; overflow: hidden; }
.s { position: absolute; left: 0; right: 0; top: ${size * (0.12 + inset * 0.5)}px; text-align: center;
     font-family: IS; font-style: italic; font-size: ${size * (0.74 - inset)}px; line-height: 1; color: #181715; }
.r { position: absolute; left: 50%; width: ${size * 0.085}px; height: ${Math.max(2, size * 0.008)}px; margin-left: -${size * 0.0425}px;
     top: ${size * (0.8 - inset * 0.4)}px; background: #a8432a; }
</style></head><body><div class="tile"><div class="s">S</div><div class="r"></div></div></body></html>`;

// Use a system Chromium when Playwright's bundled one isn't installed.
const executablePath = process.env.CHROMIUM_PATH || (await import('node:fs')).existsSync('/opt/pw-browsers/chromium') ? process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage();
const targets = [
  ['icon-192.png', 192, 0],
  ['icon-512.png', 512, 0],
  ['icon-512-maskable.png', 512, 0.16],
  ['apple-touch-icon.png', 180, 0.04],
];
for (const [name, size, inset] of targets) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(html(size, inset));
  await page.evaluate(() => document.fonts.ready);
  writeFileSync(join(root, 'public', name), await page.screenshot({ type: 'png' }));
}
await browser.close();
console.log('icons written');
