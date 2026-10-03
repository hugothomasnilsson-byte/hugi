import { useSyncExternalStore } from 'react';
import type { ID } from '../types';

/** Transient UI state shared across views: the add/edit sheet and toasts. */

export interface SheetRequest {
  /** Entry being edited; undefined when adding. */
  entryId?: ID;
  /** Files to start a new entry with (paste / drop / pick). */
  files?: File[];
  link?: string;
  /** Increments so repeated requests with the same payload are distinct. */
  nonce: number;
}

export interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
}

interface UiState {
  sheet: SheetRequest | null;
  /** Files dropped/pasted while the sheet is already open. */
  incoming: { files: File[]; nonce: number } | null;
  toasts: Toast[];
}

let ui: UiState = { sheet: null, incoming: null, toasts: [] };
const listeners = new Set<() => void>();
let nonce = 0;

function set(patch: Partial<UiState>) {
  ui = { ...ui, ...patch };
  listeners.forEach((l) => l());
}

export function useUi<T>(sel: (s: UiState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => sel(ui),
  );
}

export function openSheet(req: Omit<SheetRequest, 'nonce'> = {}) {
  if (ui.sheet && !req.entryId && req.files?.length) {
    // Already composing: append the new images to the open draft.
    set({ incoming: { files: req.files, nonce: ++nonce } });
    return;
  }
  if (ui.sheet) return;
  set({ sheet: { ...req, nonce: ++nonce } });
}

export function closeSheet() {
  set({ sheet: null, incoming: null });
}

export function isSheetOpen() {
  return ui.sheet !== null;
}

let toastId = 0;
export function toast(message: string, action?: Toast['action'], ms = 4200) {
  const t: Toast = { id: ++toastId, message, action };
  set({ toasts: [...ui.toasts, t].slice(-3) });
  window.setTimeout(() => dismissToast(t.id), ms);
}

export function dismissToast(id: number) {
  set({ toasts: ui.toasts.filter((t) => t.id !== id) });
}
