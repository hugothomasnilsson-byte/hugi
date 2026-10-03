import { deflateSync, inflateSync, strFromU8, strToU8, type DeflateOptions } from 'fflate';
import type { Entry, ID, ImageMeta, OcrStatus, Swatch } from '../types';
import { normalizeTag, parseTagList } from './tags';
import { blobToArrayBuffer, clearLibrary, getBlobs, loadAll, putMany, type ImageRecord } from './db';

/**
 * Whole-library backups as a single .zip:
 *
 *   manifest.json        { app: 'syble', format: 1, exportedAt, counts, entries, images }
 *   images/<id>.<ext>    original image, extension from its MIME type
 *   thumbs/<id>.<ext>    grid thumbnail (webp or jpg)
 *
 * Images are already compressed, so they are stored as-is (level 0); only the manifest is deflated.
 *
 * The ZIP container is written and read here; fflate does the deflating and inflating. fflate 0.8's
 * Zip writes only 32-bit sizes, offsets and file counts, so an archive past 4 GiB or 65,535 files
 * (originals of up to 12 MB are kept) would come out silently unreadable, and its unzipSync needs
 * the whole archive in one buffer, which a phone cannot allocate for a large library. This module
 * adds ZIP64 records when they are needed and reads archives piecewise through Blob.slice.
 */

export type ImportMode = 'merge' | 'replace';

export interface ImportSummary {
  /** Entries written to the library. */
  entries: number;
  /** Images written to the library. */
  images: number;
  /**
   * Entries and images in the backup that were not written: malformed, missing their image file,
   * belonging to no entry, or (when merging) not newer than the copy already in the library.
   */
  skipped: number;
}

export class BackupError extends Error {
  name = 'BackupError';
}

export interface BackupManifest {
  app: 'syble';
  format: number;
  exportedAt: string;
  counts: { entries: number; images: number };
  entries: Entry[];
  images: ImageMeta[];
}

const APP_ID = 'syble';
const FORMAT_VERSION = 1;
const MANIFEST_NAME = 'manifest.json';
const MANIFEST_LEVEL = 6;

/** Images read from IndexedDB per transaction while exporting. */
const EXPORT_BATCH = 8;
/** Import writes whole entries in transactions of roughly this many bytes / records. */
const IMPORT_BATCH_BYTES = 16 * 1024 * 1024;
const IMPORT_BATCH_RECORDS = 200;

/** Largest timestamp a Date can represent; anything beyond it is treated as missing. */
const MAX_TIME = 8.64e15;

/* ------------------------------------------------------------------ */
/* File names                                                          */
/* ------------------------------------------------------------------ */

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tif',
};

const MIME_BY_EXTENSION: Record<string, string> = {
  ...Object.fromEntries(Object.entries(EXTENSION_BY_MIME).map(([mime, ext]) => [ext, mime])),
  jpeg: 'image/jpeg',
  tiff: 'image/tiff',
  // Export's name for an image whose type was unknown.
  bin: 'application/octet-stream',
};

function extensionFor(mime: string, fallback: string): string {
  const type = mime.toLowerCase().split(';')[0].trim();
  const known = EXTENSION_BY_MIME[type];
  if (known) return known;
  // e.g. "image/jxl" -> "jxl"
  const subtype = /^image\/([a-z0-9]{1,8})$/.exec(type)?.[1];
  return subtype ?? fallback;
}

function mimeForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? (/^[a-z0-9]{1,8}$/.test(ext) ? `image/${ext}` : 'application/octet-stream');
}

/** "syble-backup-YYYY-MM-DD.zip", using the local calendar date. */
export function backupFileName(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `syble-backup-${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.zip`;
}

/* ------------------------------------------------------------------ */
/* ZIP container                                                       */
/* ------------------------------------------------------------------ */

const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
const END64_RECORD = 56;
const LOCATOR64 = 20;
const ZIP64_EXTRA_ID = 0x0001;
const VERSION_BASE = 20;
const VERSION_ZIP64 = 45;
/** General-purpose flag bit 0: encrypted. */
const FLAG_ENCRYPTED = 0x0001;
/** General-purpose flag bit 11: the file name is UTF-8. */
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = -1;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function setU64(view: DataView, at: number, value: number): void {
  view.setUint32(at, value >>> 0, true);
  view.setUint32(at + 4, Math.floor(value / 0x1_0000_0000), true);
}

