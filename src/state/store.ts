import { useSyncExternalStore } from 'react';
import type { Entry, ID, ImageBlobs, ImageMeta, OcrStatus, SearchDoc, Swatch } from '../types';
import * as db from '../lib/db';
import { buildIndex, type SearchIndex } from '../lib/search';
import { extractPalette, mergePalettes } from '../lib/colour';
import { loadImageData, type PreparedImage } from '../lib/images';
import { recognizeText } from '../lib/ocr';
import { normalizeTag } from '../lib/tags';
import { newId } from '../lib/id';
import { forgetImageUrls } from './imageUrls';

/** Live analysis state for an image (draft or saved). */
export interface Analysis {
  palette: Swatch[] | null;
  text: string | null;
  status: OcrStatus;
  /** OCR progress, 0..1. */
  progress: number;
}

export interface State {
  ready: boolean;
  error: string | null;
  entries: ReadonlyMap<ID, Entry>;
  images: ReadonlyMap<ID, ImageMeta>;
  analysis: ReadonlyMap<ID, Analysis>;
  /** Bumped whenever entries or images change; used to memoise derived data. */
  version: number;
}

let state: State = {
  ready: false,
  error: null,
  entries: new Map(),
  images: new Map(),
  analysis: new Map(),
  version: 0,
};

const listeners = new Set<() => void>();

