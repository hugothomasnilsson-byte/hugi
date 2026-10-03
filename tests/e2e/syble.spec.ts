import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { makePng, resetApp } from './helpers';

const search = (page: Page) => page.getByRole('searchbox', { name: 'Search your almanac' });

async function addEntry(
  page: Page,
  opts: { title?: string; notes?: string; tags?: string[]; image?: Buffer; link?: string; credit?: string },
) {
  await page.locator('.header__add:visible, .dock__add:visible').first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  if (opts.image) {
    await sheet.locator('input[type=file]').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: opts.image });
    await expect(sheet.locator('.plate__img img, img.plate__img').first()).toBeVisible();
  }
  if (opts.title) await sheet.getByPlaceholder('Title').fill(opts.title);
  if (opts.notes) await sheet.getByPlaceholder('Why it matters, what to remember…').fill(opts.notes);
  if (opts.link) await sheet.getByPlaceholder('https://').fill(opts.link);
  if (opts.credit) await sheet.getByPlaceholder('Artist, author, place').fill(opts.credit);
  for (const t of opts.tags ?? []) {
    const input = sheet.getByRole('combobox', { name: 'Add a hashtag' });
    await input.fill(t);
    await input.press('Enter');
  }
  await sheet.getByRole('button', { name: /Add to Syble|Save changes/ }).click();
  await expect(sheet).toBeHidden();
}

