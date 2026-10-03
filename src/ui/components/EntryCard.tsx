import type { Entry, ImageMeta, SearchField, SearchResult } from '../../types';
import { href } from '../../state/router';
import { highlight, tagMatches, type ParsedQuery } from '../../lib/search';
import { Img } from './Img';
import { Segments } from './Highlight';
import { entryText, formatDate } from '../format';

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
  // Matched tags first, so the reason a result appeared is never hidden behind "+N".
  const ordered = query
    ? [...entry.tags].sort((a, b) => Number(tagMatches(b, query)) - Number(tagMatches(a, query)))
    : entry.tags;
  const shownTags = ordered.slice(0, 4);
  const unseen = unseenFields(result, query, shownTags);

  return (
    <a href={href.entry(entry.id)} className={`card ${cover ? '' : 'card--text'}`}>
      {cover ? (
        <div className="card__visual">
          {/* The link already carries the title; the image needs no separate name. */}
          <Img id={cover.id} alt="" ratio={clampRatio(ratio!)} className="card__img" />
          {imageCount > 1 && (
            <span className="card__count mono">
              <span aria-hidden="true">{imageCount}</span>
              <span className="visually-hidden">{imageCount} images</span>
            </span>
          )}
        </div>
      ) : (
        <div className="card__visual card__visual--text">
          <p className="card__excerpt">{entryText(entry).slice(0, 220)}</p>
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
          <div
            className="card__swatches"
            role="img"
            aria-label={`Matching colours: ${result.swatches
              .slice(0, 4)
              .map((s) => s.name)
              .join(', ')}`}
          >
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
        {unseen.length > 0 && <div className="card__found label">Found in {unseen.map((f) => FIELD_LABEL[f]).join(' · ')}</div>}
      </div>
    </a>
  );
}

/**
 * Matched fields the caption doesn't already show: the title, tags, swatches and
 * snippet speak for themselves, so "Found in" only names what is otherwise invisible.
 */
function unseenFields(result?: SearchResult, query?: ParsedQuery, shownTags?: string[]): SearchField[] {
  if (!result) return [];
  const shown = new Set<SearchField>(['title']);
  if (result.snippet) shown.add(result.snippet.field);
  if (result.swatches.length) shown.add('colour');
  if (query && shownTags?.some((t) => tagMatches(t, query))) shown.add('tags');
  return result.fields.filter((f) => !shown.has(f));
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
  if (result && result.fields.some((f) => f !== 'title' && f !== 'tags' && f !== 'colour' && f !== result.snippet?.field)) h += 20;
  return h;
}
