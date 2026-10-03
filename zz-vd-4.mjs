import { open, BASE, S } from './zz-vd-lib.mjs';
const { ctx, page } = await open();
for (const scheme of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto(BASE + '#/all'); await page.waitForTimeout(1500);
  await page.screenshot({ path: `${S}/out/all-${scheme}.png`, fullPage: true });
  await page.goto(BASE + '#/'); await page.waitForTimeout(1200);
  await page.screenshot({ path: `${S}/out/home-${scheme}.png` });
  await page.locator('.header__add').click(); await page.waitForTimeout(900);
  await page.screenshot({ path: `${S}/out/sheet-${scheme}.png` });
  await page.keyboard.press('Escape'); await page.waitForTimeout(500);
}
// home fold fix
await page.emulateMedia({ colorScheme: 'light' });
for (const [w, h] of [[1440, 900], [1280, 800], [1366, 768], [1920, 1080]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(BASE + '#/'); await page.waitForTimeout(800);
  await page.addStyleTag({ content: '.search__stage { min-height: calc(50dvh - 40px); }' }); await page.waitForTimeout(900);
  const d = await page.evaluate(() => ({ formTop: Math.round(document.querySelector('.search__form').getBoundingClientRect().top), titleBottom: Math.round(document.querySelector('.recent__title').getBoundingClientRect().bottom), tagsBottom: Math.round(document.querySelector('.search__tags').getBoundingClientRect().bottom), recentTop: Math.round(document.querySelector('.recent .section-head').getBoundingClientRect().top) }));
  console.log('fold-fix', w, h, JSON.stringify(d));
  if (w === 1440) await page.screenshot({ path: `${S}/out/home-1440-fix.png` });
}
await ctx.close();
