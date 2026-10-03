import 'fake-indexeddb/auto';
import { strFromU8, strToU8, unzipSync, zipSync, type UnzipFileInfo, type Zippable } from 'fflate';
import { deleteDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BackupError,
  ZipWriter,
  backupFileName,
  exportLibrary,
  importLibrary,
  type BackupManifest,
} from '../../src/lib/backup';
import * as db from '../../src/lib/db';
import type { Entry, ImageMeta } from '../../src/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function entry(id: string, patch: Partial<Entry> = {}): Entry {
  return {
    id,
    title: `Entry ${id}`,
    notes: '',
    link: '',
    credit: '',
    tags: [],
    imageIds: [],
    dismissedTags: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    ...patch,
  };
}

function meta(id: string, entryId: string, patch: Partial<ImageMeta> = {}): ImageMeta {
  return {
    id,
    entryId,
    width: 1200,
    height: 800,
    mime: 'image/png',
    size: `full:${id}`.length,
    text: '',
    textEdited: false,
    ocrStatus: 'done',
    palette: [],
    createdAt: 1_000,
    ...patch,
  };
}

function image(id: string, entryId: string, patch: Partial<ImageMeta> = {}, content = id) {
  const m = meta(id, entryId, { size: `full:${content}`.length, ...patch });
  return {
    meta: m,
    blobs: {
      id,
      full: new Blob([`full:${content}`], { type: m.mime }),
      thumb: new Blob([`thumb:${content}`], { type: 'image/webp' }),
    },
  };
}

async function text(blob: Blob): Promise<string> {
  return new TextDecoder().decode(await db.blobToArrayBuffer(blob));
}

async function unzip(blob: Blob) {
  const info = new Map<string, UnzipFileInfo>();
  const files = unzipSync(new Uint8Array(await db.blobToArrayBuffer(blob)), {
    filter: (f) => {
      info.set(f.name, f);
      return true;
    },
  });
  return { files, info, manifest: JSON.parse(strFromU8(files['manifest.json'])) as BackupManifest };
}

function zipBlob(files: Zippable): Blob {
  return new Blob([zipSync(files)], { type: 'application/zip' });
}

function manifestFile(patch: Record<string, unknown> = {}) {
  return strToU8(
    JSON.stringify({
      app: 'syble',
      format: 1,
      exportedAt: new Date(0).toISOString(),
      counts: { entries: 0, images: 0 },
      entries: [],
      images: [],
      ...patch,
    }),
  );
}

/** Two entries, three images (one mid-OCR, one with a palette and edited text). */
async function seedLibrary() {
  await db.saveEntryWithImages(
    entry('e1', {
      title: 'Grain study',
      notes: 'Kodak Portra',
      link: 'https://example.com/a',
      credit: 'Anon',
      tags: ['film', 'grain'],
      dismissedTags: ['kodak'],
      imageIds: ['i1', 'i2'],
      createdAt: 1_000,
      updatedAt: 2_000,
    }),
    [
      image('i1', 'e1', {
        text: 'PORTRA 400',
        textEdited: true,
        palette: [{ hex: '#c9a227', rgb: [201, 162, 39], name: 'ochre', family: 'yellow', weight: 0.6 }],
      }),
      image('i2', 'e1', { mime: 'image/jpeg', ocrStatus: 'running' }),
    ],
  );
  await db.saveEntryWithImages(entry('e2', { title: 'Swiss poster', imageIds: ['i3'], createdAt: 3_000, updatedAt: 3_000 }), [
    image('i3', 'e2', { ocrStatus: 'pending' }),
  ]);
  await db.saveEntry(entry('e3', { title: 'Words only', notes: 'No images here', createdAt: 4_000 }));
}

async function snapshot() {
  const { entries, images } = await db.loadAll();
  const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
  const blobs = await db.getBlobs(images.map((m) => m.id));
  const pixels: Record<string, [string, string, string, string]> = {};
  for (const b of blobs) if (b) pixels[b.id] = [await text(b.full), b.full.type, await text(b.thumb), b.thumb.type];
  return { entries: entries.sort(byId), images: images.sort(byId), pixels };
}

