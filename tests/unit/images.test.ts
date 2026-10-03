import { describe, expect, it } from 'vitest';
import { fullImageScale, isImageFile, readJpegOrientation, sniffImageType, thumbSize } from '../../src/lib/images';

const file = (name: string, type: string) => new File(['x'], name, { type });
const bytes = (...parts: Array<number[] | string>) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? Array.from(p, (c) => c.charCodeAt(0)) : p)));

describe('isImageFile', () => {
  it('accepts raster image types', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif', 'image/bmp']) {
      expect(isImageFile(file('x', type))).toBe(true);
    }
  });

  it('refuses SVG and non-images', () => {
    expect(isImageFile(file('logo.svg', 'image/svg+xml'))).toBe(false);
    expect(isImageFile(file('notes.txt', 'text/plain'))).toBe(false);
    expect(isImageFile(file('clip.mp4', 'video/mp4'))).toBe(false);
    expect(isImageFile(file('doc.pdf', 'application/pdf'))).toBe(false);
  });

  it('falls back to the extension when the type is missing or generic', () => {
    expect(isImageFile(file('IMG_0042.HEIC', ''))).toBe(true);
    expect(isImageFile(file('scan.jpeg', 'application/octet-stream'))).toBe(true);
    expect(isImageFile(file('notes.txt', ''))).toBe(false);
    expect(isImageFile(file('logo.svg', ''))).toBe(false);
    expect(isImageFile(new Blob(['x']))).toBe(false);
    expect(isImageFile(new Blob(['x'], { type: 'image/png' }))).toBe(true);
  });
});

