export interface PreparedImage {
  full: Blob;
  thumb: Blob;
  width: number;
  height: number;
  mime: string;
}

export function isImageFile(_f: Blob): boolean {
  throw new Error('not implemented');
}

export async function prepareImage(_file: Blob): Promise<PreparedImage> {
  throw new Error('not implemented');
}

export async function loadImageData(_blob: Blob, _maxSide: number): Promise<ImageData> {
  throw new Error('not implemented');
}
