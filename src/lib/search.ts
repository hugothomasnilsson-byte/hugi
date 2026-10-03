import type { HighlightSegment, SearchDoc, SearchResult, Swatch } from '../types';

export interface ParsedQuery {
  raw: string;
  /** Plain words, folded (lowercase, diacritics removed). Each must match somewhere. */
  terms: string[];
  /** Quoted phrases, folded. Each must appear verbatim (folded) somewhere. */
  phrases: string[];
  /** Hashtag filters (normalised tags). The entry must carry each tag. */
  tags: string[];
  /** Words prefixed with "-" — entries containing them are excluded. */
  excluded: string[];
  /** Hex colour queries like "#c0392b" / "#fff" (only when not a known tag). */
  colours: { hex: string; rgb: [number, number, number] }[];
  /** The trailing hashtag the user is still typing (no trailing space), else null. */
  partialTag: string | null;
}

export interface SearchIndex {
  readonly size: number;
}

export function parseQuery(_raw: string, _knownTags?: ReadonlySet<string>): ParsedQuery {
  throw new Error('not implemented');
}

export function isEmptyQuery(_q: ParsedQuery): boolean {
  throw new Error('not implemented');
}

export function buildIndex(_docs: SearchDoc[]): SearchIndex {
  throw new Error('not implemented');
}

export function search(_index: SearchIndex, _raw: string): SearchResult[] {
  throw new Error('not implemented');
}

export function highlight(_text: string, _q: ParsedQuery): HighlightSegment[] {
  throw new Error('not implemented');
}

export function makeSnippet(_text: string, _q: ParsedQuery, _maxLen?: number): HighlightSegment[] | null {
  throw new Error('not implemented');
}

export function tagMatches(_tag: string, _q: ParsedQuery): boolean {
  throw new Error('not implemented');
}

export function swatchMatches(_swatch: Swatch, _q: ParsedQuery): boolean {
  throw new Error('not implemented');
}
