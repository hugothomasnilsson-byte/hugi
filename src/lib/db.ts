import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb';
import type { Entry, ID, ImageBlobs, ImageMeta } from '../types';

/**
 * IndexedDB persistence.
 *
 * Three stores: `entries`, `images` (metadata, small enough to load at start-up) and `blobs`
 * (pixel data, read lazily). Every multi-record change runs in a single readwrite transaction,
 * so a crash, a quota error or a bad record never leaves an entry half-written.
 */

export const DB_NAME = 'syble';
const DB_VERSION = 1;

/** A Blob kept as raw bytes, for engines that refuse to store Blobs (old WebKit). */
interface BufferedBlob {
  data: ArrayBuffer;
  type: string;
}

type StoredBlob = Blob | BufferedBlob;

interface StoredBlobs {
  id: ID;
  full: StoredBlob;
  thumb: StoredBlob;
}

interface SybleDB extends DBSchema {
  entries: { key: ID; value: Entry; indexes: { createdAt: number } };
  images: { key: ID; value: ImageMeta; indexes: { entryId: ID } };
  blobs: { key: ID; value: StoredBlobs };
}

type Store = StoreNames<SybleDB>;
const ALL_STORES: Store[] = ['entries', 'images', 'blobs'];

/** An image as written to the library: metadata plus pixel data. */
export interface ImageRecord {
  meta: ImageMeta;
  blobs: ImageBlobs;
}

/* ------------------------------------------------------------------ */
/* Connection                                                          */
/* ------------------------------------------------------------------ */

let connection: Promise<IDBPDatabase<SybleDB>> | null = null;

function openDatabase(): Promise<IDBPDatabase<SybleDB>> {
  if (connection) return connection;
  const opening = openDB<SybleDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('entries', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
        db.createObjectStore('images', { keyPath: 'id' }).createIndex('entryId', 'entryId');
        db.createObjectStore('blobs', { keyPath: 'id' });
      }
    },
    blocked() {
      // Another tab holds an older version open. Syble tabs close their connection when asked
      // (see `blocking`), so the open proceeds as soon as that tab reacts.
      console.warn('Syble is waiting for another open tab to release the library.');
    },
    blocking() {
      // Another tab wants to upgrade or delete the database: step aside so it isn't blocked.
      // The next call here opens a fresh connection.
      forget(opening);
      void opening.then((db) => db.close());
    },
    terminated() {
      // The browser closed the connection abnormally (e.g. storage was cleared).
      forget(opening);
    },
  });
  opening.catch(() => forget(opening));
  connection = opening;
  return opening;
}

function forget(opening: Promise<IDBPDatabase<SybleDB>>) {
  if (connection === opening) connection = null;
}

/** Closes the connection and forgets cached state; the next call reopens. Used by tests and teardown. */
export async function closeDb(): Promise<void> {
  const current = connection;
  connection = null;
  blobStorage = null;
  const db = await current?.catch(() => null);
  db?.close();
}

/* ------------------------------------------------------------------ */
/* Transactions                                                        */
/* ------------------------------------------------------------------ */

type Track = (request: Promise<unknown>) => void;

/**
 * Runs `body` in one readwrite transaction and resolves once it has committed.
 *
 * `body` passes each request promise to `track` as soon as it is issued (one per call, so a
 * later synchronous throw cannot orphan it); every request is then observed even if the
 * transaction aborts halfway. If `body` throws (put throws DataError/DataCloneError
 * synchronously) or any request fails, the transaction is aborted and none of its writes persist.
 */
async function write<S extends Store>(
  stores: S[],
  body: (tx: IDBPTransaction<SybleDB, S[], 'readwrite'>, track: Track) => void | Promise<void>,
): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(stores, 'readwrite');
  const pending: Promise<unknown>[] = [];
  try {
    await body(tx, (request) => pending.push(request));
    await Promise.all([...pending, tx.done]);
  } catch (err) {
    abortQuietly(tx);
    await Promise.allSettled([...pending, tx.done]);
    // When a failed request aborted the transaction, its error says more than the follow-on one.
    throw tx.error ?? err;
  }
}

function abortQuietly(tx: { abort(): void }) {
  try {
    tx.abort();
  } catch {
    // Already committed or aborted.
  }
}

/* ------------------------------------------------------------------ */
/* Blob storage, with a byte-array fallback for old WebKit             */
/* ------------------------------------------------------------------ */

