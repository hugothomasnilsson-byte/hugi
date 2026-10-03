import { open, BASE, S } from './zz-vd-lib.mjs';
import { devices } from '@playwright/test';
const { ctx, page } = await open({ ...devices['iPhone 14'], defaultBrowserType: undefined });
await page.goto(BASE + '#/entry/1a202f32-d8e8-4b65-af08-98255fd44acf'); await page.waitForTimeout(1500);
const d = await page.evaluate(() => {
  const c = document.querySelector('.chip--suggest'); const a = c.querySelector('.chip__add'); const x = c.querySelector('.chip__x');
  const cr = c.getBoundingClientRect(), ar = a.getBoundingClientRect(), xr = x.getBoundingClientRect();
  const textStart = (() => { const r = document.createRange(); r.selectNodeContents(a); const b = r.getClientRects()[0]; return b.left; })();
  const rows = [...document.querySelectorAll('.suggest--stacked .chip--suggest')].map(e => Math.round(e.getBoundingClientRect().top));
  const solid = document.querySelector('.chip--solid');
  return { vw: innerWidth, pad: getComputedStyle(c).padding, chipW: Math.round(cr.width), textIndent: Math.round(textStart - cr.left), afterX: Math.round(cr.right - xr.right), rows: [...new Set(rows)].length, n: rows.length, solid: solid && getComputedStyle(solid).padding };
});
console.log(JSON.stringify(d));
await page.screenshot({ path: `${S}/out/m-entry.png`, fullPage: true });
// with fix
await page.addStyleTag({ content: '@media (max-width: 720px) { .chip--solid { padding-right: 8px; } .chip--suggest { padding: 0 6px 0 0; } }' });
await page.waitForTimeout(300);
console.log(JSON.stringify(await page.evaluate(() => { const c = document.querySelector('.chip--suggest'); const rows = [...document.querySelectorAll('.suggest--stacked .chip--suggest')].map(e => Math.round(e.getBoundingClientRect().top)); return { pad: getComputedStyle(c).padding, w: Math.round(c.getBoundingClientRect().width), rows: [...new Set(rows)].length }; })));
// sheet on mobile with tags
await page.goto(BASE + '#/'); await page.waitForTimeout(800);
await page.locator('.dock__add').click(); await page.waitForTimeout(600);
const i = page.getByRole('combobox', { name: 'Add a hashtag' }); await i.fill('film'); await i.press('Enter');
await page.waitForTimeout(300);
console.log(JSON.stringify(await page.evaluate(() => { const s = document.querySelector('dialog .chip--solid'); return s && { pad: getComputedStyle(s).padding, cls: s.className }; })));
await ctx.close();