/** True if the 4-byte little-endian ZIP signature occurs anywhere in `bytes`. */
function hasSignature(bytes: Uint8Array, signature: number): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i + 4 <= bytes.length; i++) if (view.getUint32(i, true) === signature) return true;
  return false;
}

/** An image whose full and thumbnail files are `bytes` long. */
function bulkyImage(id: string, entryId: string, bytes: number) {
  const fill = (seed: number) => new Uint8Array(bytes).map((_, i) => (i * seed) & 255);
  return {
    meta: meta(id, entryId, { size: bytes }),
    blobs: {
      id,
      full: new Blob([fill(id.charCodeAt(id.length - 1))], { type: 'image/png' }),
      thumb: new Blob([fill(7)], { type: 'image/webp' }),
    },
  };
}

/**
 * Made with Python's zipfile with every record forced to ZIP64 (EOCD64, locator, extra fields with
 * and without offsets), and a local header whose extra field is longer than the central one, as
 * Info-ZIP and macOS re-zips have. Manifest: entry e1 with image i1 ("full:i1" / "thumb:i1").
 */
const PYTHON_ZIP64 = [
  'UEsDBC0AAAAAAAAAQ122WMrP//////////8NAFgAaW1hZ2VzL2kxLnBuZ/7KQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAQAAcAAAAAAAAABwAAAAAAAABmdWxsOmkxUEsDBC0A',
  'AAAIAAAAQ10V4h6S//////////8OABQAdGh1bWJzL2kxLndlYnABABAACAAAAAAAAAAKAAAAAAAAACvJKM1Nsso0BABQSwME',
  'LQAAAAgAAABDXUGpMuL//////////w0AFABtYW5pZmVzdC5qc29uAQAQAPIBAAAAAAAAEAEAAAAAAAB1kb1uwzAMhF/F0Ny0',
  'chKkQLYOHbIVaKYUHlSLsYlYP7BoNI7hd68ox0Y6FNCgO5JHfNIglPdin4nQfzcgnjJxdq1RFK08Crh61xLoNzbEWq53q1yu',
  '5OYo5T6dZynlicdK11kKsWsQYKlFCPcINKqaxMiBS+1rEKg5FXKeJ6S4P8oT+t02O7fOZB891c5y1TpKQ4JFg/Yy38sWNNKs',
  'SFUpWtw4RBTz+oOebMyTpzEYDAH08d5fTElqJs0jVbQ6r/9YY/HIswBgAmCy/vBA9IOa6ii38V4DVjXHbKIwaBJpSnrxtuLu',
  'gDc2X5kCronIL/jsvEdO4PizagJE05XtJynq0rtoZ9PvedUAEfwHNRbjL1BLAQItAy0AAAAAAAAAQ122WMrP//////////8N',
  'ABQAAAAAAAAAAACAAQAAAABpbWFnZXMvaTEucG5nAQAQAAcAAAAAAAAABwAAAAAAAABQSwECLQMtAAAACAAAAENdFeIekv//',
  '////////DgAcAAAAAAAAAAAAgAH/////dGh1bWJzL2kxLndlYnABABgACAAAAAAAAAAKAAAAAAAAAIoAAAAAAAAAUEsBAi0D',
  'LQAAAAgAAABDXUGpMuL//////////w0AHAAAAAAAAAAAAIAB/////21hbmlmZXN0Lmpzb24BABgA8gEAAAAAAAAQAQAAAAAA',
  'ANQAAAAAAAAAUEsGBiwAAAAAAAAALQAtAAAAAAAAAAAAAwAAAAAAAAADAAAAAAAAAP4AAAAAAAAAIwIAAAAAAABQSwYHAAAA',
  'ACEDAAAAAAAAAQAAAFBLBQYAAAAAAwADAP4AAAAjAgAAAAA=',
].join('');

const NODE_BUFFER = 'node:buffer';
async function nativeBlobClass(): Promise<typeof Blob> {
  return ((await import(/* @vite-ignore */ NODE_BUFFER)) as { Blob: typeof Blob }).Blob;
}