function getU64(view: DataView, at: number): number {
  return view.getUint32(at, true) + view.getUint32(at + 4, true) * 0x1_0000_0000;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

interface ZipRecord {
  name: Uint8Array;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  /** Offset of the file's local header. */
  offset: number;
}

/**
 * Assembles a ZIP archive as a Blob. Stored files are referenced by their original Blob rather
 * than copied, so an export holds about one image in memory at a time (to compute its CRC)
 * however large the library is. ZIP64 fields are written only where a size, offset or the file
 * count needs them, so ordinary backups stay plain ZIP files.
 */
export class ZipWriter {
  private readonly parts: BlobPart[] = [];
  private readonly records: ZipRecord[] = [];
  private offset = 0;
  private readonly zip64From: number;
  private readonly time: number;
  private readonly date: number;

  /** `zip64From`: sizes and offsets from this value up use ZIP64 fields (tests lower it). */
  constructor(zip64From = MAX_U32, modified = new Date()) {
    this.zip64From = zip64From;
    const year = Math.min(2107, Math.max(1980, modified.getFullYear()));
    this.time = (modified.getHours() << 11) | (modified.getMinutes() << 5) | (modified.getSeconds() >> 1);
    this.date = ((year - 1980) << 9) | ((modified.getMonth() + 1) << 5) | modified.getDate();
  }

  async addStored(name: string, blob: Blob): Promise<void> {
    const crc = crc32(new Uint8Array(await blobToArrayBuffer(blob)));
    this.add(name, blob, METHOD_STORED, crc, blob.size, blob.size);
  }

  addDeflated(name: string, data: Uint8Array, level: DeflateOptions['level']): void {
    const compressed = deflateSync(data, { level });
    this.add(name, compressed, METHOD_DEFLATE, crc32(data), compressed.length, data.length);
  }

  finish(): Blob {
    const directory = this.records.map((record) => this.centralHeader(record));
    const directoryOffset = this.offset;
    const directorySize = directory.reduce((n, header) => n + header.length, 0);
    const count = this.records.length;
    const zip64 = count >= MAX_U16 || this.needs64(directoryOffset) || this.needs64(directorySize);

    const tail = new Uint8Array((zip64 ? END64_RECORD + LOCATOR64 : 0) + END_RECORD);
    const view = new DataView(tail.buffer);
    let at = 0;
    if (zip64) {
      view.setUint32(0, SIG_END64, true);
      setU64(view, 4, END64_RECORD - 12);
      view.setUint16(12, VERSION_ZIP64, true);
      view.setUint16(14, VERSION_ZIP64, true);
      setU64(view, 24, count);
      setU64(view, 32, count);
      setU64(view, 40, directorySize);
      setU64(view, 48, directoryOffset);
      view.setUint32(END64_RECORD, SIG_LOCATOR64, true);
      setU64(view, END64_RECORD + 8, directoryOffset + directorySize);
      view.setUint32(END64_RECORD + 16, 1, true);
      at = END64_RECORD + LOCATOR64;
    }
    // With ZIP64, the classic record's fields point readers at the ZIP64 one (as Go and others do).
    view.setUint32(at, SIG_END, true);
    view.setUint16(at + 8, zip64 ? MAX_U16 : count, true);
    view.setUint16(at + 10, zip64 ? MAX_U16 : count, true);
    view.setUint32(at + 12, zip64 ? MAX_U32 : directorySize, true);
    view.setUint32(at + 16, zip64 ? MAX_U32 : directoryOffset, true);
    return new Blob([...this.parts, ...directory, tail], { type: 'application/zip' });
  }

  private needs64(value: number): boolean {
    return value >= this.zip64From;
  }

  private add(
    fileName: string,
    body: Blob | Uint8Array<ArrayBuffer>,
    method: number,
    crc: number,
    compressedSize: number,
    size: number,
  ): void {
    const name = strToU8(fileName);
    if (name.length > MAX_U16) throw new Error(`File name too long for a ZIP archive: ${fileName}`);
    const sizes64 = this.needs64(size) || this.needs64(compressedSize);
    // A ZIP64 local header carries both sizes.
    const header = new Uint8Array(LOCAL_HEADER + name.length + (sizes64 ? 20 : 0));
    const view = new DataView(header.buffer);
    view.setUint32(0, SIG_LOCAL, true);
    view.setUint16(4, sizes64 ? VERSION_ZIP64 : VERSION_BASE, true);
    view.setUint16(6, FLAG_UTF8, true);
    view.setUint16(8, method, true);
    view.setUint16(10, this.time, true);
    view.setUint16(12, this.date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, sizes64 ? MAX_U32 : compressedSize, true);
    view.setUint32(22, sizes64 ? MAX_U32 : size, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, sizes64 ? 20 : 0, true);
    header.set(name, LOCAL_HEADER);
    if (sizes64) {
      const at = LOCAL_HEADER + name.length;
      view.setUint16(at, ZIP64_EXTRA_ID, true);
      view.setUint16(at + 2, 16, true);
      setU64(view, at + 4, size);
      setU64(view, at + 12, compressedSize);
    }
    this.records.push({ name, method, crc, compressedSize, size, offset: this.offset });
    this.parts.push(header, body);
    this.offset += header.length + compressedSize;
  }

  private centralHeader(record: ZipRecord): Uint8Array<ArrayBuffer> {
    const sizes64 = this.needs64(record.size) || this.needs64(record.compressedSize);
    const offset64 = this.needs64(record.offset);
    // The ZIP64 extra field holds exactly the values whose classic field reads 0xFFFFFFFF, in order.
    const extraLength = sizes64 || offset64 ? 4 + (sizes64 ? 16 : 0) + (offset64 ? 8 : 0) : 0;
    const header = new Uint8Array(CENTRAL_HEADER + record.name.length + extraLength);
    const view = new DataView(header.buffer);
    const version = extraLength ? VERSION_ZIP64 : VERSION_BASE;
    view.setUint32(0, SIG_CENTRAL, true);
    view.setUint16(4, version, true);
    view.setUint16(6, version, true);
    view.setUint16(8, FLAG_UTF8, true);
    view.setUint16(10, record.method, true);
    view.setUint16(12, this.time, true);
    view.setUint16(14, this.date, true);
    view.setUint32(16, record.crc, true);
    view.setUint32(20, sizes64 ? MAX_U32 : record.compressedSize, true);
    view.setUint32(24, sizes64 ? MAX_U32 : record.size, true);
    view.setUint16(28, record.name.length, true);
    view.setUint16(30, extraLength, true);
    view.setUint32(42, offset64 ? MAX_U32 : record.offset, true);
    header.set(record.name, CENTRAL_HEADER);
    if (extraLength) {
      let at = CENTRAL_HEADER + record.name.length;
      view.setUint16(at, ZIP64_EXTRA_ID, true);
      view.setUint16(at + 2, extraLength - 4, true);
      at += 4;
      if (sizes64) {
        setU64(view, at, record.size);
        setU64(view, at + 8, record.compressedSize);
        at += 16;
      }
      if (offset64) setU64(view, at, record.offset);
    }
    return header;
  }
}

/** A file listed in an archive's central directory. */
interface ZipEntry {
  name: string;
  /** Compression method; -1 for an encrypted file. */
  method: number;
  compressedSize: number;
  size: number;
  /** Offset of the local header. */
  offset: number;
  /** Local header length if it matches the central directory's name and extra field (a read hint). */
  headerHint: number;
}

/** Structural damage in an archive; mapped to a BackupError with context by the caller. */
class ZipFormatError extends Error {}

async function readRange(file: Blob, start: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return new Uint8Array(await blobToArrayBuffer(file.slice(start, end)));
  } catch {
    throw new BackupError('That file could not be read.');
  }
}

