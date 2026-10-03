import type { HighlightSegment } from '../../types';

export function Segments({ segments }: { segments: HighlightSegment[] }) {
  return (
    <>
      {segments.map((s, i) => (s.match ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
    </>
  );
}
