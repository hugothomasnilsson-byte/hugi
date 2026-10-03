import { useState } from 'react';
import { deleteEntry, useDerived } from '../state/store';
import { href } from '../state/router';

/** A quiet line explaining the hosted preview, with a way to clear the examples. */
export function DemoBanner() {
  const { byNewest } = useDerived();
  const [busy, setBusy] = useState(false);
  const examples = byNewest.filter((e) => e.tags.includes('example'));

  return (
    <div className="demo-banner" role="note">
      <p className="demo-banner__text">
        <span className="label">Preview</span>
        <span>
          {examples.length > 0 ? (
            <>
              These <a className="link" href={href.tag('example')}>#example</a> entries show how Syble works. Add your own by
              pasting, dropping or choosing an image. It all stays in this browser.
            </>
          ) : (
            <>Your entries stay in this browser. Nothing is uploaded.</>
          )}
        </span>
      </p>
      {examples.length > 0 && (
        <button
          type="button"
          className="label link demo-banner__clear"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            for (const e of examples) await deleteEntry(e.id);
            setBusy(false);
          }}
        >
          Remove examples
        </button>
      )}
    </div>
  );
}
