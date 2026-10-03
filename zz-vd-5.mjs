import { open, BASE, S } from './zz-vd-lib.mjs';
const { ctx, page } = await open();
const ids = {};
await page.goto(BASE + '#/all'); await page.waitForTimeout(1200);
for (const c of await page.locator('.card').all()) { ids[(await c.locator('.card__title').textContent()).trim()] = await c.getAttribute('href'); }
console.log(ids);
const measure = async (tag) => {
  const d = await page.evaluate(() => {
    const R = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top + scrollY), Math.round(b.right), Math.round(b.bottom + scrollY)]; };
    const q = (s) => document.querySelector(s);
    const pal = [...document.querySelectorAll('.palette__item')].map((e) => Math.round(e.getBoundingClientRect().top + scrollY));
    const chips = [...document.querySelectorAll('.suggest--stacked .chip--suggest')].map((e) => Math.round(e.getBoundingClientRect().top + scrollY));
    const dateDd = q('.meta__row dd.mono');
    return { title: R(q('.entry__title')), titleFs: q('.entry__title') && getComputedStyle(q('.entry__title')).fontSize, notes: R(q('.entry__notes')), notesFs: q('.entry__notes') && getComputedStyle(q('.entry__notes')).fontSize, meta: R(q('.entry__meta')), suggest: R(q('.suggest--stacked')), suggestRows: [...new Set(chips)].length, nChips: chips.length, palRows: [...new Set(pal)].length, palItems: pal.length, dateH: dateDd && Math.round(dateDd.getBoundingClientRect().height), dateText: dateDd?.textContent, hero: R(q('.entry__hero-btn .img')), thumbs: [...document.querySelectorAll('.entry__thumb')].map(R), plates: R(q('.entry__plates')), gridCols: q('.entry__grid') && getComputedStyle(q('.entry__grid')).gridTemplateColumns, ocr: [...document.querySelectorAll('.ocr')].map((o) => o.innerText.replace(/\n/g, ' | ').slice(0, 80)), chipPad: q('.chip--suggest') && getComputedStyle(q('.chip--suggest')).padding, chipH: q('.chip--suggest') && getComputedStyle(q('.chip--suggest')).height };
  });
  console.log(tag, JSON.stringify(d));
};
for (const [w, h] of [[1440, 900], [900, 900], [1100, 900]]) {
  await page.setViewportSize({ width: w, height: h });
  for (const name of ['Swiss poster, Basel 1959', 'Grain study, three plates', 'Untitled', 'Specimen: Garalde']) {
    await page.goto(BASE + ids[name]); await page.waitForTimeout(1300);
    await measure(`${w} ${name}`);
    await page.screenshot({ path: `${S}/out/entry-${w}-${name.slice(0, 6).replace(/\W/g, '')}.png`, fullPage: true });
  }
}
await ctx.close();
