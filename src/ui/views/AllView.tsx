import { useMemo } from 'react';
import type { SortOrder } from '../../types';
import { useDerived } from '../../state/store';
import { openSheet } from '../../state/ui';
import { EntryGrid, SortControl, sortEntries } from '../components/EntryGrid';
import { usePersistentState } from '../usePersistentState';
import { plural } from '../format';

const SORTS = ['newest', 'oldest', 'title'] as const;

export function AllView() {
  const { byNewest, tagCounts } = useDerived();
  const [order, setOrder] = usePersistentState<SortOrder>('syble:sort:all', 'newest', SORTS);
  const entries = useMemo(() => sortEntries(byNewest, order), [byNewest, order]);

  return (
    <div className="page">
      <header className="page-head">
        <p className="label">The collection</p>
        <h1 className="page-title">Index</h1>
        <div className="page-head__row">
          <p className="page-head__meta mono">
            {plural(byNewest.length, 'entry', 'entries')} · {plural(tagCounts.size, 'tag')}
          </p>
          <SortControl value={order} onChange={setOrder} />
        </div>
      </header>
      {entries.length ? (
        <EntryGrid entries={entries} />
      ) : (
        <div className="empty">
          <p className="empty__title">Nothing collected yet.</p>
          <button type="button" className="button" onClick={() => openSheet()}>
            Add a source
          </button>
        </div>
      )}
    </div>
  );
}
