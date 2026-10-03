import { Component, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useRoute, href, navigate, historyKey, wasTraversal, type Route } from '../state/router';
import { useStore } from '../state/store';
import { dismissToast, isSheetOpen, openSheet, toast, useUi } from '../state/ui';
import { isImageFile } from '../lib/images';
import { Wordmark } from './components/Wordmark';
import { EntrySheet } from './components/EntrySheet';
import { ConfirmHost } from './components/Confirm';
import { SearchView, SEARCH_INPUT_ID } from './views/SearchView';
import { EntryView } from './views/EntryView';
import { AllView } from './views/AllView';
import { TagView } from './views/TagView';
import { TagsView } from './views/TagsView';
import { LibraryView } from './views/LibraryView';

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el?.closest?.('input, textarea, select, [contenteditable="true"]');
}

/**
 * Focuses the search field, navigating home first if needed. iOS only opens the
 * keyboard for focus() inside the tap itself, so a stand-in input takes focus
 * synchronously and hands it to the real field once the home view has mounted.
 */
function focusSearch() {
  const existing = document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null;
  if (existing) {
    existing.focus();
    existing.select();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    return;
  }
  const standIn = document.createElement('input');
  standIn.setAttribute('aria-hidden', 'true');
  standIn.tabIndex = -1;
  standIn.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;';
  document.body.append(standIn);
  standIn.focus();
  navigate(href.home());
  let tries = 0;
  const handOff = () => {
    const el = document.getElementById(SEARCH_INPUT_ID) as HTMLInputElement | null;
    if (el) {
      el.focus();
      standIn.remove();
    } else if (tries++ < 60) requestAnimationFrame(handOff);
    else standIn.remove();
  };
  requestAnimationFrame(handOff);
}

const URL_RE = /^https?:\/\/\S+$/i;

