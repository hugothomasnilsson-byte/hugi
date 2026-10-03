import { href } from '../../state/router';

/** The Syble wordmark: an italic serif name over a short red rule that draws out on hover. */
export function Wordmark({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  return (
    <a href={href.home()} className={`wordmark wordmark--${size}`} aria-label="Syble — home">
      <span className="wordmark__name" aria-hidden="true">
        Syble
      </span>
    </a>
  );
}
