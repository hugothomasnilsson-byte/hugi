import 'fake-indexeddb/auto';
import { deleteDB, openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../../src/lib/db';
import type { Entry, ImageBlobs, ImageMeta } from '../../src/types';

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
    width: 800,
    height: 600,
    mime: 'image/png',
    size: 10,
    text: '',
    textEdited: false,
    ocrStatus: 'pending',
    palette: [],
    createdAt: 1_000,
    ...patch,
  };
}

function pixels(id: string): ImageBlobs {
  return {
    id,
    full: new Blob([`full:${id}`], { type: 'image/png' }),
    thumb: new Blob([`thumb:${id}`], { type: 'image/webp' }),
  };
}

function image(id: string, entryId: string, patch: Partial<ImageMeta> = {}) {
  return { meta: meta(id, entryId, patch), blobs: pixels(id) };
}

async function text(blob: Blob): Promise<string> {
  return new TextDecoder().decode(await db.blobToArrayBuffer(blob));
}

/** Reads a record straight from IndexedDB, bypassing the module (to see how it was stored). */
async function raw(store: 'entries' | 'images' | 'blobs', id: string): Promise<any> {
  const conn = await openDB(db.DB_NAME);
  try {
    return await conn.get(store, id);
  } finally {
    conn.close();
  }
}

async function rawCount(store: 'entries' | 'images' | 'blobs'): Promise<number> {
  const conn = await openDB(db.DB_NAME);
  try {
    return await conn.count(store);
  } finally {
    conn.close();
  }
}

/** Node's own Blob, which (unlike jsdom's) survives fake-indexeddb's structured clone. */
async function nativeBlobClass(): Promise<typeof Blob> {
  const specifier = 'node:buffer';
  return ((await import(/* @vite-ignore */ specifier)) as { Blob: typeof Blob }).Blob;
}

/**
 * Makes every put of a value holding a Blob throw, by default with DataCloneError like old WebKit.
 * Safari's private browsing fails the same put with UnknownError.
 */
function refuseBlobPuts(errorName = 'DataCloneError') {
  const put = IDBObjectStore.prototype.put;
  return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: any,
    key?: IDBValidKey,
  ) {
    if (value && (value.full instanceof Blob || value.thumb instanceof Blob)) {
      throw new DOMException('An object could not be cloned.', errorName);
    }
    return put.call(this, value, key);
  });
}