export function App() {
  const route = useRoute();
  const sheet = useUi((s) => s.sheet);
  const toasts = useUi((s) => s.toasts);
  const error = useStore((s) => s.error);
  const [dropping, setDropping] = useState(false);

  // Global shortcuts: "/" search, "n" new entry.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || isSheetOpen()) return;
      if (document.querySelector('dialog[open]')) return;
      if (e.key === '/') {
        e.preventDefault();
        focusSearch();
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        openSheet();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Paste images anywhere (⌘V / Ctrl+V) to start an entry; a pasted URL becomes its link.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const data = e.clipboardData;
      if (!data) return;
      // Rich clipboards (Word, Keynote…) carry text and an image; in a text field the text wins.
      if (isTyping(e.target) && data.getData('text/plain').trim()) return;
      const all = [...data.files];
      const files = all.filter(isImageFile);
      if (files.length) {
        e.preventDefault();
        openSheet({ files });
        return;
      }
      if (all.length && !isSheetOpen()) {
        toast('Only images can be added to Syble.');
        return;
      }
      if (isTyping(e.target) || isSheetOpen() || document.querySelector('dialog[open]')) return;
      const text = data.getData('text').trim();
      if (URL_RE.test(text)) {
        e.preventDefault();
        openSheet({ link: text });
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  // Drag images from the desktop onto the window.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e) || isSheetOpen()) return;
      depth++;
      setDropping(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDropping(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDropping(false);
      const all = [...(e.dataTransfer?.files ?? [])];
      const files = all.filter(isImageFile);
      if (files.length) openSheet({ files });
      if (files.length < all.length) toast(`${all.length - files.length} file(s) skipped — only images can be added.`);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  useScrollMemory(route);

  return (
    <div className={`app app--${route.name}`}>
      <Header route={route} />
      <main className="main" id="main" tabIndex={-1}>
        {error ? (
          <div className="page page--narrow">
            <div className="empty">
              <p className="empty__title">{error}</p>
              <p className="label">Private browsing modes can block on-device storage. Try a normal window.</p>
            </div>
          </div>
        ) : (
          <ErrorBoundary key={location.hash}>
            <View route={route} />
          </ErrorBoundary>
        )}
      </main>
      <Dock route={route} />
      <ConfirmHost />
      {sheet && <EntrySheet key={sheet.nonce} request={sheet} />}
      {dropping && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay__inner">
            <span className="drop-overlay__title">Drop to add</span>
            <span className="label">Images become a new entry</span>
          </div>
        </div>
      )}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span>{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="toast__action"
                onClick={() => {
                  t.action!.run();
                  dismissToast(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * New pages start at the top; Back/Forward returns to where you were
 * (e.g. the same spot in a long list of search results).
 */
function useScrollMemory(route: Route) {
  const positions = useRef(new Map<string, number>());
  const keyRef = useRef(historyKey());

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => positions.current.set(keyRef.current, window.scrollY));
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Typing a search replaces the URL but is not a page change.
  const pageKey = route.name === 'home' ? 'home' : JSON.stringify(route);
  const firstRun = useRef(true);
  useLayoutEffect(() => {
    keyRef.current = historyKey();
    // Move focus to the new page's heading so keyboard and screen-reader users
    // land on it (not on the first page load, and never away from an open dialog).
    if (firstRun.current) firstRun.current = false;
    else if (!document.querySelector('dialog[open]')) {
      const target = document.querySelector<HTMLElement>('#main h1') ?? document.getElementById('main');
      if (target) {
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }
    }
    const saved = wasTraversal() ? positions.current.get(keyRef.current) : undefined;
    if (saved === undefined) {
      window.scrollTo(0, 0);
      return;
    }
    // Content (and lazily paged grids) may need a few frames to reach the old height;
    // keep re-applying until it holds for a few frames, unless the user scrolls first.
    const root = document.documentElement;
    root.style.overflowAnchor = 'none';
    let frame = 0;
    let tries = 0;
    let settled = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      root.style.overflowAnchor = '';
      for (const ev of ['wheel', 'touchstart', 'keydown'] as const) window.removeEventListener(ev, stop);
    };
    for (const ev of ['wheel', 'touchstart', 'keydown'] as const) window.addEventListener(ev, stop, { once: true, passive: true });
    const attempt = () => {
      window.scrollTo(0, saved);
      settled = Math.abs(window.scrollY - saved) <= 2 ? settled + 1 : 0;
      if (settled >= 3 || ++tries > 60) stop();
      else frame = requestAnimationFrame(attempt);
    };
    attempt();
    return stop;
  }, [pageKey]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Keeps one broken view from blanking the whole app. */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="page page--narrow">
        <div className="empty">
          <p className="empty__title">Something went wrong on this page.</p>
          <a className="button" href={href.home()}>
            Back to search
          </a>
        </div>
      </div>
    );
  }
}

function View({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <SearchView initialQuery={route.q} />;
    case 'entry':
      return <EntryView id={route.id} />;
    case 'tag':
      return <TagView tag={route.tag} />;
    case 'tags':
      return <TagsView />;
    case 'all':
      return <AllView />;
    case 'library':
      return <LibraryView />;
  }
}

const NAV = [
  { name: 'all', label: 'Index', to: href.all() },
  { name: 'tags', label: 'Tags', to: href.tags() },
  { name: 'library', label: 'Library', to: href.library() },
] as const;

function Header({ route }: { route: Route }) {
  const current = route.name === 'tag' ? 'tags' : route.name;
  return (
    <header className="header">
      <Wordmark />
      <nav className="header__nav" aria-label="Sections">
        {NAV.map((n) => (
          <a key={n.name} href={n.to} className={`header__link label ${current === n.name ? 'is-on' : ''}`} aria-current={current === n.name ? 'page' : undefined}>
            {n.label}
          </a>
        ))}
        <button type="button" className="header__add" onClick={() => openSheet()}>
          <span aria-hidden="true">+</span> Add
        </button>
      </nav>
    </header>
  );
}

/** Mobile: search and add always within thumb's reach. */
function Dock({ route }: { route: Route }) {
  return (
    <nav className="dock" aria-label="Quick actions">
      {route.name !== 'home' ? (
        <button type="button" className="dock__search" onClick={focusSearch}>
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M12.6 12.6 17 17" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <span>Search</span>
        </button>
      ) : (
        <span className="dock__spacer" />
      )}
      <button type="button" className="dock__add" onClick={() => openSheet()} aria-label="Add a source">
        <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
          <path d="M10 3v14M3 10h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </nav>
  );
}
