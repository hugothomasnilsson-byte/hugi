import { useState } from 'react';

/** Object URLs already decoded once; showing them again needs no fade. */
const decoded = new Set<string>();
import type { ID } from '../../types';
import { useImageUrl } from '../../state/imageUrls';

interface Props {
  id: ID | undefined;
  kind?: 'thumb' | 'full';
  alt: string;
  /** width / height, reserves layout space before the image loads. */
  ratio?: number;
  className?: string;
  eager?: boolean;
}

/** A stored image that fades in once decoded, with its space reserved up front. */
export function Img({ id, kind = 'thumb', alt, ratio, className = '', eager }: Props) {
  const url = useImageUrl(id, kind);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const loaded = !!url && (loadedUrl === url || decoded.has(url));
  return (
    <div className={`img ${loaded ? 'is-loaded' : ''} ${className}`} style={ratio ? { aspectRatio: String(ratio) } : undefined}>
      {url && (
        <img
          src={url}
          alt={alt}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          draggable={false}
          onLoad={() => {
            decoded.add(url);
            setLoadedUrl(url);
          }}
        />
      )}
    </div>
  );
}