/** Reads the central directory, found through the end record(s) at the back of the archive. */
async function readZipDirectory(file: Blob): Promise<Map<string, ZipEntry>> {
  // The end record is followed by a comment of up to 64 KiB and preceded by the ZIP64 locator.
  const tailStart = Math.max(0, file.size - (END_RECORD + MAX_U16 + LOCATOR64));
  const tail = await readRange(file, tailStart, file.size);
  const view = viewOf(tail);
  let end = -1;
  for (let i = tail.length - END_RECORD; i >= 0; i--) {
    if (view.getUint32(i, true) === SIG_END && i + END_RECORD + view.getUint16(i + 20, true) <= tail.length) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipFormatError('No end of central directory record.');

  let count = view.getUint16(end + 10, true);
  let size = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  if (end >= LOCATOR64 && view.getUint32(end - LOCATOR64, true) === SIG_LOCATOR64) {
    const at = getU64(view, end - LOCATOR64 + 8);
    const record = viewOf(await readRange(file, at, at + END64_RECORD));
    if (record.byteLength < END64_RECORD || record.getUint32(0, true) !== SIG_END64) {
      throw new ZipFormatError('Damaged ZIP64 end record.');
    }
    count = getU64(record, 32);
    size = getU64(record, 40);
    offset = getU64(record, 48);
  }
  if (offset + size > file.size) throw new ZipFormatError('The central directory lies outside the file.');

  const directory = await readRange(file, offset, offset + size);
  const dir = viewOf(directory);
  const entries = new Map<string, ZipEntry>();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + CENTRAL_HEADER > directory.length || dir.getUint32(p, true) !== SIG_CENTRAL) {
      throw new ZipFormatError('Damaged central directory.');
    }
    const flags = dir.getUint16(p + 8, true);
    const nameLength = dir.getUint16(p + 28, true);
    const extraLength = dir.getUint16(p + 30, true);
    const nameStart = p + CENTRAL_HEADER;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + dir.getUint16(p + 32, true);
    if (next > directory.length) throw new ZipFormatError('Damaged central directory.');
    const entry: ZipEntry = {
      name: strFromU8(directory.subarray(nameStart, extraStart), !(flags & FLAG_UTF8)),
      method: flags & FLAG_ENCRYPTED ? -1 : dir.getUint16(p + 10, true),
      compressedSize: dir.getUint32(p + 20, true),
      size: dir.getUint32(p + 24, true),
      offset: dir.getUint32(p + 42, true),
      headerHint: LOCAL_HEADER + nameLength + extraLength,
    };
    applyZip64Extra(dir, extraStart, extraStart + extraLength, entry);
    if (!entries.has(entry.name)) entries.set(entry.name, entry);
    p = next;
  }
  return entries;
}

