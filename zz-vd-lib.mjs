import { chromium, devices } from '@playwright/test';
export const S = '/tmp/claude-0/-home-user-hugi/d31bd7d8-265b-501f-89a5-26eccfff9fac/scratchpad/vdesign';
export const BASE = 'http://localhost:4183/';
export const UDD = S + '/udd';
export async function open(opts = {}) {
  const ctx = await chromium.launchPersistentContext(UDD, { executablePath: '/opt/pw-browsers/chromium', viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', ...opts });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  return { ctx, page };
}
export const SAMPLES = [
  { title: 'Swiss poster, Basel 1959', notes: 'Grid discipline with one red diagonal. The type sits on a strict baseline and the colour does all the shouting.', credit: 'Armin Hofmann', link: 'https://www.are.na/block/12345', tags: ['poster', 'swiss', 'type'], draws: [{ w: 900, h: 1260, kind: 'poster' }] },
  { title: 'Portra at dusk', notes: 'Warm skin tones, pushed one stop. Grain is visible but soft.', tags: ['film', 'colour'], draws: [{ w: 1400, h: 933, kind: 'sunset' }] },
  { title: 'Note on attention', notes: '', tags: ['writing'], draws: [{ w: 1170, h: 1500, kind: 'dark' }] },
  { title: 'Cyanotype study', notes: 'Prussian blue on cotton rag. Exposure 12 min in March sun.', tags: ['print', 'blue', 'process'], draws: [{ w: 1200, h: 1200, kind: 'cyan' }] },
  { title: 'Specimen: Garalde', notes: 'Old-style figures and a calligraphic italic.', tags: ['type', 'specimen'], draws: [{ w: 1400, h: 900, kind: 'specimen' }] },
  { title: 'Kiln ochres', notes: 'Iron oxide glazes after reduction firing.', tags: ['ceramic', 'colour'], draws: [{ w: 1000, h: 1300, kind: 'ochre' }] },
  { title: '', notes: 'A sentence worth keeping: the details are not the details, they make the design.', tags: ['quote', 'writing'], draws: [] },
  { title: 'Grain study, three plates', notes: 'Film grain against glaze: a set of three references.', tags: ['grain', 'film', 'colour'], draws: [{ w: 1000, h: 1300, kind: 'ochre' }, { w: 1400, h: 900, kind: 'specimen' }, { w: 1200, h: 1200, kind: 'cyan' }] },
];
export async function img(page, d) {
  const b64 = await page.evaluate((d) => {
    const c = document.createElement('canvas'); c.width = d.w; c.height = d.h; const x = c.getContext('2d');
    const W = d.w, H = d.h;
    if (d.kind === 'poster') {
      x.fillStyle = '#efe9dc'; x.fillRect(0,0,W,H);
      x.fillStyle = '#c8331e'; x.save(); x.translate(W*0.6,H*0.15); x.rotate(-0.5); x.fillRect(-60,0,120,H*1.1); x.restore();
      x.fillStyle = '#151515'; x.font = 'bold 92px Helvetica, Arial'; x.fillText('Kunst', 60, H-260); x.fillText('gewerbe', 60, H-160);
      x.font = '28px Helvetica, Arial'; x.fillText('Museum Basel  ·  Ausstellung 1959', 60, H-90);
    } else if (d.kind === 'sunset') {
      const g = x.createLinearGradient(0,0,0,H); g.addColorStop(0,'#2b3a67'); g.addColorStop(0.5,'#e07a5f'); g.addColorStop(0.75,'#f2cc8f'); g.addColorStop(1,'#3d2c2e');
      x.fillStyle = g; x.fillRect(0,0,W,H); x.fillStyle = '#1d1716'; x.beginPath(); x.moveTo(0,H*0.78); for (let i=0;i<=W;i+=40) x.lineTo(i, H*0.74 + Math.sin(i/90)*24); x.lineTo(W,H); x.lineTo(0,H); x.fill();
    } else if (d.kind === 'dark') {
      x.fillStyle = '#121212'; x.fillRect(0,0,W,H); x.fillStyle = '#e8e8e8'; x.font = '48px Georgia';
      ['Attention is the rarest', 'and purest form of', 'generosity.', '', '— Simone Weil'].forEach((l,i)=>x.fillText(l, 80, 220+i*80));
      x.fillStyle = '#777'; x.font = '30px Arial'; x.fillText('Saved from a letter, 1942', 80, H-120);
    } else if (d.kind === 'cyan') {
      x.fillStyle = '#1b3f8b'; x.fillRect(0,0,W,H); x.fillStyle = '#e9eef5';
      for (let i=0;i<9;i++){ x.globalAlpha = 0.5+i*0.05; x.beginPath(); x.ellipse(W/2 + Math.cos(i)*200, H/2 + Math.sin(i*1.3)*220, 40+i*12, 160, i, 0, Math.PI*2); x.fill(); }
      x.globalAlpha = 1;
    } else if (d.kind === 'specimen') {
      x.fillStyle = '#faf8f2'; x.fillRect(0,0,W,H); x.fillStyle = '#1a1a1a'; x.font = '220px Georgia'; x.fillText('Aa Gg', 70, 330);
      x.font = 'italic 64px Georgia'; x.fillText('Hamburgefonstiv', 80, 520); x.font = '34px Georgia'; x.fillText('ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789', 80, 640);
    } else if (d.kind === 'ochre') {
      const cols = ['#c38d2f','#a65f2a','#d9b56c','#6e3b1f','#e8d3a6'];
      cols.forEach((c,i)=>{ x.fillStyle=c; x.fillRect(0, i*H/5, W, H/5+1); });
    }
    return c.toDataURL('image/png').split(',')[1];
  }, d);
  return Buffer.from(b64, 'base64');
}
