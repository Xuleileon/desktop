/**
 * CDP Session: one persistent WebSocket to Chrome's browser endpoint.
 * Auto-injects sessionId for the active target on every call.
 *
 * Connect with `flatten: true` so all sessions share one WS (no nested
 * Target.sendMessageToTarget envelopes).
 */

import { bindDomains, type Domains, type Transport } from './generated.ts';

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  method: string;
  timer: ReturnType<typeof setTimeout>;
};

export type SessionOptions = {
  /** Maximum time for one CDP command response. Defaults to CDP_CALL_TIMEOUT_MS or 30000ms. */
  callTimeoutMs?: number;
};

const DEFAULT_CDP_CALL_TIMEOUT_MS = 30_000;
const MIN_CDP_CALL_TIMEOUT_MS = 100;
const MAX_CDP_CALL_TIMEOUT_MS = 120_000;

export type ConnectOptions = {
  /** Full WS URL: ws://host:port/devtools/browser/<id>. Escape hatch. */
  wsUrl?: string;
  /** CDP HTTP port. Browser Use Desktop provides this as BU_CDP_PORT. */
  port?: number | string;
  /** CDP HTTP host. Defaults to 127.0.0.1. */
  host?: string;
  /** Optional page target to attach after connecting to the browser endpoint. */
  targetId?: string;
  /** Or: read DevToolsActivePort from a specific browser's profile dir. */
  profileDir?: string;
  /** Per-candidate WS-open timeout in ms. Default 5000.
   *  A live browser opens or 403s within ~100ms, so 5s is generous.
   *  The only case that legitimately needs longer is waiting on the Chrome
   *  "Allow" popup — bump to 30000 if you expect the user to click it. */
  timeoutMs?: number;
};

/** A Chromium-based browser detected as running on this machine. */
export type DetectedBrowser = {
  /** Short label, e.g. 'Google Chrome', 'Brave', 'Comet'. */
  name: string;
  /** Absolute profile (user-data) dir. */
  profileDir: string;
  /** Port from DevToolsActivePort line 1. */
  port: number;
  /** WebSocket path from DevToolsActivePort line 2. */
  wsPath: string;
  /** `ws://127.0.0.1:<port><wsPath>` — ready for WebSocket. */
  wsUrl: string;
  /** DevToolsActivePort mtime (ms since epoch). Used to order by recency. */
  mtimeMs: number;
};

export class Session implements Transport {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private activeSessionId: string | undefined;
  private eventListeners: Array<(method: string, params: unknown, sessionId?: string) => void> = [];
  private readonly assignedTargetId = process.env.BU_TARGET_ID?.trim() || undefined;
  private readonly assignedPort = process.env.BU_CDP_PORT?.trim() || undefined;
  private readonly ownedTargetIds = new Set<string>(this.assignedTargetId ? [this.assignedTargetId] : []);
  private readonly ownedSessionIds = new Set<string>();
  private readonly callTimeoutMs: number;
  private assignedBrowserContextId: string | undefined;

  // Generated bindings — one per CDP domain.
  // Initialized lazily after construction so `_call` is available.
  domains!: Domains;

  constructor(options: SessionOptions = {}) {
    this.callTimeoutMs = boundedTimeoutMs(
      options.callTimeoutMs ?? process.env.CDP_CALL_TIMEOUT_MS,
      DEFAULT_CDP_CALL_TIMEOUT_MS,
      MIN_CDP_CALL_TIMEOUT_MS,
      MAX_CDP_CALL_TIMEOUT_MS,
    );
    this.domains = bindDomains(this);
    // Mirror domains onto `this` so calls read as `session.Page.navigate(...)`.
    for (const k of Object.keys(this.domains) as (keyof Domains)[]) {
      (this as any)[k] = this.domains[k];
    }
  }

