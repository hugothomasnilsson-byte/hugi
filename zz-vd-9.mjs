import { open, BASE, S } from './zz-vd-lib.mjs';
const { ctx, page } = await open();
const probeFn = () => {
  const probe = (el) => { const s = document.createElement('span'); s.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'; el.appendChild(s); const t = s.getBoundingClientRect().top; s.remove(); return Math.round(t * 10) / 10; };
  const meta = document.querySelector('.page-head__meta'); const opt = document.querySelector('.segmented__opt.is-on'); const seg = document.querySelector('.segmented');
  const sr = seg.getBoundingClientRect();
  return { metaBase: probe(meta), optBase: probe(opt), metaFont: getComputedStyle(meta).fontFamily.slice(0, 30), metaFs: getComputedStyle(meta).fontSize, optFont: getComputedStyle(opt).fontFamily.slice(0, 30), optFs: getComputedStyle(opt).fontSize, segH: Math.round(sr.height), segShadow: getComputedStyle(opt).boxShadow };
};
await page.goto(BASE + '#/all'); await page.waitForTimeout(1200);
console.log('desk', JSON.stringify(await page.evaluate(probeFn)));
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(BASE + '#/all'); await page.waitForTimeout(1200);
console.log('mob', JSON.stringify(await page.evaluate(probeFn)));
await page.screenshot({ path: `${S}/out/m-all-head.png`, clip: { x: 0, y: 0, width: 390, height: 360 } });
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(BASE + '#/?q=blue'); await page.waitForTimeout(1200);
console.log('snippet', JSON.stringify(await page.evaluate(() => { const s = document.querySelector('.card__snippet'); const e = document.querySelector('.entry__notes, .card__excerpt'); return { snip: s && getComputedStyle(s).fontFamily, fs: s && getComputedStyle(s).fontSize, found: [...document.querySelectorAll('.card__found')].map(f => f.textContent), body: getComputedStyle(document.body).fontFamily }; })));
await page.screenshot({ path: `${S}/out/search-blue.png` });
// text-entry excerpt font
await page.goto(BASE + '#/all'); await page.waitForTimeout(1000);
console.log('excerpt', await page.evaluate(() => getComputedStyle(document.querySelector('.card__excerpt')).fontFamily));
// plate strip fix
await page.goto(BASE + '#/entry/1a202f32-d8e8-4b65-af08-98255fd44acf'); await page.waitForTimeout(1200);
await page.addStyleTag({ content: `.entry__hero-btn .img { width: min(100%, calc(min(100dvh - 300px, 1100px) * var(--r, 1))); }
.entry__thumbs { gap: 14px; } .entry__thumb { opacity: .6; } .entry__thumb.is-on { opacity: 1; outline: none; box-shadow: 0 7px 0 -6px var(--ink); }` });
await page.waitForTimeout(600);
console.log('stripfix', JSON.stringify(await page.evaluate(() => ({ hero: (() => { const b = document.querySelector('.entry__hero-btn .img').getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom), Math.round(b.width)]; })(), plates: (() => { const b = document.querySelector('.entry__plates').getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom)]; })(), title: Math.round(document.querySelector('.entry__title').getBoundingClientRect().top) }))));
await page.screenshot({ path: `${S}/out/strip-fix.png`, clip: { x: 400, y: 700, width: 640, height: 200 } });
// does box-shadow show? thumbs overflow-x:auto might clip
console.log(await page.evaluate(() => { const t = document.querySelector('.entry__thumbs'); return getComputedStyle(t).overflowY + ' ' + getComputedStyle(t).overflowX; }));
await ctx.close();
