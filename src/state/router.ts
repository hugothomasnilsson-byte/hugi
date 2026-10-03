import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'home'; q: string }
  | { name: 'entry'; id: string }
  | { name: 'tag'; tag: string }
  | { name: 'tags' }
  | { name: 'all' }
  | { name: 'library' };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  const [path, qs = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  switch (parts[0]) {
    case 'entry':
      if (parts[1]) return { name: 'entry', id: parts[1] };
      break;
    case 'tag':
      if (parts[1]) return { name: 'tag', tag: parts[1] };
      break;
    case 'tags':
      return { name: 'tags' };
    case 'all':
      return { name: 'all' };
    case 'library':
      return { name: 'library' };
  }
  return { name: 'home', q: new URLSearchParams(qs).get('q') ?? '' };
}

export function routeHref(route: Route): string {
  switch (route.name) {
    case 'home':
      return route.q ? `#/?q=${encodeURIComponent(route.q)}` : '#/';
    case 'entry':
      return `#/entry/${encodeURIComponent(route.id)}`;
    case 'tag':
      return `#/tag/${encodeURIComponent(route.tag)}`;
    default:
      return `#/${route.name}`;
  }
}

export const href = {
  home: (q = '') => routeHref({ name: 'home', q }),
  entry: (id: string) => routeHref({ name: 'entry', id }),
  tag: (tag: string) => routeHref({ name: 'tag', tag }),
  tags: () => routeHref({ name: 'tags' }),
  all: () => routeHref({ name: 'all' }),
  library: () => routeHref({ name: 'library' }),
};

let current = location.hash;
const listeners = new Set<() => void>();

// Each in-app history entry is stamped with its depth so "Back" can tell
// whether there is an earlier Syble page to return to.
let depth: number = typeof history.state?.sybleDepth === 'number' ? history.state.sybleDepth : 0;
let traversed = false;
history.replaceState({ ...(history.state ?? {}), sybleDepth: depth }, '');
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

window.addEventListener('hashchange', () => {
  const stamped = history.state?.sybleDepth;
  if (typeof stamped === 'number') {
    // Back/forward onto an existing history entry.
    depth = stamped;
    traversed = true;
  } else {
    depth += 1;
    traversed = false;
    history.replaceState({ ...(history.state ?? {}), sybleDepth: depth }, '');
  }
  current = location.hash;
  listeners.forEach((l) => l());
});

/** Key identifying the current history entry, for remembering scroll positions. */
export function historyKey() {
  return `${depth}:${location.hash.replace(/\?.*$/, '')}`;
}

/** True when the latest navigation was Back/Forward rather than a new page. */
export function wasTraversal() {
  return traversed;
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  return parseHash(hash);
}

export function navigate(to: string) {
  if (location.hash === to) return;
  location.hash = to;
}

/** Updates the URL without adding a history entry (used while typing a search). */
export function replaceRoute(to: string) {
  if (location.hash === to) return;
  history.replaceState(history.state, '', to);
  current = location.hash;
  listeners.forEach((l) => l());
}

/** Goes back within the app when possible, otherwise to a fallback route. */
export function goBack(fallback = '#/') {
  if (depth > 0) history.back();
  else {
    history.replaceState(history.state, '', fallback);
    current = location.hash;
    listeners.forEach((l) => l());
  }
}
