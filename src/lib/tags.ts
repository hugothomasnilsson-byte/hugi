/**
 * Hashtag normalisation shared by the whole app.
 * A tag is lowercase, has no leading "#", and contains only letters, digits,
 * "-" and "_" (any script). Spaces become "-". Returns "" for invalid input.
 */
export function normalizeTag(raw: string): string {
  return raw
    .normalize('NFC')
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Splits free text such as "#film, grain #colour" into normalised unique tags. */
export function parseTagList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const t = normalizeTag(part);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}
