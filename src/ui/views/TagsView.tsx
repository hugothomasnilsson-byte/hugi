import { useMemo, useState } from 'react';
import { useDerived } from '../../state/store';
import { href } from '../../state/router';
import { plural } from '../format';

type Mode = 'az' | 'count';

/** Tags laid out like the index at the back of a catalogue. */
export function TagsView() {
  const { tagCounts } = useDerived();
  const [mode, setMode] = useState<Mode>('az');
  const [filter, setFilter] = useState('');

  const groups = useMemo(() => {
    const f = filter.trim().replace(/^#/, '').toLowerCase();
    const list = [...tagCounts.entries()].filter(([t]) => !f || t.includes(f));
    if (mode === 'count') {
      list.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return [{ letter: '', tags: list }];
    }
    list.sort((a, b) => a[0].localeCompare(b[0]));
    const out: { letter: string; tags: [string, number][] }[] = [];
    for (const item of list) {
      const first = item[0][0]?.toLocaleUpperCase() ?? '';
      const letter = /\p{L}/u.test(first) ? first : '#';
      const last = out[out.length - 1];
      if (last && last.letter === letter) last.tags.push(item);
      else out.push({ letter, tags: [item] });
    }
    return out;
  }, [tagCounts, mode, filter]);

  const max = Math.max(1, ...tagCounts.values());

  return (
    <div className="page">
      <header className="page-head">
        <p className="label">{plural(tagCounts.size, 'hashtag')}</p>
        <h1 className="page-title">Tags</h1>
        <div className="page-head__row">
          <input
            className="field field--inline"
            type="search"
            placeholder="Filter tags"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter tags"
          />
          <div className="segmented" role="radiogroup" aria-label="Order">
            <button type="button" role="radio" aria-checked={mode === 'az'} className={`segmented__opt ${mode === 'az' ? 'is-on' : ''}`} onClick={() => setMode('az')}>
              A–Z
            </button>
            <button type="button" role="radio" aria-checked={mode === 'count'} className={`segmented__opt ${mode === 'count' ? 'is-on' : ''}`} onClick={() => setMode('count')}>
              Most used
            </button>
          </div>
        </div>
      </header>

      {tagCounts.size === 0 ? (
        <div className="empty">
          <p className="empty__title">No hashtags yet.</p>
          <p className="label">Tags you add to entries will gather here.</p>
        </div>
      ) : (
        <div className="tag-index">
          {groups.map((g) => (
            <section key={g.letter || 'all'} className="tag-index__group">
              {g.letter && <h2 className="tag-index__letter">{g.letter}</h2>}
              <ul className="tag-index__list">
                {g.tags.map(([t, n]) => (
                  <li key={t}>
                    <a href={href.tag(t)} className="tag-index__item">
                      <span className="tag-index__name">#{t}</span>
                      <span className="tag-index__leader" aria-hidden="true" />
                      <span className="tag-index__count mono">{n}</span>
                      <span className="tag-index__bar" style={{ width: `${(n / max) * 100}%` }} aria-hidden="true" />
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {groups.every((g) => g.tags.length === 0) && <p className="label">No tags match “{filter}”.</p>}
        </div>
      )}
    </div>
  );
}