test.describe('Syble', () => {
  test.beforeEach(async ({ page }) => {
    await resetApp(page);
  });

  test('opens on a single search field with a welcome when empty', async ({ page }) => {
    await expect(search(page)).toBeVisible();
    await expect(page.getByText('A private almanac')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add your first source' })).toBeVisible();
  });

  test('adds an entry with an image, reads its text and finds it by that text', async ({ page }) => {
    const png = await makePng(page, ['Kodak Portra grain study', 'Shot on medium format']);
    await addEntry(page, { image: png, title: 'Morning light', notes: 'Soft halation on the highlights.', tags: ['film', 'colour'] });

    // Lands on the source page.
    await expect(page.getByRole('heading', { level: 1, name: 'Morning light' })).toBeVisible();
    await expect(page.getByRole('link', { name: '#film' })).toBeVisible();

    // On-device OCR finishes and shows the extracted text.
    await expect(page.locator('.ocr__text')).toContainText(/portra/i, { timeout: 90_000 });

    // Search by a word that only exists inside the image.
    await page.goto('./#/');
    await search(page).fill('portra');
    const card = page.locator('.card').first();
    await expect(card).toContainText('Morning light');
    await expect(card.locator('mark').first()).toHaveText(/portra/i);
    await expect(card).toContainText(/image text/i);
  });

  test('combines keywords and hashtags, highlights matches', async ({ page }) => {
    await addEntry(page, { title: 'Grain in shadows', notes: 'Pushed two stops', tags: ['film', 'bw'] });
    await addEntry(page, { title: 'Grain of oak', notes: 'Furniture detail', tags: ['wood'] });
    await addEntry(page, { title: 'Colour negative', notes: 'Very fine grain', tags: ['film', 'colour'] });
    await page.goto('./#/');

    await search(page).fill('grain #film');
    await expect(page.locator('.card')).toHaveCount(2);
    await expect(page.locator('.card').first().locator('mark').first()).toHaveText(/grain/i);

    await search(page).fill('grain #film #colour');
    await expect(page.locator('.card')).toHaveCount(1);
    await expect(page.locator('.card')).toContainText('Colour negative');

    await search(page).fill('grain -oak');
    await expect(page.locator('.card')).toHaveCount(2);

    await search(page).fill('zzzz-nothing');
    await expect(page.getByText(/Nothing yet for/)).toBeVisible();
  });

  test('shows top hashtags and recently added on the home screen', async ({ page }) => {
    await addEntry(page, { title: 'One', tags: ['type'] });
    await addEntry(page, { title: 'Two', tags: ['type', 'poster'] });
    await page.goto('./#/');
    const tags = page.getByRole('navigation', { name: 'Most-used hashtags' });
    await expect(tags.getByRole('button').first()).toContainText('#type');
    await expect(page.getByRole('heading', { name: 'Recently added' })).toBeVisible();
    await tags.getByRole('button', { name: /#poster/ }).click();
    await expect(search(page)).toHaveValue('#poster ');
    await expect(page.locator('.card')).toHaveCount(1);
  });

  test('keyboard: "/" focuses search, N opens a new entry, Esc closes', async ({ page }) => {
    await addEntry(page, { title: 'Something' });
    await page.goto('./#/all');
    await page.keyboard.press('/');
    await expect(search(page)).toBeFocused();
    await page.locator('body').click({ position: { x: 5, y: 300 } });
    await page.keyboard.press('n');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('pasting an image starts a new entry', async ({ page }) => {
    const png = await makePng(page, ['Pasted']);
    await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'paste.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
    }, png.toString('base64'));
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.plate')).toHaveCount(2); // the image + the "add" tile
  });

  test('edits, tags from the source page, and deletes with undo', async ({ page }) => {
    await addEntry(page, { title: 'Draft title', notes: 'first', tags: ['a'] });
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('dialog').getByPlaceholder('Title').fill('Final title');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Final title' })).toBeVisible();

    await page.getByRole('button', { name: '+ tag' }).click();
    await page.getByLabel('New hashtag').fill('later');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('link', { name: '#later' })).toBeVisible();

    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('Entry deleted')).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Final title' })).toBeVisible();
  });

  test('browses by tag, the tag index and the full index with sorting', async ({ page }) => {
    await addEntry(page, { title: 'Beta', tags: ['print'] });
    await addEntry(page, { title: 'Alpha', tags: ['print', 'ink'] });
    await addEntry(page, { title: 'Gamma', tags: ['ink'] });

    await page.goto('./#/tags');
    await expect(page.getByRole('link', { name: /#print/ })).toBeVisible();
    await page.getByRole('link', { name: /#print/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('print');
    await expect(page.locator('.card')).toHaveCount(2);

    await page.goto('./#/all');
    await page.getByRole('radio', { name: 'Title' }).click();
    await expect(page.locator('.card__title').first()).toHaveText('Alpha');
    await page.getByRole('radio', { name: 'Oldest' }).click();
    await expect(page.locator('.card__title').first()).toHaveText('Beta');
  });

  test('related entries share hashtags', async ({ page }) => {
    await addEntry(page, { title: 'Unrelated', tags: ['zzz'] });
    await addEntry(page, { title: 'Cousin', tags: ['type', 'swiss'] });
    await addEntry(page, { title: 'Subject', tags: ['type', 'swiss', 'poster'] });
    const related = page.locator('.entry__related');
    await expect(related).toContainText('Cousin');
    await expect(related).not.toContainText('Unrelated');
  });

  test('extracted text can be corrected and is searchable', async ({ page }) => {
    const png = await makePng(page, ['Helvetica Neue']);
    await addEntry(page, { title: 'Specimen', image: png });
    await expect(page.locator('.ocr__text')).toBeVisible({ timeout: 90_000 });
    await page.locator('.ocr').getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('textbox', { name: 'Extracted text' }).fill('Akzidenz Grotesk specimen');
    await page.getByRole('button', { name: 'Save text' }).click();
    await expect(page.locator('.ocr__text')).toHaveText('Akzidenz Grotesk specimen');
    await page.goto('./#/');
    await search(page).fill('akzidenz');
    await expect(page.locator('.card')).toHaveCount(1);
  });

  test('colours are extracted and searchable', async ({ page }) => {
    const png = await makePng(page, [''], { bg: '#1f3a93', block: '#1f3a93' });
    await addEntry(page, { title: 'Deep blue field', image: png });
    await expect(page.locator('.palette__item').first()).toBeVisible({ timeout: 20_000 });
    const name = (await page.locator('.palette__name').first().textContent())!.trim();
    await page.goto('./#/');
    await search(page).fill('blue');
    await expect(page.locator('.card')).toContainText('Deep blue field');
    await search(page).fill(name);
    await expect(page.locator('.card')).toContainText('Deep blue field');
  });

  test('exports and re-imports the library', async ({ page }) => {
    const png = await makePng(page, ['Backup me']);
    await addEntry(page, { title: 'Keep safe', image: png, tags: ['archive'] });
    await page.goto('./#/library');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export library' }).click()]);
    expect(download.suggestedFilename()).toMatch(/^syble-backup-\d{4}-\d{2}-\d{2}\.zip$/);
    const path = await download.path();
    const zip = readFileSync(path!);

    // Erase, then restore.
    page.once('dialog', (d) => d.accept('erase'));
    await page.getByRole('button', { name: 'Erase library…' }).click();
    await expect(page.getByText('Library erased')).toBeVisible();

    await page.locator('input[type=file][accept*="zip"]').setInputFiles({ name: 'b.zip', mimeType: 'application/zip', buffer: zip });
    await expect(page.getByText(/Imported 1 entry and 1 image/)).toBeVisible();
    await page.goto('./#/');
    await search(page).fill('#archive');
    await expect(page.locator('.card')).toContainText('Keep safe');
  });

  test('works offline after the first visit', async ({ page, context }) => {
    await page.goto('./');
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await context.setOffline(true);
    await page.reload();
    await expect(search(page)).toBeVisible();
    // Adding and OCR still work with no network.
    const png = await makePng(page, ['Offline words']);
    await addEntry(page, { title: 'No network', image: png });
    await expect(page.locator('.ocr__text')).toContainText(/offline/i, { timeout: 90_000 });
    await context.setOffline(false);
  });

  test('mobile: single-column feed and a thumb-reachable dock @mobile', async ({ page }) => {
    await addEntry(page, { title: 'Phone one', tags: ['m'] });
    await addEntry(page, { title: 'Phone two', tags: ['m'] });
    await page.goto('./#/all');
    await expect(page.locator('.masonry__col')).toHaveCount(1);
    const dock = page.getByRole('navigation', { name: 'Quick actions' });
    await expect(dock.getByRole('button', { name: 'Search' })).toBeVisible();
    await expect(dock.getByRole('button', { name: 'Add a source' })).toBeVisible();
    await dock.getByRole('button', { name: 'Search' }).click();
    await expect(search(page)).toBeFocused();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