beforeEach(async () => {
  await db.closeDb();
  await deleteDB(db.DB_NAME);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe('backupFileName', () => {
  it('uses the local calendar date, zero-padded', () => {
    expect(backupFileName(new Date(2026, 0, 5, 23, 59))).toBe('syble-backup-2026-01-05.zip');
    expect(backupFileName(new Date(2026, 9, 3, 0, 1))).toBe('syble-backup-2026-10-03.zip');
  });
});

describe('exportLibrary', () => {
  it('writes the manifest, images and thumbnails with the documented layout', async () => {
    await seedLibrary();
    const progress: number[] = [];
    const blob = await exportLibrary((p) => progress.push(p));

    expect(blob.type).toBe('application/zip');
    const { files, info, manifest } = await unzip(blob);
    expect(Object.keys(files).sort()).toEqual([
      'images/i1.png',
      'images/i2.jpg',
      'images/i3.png',
      'manifest.json',
      'thumbs/i1.webp',
      'thumbs/i2.webp',
      'thumbs/i3.webp',
    ]);
    expect(strFromU8(files['images/i2.jpg'])).toBe('full:i2');
    expect(strFromU8(files['thumbs/i2.webp'])).toBe('thumb:i2');

    // Images are stored as-is; only the manifest is deflated.
    expect(info.get('images/i1.png')?.compression).toBe(0);
    expect(info.get('thumbs/i1.webp')?.compression).toBe(0);
    expect(info.get('manifest.json')?.compression).toBe(8);

    expect(manifest).toMatchObject({ app: 'syble', format: 1, counts: { entries: 3, images: 3 } });
    expect(new Date(manifest.exportedAt).toISOString()).toBe(manifest.exportedAt);
    expect(manifest.entries.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
    expect(manifest.images.find((m) => m.id === 'i1')).toEqual((await db.loadAll()).images.find((m) => m.id === 'i1'));

    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it('exports an empty library', async () => {
    const { files, manifest } = await unzip(await exportLibrary());
    expect(Object.keys(files)).toEqual(['manifest.json']);
    expect(manifest).toMatchObject({ counts: { entries: 0, images: 0 }, entries: [], images: [] });
  });

  it('leaves out images whose pixel data is gone', async () => {
    await seedLibrary();
    // Simulate damage: pixel data vanished but the metadata remained.
    const { openDB } = await import('idb');
    const conn = await openDB(db.DB_NAME);
    await conn.delete('blobs', 'i1');
    conn.close();

    const { files, manifest } = await unzip(await exportLibrary());
    expect(files['images/i1.png']).toBeUndefined();
    expect(manifest.images.map((m) => m.id).sort()).toEqual(['i2', 'i3']);
    expect(manifest.entries.find((e) => e.id === 'e1')?.imageIds).toEqual(['i2']);
    expect(manifest.counts.images).toBe(2);
  });
});

describe('ZipWriter', () => {
  it('computes standard CRC-32 checksums', async () => {
    const zip = new ZipWriter();
    await zip.addStored('check.txt', new Blob(['123456789']));
    const bytes = new Uint8Array(await db.blobToArrayBuffer(zip.finish()));
    // CRC-32 check value from the ZIP specification's polynomial.
    expect(new DataView(bytes.buffer).getUint32(14, true)).toBe(0xcbf43926);
    expect(strFromU8(unzipSync(bytes)['check.txt'])).toBe('123456789');
  });

  it('writes ZIP64 records when sizes and offsets need them, readable by fflate and by import', async () => {
    await seedLibrary();
    const { files } = await unzip(await exportLibrary());
    const zip = new ZipWriter(0); // every size and offset counts as too large for 32 bits
    for (const [name, data] of Object.entries(files)) {
      if (name === 'manifest.json') zip.addDeflated(name, data, 6);
      else await zip.addStored(name, new Blob([data]));
    }
    const archive = zip.finish();
    const bytes = new Uint8Array(await db.blobToArrayBuffer(archive));
    expect(hasSignature(bytes, 0x06064b50)).toBe(true); // ZIP64 end of central directory
    expect(hasSignature(bytes, 0x07064b50)).toBe(true); // ZIP64 locator
    // Every central record defers its sizes and offset to a ZIP64 extra field (sizes, sizes, offset).
    const view = new DataView(bytes.buffer);
    const central = [...bytes.keys()].filter((i) => i + 46 <= bytes.length && view.getUint32(i, true) === 0x02014b50);
    expect(central).toHaveLength(Object.keys(files).length);
    for (const at of central) {
      expect([view.getUint32(at + 20, true), view.getUint32(at + 24, true), view.getUint32(at + 42, true)]).toEqual([
        0xffffffff, 0xffffffff, 0xffffffff,
      ]);
      const extra = at + 46 + view.getUint16(at + 28, true);
      expect([view.getUint16(extra, true), view.getUint16(extra + 2, true)]).toEqual([0x0001, 24]);
      // ...and so does its local header (for streaming readers), with both sizes.
      const local = view.getUint32(at + 42, true) === 0xffffffff ? Number(view.getBigUint64(extra + 20, true)) : -1;
      expect([view.getUint32(local + 18, true), view.getUint32(local + 22, true)]).toEqual([0xffffffff, 0xffffffff]);
      const localExtra = local + 30 + view.getUint16(local + 26, true);
      expect([view.getUint16(localExtra, true), view.getUint16(localExtra + 2, true)]).toEqual([0x0001, 16]);
    }

    // An independent reader sees the same files.
    const reread = unzipSync(bytes);
    expect(Object.keys(reread).sort()).toEqual(Object.keys(files).sort());
    for (const name of Object.keys(files)) expect(reread[name]).toEqual(files[name]);

    const before = await snapshot();
    await db.clearLibrary();
    expect(await importLibrary(archive, 'replace')).toEqual({ entries: 3, images: 3, skipped: 0 });
    const after = await snapshot();
    expect(after.entries).toEqual(before.entries);
    expect(after.pixels).toEqual(before.pixels);
  });
});

describe.each([
  ['jsdom Blobs (byte fallback)', false],
  ['native Blobs', true],
])('round trip with %s', (_label, native) => {
  beforeEach(async () => {
    if (native) vi.stubGlobal('Blob', await nativeBlobClass());
  });

  it('replace restores the library exactly, re-queueing interrupted OCR', async () => {
    await seedLibrary();
    const before = await snapshot();
    const backup = await exportLibrary();

    // Change the library after the backup was made.
    await db.deleteEntry('e2');
    await db.saveEntryWithImages(entry('extra', { imageIds: ['x1'] }), [image('x1', 'extra')]);

    const progress: number[] = [];
    const summary = await importLibrary(backup, 'replace', (p) => progress.push(p));
    expect(summary).toEqual({ entries: 3, images: 3, skipped: 0 });
    expect(progress.at(-1)).toBe(1);

    const after = await snapshot();
    expect(after.entries).toEqual(before.entries);
    expect(after.pixels).toEqual(before.pixels);
    const expected = before.images.map((m) => (m.ocrStatus === 'running' ? { ...m, ocrStatus: 'pending' } : m));
    expect(after.images).toEqual(expected);
    expect(after.images.find((m) => m.id === 'i2')?.ocrStatus).toBe('pending');
  });
});

describe('importLibrary: archives', () => {
  it('reads the archive piecewise, never the whole file at once', async () => {
    await db.saveEntryWithImages(
      entry('e1', { imageIds: ['i1', 'i2', 'i3'] }),
      ['i1', 'i2', 'i3'].map((id) => bulkyImage(id, 'e1', 60_000)),
    );
    const before = await snapshot();
    const backup = await exportLibrary();
    await db.clearLibrary();

    class PickedFile extends Blob {
      largestRead = 0;
      // Like a multi-gigabyte backup on a phone: too big to read into one buffer.
      arrayBuffer(): Promise<ArrayBuffer> {
        return Promise.reject(new RangeError('Array buffer allocation failed'));
      }
      slice(start?: number, end?: number, type?: string): Blob {
        const part = super.slice(start, end, type);
        this.largestRead = Math.max(this.largestRead, part.size);
        return part;
      }
    }
    const file = new PickedFile([backup]);
    expect(await importLibrary(file, 'replace')).toEqual({ entries: 1, images: 3, skipped: 0 });
    expect(file.largestRead).toBeLessThan(backup.size / 3);
    expect((await snapshot()).pixels).toEqual(before.pixels);
  });

  it('reads a ZIP64 archive written by another tool', async () => {
    const bytes = Uint8Array.from(atob(PYTHON_ZIP64), (c) => c.charCodeAt(0));
    expect(await importLibrary(new Blob([bytes]), 'replace')).toEqual({ entries: 1, images: 1, skipped: 0 });
    const { entries } = await db.loadAll();
    expect(entries[0]).toMatchObject({ id: 'e1', title: 'Zip64 from Python', imageIds: ['i1'] });
    const blobs = await db.getImageBlobs('i1');
    expect(await text(blobs!.full)).toBe('full:i1'); // stored, behind a long local extra field
    expect(await text(blobs!.thumb)).toBe('thumb:i1'); // deflated
  });

  it('round-trips ids, tags and text beyond ASCII', async () => {
    const id = 'bild-ø-日本-🙂';
    await db.saveEntryWithImages(
      entry('é1', { title: 'Café ☕', tags: ['café', '日本'], notes: 'Grüße 🙂', imageIds: [id] }),
      [image(id, 'é1', { text: 'Ελληνικά', size: new TextEncoder().encode(`full:${id}`).length })],
    );
    const before = await snapshot();
    const backup = await exportLibrary();
    await db.clearLibrary();

    expect(await importLibrary(backup, 'replace')).toEqual({ entries: 1, images: 1, skipped: 0 });
    expect(await snapshot()).toEqual(before);
  });

  it('rejects damaged image data before touching the library', async () => {
    await seedLibrary();
    const before = await snapshot();
    const name = 'images/x1.png';
    const archive = zipSync({
      [name]: [new Uint8Array(4096).map((_, i) => (i * 7) & 255), { level: 6 }],
      'manifest.json': manifestFile({ entries: [entry('x', { imageIds: ['x1'] })], images: [meta('x1', 'x')] }),
    });
    // The first file's deflate stream starts right after its local header; scramble it.
    archive.fill(0xff, 30 + name.length, 30 + name.length + 16);

    const attempt = importLibrary(new Blob([archive]), 'replace');
    await expect(attempt).rejects.toBeInstanceOf(BackupError);
    await expect(attempt).rejects.toThrow(/damaged/);
    expect(await snapshot()).toEqual(before);
  });
});

describe('importLibrary: merge', () => {
  it('adds new entries and keeps whichever copy was edited last, images and all', async () => {
    // The backup: A and B edited at t=200, D new.
    await db.saveEntryWithImages(entry('A', { title: 'A from backup', imageIds: ['a1'], updatedAt: 200 }), [
      image('a1', 'A', {}, 'a1-backup'),
    ]);
    await db.saveEntryWithImages(entry('B', { title: 'B from backup', imageIds: ['b2'], updatedAt: 200 }), [
      image('b2', 'B'),
    ]);
    await db.saveEntryWithImages(entry('D', { title: 'D from backup', imageIds: ['d1'], updatedAt: 200 }), [
      image('d1', 'D'),
    ]);
    const backup = await exportLibrary();

    // This device: A edited later (t=300), B older (t=100) with a different image, C local only.
    await db.clearLibrary();
    await db.saveEntryWithImages(entry('A', { title: 'A edited here', imageIds: ['a1'], updatedAt: 300 }), [
      image('a1', 'A', {}, 'a1-local'),
    ]);
    await db.saveEntryWithImages(entry('B', { title: 'B old', imageIds: ['b1'], updatedAt: 100 }), [image('b1', 'B')]);
    await db.saveEntry(entry('C', { title: 'C local only' }));

    const summary = await importLibrary(backup, 'merge');
    expect(summary).toEqual({ entries: 2, images: 2, skipped: 2 }); // A and its image kept local

    const { entries, images, pixels } = await snapshot();
    expect(entries.map((e) => [e.id, e.title])).toEqual([
      ['A', 'A edited here'],
      ['B', 'B from backup'],
      ['C', 'C local only'],
      ['D', 'D from backup'],
    ]);
    expect(images.map((m) => m.id)).toEqual(['a1', 'b2', 'd1']);
    expect(pixels.a1[0]).toBe('full:a1-local');
    expect(await db.getImageBlobs('b1')).toBeUndefined(); // replaced wholesale
    expect(entries.find((e) => e.id === 'B')?.imageIds).toEqual(['b2']);
  });

  it('importing the same backup twice changes nothing the second time', async () => {
    await seedLibrary();
    const backup = await exportLibrary();
    await db.clearLibrary();

    expect(await importLibrary(backup, 'merge')).toEqual({ entries: 3, images: 3, skipped: 0 });
    const once = await snapshot();
    expect(await importLibrary(backup, 'merge')).toEqual({ entries: 0, images: 0, skipped: 6 });
    expect(await snapshot()).toEqual(once);
  });

  it('a newer copy from a damaged backup keeps local images whose file it lacks', async () => {
    await db.saveEntryWithImages(entry('A', { imageIds: ['a1', 'a2', 'a3'], updatedAt: 100 }), [
      image('a1', 'A', {}, 'a1-local'),
      image('a2', 'A', {}, 'a2-local'),
      image('a3', 'A', {}, 'a3-local'),
    ]);
    const files: Zippable = {
      'manifest.json': manifestFile({
        entries: [entry('A', { title: 'edited later', imageIds: ['a2', 'a1', 'a4'], updatedAt: 200 })],
        images: [meta('a1', 'A'), meta('a2', 'A'), meta('a4', 'A')],
      }),
      'images/a1.png': strToU8('full:a1-backup'),
      'images/a4.png': strToU8('full:a4-backup'),
      // a2's file is missing; a3 was removed from the entry after the local copy was made.
    };

    expect(await importLibrary(zipBlob(files), 'merge')).toEqual({ entries: 1, images: 2, skipped: 1 });
    const { entries, images, pixels } = await snapshot();
    expect(entries[0]).toMatchObject({ title: 'edited later', imageIds: ['a2', 'a1', 'a4'] });
    expect(images.map((m) => m.id)).toEqual(['a1', 'a2', 'a4']);
    expect(pixels.a1[0]).toBe('full:a1-backup');
    expect(pixels.a2[0]).toBe('full:a2-local');
    expect(await db.getImageBlobs('a3')).toBeUndefined();
  });

  it('never takes over an image id owned by another local entry', async () => {
    await db.saveEntryWithImages(entry('new', { imageIds: ['shared'] }), [image('shared', 'new', {}, 'from-backup')]);
    const backup = await exportLibrary();
    await db.clearLibrary();
    await db.saveEntryWithImages(entry('mine', { imageIds: ['shared'] }), [image('shared', 'mine', {}, 'mine')]);

    expect(await importLibrary(backup, 'merge')).toEqual({ entries: 1, images: 0, skipped: 1 });
    const { entries, images, pixels } = await snapshot();
    expect(entries.find((e) => e.id === 'new')?.imageIds).toEqual([]);
    expect(images.map((m) => [m.id, m.entryId])).toEqual([['shared', 'mine']]);
    expect(pixels.shared[0]).toBe('full:mine');
  });
});

describe('importLibrary: replace', () => {
  it('an empty backup empties the library', async () => {
    await seedLibrary();
    const summary = await importLibrary(zipBlob({ 'manifest.json': manifestFile() }), 'replace');
    expect(summary).toEqual({ entries: 0, images: 0, skipped: 0 });
    expect(await db.loadAll()).toEqual({ entries: [], images: [] });
  });

  it('writes large backups in several batches', async () => {
    const files: Zippable = {};
    const entries: Entry[] = [];
    const images: ImageMeta[] = [];
    for (let i = 0; i < 450; i++) {
      entries.push(entry(`e${i}`, { imageIds: [`i${i}`], createdAt: i }));
      images.push(meta(`i${i}`, `e${i}`));
      files[`images/i${i}.png`] = strToU8(`full:i${i}`);
    }
    files['manifest.json'] = manifestFile({ entries, images });
    const progress: number[] = [];
    expect(await importLibrary(zipBlob(files), 'replace', (p) => progress.push(p))).toEqual({
      entries: 450,
      images: 450,
      skipped: 0,
    });
    // Progress is reported once per written batch, after the archive has been read (0.1).
    expect(progress.filter((p) => p > 0.1).length).toBeGreaterThanOrEqual(3);
    const { entries: saved, images: savedImages } = await db.loadAll();
    expect(saved).toHaveLength(450);
    expect(savedImages).toHaveLength(450);
    expect(await text((await db.getImageBlobs('i449'))!.full)).toBe('full:i449');
  });
});

describe('importLibrary: sanitising', () => {
  it('fills defaults, normalises tags and drops what cannot be restored', async () => {
    const files: Zippable = {
      'manifest.json': manifestFile({
        entries: [
          { id: 'e1', title: 'Film', tags: ['#Film Grain', 'film-grain', 'Colour', 7, ''], imageIds: ['i1', 'i2', 'i3', 'ghost'], updatedAt: 50 },
          { title: 'no id' },
          'nonsense',
          { id: 'e1', title: 'duplicate' },
        ],
        images: [
          { id: 'i1', entryId: 'e1', width: 640, height: 480, mime: 'image/png', ocrStatus: 'running', text: 'Kodak', palette: [{ hex: '#C9A227', name: 'Ochre', family: 'Yellow', weight: 3 }, { hex: 'red' }] },
          { id: 'i2', entryId: 'e1', mime: 'image/png' }, // file missing
          { id: 'i3', entryId: 'nobody', mime: 'image/png' }, // entry missing
          { id: 'i4', entryId: 'e1', ocrStatus: 'done', text: 'unlisted but belongs to e1' }, // not in imageIds, no mime
          { id: 'i1', entryId: 'e1' }, // duplicate
          { entryId: 'e1' }, // no id
        ],
      }),
      'images/i1.png': strToU8('full:i1'), // no thumbnail
      'images/i3.png': strToU8('full:i3'),
      'images/i4.jpg': strToU8('full:i4'),
      'thumbs/i4.webp': strToU8('thumb:i4'),
      '__MACOSX/._junk': strToU8('junk'),
    };

    const summary = await importLibrary(zipBlob(files), 'replace');
    // Skipped: 3 bad entries + i2, i3, duplicate i1 and the id-less image.
    expect(summary).toEqual({ entries: 1, images: 2, skipped: 7 });

    const { entries, images } = await db.loadAll();
    expect(entries).toHaveLength(1);
    const [e1] = entries;
    expect(e1).toEqual({
      id: 'e1',
      title: 'Film',
      notes: '',
      link: '',
      credit: '',
      tags: ['film-grain', 'colour'],
      imageIds: ['i1', 'i4'],
      dismissedTags: [],
      createdAt: expect.any(Number),
      updatedAt: 50,
    });

    const i1 = images.find((m) => m.id === 'i1')!;
    expect(i1).toMatchObject({ ocrStatus: 'pending', text: 'Kodak', size: 'full:i1'.length, width: 640, height: 480 });
    expect(i1.palette).toEqual([{ hex: '#c9a227', rgb: [201, 162, 39], name: 'ochre', family: 'yellow', weight: 1 }]);
    const i4 = images.find((m) => m.id === 'i4')!;
    expect(i4).toMatchObject({ mime: 'image/jpeg', ocrStatus: 'done', width: 1, height: 1, textEdited: false, palette: [] });

    // A missing thumbnail falls back to the full image.
    const i1Blobs = await db.getImageBlobs('i1');
    expect(await text(i1Blobs!.thumb)).toBe('full:i1');
    expect(i1Blobs!.full.type).toBe('image/png');
    const i4Blobs = await db.getImageBlobs('i4');
    expect(await text(i4Blobs!.thumb)).toBe('thumb:i4');
    expect(i4Blobs!.thumb.type).toBe('image/webp');
  });

  it('treats timestamps outside the range of Date as missing', async () => {
    const files: Zippable = {
      'manifest.json': manifestFile({
        entries: [{ id: 'e1', createdAt: 1e300, updatedAt: 9e15 }, { id: 'e2', createdAt: 5_000, updatedAt: -1 }],
      }),
    };
    const start = Date.now();
    await importLibrary(zipBlob(files), 'replace');
    const { entries } = await db.loadAll();
    const e1 = entries.find((e) => e.id === 'e1')!;
    expect(e1.createdAt).toBeGreaterThanOrEqual(start);
    expect(e1.updatedAt).toBe(e1.createdAt);
    expect(entries.find((e) => e.id === 'e2')).toMatchObject({ createdAt: 5_000, updatedAt: 5_000 });
  });

  it('accepts a backup that was unpacked and re-zipped inside a folder', async () => {
    await seedLibrary();
    const { files } = await unzip(await exportLibrary());
    const nested: Zippable = {};
    for (const [name, data] of Object.entries(files)) nested[`syble-backup-2026-10-03/${name}`] = data;
    await db.clearLibrary();

    expect(await importLibrary(zipBlob(nested), 'replace')).toEqual({ entries: 3, images: 3, skipped: 0 });
  });
});

describe('importLibrary: invalid files', () => {
  const cases: [string, () => Blob, RegExp][] = [
    ['an empty file', () => new Blob([]), /empty/],
    ['random bytes', () => new Blob([new Uint8Array(512).map((_, i) => (i * 7919) % 251)]), /not a readable \.zip/],
    ['a zip without a manifest', () => zipBlob({ 'images/a.png': strToU8('x') }), /no manifest\.json/],
    ['a manifest that is not JSON', () => zipBlob({ 'manifest.json': strToU8('{ nope') }), /damaged/],
    ['a manifest from another app', () => zipBlob({ 'manifest.json': manifestFile({ app: 'other' }) }), /not made by Syble/],
    ['a newer format', () => zipBlob({ 'manifest.json': manifestFile({ format: 2 }) }), /newer version/],
    ['a nonsense format', () => zipBlob({ 'manifest.json': manifestFile({ format: 'one' }) }), /not recognised/],
    ['entries that are not a list', () => zipBlob({ 'manifest.json': manifestFile({ entries: {} }) }), /incomplete/],
    ['images missing from the manifest', () => zipBlob({ 'manifest.json': manifestFile({ images: undefined }) }), /incomplete/],
    [
      'a directory that points outside the file',
      () => {
        const bytes = zipSync({ 'manifest.json': manifestFile() });
        new DataView(bytes.buffer).setUint32(bytes.length - 6, 0x7fff_0000, true); // central directory offset
        return new Blob([bytes]);
      },
      /not a readable \.zip/,
    ],
    [
      'a file the browser cannot read',
      () => {
        class Unreadable extends Blob {
          slice(): Blob {
            const part = new Blob(['x']);
            Object.defineProperty(part, 'arrayBuffer', { value: () => Promise.reject(new DOMException('', 'NotReadableError')) });
            return part;
          }
        }
        return new Unreadable([zipSync({ 'manifest.json': manifestFile() })]);
      },
      /could not be read/,
    ],
  ];

  it.each(cases)('rejects %s with a BackupError and leaves the library untouched', async (_label, make, message) => {
    await seedLibrary();
    const before = await snapshot();
    const attempt = importLibrary(make(), 'replace');
    await expect(attempt).rejects.toBeInstanceOf(BackupError);
    await expect(attempt).rejects.toThrow(message);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects a truncated backup', async () => {
    await seedLibrary();
    const backup = await exportLibrary();
    const truncated = backup.slice(0, Math.floor(backup.size / 2));
    await expect(importLibrary(truncated, 'merge')).rejects.toBeInstanceOf(BackupError);
  });
});
