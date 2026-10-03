import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ID, ImageMeta } from '../../types';
import {
  analyzeImage,
  entryImages,
  forgetAnalysis,
  getState,
  saveDraft,
  useDerived,
  useStore,
} from '../../state/store';
import { closeSheet, toast, useUi, type SheetRequest } from '../../state/ui';
import { href, navigate } from '../../state/router';
import { isImageFile, prepareImage, type PreparedImage } from '../../lib/images';
import { mergePalettes } from '../../lib/colour';
import { suggestTags } from '../../lib/suggest';
import { newId } from '../../lib/id';
import { TagInput } from './TagInput';
import { Img } from './Img';
import { OcrBadge } from './OcrBadge';
import { MOD } from '../format';
import { ask } from './Confirm';

interface SheetImage {
  id: ID;
  status: 'preparing' | 'ready' | 'error';
  prepared?: PreparedImage;
  previewUrl?: string;
  /** Saved image (editing an existing entry). */
  meta?: ImageMeta;
  ratio: number;
  error?: string;
}

export function EntrySheet({ request }: { request: SheetRequest }) {
  const editing = request.entryId ? getState().entries.get(request.entryId) : undefined;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState(editing?.title ?? '');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [link, setLink] = useState(editing?.link ?? request.link ?? '');
  const [credit, setCredit] = useState(editing?.credit ?? '');
  const [tags, setTags] = useState<string[]>(editing?.tags ?? []);
  const [dismissed, setDismissed] = useState<string[]>(editing?.dismissedTags ?? []);
  const [images, setImages] = useState<SheetImage[]>(() =>
    editing
      ? entryImages(editing).map((meta) => ({ id: meta.id, status: 'ready', meta, ratio: meta.width / meta.height }))
      : [],
  );
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dirty, setDirty] = useState(false);

  const analysis = useStore((s) => s.analysis);
  const savedImages = useStore((s) => s.images);
  const { tagCounts } = useDerived();

  const touch = () => setDirty(true);

  // Images still in this draft, and whether the sheet has been torn down, so late
  // results for discarded images are ignored instead of being read and leaked.
  const live = useRef(new Set<ID>());
  const disposed = useRef(false);
  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
    };
  }, []);
  /** Set right before we close the sheet ourselves, to tell our close from the browser's. */
  const closing = useRef(false);
  const navigatedAway = useRef(false);
  const downOnBackdrop = useRef(false);
  const dragTimer = useRef<number | undefined>(undefined);

  /* ---------------- images ---------------- */

  const addFiles = useCallback((files: File[]) => {
    const accepted = files.filter(isImageFile);
    if (accepted.length < files.length) toast(`${files.length - accepted.length} file(s) skipped — only images can be added.`);
    if (!accepted.length) return;
    setDirty(true);
    const fresh = accepted.map((file) => ({ file, id: newId() }));
    for (const { id } of fresh) live.current.add(id);
    setImages((prev) => [...prev, ...fresh.map(({ id }) => ({ id, status: 'preparing' as const, ratio: 1 }))]);
    for (const { file, id } of fresh) {
      prepareImage(file)
        .then((prepared) => {
          if (disposed.current || !live.current.has(id)) return;
          const previewUrl = URL.createObjectURL(prepared.thumb);
          setImages((prev) =>
            prev.map((img) =>
              img.id === id ? { ...img, status: 'ready', prepared, previewUrl, ratio: prepared.width / prepared.height } : img,
            ),
          );
          analyzeImage(id, prepared.full, prepared.thumb);
        })
        .catch((err: Error) => {
          setImages((prev) => prev.map((img) => (img.id === id ? { ...img, status: 'error', error: err.message } : img)));
        });
    }
  }, []);

  // Files that opened the sheet, and files pasted/dropped while it is open.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (request.files?.length) addFiles(request.files);
  }, [request.files, addFiles]);

  const incoming = useUi((s) => s.incoming);
  const seenIncoming = useRef(0);
  useEffect(() => {
    if (incoming && incoming.nonce !== seenIncoming.current) {
      seenIncoming.current = incoming.nonce;
      addFiles(incoming.files);
    }
  }, [incoming, addFiles]);

  const removeImage = (id: ID) => {
    touch();
    live.current.delete(id);
    const img = images.find((i) => i.id === id);
    if (img?.previewUrl) URL.revokeObjectURL(img.previewUrl);
    if (img && !img.meta) forgetAnalysis([id]);
    setImages((prev) => prev.filter((i) => i.id !== id));
  };

  const moveImage = (id: ID, dir: -1 | 1) => {
    touch();
    setImages((prev) => {
      const i = prev.findIndex((x) => x.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  /* ---------------- suggestions ---------------- */

  const textOf = (img: SheetImage) => (img.meta ? savedImages.get(img.id)?.text : analysis.get(img.id)?.text) ?? '';
  const paletteOf = (img: SheetImage) =>
    (img.meta ? savedImages.get(img.id)?.palette : analysis.get(img.id)?.palette) ?? [];

  const ocrText = images.map(textOf).join('\n');
  const palettes = images.map(paletteOf).filter((p) => p.length);
  const paletteKey = palettes.map((p) => p.map((s) => s.hex).join()).join('|');

  const suggestions = useMemo(
    () =>
      suggestTags(
        {
          title,
          notes,
          text: ocrText,
          palette: palettes.length > 1 ? mergePalettes(palettes) : (palettes[0] ?? []),
          tags,
          dismissed,
          library: tagCounts,
        },
        6,
      ),
    [title, notes, ocrText, paletteKey, tags, dismissed, tagCounts],
  );

  /* ---------------- dialog lifecycle ---------------- */

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    // Return focus to whatever opened the sheet (Add, Edit…) when it closes.
    const opener = document.activeElement as HTMLElement | null;
    if (!dlg.open) dlg.showModal();
    const root = document.documentElement;
    root.classList.add('is-locked');
    if (!request.files?.length && window.matchMedia('(hover: hover)').matches) titleRef.current?.focus();

    // Track the visible viewport so the footer's Save stays above the iOS keyboard.
    const vv = window.visualViewport;
    const fit = () => vv && root.style.setProperty('--vvh', `${vv.height}px`);
    fit();
    vv?.addEventListener('resize', fit);
    return () => {
      vv?.removeEventListener('resize', fit);
      root.style.removeProperty('--vvh');
      root.classList.remove('is-locked');
      // After adding, we navigate to the new entry; its heading takes focus instead.
      if (!navigatedAway.current && opener && opener !== document.body && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [request.files]);

  const cleanup = (saved: boolean) => {
    disposed.current = true;
    window.clearTimeout(dragTimer.current);
    for (const img of images) if (img.previewUrl) URL.revokeObjectURL(img.previewUrl);
    if (!saved) forgetAnalysis(images.filter((i) => !i.meta).map((i) => i.id));
  };

  const close = (saved: boolean) => {
    cleanup(saved);
    closing.current = true;
    closeSheet();
  };

  const asking = useRef(false);
  const cancel = async () => {
    if (saving || asking.current) return;
    if (dirty) {
      asking.current = true;
      const discard = await ask({
        title: editing ? 'Discard your changes?' : 'Discard this entry?',
        body: editing ? 'The entry stays as it was before you opened it.' : 'Nothing from this draft will be kept.',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        danger: true,
      });
      asking.current = false;
      if (!discard) return;
    }
    close(false);
  };

  const preparing = images.some((i) => i.status === 'preparing');
  const usable = images.filter((i) => i.status === 'ready');
  const hasContent =
    usable.length > 0 || !!title.trim() || !!notes.trim() || !!link.trim() || !!credit.trim() || tags.length > 0;
  const canSave = !saving && !preparing && hasContent;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const id = await saveDraft(
        {
          title,
          notes,
          link,
          credit,
          tags,
          images: usable.map((i) => ({ id: i.id, prepared: i.meta ? undefined : i.prepared })),
          dismissedTags: dismissed,
        },
        editing?.id,
      );
      if (!editing) navigatedAway.current = true;
      close(true);
      if (!editing) {
        navigate(href.entry(id));
        toast('Added to your almanac');
      } else toast('Saved');
    } catch (err) {
      console.error(err);
      setSaving(false);
      toast('Could not save — your device may be out of storage.');
    }
  };

  /* ---------------- render ---------------- */

  return (
    <dialog
      ref={dialogRef}
      className={`sheet ${dragging ? 'is-dragging' : ''}`}
      aria-labelledby="sheet-title"
      onCancel={(e) => {
        e.preventDefault();
        void cancel();
      }}
      onClose={() => {
        // The browser may close a modal dialog on its own (e.g. after repeated Escape
        // presses). Reopen a draft with unsaved work; tear down a clean one fully.
        if (closing.current) return;
        const dlg = dialogRef.current;
        if (!dlg?.isConnected) return;
        if (dirty || saving) dlg.showModal();
        else close(false);
      }}
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // Only a press that started and ended on the backdrop closes the sheet,
        // not a text selection dragged past the panel's edge.
        const onBackdrop = downOnBackdrop.current && e.target === e.currentTarget;
        downOnBackdrop.current = false;
        if (onBackdrop) void cancel();
      }}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          void save();
        }
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        setDragging(true);
        // dragover repeats while hovering; when it stops, the drag has left or been cancelled.
        window.clearTimeout(dragTimer.current);
        dragTimer.current = window.setTimeout(() => setDragging(false), 250);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        // Text and links dropped into a field insert normally.
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        window.clearTimeout(dragTimer.current);
        setDragging(false);
        addFiles([...e.dataTransfer.files]);
      }}
    >
      <form
        className="sheet__panel"
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <header className="sheet__head">
          <button type="button" className="sheet__cancel label" onClick={() => void cancel()}>
            Cancel
          </button>
          <h2 id="sheet-title" className="sheet__heading label">
            {editing ? 'Edit entry' : 'New entry'}
          </h2>
          <button type="submit" className="sheet__save-top label" disabled={!canSave}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </header>

        <div className="sheet__body">
          <section className={`sheet__images ${images.length ? '' : 'is-empty'}`} aria-label="Images">
            {images.length === 0 ? (
              <button type="button" className="dropzone" onClick={() => fileRef.current?.click()}>
                <span className="dropzone__title">Add images</span>
                <span className="dropzone__hint label">
                  <span className="only-fine">Drop, paste ({MOD} V) or </span>choose from your library
                </span>
              </button>
            ) : (
              <ol className="plates">
                {images.map((img, i) => {
                  const a = analysis.get(img.id);
                  return (
                    <li
                      key={img.id}
                      className={`plate ${img.status}`}
                      style={{ '--r': Math.min(2, Math.max(0.5, img.ratio)) } as CSSProperties}
                    >
                      <div className="plate__frame" style={{ aspectRatio: String(Math.min(2, Math.max(0.5, img.ratio))) }}>
                        {img.meta ? (
                          <Img id={img.id} alt={`Image ${i + 1}`} className="plate__img" />
                        ) : img.previewUrl ? (
                          <img className="plate__img" src={img.previewUrl} alt={`Image ${i + 1}`} />
                        ) : (
                          <div className="plate__placeholder label">{img.status === 'error' ? 'Unreadable' : 'Preparing…'}</div>
                        )}
                        {!img.meta && a?.status === 'running' && (
                          <span className="plate__progress" style={{ transform: `scaleX(${a.progress})` }} aria-hidden="true" />
                        )}
                      </div>
                      <div className="plate__bar">
                        <span className="label">
                          {i === 0 ? 'Cover' : `Plate ${i + 1}`}
                          {!img.meta && img.status === 'ready' && a && <OcrBadge analysis={a} />}
                        </span>
                        <span className="plate__actions">
                          {i > 0 && (
                            <button type="button" className="icon-btn" onClick={() => moveImage(img.id, -1)} aria-label="Move earlier">
                              ←
                            </button>
                          )}
                          {i < images.length - 1 && (
                            <button type="button" className="icon-btn" onClick={() => moveImage(img.id, 1)} aria-label="Move later">
                              →
                            </button>
                          )}
                          <button type="button" className="icon-btn" onClick={() => removeImage(img.id)} aria-label="Remove image">
                            ×
                          </button>
                        </span>
                      </div>
                      {img.error && <p className="plate__error label">{img.error}</p>}
                    </li>
                  );
                })}
                <li className="plate plate--add">
                  <button type="button" className="plate__add" onClick={() => fileRef.current?.click()}>
                    <span aria-hidden="true">+</span>
                    <span className="label">Add image</span>
                  </button>
                </li>
              </ol>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
          </section>

          <section className="sheet__fields">
            <label className="field-block">
              <span className="visually-hidden">Title</span>
              <input
                ref={titleRef}
                className="field field--title"
                placeholder="Title"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  touch();
                }}
              />
            </label>

            <label className="field-block">
              <span className="label">Notes</span>
              <textarea
                className="field field--notes"
                placeholder="Why it matters, what to remember…"
                rows={4}
                value={notes}
                onChange={(e) => {
                  setNotes(e.target.value);
                  touch();
                }}
              />
            </label>

            <div className="field-pair">
              <label className="field-block">
                <span className="label">Link</span>
                <input
                  className="field"
                  type="url"
                  inputMode="url"
                  placeholder="https://"
                  autoCapitalize="off"
                  autoCorrect="off"
                  value={link}
                  onChange={(e) => {
                    setLink(e.target.value);
                    touch();
                  }}
                />
              </label>
              <label className="field-block">
                <span className="label">Credit</span>
                <input
                  className="field"
                  placeholder="Artist, author, place"
                  value={credit}
                  onChange={(e) => {
                    setCredit(e.target.value);
                    touch();
                  }}
                />
              </label>
            </div>

            <div className="field-block">
              <span className="label">Hashtags</span>
              <TagInput
                tags={tags}
                library={tagCounts}
                onChange={(t) => {
                  setTags(t);
                  touch();
                }}
              />
              {suggestions.length > 0 && (
                <div className="suggest" role="group" aria-label="Suggested hashtags">
                  <span className="label">Suggested</span>
                  {suggestions.map((t) => (
                    <span key={t} className="chip chip--suggest">
                      <button
                        type="button"
                        className="chip__add"
                        onClick={() => {
                          setTags((prev) => [...prev, t]);
                          touch();
                        }}
                        aria-label={`Add #${t}`}
                      >
                        + #{t}
                      </button>
                      <button
                        type="button"
                        className="chip__x"
                        onClick={() => setDismissed((d) => [...d, t])}
                        aria-label={`Dismiss #${t}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

        <footer className="sheet__foot">
          <span className="sheet__status label">
            {preparing ? (
              'Preparing images…'
            ) : images.some((i) => analysis.get(i.id)?.status === 'running') ? (
              'Reading text on this device…'
            ) : hasContent ? (
              <span className="only-fine">{MOD} ↵ to save · Esc to close</span>
            ) : (
              'Add an image, a title, notes or a link'
            )}
          </span>
          <button type="button" className="button" onClick={() => void cancel()}>
            Cancel
          </button>
          <button type="submit" className="button button--primary" disabled={!canSave}>
            {saving ? 'Saving…' : editing ? 'Save changes' : hasContent ? 'Add to Syble' : 'Add something first'}
          </button>
        </footer>
      </form>
      {dragging && (
        <div className="sheet__drop" aria-hidden="true">
          <span>Drop to add</span>
        </div>
      )}
    </dialog>
  );
}
