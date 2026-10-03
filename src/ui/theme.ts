import { useEffect, useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'syble:theme';

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** True when Syble itself set data-theme, so "System" only clears its own choice
 *  (a host page embedding Syble may set the attribute too). */
let ownTheme = false;

function apply(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'system') {
    if (ownTheme) delete root.dataset.theme;
    ownTheme = false;
  } else {
    root.dataset.theme = pref;
    ownTheme = true;
  }
  // Keep the browser chrome (status bar, tab strip) in step with the page.
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    m.content = dark ? '#11100e' : '#f6f4ef';
  }
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(read);
  useEffect(() => {
    apply(pref);
    try {
      if (pref === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, pref);
    } catch {
      /* ignore */
    }
  }, [pref]);
  return [pref, setPref] as const;
}

export function initTheme() {
  // index.html applies a saved light/dark choice before first paint.
  ownTheme = read() !== 'system';
  apply(read());
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => apply(read()));
}
