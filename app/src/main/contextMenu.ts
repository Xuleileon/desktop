/**
 * Standard edit context menu for app UI windows.
 *
 * Electron ships no default Chromium context menu: right-clicking inside a
 * BrowserWindow does nothing unless the main process listens for the
 * `context-menu` event on its WebContents and pops a Menu itself. Without
 * this module the user cannot right-click → Copy anywhere in the app.
 *
 * Only attach this to our own renderer windows (hub / logs / pill /
 * onboarding). Automation-driven views (BrowserPool) must stay untouched so
 * the agent's page interaction is never blocked by a native popup menu.
 */

import {
  BrowserWindow,
  Menu,
  clipboard,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import { mainLogger } from './logger';

/** WebContents that already own a `context-menu` listener from this module. */
const attached = new WeakSet<WebContents>();

/**
 * Build the menu template for one right-click. Groups are assembled
 * separately and joined with separators so an empty group never leaves a
 * stray divider behind.
 */
function buildTemplate(params: ContextMenuParams): MenuItemConstructorOptions[] {
  const { editFlags } = params;
  const hasSelection = params.selectionText.trim().length > 0;
  const groups: MenuItemConstructorOptions[][] = [];

  if (params.isEditable) {
    groups.push([
      { role: 'undo', enabled: editFlags.canUndo },
      { role: 'redo', enabled: editFlags.canRedo },
    ]);
  }

  const clipboardGroup: MenuItemConstructorOptions[] = [];
  if (params.isEditable && hasSelection) {
    clipboardGroup.push({ role: 'cut', enabled: editFlags.canCut });
  }
  if (hasSelection) {
    clipboardGroup.push({ role: 'copy', enabled: editFlags.canCopy });
  }
  if (params.isEditable) {
    clipboardGroup.push({ role: 'paste', enabled: editFlags.canPaste });
  }
  if (clipboardGroup.length > 0) groups.push(clipboardGroup);

  // No Electron role copies a link target, so this one needs a click handler.
  if (params.linkURL) {
    const linkURL = params.linkURL;
    groups.push([
      {
        label: 'Copy Link Address',
        click: () => clipboard.writeText(linkURL),
      },
    ]);
  }

  if (params.isEditable || editFlags.canSelectAll) {
    groups.push([{ role: 'selectAll', enabled: editFlags.canSelectAll }]);
  }

  const template: MenuItemConstructorOptions[] = [];
  for (const group of groups) {
    if (template.length > 0) template.push({ type: 'separator' });
    template.push(...group);
  }
  return template;
}

/**
 * Attach the standard edit context menu to `contents`. Idempotent — calling
 * it twice for the same WebContents registers only one listener.
 */
export function attachEditContextMenu(contents: WebContents): void {
  // A context menu is an additive convenience: it must never be able to break
  // the creation of the window that hosts it.
  if (!contents || typeof contents.on !== 'function') return;
  if (contents.isDestroyed?.()) return;
  if (attached.has(contents)) return;
  attached.add(contents);

  contents.on('context-menu', (_event, params) => {
    const template = buildTemplate(params);
    // Nothing actionable under the cursor — don't flash an empty frame.
    if (template.length === 0) return;

    try {
      const menu = Menu.buildFromTemplate(template);
      const window = BrowserWindow.fromWebContents(contents);
      menu.popup(window ? { window } : undefined);
      mainLogger.debug('contextMenu.popup', {
        wcId: contents.id,
        itemCount: template.length,
        isEditable: params.isEditable,
        hasSelection: params.selectionText.trim().length > 0,
        hasLink: Boolean(params.linkURL),
      });
    } catch (err) {
      mainLogger.warn('contextMenu.popup.error', {
        wcId: contents.id,
        error: (err as Error).message,
      });
    }
  });

  mainLogger.debug('contextMenu.attached', { wcId: contents.id });
}