describe('sniffImageType', () => {
  const ftyp = (major: string, ...compatible: string[]) => {
    const size = 16 + compatible.length * 4;
    return bytes([0, 0, 0, size], 'ftyp', major, [0, 0, 0, 0], ...compatible);
  };

  it('recognises common signatures', () => {
    expect(sniffImageType(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffImageType(bytes('GIF89a'))).toBe('image/gif');
    expect(sniffImageType(bytes('RIFF', [1, 2, 3, 4], 'WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(bytes('II', [0x2a, 0]))).toBe('image/tiff');
    expect(sniffImageType(bytes('BM', new Array(30).fill(0)))).toBe('image/bmp');
  });

  it('tells AVIF, HEIC and HEIF apart by their ftyp brands', () => {
    expect(sniffImageType(ftyp('avif', 'mif1', 'miaf'))).toBe('image/avif');
    expect(sniffImageType(ftyp('mif1', 'avif'))).toBe('image/avif');
    expect(sniffImageType(ftyp('heic', 'mif1', 'heic'))).toBe('image/heic');
    expect(sniffImageType(ftyp('mif1', 'heic'))).toBe('image/heic');
    expect(sniffImageType(ftyp('mif1', 'mif1'))).toBe('image/heif');
  });

  it('returns "" for anything else', () => {
    expect(sniffImageType(ftyp('isom', 'mp41'))).toBe('');
    expect(sniffImageType(bytes('<svg xmlns'))).toBe('');
    expect(sniffImageType(bytes('%PDF-1.7'))).toBe('');
    expect(sniffImageType(new Uint8Array())).toBe('');
  });
});

describe('readJpegOrientation', () => {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...Array.from('JFIF\0', (c) => c.charCodeAt(0)), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sos = [0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0];
  const exif = (orientation: number, little = false) => {
    const u16 = (v: number) => (little ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
    const u32 = (v: number) => (little ? [v & 0xff, (v >> 8) & 0xff, 0, 0] : [0, 0, (v >> 8) & 0xff, v & 0xff]);
    const tiff = [
      ...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8),
      ...u16(2), // two entries: ImageWidth, then Orientation
      ...u16(0x0100), ...u16(4), ...u32(1), ...u32(640),
      ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0,
      ...u32(0),
    ];
    const body = [...Array.from('Exif\0\0', (c) => c.charCodeAt(0)), ...tiff];
    return [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
  };
  const jpeg = (...segments: number[][]) => new Uint8Array([0xff, 0xd8, ...segments.flat()]);

  it('reads big- and little-endian EXIF', () => {
    expect(readJpegOrientation(jpeg(app0, exif(6), sos))).toBe(6);
    expect(readJpegOrientation(jpeg(exif(8, true), sos))).toBe(8);
    expect(readJpegOrientation(jpeg(app0, exif(3, true), sos))).toBe(3);
  });

  it('defaults to 1 when there is no usable orientation', () => {
    expect(readJpegOrientation(jpeg(app0, sos))).toBe(1);
    expect(readJpegOrientation(jpeg(app0, sos, exif(6)))).toBe(1); // after the image data starts
    expect(readJpegOrientation(jpeg(exif(9), sos))).toBe(1);
    expect(readJpegOrientation(jpeg(exif(6)).subarray(0, 30))).toBe(1); // truncated
    expect(readJpegOrientation(bytes([0x89, 0x50, 0x4e, 0x47]))).toBe(1);
    expect(readJpegOrientation(new Uint8Array())).toBe(1);
  });
});

describe('fullImageScale', () => {
  const scaled = (w: number, h: number) => {
    const s = fullImageScale(w, h);
    return [Math.round(w * s), Math.round(h * s)];
  };

  it('keeps images within limits at full size', () => {
    expect(fullImageScale(4032, 3024)).toBe(1);
    expect(fullImageScale(4096, 4096)).toBe(1);
    expect(fullImageScale(1170, 2532)).toBe(1);
  });

  it('limits ordinary photos to 4096 px on the long edge', () => {
    expect(scaled(8064, 6048)).toEqual([4096, 3072]);
    expect(scaled(6000, 6000)).toEqual([4096, 4096]);
  });

  it('lets long, narrow images keep their width (by pixel count)', () => {
    expect(fullImageScale(1080, 9000)).toBe(1); // 9.7 MP
    const [w, h] = scaled(1080, 16000);
    expect(w * h).toBeLessThanOrEqual(4096 * 3072 + 16000);
    expect(w).toBeGreaterThan(900);
  });

  it('never exceeds the absolute edge limit', () => {
    const [w] = scaled(20000, 500);
    expect(w).toBeLessThanOrEqual(16383);
  });
});

describe('thumbSize', () => {
  it('fits ordinary images to 720 px on the long edge', () => {
    expect(thumbSize(4032, 3024)).toEqual({ width: 720, height: 540 });
    expect(thumbSize(3024, 4032)).toEqual({ width: 540, height: 720 });
  });

  it('never upscales', () => {
    expect(thumbSize(300, 200)).toEqual({ width: 300, height: 200 });
  });

  it('keeps a usable width for long screenshots and height for panoramas', () => {
    expect(thumbSize(1080, 6000)).toEqual({ width: 288, height: 1600 });
    expect(thumbSize(8000, 1000)).toEqual({ width: 2304, height: 288 });
    expect(thumbSize(1080, 20000).height).toBe(4096);
  });
});

describe('edge cases', () => {
  const app1 = (payload: string) => {
    const body = Array.from(payload, (c) => c.charCodeAt(0));
    return [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
  };
  /** Big-endian EXIF whose IFD holds `entries` and whose IFD starts `ifdOffset` bytes into the TIFF data. */
  const exifWith = (entries: number[][], ifdOffset = 8) => {
    const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, ifdOffset, ...new Array(ifdOffset - 8).fill(0), 0, entries.length, ...entries.flat(), 0, 0, 0, 0];
    const body = [...Array.from('Exif\0\0', (c) => c.charCodeAt(0)), ...tiff];
    return [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
  };
  const orientationEntry = (value: number) => [0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, value, 0, 0];
  const otherEntry = (tag: number) => [tag >> 8, tag & 0xff, 0, 3, 0, 0, 0, 1, 0, 7, 0, 0];
  const sos = [0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0];

  it('reads orientation behind fill bytes, an XMP segment and several other tags', () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xff, // fill bytes before a marker are legal
      ...app1('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>'),
      ...exifWith([otherEntry(0x010f), otherEntry(0x0110), orientationEntry(7)], 26),
      ...sos,
    ]);
    expect(readJpegOrientation(jpeg)).toBe(7);
  });

  it('terminates on malformed segment lengths and IFD offsets', () => {
    expect(readJpegOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xe0, 0, 0]))).toBe(1);
    expect(readJpegOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 0xff]))).toBe(1);
    const farIfd = new Uint8Array([0xff, 0xd8, ...exifWith([orientationEntry(6)]), ...sos]);
    farIfd[2 + 4 + 6 + 4] = 0x7f; // IFD offset 0x7f000008: far beyond the segment
    expect(readJpegOrientation(farIfd)).toBe(1);
  });

  it('sniffs the remaining signatures and refuses lookalikes', () => {
    const b = (...parts: Array<number[] | string>) => bytes(...parts);
    expect(sniffImageType(b('GIF87a'))).toBe('image/gif');
    expect(sniffImageType(b('MM', [0, 0x2a]))).toBe('image/tiff');
    expect(sniffImageType(b([0, 0, 0, 0x0c], 'JXL ', [0x0d, 0x0a, 0x87, 0x0a]))).toBe('image/jxl');
    expect(sniffImageType(b([0, 0, 1, 0, 1, 0]))).toBe('image/x-icon');
    expect(sniffImageType(b('RIFF', [0, 0, 0, 0], 'WAVE'))).toBe('');
    expect(sniffImageType(b('BM'))).toBe(''); // too short to be a bitmap header
    // An ftyp box with a 64-bit size field carries no brands where we look.
    expect(sniffImageType(b([0, 0, 0, 1], 'ftyp', 'avif'))).toBe('');
  });

  it('judges types case-insensitively and never accepts SVG', () => {
    expect(isImageFile(file('a.png', 'IMAGE/PNG'))).toBe(true);
    expect(isImageFile(file('a.svg', 'image/svg+xml; charset=utf-8'))).toBe(false);
    expect(isImageFile(file('a.SVGZ', ''))).toBe(false);
    expect(isImageFile(file('archive.tar.JPG', ''))).toBe(true);
    expect(isImageFile(file('no-extension', ''))).toBe(false);
    expect(isImageFile(file('.png', ''))).toBe(true);
  });
});

