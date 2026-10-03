import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { Entry, ImageMeta, Swatch } from '../../types';
import {
  addTag,
  deleteEntry,
  dismissSuggestion,
  entryImages,
  entryPalette,
  retryOcr,
  updateImageText,
  useDerived,
  useStore,
} from '../../state/store';
import { goBack, href, navigate } from '../../state/router';
import { openSheet, toast } from '../../state/ui';
import { suggestTags } from '../../lib/suggest';
import { isLight } from '../../lib/colour';
import { Img } from '../components/Img';
import { Lightbox } from '../components/Lightbox';
import { EntryGrid } from '../components/EntryGrid';
import { formatLongDate, prettyLink, safeHref } from '../format';

export function EntryView({ id }: { id: string }) {
  const entry = useStore((s) => s.entries.get(id));
  const images = useStore((s) => s.images);
  const ready = useStore((s) => s.ready);

  if (!entry) {
    return (
      <div className="page page--narrow">
        <div className="empty">
          <p className="empty__title">{ready ? 'This entry is no longer in your almanac.' : 'Opening…'}</p>
          {ready && (
            <a className="button" href={href.home()}>
              Back to search
            </a>
          )}
        </div>
      </div>
    );
  }
  return <EntryDetail key={entry.id} entry={entry} images={entryImages(entry, images)} />;
}

