import { useEffect, useRef, useState } from 'react';
import type { ImageMeta } from '../../types';
import { Img } from './Img';

interface Props {
  images: ImageMeta[];
  start: number;
  title: string;
  onClose: (index: number) => void;
}

/** Full-screen viewer: arrows / swipe to move, click to zoom to actual size. */
export function Lightbox({ images, start, title, onClose }: Props) {
  const [index, setIndex] = useState(() => Math.max(0, Math.min(start, images.length - 1)));
  const [zoomed, setZoomed] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  /** Set when a gesture was a swipe, so the click that follows doesn't toggle zoom. */
  const swiped = useRef(false);
  const count = images.length;
  const img = images[index];

  const go = (d: number) => {
    setZoomed(false);
    setIndex((i) => (i + d + count) % count);
  };

  const hasImage = !!img;
  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    const opener = document.activeElement as HTMLElement | null;
    if (!dlg.open) dlg.showModal();
    // showModal focuses the first control (the image); Close is the expected start.
    dlg.querySelector<HTMLElement>('.lightbox__close')?.focus();
    document.documentElement.classList.add('is-locked');
    return () => {
      document.documentElement.classList.remove('is-locked');
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [hasImage]);

  useEffect(() => {
    if (count === 0) onClose(0);
  }, [count, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' && count > 1) go(1);
      else if (e.key === 'ArrowLeft' && count > 1) go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!img) return null;

  return (
    <dialog
      ref={ref}
      className={`lightbox ${zoomed ? 'is-zoomed' : ''}`}
      aria-label={`${title} — image ${index + 1} of ${count}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose(index);
      }}
    >
      <div
        className="lightbox__stage"
        onClick={(e) => {
          if (e.target === e.currentTarget && !zoomed) onClose(index);
        }}
        onPointerDown={(e) => {
          swiped.current = false;
          if (!zoomed) swipe.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          const s = swipe.current;
          swipe.current = null;
          if (!s || zoomed) return;
          const dx = e.clientX - s.x;
          const dy = e.clientY - s.y;
          swiped.current = Math.hypot(dx, dy) > 12;
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && count > 1) go(dx < 0 ? 1 : -1);
          else if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.5) onClose(index);
        }}
      >
        <button
          type="button"
          className="lightbox__img-btn"
          onClick={() => {
            if (!swiped.current) setZoomed((z) => !z);
          }}
          aria-label={zoomed ? 'Fit to screen' : 'View actual size'}
          style={zoomed ? { width: img.width, height: img.height } : undefined}
        >
          <Img key={img.id} id={img.id} kind="full" alt={`${title}, image ${index + 1}`} className="lightbox__img" eager />
        </button>
      </div>

      <div className="lightbox__chrome">
        <span className="lightbox__count mono">
          {String(index + 1).padStart(2, '0')} / {String(count).padStart(2, '0')}
        </span>
        <span className="lightbox__dims mono">
          {img.width} × {img.height}
        </span>
        <button type="button" className="lightbox__close label" onClick={() => onClose(index)}>
          Close
        </button>
      </div>

      {count > 1 && (
        <>
          <button type="button" className="lightbox__nav lightbox__nav--prev" onClick={() => go(-1)} aria-label="Previous image">
            ←
          </button>
          <button type="button" className="lightbox__nav lightbox__nav--next" onClick={() => go(1)} aria-label="Next image">
            →
          </button>
        </>
      )}
    </dialog>
  );
}
