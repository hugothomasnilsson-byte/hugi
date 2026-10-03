import { open, BASE, S } from './zz-vd-lib.mjs';
const { ctx, page } = await open();
const GRAIN = '#/entry/1a202f32-d8e8-4b65-af08-98255fd44acf', SWISS = '#/entry/e870096f-3bb4-44e5-b98c-7810bb4ab3b9';
await page.goto(BASE + GRAIN); await page.waitForTimeout(1200);
await page.addStyleTag({ content: `.entry__hero-btn .img { width: min(100%, calc(min(100dvh - 300px, 1100px) * var(--r, 1))); }
.entry__thumbs { gap: 14px; padding-bottom: 8px; } .entry__thumb { opacity: .6; } .entry__thumb.is-on { opacity: 1; outline: none; box-shadow: 0 7px 0 -6px var(--ink); }` });
await page.waitForTimeout(600);
await page.screenshot({ path: `${S}/out/strip-fix2.png`, clip: { x: 400, y: 700, width: 640, height: 200 } });
const SUG = `.suggest--stacked { flex-direction: row; flex-wrap: wrap; align-items: baseline; gap: 2px 14px; margin-top: 14px; }
.suggest--stacked .suggest__chips { gap: 2px 14px; }
.suggest--stacked .chip--suggest { height: auto; padding: 0; border: 0; background: none; overflow: visible; }
.suggest--stacked .chip__add { padding: 2px 0; font-size: 12px; color: var(--muted); }
.suggest--stacked .chip__add:hover { color: var(--ink); }
.suggest--stacked .chip__x { opacity: 0; } .suggest--stacked .chip--suggest:hover .chip__x, .suggest--stacked .chip__x:focus-visible { opacity: 1; }
@media (max-width: 1100px) { .entry__grid { grid-template-columns: 1fr; gap: 24px; } .entry__meta { max-width: 640px; } }
.palette { grid-template-columns: repeat(6, minmax(0, 72px)); }`;
for (const [w, url] of [[1440, GRAIN], [1440, SWISS], [1200, GRAIN], [1101, GRAIN], [900, GRAIN]]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.goto(BASE + url); await page.waitForTimeout(1000);
  await page.addStyleTag({ content: SUG }); await page.waitForTimeout(400);
  const d = await page.evaluate(() => {
    const pal = [...document.querySelectorAll('.palette__item')];
    const sw = pal.map(p => Math.round(p.querySelector('.palette__chip').getBoundingClientRect().width));
    const clipped = pal.filter(p => { const n = p.querySelector('.palette__name'); return n.scrollWidth > n.clientWidth; }).map(p => p.querySelector('.palette__name').textContent);
    const s = document.querySelector('.suggest--stacked'); const sr = s && s.getBoundingClientRect();
    const x = document.querySelector('.suggest--stacked .chip__x');
    return { rows: [...new Set(pal.map(p => Math.round(p.getBoundingClientRect().top)))].length, sw, clipped, sugH: sr && Math.round(sr.height), xOpacity: x && getComputedStyle(x).opacity, gridCols: getComputedStyle(document.querySelector('.entry__grid')).gridTemplateColumns };
  });
  console.log(w, url === GRAIN ? 'grain' : 'swiss', JSON.stringify(d));
  if (w === 1440 && url === GRAIN) await page.screenshot({ path: `${S}/out/meta-fix-1440.png`, clip: { x: 900, y: 940, width: 540, height: 500 }, fullPage: true });
}
await ctx.close();
