import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { BrowserPool, browserSpacePartition, isSafeTopLevelUrl } from '../../../src/main/sessions/BrowserPool';
import { contentViewStub } from '../../fixtures/electron-mock';

type MockWindow = {
  contentView: {
    children: unknown[];
    addChildView: (view: unknown) => void;
    removeChildView: (view: unknown) => void;
  };
};

type MockWebContents = {
  id: number;
  emit: (event: string, ...args: unknown[]) => boolean;
  destroy: () => void;
  isDestroyed: () => boolean;
  setMockTitle: (title: string) => void;
  setMockBeforeUnloadBlocked: (blocked: boolean) => void;
  invokeWindowOpenHandler: (url: string) => {
    action: 'allow' | 'deny';
    createWindow?: (options: Record<string, unknown>) => MockWebContents;
  } | null;
};

function mockWebContents(view: NonNullable<ReturnType<BrowserPool['create']>>): MockWebContents {
  return view.webContents as unknown as MockWebContents;
}

function openManagedPage(
  opener: MockWebContents,
  url: string,
): { action: 'allow' | 'deny'; page?: MockWebContents } {
  const response = opener.invokeWindowOpenHandler(url);
  if (!response || response.action === 'deny') return { action: 'deny' };
  return {
    action: 'allow',
    page: response.createWindow!({ webPreferences: {} }),
  };
}

async function flushImmediate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function mockWindow(): BrowserWindow & MockWindow {
  const children: unknown[] = [];
  return {
    getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 1200, height: 900 })),
    contentView: {
      ...contentViewStub,
      children,
      addChildView: vi.fn((view: unknown) => {
        if (!children.includes(view)) children.push(view);
      }),
      removeChildView: vi.fn((view: unknown) => {
        const index = children.indexOf(view);
        if (index >= 0) children.splice(index, 1);
      }),
    },
  } as unknown as BrowserWindow & MockWindow;
}

function instrumentLifecycle(view: NonNullable<ReturnType<BrowserPool['create']>>) {
  const setFrameRate = vi.fn<(fps: number) => void>();
  const sendCommand = vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>().mockResolvedValue({});
  const wc = view.webContents as unknown as {
    setFrameRate: (fps: number) => void;
    debugger: {
      sendCommand: (method: string, params: Record<string, unknown>) => Promise<unknown>;
      attach: () => void;
      detach: () => void;
      isAttached: () => boolean;
    };
  };
  wc.setFrameRate = setFrameRate;
  Object.assign(wc.debugger, {
    sendCommand,
    attach: vi.fn<() => void>(),
    detach: vi.fn<() => void>(),
    isAttached: () => false,
  });
  return { setFrameRate, sendCommand };
}

// ---------------------------------------------------------------------------
// Creation & lifecycle
// ---------------------------------------------------------------------------

