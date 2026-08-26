import React from 'react';
import type { KeyBinding, ActionId, ScreenId } from './keybindings';
import { SCREEN_COMMANDS } from './keybindings';
import { useI18n } from './i18n';

interface CommandBarProps {
  screen: ScreenId;
  keybindings: KeyBinding[];
  onClose: () => void;
  onInvoke?: (id: ActionId) => void;
  formatShortcut: (shortcut: string) => string;
}

export function CommandBar({ screen, keybindings, onClose, onInvoke, formatShortcut }: CommandBarProps): React.ReactElement {
  const { tr, tx } = useI18n();
  const actionIds = SCREEN_COMMANDS[screen] ?? [];
  const items = actionIds
    .map((id) => keybindings.find((kb) => kb.id === id))
    .filter((kb): kb is KeyBinding => Boolean(kb));

  return (
    <footer className="cmdhints" role="toolbar" aria-label={tr('Available commands', '可用命令')}>
      <div className="cmdhints__items">
        {items.map((kb) => (
          <button
            key={kb.id}
            type="button"
            className="cmdhints__item"
            onClick={() => onInvoke?.(kb.id)}
            title={tx(kb.label)}
          >
            <span className="cmdhints__keys">
              {kb.keys[0] ? formatShortcut(kb.keys[0]).split(' ').map((token, i) => (
                <kbd key={i} className="cmdhints__kbd">{token}</kbd>
              )) : null}
            </span>
            <span className="cmdhints__label">{tx(kb.label)}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="cmdhints__close"
        onClick={onClose}
        aria-label={tr('Hide command bar', '隐藏命令栏')}
        title={tr('Hide command bar', '隐藏命令栏')}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </footer>
  );
}