  /**
   * Connect to Chrome's browser-level WebSocket.
   *
   * With no args, runs auto-detect: scans OS-specific profile dirs via
   * `detectBrowsers()` and tries each candidate (most-recently-launched first)
   * until a WebSocket open succeeds. Each attempt has a short timeout so
   * dead ports and permission-denied (403) candidates fail fast and the
   * loop moves on.
   *
   * With explicit opts ({ wsUrl } | { profileDir } | { port }), connects
   * directly to that single URL with a generous timeout. When { targetId } is
   * supplied with { port }, Browser Use Desktop attaches that page target so
   * Page/DOM/Runtime calls route to the app-assigned browser view.
   */
  async connect(opts: ConnectOptions = {}): Promise<void> {
    if (this.assignedTargetId && this.assignedPort) {
      if (opts.wsUrl || opts.profileDir) {
        throw new Error('Browser isolation: this conversation may only connect to its assigned Browser Use target.');
      }
      if (opts.targetId && opts.targetId !== this.assignedTargetId) {
        throw new Error(`Browser isolation: target ${opts.targetId} is not assigned to this conversation.`);
      }
      if (opts.port != null && Number(opts.port) !== Number(this.assignedPort)) {
        throw new Error(`Browser isolation: CDP port ${opts.port} is not assigned to this conversation.`);
      }
      opts = {
        host: '127.0.0.1',
        port: this.assignedPort,
        targetId: this.assignedTargetId,
        timeoutMs: opts.timeoutMs,
      };
    }
    const timeoutMs = opts.timeoutMs ?? 5_000;
    if (opts.wsUrl || opts.profileDir || opts.port) {
      const endpoint = await resolveEndpoint(opts);
      await this.openWs(endpoint.wsUrl, timeoutMs);
      if (opts.targetId && !endpoint.scopedToTarget) await this.use(opts.targetId);
      return;
    }
    const browsers = await detectBrowsers();
    if (browsers.length === 0) {
      const scanned = getBrowserCandidates().map(c => c.name).join(', ');
      throw new Error(
        `No running browser with remote debugging detected. Enable it from chrome://inspect > "Discover network targets", or pass { profileDir } / { wsUrl } explicitly. Scanned: ${scanned}.`,
      );
    }
    const errors: string[] = [];
    for (const b of browsers) {
      try {
        await this.openWs(b.wsUrl, timeoutMs);
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`  ${b.name} @ ${b.wsUrl}: ${msg}`);
      }
    }
    throw new Error(
      `No detected browser accepted a connection. If one of these is the browser you want, click "Allow" on its remote-debugging prompt and retry, or pass { profileDir, timeoutMs: 30000 } to wait for the click:\n${errors.join('\n')}`,
    );
  }

  private openWs(wsUrl: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((res, rej) => {
      const ws = new WebSocket(wsUrl);
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) { try { ws.close(); } catch { /* ignore */ } rej(err); }
        else res();
      };
      const timer = setTimeout(() => finish(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      ws.addEventListener('open', () => finish());
      ws.addEventListener('error', (e) => finish(new Error(`WS error: ${(e as any)?.message ?? 'connect failed (likely 403, permission not granted, or port closed)'}`)));
      ws.addEventListener('message', (e) => {
        if (this.ws === ws) this.onMessage(String(e.data));
      });
      ws.addEventListener('close', () => {
        if (this.ws === ws) {
          this.ws = undefined;
          this.activeSessionId = undefined;
          this.rejectAllPending(new Error('CDP socket closed'));
        }
        finish(new Error('WS closed before open (likely 403 or port closed)'));
      });
      this.ws = ws;
    });
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close(): void {
    const ws = this.ws;
    this.ws = undefined;
    this.activeSessionId = undefined;
    this.rejectAllPending(new Error('CDP socket closed'));
    ws?.close();
  }

  /**
   * Pick a target and make subsequent calls auto-route to it.
   * Uses Target.attachToTarget with flatten:true (single-WS, sessionId-on-message).
   */
  async use(targetId: string): Promise<string> {
    if (this.assignedTargetId && !this.ownedTargetIds.has(targetId)) {
      await this._call('Target.getTargets', {});
      if (!this.ownedTargetIds.has(targetId)) {
        throw new Error(`Browser isolation: target ${targetId} belongs to another conversation Space.`);
      }
    }
    // Keep the Desktop's visible page in lock-step with the target selected by
    // the agent. Attaching alone changes CDP routing but does not necessarily
    // focus the corresponding WebContentsView, which leaves the tab strip and
    // live preview showing a different page from the one being automated.
    await this._call('Target.activateTarget', { targetId });
    const r = await this._call('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    this.activeSessionId = r.sessionId;
    if (this.assignedTargetId) this.ownedSessionIds.add(r.sessionId);
    return r.sessionId;
  }

  /** Set the active sessionId directly (e.g. one you already attached). */
  setActiveSession(sessionId: string | undefined): void {
    if (this.assignedTargetId && sessionId && !this.ownedSessionIds.has(sessionId)) {
      throw new Error('Browser isolation: the CDP session does not belong to this conversation Space.');
    }
    this.activeSessionId = sessionId;
  }

  getActiveSession(): string | undefined {
    return this.activeSessionId;
  }

  /** Subscribe to all CDP events. Returns an unsubscribe fn. */
  onEvent(fn: (method: string, params: unknown, sessionId?: string) => void): () => void {
    this.eventListeners.push(fn);
    return () => {
      this.eventListeners = this.eventListeners.filter(x => x !== fn);
    };
  }

  /** Wait for the next event matching `method` (and optional predicate). */
  waitFor<T = unknown>(method: string, predicate?: (params: T) => boolean, timeoutMs = 30_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error(`Timeout waiting for ${method}`));
      }, timeoutMs);
      const unsub = this.onEvent((m, params) => {
        if (m !== method) return;
        if (predicate && !predicate(params as T)) return;
        clearTimeout(timer);
        unsub();
        resolve(params as T);
      });
    });
  }

  // Transport implementation. Called by the generated domain bindings.
  _call(method: string, params: unknown = {}): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected. Call session.connect(...) first.'));
    }
    const isolationError = this.browserIsolationError(method, params);
    if (isolationError) return Promise.reject(new Error(isolationError));
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method, params: params ?? {} };
    if (this.activeSessionId && !isBrowserLevel(method)) {
      msg.sessionId = this.activeSessionId;
    }
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new CdpTimeoutError(method, this.callTimeoutMs));
      }, this.callTimeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      try {
        this.ws!.send(JSON.stringify(msg));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
    if (this.assignedTargetId && method === 'Target.getTargets') {
      return response.then((result) => {
        const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
        const targetInfos = Array.isArray(record.targetInfos)
          ? record.targetInfos.filter((info): info is Record<string, unknown> => Boolean(info && typeof info === 'object'))
          : [];
        this.refreshOwnedTargets(targetInfos);
        return {
          ...record,
          targetInfos: targetInfos.filter((info) => this.ownedTargetIds.has(String(info.targetId ?? ''))),
        };
      });
    }
    return response;
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private browserIsolationError(method: string, params: unknown): string | null {
    const assignedTargetId = this.assignedTargetId;
    if (!assignedTargetId) return null;
    const record = params && typeof params === 'object' ? params as Record<string, unknown> : {};
    if (method === 'Target.getTargets') return null;
    if (
      method === 'Target.attachToTarget'
      || method === 'Target.activateTarget'
      || method === 'Target.getTargetInfo'
      || method === 'Target.closeTarget'
    ) {
      const requestedTarget = record.targetId;
      if (method === 'Target.closeTarget' && requestedTarget === assignedTargetId) {
        return 'Browser isolation: the assigned root target anchors this conversation Space and cannot be closed.';
      }
      if (typeof requestedTarget === 'string' && this.ownedTargetIds.has(requestedTarget)) return null;
      return `Browser isolation: ${method} may only address a target in the assigned conversation Space.`;
    }
    if (method.startsWith('Target.')) {
      return `Browser isolation: ${method} is not available inside a conversation-scoped browser view.`;
    }
    if (method.startsWith('Browser.') && method !== 'Browser.getVersion') {
      return `Browser isolation: ${method} is browser-global and is not available inside a conversation.`;
    }
    return null;
  }

  private refreshOwnedTargets(targetInfos: Record<string, unknown>[]): void {
    const assignedInfo = targetInfos.find((info) => info.targetId === this.assignedTargetId);
    if (typeof assignedInfo?.browserContextId === 'string') {
      this.assignedBrowserContextId = assignedInfo.browserContextId;
    }
    if (this.assignedBrowserContextId) {
      for (const info of targetInfos) {
        if (info.browserContextId === this.assignedBrowserContextId && typeof info.targetId === 'string') {
          this.ownedTargetIds.add(info.targetId);
        }
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const info of targetInfos) {
        const targetId = typeof info.targetId === 'string' ? info.targetId : '';
        const openerId = typeof info.openerId === 'string' ? info.openerId : '';
        if (!targetId || this.ownedTargetIds.has(targetId) || !this.ownedTargetIds.has(openerId)) continue;
        this.ownedTargetIds.add(targetId);
        changed = true;
      }
    }
  }

  private onMessage(raw: string): void {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if (typeof m.id === 'number') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new CdpError(m.error.code, m.error.message, m.error.data));
      else p.resolve(m.result);
    } else if (m.method) {
      if (this.assignedTargetId && m.method.startsWith('Target.')) {
        const params = m.params && typeof m.params === 'object' ? m.params as Record<string, unknown> : {};
        const targetInfo = params.targetInfo && typeof params.targetInfo === 'object'
          ? params.targetInfo as Record<string, unknown>
          : null;
        if (targetInfo) {
          this.refreshOwnedTargets([targetInfo]);
          const eventTargetId = typeof targetInfo.targetId === 'string' ? targetInfo.targetId : '';
          if (!eventTargetId || !this.ownedTargetIds.has(eventTargetId)) return;
        }
        const eventTargetId = typeof params.targetId === 'string' ? params.targetId : '';
        if (eventTargetId && !this.ownedTargetIds.has(eventTargetId)) return;
        if (m.method === 'Target.targetDestroyed' && eventTargetId) this.ownedTargetIds.delete(eventTargetId);
        const eventSessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
        if (m.method === 'Target.attachedToTarget' && eventSessionId) this.ownedSessionIds.add(eventSessionId);
        if (m.method === 'Target.detachedFromTarget' && eventSessionId && !this.ownedSessionIds.has(eventSessionId)) return;
        if (m.method === 'Target.detachedFromTarget' && eventSessionId) this.ownedSessionIds.delete(eventSessionId);
      }
      for (const fn of this.eventListeners) {
        try { fn(m.method, m.params, m.sessionId); } catch { /* ignore */ }
      }
    }
  }
}

