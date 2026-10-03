import { href } from '../../state/router';

/** The Syble wordmark: an italic serif name with a short red rule beneath its "y". */
export function Wordmark({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  return (
    <a href={href.home()} className={`wordmark wordmark--${size}`} aria-label="Syble — home">
      <span className="wordmark__name" aria-hidden="true">
        S<span className="wordmark__y">y</span>ble
      </span>
    </a>
  );
}