/** Replaces 0xFFFFFFFF sizes and offset with their values from the ZIP64 extra field. */
function applyZip64Extra(view: DataView, start: number, end: number, entry: ZipEntry): void {
  const wantSize = entry.size === MAX_U32;
  const wantCompressed = entry.compressedSize === MAX_U32;
  const wantOffset = entry.offset === MAX_U32;
  if (!wantSize && !wantCompressed && !wantOffset) return;
  for (let at = start; at + 4 <= end; at += 4 + view.getUint16(at + 2, true)) {
    if (view.getUint16(at, true) !== ZIP64_EXTRA_ID) continue;
    const fieldEnd = Math.min(end, at + 4 + view.getUint16(at + 2, true));
    let field = at + 4;
    if (wantSize && field + 8 <= fieldEnd) {
      entry.size = getU64(view, field);
      field += 8;
    }
    if (wantCompressed && field + 8 <= fieldEnd) {
      entry.compressedSize = getU64(view, field);
      field += 8;
    }
    if (wantOffset && field + 8 <= fieldEnd) entry.offset = getU64(view, field);
    return;
  }
}

/** Reads and decompresses one file. Throws ZipFormatError if it is damaged or unsupported. */
async function readZipEntry(file: Blob, entry: ZipEntry): Promise<Uint8Array<ArrayBuffer>> {
  // One read normally covers the local header and the data; a local header with a longer extra
  // field than the central directory's needs a second.
  let chunk = await readRange(file, entry.offset, entry.offset + entry.headerHint + entry.compressedSize);
  const view = viewOf(chunk);
  if (chunk.length < LOCAL_HEADER || view.getUint32(0, true) !== SIG_LOCAL) {
    throw new ZipFormatError(`Damaged local header for ${entry.name}.`);
  }
  const start = LOCAL_HEADER + view.getUint16(26, true) + view.getUint16(28, true);
  const end = start + entry.compressedSize;
  if (end > chunk.length) chunk = await readRange(file, entry.offset, entry.offset + end);
  if (end > chunk.length) throw new ZipFormatError(`${entry.name} is truncated.`);
  const data = chunk.subarray(start, end);
  if (entry.method === METHOD_STORED && data.length === entry.size) return data;
  if (entry.method === METHOD_DEFLATE) {
    try {
      return inflateSync(data, { out: new Uint8Array(entry.size) });
    } catch {
      throw new ZipFormatError(`${entry.name} could not be decompressed.`);
    }
  }
  throw new ZipFormatError(`${entry.name} uses an unsupported compression method.`);
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

/** Exports the whole library as a .zip Blob. `onProgress` receives 0..1. */
export async function exportLibrary(onProgress?: (p: number) => void): Promise<Blob> {
  const report = progressReporter(onProgress);
  report(0);
  const { entries, images } = await loadAll();
  entries.sort((a, b) => a.createdAt - b.createdAt);
  const entryIds = new Set(entries.map((e) => e.id));
  const metas = images.filter((meta) => entryIds.has(meta.entryId));

  const zip = new ZipWriter();
  const exported: ImageMeta[] = [];
  for (let start = 0; start < metas.length; start += EXPORT_BATCH) {
    const batch = metas.slice(start, start + EXPORT_BATCH);
    const blobs = await getBlobs(batch.map((meta) => meta.id));
    for (let i = 0; i < batch.length; i++) {
      const meta = batch[i];
      const pixels = blobs[i];
      // An image whose pixel data is gone cannot be restored; leave it out of the backup.
      if (!pixels) continue;
      await zip.addStored(`images/${meta.id}.${extensionFor(meta.mime || pixels.full.type, 'bin')}`, pixels.full);
      await zip.addStored(`thumbs/${meta.id}.${extensionFor(pixels.thumb.type, 'jpg')}`, pixels.thumb);
      exported.push(meta);
    }
    report((0.95 * (start + batch.length)) / metas.length);
  }

  // The manifest goes last so it lists exactly the images that made it into the archive.
  const exportedIds = new Set(exported.map((meta) => meta.id));
  const manifest: BackupManifest = {
    app: APP_ID,
    format: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    counts: { entries: entries.length, images: exported.length },
    entries: entries.map((entry) => ({ ...entry, imageIds: entry.imageIds.filter((id) => exportedIds.has(id)) })),
    images: exported,
  };
  zip.addDeflated(MANIFEST_NAME, strToU8(JSON.stringify(manifest)), MANIFEST_LEVEL);
  const archive = zip.finish();
  report(1);
  return archive;
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

interface Archive {
  file: Blob;
  /** Every file in the archive, by path. */
  files: Map<string, ZipEntry>;
  /** "" or "<folder>/" when the backup was unpacked and re-zipped inside a folder. */
  root: string;
  entries: unknown[];
  images: unknown[];
}

interface PlannedImage {
  meta: ImageMeta;
  full: ZipEntry;
  /** null when the thumbnail is missing: the full image stands in for it. */
  thumb: ZipEntry | null;
  bytes: number;
}

interface PlannedEntry {
  entry: Entry;
  images: PlannedImage[];
  /** The entry's image ids as listed in the backup, including any whose file is missing. */
  listed: ID[];
  /** Merge: an older copy of this entry exists locally and its images are replaced. */
  replacesLocal: boolean;
  /** Merge: local images of this entry that stay because the backup lists them but lacks their file. */
  keep: ID[];
}

/**
 * Imports a backup. Everything is read and validated before the library is touched; a backup
 * that cannot be used throws BackupError with a message fit for the user.
 *
 * - replace: the library is cleared and refilled. The clear runs in the same transaction as the
 *   first batch, so a failure there leaves the old library intact (a failure in a later batch,
 *   e.g. storage running out, keeps the batches already written).
 * - merge: new entries are added; for an id present on both sides the newer `updatedAt` wins,
 *   taking its images with it.
 *
 * The archive is read piecewise (directory, manifest, then each batch's files) and entries are
 * written in batches, each atomic, so memory holds about one batch of images at a time.
 */
export async function importLibrary(
  file: Blob,
  mode: ImportMode,
  onProgress?: (p: number) => void,
): Promise<ImportSummary> {
  const report = progressReporter(onProgress);
  report(0);
  const archive = await openArchive(file);
  report(0.05);
  const plan = planImport(archive, Date.now());
  const merged = mode === 'merge' ? await mergeWithLibrary(plan.entries) : { writes: plan.entries, skipped: 0 };
  report(0.1);

  const summary: ImportSummary = { entries: 0, images: 0, skipped: plan.skipped + merged.skipped };
  const weight = (p: PlannedEntry) => 1024 + p.images.reduce((n, image) => n + image.bytes, 0);
  const total = merged.writes.reduce((n, p) => n + weight(p), 0);
  let done = 0;
  let first = true;

  for (const batch of batchesOf(merged.writes)) {
    const images = await readImages(file, batch);
    await putMany({
      clear: mode === 'replace' && first,
      replaceImagesOf: batch.filter((p) => p.replacesLocal).map((p) => p.entry.id),
      keepImageIds: batch.flatMap((p) => p.keep),
      entries: batch.map((p) => p.entry),
      images,
    });
    first = false;
    summary.entries += batch.length;
    summary.images += images.length;
    done += batch.reduce((n, p) => n + weight(p), 0);
    report(0.1 + (0.9 * done) / total);
  }
  // A backup with no usable entries still empties the library in replace mode.
  if (mode === 'replace' && first) await clearLibrary();

  report(1);
  return summary;
}

/** Lists the archive and parses the manifest, without reading any image data. */
async function openArchive(file: Blob): Promise<Archive> {
  if (file.size === 0) throw new BackupError('That file is empty.');
  let files: Map<string, ZipEntry>;
  try {
    files = await readZipDirectory(file);
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError('That file is not a readable .zip archive.');
  }

  // Prefer a manifest at the top level; accept one inside a single folder.
  const path = files.has(MANIFEST_NAME) ? MANIFEST_NAME : [...files.keys()].filter(isManifestPath).sort()[0];
  if (!path) throw new BackupError('That .zip is not a Syble backup: it has no manifest.json.');

  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(await readZipEntry(file, files.get(path)!)));
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError('The backup’s manifest is damaged and could not be read.');
  }
  if (!isRecord(raw) || raw.app !== APP_ID) throw new BackupError('That .zip was not made by Syble.');
  const { format } = raw;
  if (typeof format !== 'number' || !Number.isInteger(format) || format < 1) {
    throw new BackupError('This backup’s format is not recognised.');
  }
  if (format > FORMAT_VERSION) {
    throw new BackupError('This backup was made by a newer version of Syble. Update the app, then import it again.');
  }
  if (!Array.isArray(raw.entries) || !Array.isArray(raw.images)) {
    throw new BackupError('The backup’s manifest is incomplete: its list of entries or images is missing.');
  }
  return { file, files, root: path.slice(0, -MANIFEST_NAME.length), entries: raw.entries, images: raw.images };
}