export class CdpError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(`CDP ${code}: ${message}`);
    this.name = 'CdpError';
  }
}

export class CdpTimeoutError extends Error {
  constructor(public method: string, public timeoutMs: number) {
    super(`CDP call ${method} timed out after ${timeoutMs}ms`);
    this.name = 'CdpTimeoutError';
  }
}

function boundedTimeoutMs(value: number | string | undefined, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/** Browser-level methods never take a sessionId. */
function isBrowserLevel(method: string): boolean {
  return method.startsWith('Browser.') || method.startsWith('Target.');
}

/**
 * Resolve a WebSocket URL for one of the explicit connect forms:
 *   { wsUrl }      — passthrough.
 *   { profileDir } — reads `<profileDir>/DevToolsActivePort` and builds the
 *                    WS URL directly. Works on all Chrome versions including
 *                    144+ / chrome://inspect (which doesn't serve /json/version).
 *
 * For auto-detect, call `session.connect()` with no args — it iterates
 * `detectBrowsers()` and picks the first browser whose WS accepts.
 */
export async function resolveWsUrl(opts: ConnectOptions): Promise<string> {
  return (await resolveEndpoint(opts)).wsUrl;
}

type ResolvedEndpoint = {
  wsUrl: string;
  /** True when the URL is already a page-scoped /devtools/page endpoint. */
  scopedToTarget?: boolean;
};

async function resolveEndpoint(opts: ConnectOptions): Promise<ResolvedEndpoint> {
  if (opts.wsUrl) return { wsUrl: opts.wsUrl };
  if (opts.profileDir) {
    const { port, path } = await readDevToolsActivePort(opts.profileDir);
    return { wsUrl: `ws://127.0.0.1:${port}${path}` };
  }
  if (opts.port) {
    return resolvePortEndpoint(opts);
  }
  throw new Error('resolveWsUrl needs { wsUrl }, { profileDir }, or { port }. For auto-detect, call session.connect() directly.');
}

async function resolvePortEndpoint(opts: ConnectOptions): Promise<ResolvedEndpoint> {
  const port = Number(opts.port);
  if (!Number.isFinite(port)) throw new Error(`invalid CDP port: ${opts.port}`);
  const host = opts.host ?? '127.0.0.1';
  const timeoutMs = boundedTimeoutMs(opts.timeoutMs, 5_000, 100, 30_000);

  try {
    const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(`http://${host}:${port}/json/version`, timeoutMs);
    if (version.webSocketDebuggerUrl) return { wsUrl: version.webSocketDebuggerUrl };
  } catch {
    // Some Chromium builds only expose page endpoints. Fall through to /json/list.
  }

  const targets = await fetchJson<Array<{ id?: string; targetId?: string; type?: string; url?: string; webSocketDebuggerUrl?: string }>>(
    `http://${host}:${port}/json/list`,
    timeoutMs,
  );
  const match = opts.targetId
    ? targets.find(t => t.id === opts.targetId || t.targetId === opts.targetId)
    : targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!match?.webSocketDebuggerUrl) {
    throw new Error(`Could not resolve CDP websocket from ${host}:${port}${opts.targetId ? ` for target ${opts.targetId}` : ''}`);
  }
  return { wsUrl: match.webSocketDebuggerUrl, scopedToTarget: true };
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return await res.json() as T;
}

