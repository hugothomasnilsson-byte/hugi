import { open, BASE, S } from './zz-vd-lib.mjs';
const { ctx, page } = await open({ deviceScaleFactor: 4 });
await page.goto(BASE + '#/all'); await page.waitForTimeout(1500);
const d = await page.evaluate(() => {
  const y = document.querySelector('.wordmark__y'); const yr = y.getBoundingClientRect();
  const after = getComputedStyle(y, '::after');
  const name = document.querySelector('.wordmark__name').getBoundingClientRect();
  const link = document.querySelector('.header__link'); const lr = link.getBoundingClientRect();
  // baseline via inline-block probe
  const probe = (el) => { const s = document.createElement('span'); s.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'; el.appendChild(s); const t = s.getBoundingClientRect().top; s.remove(); return Math.round(t * 10) / 10; };
  return { y: [yr.left, yr.top, yr.right, yr.bottom].map(Math.round), afterLeft: after.left, afterBottom: after.bottom, afterW: after.width, afterML: after.marginLeft, name: [name.left, name.top, name.right, name.bottom].map(Math.round), wordBase: probe(document.querySelector('.wordmark__name')), linkBase: probe(link), link: [lr.left, lr.top, lr.right, lr.bottom].map(Math.round), headerAlign: getComputedStyle(document.querySelector('.header')).alignItems };
});
console.log(JSON.stringify(d));
await page.screenshot({ path: `${S}/out/wordmark.png`, clip: { x: 40, y: 10, width: 120, height: 50 } });
await page.screenshot({ path: `${S}/out/header.png`, clip: { x: 0, y: 0, width: 1440, height: 70 }, scale: 'css' });
await page.addStyleTag({ content: `.wordmark__y::after { content: none; }
.wordmark__name { position: relative; display: inline-block; padding-bottom: .14em; }
.wordmark__name::after { content: ''; position: absolute; left: 0; bottom: 0; width: 100%; height: 1px; background: var(--accent); transform: scaleX(.22); transform-origin: left; transition: transform .5s var(--ease-out); }
.header { align-items: baseline; }` });
await page.waitForTimeout(400);
const d2 = await page.evaluate(() => {
  const probe = (el) => { const s = document.createElement('span'); s.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'; el.appendChild(s); const t = s.getBoundingClientRect().top; s.remove(); return Math.round(t * 10) / 10; };
  const add = document.querySelector('.header__add').getBoundingClientRect();
  return { wordBase: probe(document.querySelector('.wordmark__name')), linkBase: probe(document.querySelector('.header__link')), add: [add.top, add.bottom].map(Math.round), header: Math.round(document.querySelector('.header').getBoundingClientRect().height) };
});
console.log('fix', JSON.stringify(d2));
await page.screenshot({ path: `${S}/out/wordmark-fix.png`, clip: { x: 40, y: 10, width: 120, height: 50 } });
await page.screenshot({ path: `${S}/out/header-fix.png`, clip: { x: 0, y: 0, width: 1440, height: 70 }, scale: 'css' });
await ctx.close();
