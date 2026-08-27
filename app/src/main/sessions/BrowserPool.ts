import {
  WebContentsView,
  nativeTheme,
  type BrowserWindow,
  type BrowserWindowConstructorOptions,
  type WebContents,
} from 'electron';
import { createHash } from 'node:crypto';
import { browserLogger } from '../logger';
import { getWindowBackgroundColor } from '../themeMode';
import type { TabInfo } from './types';
import { buildBrowserIdentity, type BrowserIdentity } from './browserIdentity';

const DEFAULT_BROWSER_WIDTH = 1280;
const DEFAULT_BROWSER_HEIGHT = 800;
const DEFAULT_MAX_CONCURRENT = 10;
const THROTTLED_FRAME_RATE = 4;
const IDLE_FRAME_RATE = 1;
const ACTIVE_FRAME_RATE = 60;
const DEFAULT_IDLE_FREEZE_DELAY_MS = 15_000;
const DEFAULT_MAX_PAGES_PER_SPACE = 8;
const DEFAULT_COMPLETED_PAGE_CLEANUP_DELAY_MS = 10 * 60_000;
const DEFAULT_DUPLICATE_WINDOW_OPEN_REUSE_MS = 30_000;
const CDP_PROTOCOL_VERSION = '1.3';
const PREVIEW_PARK_VISIBLE_PX = 1;
// Edge-to-edge fill. View rect = slot rect, no gutters ever. Page sees
// a viewport sized purely by setZoomFactor: window.innerWidth = slot.width
// / zoom, window.innerHeight = slot.height / zoom. zoom is pinned so the
// page sees ~900 CSS px tall regardless of slot height, giving sites a
// desktop-class viewport. No enableDeviceEmulation — one knob only, no
// ambiguity about where Chromium positions the rendered page.
const EMULATED_VIEWPORT_HEIGHT = 900;
const SAFE_TOP_LEVEL_PROTOCOLS = new Set(['about:', 'blob:', 'data:', 'file:', 'http:', 'https:']);
const VOLATILE_WINDOW_OPEN_PARAMS = new Set(['_rdm', '_key']);

