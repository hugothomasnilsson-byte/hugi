import type { Entry, SortOrder } from '../../types';
import { useStore } from '../../state/store';
import { Masonry } from './Masonry';
import { EntryCard, cardExtra, clampRatio } from './EntryCard';

export function sortEntries(entries: Entry[], order: SortOrder): Entry[] {
  const list = [...entries];
  if (order === 'newest') list.sort((a, b) => b.createdAt - a.createdAt);
  else if (order === 'oldest') list.sort((a, b) => a.createdAt - b.createdAt);
  else
    list.sort((a, b) => {
      // Untitled entries go last; titles compare naturally ("No. 2" before "No. 10").
      if (!a.title !== !b.title) return a.title ? -1 : 1;
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }) || b.createdAt - a.createdAt;
    });
  return list;
}

export function EntryGrid({ entries }: { entries: Entry[] }) {
  const images = useStore((s) => s.images);
  return (
    <Masonry
      items={entries.map((e) => {
        const cover = images.get(e.imageIds[0]);
        return {
          key: e.id,
          ratio: cover ? clampRatio(cover.width / cover.height) : null,
          extra: () => cardExtra(e),
          render: () => <EntryCard entry={e} cover={cover} imageCount={e.imageIds.length} />,
        };
      })}
    />
  );
}

const ORDERS: { value: SortOrder; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'title', label: 'Title' },
];

export function SortControl({ value, onChange }: { value: SortOrder; onChange: (v: SortOrder) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label="Sort by">
      {ORDERS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={`segmented__opt ${value === o.value ? 'is-on' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
