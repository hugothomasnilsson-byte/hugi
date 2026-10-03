import { open, BASE, S, img } from './zz-vd-lib.mjs';
import { devices } from '@playwright/test';
const { ctx, page } = await open();
const R = (sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; }), sel);
await page.goto(BASE + '#/'); await page.waitForTimeout(800);
await page.locator('.header__add').click();
const sheet = page.getByRole('dialog');
await sheet.locator('input[type=file]').setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: await img(page, { w: 900, h: 1260, kind: 'poster' }) });
await page.waitForTimeout(400);
console.log('running badge', await R('dialog .ocr-badge'), await page.evaluate(() => document.querySelector('dialog .ocr-badge')?.parentElement?.className));
await page.waitForTimeout(12000);
console.log('li', await R('dialog .plates > .plate:first-child'), 'frame', await R('dialog .plate__frame'), 'bar', await R('dialog .plate__bar'), 'x', await R('dialog .plate__actions button'), 'badge', await R('dialog .ocr-badge'), await page.evaluate(() => document.querySelector('dialog .ocr-badge')?.parentElement?.className), 'col', await R('dialog .sheet__images'));
await page.screenshot({ path: `${S}/out/sheet-cover.png` });
await page.keyboard.press('Escape'); await page.waitForTimeout(400);
// close-confirm?
await ctx.close();