export function isSafeTopLevelUrl(rawUrl: string): boolean {
  try {
    return SAFE_TOP_LEVEL_PROTOCOLS.has(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

type RuntimeBrowserIdentity = Pick<BrowserIdentity, 'userAgent'>;
type ViewBounds = { x: number; y: number; width: number; height: number };

interface ManagedPage {
  view: WebContentsView;
  createdAt: number;
  lastActivatedAt: number;
  pinned: boolean;
  isRoot: boolean;
  frozen: boolean;
  autoCloseProtected: boolean;
  faviconUrl?: string;
}

function canonicalWindowOpenUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    for (const key of Array.from(url.searchParams.keys())) {
      if (VOLATILE_WINDOW_OPEN_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
    }

    const rawHash = url.hash.slice(1);
    const hashQueryIndex = rawHash.indexOf('?');
    if (hashQueryIndex >= 0) {
      const hashPath = rawHash.slice(0, hashQueryIndex);
      const hashParams = new URLSearchParams(rawHash.slice(hashQueryIndex + 1));
      for (const key of Array.from(hashParams.keys())) {
        if (VOLATILE_WINDOW_OPEN_PARAMS.has(key.toLowerCase())) hashParams.delete(key);
      }
      const canonicalHashQuery = hashParams.toString();
      url.hash = canonicalHashQuery ? `${hashPath}?${canonicalHashQuery}` : hashPath;
    }

    return url.toString();
  } catch {
    return null;
  }
}

interface PoolEntry {
  sessionId: string;
  rootView: WebContentsView;
  view: WebContentsView;
  pages: Map<number, ManagedPage>;
  createdAt: number;
  attached: boolean;
  attachedWindow: BrowserWindow | null;
  parked: boolean;
  lastVisibleBounds: ViewBounds | null;
  idleFreezeEligible: boolean;
  freezeTimer: ReturnType<typeof setTimeout> | null;
  completedCleanupTimer: ReturnType<typeof setTimeout> | null;
  pageLimitRun: Promise<void> | null;
  pageLimitRequested: boolean;
  recentWindowOpens: Map<string, { page: ManagedPage; openedAt: number }>;
}

export function browserSpacePartition(sessionId: string): string {
  const key = createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
  return `persist:browser-use-space-${key}`;
}

function readIdleFreezeDelayMs(): number {
  const raw = process.env.BU_IDLE_BROWSER_FREEZE_DELAY_MS;
  if (raw == null || raw.trim() === '') return DEFAULT_IDLE_FREEZE_DELAY_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_IDLE_FREEZE_DELAY_MS;
  return value;
}

function readCompletedPageCleanupDelayMs(): number {
  const raw = process.env.BU_COMPLETED_PAGE_CLEANUP_DELAY_MS;
  if (raw == null || raw.trim() === '') return DEFAULT_COMPLETED_PAGE_CLEANUP_DELAY_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_COMPLETED_PAGE_CLEANUP_DELAY_MS;
  return value;
}

export class BrowserPool {
  private entries: Map<string, PoolEntry> = new Map();
  private maxConcurrent: number;
  private queue: string[] = [];
  private onGone?: (sessionId: string) => void;
  private onCreate?: (sessionId: string) => void;
  private onNavigate?: (sessionId: string, url: string) => void;
  private onTabsChanged?: (sessionId: string, tabs: TabInfo[]) => void;
  private onInterruptShortcut?: (sessionId: string) => boolean | void;
  private idleFreezeDelayMs: number;
  private maxPagesPerSpace: number;
  private completedPageCleanupDelayMs: number;
  private duplicateWindowOpenReuseMs: number;

  constructor(
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    opts: {
      idleFreezeDelayMs?: number;
      maxPagesPerSpace?: number;
      completedPageCleanupDelayMs?: number;
      duplicateWindowOpenReuseMs?: number;
    } = {},
  ) {
    this.maxConcurrent = maxConcurrent;
    this.idleFreezeDelayMs = opts.idleFreezeDelayMs ?? readIdleFreezeDelayMs();
    this.maxPagesPerSpace = Math.max(2, Math.floor(opts.maxPagesPerSpace ?? DEFAULT_MAX_PAGES_PER_SPACE));
    this.completedPageCleanupDelayMs = opts.completedPageCleanupDelayMs ?? readCompletedPageCleanupDelayMs();
    this.duplicateWindowOpenReuseMs = Math.max(
      0,
      Math.floor(opts.duplicateWindowOpenReuseMs ?? DEFAULT_DUPLICATE_WINDOW_OPEN_REUSE_MS),
    );
    browserLogger.info('BrowserPool.init', {
      maxConcurrent,
      maxPagesPerSpace: this.maxPagesPerSpace,
      completedPageCleanupDelayMs: this.completedPageCleanupDelayMs,
      duplicateWindowOpenReuseMs: this.duplicateWindowOpenReuseMs,
    });

    // Repaint every pooled view (attached AND detached) when the theme
    // flips. themeMode.applyBackgroundToAllWindows only walks attached
    // contentView children, so a session sitting at "Browser not started
    // yet" while the user toggles theme would otherwise carry stale bg
    // until next attach.
    nativeTheme.on('updated', () => {
      const color = getWindowBackgroundColor();
      for (const entry of this.entries.values()) {
        for (const page of entry.pages.values()) {
          try { page.view.setBackgroundColor(color); } catch { /* view destroyed */ }
        }
      }
    });
  }

  /** Register a listener that fires when a session's WebContents is gone
   *  (destroyed, crashed, or explicitly closed). Used to push a browser-gone
   *  notification to the renderer so the UI can stop showing "Browser starting…". */
  setOnGone(listener: (sessionId: string) => void): void {
    this.onGone = listener;
  }

  /** Register a listener that fires whenever a new WebContentsView is created
   *  for a session — used by main to push `sessions:browser-attached` IPC so
   *  the renderer flips `hasBrowser` to true mid-session without waiting for
   *  the next listAll. */
  setOnCreate(listener: (sessionId: string) => void): void {
    this.onCreate = listener;
  }

  /** Register a listener that fires on every top-frame navigation (including
   *  in-page hash/pushState). Used by SessionManager to keep session.primarySite
   *  in sync with the actual browser — the source of truth, not tool-call args. */
  setOnNavigate(listener: (sessionId: string, url: string) => void): void {
    this.onNavigate = listener;
  }

  /** Notify the shell whenever a Space page is created, activated, renamed,
   *  navigated, pinned, or closed. The renderer treats this as the source of
   *  truth for its horizontal page strip. */
  setOnTabsChanged(listener: (sessionId: string, tabs: TabInfo[]) => void): void {
    this.onTabsChanged = listener;
  }

  /** Register a listener for Ctrl+C inside an attached browser view. Returning
   *  true means the keypress was handled and should not continue into the page. */
  setOnInterruptShortcut(listener: (sessionId: string) => boolean | void): void {
    this.onInterruptShortcut = listener;
  }

  private notifyGone(sessionId: string): void {
    try { this.onGone?.(sessionId); } catch (err) {
      browserLogger.warn('BrowserPool.notifyGone.listenerError', { sessionId, error: (err as Error).message });
    }
  }

  private notifyNavigate(sessionId: string, url: string): void {
    try { this.onNavigate?.(sessionId, url); } catch (err) {
      browserLogger.warn('BrowserPool.notifyNavigate.listenerError', { sessionId, error: (err as Error).message });
    }
  }

  private tabSnapshot(entry: PoolEntry): TabInfo[] {
    return Array.from(entry.pages.values())
      .filter((page) => !page.view.webContents.isDestroyed())
      .map((page) => ({
        targetId: String(page.view.webContents.id),
        url: page.view.webContents.getURL() || 'about:blank',
        title: page.view.webContents.getTitle() || 'New Tab',
        type: 'page' as const,
        active: page.view === entry.view,
        pinned: page.pinned,
        isRoot: page.isRoot,
        isLoading: page.view.webContents.isLoading(),
        faviconUrl: page.faviconUrl,
      }));
  }

  private notifyTabsChanged(entry: PoolEntry): void {
    try { this.onTabsChanged?.(entry.sessionId, this.tabSnapshot(entry)); } catch (err) {
      browserLogger.warn('BrowserPool.notifyTabsChanged.listenerError', {
        sessionId: entry.sessionId,
        error: (err as Error).message,
      });
    }
  }

  private activateManagedPage(entry: PoolEntry, nextPage: ManagedPage, reason: string): boolean {
    const nextView = nextPage.view;
    if (nextView.webContents.isDestroyed()) return false;
    nextPage.lastActivatedAt = Date.now();
    if (entry.view === nextView) {
      if (nextPage.frozen) void this.setPageLifecycleState(entry, nextPage, 'active', `page-reactivated:${reason}`);
      this.applyFrameRate(entry);
      this.notifyTabsChanged(entry);
      return true;
    }

    const previousView = entry.view;
    const stableBounds = entry.lastVisibleBounds ?? previousView.getBounds();
    entry.view = nextView;

    if (entry.attached && entry.attachedWindow && !entry.attachedWindow.isDestroyed()) {
      try { entry.attachedWindow.contentView.removeChildView(previousView); } catch { /* already detached */ }
      nextView.setBounds(stableBounds);
      this.raiseChildView(entry.attachedWindow, nextView);
      const fitted = this.fitBoundsToView(stableBounds);
      try { nextView.webContents.setZoomFactor(fitted.zoom); } catch { /* page may be closing */ }
      try { nextView.webContents.focus(); } catch { /* page may be closing */ }
    }
    this.applyFrameRate(entry);
    if (nextPage.frozen) void this.setPageLifecycleState(entry, nextPage, 'active', `page-activated:${reason}`);
    browserLogger.info('BrowserPool.space.pageActivated', {
      sessionId: entry.sessionId,
      reason,
      previousWcId: previousView.webContents.id,
      wcId: nextView.webContents.id,
      pageCount: entry.pages.size,
    });
    this.notifyTabsChanged(entry);
    return true;
  }

  private notifyInterruptShortcut(sessionId: string): boolean {
    try { return this.onInterruptShortcut?.(sessionId) === true; } catch (err) {
      browserLogger.warn('BrowserPool.notifyInterruptShortcut.listenerError', { sessionId, error: (err as Error).message });
      return false;
    }
  }

  get activeCount(): number {
    return this.entries.size;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  canCreate(): boolean {
    return this.entries.size < this.maxConcurrent;
  }

  create(sessionId: string, sessionStartedAt?: number): WebContentsView | null {
    if (this.entries.has(sessionId)) {
      browserLogger.warn('BrowserPool.create.duplicate', { sessionId });
      return this.entries.get(sessionId)!.view;
    }

    if (!this.canCreate()) {
      this.queue.push(sessionId);
      browserLogger.warn('BrowserPool.create.queued', {
        sessionId,
        activeCount: this.entries.size,
        maxConcurrent: this.maxConcurrent,
        queuePosition: this.queue.length,
      });
      return null;
    }

    const startupStartedAt = Date.now();
    const timingStartedAt = sessionStartedAt ?? startupStartedAt;
    const startupMs = (): number => Date.now() - startupStartedAt;
    const sessionMs = (): number => Date.now() - timingStartedAt;
    browserLogger.info('BrowserPool.startup.start', {
      sessionId,
      component: 'BrowserPool',
      area: 'startup',
      event: 'start',
      msSinceSessionStart: sessionMs(),
      activeCount: this.entries.size,
      maxConcurrent: this.maxConcurrent,
    });

    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: true,
        partition: browserSpacePartition(sessionId),
      },
    });
    // Without this, attach/detach during view swaps briefly paints black
    // (Chromium's default before the page commits its first frame).
    view.setBackgroundColor(getWindowBackgroundColor());
    browserLogger.info('BrowserPool.startup.constructed', {
      sessionId,
      component: 'BrowserPool',
      area: 'startup',
      event: 'constructed',
      msSinceCreate: startupMs(),
      msSinceSessionStart: sessionMs(),
      pid: view.webContents.getOSProcessId(),
      wcId: view.webContents.id,
    });

    view.setBounds({
      x: 0,
      y: 0,
      width: DEFAULT_BROWSER_WIDTH,
      height: DEFAULT_BROWSER_HEIGHT,
    });

    const browserIdentity = buildBrowserIdentity();
    let activeUserAgent: string | null = null;

    const applyWebContentsUserAgent = (
      identity: RuntimeBrowserIdentity,
      reason: string,
    ): void => {
      if (activeUserAgent === identity.userAgent) return;
      try {
        view.webContents.setUserAgent(identity.userAgent);
        activeUserAgent = identity.userAgent;
        browserLogger.info('BrowserPool.userAgent.applied', { sessionId, reason, userAgent: identity.userAgent });
      } catch (err) {
        browserLogger.warn('BrowserPool.userAgent.error', { sessionId, reason, error: (err as Error).message });
      }
    };

    applyWebContentsUserAgent(browserIdentity, 'startup');

    view.webContents.on('before-input-event', (event, input) => {
      if (
        input.type === 'keyDown' &&
        input.key.toLowerCase() === 'c' &&
        input.control &&
        !input.meta &&
        !input.alt
      ) {
        const handled = this.notifyInterruptShortcut(sessionId);
        if (handled) event.preventDefault();
      }
    });

    view.webContents.setFrameRate(THROTTLED_FRAME_RATE);

    // No enableDeviceEmulation — `screenSize` and `viewPosition` only apply
    // when screenPosition === 'mobile' (per Electron's Parameters typedef),
    // and combining emulation with setZoomFactor produced the rendered
    // page being narrower than bounds, leaving an asymmetric gutter. We
    // now drive everything through setZoomFactor alone: the page sees
    // window.innerWidth = bounds.width / zoom, and renders at exactly
    // bounds.width x bounds.height physical pixels — no second knob to
    // disagree, no positioning ambiguity.

    const rootPage: ManagedPage = {
      view,
      createdAt: startupStartedAt,
      lastActivatedAt: startupStartedAt,
      pinned: false,
      isRoot: true,
      frozen: false,
      autoCloseProtected: false,
    };
    const entry: PoolEntry = {
      sessionId,
      rootView: view,
      view,
      pages: new Map([[view.webContents.id, rootPage]]),
      createdAt: startupStartedAt,
      attached: false,
      attachedWindow: null,
      parked: false,
      lastVisibleBounds: null,
      idleFreezeEligible: false,
      freezeTimer: null,
      completedCleanupTimer: null,
      pageLimitRun: null,
      pageLimitRequested: false,
      recentWindowOpens: new Map(),
    };

    this.entries.set(sessionId, entry);

    // Notify subscribers (main wires this to a `sessions:browser-attached`
    // IPC so the renderer flips `hasBrowser` to true the moment the view
    // appears, without waiting for the next listAll snapshot).
    try { this.onCreate?.(sessionId); } catch (err) {
      browserLogger.warn('BrowserPool.onCreate.error', { sessionId, error: (err as Error).message });
    }

    // Fire onGone if the renderer process crashes, closes, or otherwise dies
    // out-of-band so the UI can react (stop showing "Browser starting…").
    const wc = view.webContents;
    // Never hand arbitrary site-triggered custom schemes to Windows. Without
    // this guard, pages that probe for desktop clients (for example
    // `bitbrowser:`) produce a system "Get an app to open this link" dialog.
    wc.on('will-navigate', (event, url) => {
      if (isSafeTopLevelUrl(url)) return;
      event.preventDefault();
      browserLogger.warn('BrowserPool.navigation.blockedProtocol', { sessionId, url: url.slice(0, 200) });
    });
    const createManagedWindowOpenHandler = (openerPage: ManagedPage) => ({ url }: { url: string }) => {
      if (!isSafeTopLevelUrl(url)) {
        browserLogger.warn('BrowserPool.windowOpen.blockedProtocol', { sessionId, url: url.slice(0, 200) });
        return { action: 'deny' } as const;
      }

      const canonicalUrl = canonicalWindowOpenUrl(url);
      const openerWcId = openerPage.view.webContents.id;
      const recentKey = canonicalUrl ? `${openerWcId}\n${canonicalUrl}` : null;
      const now = Date.now();
      for (const [key, recent] of entry.recentWindowOpens) {
        const wc = recent.page.view.webContents;
        if (
          now - recent.openedAt > this.duplicateWindowOpenReuseMs
          || wc.isDestroyed()
          || entry.pages.get(wc.id) !== recent.page
        ) {
          entry.recentWindowOpens.delete(key);
        }
      }
      const recent = recentKey && this.duplicateWindowOpenReuseMs > 0
        ? entry.recentWindowOpens.get(recentKey)
        : undefined;
      if (recent) {
        const reusedWc = recent.page.view.webContents;
        browserLogger.info('BrowserPool.windowOpen.reusedInSpace', {
          sessionId,
          openerWcId,
          wcId: reusedWc.id,
          ageMs: now - recent.openedAt,
          canonicalUrl: canonicalUrl!.slice(0, 200),
        });
        setImmediate(() => {
          if (this.entries.get(sessionId) === entry && !reusedWc.isDestroyed()) {
            this.activateManagedPage(entry, recent.page, 'duplicate-window-open');
          }
        });
        return { action: 'deny' } as const;
      }

      if (
        entry.pages.size >= this.maxPagesPerSpace
        && !Array.from(entry.pages.values()).some((page) => (
          !page.isRoot
          && !page.pinned
          && !page.autoCloseProtected
          && page.view !== entry.view
          && !page.view.webContents.isCurrentlyAudible()
          && !page.view.webContents.isDestroyed()
        ))
      ) {
        browserLogger.warn('BrowserPool.windowOpen.blockedPageLimit', {
          sessionId,
          pageCount: entry.pages.size,
          maxPagesPerSpace: this.maxPagesPerSpace,
        });
        return { action: 'deny' } as const;
      }
      browserLogger.info('BrowserPool.windowOpen.managedInSpace', { sessionId, url: url.slice(0, 200) });
      return {
        action: 'allow',
        createWindow: (options: BrowserWindowConstructorOptions) => createManagedPopup(options, url, recentKey),
      } as const;
    };

    const createManagedPopup = (
      options: BrowserWindowConstructorOptions,
      requestedUrl: string,
      recentKey: string | null,
    ): WebContents => {
      const { session: _ignoredSession, partition: _ignoredPartition, ...popupPreferences } = options.webPreferences ?? {};
      const popupView = new WebContentsView({
        webPreferences: {
          ...popupPreferences,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: true,
          partition: browserSpacePartition(sessionId),
        },
      });
      popupView.setBackgroundColor(getWindowBackgroundColor());
      popupView.setBounds(entry.lastVisibleBounds ?? entry.view.getBounds());
      const popup = popupView.webContents;
      const popupPage: ManagedPage = {
        view: popupView,
        createdAt: Date.now(),
        lastActivatedAt: Date.now(),
        pinned: false,
        isRoot: false,
        frozen: false,
        autoCloseProtected: false,
      };
      entry.pages.set(popup.id, popupPage);
      if (recentKey) entry.recentWindowOpens.set(recentKey, { page: popupPage, openedAt: popupPage.createdAt });
      try { popup.setUserAgent(browserIdentity.userAgent); } catch { /* popup may already be gone */ }
      popup.setFrameRate(this.frameRateForPage(entry, popupPage));
      popup.setWindowOpenHandler(createManagedWindowOpenHandler(popupPage));
      popup.on('will-navigate', (event, url) => {
        if (isSafeTopLevelUrl(url)) return;
        event.preventDefault();
        browserLogger.warn('BrowserPool.navigation.blockedProtocol', { sessionId, url: url.slice(0, 200), wcId: popup.id });
      });
      popup.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key.toLowerCase() === 'c' && input.control && !input.meta && !input.alt) {
          if (this.notifyInterruptShortcut(sessionId)) event.preventDefault();
        }
      });
      popup.on('focus', () => this.activateManagedPage(entry, popupPage, 'focus'));
      popup.on('did-start-loading', () => this.notifyTabsChanged(entry));
      popup.on('did-stop-loading', () => this.notifyTabsChanged(entry));
      popup.on('page-title-updated', () => this.notifyTabsChanged(entry));
      popup.on('will-prevent-unload', () => {
        popupPage.autoCloseProtected = true;
        browserLogger.info('BrowserPool.space.pageProtectedBeforeUnload', {
          sessionId,
          wcId: popup.id,
        });
        this.notifyTabsChanged(entry);
      });
      popup.on('page-favicon-updated', (_event, favicons: string[]) => {
        popupPage.faviconUrl = favicons.find((favicon) => typeof favicon === 'string' && favicon.length > 0);
        this.notifyTabsChanged(entry);
      });
      popup.on('did-navigate', (_event, url) => {
        popupPage.autoCloseProtected = false;
        if (entry.view === popupView) this.notifyNavigate(sessionId, url);
        this.notifyTabsChanged(entry);
      });
      popup.on('did-navigate-in-page', (_event, url, isMainFrame) => {
        if (isMainFrame && entry.view === popupView) this.notifyNavigate(sessionId, url);
        if (isMainFrame) this.notifyTabsChanged(entry);
      });
      popup.on('destroyed', () => {
        entry.pages.delete(popup.id);
        if (this.entries.get(sessionId) !== entry) return;
        if (entry.view === popupView) {
          const fallback = Array.from(entry.pages.values())
            .filter((page) => !page.view.webContents.isDestroyed())
            .sort((a, b) => Number(b.isRoot) - Number(a.isRoot) || b.lastActivatedAt - a.lastActivatedAt)[0];
          if (fallback) this.activateManagedPage(entry, fallback, 'active-page-destroyed');
        }
        browserLogger.info('BrowserPool.space.pageDestroyed', { sessionId, wcId: popup.id, pageCount: entry.pages.size });
        this.notifyTabsChanged(entry);
      });
      // Electron normally commits the requested URL after createWindow returns.
      // A detached Space (for example a task submitted before its chat is shown)
      // can leave that first navigation pending indefinitely, which also makes
      // Target.attachToTarget hang. Only rescue the genuinely untouched target;
      // visible/normal popups keep Electron's native navigation path.
      const initialNavigationTimer = setTimeout(() => {
        if (this.entries.get(sessionId) !== entry) return;
        if (popup.isDestroyed() || popup.getURL() || popup.isLoading()) return;
        void popup.loadURL(requestedUrl).catch((err) => {
          browserLogger.warn('BrowserPool.space.popupInitialNavigationFailed', {
            sessionId,
            wcId: popup.id,
            url: requestedUrl.slice(0, 200),
            error: (err as Error).message,
          });
        });
      }, 100);
      initialNavigationTimer.unref?.();
      setImmediate(() => {
        if (this.entries.get(sessionId) === entry) this.activateManagedPage(entry, popupPage, 'window-open');
      });
      browserLogger.info('BrowserPool.space.pageCreated', { sessionId, wcId: popup.id, pageCount: entry.pages.size });
      this.notifyTabsChanged(entry);
      this.schedulePageLimitEnforcement(entry);
      return popup;
    };

    wc.setWindowOpenHandler(createManagedWindowOpenHandler(rootPage));
    wc.on('focus', () => this.activateManagedPage(entry, rootPage, 'focus'));
    wc.on('did-start-loading', () => this.notifyTabsChanged(entry));
    wc.on('did-stop-loading', () => this.notifyTabsChanged(entry));
    wc.on('page-title-updated', () => this.notifyTabsChanged(entry));
    wc.on('will-prevent-unload', () => {
      rootPage.autoCloseProtected = true;
      browserLogger.info('BrowserPool.space.pageProtectedBeforeUnload', {
        sessionId,
        wcId: wc.id,
      });
      this.notifyTabsChanged(entry);
    });
    wc.on('page-favicon-updated', (_event, favicons: string[]) => {
      rootPage.faviconUrl = favicons.find((favicon) => typeof favicon === 'string' && favicon.length > 0);
      this.notifyTabsChanged(entry);
    });
    let navigationSeq = 0;
    let currentNavigation: { id: number; url: string; startedAt: number } | null = null;

    const navigationElapsedMs = (): number | null =>
      currentNavigation ? Date.now() - currentNavigation.startedAt : null;

    wc.once('did-start-loading', () => {
      browserLogger.info('BrowserPool.startup.didStartLoading', {
        sessionId,
        component: 'BrowserPool',
        area: 'startup',
        event: 'didStartLoading',
        msSinceCreate: startupMs(),
        msSinceSessionStart: sessionMs(),
        pid: wc.getOSProcessId(),
        wcId: wc.id,
        url: wc.getURL(),
      });
    });
    wc.once('dom-ready', () => {
      browserLogger.info('BrowserPool.startup.domReady', {
        sessionId,
        component: 'BrowserPool',
        area: 'startup',
        event: 'domReady',
        msSinceCreate: startupMs(),
        msSinceSessionStart: sessionMs(),
        pid: wc.getOSProcessId(),
        wcId: wc.id,
        url: wc.getURL(),
      });
    });
    wc.once('did-finish-load', () => {
      browserLogger.info('BrowserPool.startup.didFinishLoad', {
        sessionId,
        component: 'BrowserPool',
        area: 'startup',
        event: 'didFinishLoad',
        msSinceCreate: startupMs(),
        msSinceSessionStart: sessionMs(),
        pid: wc.getOSProcessId(),
        wcId: wc.id,
        url: wc.getURL(),
      });
    });
    wc.once('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      browserLogger.warn('BrowserPool.startup.didFailLoad', {
        sessionId,
        component: 'BrowserPool',
        area: 'startup',
        event: 'didFailLoad',
        msSinceCreate: startupMs(),
        msSinceSessionStart: sessionMs(),
        pid: wc.getOSProcessId(),
        wcId: wc.id,
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      });
    });
    wc.on('destroyed', () => {
      browserLogger.info('BrowserPool.wc.destroyed', { sessionId, msSinceCreate: startupMs() });
      const liveEntry = this.entries.get(sessionId);
      if (!liveEntry) return;
      // The root target anchors the Space for agent resume and isolation. If
      // it dies unexpectedly, tear down every child page as one unit instead
      // of leaving orphaned WebContents running outside session ownership.
      this.destroy(sessionId, liveEntry.attachedWindow ?? undefined);
    });
    wc.on('render-process-gone', (_event, details) => {
      browserLogger.warn('BrowserPool.wc.renderProcessGone', { sessionId, reason: details.reason, msSinceCreate: startupMs() });
      this.notifyGone(sessionId);
    });
    wc.on('did-start-navigation', (_event, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId) => {
      if (!isMainFrame) return;
      navigationSeq += 1;
      currentNavigation = { id: navigationSeq, url, startedAt: Date.now() };
      browserLogger.info('BrowserPool.navigation.start', {
        sessionId,
        component: 'BrowserPool',
        area: 'navigation',
        event: 'start',
        navigationId: currentNavigation.id,
        url,
        msSinceBrowserCreate: startupMs(),
        msSinceSessionStart: sessionMs(),
        isInPlace,
        isMainFrame,
        frameProcessId,
        frameRoutingId,
        pid: wc.getOSProcessId(),
        wcId: wc.id,
      });
    });
    wc.on('did-redirect-navigation', (_event, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId) => {
      if (!isMainFrame) return;
      const msSinceNavigationStart = navigationElapsedMs();
      if (currentNavigation) currentNavigation.url = url;
      browserLogger.info('BrowserPool.navigation.redirect', {
        sessionId,
        component: 'BrowserPool',
        area: 'navigation',
        event: 'redirect',
        navigationId: currentNavigation?.id ?? null,
        url,
        isInPlace,
        isMainFrame,
        frameProcessId,
        frameRoutingId,
        msSinceNavigationStart,
        msSinceBrowserCreate: startupMs(),
        msSinceSessionStart: sessionMs(),
        pid: wc.getOSProcessId(),
        wcId: wc.id,
      });
    });
    // Top-frame navigation — full page load. Covers agent-driven goto(),
    // user clicks on links, form submits, history back/forward, etc.
    wc.on('did-navigate', (_event, url) => {
      rootPage.autoCloseProtected = false;
      browserLogger.info('BrowserPool.navigation.didNavigate', {
        sessionId,
        component: 'BrowserPool',
        area: 'navigation',
        event: 'didNavigate',
        navigationId: currentNavigation?.id ?? null,
        url,
        startedUrl: currentNavigation?.url ?? null,
        msSinceNavigationStart: navigationElapsedMs(),
        msSinceBrowserCreate: startupMs(),
        msSinceSessionStart: sessionMs(),
        pid: wc.getOSProcessId(),
        wcId: wc.id,
      });
      if (entry.view === view) this.notifyNavigate(sessionId, url);
      this.notifyTabsChanged(entry);
    });
    wc.on('did-finish-load', () => {
      if (!currentNavigation) return;
      browserLogger.info('BrowserPool.navigation.didFinishLoad', {
        sessionId,
        component: 'BrowserPool',
        area: 'navigation',
        event: 'didFinishLoad',
        navigationId: currentNavigation.id,
        url: wc.getURL(),
        startedUrl: currentNavigation.url,
        msSinceNavigationStart: navigationElapsedMs(),
        msSinceBrowserCreate: startupMs(),
        msSinceSessionStart: sessionMs(),
        pid: wc.getOSProcessId(),
        wcId: wc.id,
      });
      currentNavigation = null;
    });
    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      browserLogger.warn('BrowserPool.navigation.didFailLoad', {
        sessionId,
        component: 'BrowserPool',
        area: 'navigation',
        event: 'didFailLoad',
        navigationId: currentNavigation?.id ?? null,
        validatedURL,
        startedUrl: currentNavigation?.url ?? null,
        msSinceNavigationStart: navigationElapsedMs(),
        msSinceBrowserCreate: startupMs(),
        msSinceSessionStart: sessionMs(),
        errorCode,
        errorDescription,
        pid: wc.getOSProcessId(),
        wcId: wc.id,
      });
      if (errorCode !== -3) currentNavigation = null;
    });
    // SPA/hash navigation — pushState, replaceState, hash changes. Many
    // sites (x.com, linkedin, gmail) never fire did-navigate after the
    // initial load, so without this the primarySite gets stuck on the
    // first URL and misses SPA route changes.
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) {
        browserLogger.info('BrowserPool.navigation.inPage', {
          sessionId,
          component: 'BrowserPool',
          area: 'navigation',
          event: 'inPage',
          url,
          msSinceBrowserCreate: startupMs(),
          msSinceSessionStart: sessionMs(),
          pid: wc.getOSProcessId(),
          wcId: wc.id,
        });
        if (entry.view === view) this.notifyNavigate(sessionId, url);
        this.notifyTabsChanged(entry);
      }
    });

    browserLogger.info('BrowserPool.create', {
      sessionId,
      activeCount: this.entries.size,
      maxConcurrent: this.maxConcurrent,
      pid: view.webContents.getOSProcessId(),
    });

    this.notifyTabsChanged(entry);

    return view;
  }

  getWebContents(sessionId: string): WebContents | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    return entry.view.webContents;
  }

  getRootWebContents(sessionId: string): WebContents | null {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.rootView.webContents.isDestroyed()) return null;
    return entry.rootView.webContents;
  }

  getView(sessionId: string): WebContentsView | null {
    const entry = this.entries.get(sessionId);
    return entry?.view ?? null;
  }

  async markSessionActive(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.idleFreezeEligible = false;
    this.clearIdleFreezeTimer(entry);
    this.clearCompletedCleanupTimer(entry);
    this.applyFrameRate(entry);
    await this.setLifecycleState(entry, 'active', 'session-active');
  }

  markSessionIdle(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.idleFreezeEligible = true;
    this.applyFrameRate(entry);
    this.scheduleIdleFreeze(entry, 'session-idle');
    this.scheduleCompletedPageCleanup(entry);
  }

  private clearIdleFreezeTimer(entry: PoolEntry): void {
    if (!entry.freezeTimer) return;
    clearTimeout(entry.freezeTimer);
    entry.freezeTimer = null;
  }

  private clearCompletedCleanupTimer(entry: PoolEntry): void {
    if (!entry.completedCleanupTimer) return;
    clearTimeout(entry.completedCleanupTimer);
    entry.completedCleanupTimer = null;
  }

  private scheduleCompletedPageCleanup(entry: PoolEntry): void {
    this.clearCompletedCleanupTimer(entry);
    entry.completedCleanupTimer = setTimeout(() => {
      entry.completedCleanupTimer = null;
      const current = this.entries.get(entry.sessionId);
      if (current !== entry || !entry.idleFreezeEligible) return;
      void this.cleanupCompletedPages(entry);
    }, this.completedPageCleanupDelayMs);
    entry.completedCleanupTimer.unref?.();
  }

  private async cleanupCompletedPages(entry: PoolEntry): Promise<void> {
    const candidates = Array.from(entry.pages.values())
      .filter((page) => (
        !page.isRoot
        && !page.pinned
        && !page.autoCloseProtected
        && page.view !== entry.view
        && !page.view.webContents.isCurrentlyAudible()
      ))
      .sort((a, b) => a.lastActivatedAt - b.lastActivatedAt);
    let closed = 0;
    for (const page of candidates) {
      if (await this.requestPageClose(entry, page, 'completed-cleanup')) closed += 1;
    }
    browserLogger.info('BrowserPool.space.completedCleanup', {
      sessionId: entry.sessionId,
      candidates: candidates.length,
      closed,
      remaining: entry.pages.size,
    });
  }

  private schedulePageLimitEnforcement(entry: PoolEntry): void {
    entry.pageLimitRequested = true;
    if (entry.pageLimitRun) return;
    entry.pageLimitRun = (async () => {
      while (entry.pageLimitRequested && this.entries.get(entry.sessionId) === entry) {
        entry.pageLimitRequested = false;
        await this.enforcePageLimit(entry);
      }
    })().finally(() => {
      if (this.entries.get(entry.sessionId) === entry) {
        entry.pageLimitRun = null;
        if (entry.pageLimitRequested) queueMicrotask(() => this.schedulePageLimitEnforcement(entry));
      }
    });
  }

  private async enforcePageLimit(entry: PoolEntry): Promise<void> {
    const attempted = new Set<number>();
    while (entry.pages.size > this.maxPagesPerSpace) {
      const candidate = Array.from(entry.pages.entries())
        .filter(([id, page]) => (
          !attempted.has(id)
          && !page.isRoot
          && !page.pinned
          && !page.autoCloseProtected
          && page.view !== entry.view
          && !page.view.webContents.isCurrentlyAudible()
          && !page.view.webContents.isDestroyed()
        ))
        .sort(([, a], [, b]) => a.lastActivatedAt - b.lastActivatedAt)[0];
      if (!candidate) break;
      const [id, page] = candidate;
      attempted.add(id);
      await this.requestPageClose(entry, page, 'page-limit');
    }
    if (entry.pages.size > this.maxPagesPerSpace) {
      // A newly opened page can become active before an older candidate's
      // beforeunload veto is known. If every old page is now protected, move
      // focus back to the root and try to discard only that just-created
      // overflow page. A veto restores it as active and leaves the Space
      // temporarily over quota rather than risking unsaved data.
      const newest = Array.from(entry.pages.values())
        .filter((page) => !page.isRoot && !page.pinned && !page.autoCloseProtected && !page.view.webContents.isDestroyed())
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      const root = Array.from(entry.pages.values()).find((page) => page.isRoot && !page.view.webContents.isDestroyed());
      if (
        newest
        && newest.view === entry.view
        && root
        && Date.now() - newest.createdAt < 10_000
        && !newest.view.webContents.isCurrentlyAudible()
        && this.activateManagedPage(entry, root, 'page-limit-overflow-fallback')
      ) {
        const closed = await this.requestPageClose(entry, newest, 'page-limit-new-overflow');
        if (!closed && this.entries.get(entry.sessionId) === entry) {
          this.activateManagedPage(entry, newest, 'page-limit-overflow-veto');
        }
      }
    }
    if (entry.pages.size > this.maxPagesPerSpace) {
      browserLogger.warn('BrowserPool.space.pageLimitDeferred', {
        sessionId: entry.sessionId,
        pageCount: entry.pages.size,
        maxPagesPerSpace: this.maxPagesPerSpace,
        reason: 'all remaining pages are protected, audible, active, or blocked beforeunload',
      });
    }
  }

  private requestPageClose(entry: PoolEntry, page: ManagedPage, reason: string): Promise<boolean> {
    const wc = page.view.webContents;
    if (wc.isDestroyed()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (closed: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        wc.off('destroyed', onDestroyed);
        if (!closed) {
          page.autoCloseProtected = true;
          browserLogger.info('BrowserPool.space.pageCloseDeferred', {
            sessionId: entry.sessionId,
            wcId: wc.id,
            reason,
          });
          this.notifyTabsChanged(entry);
        }
        resolve(closed);
      };
      const onDestroyed = (): void => finish(true);
      const timer = setTimeout(() => finish(wc.isDestroyed()), 1_500);
      timer.unref?.();
      wc.once('destroyed', onDestroyed);
      try {
        wc.close({ waitForBeforeUnload: true });
      } catch (err) {
        browserLogger.warn('BrowserPool.space.pageCloseError', {
          sessionId: entry.sessionId,
          wcId: wc.id,
          reason,
          error: (err as Error).message,
        });
        finish(false);
      }
    });
  }

  private frameRateFor(entry: PoolEntry): number {
    const activePage = entry.pages.get(entry.view.webContents.id);
    return activePage ? this.frameRateForPage(entry, activePage) : THROTTLED_FRAME_RATE;
  }

  private frameRateForPage(entry: PoolEntry, page: ManagedPage): number {
    if (page.view === entry.view && entry.attached && !entry.parked) return ACTIVE_FRAME_RATE;
    return entry.idleFreezeEligible ? IDLE_FRAME_RATE : THROTTLED_FRAME_RATE;
  }

  private applyFrameRate(entry: PoolEntry): void {
    for (const page of entry.pages.values()) {
      try {
        page.view.webContents.setFrameRate(this.frameRateForPage(entry, page));
      } catch (err) {
        browserLogger.warn('BrowserPool.frameRate.error', {
          sessionId: entry.sessionId,
          wcId: page.view.webContents.id,
          error: (err as Error).message,
        });
      }
    }
  }

  private scheduleIdleFreeze(entry: PoolEntry, reason: string): void {
    this.clearIdleFreezeTimer(entry);
    if (!entry.idleFreezeEligible || entry.attached || this.idleFreezeDelayMs <= 0) return;

    entry.freezeTimer = setTimeout(() => {
      entry.freezeTimer = null;
      const current = this.entries.get(entry.sessionId);
      if (current !== entry) return;
      void this.freezeIfStillIdle(entry, reason);
    }, this.idleFreezeDelayMs);
    entry.freezeTimer.unref?.();
  }

  private async freezeIfStillIdle(entry: PoolEntry, reason: string): Promise<void> {
    if (!entry.idleFreezeEligible || entry.attached) return;
    let audiblePages = 0;
    for (const page of entry.pages.values()) {
      const wc = page.view.webContents;
      if (wc.isDestroyed() || page.frozen) continue;
      if (wc.isCurrentlyAudible()) {
        audiblePages += 1;
        continue;
      }
      await this.setPageLifecycleState(entry, page, 'frozen', reason);
    }
    if (audiblePages > 0) {
      browserLogger.info('BrowserPool.freeze.skippedAudible', {
        sessionId: entry.sessionId,
        reason,
        audiblePages,
      });
      this.scheduleIdleFreeze(entry, 'audible-retry');
    }
  }

  private async wakeForVisibility(entry: PoolEntry, reason: string): Promise<void> {
    this.clearIdleFreezeTimer(entry);
    await this.setLifecycleState(entry, 'active', reason);
  }

  private async setLifecycleState(entry: PoolEntry, state: 'active' | 'frozen', reason: string): Promise<void> {
    for (const page of entry.pages.values()) {
      await this.setPageLifecycleState(entry, page, state, reason);
    }
  }

  private async setPageLifecycleState(
    entry: PoolEntry,
    page: ManagedPage,
    state: 'active' | 'frozen',
    reason: string,
  ): Promise<void> {
    const wc = page.view.webContents;
    if (wc.isDestroyed()) return;
    if (state === 'active' && !page.frozen) return;
    if (state === 'frozen' && page.frozen) return;

    const dbg = wc.debugger;
    const wasAttached = dbg.isAttached();
    try {
      if (!wasAttached) dbg.attach(CDP_PROTOCOL_VERSION);
      await dbg.sendCommand('Page.setWebLifecycleState', { state });
      page.frozen = state === 'frozen';
      browserLogger.info('BrowserPool.lifecycleState', {
        sessionId: entry.sessionId,
        wcId: wc.id,
        state,
        reason,
      });
    } catch (err) {
      browserLogger.debug('BrowserPool.lifecycleState.error', {
        sessionId: entry.sessionId,
        wcId: wc.id,
        state,
        reason,
        error: (err as Error).message,
      });
    } finally {
      if (!wasAttached) {
        try { dbg.detach(); } catch { /* debugger may have detached during navigation */ }
      }
    }
  }

  /** Edge-to-edge fill: view rect = slot rect, no gutters. Zoom is set so
   *  the page sees a desktop-feeling viewport (~900 CSS px tall, slot-aspect
   *  wide). zoom alone is enough — no device emulation. The page renders
   *  at exactly bounds.width x bounds.height physical pixels. */
  private fitBoundsToView(
    bounds: ViewBounds,
  ): { x: number; y: number; width: number; height: number; zoom: number } {
    const zoom = Math.max(0.25, bounds.height / EMULATED_VIEWPORT_HEIGHT);
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      zoom,
    };
  }

  private rememberVisibleBounds(entry: PoolEntry, bounds: ViewBounds): void {
    if (entry.parked) return;
    if (bounds.width <= 0 || bounds.height <= 0) return;
    entry.lastVisibleBounds = { ...bounds };
  }

  private ensureChildView(window: BrowserWindow, view: WebContentsView): void {
    if (!window.contentView.children.includes(view)) {
      window.contentView.addChildView(view);
    }
  }

  /** The hub currently renders one live browser pane. Keep background
   * screencast views parked, but remove any other full-size sibling before a
   * session becomes visible. Otherwise two WebContentsViews occupy the same
   * rectangle and Electron's child z-order can show a stale session. */
  private detachVisibleSiblings(sessionId: string, window: BrowserWindow): void {
    for (const entry of this.entries.values()) {
      if (entry.sessionId === sessionId || !entry.attached || entry.parked) continue;
      try { window.contentView.removeChildView(entry.view); } catch { /* already removed */ }
      entry.attached = false;
      entry.attachedWindow = null;
      this.applyFrameRate(entry);
      this.scheduleIdleFreeze(entry, 'replaced-by-visible-session');
      browserLogger.info('BrowserPool.detachVisibleSibling', {
        sessionId: entry.sessionId,
        replacedBy: sessionId,
      });
    }
  }

  private raiseChildView(window: BrowserWindow, view: WebContentsView): void {
    if (window.contentView.children.includes(view)) {
      try { window.contentView.removeChildView(view); } catch { /* already removed */ }
    }
    window.contentView.addChildView(view);
  }

  private getPreviewParkBounds(window: BrowserWindow, width: number, height: number): ViewBounds {
    const fallback = { width: DEFAULT_BROWSER_WIDTH, height: DEFAULT_BROWSER_HEIGHT };
    const contentBounds = typeof window.getContentBounds === 'function'
      ? window.getContentBounds()
      : fallback;
    const contentWidth = Math.max(PREVIEW_PARK_VISIBLE_PX, contentBounds.width || fallback.width);
    const contentHeight = Math.max(PREVIEW_PARK_VISIBLE_PX, contentBounds.height || fallback.height);
    return {
      x: contentWidth - PREVIEW_PARK_VISIBLE_PX,
      y: contentHeight - PREVIEW_PARK_VISIBLE_PX,
      width,
      height,
    };
  }

  /** Public helper for the resize fast path: applies the same fit logic as
   *  attach so the rendered page stays edge-to-edge as the hub layout
   *  changes. Returns the fitted rect, or null if the view doesn't exist. */
  setViewBoundsFitted(sessionId: string, bounds: ViewBounds): { x: number; y: number; width: number; height: number } | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width <= 0 || bounds.height <= 0) return null;
    const fitted = this.fitBoundsToView(bounds);
    entry.view.setBounds({ x: fitted.x, y: fitted.y, width: fitted.width, height: fitted.height });
    try { entry.view.webContents.setZoomFactor(fitted.zoom); } catch { /* ignore */ }
    entry.parked = false;
    this.rememberVisibleBounds(entry, { x: fitted.x, y: fitted.y, width: fitted.width, height: fitted.height });
    return { x: fitted.x, y: fitted.y, width: fitted.width, height: fitted.height };
  }

  attachToWindow(sessionId: string, window: BrowserWindow, bounds: ViewBounds): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      browserLogger.warn('BrowserPool.attach.notFound', { sessionId });
      return false;
    }

    // Re-apply the resolved theme bg every attach. While detached, the view
    // isn't a child of any window's contentView, so it misses the
    // theme-broadcast loop in themeMode.applyBackgroundToAllWindows() and
    // would otherwise paint with whatever bg it had at create time.
    try { entry.view.setBackgroundColor(getWindowBackgroundColor()); } catch { /* noop */ }

    // Guard against transient zero/non-finite bounds (e.g. a frame fired
    // mid-relayout when the pane has 0 width/height). Without this the fit
    // math feeds NaN/Infinity into setBounds.
    const validShape = Number.isFinite(bounds.width) && Number.isFinite(bounds.height)
      && bounds.width > 0 && bounds.height > 0;
    if (!validShape) {
      browserLogger.debug('BrowserPool.attach.skipInvalidBounds', { sessionId, bounds });
      return entry.attached;
    }

    const fitted = this.fitBoundsToView(bounds);
    this.detachVisibleSiblings(sessionId, window);

    if (entry.attached) {
      browserLogger.debug('BrowserPool.attach.alreadyAttached', { sessionId });
      // Re-adding is intentional: addChildView raises the selected session
      // above any parked/background sibling.
      this.raiseChildView(window, entry.view);
      entry.view.setBounds({ x: fitted.x, y: fitted.y, width: fitted.width, height: fitted.height });
      try { entry.view.webContents.setZoomFactor(fitted.zoom); } catch { /* ignore */ }
      entry.parked = false;
      entry.attachedWindow = window;
      this.rememberVisibleBounds(entry, { x: fitted.x, y: fitted.y, width: fitted.width, height: fitted.height });
      void this.wakeForVisibility(entry, 'attach');
      this.applyFrameRate(entry);
      return true;
    }

    entry.view.setBounds({ x: fitted.x, y: fitted.y, width: fitted.width, height: fitted.height });
    this.raiseChildView(window, entry.view);
    entry.attached = true;
    entry.attachedWindow = window;
    entry.parked = false;
    this.rememberVisibleBounds(entry, { x: fitted.x, y: fitted.y, width: fitted.width, height: fitted.height });
    void this.wakeForVisibility(entry, 'attach');

    this.applyFrameRate(entry);

    try {
      entry.view.webContents.setZoomFactor(fitted.zoom);
    } catch (err) {
      browserLogger.warn('BrowserPool.attach.setZoomFactor.error', { sessionId, zoom: fitted.zoom, error: (err as Error).message });
    }

    browserLogger.info('BrowserPool.attach', {
      sessionId,
      visualBounds: bounds,
      fittedBounds: { x: fitted.x, y: fitted.y, width: fitted.width, height: fitted.height },
      cssViewport: { width: Math.round(bounds.width / fitted.zoom), height: Math.round(bounds.height / fitted.zoom) },
      rectAspect: bounds.width / bounds.height,
      zoomFactor: fitted.zoom,
      frameRate: this.frameRateFor(entry),
    });

    return true;
  }

  detachFromWindow(sessionId: string, window: BrowserWindow): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      browserLogger.warn('BrowserPool.detach.notFound', { sessionId });
      return false;
    }

    if (!entry.attached) {
      browserLogger.debug('BrowserPool.detach.notAttached', { sessionId });
      return false;
    }

    window.contentView.removeChildView(entry.view);
    entry.attached = false;
    entry.attachedWindow = null;
    entry.parked = false;

    this.applyFrameRate(entry);
    this.scheduleIdleFreeze(entry, 'detached');

    browserLogger.info('BrowserPool.detach', {
      sessionId,
      frameRate: this.frameRateFor(entry),
      idleFreezeEligible: entry.idleFreezeEligible,
    });

    return true;
  }

  detachAll(window: BrowserWindow): void {
    const ids = Array.from(this.entries.keys());
    for (const id of ids) {
      this.detachFromWindow(id, window);
    }
    browserLogger.info('BrowserPool.detachAll', { count: ids.length });
  }

  temporarilyDetachAll(window: BrowserWindow): void {
    let parked = 0;
    for (const entry of this.entries.values()) {
      if (entry.attached) {
        this.ensureChildView(window, entry.view);
        const current = entry.view.getBounds();
        this.rememberVisibleBounds(entry, current);
        const stableBounds = entry.lastVisibleBounds ?? current;
        const width = Math.max(1, stableBounds.width || DEFAULT_BROWSER_WIDTH);
        const height = Math.max(1, stableBounds.height || DEFAULT_BROWSER_HEIGHT);
        entry.view.setBounds(this.getPreviewParkBounds(window, width, height));
        entry.parked = true;
        parked += 1;
        this.applyFrameRate(entry);
      }
    }
    browserLogger.info('BrowserPool.temporarilyDetachAll', { parked });
  }

  async parkForPreview(sessionId: string, window: BrowserWindow): Promise<{ ok: boolean; parkedByUs: boolean; reason?: string }> {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      browserLogger.warn('BrowserPool.parkForPreview.notFound', { sessionId });
      return { ok: false, parkedByUs: false, reason: 'not_found' };
    }
    if (entry.view.webContents.isDestroyed()) {
      browserLogger.warn('BrowserPool.parkForPreview.destroyed', { sessionId });
      return { ok: false, parkedByUs: false, reason: 'destroyed' };
    }

    const parkedByUs = !entry.attached;
    this.ensureChildView(window, entry.view);
    const current = entry.view.getBounds();
    this.rememberVisibleBounds(entry, current);
    const stableBounds = entry.lastVisibleBounds ?? current;
    const width = Math.max(1, stableBounds.width || DEFAULT_BROWSER_WIDTH);
    const height = Math.max(1, stableBounds.height || DEFAULT_BROWSER_HEIGHT);
    entry.view.setBounds(this.getPreviewParkBounds(window, width, height));
    entry.attached = true;
    entry.attachedWindow = window;
    entry.parked = true;
    this.clearIdleFreezeTimer(entry);
    await this.wakeForVisibility(entry, 'preview');
    this.applyFrameRate(entry);
    browserLogger.info('BrowserPool.parkForPreview', { sessionId, parkedByUs, width, height, bounds: entry.view.getBounds() });
    return { ok: true, parkedByUs };
  }

  releasePreviewParking(sessionId: string, window: BrowserWindow | null): void {
    const entry = this.entries.get(sessionId);
    if (!entry || !entry.attached || !entry.parked) return;

    if (window && !window.isDestroyed()) {
      try {
        window.contentView.removeChildView(entry.view);
      } catch (err) {
        browserLogger.warn('BrowserPool.releasePreviewParking.removeError', {
          sessionId,
          error: (err as Error).message,
        });
      }
    }
    entry.attached = false;
    entry.attachedWindow = null;
    entry.parked = false;
    this.applyFrameRate(entry);
    this.scheduleIdleFreeze(entry, 'preview-stopped');
    browserLogger.info('BrowserPool.releasePreviewParking', {
      sessionId,
      frameRate: this.frameRateFor(entry),
      idleFreezeEligible: entry.idleFreezeEligible,
    });
  }

  reattachAll(window: BrowserWindow): void {
    let reattached = 0;
    for (const entry of this.entries.values()) {
      if (entry.attached) {
        entry.attachedWindow = window;
        this.ensureChildView(window, entry.view);
        if (entry.parked && entry.lastVisibleBounds) {
          entry.view.setBounds(entry.lastVisibleBounds);
        }
        entry.parked = false;
        void this.wakeForVisibility(entry, 'reattach');
        this.applyFrameRate(entry);
        reattached += 1;
      }
    }
    browserLogger.info('BrowserPool.reattachAll', { reattached });
  }

  async getTabs(sessionId: string): Promise<TabInfo[]> {
    try {
      const entry = this.entries.get(sessionId);
      if (!entry) return [];
      return this.tabSnapshot(entry);
    } catch (err) {
      browserLogger.warn('BrowserPool.getTabs.error', {
        sessionId,
        error: (err as Error).message,
      });
      return [];
    }
  }

  activatePage(sessionId: string, targetId: string): { activated: boolean; reason?: string } {
    const entry = this.entries.get(sessionId);
    if (!entry) return { activated: false, reason: 'session_not_found' };
    const wcId = Number(targetId);
    if (!Number.isSafeInteger(wcId)) return { activated: false, reason: 'invalid_target' };
    const page = entry.pages.get(wcId);
    if (!page || page.view.webContents.isDestroyed()) return { activated: false, reason: 'page_not_found' };
    return this.activateManagedPage(entry, page, 'user-tab-strip')
      ? { activated: true }
      : { activated: false, reason: 'page_destroyed' };
  }

  setPagePinned(sessionId: string, targetId: string, pinned: boolean): { pinned: boolean; reason?: string } {
    const entry = this.entries.get(sessionId);
    if (!entry) return { pinned: false, reason: 'session_not_found' };
    const wcId = Number(targetId);
    if (!Number.isSafeInteger(wcId)) return { pinned: false, reason: 'invalid_target' };
    const page = entry.pages.get(wcId);
    if (!page || page.view.webContents.isDestroyed()) return { pinned: false, reason: 'page_not_found' };
    if (page.isRoot) return { pinned: false, reason: 'root_always_protected' };
    page.pinned = pinned;
    browserLogger.info('BrowserPool.space.pagePinned', { sessionId, wcId, pinned });
    this.notifyTabsChanged(entry);
    return { pinned };
  }

  async closePage(sessionId: string, targetId: string): Promise<{ closed: boolean; reason?: string }> {
    const entry = this.entries.get(sessionId);
    if (!entry) return { closed: false, reason: 'session_not_found' };
    const wcId = Number(targetId);
    if (!Number.isSafeInteger(wcId)) return { closed: false, reason: 'invalid_target' };
    const page = entry.pages.get(wcId);
    if (!page || page.view.webContents.isDestroyed()) return { closed: false, reason: 'page_not_found' };
    if (page.isRoot) return { closed: false, reason: 'root_protected' };

    if (page.view === entry.view) {
      const fallback = Array.from(entry.pages.values())
        .filter((candidate) => candidate !== page && !candidate.view.webContents.isDestroyed())
        .sort((a, b) => Number(b.isRoot) - Number(a.isRoot) || b.lastActivatedAt - a.lastActivatedAt)[0];
      if (!fallback || !this.activateManagedPage(entry, fallback, 'active-page-close')) {
        return { closed: false, reason: 'no_fallback' };
      }
    }

    const closed = await this.requestPageClose(entry, page, 'user-tab-strip');
    if (!closed && this.entries.get(sessionId) === entry) {
      this.activateManagedPage(entry, page, 'user-close-beforeunload-veto');
    }
    return closed ? { closed: true } : { closed: false, reason: 'beforeunload_blocked' };
  }

  destroy(sessionId: string, window?: BrowserWindow): void {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      browserLogger.debug('BrowserPool.destroy.notFound', { sessionId });
      return;
    }

    if (entry.attached && window) {
      try {
        window.contentView.removeChildView(entry.view);
      } catch (err) {
        browserLogger.warn('BrowserPool.destroy.detachError', {
          sessionId,
          error: (err as Error).message,
        });
      }
    }

    const lifetimeMs = Date.now() - entry.createdAt;
    this.clearIdleFreezeTimer(entry);
    this.clearCompletedCleanupTimer(entry);

    // Delete from map first so the wc.on('destroyed') listener's notifyGone
    // is a clean no-op (it still fires, but the entry is already gone).
    this.entries.delete(sessionId);

    const wc = entry.view.webContents;
    const pages = Array.from(entry.pages.values());
    let closed = false;
    try {
      if (!wc.isDestroyed()) {
        (wc as unknown as { close: (opts?: { waitForBeforeUnload?: boolean }) => void }).close();
        closed = true;
      }
    } catch (err) {
      browserLogger.warn('BrowserPool.destroy.closeError', {
        sessionId,
        error: (err as Error).message,
      });
    }

    // wc.close() doesn't always destroy embedded WebContents synchronously
    // (or at all, for views without an unload handler). Force teardown on the
    // next tick if it's still alive — this fires the `destroyed` listener,
    // which also calls notifyGone (idempotent on the renderer).
    setImmediate(() => {
      for (const page of pages) {
        const pageWc = page.view.webContents;
        try {
          if (!pageWc.isDestroyed()) {
            (pageWc as unknown as { destroy?: () => void }).destroy?.();
          }
        } catch (err) {
          browserLogger.warn('BrowserPool.destroy.forceError', {
            sessionId,
            wcId: pageWc.id,
            error: (err as Error).message,
          });
        }
      }
    });

    // Notify renderer synchronously so "Browser ended" paints immediately —
    // we don't want to wait for the wc.destroyed event, which may be delayed
    // or never fire if close() is a no-op.
    this.notifyGone(sessionId);

    browserLogger.info('BrowserPool.destroy', {
      sessionId,
      lifetimeMs,
      remainingActive: this.entries.size,
      closed,
    });

    this.drainQueue();
  }

  destroyAll(window?: BrowserWindow): void {
    const sessionIds = Array.from(this.entries.keys());
    browserLogger.info('BrowserPool.destroyAll', { count: sessionIds.length });

    for (const sessionId of sessionIds) {
      this.destroy(sessionId, window);
    }

    this.queue.length = 0;
  }

  isAttached(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    return entry?.attached ?? false;
  }

  getStats(): {
    active: number;
    queued: number;
    maxConcurrent: number;
    sessions: Array<{ sessionId: string; attached: boolean; createdAt: number; pid: number }>;
  } {
    const sessions = Array.from(this.entries.values()).map((e) => ({
      sessionId: e.sessionId,
      attached: e.attached,
      createdAt: e.createdAt,
      pid: e.view.webContents.getOSProcessId(),
    }));

    return {
      active: this.entries.size,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      sessions,
    };
  }

  private drainQueue(): void {
    while (this.queue.length > 0 && this.canCreate()) {
      const nextSessionId = this.queue.shift()!;
      browserLogger.info('BrowserPool.drainQueue', {
        sessionId: nextSessionId,
        remainingQueued: this.queue.length,
      });
      // The session manager will need to call create() again for this session.
      // We emit the session ID so the caller knows to retry.
      // For now, just log — the session manager polls canCreate().
    }
  }
}