function setState(patch: Partial<State>, bump = true) {
  state = { ...state, ...patch, version: bump ? state.version + 1 : state.version };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getState() {
  return state;
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

/* ------------------------------------------------------------------ */
/* Derived data, memoised on `version`                                 */
/* ------------------------------------------------------------------ */

interface Derived {
  version: number;
  docs: SearchDoc[];
  index: SearchIndex;
  tagCounts: Map<string, number>;
  byNewest: Entry[];
}

let derived: Derived | null = null;

export function getDerived(): Derived {
  if (derived && derived.version === state.version) return derived;
  const imagesByEntry = new Map<ID, ImageMeta[]>();
  for (const img of state.images.values()) {
    const list = imagesByEntry.get(img.entryId);
    if (list) list.push(img);
    else imagesByEntry.set(img.entryId, [img]);
  }
  const byNewest = [...state.entries.values()].sort((a, b) => b.createdAt - a.createdAt);
  const docs: SearchDoc[] = byNewest.map((entry) => {
    const imgs = imagesByEntry.get(entry.id) ?? [];
    const order = new Map(entry.imageIds.map((id, i) => [id, i]));
    imgs.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return { entry, images: imgs };
  });
  const tagCounts = new Map<string, number>();
  for (const e of byNewest) for (const t of e.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  derived = { version: state.version, docs, index: buildIndex(docs), tagCounts, byNewest };
  return derived;
}

export function useDerived(): Derived {
  useStore((s) => s.version);
  return getDerived();
}

export function entryImages(entry: Entry, images: ReadonlyMap<ID, ImageMeta> = state.images): ImageMeta[] {
  return entry.imageIds.map((id) => images.get(id)).filter((m): m is ImageMeta => !!m);
}

export function entryPalette(entry: Entry, images?: ReadonlyMap<ID, ImageMeta>): Swatch[] {
  const palettes = entryImages(entry, images)
    .map((m) => m.palette)
    .filter((p) => p.length > 0);
  if (palettes.length === 0) return [];
  if (palettes.length === 1) return palettes[0];
  return mergePalettes(palettes, 6);
}

/* ------------------------------------------------------------------ */
/* Start-up                                                            */
/* ------------------------------------------------------------------ */

export async function initStore() {
  try {
    const { entries, images } = await db.loadAll();
    setState({
      ready: true,
      entries: new Map(entries.map((e) => [e.id, e])),
      images: new Map(images.map((m) => [m.id, m])),
    });
    // Resume analysis interrupted by a reload or crash.
    for (const meta of images) {
      if (meta.ocrStatus === 'pending' || meta.ocrStatus === 'running') {
        void db.getImageBlobs(meta.id).then((b) => b && analyzeImage(meta.id, b.full));
      }
    }
  } catch (err) {
    console.error(err);
    setState({ ready: true, error: 'Syble could not open its library on this device.' });
  }
}

/* ------------------------------------------------------------------ */
/* Image analysis: palette (fast) then OCR (queued, slow)              */
/* ------------------------------------------------------------------ */

let ocrChain: Promise<void> = Promise.resolve();
const cancelled = new Set<ID>();

function setAnalysis(id: ID, patch: Partial<Analysis>) {
  const prev = state.analysis.get(id) ?? { palette: null, text: null, status: 'pending', progress: 0 };
  const next = new Map(state.analysis);
  next.set(id, { ...prev, ...patch });
  setState({ analysis: next }, false);
}

/** Persists analysis results onto a saved image, unless the user edited its text. */
async function applyToSavedImage(id: ID, patch: Partial<Pick<ImageMeta, 'palette' | 'text' | 'ocrStatus'>>) {
  const meta = state.images.get(id);
  if (!meta) return;
  const next: ImageMeta = { ...meta, ...patch };
  if (meta.textEdited && 'text' in patch) next.text = meta.text;
  const images = new Map(state.images);
  images.set(id, next);
  setState({ images });
  await db.saveImageMeta(next);
}

export function analyzeImage(id: ID, blob: Blob) {
  cancelled.delete(id);
  setAnalysis(id, { status: 'pending', progress: 0 });

  void (async () => {
    try {
      const data = await loadImageData(blob, 200);
      const palette = extractPalette(data, 5);
      setAnalysis(id, { palette });
      await applyToSavedImage(id, { palette });
    } catch (err) {
      console.warn('Palette extraction failed', err);
    }
  })();

  ocrChain = ocrChain.then(async () => {
    if (cancelled.has(id)) return;
    setAnalysis(id, { status: 'running', progress: 0 });
    await applyToSavedImage(id, { ocrStatus: 'running' });
    try {
      const text = await recognizeText(blob, (p) => setAnalysis(id, { progress: p }));
      setAnalysis(id, { text, status: 'done', progress: 1 });
      await applyToSavedImage(id, { text, ocrStatus: 'done' });
    } catch (err) {
      console.warn('OCR failed', err);
      setAnalysis(id, { status: 'error' });
      await applyToSavedImage(id, { ocrStatus: 'error' });
    }
  });
}

/** Stops queued analysis for draft images that were discarded. */
export function forgetAnalysis(ids: ID[]) {
  const next = new Map(state.analysis);
  for (const id of ids) {
    if (state.images.has(id)) continue;
    cancelled.add(id);
    next.delete(id);
  }
  setState({ analysis: next }, false);
}

export async function retryOcr(id: ID) {
  const blobs = await db.getImageBlobs(id);
  if (blobs) analyzeImage(id, blobs.full);
}

/* ------------------------------------------------------------------ */
/* Entry mutations                                                     */
/* ------------------------------------------------------------------ */

export interface DraftImage {
  id: ID;
  /** Present for images not yet saved. */
  prepared?: PreparedImage;
}

export interface EntryDraft {
  title: string;
  notes: string;
  link: string;
  credit: string;
  tags: string[];
  images: DraftImage[];
  dismissedTags?: string[];
}

function buildMeta(id: ID, entryId: ID, prepared: PreparedImage, now: number): ImageMeta {
  const a = state.analysis.get(id);
  const status: OcrStatus = a?.status ?? 'pending';
  return {
    id,
    entryId,
    width: prepared.width,
    height: prepared.height,
    mime: prepared.mime,
    size: prepared.full.size,
    text: a?.text ?? '',
    textEdited: false,
    ocrStatus: status === 'done' || status === 'error' ? status : 'pending',
    palette: a?.palette ?? [],
    createdAt: now,
  };
}

function cleanDraft(draft: EntryDraft) {
  return {
    title: draft.title.trim(),
    notes: draft.notes.replace(/\s+$/, ''),
    link: draft.link.trim(),
    credit: draft.credit.trim(),
    tags: [...new Set(draft.tags.map(normalizeTag).filter(Boolean))],
  };
}

export async function saveDraft(draft: EntryDraft, existingId?: ID): Promise<ID> {
  const now = Date.now();
  const prev = existingId ? state.entries.get(existingId) : undefined;
  const id = prev?.id ?? newId();

  const newImages: { meta: ImageMeta; blobs: ImageBlobs }[] = [];
  for (const img of draft.images) {
    if (img.prepared && !state.images.has(img.id)) {
      newImages.push({
        meta: buildMeta(img.id, id, img.prepared, now),
        blobs: { id: img.id, full: img.prepared.full, thumb: img.prepared.thumb },
      });
    }
  }
  const keptIds = new Set(draft.images.map((i) => i.id));
  const removed = prev ? prev.imageIds.filter((iid) => !keptIds.has(iid)) : [];

  const entry: Entry = {
    id,
    ...cleanDraft(draft),
    imageIds: draft.images.map((i) => i.id),
    dismissedTags: draft.dismissedTags ?? prev?.dismissedTags ?? [],
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };

  await db.saveEntryWithImages(entry, newImages, removed);

  const entries = new Map(state.entries);
  entries.set(id, entry);
  const images = new Map(state.images);
  for (const { meta } of newImages) images.set(meta.id, meta);
  for (const rid of removed) images.delete(rid);
  setState({ entries, images });
  forgetImageUrls(removed);

  // Requests that the browser keep our data even under storage pressure.
  void navigator.storage?.persist?.().catch(() => undefined);
  return id;
}

export async function updateEntry(id: ID, patch: Partial<Pick<Entry, 'tags' | 'dismissedTags' | 'title' | 'notes'>>) {
  const prev = state.entries.get(id);
  if (!prev) return;
  const entry: Entry = { ...prev, ...patch, updatedAt: Date.now() };
  const entries = new Map(state.entries);
  entries.set(id, entry);
  setState({ entries });
  await db.saveEntry(entry);
}

export async function addTag(id: ID, raw: string) {
  const tag = normalizeTag(raw);
  const prev = state.entries.get(id);
  if (!tag || !prev || prev.tags.includes(tag)) return;
  await updateEntry(id, { tags: [...prev.tags, tag] });
}

export async function dismissSuggestion(id: ID, tag: string) {
  const prev = state.entries.get(id);
  if (!prev || prev.dismissedTags.includes(tag)) return;
  await updateEntry(id, { dismissedTags: [...prev.dismissedTags, tag] });
}

export async function updateImageText(id: ID, text: string) {
  const meta = state.images.get(id);
  if (!meta) return;
  const next: ImageMeta = { ...meta, text, textEdited: true, ocrStatus: 'done' };
  const images = new Map(state.images);
  images.set(id, next);
  setState({ images });
  await db.saveImageMeta(next);
}

/** Deletes an entry and returns a function that restores it (for "Undo"). */
export async function deleteEntry(id: ID): Promise<() => Promise<void>> {
  const entry = state.entries.get(id);
  if (!entry) return async () => undefined;
  const metas = entryImages(entry);
  const blobs = (await Promise.all(metas.map((m) => db.getImageBlobs(m.id)))).filter(
    (b): b is ImageBlobs => !!b,
  );

  await db.deleteEntry(id);
  const entries = new Map(state.entries);
  entries.delete(id);
  const images = new Map(state.images);
  for (const m of metas) images.delete(m.id);
  setState({ entries, images });
  forgetImageUrls(metas.map((m) => m.id));

  return async () => {
    const pairs = metas
      .map((meta) => ({ meta, blobs: blobs.find((b) => b.id === meta.id) }))
      .filter((p): p is { meta: ImageMeta; blobs: ImageBlobs } => !!p.blobs);
    await db.saveEntryWithImages(entry, pairs);
    const e2 = new Map(state.entries);
    e2.set(entry.id, entry);
    const i2 = new Map(state.images);
    for (const p of pairs) i2.set(p.meta.id, p.meta);
    setState({ entries: e2, images: i2 });
  };
}

/** Reloads everything from IndexedDB (after an import). */
export async function reloadStore() {
  const { entries, images } = await db.loadAll();
  forgetImageUrls([...state.images.keys()]);
  setState({
    entries: new Map(entries.map((e) => [e.id, e])),
    images: new Map(images.map((m) => [m.id, m])),
  });
  for (const meta of images) {
    if (meta.ocrStatus === 'pending' || meta.ocrStatus === 'running') {
      void db.getImageBlobs(meta.id).then((b) => b && analyzeImage(meta.id, b.full));
    }
  }
}
