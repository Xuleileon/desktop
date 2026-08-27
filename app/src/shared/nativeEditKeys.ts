/**
 * Priority boundary between app-level (vim-style) shortcuts and the browser's
 * native editing shortcuts.
 *
 * Several renderer surfaces bind Ctrl/Cmd+C to "pause/cancel session" and call
 * preventDefault() unconditionally. That swallows the user's native copy when
 * they have selected text outside of an input. These predicates let each
 * listener bail out early so the native edit operation wins.
 */

type EditTarget = Pick<HTMLElement, 'tagName' | 'isContentEditable'>;

const NATIVE_EDIT_KEYS = new Set(['c', 'x', 'a', 'v', 'z', 'y']);
const COPY_LIKE_KEYS = new Set(['c', 'x']);

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as unknown as Partial<EditTarget> | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
}

function hasPrimaryModifier(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey;
}

export function hasActiveTextSelection(): boolean {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return false;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  return selection.toString().trim().length > 0;
}

export function isNativeEditShortcut(e: KeyboardEvent): boolean {
  if (!hasPrimaryModifier(e)) return false;
  return NATIVE_EDIT_KEYS.has(e.key.toLowerCase());
}

export function shouldYieldToNativeEdit(e: KeyboardEvent): boolean {
  if (isEditableTarget(e.target)) return true;
  if (!hasPrimaryModifier(e)) return false;
  return COPY_LIKE_KEYS.has(e.key.toLowerCase()) && hasActiveTextSelection();
}