function isManifestPath(name: string): boolean {
  return name === MANIFEST_NAME || (/^[^/]+\/manifest\.json$/.test(name) && !name.startsWith('__MACOSX/'));
}

/** Sanitises the manifest against the files actually present in the archive. */
function planImport(archive: Archive, now: number): { entries: PlannedEntry[]; skipped: number } {
  let skipped = 0;
  const fullFiles = new Map<ID, ZipEntry>();
  const thumbFiles = new Map<ID, ZipEntry>();
  for (const [name, info] of archive.files) {
    if (!name.startsWith(archive.root)) continue;
    const match = /^(images|thumbs)\/([^/]+)$/.exec(name.slice(archive.root.length));
    if (!match) continue;
    const file = match[2];
    const dot = file.lastIndexOf('.');
    (match[1] === 'images' ? fullFiles : thumbFiles).set(dot > 0 ? file.slice(0, dot) : file, info);
  }

  const entries = new Map<ID, Entry>();
  for (const raw of archive.entries) {
    const entry = sanitizeEntry(raw, now);
    if (!entry || entries.has(entry.id)) skipped++;
    else entries.set(entry.id, entry);
  }

  const imagesByEntry = new Map<ID, PlannedImage[]>();
  const seen = new Set<ID>();
  for (const raw of archive.images) {
    const meta = sanitizeImage(raw, now);
    const full = meta && fullFiles.get(meta.id);
    if (!meta || !full || seen.has(meta.id) || !entries.has(meta.entryId)) {
      skipped++;
      continue;
    }
    seen.add(meta.id);
    const thumb = thumbFiles.get(meta.id) ?? null;
    const planned: PlannedImage = {
      meta: { ...meta, size: full.size, mime: meta.mime || mimeForPath(full.name) },
      full,
      thumb,
      bytes: full.size + (thumb?.size ?? 0),
    };
    const list = imagesByEntry.get(meta.entryId);
    if (list) list.push(planned);
    else imagesByEntry.set(meta.entryId, [planned]);
  }

  const planned = [...entries.values()].map((entry): PlannedEntry => {
    const images = orderImages(entry, imagesByEntry.get(entry.id) ?? []);
    return { entry: withImages(entry, images), images, listed: entry.imageIds, replacesLocal: false, keep: [] };
  });
  return { entries: planned, skipped };
}

