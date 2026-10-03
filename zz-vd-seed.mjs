import { open, SAMPLES, img, BASE } from './zz-vd-lib.mjs';
const { ctx, page } = await open();
await page.goto(BASE);
await page.waitForTimeout(800);
for (const s of SAMPLES) {
  await page.locator('.header__add:visible, .dock__add:visible').first().click();
  const sheet = page.getByRole('dialog');
  if (s.draws.length) {
    const files = [];
    for (const d of s.draws) files.push({ name: `x${files.length}.png`, mimeType: 'image/png', buffer: await img(page, d) });
    await sheet.locator('input[type=file]').setInputFiles(files);
    await page.waitForFunction((n) => document.querySelectorAll('dialog img.plate__img').length >= n, s.draws.length);
  }
  if (s.title) await sheet.getByPlaceholder('Title').fill(s.title);
  if (s.notes) await sheet.getByPlaceholder('Why it matters, what to remember…').fill(s.notes);
  if (s.credit) await sheet.getByPlaceholder('Artist, author, place').fill(s.credit);
  if (s.link) await sheet.getByPlaceholder('https://').fill(s.link);
  for (const t of s.tags) { const i = sheet.getByRole('combobox', { name: 'Add a hashtag' }); await i.fill(t); await i.press('Enter'); }
  await sheet.getByRole('button', { name: 'Add to Syble' }).click();
  await sheet.waitFor({ state: 'hidden' });
}
await page.waitForTimeout(25000);
console.log(await page.evaluate(() => document.querySelectorAll('.recent__item').length));
await ctx.close();
