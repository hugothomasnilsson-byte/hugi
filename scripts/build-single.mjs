// Builds Syble as one self-contained HTML file (dist-single/syble.html) that runs
// straight from disk: scripts, styles, fonts, icons and the OCR engine are inlined.
// Run: npm run build:single
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'dist-single');

execSync('npx vite build', { cwd: root, stdio: 'inherit', env: { ...process.env, VITE_SINGLEFILE: '1' } });

let html = readFileSync(join(out, 'index.html'), 'utf8');
const assets = join(out, 'assets');
const files = readdirSync(assets);
const jsFiles = files.filter((f) => f.endsWith('.js'));
if (jsFiles.length !== 1) throw new Error(`Expected one script bundle, found: ${jsFiles.join(', ')}`);

// "</script" inside the code would end the inline <script> early.
const inlineScript = (code) => code.replace(/<\/script/gi, '<\\/script');
const dataUri = (path, type) => `data:${type};base64,${readFileSync(path).toString('base64')}`;

html = html
  .replace(/<script type="module" crossorigin src="\.\/assets\/[^"]+\.js"><\/script>/, () => {
    const code = readFileSync(join(assets, jsFiles[0]), 'utf8');
    return `<script type="module">${inlineScript(code)}</script>`;
  })
  .replace(/<link rel="stylesheet" crossorigin href="\.\/assets\/([^"]+\.css)">/, (_, name) => {
    return `<style>${readFileSync(join(assets, name), 'utf8')}</style>`;
  })
  .replace(/\s*<link rel="modulepreload"[^>]*>/g, '')
  .replace(/\s*<link rel="manifest"[^>]*>/g, '')
  .replace(/\s*<meta name="apple-mobile-web-app-[^>]*>/g, '')
  .replace(/\s*<meta name="mobile-web-app-capable"[^>]*>/g, '')
  .replace(/\s*<link rel="apple-touch-icon"[^>]*>/g, '')
  .replace('href="./icon-192.png"', `href="${dataUri(join(root, 'public', 'icon-192.png'), 'image/png')}"`);

if (/(src|href)="\.\//.test(html)) throw new Error('A relative reference was left un-inlined.');
const target = join(out, 'syble.html');
writeFileSync(target, html);
console.log(`Wrote ${target} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MB)`);
