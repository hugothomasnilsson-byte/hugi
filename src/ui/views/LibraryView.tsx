import { useEffect, useRef, useState } from 'react';
import { reloadStore, rereadAllImages, useDerived, useStore } from '../../state/store';
import { OCR_LANGUAGES, getOcrLanguages, ocrLanguageUrl, saveOcrLanguages } from '../../lib/ocrLanguages';
import { setOcrLanguages } from '../../lib/ocr';
import { toast } from '../../state/ui';
import { exportLibrary, importLibrary, backupFileName, BackupError, type ImportMode } from '../../lib/backup';
import { clearLibrary } from '../../lib/db';
import { MOD, formatBytes, plural } from '../format';
import { useTheme, type ThemePref } from '../theme';
import { Segmented } from '../components/Segmented';

export function LibraryView() {
  const { byNewest, tagCounts } = useDerived();
  const images = useStore((s) => s.images);
  const [theme, setTheme] = useTheme();
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [mode, setMode] = useState<ImportMode>('merge');
  const fileRef = useRef<HTMLInputElement>(null);

  const imageBytes = [...images.values()].reduce((n, m) => n + m.size, 0);

  useEffect(() => {
    void navigator.storage?.estimate?.().then((e) => setUsage({ used: e.usage ?? 0, quota: e.quota ?? 0 }));
    void navigator.storage?.persisted?.().then(setPersisted);
  }, [images]);

  // On phones the share sheet saves to Files / Drive / AirDrop. Safari only opens it
  // straight from a tap, so the backup is prepared first and shared on a second tap.
  const [ready, setReady] = useState<File | null>(null);
  const preferShare = () =>
    window.matchMedia('(pointer: coarse)').matches && typeof navigator.canShare === 'function';

  const onExport = async () => {
    setBusy('Preparing backup…');
    setProgress(0);
    setReady(null);
    try {
      const blob = await exportLibrary(setProgress);
      const name = backupFileName(new Date());
      const file = new File([blob], name, { type: 'application/zip' });
      if (preferShare() && navigator.canShare({ files: [file] })) setReady(file);
      else {
        download(blob, name);
        toast(`Backup saved · ${formatBytes(blob.size)}`);
      }
    } catch (err) {
      console.error(err);
      toast('Could not create the backup.');
    } finally {
      setBusy(null);
    }
  };

  const onShare = () => {
    if (!ready) return;
    const file = ready;
    navigator
      .share({ files: [file], title: file.name })
      .then(() => {
        setReady(null);
        toast(`Backup saved · ${formatBytes(file.size)}`);
      })
      .catch((err: DOMException) => {
        if (err.name === 'AbortError') return;
        download(file, file.name);
        setReady(null);
      });
  };

  const onImport = async (file: File) => {
    if (
      mode === 'replace' &&
      byNewest.length > 0 &&
      !confirm(`Replace your library with this backup? Your current ${plural(byNewest.length, 'entry', 'entries')} will be removed.`)
    )
      return;
    setBusy('Importing…');
    setProgress(0);
    try {
      const summary = await importLibrary(file, mode, setProgress);
      await reloadStore();
      toast(
        `Imported ${plural(summary.entries, 'entry', 'entries')} and ${plural(summary.images, 'image')}` +
          (summary.skipped ? ` · ${summary.skipped} skipped` : ''),
      );
    } catch (err) {
      console.error(err);
      toast(err instanceof BackupError ? err.message : 'That file could not be imported.');
    } finally {
      setBusy(null);
    }
  };

  const onPersist = async () => {
    const ok = await navigator.storage?.persist?.();
    setPersisted(!!ok);
    toast(ok ? 'This device will keep your library.' : 'The browser declined — install Syble to your home screen and try again.');
  };

  const onErase = async () => {
    const answer = prompt(`This permanently erases all ${plural(byNewest.length, 'entry', 'entries')} from this device.\nType “erase” to confirm.`);
    if (answer?.trim().toLowerCase() !== 'erase') return;
    await clearLibrary();
    await reloadStore();
    toast('Library erased');
  };

  return (
    <div className="page page--narrow library">
      <header className="page-head">
        <p className="label">Kept on this device</p>
        <h1 className="page-title">Library</h1>
      </header>

      <section className="library__stats" aria-label="Library contents">
        <Stat value={byNewest.length} label={byNewest.length === 1 ? 'Entry' : 'Entries'} />
        <Stat value={images.size} label={images.size === 1 ? 'Image' : 'Images'} />
        <Stat value={tagCounts.size} label={tagCounts.size === 1 ? 'Hashtag' : 'Hashtags'} />
        <Stat value={formatBytes(imageBytes)} label="Library size" />
      </section>

      <section className="library__section">
        <div className="library__text">
          <h2 className="library__h">Back up</h2>
          <p>
            Save your whole almanac — entries, images, extracted text and tags — as a single <span className="mono">.zip</span>{' '}
            file. Keep it somewhere safe, or open it on another device to move your library.
          </p>
        </div>
        <div className="library__actions">
          {ready ? (
            <button type="button" className="button button--primary" onClick={onShare}>
              Save backup ({formatBytes(ready.size)})…
            </button>
          ) : (
            <button type="button" className="button button--primary" onClick={onExport} disabled={!!busy || byNewest.length === 0}>
              Export library
            </button>
          )}
        </div>
      </section>

      <section className="library__section">
        <div className="library__text">
          <h2 className="library__h">Restore</h2>
          <p>Import a Syble backup. Merging keeps everything you have and adds or updates entries from the file.</p>
          <Segmented
            label="Import mode"
            value={mode}
            options={[
              { value: 'merge', label: 'Merge' },
              { value: 'replace', label: 'Replace all' },
            ]}
            onChange={setMode}
          />
        </div>
        <div className="library__actions">
          <button type="button" className="button" onClick={() => fileRef.current?.click()} disabled={!!busy}>
            Import backup…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void onImport(f);
            }}
          />
        </div>
      </section>

      {busy && (
        <div className="library__progress" role="status">
          <span className="label">{busy}</span>
          <span className="progress">
            <span className="progress__bar" style={{ transform: `scaleX(${progress})` }} />
          </span>
        </div>
      )}

      <ReadingLanguages />

      <section className="library__section">
        <div className="library__text">
          <h2 className="library__h">Appearance</h2>
        </div>
        <div className="library__actions">
          <Segmented<ThemePref>
            label="Theme"
            value={theme}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
            onChange={setTheme}
          />
        </div>
      </section>

      <section className="library__section">
        <div className="library__text">
          <h2 className="library__h">Privacy</h2>
          <p>
            Syble never connects to the internet. Text in your images is read on this device, and nothing is uploaded,
            synced or tracked. Your library lives in this browser’s storage
            {usage?.quota
              ? ` (${formatBytes(usage.used)} used including the app and its offline text engine, ${formatBytes(usage.quota)} available)`
              : ''}
            .
          </p>
          <p className="label">
            {persisted === true
              ? 'Protected: this device won’t clear your library to free space.'
              : 'Ask the browser to protect your library from automatic clean-up.'}
          </p>
        </div>
        <div className="library__actions">
          {persisted !== true && (
            <button type="button" className="button" onClick={onPersist}>
              Keep data on this device
            </button>
          )}
        </div>
      </section>

      <section className="library__section only-fine">
        <div className="library__text">
          <h2 className="library__h">Shortcuts</h2>
          <dl className="shortcuts">
            <dt><kbd>/</kbd></dt><dd>Search</dd>
            <dt><kbd>{MOD}</kbd> <kbd>V</kbd></dt><dd>Add from clipboard</dd>
            <dt><kbd>N</kbd></dt><dd>New entry</dd>
            <dt><kbd>{MOD}</kbd> <kbd>↵</kbd></dt><dd>Save entry</dd>
            <dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Previous / next image</dd>
            <dt><kbd>Esc</kbd></dt><dd>Close · clear search</dd>
          </dl>
        </div>
      </section>

      <section className="library__section library__section--danger">
        <div className="library__text">
          <h2 className="library__h">Erase</h2>
          <p>Remove every entry and image from this device. Export a backup first.</p>
        </div>
        <div className="library__actions">
          <button type="button" className="button button--danger" onClick={onErase} disabled={!!busy || byNewest.length === 0}>
            Erase library…
          </button>
        </div>
      </section>

      <p className="library__colophon label">Syble · a personal almanac · works offline</p>
    </div>
  );
}

