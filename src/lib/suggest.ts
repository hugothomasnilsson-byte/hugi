import type { Swatch } from '../types';

export interface SuggestInput {
  title: string;
  notes: string;
  /** All extracted (OCR) text of the entry's images. */
  text: string;
  palette: Swatch[];
  /** Tags already on the entry. */
  tags: string[];
  /** Tags the user dismissed for this entry. */
  dismissed: string[];
  /** Every tag in the library with its usage count. */
  library: ReadonlyMap<string, number>;
}

export function suggestTags(_input: SuggestInput, _limit?: number): string[] {
  throw new Error('not implemented');
}
