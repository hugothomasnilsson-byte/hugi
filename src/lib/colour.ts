import type { Swatch } from '../types';

export interface PixelData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export function extractPalette(_img: PixelData, _count?: number): Swatch[] {
  throw new Error('not implemented');
}

export function nameColour(_rgb: [number, number, number]): { name: string; family: string } {
  throw new Error('not implemented');
}

export function hexToRgb(_hex: string): [number, number, number] | null {
  throw new Error('not implemented');
}

export function rgbToHex(_rgb: [number, number, number]): string {
  throw new Error('not implemented');
}

export function deltaE(_a: [number, number, number], _b: [number, number, number]): number {
  throw new Error('not implemented');
}

export function isLight(_rgb: [number, number, number]): boolean {
  throw new Error('not implemented');
}

export function mergePalettes(_palettes: Swatch[][], _count?: number): Swatch[] {
  throw new Error('not implemented');
}

/** Every colour name and family the namer can produce (used for search hints). */
export const COLOUR_WORDS: ReadonlySet<string> = new Set();
