import type { Page } from '@playwright/test';

/** Renders text onto a canvas in the page and returns it as a PNG buffer. */
export async function makePng(
  page: Page,
  lines: string[],
  opts: { width?: number; height?: number; bg?: string; fg?: string; block?: string } = {},
): Promise<Buffer> {
  const b64 = await page.evaluate(
    ({ lines, width, height, bg, fg, block }) => {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);
      if (block) {
        ctx.fillStyle = block;
        ctx.fillRect(0, height * 0.55, width, height * 0.45);
      }
      ctx.fillStyle = fg;
      ctx.font = '56px Arial, Helvetica, sans-serif';
      lines.forEach((l, i) => ctx.fillText(l, 48, 110 + i * 84));
      return c.toDataURL('image/png').split(',')[1];
    },
    { lines, width: opts.width ?? 1200, height: opts.height ?? 800, bg: opts.bg ?? '#ffffff', fg: opts.fg ?? '#111111', block: opts.block ?? '' },
  );
  return Buffer.from(b64, 'base64');
}

export async function resetApp(page: Page) {
  await page.goto('./');
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('syble');
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
  await page.goto('./');
  await page.reload();
}