/**
 * Images keep the entry's order; images that point at the entry but are missing from its
 * `imageIds` are appended rather than left invisible. Ids without an image are dropped.
 */
function orderImages(entry: Entry, images: PlannedImage[]): PlannedImage[] {
  const rank = new Map(entry.imageIds.map((id, i) => [id, i]));
  const at = (image: PlannedImage) => rank.get(image.meta.id) ?? Number.MAX_SAFE_INTEGER;
  return [...images].sort((a, b) => at(a) - at(b) || a.meta.createdAt - b.meta.createdAt);
}

function withImages(entry: Entry, images: PlannedImage[]): Entry {
  return { ...entry, imageIds: images.map((image) => image.meta.id) };
}

/**
 * Merge: the newer `updatedAt` wins per entry id (ties keep the local copy). A winning backup
 * copy replaces the local images, except those it still lists but whose file the backup lacks:
 * a damaged backup must not delete pictures the device still has.
 */
async function mergeWithLibrary(plan: PlannedEntry[]): Promise<{ writes: PlannedEntry[]; skipped: number }> {
  const local = await loadAll();
  const localEntries = new Map(local.entries.map((entry) => [entry.id, entry]));
  const imageOwner = new Map(local.images.map((meta) => [meta.id, meta.entryId]));
  const writes: PlannedEntry[] = [];
  let skipped = 0;
  for (const p of plan) {
    const existing = localEntries.get(p.entry.id);
    if (existing && !(p.entry.updatedAt > existing.updatedAt)) {
      skipped += 1 + p.images.length;
      continue;
    }
    // Never take over an image id that another local entry owns.
    const images = p.images.filter((image) => {
      const owner = imageOwner.get(image.meta.id);
      return owner === undefined || owner === p.entry.id;
    });
    skipped += p.images.length - images.length;

    const written = new Set(images.map((image) => image.meta.id));
    const keep = existing ? p.listed.filter((id) => !written.has(id) && imageOwner.get(id) === p.entry.id) : [];
    const present = new Set([...written, ...keep]);
    const listed = new Set(p.listed);
    const imageIds = [
      ...p.listed.filter((id) => present.has(id)),
      ...images.map((image) => image.meta.id).filter((id) => !listed.has(id)),
    ];
    writes.push({ ...p, entry: { ...p.entry, imageIds }, images, replacesLocal: !!existing, keep });
  }
  return { writes, skipped };
}

