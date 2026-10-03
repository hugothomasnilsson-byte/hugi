import { open, BASE, S } from './zz-vd-lib.mjs';
const { ctx, page } = await open();
const FIX = `:root { --plate-edge: rgba(24,23,21,.07); } @media (prefers-color-scheme: dark) { :root { --plate-edge: rgba(236,232,224,.08); } }
.img::after { content: ''; position: absolute; inset: 0; box-shadow: inset 0 0 0 1px var(--plate-edge); pointer-events: none; }
.lightbox__img::after { content: none; }
.sheet { box-shadow: 0 0 0 1px var(--rule), var(--shadow); }
@media (prefers-color-scheme: dark) { .sheet::backdrop { background: rgba(0,0,0,.6); } }`;
await page.emulateMedia({ colorScheme: 'dark' });
await page.goto(BASE + '#/'); await page.waitForTimeout(1500);
await page.addStyleTag({ content: FIX }); await page.waitForTimeout(300);
await page.screenshot({ path: `${S}/out/home-dark-fix.png`, clip: { x: 0, y: 690, width: 1440, height: 210 } });
await page.locator('.header__add').click(); await page.waitForTimeout(900);
await page.screenshot({ path: `${S}/out/sheet-dark-fix.png` });
await ctx.close();
