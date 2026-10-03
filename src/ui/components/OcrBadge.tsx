import type { Analysis } from '../../state/store';

/** Small status line over an image while its text is being read on-device. */
export function OcrBadge({ analysis }: { analysis: Analysis }) {
  if (analysis.status === 'done') {
    const words = analysis.text ? analysis.text.split(/\s+/).filter(Boolean).length : 0;
    return <span className="ocr-badge is-done label">{words ? `${words} words read` : 'No text found'}</span>;
  }
  if (analysis.status === 'error') return <span className="ocr-badge is-error label">Text unreadable</span>;
  const pct = Math.round(analysis.progress * 100);
  if (analysis.status !== 'running') return <span className="ocr-badge is-queued label">Queued to read</span>;
  // A progressbar rather than a live region, so screen readers aren't read every percent.
  return (
    <span className="ocr-badge label" role="progressbar" aria-label="Reading text" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      Reading text {pct}%
    </span>
  );
}