/**
 * Parse both lines of DevToolsActivePort. Chrome writes:
 *   line 1: port number
 *   line 2: path (e.g. "/devtools/browser/<uuid>")
 * With both in hand we can build `ws://host:port<path>` with no HTTP probe.
 */
async function readDevToolsActivePort(profileDir: string): Promise<{ port: number; path: string }> {
  const deadline = Date.now() + 30_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const text = (await Bun.file(`${profileDir}/DevToolsActivePort`).text()).trim();
      const [portStr, path] = text.split('\n');
      const port = Number(portStr);
      if (!Number.isFinite(port)) throw new Error(`malformed port line: ${portStr}`);
      if (!path || !path.startsWith('/devtools/')) {
        // File is written atomically but path line may not be there on first open.
        throw new Error(`missing/invalid path line in DevToolsActivePort: ${JSON.stringify(text)}`);
      }
      return { port, path };
    } catch (e) {
      lastErr = e;
      await Bun.sleep(250);
    }
  }
  throw new Error(`Could not read ${profileDir}/DevToolsActivePort after 30s: ${lastErr}`);
}

/**
 * List page targets via CDP's `Target.getTargets` (works on all Chrome versions,
 * including those that do not serve /json). Filters out chrome:// and devtools://
 * internals. Requires the session to be connected already.
 */
