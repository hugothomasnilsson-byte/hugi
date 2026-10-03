import { open, BASE, S } from './zz-vd-lib.mjs';
const { ctx, page } = await open();
const r = (sel) => page.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; }, sel);
const mk = (mw) => `.search__form, .search__completions, .search__tags { width: 100%; max-width: 860px; transition: max-width .6s cubic-bezier(.16,1,.3,1); }
.search.is-active .search__form, .search.is-active .search__completions, .search.is-active .search__tags { max-width: ${mw}; }
.results > .section-head { border-top: 0; padding-top: 18px; margin-bottom: 24px; }
@media (max-width: 720px) { .search__tags { width: calc(100% + 32px); } }`;
for (const mw of ['100%', 'none']) {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(BASE + '#/?q=grain'); await page.waitForTimeout(900);
    await page.addStyleTag({ content: mk(mw) }); await page.waitForTimeout(900);
    console.log(mw, w, 'form', await r('.search__form'), 'tags', await r('.search__tags'), 'card', await r('.results .card'));
    if (w === 1440 && mw === 'none') await page.screenshot({ path: `${S}/out/search-fix-final.png` });
    await page.goto(BASE + '#/'); await page.waitForTimeout(700);
    await page.addStyleTag({ content: mk(mw) }); await page.waitForTimeout(700);
    console.log(mw, w, 'idle form', await r('.search__form'), 'tags', await r('.search__tags'));
  }
}
await ctx.close();