describe('BrowserPool — creation', () => {
  let pool: BrowserPool;

  beforeEach(() => { pool = new BrowserPool(3); });
  afterEach(() => { pool.destroyAll(); });

  it('creates a browser view and returns it', () => {
    const view = pool.create('s1');
    expect(view).not.toBeNull();
    expect(pool.activeCount).toBe(1);
  });

  it('assigns unique webContents per session', () => {
    const v1 = pool.create('s1');
    const v2 = pool.create('s2');
    expect(v1!.webContents.id).not.toBe(v2!.webContents.id);
  });

  it('returns existing view for duplicate session ID', () => {
    const v1 = pool.create('s1');
    const v2 = pool.create('s1');
    expect(v1).toBe(v2);
    expect(pool.activeCount).toBe(1);
  });

  it('getWebContents returns the correct webContents', () => {
    const view = pool.create('s1');
    const wc = pool.getWebContents('s1');
    expect(wc).toBe(view!.webContents);
  });

  it('getWebContents returns null for unknown session', () => {
    expect(pool.getWebContents('nonexistent')).toBeNull();
  });

  it('getView returns the view or null', () => {
    pool.create('s1');
    expect(pool.getView('s1')).not.toBeNull();
    expect(pool.getView('nonexistent')).toBeNull();
  });

  it('sets session views to a Chromium-compatible user agent', () => {
    const view = pool.create('s1');
    const ua = (view!.webContents as unknown as { getUserAgent: () => string }).getUserAgent();

    expect(ua).toContain('Chrome/');
    expect(ua).toContain('Safari/537.36');
    expect(ua).not.toContain('Firefox/');
    expect(ua).not.toContain('Electron');
    expect(ua).not.toContain('BrowserUse');
  });

  it('notifies when Ctrl+C is pressed inside a browser view and prevents the page keypress when handled', () => {
    const view = pool.create('s1');
    const onInterruptShortcut = vi.fn(() => true);
    const preventDefault = vi.fn();
    pool.setOnInterruptShortcut(onInterruptShortcut);

    (view!.webContents as unknown as { emit: (event: string, ...args: unknown[]) => boolean }).emit(
      'before-input-event',
      { preventDefault },
      { type: 'keyDown', key: 'c', control: true, meta: false, alt: false },
    );

    expect(onInterruptShortcut).toHaveBeenCalledWith('s1');
    expect(preventDefault).toHaveBeenCalled();
  });

  it('lets Ctrl+C through to the page when the app does not handle it', () => {
    const view = pool.create('s1');
    const preventDefault = vi.fn();
    pool.setOnInterruptShortcut(() => false);

    (view!.webContents as unknown as { emit: (event: string, ...args: unknown[]) => boolean }).emit(
      'before-input-event',
      { preventDefault },
      { type: 'keyDown', key: 'c', control: true, meta: false, alt: false },
    );

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('does not treat Escape as the browser-view interrupt shortcut', () => {
    const view = pool.create('s1');
    const onInterruptShortcut = vi.fn(() => true);
    const preventDefault = vi.fn();
    pool.setOnInterruptShortcut(onInterruptShortcut);

    (view!.webContents as unknown as { emit: (event: string, ...args: unknown[]) => boolean }).emit(
      'before-input-event',
      { preventDefault },
      { type: 'keyDown', key: 'Escape', control: false, meta: false, alt: false },
    );

    expect(onInterruptShortcut).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('blocks custom protocols before Windows can open an app picker', () => {
    const view = pool.create('s1');
    const preventDefault = vi.fn();

    (view!.webContents as unknown as { emit: (event: string, ...args: unknown[]) => boolean }).emit(
      'will-navigate',
      { preventDefault },
      'bitbrowser://open/client',
    );

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(isSafeTopLevelUrl('https://www.douyin.com/')).toBe(true);
    expect(isSafeTopLevelUrl('bitbrowser://open/client')).toBe(false);
  });

  it('assigns a stable isolated persistent Profile to each conversation Space', () => {
    expect(browserSpacePartition('s1')).toBe(browserSpacePartition('s1'));
    expect(browserSpacePartition('s1')).not.toBe(browserSpacePartition('s2'));
    expect(browserSpacePartition('s1')).toMatch(/^persist:browser-use-space-/);
  });

  it('keeps a safe window.open URL as a second managed page in the owning Space', async () => {
    const view = pool.create('s1');
    const wc = view!.webContents as unknown as {
      invokeWindowOpenHandler: (url: string) => {
        action: 'allow' | 'deny';
        createWindow?: (options: Record<string, unknown>) => { id: number };
      } | null;
    };

    const response = wc.invokeWindowOpenHandler('https://atourgroup.feishu.cn/base/example');
    expect(response?.action).toBe('allow');
    expect(response?.createWindow).toBeTypeOf('function');
    const popup = response!.createWindow!({ webPreferences: {} });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(popup.id).not.toBe(view!.webContents.id);
    expect(await pool.getTabs('s1')).toHaveLength(2);
    expect(pool.getWebContents('s1')?.id).toBe(popup.id);
    expect(pool.getRootWebContents('s1')?.id).toBe(view!.webContents.id);
  });

  it('keeps a script-driven about:blank popup as a managed Space page', async () => {
    const view = pool.create('s1');
    const wc = view!.webContents as unknown as {
      invokeWindowOpenHandler: (url: string) => {
        action: 'allow' | 'deny';
        createWindow?: (options: Record<string, unknown>) => {
          id: number;
          emit: (event: string, ...args: unknown[]) => boolean;
        };
      } | null;
    };

    const response = wc.invokeWindowOpenHandler('about:blank');
    expect(response?.action).toBe('allow');
    expect(response?.createWindow).toBeTypeOf('function');

    const bridge = response!.createWindow!({ webPreferences: {} });
    bridge.emit(
      'did-start-navigation',
      {},
      'https://atourgroup.feishu.cn/base/script-driven-destination',
      false,
      true,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    const tabs = await pool.getTabs('s1');
    expect(tabs).toHaveLength(2);
    expect(tabs.filter((tab) => tab.active)).toHaveLength(1);
    expect(pool.getWebContents('s1')?.id).toBe(bridge.id);
  });
});

// ---------------------------------------------------------------------------
// Concurrency limits
// ---------------------------------------------------------------------------

describe('BrowserPool — concurrency', () => {
  let pool: BrowserPool;

  beforeEach(() => { pool = new BrowserPool(2); });
  afterEach(() => { pool.destroyAll(); });

  it('enforces max concurrent limit', () => {
    pool.create('s1');
    pool.create('s2');
    const v3 = pool.create('s3');
    expect(v3).toBeNull();
    expect(pool.activeCount).toBe(2);
    expect(pool.queuedCount).toBe(1);
  });

  it('canCreate returns false at capacity', () => {
    pool.create('s1');
    expect(pool.canCreate()).toBe(true);
    pool.create('s2');
    expect(pool.canCreate()).toBe(false);
  });

  it('frees capacity when a session is destroyed', () => {
    pool.create('s1');
    pool.create('s2');
    expect(pool.canCreate()).toBe(false);

    pool.destroy('s1');
    expect(pool.canCreate()).toBe(true);
    expect(pool.activeCount).toBe(1);
  });

  it('queued count resets on destroyAll', () => {
    pool.create('s1');
    pool.create('s2');
    pool.create('s3');
    expect(pool.queuedCount).toBe(1);

    pool.destroyAll();
    expect(pool.queuedCount).toBe(0);
    expect(pool.activeCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Attach / detach (live view)
// ---------------------------------------------------------------------------

describe('BrowserPool — attach/detach', () => {
  let pool: BrowserPool;
  let win: BrowserWindow & MockWindow;

  beforeEach(() => {
    pool = new BrowserPool(5);
    win = mockWindow();
  });
  afterEach(() => { pool.destroyAll(); });

  it('attachToWindow returns true and sets bounds', () => {
    pool.create('s1');
    const bounds = { x: 100, y: 50, width: 800, height: 600 };
    const ok = pool.attachToWindow('s1', win, bounds);
    expect(ok).toBe(true);
  });

  it('attachToWindow returns false for unknown session', () => {
    const ok = pool.attachToWindow('nonexistent', win, { x: 0, y: 0, width: 100, height: 100 });
    expect(ok).toBe(false);
  });

  it('detachFromWindow returns true after attach', () => {
    pool.create('s1');
    pool.attachToWindow('s1', win, { x: 0, y: 0, width: 800, height: 600 });
    const ok = pool.detachFromWindow('s1', win);
    expect(ok).toBe(true);
  });

  it('detachFromWindow returns false if not attached', () => {
    pool.create('s1');
    const ok = pool.detachFromWindow('s1', win);
    expect(ok).toBe(false);
  });

  it('detachFromWindow returns false for unknown session', () => {
    const ok = pool.detachFromWindow('nonexistent', win);
    expect(ok).toBe(false);
  });

  it('double attach updates bounds without error', () => {
    pool.create('s1');
    pool.attachToWindow('s1', win, { x: 0, y: 0, width: 800, height: 600 });
    const ok = pool.attachToWindow('s1', win, { x: 50, y: 50, width: 640, height: 480 });
    expect(ok).toBe(true);
  });

  it('keeps only the selected full-size session attached', () => {
    const first = pool.create('s1');
    const second = pool.create('s2');
    pool.attachToWindow('s1', win, { x: 0, y: 0, width: 800, height: 600 });
    pool.attachToWindow('s2', win, { x: 0, y: 0, width: 800, height: 600 });

    expect(win.contentView.children).not.toContain(first);
    expect(win.contentView.children).toContain(second);
    expect(pool.getStats().sessions.find((s) => s.sessionId === 's1')?.attached).toBe(false);
    expect(pool.getStats().sessions.find((s) => s.sessionId === 's2')?.attached).toBe(true);
  });

  it('raises an already attached selected session above parked siblings', async () => {
    const selected = pool.create('selected');
    const parked = pool.create('parked');
    await pool.parkForPreview('parked', win);
    pool.attachToWindow('selected', win, { x: 0, y: 0, width: 800, height: 600 });

    expect(win.contentView.children.at(-1)).toBe(selected);
    expect(win.contentView.children).toContain(parked);
  });

  it('keeps an attached view edge-to-edge and resets page zoom', () => {
    const view = pool.create('s1');
    expect(view).not.toBeNull();
    const setZoomFactor = vi.fn<(factor: number) => void>();
    (view!.webContents as unknown as { setZoomFactor: (factor: number) => void }).setZoomFactor = setZoomFactor;

    const ok = pool.attachToWindow('s1', win, { x: 0, y: 0, width: 2000, height: 900 });
    expect(ok).toBe(true);
    expect(view!.getBounds()).toEqual({ x: 0, y: 0, width: 2000, height: 900 });
    expect(setZoomFactor).toHaveBeenLastCalledWith(1);
  });

  it('destroy detaches if currently attached', () => {
    pool.create('s1');
    pool.attachToWindow('s1', win, { x: 0, y: 0, width: 800, height: 600 });
    pool.destroy('s1', win);
    expect(pool.activeCount).toBe(0);
  });

  it('parks temporarily hidden views at the window edge without collapsing their viewport', () => {
    const view = pool.create('s1');
    expect(view).not.toBeNull();

    pool.attachToWindow('s1', win, { x: 100, y: 50, width: 800, height: 600 });
    expect(win.contentView.children).toContain(view);

    pool.temporarilyDetachAll(win);
    expect(win.contentView.children).toContain(view);
    expect(view!.getBounds()).toEqual({ x: 1199, y: 899, width: 800, height: 600 });

    pool.reattachAll(win);
    expect(win.contentView.children.filter((child: unknown) => child === view)).toHaveLength(1);
    expect(view!.getBounds()).toEqual({ x: 100, y: 50, width: 800, height: 600 });
  });

  it('clears preview parking state even when the preview window is gone', async () => {
    const view = pool.create('s1');
    expect(view).not.toBeNull();
    instrumentLifecycle(view!);

    const parking = await pool.parkForPreview('s1', win);
    expect(parking).toEqual({ ok: true, parkedByUs: true });
    expect(pool.getStats().sessions[0].attached).toBe(true);

    pool.releasePreviewParking('s1', null);

    expect(pool.getStats().sessions[0].attached).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tab observation
// ---------------------------------------------------------------------------

describe('BrowserPool — getTabs', () => {
  let pool: BrowserPool;

  beforeEach(() => { pool = new BrowserPool(5); });
  afterEach(() => { pool.destroyAll(); });

  it('returns tab info for active session', async () => {
    pool.create('s1');
    const tabs = await pool.getTabs('s1');
    expect(tabs.length).toBe(1);
    expect(tabs[0].url).toBe('about:blank');
    expect(tabs[0].type).toBe('page');
    expect(tabs[0].active).toBe(true);
  });

  it('returns empty array for unknown session', async () => {
    const tabs = await pool.getTabs('nonexistent');
    expect(tabs).toEqual([]);
  });
});

describe('BrowserPool — managed page controls and tab events', () => {
  let pool: BrowserPool;

  beforeEach(() => { pool = new BrowserPool(5); });
  afterEach(() => { pool.destroyAll(); });

  it('publishes tab changes and supports activate, pin, and close without allowing the root page to close', async () => {
    const rootView = pool.create('s1');
    expect(rootView).not.toBeNull();
    const root = mockWebContents(rootView!);
    const snapshots: Awaited<ReturnType<BrowserPool['getTabs']>>[] = [];
    pool.setOnTabsChanged((_sessionId, tabs) => snapshots.push(tabs));

    const opened = openManagedPage(root, 'https://example.com/report');
    expect(opened.action).toBe('allow');
    const popup = opened.page!;
    await flushImmediate();

    expect(snapshots.some((tabs) => tabs.length === 2)).toBe(true);
    expect(pool.getWebContents('s1')?.id).toBe(popup.id);

    popup.setMockTitle('Quarterly report');
    expect(snapshots.at(-1)?.find((tab) => tab.targetId === String(popup.id))?.title).toBe('Quarterly report');

    expect(pool.setPagePinned('s1', String(popup.id), true)).toEqual({ pinned: true });
    expect((await pool.getTabs('s1')).find((tab) => tab.targetId === String(popup.id))?.pinned).toBe(true);

    expect(pool.activatePage('s1', String(root.id))).toEqual({ activated: true });
    expect(pool.getWebContents('s1')?.id).toBe(root.id);
    expect((await pool.getTabs('s1')).find((tab) => tab.targetId === String(root.id))?.active).toBe(true);

    expect(await pool.closePage('s1', String(popup.id))).toEqual({ closed: true });
    expect(popup.isDestroyed()).toBe(true);
    expect(await pool.getTabs('s1')).toHaveLength(1);
    expect(snapshots.at(-1)).toHaveLength(1);

    expect(await pool.closePage('s1', String(root.id))).toEqual({ closed: false, reason: 'root_protected' });
    expect(pool.setPagePinned('s1', String(root.id), true)).toEqual({
      pinned: false,
      reason: 'root_always_protected',
    });
    expect(root.isDestroyed()).toBe(false);
  });
});

describe('BrowserPool — duplicate window.open idempotency', () => {
  let pool: BrowserPool;

  beforeEach(() => { pool = new BrowserPool(5); });
  afterEach(() => { pool.destroyAll(); });

  it('reuses and activates a recent page from the same opener after removing volatile query parameters', async () => {
    const rootView = pool.create('s1');
    const root = mockWebContents(rootView!);
    const first = openManagedPage(
      root,
      'http://oa.yaduo.com/spa/workflow/static4form/index.html?_rdm=100&tenant=atour#/main/workflow/req?workflowid=1169&_key=first&iscreate=1',
    );
    expect(first.action).toBe('allow');
    await flushImmediate();
    expect(pool.activatePage('s1', String(root.id))).toEqual({ activated: true });

    const duplicate = openManagedPage(
      root,
      'http://oa.yaduo.com/spa/workflow/static4form/index.html?_rdm=200&tenant=atour#/main/workflow/req?workflowid=1169&_key=second&iscreate=1',
    );
    await flushImmediate();

    expect(duplicate).toEqual({ action: 'deny' });
    expect(await pool.getTabs('s1')).toHaveLength(2);
    expect(pool.getWebContents('s1')?.id).toBe(first.page!.id);
  });

  it('keeps different stable business parameters as separate pages', async () => {
    const rootView = pool.create('s1');
    const root = mockWebContents(rootView!);
    const first = openManagedPage(
      root,
      'https://oa.example.test/form?_rdm=100#/request?workflowid=1169&_key=one&iscreate=1',
    );
    const second = openManagedPage(
      root,
      'https://oa.example.test/form?_rdm=200#/request?workflowid=1170&_key=two&iscreate=1',
    );
    await flushImmediate();

    expect(first.action).toBe('allow');
    expect(second.action).toBe('allow');
    expect(await pool.getTabs('s1')).toHaveLength(3);
  });

  it('allows the same canonical URL again after the reuse window expires', async () => {
    const now = vi.spyOn(Date, 'now');
    let currentTime = new Date('2026-08-27T05:00:00.000Z').getTime();
    now.mockImplementation(() => currentTime);
    const timedPool = new BrowserPool(5, { duplicateWindowOpenReuseMs: 1_000 });
    try {
      const rootView = timedPool.create('s1');
      const root = mockWebContents(rootView!);
      const first = openManagedPage(root, 'https://oa.example.test/form?_rdm=100#/request?workflowid=1169&_key=one');
      await flushImmediate();

      currentTime += 1_001;
      const later = openManagedPage(root, 'https://oa.example.test/form?_rdm=200#/request?workflowid=1169&_key=two');
      await flushImmediate();

      expect(first.action).toBe('allow');
      expect(later.action).toBe('allow');
      expect(await timedPool.getTabs('s1')).toHaveLength(3);
    } finally {
      timedPool.destroyAll();
      now.mockRestore();
    }
  });

  it('never deduplicates about:blank popups', async () => {
    const rootView = pool.create('s1');
    const root = mockWebContents(rootView!);

    const first = openManagedPage(root, 'about:blank');
    const second = openManagedPage(root, 'about:blank');
    await flushImmediate();

    expect(first.action).toBe('allow');
    expect(second.action).toBe('allow');
    expect(await pool.getTabs('s1')).toHaveLength(3);
  });

  it('does not merge matching URLs opened by different managed pages', async () => {
    const rootView = pool.create('s1');
    const root = mockWebContents(rootView!);
    const url = 'https://oa.example.test/form?_rdm=100#/request?workflowid=1169&_key=one';
    const first = openManagedPage(root, url);
    expect(first.action).toBe('allow');
    await flushImmediate();

    const fromChild = openManagedPage(
      first.page!,
      'https://oa.example.test/form?_rdm=200#/request?workflowid=1169&_key=two',
    );
    await flushImmediate();

    expect(fromChild.action).toBe('allow');
    expect(await pool.getTabs('s1')).toHaveLength(3);
  });
});

describe('BrowserPool — page limit and protected pages', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes the least-recently-used inactive child and preserves the root and current page', async () => {
    const pool = new BrowserPool(5, { maxPagesPerSpace: 4 });
    try {
      const rootView = pool.create('s1');
      const root = mockWebContents(rootView!);

      vi.setSystemTime(new Date('2026-08-27T00:00:01.000Z'));
      const first = openManagedPage(root, 'https://example.com/first').page!;
      await vi.runAllTimersAsync();
      vi.setSystemTime(new Date('2026-08-27T00:00:02.000Z'));
      const second = openManagedPage(root, 'https://example.com/second').page!;
      await vi.runAllTimersAsync();
      vi.setSystemTime(new Date('2026-08-27T00:00:03.000Z'));
      const current = openManagedPage(root, 'https://example.com/current').page!;
      await vi.runAllTimersAsync();

      expect(pool.getWebContents('s1')?.id).toBe(current.id);
      vi.setSystemTime(new Date('2026-08-27T00:00:04.000Z'));
      const overflow = openManagedPage(root, 'https://example.com/overflow');
      expect(overflow.action).toBe('allow');
      await vi.runAllTimersAsync();

      expect(first.isDestroyed()).toBe(true);
      expect(second.isDestroyed()).toBe(false);
      expect(current.isDestroyed()).toBe(false);
      expect(root.isDestroyed()).toBe(false);
      expect(await pool.getTabs('s1')).toHaveLength(4);
    } finally {
      pool.destroyAll();
    }
  });

  it('refuses a new page when the only inactive child is pinned and root/current are protected', async () => {
    const pool = new BrowserPool(5, { maxPagesPerSpace: 3 });
    try {
      const rootView = pool.create('s1');
      const root = mockWebContents(rootView!);
      const pinned = openManagedPage(root, 'https://example.com/pinned').page!;
      await vi.runAllTimersAsync();
      const current = openManagedPage(root, 'https://example.com/current').page!;
      await vi.runAllTimersAsync();
      expect(pool.setPagePinned('s1', String(pinned.id), true)).toEqual({ pinned: true });

      const blocked = openManagedPage(root, 'https://example.com/blocked');

      expect(blocked).toEqual({ action: 'deny' });
      expect(root.isDestroyed()).toBe(false);
      expect(pinned.isDestroyed()).toBe(false);
      expect(current.isDestroyed()).toBe(false);
      expect(pool.getWebContents('s1')?.id).toBe(current.id);
      expect(await pool.getTabs('s1')).toHaveLength(3);
    } finally {
      pool.destroyAll();
    }
  });

  it('honors beforeunload for a user close and restores the vetoed page as active', async () => {
    const pool = new BrowserPool(5, { maxPagesPerSpace: 3 });
    try {
      const rootView = pool.create('s1');
      const root = mockWebContents(rootView!);
      const popup = openManagedPage(root, 'https://example.com/unsaved-form').page!;
      await vi.runAllTimersAsync();
      popup.setMockBeforeUnloadBlocked(true);

      const closeResult = pool.closePage('s1', String(popup.id));
      await vi.advanceTimersByTimeAsync(1_500);

      expect(await closeResult).toEqual({ closed: false, reason: 'beforeunload_blocked' });
      expect(popup.isDestroyed()).toBe(false);
      expect(pool.getWebContents('s1')?.id).toBe(popup.id);
      expect(root.isDestroyed()).toBe(false);
      expect(await pool.getTabs('s1')).toHaveLength(2);
    } finally {
      pool.destroyAll();
    }
  });

  it('does not discard an unsaved inactive page during automatic LRU cleanup', async () => {
    const pool = new BrowserPool(5, { maxPagesPerSpace: 3 });
    try {
      const rootView = pool.create('s1');
      const root = mockWebContents(rootView!);
      const protectedPage = openManagedPage(root, 'https://example.com/unsaved').page!;
      await vi.runAllTimersAsync();
      protectedPage.setMockBeforeUnloadBlocked(true);
      const replaceablePage = openManagedPage(root, 'https://example.com/replaceable').page!;
      await vi.runAllTimersAsync();

      const overflow = openManagedPage(root, 'https://example.com/overflow');
      expect(overflow.action).toBe('allow');
      await vi.runAllTimersAsync();

      expect(protectedPage.isDestroyed()).toBe(false);
      expect(replaceablePage.isDestroyed()).toBe(true);
      expect(root.isDestroyed()).toBe(false);
      expect((await pool.getTabs('s1')).some((tab) => tab.targetId === String(protectedPage.id))).toBe(true);
      expect(await pool.getTabs('s1')).toHaveLength(3);
    } finally {
      pool.destroyAll();
    }
  });
});

describe('BrowserPool — completed task cleanup', () => {
  let pool: BrowserPool;

  beforeEach(() => {
    vi.useFakeTimers();
    pool = new BrowserPool(5, {
      idleFreezeDelayMs: 60_000,
      completedPageCleanupDelayMs: 100,
    });
  });

  afterEach(() => {
    pool.destroyAll();
    vi.useRealTimers();
  });

  it('closes inactive unpinned child pages after the completed-task retention delay', async () => {
    const rootView = pool.create('s1');
    const root = mockWebContents(rootView!);
    const inactive = openManagedPage(root, 'https://example.com/result-one').page!;
    await vi.runOnlyPendingTimersAsync();
    const current = openManagedPage(root, 'https://example.com/result-two').page!;
    await vi.runOnlyPendingTimersAsync();

    pool.markSessionIdle('s1');
    await vi.advanceTimersByTimeAsync(100);

    expect(inactive.isDestroyed()).toBe(true);
    expect(current.isDestroyed()).toBe(false);
    expect(root.isDestroyed()).toBe(false);
    expect(await pool.getTabs('s1')).toHaveLength(2);
  });

  it('cancels delayed cleanup when the task resumes', async () => {
    const rootView = pool.create('s1');
    const root = mockWebContents(rootView!);
    const inactive = openManagedPage(root, 'https://example.com/result-one').page!;
    await vi.runOnlyPendingTimersAsync();
    const current = openManagedPage(root, 'https://example.com/result-two').page!;
    await vi.runOnlyPendingTimersAsync();

    pool.markSessionIdle('s1');
    await vi.advanceTimersByTimeAsync(99);
    await pool.markSessionActive('s1');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(inactive.isDestroyed()).toBe(false);
    expect(current.isDestroyed()).toBe(false);
    expect(await pool.getTabs('s1')).toHaveLength(3);
  });
});

describe('BrowserPool — Space ownership cleanup', () => {
  let pool: BrowserPool;

  beforeEach(() => { pool = new BrowserPool(5); });
  afterEach(() => { pool.destroyAll(); });

  it('tears down every child page when the root page is destroyed unexpectedly', async () => {
    const rootView = pool.create('s1');
    const root = mockWebContents(rootView!);
    const first = openManagedPage(root, 'https://example.com/first').page!;
    const second = openManagedPage(root, 'https://example.com/second').page!;
    await flushImmediate();

    root.destroy();
    await flushImmediate();

    expect(pool.activeCount).toBe(0);
    expect(pool.getWebContents('s1')).toBeNull();
    expect(first.isDestroyed()).toBe(true);
    expect(second.isDestroyed()).toBe(true);
  });
});

describe('BrowserPool — fitted resize', () => {
  let pool: BrowserPool;

  beforeEach(() => {
    pool = new BrowserPool(5);
  });

  afterEach(() => { pool.destroyAll(); });

  it('keeps fitted resize edge-to-edge and resets page zoom', () => {
    const view = pool.create('s1');
    expect(view).not.toBeNull();
    const setZoomFactor = vi.fn<(factor: number) => void>();
    (view!.webContents as unknown as { setZoomFactor: (factor: number) => void }).setZoomFactor = setZoomFactor;

    const fitted = pool.setViewBoundsFitted('s1', { x: 0, y: 0, width: 2000, height: 900 });
    expect(fitted).toEqual({ x: 0, y: 0, width: 2000, height: 900 });
    expect(view!.getBounds()).toEqual({ x: 0, y: 0, width: 2000, height: 900 });
    expect(setZoomFactor).toHaveBeenLastCalledWith(1);
  });
});

describe('BrowserPool — idle CPU throttling', () => {
  let pool: BrowserPool;

  beforeEach(() => {
    vi.useFakeTimers();
    pool = new BrowserPool(5, { idleFreezeDelayMs: 100 });
  });

  afterEach(() => {
    pool.destroyAll();
    vi.useRealTimers();
  });

  it('drops detached idle sessions to 1 FPS and freezes after the idle delay', async () => {
    const view = pool.create('s1');
    expect(view).not.toBeNull();

    const { setFrameRate, sendCommand } = instrumentLifecycle(view!);

    pool.markSessionIdle('s1');
    expect(setFrameRate).toHaveBeenLastCalledWith(1);

    await vi.advanceTimersByTimeAsync(100);
    const lifecycleCalls = sendCommand.mock.calls.filter(([method]) => method === 'Page.setWebLifecycleState');
    expect(lifecycleCalls).toEqual([['Page.setWebLifecycleState', { state: 'frozen' }]]);
  });

  it('does not freeze an idle session while it is visible', async () => {
    const view = pool.create('s1');
    expect(view).not.toBeNull();

    const { setFrameRate, sendCommand } = instrumentLifecycle(view!);

    const win = mockWindow();
    pool.attachToWindow('s1', win, { x: 0, y: 0, width: 800, height: 600 });
    pool.markSessionIdle('s1');

    await vi.advanceTimersByTimeAsync(100);
    const lifecycleCalls = sendCommand.mock.calls.filter(([method]) => method === 'Page.setWebLifecycleState');
    expect(lifecycleCalls).toEqual([]);
    expect(setFrameRate).toHaveBeenLastCalledWith(60);
  });

  it('wakes a frozen detached session before new agent activity', async () => {
    const view = pool.create('s1');
    expect(view).not.toBeNull();

    const { setFrameRate, sendCommand } = instrumentLifecycle(view!);

    pool.markSessionIdle('s1');
    await vi.advanceTimersByTimeAsync(100);
    await pool.markSessionActive('s1');

    const lifecycleCalls = sendCommand.mock.calls.filter(([method]) => method === 'Page.setWebLifecycleState');
    expect(lifecycleCalls).toEqual([
      ['Page.setWebLifecycleState', { state: 'frozen' }],
      ['Page.setWebLifecycleState', { state: 'active' }],
    ]);
    expect(setFrameRate).toHaveBeenLastCalledWith(4);
  });
});

// ---------------------------------------------------------------------------
// Stats / monitoring
// ---------------------------------------------------------------------------

describe('BrowserPool — getStats', () => {
  let pool: BrowserPool;

  beforeEach(() => { pool = new BrowserPool(3); });
  afterEach(() => { pool.destroyAll(); });

  it('returns accurate stats with no sessions', () => {
    const stats = pool.getStats();
    expect(stats.active).toBe(0);
    expect(stats.queued).toBe(0);
    expect(stats.maxConcurrent).toBe(3);
    expect(stats.sessions).toEqual([]);
  });

  it('returns accurate stats with active sessions', () => {
    pool.create('s1');
    pool.create('s2');
    const stats = pool.getStats();
    expect(stats.active).toBe(2);
    expect(stats.sessions.length).toBe(2);
    expect(stats.sessions[0].sessionId).toBe('s1');
    expect(stats.sessions[0].attached).toBe(false);
    expect(typeof stats.sessions[0].pid).toBe('number');
    expect(typeof stats.sessions[0].createdAt).toBe('number');
  });

  it('reflects attached state in stats', () => {
    pool.create('s1');
    const win = mockWindow();
    pool.attachToWindow('s1', win, { x: 0, y: 0, width: 800, height: 600 });
    const stats = pool.getStats();
    expect(stats.sessions[0].attached).toBe(true);
  });

  it('includes queued count', () => {
    pool.create('s1');
    pool.create('s2');
    pool.create('s3');
    pool.create('s4');
    const stats = pool.getStats();
    expect(stats.active).toBe(3);
    expect(stats.queued).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Destroy / cleanup
// ---------------------------------------------------------------------------

describe('BrowserPool — destroy', () => {
  let pool: BrowserPool;

  beforeEach(() => { pool = new BrowserPool(5); });

  it('destroy removes the entry', () => {
    pool.create('s1');
    pool.destroy('s1');
    expect(pool.activeCount).toBe(0);
    expect(pool.getWebContents('s1')).toBeNull();
  });

  it('destroy is idempotent', () => {
    pool.create('s1');
    pool.destroy('s1');
    pool.destroy('s1');
    expect(pool.activeCount).toBe(0);
  });

  it('destroyAll clears everything', () => {
    pool.create('s1');
    pool.create('s2');
    pool.create('s3');
    pool.destroyAll();
    expect(pool.activeCount).toBe(0);
    expect(pool.queuedCount).toBe(0);
  });
});
