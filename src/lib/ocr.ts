export type OcrProgress = (progress: number) => void;

export function recognizeText(_blob: Blob, _onProgress?: OcrProgress): Promise<string> {
  throw new Error('not implemented');
}

export async function disposeOcr(): Promise<void> {
  throw new Error('not implemented');
}
