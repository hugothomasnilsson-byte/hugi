import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useDerived, useStore } from '../../state/store';
import { href, navigate, replaceRoute } from '../../state/router';
import { openSheet } from '../../state/ui';
import { isEmptyQuery, knownTagsOf, parseQuery, search } from '../../lib/search';
import { Masonry } from '../components/Masonry';
import { EntryCard, cardExtra, clampRatio } from '../components/EntryCard';
import { Img } from '../components/Img';
import { entryText, plural } from '../format';

export const SEARCH_INPUT_ID = 'syble-search';

const isFinePointer = () => window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? false;

export function SearchView({ initialQuery }: { initialQuery: string }) {
  const [q, setQ] = useState(initialQuery);
  const deferred = useDeferredValue(q);
  const inputRef = useRef<HTMLInputElement>(null);
  const { index, tagCounts, byNewest, docs } = useDerived();
  const images = useStore((s) => s.images);
  const ready = useStore((s) => s.ready);

  // Keep the box in sync when the route changes from elsewhere (e.g. a tag link).
  useEffect(() => setQ(initialQuery), [initialQuery]);

  useEffect(() => {
    if (isFinePointer()) inputRef.current?.focus({ preventScroll: true });
  }, []);

  // Same known-tag set the engine uses, so hex-like tags (#facade) highlight as tags.
  const knownTags = useMemo(() => knownTagsOf(index), [index]);
  const parsed = useMemo(() => parseQuery(deferred, knownTags), [deferred, knownTags]);
  const active = !isEmptyQuery(parsed);
  const results = useMemo(() => (active ? search(index, deferred) : []), [index, deferred, active]);

  const topTags = useMemo(
    () => [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12),
    [tagCounts],
  );

  // Hashtag completion for the token being typed.
  const completions = useMemo(() => {
    if (!parsed.partialTag) return [];
    const p = parsed.partialTag;
    return [...tagCounts.entries()]
      .filter(([t]) => t.startsWith(p) && t !== p)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([t]) => t);
  }, [parsed.partialTag, tagCounts]);

  const update = (value: string) => {
    setQ(value);
    replaceRoute(href.home(value));
  };

  // A chip tap is a deliberate step (Back undoes it); typing only replaces the URL.
  const toggleTag = (tag: string) => {
    const tokens = q.split(/\s+/).filter(Boolean);
    const has = tokens.some((t) => t.toLowerCase() === `#${tag}`);
    const next = has ? tokens.filter((t) => t.toLowerCase() !== `#${tag}`) : [...tokens, `#${tag}`];
    const value = next.length ? `${next.join(' ')} ` : '';
    setQ(value);
    navigate(href.home(value));
    inputRef.current?.focus({ preventScroll: true });
  };

  const complete = (tag: string) => {
    update(q.replace(/#[^\s#]*$/, `#${tag} `));
    inputRef.current?.focus();
  };

  const recent = byNewest.slice(0, 10);
  const empty = ready && byNewest.length === 0;

  return (
    <div className={`search ${active || q.trim() ? 'is-active' : ''}`}>
      <div className="search__stage">
        <form
          className="search__form"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (completions.length && parsed.partialTag) return complete(completions[0]);
            const first = results[0];
            if (first) location.hash = href.entry(first.entry.id);
          }}
        >
          <label htmlFor={SEARCH_INPUT_ID} className="visually-hidden">
            Search your almanac
          </label>
          <input
            id={SEARCH_INPUT_ID}
            ref={inputRef}
            className="search__input"
            type="search"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="Search your almanac"
            value={q}
            onChange={(e) => update(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && q) {
                e.preventDefault();
                e.stopPropagation();
                update('');
              } else if (e.key === 'Tab' && completions.length && !e.shiftKey) {
                e.preventDefault();
                complete(completions[0]);
              }
            }}
          />
          <span className="search__rule" aria-hidden="true" />
          {q && (
            <button type="button" className="search__clear label" onClick={() => update('')} aria-label="Clear search">
              Clear
            </button>
          )}
        </form>

        {completions.length > 0 && (
          <div className="search__completions" role="listbox" aria-label="Matching hashtags">
            {completions.map((t, i) => (
              <button key={t} type="button" role="option" aria-selected={i === 0} className="chip" onClick={() => complete(t)}>
                #{t}
                <span className="chip__count">{tagCounts.get(t)}</span>
              </button>
            ))}
            <span className="search__hint label only-fine">Tab to complete</span>
          </div>
        )}

        {!empty && topTags.length > 0 && completions.length === 0 && (
          <nav className="search__tags" aria-label="Most-used hashtags">
            {topTags.map(([t, n]) => {
              const on = parsed.tags.includes(t);
              return (
                <button key={t} type="button" className={`chip ${on ? 'is-on' : ''}`} aria-pressed={on} onClick={() => toggleTag(t)}>
                  #{t}
                  <span className="chip__count">{n}</span>
                </button>
              );
            })}
            <a className="chip chip--quiet" href={href.tags()}>
              All tags →
            </a>
          </nav>
        )}

        {empty && (
          <div className="search__welcome">
            <p className="search__welcome-lede">
              A private almanac for the things that move you — screenshots, images, passages, colour.
            </p>
            <p className="search__welcome-how label">
              <span className="only-fine">Paste · drop · or add an image to begin. </span>
              <span className="only-coarse">Add an image from your photos to begin. </span>
              Everything stays on this device.
            </p>
            <button type="button" className="button button--primary" onClick={() => openSheet()}>
              Add your first source
            </button>
          </div>
        )}
      </div>

      {!active && recent.length > 0 && (
        <section className="recent" aria-labelledby="recent-h">
          <div className="section-head">
            <h2 id="recent-h" className="label">
              Recently added
            </h2>
            <a className="label link" href={href.all()}>
              View all {byNewest.length > recent.length ? `(${byNewest.length})` : ''} →
            </a>
          </div>
          <div className="recent__strip">
            {recent.map((e) => {
              const cover = images.get(e.imageIds[0]);
              return (
                <a key={e.id} href={href.entry(e.id)} className="recent__item">
                  {cover ? (
                    <Img id={cover.id} alt={e.title || 'Untitled'} ratio={clampRatio(cover.width / cover.height)} className="recent__img" />
                  ) : (
                    <div className="recent__img recent__img--text">
                      <span>{entryText(e).slice(0, 160)}</span>
                    </div>
                  )}
                  <span className={`recent__title ${e.title ? '' : 'is-untitled'}`}>{e.title || 'Untitled'}</span>
                </a>
              );
            })}
          </div>
        </section>
      )}

      {active && (
        <section className="results" aria-live="polite">
          <div className="section-head">
            <h2 className="label">
              {results.length ? plural(results.length, 'entry', 'entries') : 'No entries'}
              <span className="faint"> of {docs.length.toLocaleString()}</span>
            </h2>
          </div>
          {results.length === 0 ? (
            <div className="results__none">
              <p className="results__none-title">Nothing yet for “{q.trim()}”.</p>
              <p className="label">Try fewer words, a shorter fragment, or browse the <a className="link" href={href.tags()}>index of tags</a>.</p>
            </div>
          ) : (
            <Masonry
              items={results.map((r) => {
                const cover = images.get(r.entry.imageIds[0]);
                return {
                  key: r.entry.id,
                  ratio: cover ? clampRatio(cover.width / cover.height) : null,
                  extra: () => cardExtra(r.entry, r),
                  render: () => (
                    <EntryCard
                      entry={r.entry}
                      cover={cover}
                      imageCount={r.entry.imageIds.length}
                      result={r}
                      query={parsed}
                    />
                  ),
                };
              })}
            />
          )}
        </section>
      )}
    </div>
  );
}