describe('size rules stay within browser limits', () => {
  // iOS Safari refuses canvases over 4096 × 4096 pixels; WebP can't exceed 16383 px a side.
  const IOS_CANVAS_AREA = 4096 * 4096;
  const sizes: Array<[number, number]> = [];
  for (const w of [1, 7, 99, 640, 1080, 1170, 2000, 3024, 4032, 4096, 4097, 6000, 8064, 12000, 16000, 20000, 40000]) {
    for (const h of [1, 3, 50, 720, 1440, 2532, 3000, 4096, 6048, 9000, 16383, 30000]) sizes.push([w, h]);
  }

  it('stored images fit one canvas, never exceed 16383 px and are never enlarged', () => {
    for (const [w, h] of sizes) {
      const s = fullImageScale(w, h);
      const [sw, sh] = [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
      expect(s, `${w}×${h}`).toBeLessThanOrEqual(1);
      expect(sw * sh, `${w}×${h} → ${sw}×${sh}`).toBeLessThanOrEqual(IOS_CANVAS_AREA);
      expect(Math.max(sw, sh), `${w}×${h}`).toBeLessThanOrEqual(16383);
    }
  });

  it('thumbnails are at least 1 px, at most 4096 px and never larger than the source', () => {
    for (const [w, h] of sizes) {
      const t = thumbSize(w, h);
      expect(t.width, `${w}×${h}`).toBeGreaterThanOrEqual(1);
      expect(t.height, `${w}×${h}`).toBeGreaterThanOrEqual(1);
      expect(Math.max(t.width, t.height), `${w}×${h}`).toBeLessThanOrEqual(4096);
      expect(t.width, `${w}×${h}`).toBeLessThanOrEqual(w);
      expect(t.height, `${w}×${h}`).toBeLessThanOrEqual(h);
    }
  });

  it('ordinary photos come out at 720 px on the long edge in every orientation', () => {
    for (const [w, h] of [[4032, 3024], [6000, 4000], [1920, 1080], [2532, 1170]]) {
      expect(Math.max(...Object.values(thumbSize(w, h)))).toBe(720);
      expect(Math.max(...Object.values(thumbSize(h, w)))).toBe(720);
    }
  });
});
