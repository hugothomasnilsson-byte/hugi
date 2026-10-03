import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { historyKey } from '../../state/router';

export interface MasonryItem {
  key: string;
  /** width / height of the visual part, or null for text-only cards. */
  ratio: number | null;
  /** Estimated height below the visual in px (caption, snippet). Called only for rendered items. */
  extra: () => number;
  /** Called only for items within the rendered page, so long result lists stay cheap. */
  render: () => ReactNode;
}

function columnsFor(width: number) {
  if (width < 560) return 1;
  if (width < 880) return 2;
  if (width < 1240) return 3;
  if (width < 1640) return 4;
  return 5;
}

const PAGE = 40;

/** How far each history entry's grid had paged, so Back can return to the same spot. */
const pagedTo = new Map<string, number>();

/**
 * A grid cell decides once, when it mounts, whether it is new: cards animate in the
 * first time they appear, not again when live search moves them to another column.
 */
function Cell({ id, seen, children }: { id: string; seen: MutableRefObject<Set<string>>; children: ReactNode }) {
  const [isNew] = useState(() => !seen.current.has(id));
  useEffect(() => {
    seen.current.add(id);
  }, [id, seen]);
  return <div className={`masonry__cell${isNew ? ' is-new' : ''}`}>{children}</div>;
}

/**
 * Left-to-right masonry: items are placed into the currently shortest column
 * using their known aspect ratios, so reading order stays newest-first and
 * nothing reflows when images load.
 */
export function Masonry({ items, gap }: { items: MasonryItem[]; gap?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // Cards animate in only the first time they appear, not when live search reshuffles them.
  const seen = useRef(new Set<string>());
  const pageKey = useRef(historyKey());
  const [limit, setLimit] = useState(() => pagedTo.get(pageKey.current) ?? PAGE);

  useEffect(() => {
    pagedTo.set(pageKey.current, limit);
  }, [limit]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Reset paging when the result set changes (but not on mount, which may be a Back).
  const signature = `${items[0]?.key}|${items.length}`;
  const lastSignature = useRef(signature);
  useEffect(() => {
    if (lastSignature.current === signature) return;
    lastSignature.current = signature;
    setLimit(PAGE);
  }, [signature]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || limit >= items.length) return;
    const io = new IntersectionObserver(
      ([e]) => e.isIntersecting && setLimit((l) => l + PAGE),
      { rootMargin: '1200px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [limit, items.length]);

  // Until the width is measured (synchronously, before paint) render no cells, so a
  // provisional one-column layout never affects scroll position.
  if (!width) {
    return (
      <>
        <div ref={ref} className="masonry" />
        <div ref={sentinel} className="masonry__sentinel" aria-hidden="true" />
      </>
    );
  }

  const cols = columnsFor(width);
  const g = gap ?? (cols === 1 ? 40 : width > 1200 ? 40 : 28);
  const colW = (width - g * (cols - 1)) / cols;
  const heights = new Array(cols).fill(0);
  const columns: ReactNode[][] = Array.from({ length: cols }, () => []);

  for (const item of items.slice(0, limit)) {
    let shortest = 0;
    for (let c = 1; c < cols; c++) if (heights[c] < heights[shortest] - 1) shortest = c;
    const visual = item.ratio ? colW / item.ratio : colW * 0.62;
    heights[shortest] += visual + item.extra() + g;
    columns[shortest].push(
      <Cell key={item.key} id={item.key} seen={seen}>
        {item.render()}
      </Cell>,
    );
  }

  return (
    <>
      <div ref={ref} className="masonry" style={{ gap: g }}>
        {columns.map((col, i) => (
          <div key={i} className="masonry__col" style={{ gap: g }}>
            {col}
          </div>
        ))}
      </div>
      <div ref={sentinel} className="masonry__sentinel" aria-hidden="true" />
    </>
  );
}