function EntryDetail({ entry, images }: { entry: Entry; images: ImageMeta[] }) {
  const [current, setCurrent] = useState(0);
  const [viewer, setViewer] = useState<number | null>(null);
  const { tagCounts, byNewest } = useDerived();
  const analysis = useStore((s) => s.analysis);
  const allImages = useStore((s) => s.images);
  const palette = useMemo(() => entryPalette(entry, allImages), [entry, allImages]);
  const cover = images[Math.min(current, images.length - 1)];
  const title = entry.title || 'Untitled';

  useEffect(() => {
    document.title = `${title} — Syble`;
    return () => {
      document.title = 'Syble';
    };
  }, [title]);

  // Arrow keys step through plates when the viewer is closed.
  useEffect(() => {
    if (images.length < 2 || viewer !== null) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, [contenteditable], dialog')) return;
      if (e.key === 'ArrowRight') setCurrent((c) => (c + 1) % images.length);
      if (e.key === 'ArrowLeft') setCurrent((c) => (c - 1 + images.length) % images.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [images.length, viewer]);

  const suggestions = useMemo(
    () =>
      suggestTags({
        title: entry.title,
        notes: entry.notes,
        text: images.map((m) => m.text).join('\n'),
        palette,
        tags: entry.tags,
        dismissed: entry.dismissedTags,
        library: tagCounts,
      }),
    [entry, images, palette, tagCounts],
  );

  const related = useMemo(() => {
    if (!entry.tags.length) return [];
    const mine = new Set(entry.tags);
    return byNewest
      .filter((e) => e.id !== entry.id)
      .map((e) => {
        const shared = e.tags.filter((t) => mine.has(t)).length;
        // Jaccard overlap, so entries with many unrelated tags rank lower.
        const score = shared / (mine.size + e.tags.length - shared);
        return { e, shared, score };
      })
      .filter((r) => r.shared > 0)
      .sort((a, b) => b.score - a.score || b.shared - a.shared || b.e.createdAt - a.e.createdAt)
      .slice(0, 8)
      .map((r) => r.e);
  }, [byNewest, entry]);

  const onDelete = async () => {
    if (!confirm(`Delete “${title}”? This removes it and its images from this device.`)) return;
    const restore = await deleteEntry(entry.id);
    goBack(href.home());
    toast('Entry deleted', {
      label: 'Undo',
      run: () => {
        void restore().then(() => navigate(href.entry(entry.id)));
      },
    }, 7000);
  };

  const link = entry.link ? safeHref(entry.link) : null;

  return (
    <article className="entry">
      <div className="entry__bar">
        <button type="button" className="label link" onClick={() => goBack(href.home())}>
          ← Back
        </button>
        <div className="entry__actions">
          <button type="button" className="label link" onClick={() => openSheet({ entryId: entry.id })}>
            Edit
          </button>
          <button type="button" className="label link link--danger" onClick={onDelete}>
            Delete
          </button>
        </div>
      </div>

      {cover && (
        <figure className="entry__hero">
          <button
            type="button"
            className="entry__hero-btn"
            onClick={() => setViewer(current)}
            aria-label="View full screen"
            style={{ '--r': cover.width / cover.height } as CSSProperties}
          >
            <Img
              key={cover.id}
              id={cover.id}
              kind="full"
              alt={title}
              ratio={cover.width / cover.height}
              className="entry__hero-img"
              eager
            />
          </button>
          {images.length > 1 && (
            <figcaption className="entry__plates">
              <span className="mono">
                {String(current + 1).padStart(2, '0')} / {String(images.length).padStart(2, '0')}
              </span>
              <ol className="entry__thumbs">
                {images.map((m, i) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      className={`entry__thumb ${i === current ? 'is-on' : ''}`}
                      onClick={() => setCurrent(i)}
                      aria-label={`Show image ${i + 1}`}
                      aria-current={i === current}
                    >
                      <Img id={m.id} alt="" ratio={m.width / m.height} />
                    </button>
                  </li>
                ))}
              </ol>
            </figcaption>
          )}
        </figure>
      )}

      <div className="entry__grid">
        <div className="entry__main">
          <h1 className={`entry__title ${entry.title ? '' : 'is-untitled'}`}>{title}</h1>
          {entry.notes ? (
            <div className="entry__notes">
              {entry.notes.split(/\n{2,}/).map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          ) : (
            <p className="entry__notes is-empty">
              <button type="button" className="link" onClick={() => openSheet({ entryId: entry.id })}>
                Add notes
              </button>
            </p>
          )}
        </div>

        <aside className="entry__meta">
          <dl className="meta">
            <div className="meta__row">
              <dt className="label">Added</dt>
              <dd className="mono">{formatLongDate(entry.createdAt)}</dd>
            </div>
            {entry.updatedAt - entry.createdAt > 60_000 && (
              <div className="meta__row">
                <dt className="label">Edited</dt>
                <dd className="mono">{formatLongDate(entry.updatedAt)}</dd>
              </div>
            )}
            {entry.credit && (
              <div className="meta__row">
                <dt className="label">Credit</dt>
                <dd className="meta__credit">{entry.credit}</dd>
              </div>
            )}
            {entry.link && (
              <div className="meta__row">
                <dt className="label">Source</dt>
                <dd className="mono meta__link">
                  {link ? (
                    <a href={link} target="_blank" rel="noopener noreferrer" className="link">
                      {prettyLink(link)} ↗
                    </a>
                  ) : (
                    entry.link
                  )}
                </dd>
              </div>
            )}
            <div className="meta__row">
              <dt className="label">Tags</dt>
              <dd>
                <TagEditor entry={entry} library={tagCounts} />
                {suggestions.length > 0 && (
                  <div className="suggest suggest--stacked" aria-label="Suggested hashtags">
                    <span className="label">Suggested</span>
                    <div className="suggest__chips">
                      {suggestions.map((t) => (
                        <span key={t} className="chip chip--suggest">
                          <button type="button" className="chip__add" onClick={() => void addTag(entry.id, t)} aria-label={`Add #${t}`}>
                            + #{t}
                          </button>
                          <button
                            type="button"
                            className="chip__x"
                            onClick={() => void dismissSuggestion(entry.id, t)}
                            aria-label={`Dismiss #${t}`}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </dd>
            </div>
            {palette.length > 0 && (
              <div className="meta__row">
                <dt className="label">Palette</dt>
                <dd>
                  <Palette swatches={palette} />
                </dd>
              </div>
            )}
            {images.length > 0 && (
              <div className="meta__row">
                <dt className="label">{images.length > 1 ? 'Images' : 'Image'}</dt>
                <dd className="mono">
                  {images.length > 1 ? `${images.length} plates` : `${images[0].width} × ${images[0].height}`}
                </dd>
              </div>
            )}
          </dl>
        </aside>
      </div>

      {images.length > 0 && (
        <section className="entry__text" aria-labelledby="text-h">
          <div className="section-head">
            <h2 id="text-h" className="label">
              Extracted text
            </h2>
            <span className="label faint">Read on this device · searchable</span>
          </div>
          {images.map((m, i) => (
            <ExtractedText
              key={m.id}
              meta={m}
              label={images.length > 1 ? `Plate ${i + 1}` : null}
              progress={analysis.get(m.id)?.progress ?? 0}
            />
          ))}
        </section>
      )}

      {related.length > 0 && (
        <section className="entry__related" aria-labelledby="related-h">
          <div className="section-head">
            <h2 id="related-h" className="label">
              Related
            </h2>
            <span className="label faint">Sharing hashtags</span>
          </div>
          <EntryGrid entries={related} />
        </section>
      )}

      {viewer !== null && (
        <Lightbox
          images={images}
          start={viewer}
          title={title}
          onClose={(i) => {
            setCurrent(i);
            setViewer(null);
          }}
        />
      )}
    </article>
  );
}

function TagEditor({ entry, library }: { entry: Entry; library: ReadonlyMap<string, number> }) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  const options = useMemo(() => {
    const q = value.replace(/^#/, '').toLowerCase();
    if (!q) return [];
    return [...library.keys()].filter((t) => t.startsWith(q) && !entry.tags.includes(t)).slice(0, 5);
  }, [value, library, entry.tags]);

  const commit = (t: string) => {
    if (t.trim()) void addTag(entry.id, t);
    setValue('');
  };

  return (
    <div className="tag-editor">
      {entry.tags.map((t) => (
        <a key={t} href={href.tag(t)} className="chip">
          #{t}
        </a>
      ))}
      {adding ? (
        <span className="tag-editor__add">
          <input
            className="tag-editor__input"
            autoFocus
            value={value}
            placeholder="#tag"
            aria-label="New hashtag"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            list={`tags-${entry.id}`}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit(value);
              } else if (e.key === 'Tab' && options[0]) {
                e.preventDefault();
                setValue(options[0]);
              } else if (e.key === 'Escape') {
                setAdding(false);
                setValue('');
              }
            }}
            onBlur={() => {
              commit(value);
              setAdding(false);
            }}
          />
          <datalist id={`tags-${entry.id}`}>
            {options.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </span>
      ) : (
        <button type="button" className="chip chip--quiet" onClick={() => setAdding(true)}>
          + tag
        </button>
      )}
    </div>
  );
}

function Palette({ swatches }: { swatches: Swatch[] }) {
  return (
    <ul className="palette">
      {swatches.map((s) => (
        <li key={s.hex} className="palette__item">
          <a
            href={href.home(s.name)}
            className="palette__chip"
            style={{ background: s.hex, color: isLight(s.rgb) ? '#181715' : '#f6f4ef' }}
            title={`Search “${s.name}”`}
          >
            <span className="visually-hidden">Search {s.name}</span>
          </a>
          <span className="palette__name">{s.name}</span>
          <span className="palette__hex mono">{s.hex}</span>
        </li>
      ))}
    </ul>
  );
}

function ExtractedText({ meta, label, progress }: { meta: ImageMeta; label: string | null; progress: number }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(meta.text);

  useEffect(() => {
    if (!editing) setDraft(meta.text);
  }, [meta.text, editing]);

  const status = meta.ocrStatus;
  return (
    <div className="ocr">
      <div className="ocr__head">
        {label && <span className="label">{label}</span>}
        {status === 'done' && !editing && (
          <button type="button" className="label link" onClick={() => setEditing(true)}>
            {meta.text ? 'Edit' : 'Add text'}
          </button>
        )}
        {meta.textEdited && !editing && <span className="label faint">Edited by you</span>}
      </div>
      {editing ? (
        <div className="ocr__edit">
          <textarea
            className="field field--mono"
            value={draft}
            rows={Math.min(18, Math.max(5, draft.split('\n').length + 1))}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
            aria-label="Extracted text"
          />
          <div className="ocr__edit-actions">
            <button type="button" className="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => {
                void updateImageText(meta.id, draft.trim());
                setEditing(false);
              }}
            >
              Save text
            </button>
          </div>
        </div>
      ) : status === 'pending' || status === 'running' ? (
        <p className="ocr__status label" role="status">
          <span className="ocr__progress" style={{ transform: `scaleX(${status === 'running' ? progress : 0})` }} />
          {status === 'running' ? `Reading text… ${Math.round(progress * 100)}%` : 'Waiting to read text…'}
        </p>
      ) : status === 'error' ? (
        <p className="ocr__status label">
          Couldn’t read this image.{' '}
          <button type="button" className="link" onClick={() => void retryOcr(meta.id)}>
            Try again
          </button>
        </p>
      ) : meta.text ? (
        <pre className="ocr__text">{meta.text}</pre>
      ) : (
        <p className="ocr__status label faint">No text found in this image.</p>
      )}
    </div>
  );
}