function* batchesOf(plan: PlannedEntry[]): Generator<PlannedEntry[]> {
  let batch: PlannedEntry[] = [];
  let bytes = 0;
  let records = 0;
  for (const p of plan) {
    const cost = p.images.reduce((n, image) => n + image.bytes, 0);
    const count = 1 + p.images.length;
    if (batch.length > 0 && (bytes + cost > IMPORT_BATCH_BYTES || records + count > IMPORT_BATCH_RECORDS)) {
      yield batch;
      batch = [];
      bytes = 0;
      records = 0;
    }
    batch.push(p);
    bytes += cost;
    records += count;
  }
  if (batch.length > 0) yield batch;
}

/** Reads one batch's image files from the archive. */
async function readImages(file: Blob, batch: PlannedEntry[]): Promise<ImageRecord[]> {
  try {
    return await Promise.all(
      batch
        .flatMap((p) => p.images)
        .map(async ({ meta, full, thumb }): Promise<ImageRecord> => {
          const [fullBytes, thumbBytes] = await Promise.all([
            readZipEntry(file, full),
            thumb ? readZipEntry(file, thumb) : null,
          ]);
          const fullBlob = new Blob([fullBytes], { type: meta.mime });
          const thumbBlob = thumb && thumbBytes ? new Blob([thumbBytes], { type: mimeForPath(thumb.name) }) : fullBlob;
          return { meta, blobs: { id: meta.id, full: fullBlob, thumb: thumbBlob } };
        }),
    );
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError('Some images in the backup are damaged and could not be read.');
  }
}