type BlobStorage = 'native' | 'buffer';

let blobStorage: Promise<BlobStorage> | null = null;

/** Detects once per session whether this engine can store Blobs in IndexedDB. */
function getBlobStorage(): Promise<BlobStorage> {
  if (blobStorage) return blobStorage;
  const detecting = openDatabase().then(detectBlobStorage);
  detecting.catch(() => {
    // An unexpected failure (not a refusal to clone) says nothing about Blob support: retry later.
    if (blobStorage === detecting) blobStorage = null;
  });
  blobStorage = detecting;
  return detecting;
}

const PROBE_ID = '\u0000blob-probe';

/**
 * Errors that say the database cannot be used right now (closing, out of space), not that it
 * cannot hold Blobs. Detection is retried later instead of settling on a mode.
 */
const TRANSIENT_ERRORS = new Set(['AbortError', 'InvalidStateError', 'TransactionInactiveError', 'QuotaExceededError']);

/**
 * Puts a tiny Blob and reads it back inside a transaction that is then aborted, so the probe is
 * never persisted. Old WebKit throws DataCloneError on the put, and Safari's private browsing
 * fails it with UnknownError ("Error preparing Blob/File data to be stored"); an engine that
 * accepts the put but hands back something other than the Blob is treated the same way.
 */
async function detectBlobStorage(db: IDBPDatabase<SybleDB>): Promise<BlobStorage> {
  const probe = new Blob([new Uint8Array([0x73, 0x79, 0x62])], { type: 'application/octet-stream' });
  const tx = db.transaction('blobs', 'readwrite');
  try {
    await tx.store.put({ id: PROBE_ID, full: probe, thumb: probe });
    const echo = (await tx.store.get(PROBE_ID))?.full;
    return isBlob(echo) && echo.size === probe.size ? 'native' : 'buffer';
  } catch (err) {
    if (TRANSIENT_ERRORS.has(errorName(err))) throw err;
    return 'buffer';
  } finally {
    abortQuietly(tx);
    await tx.done.catch(() => undefined);
  }
}

async function encodeBlobs(list: ImageBlobs[]): Promise<StoredBlobs[]> {
  if (list.length === 0) return [];
  const storage = await getBlobStorage();
  return Promise.all(
    list.map(async ({ id, full, thumb }) => {
      if (storage === 'native') return { id, full, thumb };
      const [fullBytes, thumbBytes] = await Promise.all([toBuffered(full), toBuffered(thumb)]);
      return { id, full: fullBytes, thumb: thumbBytes };
    }),
  );
}

async function toBuffered(blob: Blob): Promise<BufferedBlob> {
  return { data: await blobToArrayBuffer(blob), type: blob.type };
}

/** Reads either representation back as Blobs, whichever mode wrote it. */
function decodeBlobs(stored: StoredBlobs | undefined): ImageBlobs | undefined {
  const full = stored && decodeBlob(stored.full);
  if (!stored || !full) return undefined;
  return { id: stored.id, full, thumb: decodeBlob(stored.thumb) ?? full };
}

function decodeBlob(value: unknown): Blob | null {
  if (isBlob(value)) return value;
  if (isBufferedBlob(value)) return new Blob([value.data], { type: value.type });
  return null;
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function isBufferedBlob(value: unknown): value is BufferedBlob {
  if (typeof value !== 'object' || value === null) return false;
  const { data, type } = value as Partial<BufferedBlob>;
  // toString instead of instanceof: the buffer may come from another realm.
  return typeof type === 'string' && Object.prototype.toString.call(data) === '[object ArrayBuffer]';
}

function errorName(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : '';
}

/** Reads a Blob's bytes; falls back to FileReader where Blob.arrayBuffer is missing (Safari < 14). */
export function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
      reader.readAsArrayBuffer(blob);
    });
  }
  return new Response(blob).arrayBuffer();
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Every entry and image metadata record (pixel data stays on disk). */
export async function loadAll(): Promise<{ entries: Entry[]; images: ImageMeta[] }> {
  const db = await openDatabase();
  const tx = db.transaction(['entries', 'images'], 'readonly');
  const [entries, images] = await Promise.all([
    tx.objectStore('entries').getAll(),
    tx.objectStore('images').getAll(),
    tx.done,
  ]);
  return { entries, images };
}

