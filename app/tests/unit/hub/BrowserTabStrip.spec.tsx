// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserTabStrip } from '../../../src/renderer/hub/BrowserTabStrip';
import type { TabInfo } from '../../../src/shared/session-schemas';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT_TAB: TabInfo = {
  targetId: 'root',
  url: 'https://example.com/root',
  title: 'Root page',
  type: 'page',
  active: true,
  pinned: false,
  isRoot: true,
  isLoading: false,
};

const CHILD_TAB: TabInfo = {
  targetId: 'child',
  url: 'https://example.com/child',
  title: 'Child page',
  type: 'page',
  active: false,
  pinned: false,
  isRoot: false,
  isLoading: false,
};

function renderStrip(onTakeOver = vi.fn()): { container: HTMLDivElement; root: Root; onTakeOver: ReturnType<typeof vi.fn> } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<BrowserTabStrip sessionId="session-1" running onTakeOver={onTakeOver} />);
  });
  return { container, root, onTakeOver };
}

describe('BrowserTabStrip', () => {
  let tabsChanged: ((sessionId: string, tabs: TabInfo[]) => void) | null;
  const getTabs = vi.fn(async () => [ROOT_TAB, CHILD_TAB]);
  const activatePage = vi.fn(async () => ({ activated: true }));
  const closePage = vi.fn(async () => ({ closed: true }));
  const setPagePinned = vi.fn(async (_sessionId: string, _targetId: string, pinned: boolean) => ({ pinned }));

  beforeEach(() => {
    tabsChanged = null;
    getTabs.mockClear();
    activatePage.mockClear();
    closePage.mockClear();
    setPagePinned.mockClear();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        sessions: { getTabs, activatePage, closePage, setPagePinned },
        on: {
          sessionTabsChanged: vi.fn((cb: (sessionId: string, tabs: TabInfo[]) => void) => {
            tabsChanged = cb;
            return vi.fn();
          }),
        },
      },
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders the live Space pages and keeps the root page protected', async () => {
    const { container, root } = renderStrip();
    await act(async () => { await Promise.resolve(); });

    const pageTabs = container.querySelectorAll('[role="tab"]');
    expect(pageTabs).toHaveLength(2);
    expect(pageTabs[0].getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[aria-label="Root page"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Close Root page"]')).toBeNull();
    expect(container.querySelector('[aria-label="Close Child page"]')).not.toBeNull();
    expect(container.textContent).toContain('Agent is working');

    act(() => root.unmount());
  });

  it('activates, pins, closes, takes over, and accepts pushed tab snapshots', async () => {
    const { container, root, onTakeOver } = renderStrip();
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      (container.querySelector('[aria-label="Child page"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(activatePage).toHaveBeenCalledWith('session-1', 'child');

    await act(async () => {
      (container.querySelector('[aria-label="Pin Child page"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(setPagePinned).toHaveBeenCalledWith('session-1', 'child', true);

    await act(async () => {
      (container.querySelector('[aria-label="Close Child page"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(closePage).toHaveBeenCalledWith('session-1', 'child');

    act(() => {
      (container.querySelector('[aria-label="Pause Agent and take over browser"]') as HTMLButtonElement).click();
    });
    expect(onTakeOver).toHaveBeenCalledOnce();

    act(() => {
      tabsChanged?.('session-1', [
        { ...ROOT_TAB, active: false },
        { ...CHILD_TAB, active: true, pinned: true, isLoading: true },
      ]);
    });
    expect(container.querySelector('[aria-label="Child page, Pinned, Loading"]')?.getAttribute('aria-selected')).toBe('true');

    act(() => root.unmount());
  });
});
