const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const longFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/** The platform's shortcut modifier, for hints: ⌘ on Apple devices, Ctrl elsewhere. */
export const MOD = /Mac|iPhone|iPad|iPod/i.test(
  (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? navigator.userAgent,
)
  ? '⌘'
  : 'Ctrl';

export function formatDate(ts: number) {
  return dateFmt.format(ts);
}

export function formatLongDate(ts: number) {
  return `${longFmt.format(ts)}, ${timeFmt.format(ts)}`;
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** Display form of a link: host + path, no protocol or trailing slash. */
export function prettyLink(url: string) {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.host.replace(/^www\./, '')}${path}`.replace(/\/$/, '');
  } catch {
    return url;
  }
}

/** Best text to stand in for an entry without an image. */
export function entryText(e: { title: string; notes: string; link: string; credit: string }) {
  return e.notes || e.title || (e.link ? prettyLink(e.link) : '') || e.credit || 'Untitled';
}

/** Only http(s) links are rendered as clickable anchors. */
export function safeHref(url: string): string | null {
  try {
    const u = new URL(url.includes('://') ? url : `https://${url}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}
