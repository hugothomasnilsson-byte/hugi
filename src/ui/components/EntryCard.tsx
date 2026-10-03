import type { Entry, ImageMeta, SearchField, SearchResult } from '../../types';
import { href } from '../../state/router';
import { highlight, tagMatches, type ParsedQuery } from '../../lib/search';
import { Img } from './Img';
import { Segments } from './Highlight';
import { formatDate } from '../format';

interface Props {
  entry: Entry;
  cover: ImageMeta | undefined;
  imageCount: number;
  result?: SearchResult;
  query?: ParsedQuery;
}

const FIELD_LABEL: Record<SearchField, string> = {
  title: 'title',
  tags: 'tags',
  notes: 'notes',
  credit: 'credit',
  link: 'link',
  text: 'image text',
  colour: 'colour',
};

export function EntryCard({ entry, cover, imageCount, result, query }: Props) {
  const title = entry.title || 'Untitled';
  const ratio = cover ? cover.width / Math.max(1, cover.height) : null;
  const shownTags = entry.tags.slice(0, 4);
  const matchedNotTitle = result?.fields.filter((f) => f !== 'title') ?? [];

  return (
    <a href={href.entry(entry.id)} className={`card ${cover ? '' : 'card--text'}`}>
      {cover ? (
        <div className="card__visual">
          <Img id={cover.id} alt={title} ratio={clampRatio(ratio!)} className="card__img" />
          {imageCount > 1 && <span className="card__count mono">{imageCount}</span>}
        </div>
      ) : (
        <div className="card__visual card__visual--text">
          <p className="card__excerpt">{entry.notes.slice(0, 220) || title}</p>
        </div>
      )}
      <div className="card__body">
        <h3 className={`card__title ${entry.title ? '' : 'is-untitled'}`}>
          <span className="card__title-text">
            {query && entry.title ? <Segments segments={highlight(entry.title, query)} /> : title}
          </span>
        </h3>
        {result?.snippet && (
          <p className="card__snippet">
            <span className="card__snippet-field label">{result.snippet.field === 'text' ? 'In image' : result.snippet.field}</span>
            <Segments segments={result.snippet.segments} />
          </p>
        )}
        {result && result.swatches.length > 0 && (
          <div className="card__swatches" aria-label="Matching colours">
            {result.swatches.slice(0, 4).map((s) => (
              <span key={s.hex} className="swatch-dot" style={{ background: s.hex }} title={`${s.name} ${s.hex}`} />
            ))}
          </div>
        )}
        <div className="card__meta mono">
          <span className="card__date">{formatDate(entry.createdAt)}</span>
          {shownTags.length > 0 && (
            <span className="card__tags">
              {shownTags.map((t) => (
                <span key={t} className={query && tagMatches(t, query) ? 'is-match' : ''}>
                  #{t}
                </span>
              ))}
              {entry.tags.length > shownTags.length && <span className="faint">+{entry.tags.length - shownTags.length}</span>}
            </span>
          )}
        </div>
        {matchedNotTitle.length > 0 && (
          <div className="card__found label">Found in {matchedNotTitle.map((f) => FIELD_LABEL[f]).join(' · ')}</div>
        )}
      </div>
    </a>
  );
}

/** Very tall or very wide covers are cropped to keep the grid calm. */
export function clampRatio(r: number) {
  return Math.min(2.2, Math.max(0.42, r));
}

/** Estimated caption height used by the masonry layout. */
export function cardExtra(entry: Entry, result?: SearchResult) {
  let h = 74;
  if (entry.title.length > 34) h += 26;
  if (result?.snippet) h += 64;
  if (result?.swatches.length) h += 22;
  if (result && result.fields.some((f) => f !== 'title')) h += 20;
  return h;
}
