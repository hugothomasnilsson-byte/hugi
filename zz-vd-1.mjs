import { open, BASE, S } from './zz-vd-lib.mjs';
const { ctx, page } = await open();
const r = (sel) => page.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; }, sel);
for (const q of ['grain', 'blue', 'zzzq']) {
  await page.goto(BASE + '#/?q=' + q); await page.waitForTimeout(1200);
  const inputText = await page.evaluate(() => { const i = document.querySelector('.search__input'); const b = i.getBoundingClientRect(); return [Math.round(b.left + parseFloat(getComputedStyle(i).paddingLeft))]; });
  console.log(q, 'form', await r('.search__form'), 'inputTextX', inputText, 'rule', await r('.search__rule'), 'sectionhead', await r('.results > .section-head'), 'card', await r('.results .card'), 'none', await r('.results__none-title'));
  await page.screenshot({ path: `${S}/out/search-${q}.png` });
}
await page.setViewportSize({ width: 900, height: 900 });
await page.goto(BASE + '#/?q=grain'); await page.waitForTimeout(1200);
console.log('900 form', await r('.search__form'), 'rule', await r('.search__rule'), 'sectionhead', await r('.results > .section-head'), 'card', await r('.results .card'));
await page.screenshot({ path: `${S}/out/search-900.png` });
// home fold
for (const [w, h] of [[1440, 900], [1280, 800], [1536, 864], [1920, 1080], [1366, 768]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(BASE + '#/'); await page.waitForTimeout(1500);
  const data = await page.evaluate(() => {
    const b = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().bottom) : null; };
    const t = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().top) : null; };
    return { tagsBottom: b('.search__tags'), recentHeadTop: t('.recent .section-head'), imgBottom: b('.recent__img'), titleBottom: b('.recent__title'), stageBottom: b('.search__stage'), formTop: t('.search__form') };
  });
  console.log(w, h, JSON.stringify(data));
  if (w === 1440 || w === 1280) await page.screenshot({ path: `${S}/out/home-${w}.png` });
}
await ctx.close();
