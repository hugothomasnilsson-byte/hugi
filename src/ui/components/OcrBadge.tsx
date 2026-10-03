import type { Analysis } from '../../state/store';

/** Small status line over an image while its text is being read on-device. */
export function OcrBadge({ analysis }: { analysis: Analysis }) {
  if (analysis.status === 'done') {
    const words = analysis.text ? analysis.text.split(/\s+/).filter(Boolean).length : 0;
    return <span className="ocr-badge is-done label">{words ? `${words} words read` : 'No text found'}</span>;
  }
  if (analysis.status === 'error') return <span className="ocr-badge is-error label">Text unreadable</span>;
  const pct = Math.round(analysis.progress * 100);
  return (
    <span className="ocr-badge label" role="status">
      <span className="ocr-badge__bar" style={{ transform: `scaleX(${analysis.progress})` }} />
      {analysis.status === 'running' ? `Reading text ${pct}%` : 'Queued to read'}
    </span>
  );
}
