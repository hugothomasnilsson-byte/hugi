import type { Entry, ID, ImageBlobs, ImageMeta } from '../types';

export async function loadAll(): Promise<{ entries: Entry[]; images: ImageMeta[] }> {
  throw new Error('not implemented');
}
export async function saveEntry(_entry: Entry): Promise<void> {
  throw new Error('not implemented');
}
export async function saveEntryWithImages(
  _entry: Entry,
  _images: { meta: ImageMeta; blobs: ImageBlobs }[],
  _removedImageIds?: ID[],
): Promise<void> {
  throw new Error('not implemented');
}
export async function saveImageMeta(_meta: ImageMeta): Promise<void> {
  throw new Error('not implemented');
}
export async function getImageBlobs(_id: ID): Promise<ImageBlobs | undefined> {
  throw new Error('not implemented');
}
export async function deleteEntry(_id: ID): Promise<void> {
  throw new Error('not implemented');
}
export async function clearLibrary(): Promise<void> {
  throw new Error('not implemented');
}