export async function saveEntry(entry: Entry): Promise<void> {
  await write(['entries'], (tx, track) => track(tx.objectStore('entries').put(entry)));
}

/** Saves an entry, adds its new images and removes dropped ones, atomically. */
export async function saveEntryWithImages(
  entry: Entry,
  images: { meta: ImageMeta; blobs: ImageBlobs }[],
  removedImageIds: ID[] = [],
): Promise<void> {
  const stored = await encodeBlobs(images.map((image) => image.blobs));
  await write(ALL_STORES, (tx, track) => {
    const metas = tx.objectStore('images');
    const blobs = tx.objectStore('blobs');
    // Deletions are issued first so that an id listed as both removed and new ends up saved.
    for (const id of removedImageIds) {
      track(metas.delete(id));
      track(blobs.delete(id));
    }
    track(tx.objectStore('entries').put(entry));
    images.forEach(({ meta }, i) => {
      track(metas.put(meta));
      track(blobs.put(stored[i]));
    });
  });
}

/**
 * Updates an image's metadata, but only if the image still exists: OCR can finish after its
 * entry was deleted, and must not bring the image back.
 */
export async function saveImageMeta(meta: ImageMeta): Promise<void> {
  await write(['images'], async (tx, track) => {
    const store = tx.objectStore('images');
    if ((await store.count(meta.id)) > 0) track(store.put(meta));
  });
}

export async function getImageBlobs(id: ID): Promise<ImageBlobs | undefined> {
  const db = await openDatabase();
  return decodeBlobs(await db.get('blobs', id));
}

/** Pixel data for several images in one transaction, in the order asked (undefined if missing). */
export async function getBlobs(ids: ID[]): Promise<(ImageBlobs | undefined)[]> {
  if (ids.length === 0) return [];
  const db = await openDatabase();
  const tx = db.transaction('blobs', 'readonly');
  const [records] = await Promise.all([Promise.all(ids.map((id) => tx.store.get(id))), tx.done]);
  return records.map(decodeBlobs);
}

/** Deletes an entry with all of its images and their pixel data. */
export async function deleteEntry(id: ID): Promise<void> {
  await write(ALL_STORES, async (tx, track) => {
    const metas = tx.objectStore('images');
    const blobs = tx.objectStore('blobs');
    const imageIds = await metas.index('entryId').getAllKeys(id);
    track(tx.objectStore('entries').delete(id));
    for (const imageId of imageIds) {
      track(metas.delete(imageId));
      track(blobs.delete(imageId));
    }
  });
}

export async function clearLibrary(): Promise<void> {
  await write(ALL_STORES, (tx, track) => {
    for (const name of ALL_STORES) track(tx.objectStore(name).clear());
  });
}

export interface LibraryWrite {
  /** Erase the whole library first. */
  clear?: boolean;
  /** Entries whose current images (metadata and pixels) are deleted before writing. */
  replaceImagesOf?: ID[];
  /** Images of `replaceImagesOf` entries to leave in place. */
  keepImageIds?: ID[];
  entries?: Entry[];
  images?: ImageRecord[];
}

/**
 * Applies a bulk change (used by import) in one transaction: if any part fails, nothing changes,
 * including the `clear`.
 */
export async function putMany({
  clear = false,
  replaceImagesOf = [],
  keepImageIds = [],
  entries = [],
  images = [],
}: LibraryWrite): Promise<void> {
  const stored = await encodeBlobs(images.map((image) => image.blobs));
  await write(ALL_STORES, async (tx, track) => {
    const entryStore = tx.objectStore('entries');
    const metas = tx.objectStore('images');
    const blobs = tx.objectStore('blobs');
    if (clear) {
      track(entryStore.clear());
      track(metas.clear());
      track(blobs.clear());
    }
    if (replaceImagesOf.length > 0) {
      const byEntry = metas.index('entryId');
      const stale = await Promise.all(replaceImagesOf.map((entryId) => byEntry.getAllKeys(entryId)));
      const keep = new Set(keepImageIds);
      for (const imageId of stale.flat()) {
        if (keep.has(imageId)) continue;
        track(metas.delete(imageId));
        track(blobs.delete(imageId));
      }
    }
    for (const entry of entries) track(entryStore.put(entry));
    images.forEach(({ meta }, i) => {
      track(metas.put(meta));
      track(blobs.put(stored[i]));
    });
  });
}