/** Which languages the on-device text reader recognises. */
function ReadingLanguages() {
  const [langs, setLangs] = useState<string[]>(getOcrLanguages);
  const [loading, setLoading] = useState<string | null>(null);
  const imageCount = useStore((s) => s.images.size);

  const toggle = async (code: string) => {
    if (code === 'eng' || loading) return;
    let next: string[];
    if (langs.includes(code)) next = langs.filter((c) => c !== code);
    else {
      setLoading(code);
      try {
        // Served by Syble itself; the offline cache keeps it from now on.
        const res = await fetch(ocrLanguageUrl(code));
        if (!res.ok) throw new Error(String(res.status));
        await res.arrayBuffer();
      } catch {
        toast('That language isn’t available offline yet. Connect once to add it.');
        return;
      } finally {
        setLoading(null);
      }
      next = [...langs, code];
    }
    setLangs(next);
    saveOcrLanguages(next);
    setOcrLanguages(next);
  };

  const reread = async () => {
    const n = await rereadAllImages();
    toast(n ? `Re-reading ${plural(n, 'image')} on this device…` : 'Every image has hand-corrected text.');
  };

  return (
    <section className="library__section">
      <div className="library__text">
        <h2 className="library__h">Reading text</h2>
        <p>
          Text in your images is read on this device. Add the languages you collect in, so accents and special letters
          come out right.
        </p>
        <div className="chip-row" role="group" aria-label="Recognition languages">
          {OCR_LANGUAGES.map((l) => {
            const on = langs.includes(l.code);
            return (
              <button
                key={l.code}
                type="button"
                className={`chip ${on ? 'is-on' : ''}`}
                aria-pressed={on}
                disabled={l.code === 'eng'}
                onClick={() => void toggle(l.code)}
              >
                {loading === l.code ? 'Adding…' : l.name}
              </button>
            );
          })}
        </div>
      </div>
      <div className="library__actions">
        <button type="button" className="button" onClick={() => void reread()} disabled={imageCount === 0}>
          Re-read all images
        </button>
      </div>
    </section>
  );
}

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="stat">
      <span className="stat__value">{typeof value === 'number' ? value.toLocaleString() : value}</span>
      <span className="label">{label}</span>
    </div>
  );
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
