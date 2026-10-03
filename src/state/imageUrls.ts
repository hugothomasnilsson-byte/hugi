import { useEffect, useState } from 'react';
import type { ID } from '../types';
import { getImageBlobs } from '../lib/db';

type Kind = 'thumb' | 'full';

const urls = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();

const key = (id: ID, kind: Kind) => `${kind}:${id}`;

/** Resolves (and caches) an object URL for a stored image. */
export function getImageUrl(id: ID, kind: Kind): Promise<string | null> {
  const k = key(id, kind);
  const hit = urls.get(k);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(k);
  if (!p) {
    p = getImageBlobs(id)
      .then((b) => {
        if (!b) return null;
        const url = URL.createObjectURL(kind === 'thumb' ? b.thumb : b.full);
        urls.set(k, url);
        return url;
      })
      .catch(() => null)
      .finally(() => pending.delete(k));
    pending.set(k, p);
  }
  return p;
}

export function peekImageUrl(id: ID, kind: Kind): string | undefined {
  return urls.get(key(id, kind));
}

/** Releases cached URLs for deleted or replaced images. */
export function forgetImageUrls(ids: ID[]) {
  for (const id of ids) {
    for (const kind of ['thumb', 'full'] as const) {
      const k = key(id, kind);
      const url = urls.get(k);
      if (url) URL.revokeObjectURL(url);
      urls.delete(k);
    }
  }
}

export function useImageUrl(id: ID | undefined, kind: Kind): string | undefined {
  const [url, setUrl] = useState(() => (id ? peekImageUrl(id, kind) : undefined));
  useEffect(() => {
    if (!id) {
      setUrl(undefined);
      return;
    }
    const cached = peekImageUrl(id, kind);
    if (cached) {
      setUrl(cached);
      return;
    }
    let alive = true;
    void getImageUrl(id, kind).then((u) => alive && setUrl(u ?? undefined));
    return () => {
      alive = false;
    };
  }, [id, kind]);
  return url;
}