beforeEach(async () => {
  await db.closeDb();
  await deleteDB(db.DB_NAME);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe('schema', () => {
  it('creates the three stores and their indexes', async () => {
    await db.loadAll();
    const conn = await openDB(db.DB_NAME);
    expect(conn.version).toBe(1);
    expect([...conn.objectStoreNames].sort()).toEqual(['blobs', 'entries', 'images']);
    const tx = conn.transaction(['entries', 'images', 'blobs']);
    expect(tx.objectStore('entries').keyPath).toBe('id');
    expect([...tx.objectStore('entries').indexNames]).toEqual(['createdAt']);
    expect([...tx.objectStore('images').indexNames]).toEqual(['entryId']);
    expect(tx.objectStore('blobs').keyPath).toBe('id');
    conn.close();
  });
});

describe('entries and images', () => {
  it('starts empty', async () => {
    expect(await db.loadAll()).toEqual({ entries: [], images: [] });
  });

  it('saves an entry with images and loads metadata without pixel data', async () => {
    const e = entry('e1', { imageIds: ['i1', 'i2'], tags: ['film'] });
    await db.saveEntryWithImages(e, [image('i1', 'e1'), image('i2', 'e1', { ocrStatus: 'done', text: 'grain' })]);

    const { entries, images } = await db.loadAll();
    expect(entries).toEqual([e]);
    expect(images.map((m) => m.id).sort()).toEqual(['i1', 'i2']);
    expect(images.find((m) => m.id === 'i2')).toEqual(meta('i2', 'e1', { ocrStatus: 'done', text: 'grain' }));

    const blobs = await db.getImageBlobs('i1');
    expect(blobs?.id).toBe('i1');
    expect(blobs?.full.type).toBe('image/png');
    expect(blobs?.thumb.type).toBe('image/webp');
    expect(await text(blobs!.full)).toBe('full:i1');
    expect(await text(blobs!.thumb)).toBe('thumb:i1');
    expect(await db.getImageBlobs('nope')).toBeUndefined();
  });

  it('saveEntry updates the entry and leaves its images alone', async () => {
    await db.saveEntryWithImages(entry('e1', { imageIds: ['i1'] }), [image('i1', 'e1')]);
    await db.saveEntry(entry('e1', { imageIds: ['i1'], title: 'Renamed', updatedAt: 2_000 }));

    const { entries, images } = await db.loadAll();
    expect(entries[0].title).toBe('Renamed');
    expect(images).toHaveLength(1);
  });

  it('removes dropped images and their pixel data when an entry is re-saved', async () => {
    await db.saveEntryWithImages(entry('e1', { imageIds: ['i1', 'i2'] }), [image('i1', 'e1'), image('i2', 'e1')]);
    await db.saveEntryWithImages(entry('e1', { imageIds: ['i2', 'i3'] }), [image('i3', 'e1')], ['i1']);

    const { images } = await db.loadAll();
    expect(images.map((m) => m.id).sort()).toEqual(['i2', 'i3']);
    expect(await db.getImageBlobs('i1')).toBeUndefined();
    expect(await raw('blobs', 'i1')).toBeUndefined();
    expect(await text((await db.getImageBlobs('i3'))!.full)).toBe('full:i3');
  });

  it('getBlobs returns pixel data in the order asked, with gaps for missing images', async () => {
    await db.saveEntryWithImages(entry('e1'), [image('i1', 'e1'), image('i2', 'e1')]);
    const result = await db.getBlobs(['i2', 'missing', 'i1']);
    expect(result.map((b) => b?.id)).toEqual(['i2', undefined, 'i1']);
    expect(await db.getBlobs([])).toEqual([]);
  });

  it('deleteEntry removes the entry, all of its images and their pixel data', async () => {
    await db.saveEntryWithImages(entry('e1', { imageIds: ['a', 'b'] }), [image('a', 'e1'), image('b', 'e1')]);
    await db.saveEntryWithImages(entry('e2', { imageIds: ['c'] }), [image('c', 'e2')]);

    await db.deleteEntry('e1');

    const { entries, images } = await db.loadAll();
    expect(entries.map((e) => e.id)).toEqual(['e2']);
    expect(images.map((m) => m.id)).toEqual(['c']);
    expect(await rawCount('blobs')).toBe(1);
    expect(await db.getImageBlobs('c')).toBeDefined();
  });

  it('deleting an unknown entry is a no-op', async () => {
    await db.saveEntry(entry('e1'));
    await db.deleteEntry('nope');
    expect((await db.loadAll()).entries).toHaveLength(1);
  });

  it('clearLibrary empties every store', async () => {
    await db.saveEntryWithImages(entry('e1'), [image('i1', 'e1')]);
    await db.clearLibrary();
    expect(await db.loadAll()).toEqual({ entries: [], images: [] });
    expect(await rawCount('blobs')).toBe(0);
  });
});

describe('saveImageMeta', () => {
  it('updates an existing image', async () => {
    await db.saveEntryWithImages(entry('e1'), [image('i1', 'e1')]);
    await db.saveImageMeta(meta('i1', 'e1', { text: 'Swiss poster', ocrStatus: 'done' }));
    expect((await db.loadAll()).images[0]).toMatchObject({ text: 'Swiss poster', ocrStatus: 'done' });
  });

  it('does not resurrect an image whose entry was deleted', async () => {
    await db.saveEntryWithImages(entry('e1'), [image('i1', 'e1')]);
    await db.deleteEntry('e1');
    await db.saveImageMeta(meta('i1', 'e1', { text: 'late OCR result', ocrStatus: 'done' }));
    expect(await db.loadAll()).toEqual({ entries: [], images: [] });
  });

  it('does not resurrect an image deleted concurrently', async () => {
    await db.saveEntryWithImages(entry('e1'), [image('i1', 'e1')]);
    await Promise.all([db.deleteEntry('e1'), db.saveImageMeta(meta('i1', 'e1', { ocrStatus: 'done' }))]);
    expect((await db.loadAll()).images).toEqual([]);
  });
});

describe('atomicity', () => {
  it('a bad record halfway through saveEntryWithImages leaves nothing behind', async () => {
    const broken = image('i2', 'e1');
    (broken.meta as { id?: string }).id = undefined; // put throws DataError synchronously
    await expect(
      db.saveEntryWithImages(entry('e1', { imageIds: ['i1', 'i2'] }), [image('i1', 'e1'), broken]),
    ).rejects.toMatchObject({ name: 'DataError' });

    expect(await db.loadAll()).toEqual({ entries: [], images: [] });
    expect(await rawCount('blobs')).toBe(0);
  });

  it('a failed putMany rolls back its clear as well', async () => {
    await db.saveEntryWithImages(entry('keep', { imageIds: ['k1'] }), [image('k1', 'keep')]);
    const broken = image('x2', 'new');
    (broken.blobs as { id?: string }).id = undefined;
    await expect(
      db.putMany({ clear: true, entries: [entry('new')], images: [image('x1', 'new'), broken] }),
    ).rejects.toBeTruthy();

    const { entries, images } = await db.loadAll();
    expect(entries.map((e) => e.id)).toEqual(['keep']);
    expect(images.map((m) => m.id)).toEqual(['k1']);
    expect(await db.getImageBlobs('k1')).toBeDefined();
  });

  it('putMany replaces the images of the given entries', async () => {
    await db.saveEntryWithImages(entry('e1', { imageIds: ['old1', 'old2'] }), [image('old1', 'e1'), image('old2', 'e1')]);
    await db.saveEntryWithImages(entry('e2', { imageIds: ['other'] }), [image('other', 'e2')]);

    await db.putMany({
      replaceImagesOf: ['e1'],
      entries: [entry('e1', { imageIds: ['old2', 'new'], updatedAt: 5_000 })],
      images: [image('old2', 'e1', { text: 'reimported' }), image('new', 'e1')],
    });

    const { entries, images } = await db.loadAll();
    expect(entries.find((e) => e.id === 'e1')?.updatedAt).toBe(5_000);
    expect(images.map((m) => m.id).sort()).toEqual(['new', 'old2', 'other']);
    expect(images.find((m) => m.id === 'old2')?.text).toBe('reimported');
    expect(await raw('blobs', 'old1')).toBeUndefined();
  });
});

describe('putMany', () => {
  it('keeps the listed images of an entry whose images it replaces', async () => {
    await db.saveEntryWithImages(entry('e1', { imageIds: ['a', 'b', 'c'] }), [
      image('a', 'e1'),
      image('b', 'e1'),
      image('c', 'e1'),
    ]);
    await db.putMany({
      replaceImagesOf: ['e1'],
      keepImageIds: ['b'],
      entries: [entry('e1', { imageIds: ['b', 'd'], updatedAt: 2_000 })],
      images: [image('d', 'e1')],
    });

    const { images } = await db.loadAll();
    expect(images.map((m) => m.id).sort()).toEqual(['b', 'd']);
    expect(await text((await db.getImageBlobs('b'))!.full)).toBe('full:b');
    expect(await raw('blobs', 'a')).toBeUndefined();
    expect(await raw('blobs', 'c')).toBeUndefined();
  });
});

describe('blob storage', () => {
  it('stores Blobs natively when the engine can clone them', async () => {
    vi.stubGlobal('Blob', await nativeBlobClass());
    await db.saveEntryWithImages(entry('e1'), [image('i1', 'e1')]);

    const stored = await raw('blobs', 'i1');
    expect(stored.full).toBeInstanceOf(Blob);
    const blobs = await db.getImageBlobs('i1');
    expect(blobs?.full).toBeInstanceOf(Blob);
    expect(blobs?.full.type).toBe('image/png');
    expect(await text(blobs!.full)).toBe('full:i1');
    expect(await rawCount('blobs')).toBe(1); // the capability probe is never committed
  });

  it('falls back to bytes when a Blob put throws DataCloneError (old WebKit)', async () => {
    vi.stubGlobal('Blob', await nativeBlobClass());
    const put = refuseBlobPuts();
    await db.saveEntryWithImages(entry('e1'), [image('i1', 'e1'), image('i2', 'e1')]);

    const stored = await raw('blobs', 'i1');
    expect(stored.full).not.toBeInstanceOf(Blob);
    expect(stored.full.type).toBe('image/png');
    expect(Object.prototype.toString.call(stored.full.data)).toBe('[object ArrayBuffer]');

    const blobs = await db.getImageBlobs('i1');
    expect(blobs?.full).toBeInstanceOf(Blob);
    expect(blobs?.full.type).toBe('image/png');
    expect(blobs?.thumb.type).toBe('image/webp');
    expect(await text(blobs!.full)).toBe('full:i1');
    expect(await text(blobs!.thumb)).toBe('thumb:i1');
    expect(await rawCount('blobs')).toBe(2);
    // Detected once: later writes go straight to bytes without another refused put.
    const refusals = put.mock.results.filter((r) => r.type === 'throw').length;
    await db.saveEntryWithImages(entry('e2'), [image('i3', 'e2')]);
    expect(put.mock.results.filter((r) => r.type === 'throw').length).toBe(refusals);
  });

  it('falls back to bytes when Safari private browsing refuses Blobs with UnknownError', async () => {
    vi.stubGlobal('Blob', await nativeBlobClass());
    refuseBlobPuts('UnknownError');
    await db.saveEntryWithImages(entry('e1'), [image('i1', 'e1')]);

    expect((await raw('blobs', 'i1')).full).not.toBeInstanceOf(Blob);
    const blobs = await db.getImageBlobs('i1');
    expect(await text(blobs!.full)).toBe('full:i1');
    expect(blobs!.full.type).toBe('image/png');
  });

  it('does not settle on a storage mode when the probe fails for an unrelated reason', async () => {
    vi.stubGlobal('Blob', await nativeBlobClass());
    const refusal = refuseBlobPuts('QuotaExceededError');
    await expect(db.saveEntryWithImages(entry('e1'), [image('i1', 'e1')])).rejects.toMatchObject({
      name: 'QuotaExceededError',
    });
    expect(await db.loadAll()).toEqual({ entries: [], images: [] });

    // Space was freed: the next save probes again and stores Blobs natively.
    refusal.mockRestore();
    await db.saveEntryWithImages(entry('e1'), [image('i1', 'e1')]);
    expect((await raw('blobs', 'i1')).full).toBeInstanceOf(Blob);
  });

  it('detects Blobs that do not survive a round trip and falls back to bytes', async () => {
    // jsdom's Blob is silently cloned into {} by fake-indexeddb: the probe must catch that.
    await db.saveEntryWithImages(entry('e1'), [image('i1', 'e1')]);

    expect(Object.prototype.toString.call((await raw('blobs', 'i1')).full.data)).toBe('[object ArrayBuffer]');
    const blobs = await db.getImageBlobs('i1');
    expect(blobs?.full.size).toBe('full:i1'.length);
    expect(await text(blobs!.full)).toBe('full:i1');
  });

  it('keeps reading byte records after the engine starts accepting Blobs', async () => {
    vi.stubGlobal('Blob', await nativeBlobClass());
    refuseBlobPuts();
    await db.saveEntryWithImages(entry('e1'), [image('i1', 'e1')]);
    vi.restoreAllMocks();
    await db.closeDb();

    await db.saveEntryWithImages(entry('e2'), [image('i2', 'e2')]);
    expect((await raw('blobs', 'i2')).full).toBeInstanceOf(Blob);
    const [old, fresh] = await db.getBlobs(['i1', 'i2']);
    expect(await text(old!.full)).toBe('full:i1');
    expect(await text(fresh!.full)).toBe('full:i2');
  });

  it('putMany uses the same storage mode', async () => {
    vi.stubGlobal('Blob', await nativeBlobClass());
    refuseBlobPuts();
    await db.putMany({ entries: [entry('e1')], images: [image('i1', 'e1')] });
    expect(await text((await db.getImageBlobs('i1'))!.thumb)).toBe('thumb:i1');
  });
});

describe('connection', () => {
  it('steps aside when another connection deletes the database, then reopens', async () => {
    await db.saveEntry(entry('e1'));
    // Would hang forever if the module kept its connection open.
    await deleteDB(db.DB_NAME);
    expect(await db.loadAll()).toEqual({ entries: [], images: [] });
    await db.saveEntry(entry('e2'));
    expect((await db.loadAll()).entries.map((e) => e.id)).toEqual(['e2']);
  });
});

describe('blobToArrayBuffer', () => {
  it('reads bytes with Blob.arrayBuffer', async () => {
    const buffer = await db.blobToArrayBuffer(new Blob([new Uint8Array([1, 2, 3])]));
    expect([...new Uint8Array(buffer)]).toEqual([1, 2, 3]);
  });

  it('falls back to FileReader where Blob.arrayBuffer is missing', async () => {
    const blob = new Blob([new Uint8Array([4, 5])]);
    Object.defineProperty(blob, 'arrayBuffer', { value: undefined });
    const buffer = await db.blobToArrayBuffer(blob);
    expect([...new Uint8Array(buffer)]).toEqual([4, 5]);
  });
});
