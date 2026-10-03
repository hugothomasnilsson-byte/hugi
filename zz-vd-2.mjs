import { open, BASE, S } from './zz-vd-lib.mjs';
const { ctx, page } = await open();
const r = (sel) => page.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; }, sel);
const FIX = `.search__form, .search__completions { width: 100%; max-width: 860px; transition: max-width .6s cubic-bezier(.2,.7,.2,1); }
.search.is-active .search__form, .search.is-active .search__completions { max-width: 100%; }
.results > .section-head { border-top: 0; padding-top: 18px; margin-bottom: 24px; }`;
await page.goto(BASE + '#/?q=grain'); await page.waitForTimeout(1000);
await page.addStyleTag({ content: FIX }); await page.waitForTimeout(1000);
console.log('fix grain form', await r('.search__form'), 'tags', await r('.search__tags'), 'card', await r('.results .card'));
await page.screenshot({ path: `${S}/out/search-grain-fix.png` });
// idle with fix
await page.goto(BASE + '#/'); await page.waitForTimeout(800);
await page.addStyleTag({ content: FIX }); await page.waitForTimeout(800);
console.log('fix idle form', await r('.search__form'), 'tags', await r('.search__tags'));
// type first char, mid-transition
await page.locator('.search__input').type('g'); await page.waitForTimeout(150);
console.log('fix mid form', await r('.search__form'));
await page.screenshot({ path: `${S}/out/search-mid-fix.png` });
// mobile check
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(BASE + '#/?q=grain'); await page.waitForTimeout(800);
await page.addStyleTag({ content: FIX }); await page.waitForTimeout(800);
console.log('fix mobile form', await r('.search__form'), 'tags', await r('.search__tags'), 'card', await r('.results .card'));
await page.screenshot({ path: `${S}/out/search-mobile-fix.png` });
await ctx.close();
