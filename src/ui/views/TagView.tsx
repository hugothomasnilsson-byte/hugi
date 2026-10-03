import { useMemo } from 'react';
import type { SortOrder } from '../../types';
import { useDerived } from '../../state/store';
import { href } from '../../state/router';
import { EntryGrid, SortControl, sortEntries } from '../components/EntryGrid';
import { usePersistentState } from '../usePersistentState';
import { plural } from '../format';

const SORTS = ['newest', 'oldest', 'title'] as const;

export function TagView({ tag }: { tag: string }) {
  const { byNewest } = useDerived();
  const [order, setOrder] = usePersistentState<SortOrder>('syble:sort:tag', 'newest', SORTS);
  const tagged = useMemo(() => byNewest.filter((e) => e.tags.includes(tag)), [byNewest, tag]);
  const entries = useMemo(() => sortEntries(tagged, order), [tagged, order]);

  // Tags that most often appear alongside this one.
  const neighbours = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of tagged) for (const t of e.tags) if (t !== tag) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10);
  }, [tagged, tag]);

  return (
    <div className="page">
      <header className="page-head">
        <p className="label">
          <a className="link" href={href.tags()}>
            Tags
          </a>{' '}
          / {plural(tagged.length, 'entry', 'entries')}
        </p>
        <h1 className="page-title">
          <span className="page-title__hash">#</span>
          {tag}
        </h1>
        <div className="page-head__row">
          {neighbours.length > 0 ? (
            <nav className="chip-row" aria-label="Often together">
              <span className="label">Often with</span>
              {neighbours.map(([t, n]) => (
                <a key={t} className="chip" href={href.home(`#${tag} #${t}`)}>
                  #{t}
                  <span className="chip__count">{n}</span>
                </a>
              ))}
            </nav>
          ) : (
            <span />
          )}
          <SortControl value={order} onChange={setOrder} />
        </div>
      </header>
      {entries.length ? (
        <EntryGrid entries={entries} />
      ) : (
        <div className="empty">
          <p className="empty__title">No entries carry #{tag} any more.</p>
          <a className="button" href={href.tags()}>
            All tags
          </a>
        </div>
      )}
    </div>
  );
}
