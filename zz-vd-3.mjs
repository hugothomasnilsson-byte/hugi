import { open, BASE, S } from './zz-vd-lib.mjs';
const { ctx, page } = await open();
await page.goto(BASE + '#/'); await page.waitForTimeout(1000);
const input = page.locator('.search__input');
await input.click();
let n = 0;
const seq = ['o', 'r', 'Backspace', 'Backspace', 'c', 'o', 'l'];
let prevKeys = [];
for (const k of seq) {
  if (k === 'Backspace') await input.press('Backspace'); else await input.type(k);
  await page.waitForTimeout(120);
  const info = await page.evaluate((n) => {
    const cards = [...document.querySelectorAll('.results .card')];
    const out = cards.map((c) => {
      const fresh = !c.dataset.vtag; c.dataset.vtag = '1';
      const img = c.querySelector('.img img');
      const anim = c.getAnimations()[0];
      return { t: c.querySelector('.card__title')?.textContent?.slice(0, 14), fresh, op: img ? getComputedStyle(img).opacity.slice(0, 4) : '-', anim: anim ? Math.round(anim.currentTime) : null, col: [...c.closest('.masonry').children].indexOf(c.closest('.masonry__col')) };
    });
    return { q: document.querySelector('.search__input').value, out };
  }, n++);
  console.log(JSON.stringify(info));
  await page.waitForTimeout(900);
}
await ctx.close();
