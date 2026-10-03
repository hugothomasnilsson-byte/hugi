import { analyzeImage, getState, saveDraft, type DraftImage } from '../state/store';
import { prepareImage } from '../lib/images';
import { newId } from '../lib/id';

/**
 * Example entries for the hosted preview only (built with VITE_DEMO=1). Every one
 * carries #example so it is clearly marked and can be removed in one go.
 */

type Kind = 'poster' | 'sunset' | 'quote' | 'cyanotype' | 'specimen' | 'ochre';

interface Sample {
  title: string;
  notes: string;
  credit?: string;
  link?: string;
  tags: string[];
  image?: { kind: Kind; w: number; h: number };
}

const SAMPLES: Sample[] = [
  {
    title: '',
    notes: 'A sentence worth keeping: the details are not the details, they make the design.',
    credit: 'Charles Eames',
    tags: ['quote', 'writing'],
  },
  {
    title: 'Kiln ochres',
    notes: 'Iron oxide glazes after a reduction firing. The darkest band is where the kiln ran hottest.',
    tags: ['ceramic', 'colour'],
    image: { kind: 'ochre', w: 1000, h: 1300 },
  },
  {
    title: 'Specimen: Garalde',
    notes: 'Old-style figures and a calligraphic italic. Compare the g with the one in the poster.',
    tags: ['type', 'specimen'],
    image: { kind: 'specimen', w: 1400, h: 900 },
  },
  {
    title: 'Cyanotype study',
    notes: 'Prussian blue on cotton rag. Exposure 12 minutes in March sun.',
    tags: ['print', 'blue', 'process'],
    image: { kind: 'cyanotype', w: 1200, h: 1200 },
  },
  {
    title: 'Note on attention',
    notes: '',
    tags: ['writing'],
    image: { kind: 'quote', w: 1170, h: 1500 },
  },
  {
    title: 'Portra at dusk',
    notes: 'Warm skin tones, pushed one stop. Grain is visible but soft.',
    tags: ['film', 'colour'],
    image: { kind: 'sunset', w: 1400, h: 933 },
  },
  {
    title: 'Swiss poster, Basel 1959',
    notes: 'Grid discipline with one red diagonal. The type sits on a strict baseline and the colour does all the shouting.',
    credit: 'In the manner of the Basel school',
    tags: ['poster', 'swiss', 'type'],
    image: { kind: 'poster', w: 900, h: 1260 },
  },
];

function draw(kind: Kind, w: number, h: number): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d')!;
  if (kind === 'poster') {
    x.fillStyle = '#efe9dc';
    x.fillRect(0, 0, w, h);
    x.fillStyle = '#c8331e';
    x.save();
    x.translate(w * 0.6, h * 0.15);
    x.rotate(-0.5);
    x.fillRect(-60, 0, 120, h * 1.1);
    x.restore();
    x.fillStyle = '#151515';
    x.font = 'bold 92px Helvetica, Arial, sans-serif';
    x.fillText('Kunst', 60, h - 260);
    x.fillText('gewerbe', 60, h - 160);
    x.font = '28px Helvetica, Arial, sans-serif';
    x.fillText('Museum Basel  ·  Ausstellung 1959', 60, h - 90);
  } else if (kind === 'sunset') {
    const g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#2b3a67');
    g.addColorStop(0.5, '#e07a5f');
    g.addColorStop(0.75, '#f2cc8f');
    g.addColorStop(1, '#3d2c2e');
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    x.fillStyle = '#1d1716';
    x.beginPath();
    x.moveTo(0, h * 0.78);
    for (let i = 0; i <= w; i += 40) x.lineTo(i, h * 0.74 + Math.sin(i / 90) * 24);
    x.lineTo(w, h);
    x.lineTo(0, h);
    x.fill();
  } else if (kind === 'quote') {
    x.fillStyle = '#121212';
    x.fillRect(0, 0, w, h);
    x.fillStyle = '#e8e8e8';
    x.font = '48px Georgia, serif';
    ['Attention is the rarest', 'and purest form of', 'generosity.', '', '— Simone Weil'].forEach((l, i) =>
      x.fillText(l, 80, 220 + i * 80),
    );
    x.fillStyle = '#777';
    x.font = '30px Arial, sans-serif';
    x.fillText('Saved from a letter, 1942', 80, h - 120);
  } else if (kind === 'cyanotype') {
    x.fillStyle = '#1b3f8b';
    x.fillRect(0, 0, w, h);
    x.fillStyle = '#e9eef5';
    for (let i = 0; i < 9; i++) {
      x.globalAlpha = 0.5 + i * 0.05;
      x.beginPath();
      x.ellipse(w / 2 + Math.cos(i) * 200, h / 2 + Math.sin(i * 1.3) * 220, 40 + i * 12, 160, i, 0, Math.PI * 2);
      x.fill();
    }
    x.globalAlpha = 1;
  } else if (kind === 'specimen') {
    x.fillStyle = '#faf8f2';
    x.fillRect(0, 0, w, h);
    x.fillStyle = '#1a1a1a';
    x.font = '220px Georgia, serif';
    x.fillText('Aa Gg', 70, 330);
    x.font = 'italic 64px Georgia, serif';
    x.fillText('Hamburgefonstiv', 80, 520);
    x.font = '34px Georgia, serif';
    x.fillText('ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789', 80, 640);
  } else {
    ['#c38d2f', '#a65f2a', '#d9b56c', '#6e3b1f', '#e8d3a6'].forEach((col, i) => {
      x.fillStyle = col;
      x.fillRect(0, (i * h) / 5, w, h / 5 + 1);
    });
  }
  return new Promise((resolve) => c.toBlob((b) => resolve(b!), 'image/png'));
}

const FLAG = 'syble:demo-seeded';

/** Adds the examples once, on a first visit with an empty library. */
export async function seedExamples() {
  try {
    if (localStorage.getItem(FLAG) || getState().entries.size > 0) return;
    localStorage.setItem(FLAG, '1');
  } catch {
    if (getState().entries.size > 0) return;
  }
  for (const s of SAMPLES) {
    const images: DraftImage[] = [];
    if (s.image) {
      const prepared = await prepareImage(await draw(s.image.kind, s.image.w, s.image.h));
      const id = newId();
      analyzeImage(id, prepared.full, prepared.thumb);
      images.push({ id, prepared });
    }
    await saveDraft({
      title: s.title,
      notes: s.notes,
      link: s.link ?? '',
      credit: s.credit ?? '',
      tags: [...s.tags, 'example'],
      images,
    });
  }
}
