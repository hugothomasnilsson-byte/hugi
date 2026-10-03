export type ID = string;

/** One colour in an image palette. */
export interface Swatch {
  /** Lowercase "#rrggbb". */
  hex: string;
  rgb: [number, number, number];
  /** Evocative, searchable name, e.g. "ochre", "slate", "ivory". Lowercase. */
  name: string;
  /** Basic colour family, e.g. "yellow", "blue", "grey", "black", "white", "brown". Lowercase. */
  family: string;
  /** Share of the image's pixels this colour represents, 0..1. Palettes are sorted by weight desc. */
  weight: number;
}

export type OcrStatus = 'pending' | 'running' | 'done' | 'error';

/** Image metadata. Loaded into memory at start-up; pixel data lives in the `blobs` store. */
export interface ImageMeta {
  id: ID;
  entryId: ID;
  width: number;
  height: number;
  /** MIME type of the stored full-size blob. */
  mime: string;
  /** Byte size of the stored full-size blob. */
  size: number;
  /** Text read from the image by OCR (or corrected by the user). */
  text: string;
  /** True once the user has edited the text by hand; OCR never overwrites it after that. */
  textEdited: boolean;
  ocrStatus: OcrStatus;
  palette: Swatch[];
  createdAt: number;
}

export interface ImageBlobs {
  id: ID;
  full: Blob;
  /** ~640px long-edge preview used in grids. */
  thumb: Blob;
}

export interface Entry {
  id: ID;
  title: string;
  notes: string;
  /** Optional URL of the original source. */
  link: string;
  /** Optional credit / author / where it came from. */
  credit: string;
  /** Normalised hashtags without the leading "#", e.g. ["film", "colour"]. */
  tags: string[];
  /** Ordered image ids; the first is the cover. */
  imageIds: ID[];
  /** Suggested tags the user dismissed for this entry (never suggested again). */
  dismissedTags: string[];
  createdAt: number;
  updatedAt: number;
}

/** Everything the search engine needs for one entry. */
export interface SearchDoc {
  entry: Entry;
  images: ImageMeta[];
}

export type SearchField = 'title' | 'tags' | 'notes' | 'credit' | 'link' | 'text' | 'colour';

export interface HighlightSegment {
  text: string;
  match: boolean;
}

export interface SearchResult {
  entry: Entry;
  score: number;
  /** Fields that contained at least one query term, most important first. */
  fields: SearchField[];
  /** Excerpt from the best-matching long-form field (notes or extracted text)
   *  when the match is not visible in the title; null otherwise. */
  snippet: { field: 'notes' | 'text' | 'credit' | 'link'; segments: HighlightSegment[] } | null;
  /** Colour swatches that matched a colour query, if any. */
  swatches: Swatch[];
}

export type SortOrder = 'newest' | 'oldest' | 'title';