export type PageTarget = { targetId: string; title: string; url: string; type: string };
export function listPageTargets(session: Session): Promise<PageTarget[]> {
  const request = session.domains.Target.getTargets({}).then(({ targetInfos }) => (
    (targetInfos as PageTarget[]).filter(
      t => t.type === 'page' && !t.url.startsWith('chrome://') && !t.url.startsWith('devtools://')
    )
  ));
  return requireAwait(request, 'listPageTargets()');
}

/**
 * Keep normal Promise/await behavior while making accidental synchronous use
 * fail loudly instead of serializing a pending Promise as `{}` or `[]`.
 */
function requireAwait<T>(promise: Promise<T>, label: string): Promise<T> {
  const misuse = (operation: PropertyKey) => new TypeError(
    `${label} returns a Promise; use \`await ${label}\` before ${String(operation)}.`,
  );
  // A misuse may throw before a caller can attach a rejection handler. Keep a
  // side handler so a later CDP failure does not become an unhandled rejection;
  // awaiting the original Promise still receives the rejection normally.
  void promise.catch(() => {});
  return new Proxy(promise, {
    get(target, property) {
      if (property === 'then' || property === 'catch' || property === 'finally') {
        return target[property].bind(target);
      }
      if (property === Symbol.toStringTag) return 'Promise';
      throw misuse(property);
    },
    ownKeys() {
      throw misuse('enumerating its values');
    },
    getOwnPropertyDescriptor() {
      throw misuse('reading its properties');
    },
  });
}

