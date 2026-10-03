import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';

/**
 * Syble's own confirmation dialog, used instead of the browser's confirm()/prompt():
 * it matches the design, and works in embedded views that suppress native dialogs.
 */

export interface AskOptions {
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  /** When set, the user must type this word to enable the confirm button. */
  typeToConfirm?: string;
}

interface Pending extends AskOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

let pending: Pending | null = null;
let counter = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Asks the user to confirm; resolves true when they do. */
export function ask(options: AskOptions): Promise<boolean> {
  pending?.resolve(false);
  return new Promise((resolve) => {
    pending = { ...options, id: ++counter, resolve };
    emit();
  });
}

function settle(ok: boolean) {
  const p = pending;
  pending = null;
  emit();
  p?.resolve(ok);
}

export function ConfirmHost() {
  const current = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending,
  );
  return current ? <ConfirmDialog key={current.id} request={current} /> : null;
}

function ConfirmDialog({ request }: { request: Pending }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState('');
  const titleId = useId();
  const bodyId = useId();
  const needsWord = request.typeToConfirm;
  const ready = !needsWord || typed.trim().toLowerCase() === needsWord.toLowerCase();

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    const opener = document.activeElement as HTMLElement | null;
    if (!dlg.open) dlg.showModal();
    // Start on the safe choice (or the text field when a word is required).
    dlg.querySelector<HTMLElement>(needsWord ? 'input' : '.confirm__cancel')?.focus();
    return () => {
      if (opener && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [needsWord]);

  return (
    <dialog
      ref={ref}
      className="confirm"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={request.body ? bodyId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        settle(false);
      }}
      onClose={() => {
        // Closed by the browser itself: treat as "keep".
        if (pending?.id === request.id) settle(false);
      }}
    >
      <form
        className="confirm__panel"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) settle(true);
        }}
      >
        <h2 id={titleId} className="confirm__title">
          {request.title}
        </h2>
        {request.body && (
          <p id={bodyId} className="confirm__body">
            {request.body}
          </p>
        )}
        {needsWord && (
          <label className="field-block">
            <span className="label">Type “{needsWord}” to confirm</span>
            <input
              className="field"
              value={typed}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setTyped(e.target.value)}
            />
          </label>
        )}
        <div className="confirm__actions">
          <button type="button" className="button confirm__cancel" onClick={() => settle(false)}>
            {request.cancelLabel ?? 'Keep'}
          </button>
          <button type="submit" className={`button ${request.danger ? 'button--danger-solid' : 'button--primary'}`} disabled={!ready}>
            {request.confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
