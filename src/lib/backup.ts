export type ImportMode = 'merge' | 'replace';
export interface ImportSummary {
  entries: number;
  images: number;
  skipped: number;
}
export class BackupError extends Error {}

export async function exportLibrary(_onProgress?: (p: number) => void): Promise<Blob> {
  throw new Error('not implemented');
}
export async function importLibrary(
  _file: Blob,
  _mode: ImportMode,
  _onProgress?: (p: number) => void,
): Promise<ImportSummary> {
  throw new Error('not implemented');
}
export function backupFileName(_date: Date): string {
  throw new Error('not implemented');
}