/**
 * Scan OS-specific user-data directories for Chromium-based browsers that
 * currently have remote debugging enabled (a `DevToolsActivePort` file exists
 * in the profile dir). Does NOT verify the WS endpoint is live — call
 * `verifyWsEndpoint(wsUrl)` on each entry if you need that.
 *
 * Ordered by DevToolsActivePort mtime descending, so the most-recently-
 * launched browser is first — that's the one `connect()` picks by default.
 *
 * This is the ONLY reliable connect method for Chrome 144+ with remote
 * debugging toggled from chrome://inspect — those browsers do NOT serve
 * `/json/version`, so port-probe discovery fails.
 */
export async function detectBrowsers(): Promise<DetectedBrowser[]> {
  const candidates = getBrowserCandidates();
  const detected: DetectedBrowser[] = [];
  for (const { name, profileDir } of candidates) {
    const parsed = await tryReadDevToolsActivePort(profileDir);
    if (!parsed) continue;
    detected.push({
      name,
      profileDir,
      port: parsed.port,
      wsPath: parsed.path,
      wsUrl: `ws://127.0.0.1:${parsed.port}${parsed.path}`,
      mtimeMs: parsed.mtimeMs,
    });
  }
  detected.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return detected;
}

type BrowserCandidate = { name: string; profileDir: string };

/** OS-specific user-data dirs for Chromium-based browsers, in rough popularity order. */
function getBrowserCandidates(): BrowserCandidate[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const list: BrowserCandidate[] = [];
  const push = (name: string, profileDir: string) => list.push({ name, profileDir });

  if (process.platform === 'darwin') {
    const base = `${home}/Library/Application Support`;
    push('Google Chrome',          `${base}/Google/Chrome`);
    push('Chromium',               `${base}/Chromium`);
    push('Microsoft Edge',         `${base}/Microsoft Edge`);
    push('Brave',                  `${base}/BraveSoftware/Brave-Browser`);
    push('Arc',                    `${base}/Arc/User Data`);
    push('Vivaldi',                `${base}/Vivaldi`);
    push('Opera',                  `${base}/com.operasoftware.Opera`);
    push('Comet',                  `${base}/Comet`);
    push('Google Chrome Canary',   `${base}/Google/Chrome Canary`);
  } else if (process.platform === 'linux') {
    const cfg = `${home}/.config`;
    push('Google Chrome',          `${cfg}/google-chrome`);
    push('Chromium',               `${cfg}/chromium`);
    push('Microsoft Edge',         `${cfg}/microsoft-edge`);
    push('Brave',                  `${cfg}/BraveSoftware/Brave-Browser`);
    push('Vivaldi',                `${cfg}/vivaldi`);
    push('Opera',                  `${cfg}/opera`);
    push('Google Chrome Canary',   `${cfg}/google-chrome-unstable`);
  } else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? `${home}\\AppData\\Local`;
    push('Google Chrome',          `${local}\\Google\\Chrome\\User Data`);
    push('Chromium',               `${local}\\Chromium\\User Data`);
    push('Microsoft Edge',         `${local}\\Microsoft\\Edge\\User Data`);
    push('Brave',                  `${local}\\BraveSoftware\\Brave-Browser\\User Data`);
    push('Arc',                    `${local}\\Arc\\User Data`);
    push('Vivaldi',                `${local}\\Vivaldi\\User Data`);
    push('Opera',                  `${local}\\Opera Software\\Opera Stable`);
    push('Google Chrome Canary',   `${local}\\Google\\Chrome SxS\\User Data`);
  }
  return list;
}

/**
 * Read and parse `<profileDir>/DevToolsActivePort` once (no polling), returning
 * undefined if the file is missing or malformed. Also returns mtime so callers
 * can sort by recency.
 */
async function tryReadDevToolsActivePort(
  profileDir: string,
): Promise<{ port: number; path: string; mtimeMs: number } | undefined> {
  try {
    const file = Bun.file(`${profileDir}/DevToolsActivePort`);
    const [text, mtimeMs] = await Promise.all([file.text(), file.lastModified]);
    const [portStr, path] = text.trim().split('\n');
    const port = Number(portStr);
    if (!Number.isFinite(port)) return undefined;
    if (!path || !path.startsWith('/devtools/')) return undefined;
    return { port, path, mtimeMs: mtimeMs as number };
  } catch {
    return undefined;
  }
}
