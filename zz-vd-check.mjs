import { open, BASE, S } from './zz-vd-lib.mjs';
const { ctx, page } = await open();
await page.goto(BASE + '#/all'); await page.waitForTimeout(1500);
console.log(page.url(), await page.evaluate(() => [...document.querySelectorAll('.card__title')].map(e => e.textContent)));
await page.goto(BASE + '#/'); await page.waitForTimeout(1500);
console.log(await page.evaluate(() => document.querySelectorAll('.recent__item').length));
await ctx.close();