/* ------------------------------------------------------------------ */
/* Sanitising                                                          */
/* ------------------------------------------------------------------ */

function sanitizeEntry(raw: unknown, now: number): Entry | null {
  if (!isRecord(raw) || !isId(raw.id)) return null;
  const createdAt = timestamp(raw.createdAt) ?? now;
  return {
    id: raw.id,
    title: text(raw.title),
    notes: text(raw.notes),
    link: text(raw.link),
    credit: text(raw.credit),
    tags: tagList(raw.tags),
    imageIds: idList(raw.imageIds),
    dismissedTags: tagList(raw.dismissedTags),
    createdAt,
    updatedAt: timestamp(raw.updatedAt) ?? createdAt,
  };
}

function sanitizeImage(raw: unknown, now: number): ImageMeta | null {
  if (!isRecord(raw) || !isId(raw.id) || !isId(raw.entryId)) return null;
  const mime = typeof raw.mime === 'string' && /^image\/[\w.+-]+$/i.test(raw.mime) ? raw.mime.toLowerCase() : '';
  // OCR that was queued or running when the backup was made is re-run after import.
  const ocrStatus: OcrStatus = raw.ocrStatus === 'done' || raw.ocrStatus === 'error' ? raw.ocrStatus : 'pending';
  return {
    id: raw.id,
    entryId: raw.entryId,
    width: dimension(raw.width),
    height: dimension(raw.height),
    mime,
    size: 0,
    text: text(raw.text),
    textEdited: raw.textEdited === true,
    ocrStatus,
    palette: Array.isArray(raw.palette) ? raw.palette.map(sanitizeSwatch).filter((s): s is Swatch => s !== null) : [],
    createdAt: timestamp(raw.createdAt) ?? now,
  };
}

function sanitizeSwatch(raw: unknown): Swatch | null {
  if (!isRecord(raw) || typeof raw.hex !== 'string') return null;
  const hex = raw.hex.trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(hex)) return null;
  const weight = typeof raw.weight === 'number' && Number.isFinite(raw.weight) ? raw.weight : 0;
  return {
    hex,
    // Derived from the hex so the two can never disagree.
    rgb: [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)],
    name: text(raw.name).toLowerCase(),
    family: text(raw.family).toLowerCase(),
    weight: Math.min(1, Math.max(0, weight)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is ID {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function timestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIME ? value : null;
}

/** Unknown dimensions become 1 so aspect ratios stay finite. */
function dimension(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}

function idList(value: unknown): ID[] {
  return Array.isArray(value) ? [...new Set(value.filter(isId))] : [];
}

function tagList(value: unknown): string[] {
  if (typeof value === 'string') return parseTagList(value);
  if (!Array.isArray(value)) return [];
  const tags = value.filter((t): t is string => typeof t === 'string').map(normalizeTag);
  return [...new Set(tags.filter(Boolean))];
}

/* ------------------------------------------------------------------ */

/** Clamps progress to 0..1 and never lets it run backwards. */
function progressReporter(onProgress?: (p: number) => void): (p: number) => void {
  let last = -1;
  return (p) => {
    const value = Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0));
    if (!onProgress || value <= last) return;
    last = value;
    onProgress(value);
  };
}
