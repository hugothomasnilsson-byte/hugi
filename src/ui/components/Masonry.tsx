import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

interface Item {
  key: string;
  /** width / height of the visual part, or null for text-only cards. */
  ratio: number | null;
  /** Extra height below the visual, estimated in px (caption, snippet). */
  extra: number;
  node: ReactNode;
}

function columnsFor(width: number) {
  if (width < 560) return 1;
  if (width < 880) return 2;
  if (width < 1240) return 3;
  if (width < 1640) return 4;
  return 5;
}

const PAGE = 40;

/**
 * Left-to-right masonry: items are placed into the currently shortest column
 * using their known aspect ratios, so reading order stays newest-first and
 * nothing reflows when images load.
 */
export function Masonry({ items, gap }: { items: Item[]; gap?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [limit, setLimit] = useState(PAGE);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Reset paging when the result set changes identity.
  const firstKey = items[0]?.key;
  useEffect(() => setLimit(PAGE), [firstKey, items.length]);

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

  const cols = width ? columnsFor(width) : 1;
  const g = gap ?? (cols === 1 ? 40 : width > 1200 ? 40 : 28);
  const colW = width ? (width - g * (cols - 1)) / cols : 300;
  const heights = new Array(cols).fill(0);
  const columns: ReactNode[][] = Array.from({ length: cols }, () => []);

  for (const item of items.slice(0, limit)) {
    let shortest = 0;
    for (let c = 1; c < cols; c++) if (heights[c] < heights[shortest] - 1) shortest = c;
    const visual = item.ratio ? colW / item.ratio : colW * 0.62;
    heights[shortest] += visual + item.extra + g;
    columns[shortest].push(<div key={item.key} className="masonry__cell">{item.node}</div>);
  }

  return (
    <div ref={ref} className="masonry" style={{ gap: g }}>
      {columns.map((col, i) => (
        <div key={i} className="masonry__col" style={{ gap: g }}>
          {col}
        </div>
      ))}
      <div ref={sentinel} className="masonry__sentinel" aria-hidden="true" />
    </div>
  );
}
