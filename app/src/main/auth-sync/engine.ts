import { EventEmitter } from 'node:events';
import WebSocket, { type RawData } from 'ws';

export interface AuthSyncLogger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
}

interface PendingCommand {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

interface CdpEvent {
  method: string;
  params?: { targetInfo?: TargetInfo; targetId?: string };
}

export interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  browserContextId?: string;
}

export function destinationBrowserContextIds(targetInfos: TargetInfo[]): Array<string | null> {
  const contextIds = new Set<string | null>();
  for (const target of targetInfos) {
    if (target.type === 'page') contextIds.add(target.browserContextId ?? null);
  }
  return contextIds.size > 0 ? Array.from(contextIds) : [null];
}

function isDestinationPage(target: TargetInfo): boolean {
  return target.type === 'page'
    && (target.url === 'about:blank' || target.url.startsWith('http://') || target.url.startsWith('https://'));
}

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'None' | 'Lax' | 'Strict';
  expires?: number;
  partitionKey?: Record<string, unknown>;
}

interface StoragePayload {
  origin?: unknown;
  localStorage?: unknown;
  sessionStorage?: unknown;
}

interface StorageRecord {
  localStorage: Record<string, string | null>;
  sessionStorage: Record<string, string | null>;
}

export interface AuthSyncResult {
  completedAt: string;
  reason: string;
  sourceReceivedAt: string | null;
  cookies: {
    source: number;
    set: number;
    failed: number;
    deleted: number;
  };
  storage: AuthSyncStorageCounts;
  spaces: AuthSyncSpaceCounts;
  error: string | null;
}

export interface AuthSyncStorageCounts {
  origins: number;
  localItems: number;
  sessionItems: number;
}

export interface AuthSyncSpaceCounts {
  discovered: number;
  applied: number;
  skipped: number;
  failed: number;
  verified: number;
}

export interface AuthSyncSourceMetadata {
  sourceId: string;
  epoch: string;
  revision: number;
}

export type AuthSyncSourceAdmissionStatus =
  | 'accepted'
  | 'legacy'
  | 'duplicate'
  | 'stale_revision'
  | 'retired_epoch'
  | 'source_conflict'
  | 'legacy_blocked'
  | 'invalid_metadata';

export interface AuthSyncSourceAdmission {
  accepted: boolean;
  ignored: boolean;
  status: AuthSyncSourceAdmissionStatus;
  sourceId: string | null;
  epoch: string | null;
  revision: number | null;
  activeSourceId: string | null;
  lastRevision: number | null;
  leaseExpiresAt: string | null;
}

export interface AuthSyncSourceStatus {
  identified: boolean;
  sourceId: string | null;
  epoch: string | null;
  revision: number | null;
  leaseExpiresAt: string | null;
  leaseActive: boolean;
}

interface AuthSyncSourceCursor {
  currentEpoch: string;
  lastRevision: number;
  retiredEpochs: Set<string>;
}

type ParsedAuthSyncSource =
  | { kind: 'identified'; metadata: AuthSyncSourceMetadata }
  | { kind: 'legacy' }
  | { kind: 'invalid' };

function parseAuthSyncSource(payload: unknown): ParsedAuthSyncSource {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { kind: 'legacy' };
  const record = payload as Record<string, unknown>;
  const supplied = [record.sourceId, record.epoch, record.revision].filter((value) => value !== undefined).length;
  if (supplied === 0) return { kind: 'legacy' };
  if (
    supplied !== 3
    || typeof record.sourceId !== 'string'
    || record.sourceId.trim().length === 0
    || record.sourceId.length > 256
    || typeof record.epoch !== 'string'
    || record.epoch.trim().length === 0
    || record.epoch.length > 256
    || typeof record.revision !== 'number'
    || !Number.isSafeInteger(record.revision)
    || record.revision < 0
  ) {
    return { kind: 'invalid' };
  }
  return {
    kind: 'identified',
    metadata: {
      sourceId: record.sourceId,
      epoch: record.epoch,
      revision: record.revision,
    },
  };
}

/**
 * Serial, in-memory admission gate for extension writes. The first identified
 * Chrome Profile owns a renewable lease. Revisions are global to a worker
 * epoch, and retired epochs remain rejected even after a newer worker starts.
 */
export class AuthSyncSourceGate {
  private activeSourceId: string | null = null;
  private leaseExpiresAtMs = 0;
  private readonly cursors = new Map<string, AuthSyncSourceCursor>();

  constructor(
    private readonly leaseMs = 120_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('Auth sync source lease must be positive');
  }

  get status(): AuthSyncSourceStatus {
    const cursor = this.activeSourceId ? this.cursors.get(this.activeSourceId) : undefined;
    return {
      identified: this.activeSourceId !== null,
      sourceId: this.activeSourceId,
      epoch: cursor?.currentEpoch ?? null,
      revision: cursor?.lastRevision ?? null,
      leaseExpiresAt: this.activeSourceId ? new Date(this.leaseExpiresAtMs).toISOString() : null,
      leaseActive: this.activeSourceId !== null && this.now() < this.leaseExpiresAtMs,
    };
  }

  admit(payload: unknown): AuthSyncSourceAdmission {
    const parsed = parseAuthSyncSource(payload);
    if (parsed.kind === 'invalid') return this.result(false, true, 'invalid_metadata', null);
    if (parsed.kind === 'legacy') {
      return this.activeSourceId
        ? this.result(false, true, 'legacy_blocked', null)
        : this.result(true, false, 'legacy', null);
    }

    const metadata = parsed.metadata;
    const now = this.now();
    if (
      this.activeSourceId
      && this.activeSourceId !== metadata.sourceId
      && now < this.leaseExpiresAtMs
    ) {
      return this.result(false, true, 'source_conflict', metadata);
    }

    const cursor = this.cursors.get(metadata.sourceId);
    if (cursor?.retiredEpochs.has(metadata.epoch)) {
      return this.result(false, true, 'retired_epoch', metadata, cursor.lastRevision);
    }
    if (cursor?.currentEpoch === metadata.epoch) {
      if (metadata.revision === cursor.lastRevision) {
        return this.result(false, true, 'duplicate', metadata, cursor.lastRevision);
      }
      if (metadata.revision < cursor.lastRevision) {
        return this.result(false, true, 'stale_revision', metadata, cursor.lastRevision);
      }
    }

    if (cursor && cursor.currentEpoch !== metadata.epoch) {
      cursor.retiredEpochs.add(cursor.currentEpoch);
      cursor.currentEpoch = metadata.epoch;
      cursor.lastRevision = metadata.revision;
    } else if (cursor) {
      cursor.lastRevision = metadata.revision;
    } else {
      this.cursors.set(metadata.sourceId, {
        currentEpoch: metadata.epoch,
        lastRevision: metadata.revision,
        retiredEpochs: new Set(),
      });
    }
    this.activeSourceId = metadata.sourceId;
    this.leaseExpiresAtMs = now + this.leaseMs;
    return this.result(true, false, 'accepted', metadata, metadata.revision);
  }

  private result(
    accepted: boolean,
    ignored: boolean,
    status: AuthSyncSourceAdmissionStatus,
    metadata: AuthSyncSourceMetadata | null,
    lastRevision: number | null = null,
  ): AuthSyncSourceAdmission {
    return {
      accepted,
      ignored,
      status,
      sourceId: metadata?.sourceId ?? null,
      epoch: metadata?.epoch ?? null,
      revision: metadata?.revision ?? null,
      activeSourceId: this.activeSourceId,
      lastRevision,
      leaseExpiresAt: this.activeSourceId ? new Date(this.leaseExpiresAtMs).toISOString() : null,
    };
  }
}

type TargetCommandResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'skipped'; error: Error }
  | { status: 'failed'; error: Error };

interface CookieApplyOutcome {
  set: number;
  failed: number;
  spaces: AuthSyncSpaceCounts;
  error: string | null;
}

const EMPTY_SPACE_COUNTS: AuthSyncSpaceCounts = {
  discovered: 0,
  applied: 0,
  skipped: 0,
  failed: 0,
  verified: 0,
};

const DEFAULT_BROWSER_CONTEXT_KEY = '__default_browser_context__';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTargetLifecycleError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes('session with given id not found')
    || message.includes('no target with given id')
    || message.includes('target closed')
    || message.includes('target was closed')
    || message.includes('inspected target navigated or closed')
    || message.includes('cannot find context with specified id')
    || message.includes('failed to find browser context')
    || message.includes('desktop cdp timeout')
    || message.includes('desktop cdp disconnected');
}

function isRetryableStaleSessionError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes('session with given id not found')
    || message.includes('no target with given id')
    || message.includes('cannot find context with specified id');
}

function isCookieValidationError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes('invalid cookie')
    || message.includes('invalid parameters')
    || message.includes('invalid argument');
}

function normalizeDomain(domain: unknown): string {
  return String(domain ?? '').trim().replace(/^\./, '').toLowerCase();
}

function cookieIdentityDomain(domain: unknown): string {
  return String(domain ?? '').trim().toLowerCase();
}

function destinationContextKey(target: TargetInfo): string {
  return target.browserContextId ?? DEFAULT_BROWSER_CONTEXT_KEY;
}

function targetOrigin(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

function stringMap(value: unknown): Record<string, string | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' || item === null) result[key] = item;
  }
  return result;
}

function extensionCookieToCdp(value: unknown): CdpCookie | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cookie = value as Record<string, unknown>;
  if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string' || typeof cookie.domain !== 'string') {
    return null;
  }
  const domain = cookie.domain.trim();
  if (!domain || !normalizeDomain(domain)) return null;
  const result: CdpCookie = {
    name: cookie.name,
    value: cookie.value,
    domain,
    path: typeof cookie.path === 'string' && cookie.path ? cookie.path : '/',
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
  };
  const sameSite = {
    no_restriction: 'None',
    lax: 'Lax',
    strict: 'Strict',
  }[typeof cookie.sameSite === 'string' ? cookie.sameSite : ''] as CdpCookie['sameSite'];
  if (sameSite) result.sameSite = sameSite;
  if (typeof cookie.expirationDate === 'number' && Number.isFinite(cookie.expirationDate)) {
    result.expires = cookie.expirationDate;
  }
  if (cookie.partitionKey && typeof cookie.partitionKey === 'object' && !Array.isArray(cookie.partitionKey)) {
    result.partitionKey = cookie.partitionKey as Record<string, unknown>;
  }
  return result;
}

function cookieKey(cookie: CdpCookie): string {
  const partition = cookiePartitionKey(cookie.partitionKey);
  return `${cookieIdentityDomain(cookie.domain)}\u0000${cookie.path}\u0000${cookie.name}\u0000${partition}`;
}

function cookiePartitionKey(partitionKey: Record<string, unknown> | undefined): string {
  if (!partitionKey) return '';
  return JSON.stringify([
    partitionKey.topLevelSite ?? '',
    partitionKey.hasCrossSiteAncestor ?? null,
  ]);
}

function cookieFingerprint(cookie: CdpCookie): string {
  return JSON.stringify(cookie);
}

function buildStorageBootstrap(snapshot: Record<string, StorageRecord>): string {
  const safeSnapshot = JSON.stringify(snapshot).replaceAll('<', '\\u003c');
  return `(() => {
    const all = ${safeSnapshot};
    const data = all[location.origin];
    if (!data) return null;
    const readback = { localStorage: {}, sessionStorage: {} };
    try {
      localStorage.clear();
      if (data.localStorage) for (const [key, value] of Object.entries(data.localStorage)) {
        if (value !== null) localStorage.setItem(key, value);
      }
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key !== null) readback.localStorage[key] = localStorage.getItem(key);
      }
    } catch {}
    try {
      sessionStorage.clear();
      if (data.sessionStorage) for (const [key, value] of Object.entries(data.sessionStorage)) {
        if (value !== null) sessionStorage.setItem(key, value);
      }
      for (let index = 0; index < sessionStorage.length; index += 1) {
        const key = sessionStorage.key(index);
        if (key !== null) readback.sessionStorage[key] = sessionStorage.getItem(key);
      }
    } catch {}
    return readback;
  })();`;
}

function storageReadbackMatches(value: unknown, expected: StorageRecord): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const readback = value as Partial<StorageRecord>;
  const matches = (actual: unknown, wanted: Record<string, string | null>): boolean => {
    const expected = Object.fromEntries(Object.entries(wanted).filter(([, item]) => item !== null));
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return Object.keys(expected).length === 0;
    const record = actual as Record<string, unknown>;
    return Object.keys(record).length === Object.keys(expected).length
      && Object.entries(expected).every(([key, item]) => record[key] === item);
  };
  return matches(readback.localStorage, expected.localStorage)
    && matches(readback.sessionStorage, expected.sessionStorage);
}

function cookieReadbackKey(cookie: Pick<CdpCookie, 'name' | 'domain' | 'path' | 'partitionKey'>): string {
  return `${cookieIdentityDomain(cookie.domain)}\u0000${cookie.path}\u0000${cookie.name}\u0000${cookiePartitionKey(cookie.partitionKey)}`;
}

class CdpConnection extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private socket: WebSocket | null = null;

  constructor(private readonly url: string) {
    super();
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timeout);
        socket.off('open', onOpen);
        socket.off('error', onError);
      };
      const onOpen = (): void => { cleanup(); resolve(); };
      const onError = (): void => { cleanup(); reject(new Error('Desktop CDP connection failed')); };
      const timeout = setTimeout(() => {
        cleanup();
        socket.once('error', () => undefined);
        socket.terminate();
        reject(new Error('Desktop CDP WebSocket timed out after 5000ms'));
      }, 5_000);
      socket.on('open', onOpen);
      socket.on('error', onError);
    });
    socket.on('message', (raw) => this.onMessage(raw));
    socket.on('error', () => socket.close());
    socket.on('close', () => this.onClose());
  }

  async send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 10_000,
  ): Promise<T> {
    if (!this.connected || !this.socket) throw new Error('Desktop CDP is not connected');
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Desktop CDP timeout: ${method}`));
        // A timed-out browser-level CDP socket is no longer a trustworthy
        // ordering boundary. Reconnect instead of piling more commands onto it.
        this.socket?.close();
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        method,
      });
      try {
        this.socket?.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    this.socket?.close();
  }

  private onMessage(raw: RawData): void {
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      const error = message.error as { message?: unknown } | undefined;
      if (error) pending.reject(new Error(`${pending.method}: ${String(error.message ?? 'CDP error')}`));
      else pending.resolve((message.result as Record<string, unknown> | undefined) ?? {});
      return;
    }
    if (typeof message.method === 'string') this.emit('event', message as unknown as CdpEvent);
  }

  private onClose(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Desktop CDP disconnected'));
    }
    this.pending.clear();
    this.emit('disconnect');
  }
}

async function discoverWebSocket(discoveryUrl: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(discoveryUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`Desktop CDP discovery failed: HTTP ${response.status}`);
    const body = await response.json() as { webSocketDebuggerUrl?: unknown };
    if (typeof body.webSocketDebuggerUrl !== 'string') {
      throw new Error('Desktop CDP discovery did not return a WebSocket URL');
    }
    return body.webSocketDebuggerUrl;
  } catch (error) {
    if ((error as { name?: unknown }).name === 'AbortError') {
      throw new Error('Desktop CDP discovery timed out after 5000ms', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function attachToTarget(connection: CdpConnection, targetId: string): Promise<string> {
  const result = await connection.send<{ sessionId?: unknown }>('Target.attachToTarget', { targetId, flatten: true });
  if (typeof result.sessionId !== 'string') throw new Error('Desktop CDP did not return a target session');
  return result.sessionId;
}

export class AuthSyncEngine {
  private destination: CdpConnection | null = null;
  private readonly destinationSessions = new Map<string, string>();
  private readonly destinationSessionPromises = new Map<string, Promise<string>>();
  private readonly targetGenerations = new Map<string, number>();
  private readonly injectedScripts = new Map<string, { identifier?: string; generation: number; appliedOrigin?: string }>();
  private readonly seededBrowserContexts = new Set<string>();
  private readonly pendingDeletions = new Map<string, CdpCookie>();
  private cookies: CdpCookie[] = [];
  private readonly storageSnapshot: Record<string, StorageRecord> = {};
  private storageGeneration = 0;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private eventReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcilePromise: Promise<void> | null = null;
  private reconcileRequested = false;
  private connectPromise: Promise<void> | null = null;
  private lifecycleGeneration = 0;
  private disconnectPromise: Promise<string> = Promise.resolve('not connected');
  private operation: Promise<unknown> = Promise.resolve();
  private closing = false;
  private cookieSpaceCounts: AuthSyncSpaceCounts = { ...EMPTY_SPACE_COUNTS };
  private storageSpaceCounts: AuthSyncSpaceCounts = { ...EMPTY_SPACE_COUNTS };
  private cookieApplyErrorValue: string | null = null;
  private storageApplyErrorValue: string | null = null;
  private latestSpaceCounts: AuthSyncSpaceCounts = { ...EMPTY_SPACE_COUNTS };
  private lastSuccessfulApplyAtValue: string | null = null;
  private lastApplyErrorValue: string | null = null;

  sourceReceivedAt: string | null = null;
  lastResult: AuthSyncResult | null = null;

  constructor(
    private readonly discoveryUrl: string,
    private readonly logger: AuthSyncLogger,
  ) {}

  get destinationConnected(): boolean {
    return this.destination?.connected === true;
  }

  get hasSourceSnapshot(): boolean {
    return this.sourceReceivedAt !== null;
  }

  get sourceCookieCount(): number {
    return this.cookies.length;
  }

  get storageCounts(): AuthSyncStorageCounts {
    return {
      origins: Object.keys(this.storageSnapshot).length,
      localItems: Object.values(this.storageSnapshot).reduce((sum, item) => sum + Object.keys(item.localStorage).length, 0),
      sessionItems: Object.values(this.storageSnapshot).reduce((sum, item) => sum + Object.keys(item.sessionStorage).length, 0),
    };
  }

  get syncState(): 'running' | 'degraded' | 'waiting' {
    if (!this.destinationConnected || !this.hasSourceSnapshot || this.latestSpaceCounts.discovered === 0) return 'waiting';
    if (this.lastApplyErrorValue) return 'degraded';
    return this.lastSuccessfulApplyAtValue ? 'running' : 'waiting';
  }

  get lastSuccessfulApplyAt(): string | null {
    return this.lastSuccessfulApplyAtValue;
  }

  get lastApplyError(): string | null {
    return this.lastApplyErrorValue;
  }

  get reconcileBacklog(): number {
    return Number(this.reconcileRequested) + Number(this.reconcilePromise !== null);
  }

  get spaceCounts(): AuthSyncSpaceCounts {
    return { ...this.latestSpaceCounts };
  }

  async connect(): Promise<void> {
    if (this.destinationConnected) return;
    if (this.closing) throw new Error('Auth sync engine is closed');
    if (this.connectPromise) return await this.connectPromise;
    const generation = this.lifecycleGeneration;
    const connecting = this.connectOnce(generation);
    this.connectPromise = connecting;
    try {
      await connecting;
    } finally {
      if (this.connectPromise === connecting) this.connectPromise = null;
    }
  }

  private async connectOnce(generation: number): Promise<void> {
    const connection = new CdpConnection(await discoverWebSocket(this.discoveryUrl));
    await connection.connect();
    if (this.closing || generation !== this.lifecycleGeneration) {
      connection.close();
      throw new Error('Auth sync connection was cancelled');
    }
    this.destination = connection;
    this.disconnectPromise = new Promise((resolve) => {
      connection.once('disconnect', () => {
        if (this.destination === connection) this.destination = null;
        resolve('Desktop CDP disconnected');
      });
    });
    await connection.send('Target.setDiscoverTargets', { discover: true });
    connection.on('event', (event: CdpEvent) => this.onDestinationEvent(connection, event));
    this.reconcileTimer = setInterval(() => {
      if (this.closing || this.destination !== connection) return;
      void this.requestReconcile().catch((error: Error) => this.logReconcileFailure(error));
    }, 5_000);
    await this.requestReconcile();
  }

  async waitForDisconnect(): Promise<string> {
    return await this.disconnectPromise;
  }

  async acceptSnapshot(payload: unknown): Promise<AuthSyncResult> {
    return await this.exclusive(async () => {
      const rawCookies = payload && typeof payload === 'object' && Array.isArray((payload as { cookies?: unknown }).cookies)
        ? (payload as { cookies: unknown[] }).cookies
        : [];
      const convertedCookies = rawCookies.map(extensionCookieToCdp).filter((cookie): cookie is CdpCookie => cookie !== null);
      const nextByKey = new Map(convertedCookies.map((cookie) => [cookieKey(cookie), cookie]));
      const nextCookies = Array.from(nextByKey.values());
      const previousByKey = new Map(this.cookies.map((cookie) => [cookieKey(cookie), cookie]));
      const changed = nextCookies.filter((cookie) => {
        const previous = previousByKey.get(cookieKey(cookie));
        return !previous || cookieFingerprint(previous) !== cookieFingerprint(cookie);
      });
      const removed = this.cookies.filter((cookie) => !nextByKey.has(cookieKey(cookie)));
      for (const cookie of changed) this.pendingDeletions.delete(cookieKey(cookie));
      for (const cookie of removed) this.pendingDeletions.set(cookieKey(cookie), cookie);
      this.cookies = nextCookies;
      this.sourceReceivedAt = new Date().toISOString();
      if (!this.destinationConnected) return this.recordResult('extension-snapshot-buffered', 0, 0, 0);
      if (this.lastApplyErrorValue || !this.lastSuccessfulApplyAtValue || this.seededBrowserContexts.size === 0) {
        return await this.applyAll('extension-snapshot');
      }
      return await this.applySnapshotDiff(changed, Array.from(this.pendingDeletions.values()));
    });
  }

  async acceptCookieChange(payload: unknown): Promise<AuthSyncResult | null> {
    return await this.exclusive(async () => {
      if (!payload || typeof payload !== 'object') return this.lastResult;
      const change = payload as { cookie?: unknown; removed?: unknown };
      const converted = extensionCookieToCdp(change.cookie);
      if (!converted) return this.lastResult;
      this.sourceReceivedAt = new Date().toISOString();
      const key = cookieKey(converted);
      const existingIndex = this.cookies.findIndex((candidate) => cookieKey(candidate) === key);
      if (change.removed === true) {
        if (existingIndex >= 0) this.cookies.splice(existingIndex, 1);
      } else if (existingIndex >= 0) {
        this.cookies[existingIndex] = converted;
      } else {
        this.cookies.push(converted);
      }
      if (change.removed === true) this.pendingDeletions.set(key, converted);
      else this.pendingDeletions.delete(key);
      if (!this.destinationConnected) return this.recordResult('cookie-change-buffered', 0, 0, 0);
      const connection = this.destination;
      if (!connection) return this.recordResult('cookie-change-buffered', 0, 0, 0);
      let pages: TargetInfo[];
      try {
        pages = await this.getLiveDestinationPages(connection);
      } catch (error) {
        return this.recordApplyFailure('cookie-change', error);
      }
      const representatives = this.destinationRepresentatives(pages);
      let deleted = 0;
      let set = 0;
      let failed = 0;
      const spaces: AuthSyncSpaceCounts = {
        discovered: representatives.size,
        applied: 0,
        skipped: 0,
        failed: 0,
        verified: 0,
      };
      let allApplied = representatives.size > 0;
      for (const [contextKey, target] of representatives) {
        let counted = false;
        if (!this.seededBrowserContexts.has(contextKey)) {
          const seeded = await this.seedCookiesIntoTarget(connection, target, this.cookies, true, true);
          this.accumulateTargetOutcome(spaces, seeded);
          counted = true;
          if (this.isVerifiedCookieOutcome(seeded)) {
            this.seededBrowserContexts.add(contextKey);
          } else {
            allApplied = false;
            failed = 1;
            continue;
          }
          if (change.removed !== true) {
            set = 1;
            continue;
          }
        }
        let outcome: TargetCommandResult<unknown>;
        let applied: boolean;
        if (change.removed === true) {
          const deletion = await this.deleteCookieFromTarget(connection, target, converted, this.cookies);
          outcome = deletion;
          applied = deletion.status === 'ok' && deletion.value.verified;
        } else {
          const setting = await this.seedCookiesIntoTarget(connection, target, [converted], true, false, this.cookies);
          outcome = setting;
          applied = this.isVerifiedCookieOutcome(setting);
        }
        if (!counted) this.accumulateTargetOutcome(spaces, outcome);
        if (applied) {
          if (change.removed === true) deleted = 1;
          else set = 1;
        } else {
          allApplied = false;
          failed = 1;
          this.seededBrowserContexts.delete(contextKey);
          if (counted) {
            spaces.applied = Math.max(0, spaces.applied - 1);
            spaces.verified = Math.max(0, spaces.verified - 1);
            if (outcome.status === 'skipped') spaces.skipped += 1;
            else spaces.failed += 1;
          }
        }
      }
      if (change.removed === true && allApplied) this.pendingDeletions.delete(key);
      this.finishCookieHealth(spaces);
      return this.recordResult('cookie-change', set, failed, deleted, this.latestSpaceCounts);
    });
  }

  async acceptStorage(payload: StoragePayload): Promise<AuthSyncResult> {
    return await this.exclusive(async () => {
      const origin = targetOrigin(payload.origin);
      if (!origin) throw new Error('Storage origin must be an HTTP(S) origin');
      this.storageSnapshot[origin] = {
        localStorage: stringMap(payload.localStorage),
        sessionStorage: stringMap(payload.sessionStorage),
      };
      this.storageGeneration += 1;
      this.sourceReceivedAt = new Date().toISOString();
      const connection = this.destination;
      if (!connection || !this.destinationConnected) return this.recordResult('storage-update-buffered', 0, 0, 0);
      try {
        const pages = await this.getLiveDestinationPages(connection);
        const spaces = await this.applyStorageToPages(connection, pages);
        this.finishStorageHealth(spaces);
        return this.recordResult('storage-update', 0, 0, 0, this.latestSpaceCounts);
      } catch (error) {
        return this.recordApplyFailure('storage-update', error);
      }
    });
  }

  async syncNow(): Promise<AuthSyncResult> {
    return await this.exclusive(async () => await this.applyAll('manual-sync'));
  }

  private async applyAll(reason: string): Promise<AuthSyncResult> {
    const connection = this.destination;
    if (!this.destinationConnected || !connection) throw new Error('Browser Use Desktop is not connected');
    try {
      const pages = await this.getLiveDestinationPages(connection);
      const cookieOutcome = await this.applyCookiesToRepresentatives(connection, pages, this.cookies, true);
      const deleted = await this.applyPendingDeletions(connection, pages, cookieOutcome.spaces);
      const storageSpaces = await this.applyStorageToPages(connection, pages);
      const spaces = this.mergeSpaceCounts(cookieOutcome.spaces, storageSpaces);
      this.finishCookieHealth(cookieOutcome.spaces, cookieOutcome.error);
      this.finishStorageHealth(storageSpaces);
      return this.recordResult(reason, cookieOutcome.set, cookieOutcome.failed, deleted, spaces);
    } catch (error) {
      return this.recordApplyFailure(reason, error);
    }
  }

  private async applySnapshotDiff(changed: CdpCookie[], removed: CdpCookie[]): Promise<AuthSyncResult> {
    const connection = this.destination;
    if (!connection) return this.recordResult('extension-snapshot-buffered', 0, 0, 0);
    try {
      const pages = await this.getLiveDestinationPages(connection);
      const representatives = this.destinationRepresentatives(pages);
      const spaces: AuthSyncSpaceCounts = {
        discovered: representatives.size,
        applied: 0,
        skipped: 0,
        failed: 0,
        verified: 0,
      };
      let set = 0;
      let failed = 0;
      let deleted = 0;
      let firstError: string | null = null;
      let allDeletionsApplied = representatives.size > 0;
      for (const [contextKey, target] of representatives) {
        let seededNow = false;
        if (!this.seededBrowserContexts.has(contextKey)) {
          const seeded = await this.seedCookiesIntoTarget(connection, target, this.cookies, true, true);
          this.accumulateTargetOutcome(spaces, seeded);
          if (!this.isVerifiedCookieOutcome(seeded)) {
            firstError ??= seeded.status === 'ok'
              ? seeded.value.verificationError ?? 'Cookie apply incomplete'
              : seeded.error.message;
            allDeletionsApplied = false;
            continue;
          }
          this.seededBrowserContexts.add(contextKey);
          seededNow = true;
          set = Math.max(set, this.cookies.length);
        }
        if (!seededNow) {
          const changedOutcome = await this.seedCookiesIntoTarget(connection, target, changed, true, false, this.cookies);
          this.accumulateTargetOutcome(spaces, changedOutcome);
          if (this.isVerifiedCookieOutcome(changedOutcome)) {
            set = Math.max(set, changed.length);
          } else {
            firstError ??= changedOutcome.status === 'ok'
              ? changedOutcome.value.verificationError ?? 'Cookie apply incomplete'
              : changedOutcome.error.message;
            failed = Math.max(failed, changedOutcome.status === 'ok' ? changedOutcome.value.failed : changed.length);
            this.seededBrowserContexts.delete(contextKey);
            allDeletionsApplied = false;
            continue;
          }
        }
        for (const cookie of removed) {
          const outcome = await this.deleteCookieFromTarget(connection, target, cookie, this.cookies);
          if (outcome.status === 'ok' && outcome.value.verified) {
            deleted = Math.max(deleted, removed.length);
            continue;
          }
          allDeletionsApplied = false;
          firstError ??= outcome.status === 'ok' ? 'Cookie deletion readback mismatch' : outcome.error.message;
          failed += 1;
          if (outcome.status !== 'ok') {
            this.seededBrowserContexts.delete(contextKey);
            spaces.applied = Math.max(0, spaces.applied - 1);
            if (outcome.status === 'skipped') spaces.skipped += 1;
            else spaces.failed += 1;
          } else {
            this.seededBrowserContexts.delete(contextKey);
            spaces.applied = Math.max(0, spaces.applied - 1);
            spaces.failed += 1;
          }
          break;
        }
      }
      if (allDeletionsApplied) {
        for (const cookie of removed) this.pendingDeletions.delete(cookieKey(cookie));
      }
      const storageSpaces = await this.applyStorageToPages(connection, pages);
      const merged = this.mergeSpaceCounts(spaces, storageSpaces);
      this.finishCookieHealth(spaces, firstError);
      this.finishStorageHealth(storageSpaces);
      return this.recordResult('extension-snapshot-diff', set, failed, deleted, merged);
    } catch (error) {
      return this.recordApplyFailure('extension-snapshot-diff', error);
    }
  }

  private async ensureDestinationSession(connection: CdpConnection, targetInfo: TargetInfo): Promise<string> {
    const existing = this.destinationSessions.get(targetInfo.targetId);
    if (existing) return existing;
    const pending = this.destinationSessionPromises.get(targetInfo.targetId);
    if (pending) return await pending;
    const generation = this.targetGenerations.get(targetInfo.targetId) ?? 0;
    const attaching = (async () => {
      const sessionId = await attachToTarget(connection, targetInfo.targetId);
      if (connection !== this.destination || generation !== (this.targetGenerations.get(targetInfo.targetId) ?? 0)) {
        throw new Error('No target with given id');
      }
      this.destinationSessions.set(targetInfo.targetId, sessionId);
      return sessionId;
    })();
    this.destinationSessionPromises.set(targetInfo.targetId, attaching);
    try {
      return await attaching;
    } finally {
      if (this.destinationSessionPromises.get(targetInfo.targetId) === attaching) {
        this.destinationSessionPromises.delete(targetInfo.targetId);
      }
    }
  }

  private destinationRepresentatives(pages: TargetInfo[]): Map<string, TargetInfo> {
    const representatives = new Map<string, TargetInfo>();
    for (const page of pages) representatives.set(destinationContextKey(page), page);
    return representatives;
  }

  private async getLiveDestinationPages(connection: CdpConnection): Promise<TargetInfo[]> {
    const targets = await connection.send<{ targetInfos?: TargetInfo[] }>('Target.getTargets');
    const pages = (targets.targetInfos ?? []).filter(isDestinationPage);
    const liveTargetIds = new Set(pages.map((page) => page.targetId));
    const liveContextIds = new Set(pages.map(destinationContextKey));
    for (const targetId of this.destinationSessions.keys()) {
      if (!liveTargetIds.has(targetId)) this.invalidateDestinationTarget(targetId);
    }
    for (const contextId of this.seededBrowserContexts) {
      if (!liveContextIds.has(contextId)) this.seededBrowserContexts.delete(contextId);
    }
    return pages;
  }

  private invalidateDestinationTarget(targetId: string): void {
    this.targetGenerations.set(targetId, (this.targetGenerations.get(targetId) ?? 0) + 1);
    this.destinationSessions.delete(targetId);
    this.destinationSessionPromises.delete(targetId);
    this.injectedScripts.delete(targetId);
  }

  private async runTargetCommand<T>(
    connection: CdpConnection,
    target: TargetInfo,
    method: string,
    task: (sessionId: string) => Promise<T>,
  ): Promise<TargetCommandResult<T>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (connection !== this.destination || !connection.connected) {
        return { status: 'skipped', error: new Error('Desktop CDP disconnected') };
      }
      try {
        const sessionId = await this.ensureDestinationSession(connection, target);
        const value = await task(sessionId);
        if (connection !== this.destination || this.destinationSessions.get(target.targetId) !== sessionId) {
          throw new Error('Session with given id not found');
        }
        return { status: 'ok', value };
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (!isTargetLifecycleError(normalized)) return { status: 'failed', error: normalized };
        this.invalidateDestinationTarget(target.targetId);
        if (attempt === 0 && isRetryableStaleSessionError(normalized)) continue;
        this.reconcileRequested = true;
        return { status: 'skipped', error: normalized };
      }
    }
    return { status: 'skipped', error: new Error(`${method}: target disappeared`) };
  }

  private async setCookieBatchWithIsolation(
    connection: CdpConnection,
    target: TargetInfo,
    cookies: CdpCookie[],
  ): Promise<TargetCommandResult<{ failed: number }>> {
    const result = await this.runTargetCommand(connection, target, 'Network.setCookies', async (sessionId) => {
      await connection.send('Network.setCookies', { cookies }, sessionId);
    });
    if (result.status === 'ok') return { status: 'ok', value: { failed: 0 } };
    if (result.status === 'skipped') return result;
    if (!isCookieValidationError(result.error)) return result;
    if (cookies.length === 1) {
      this.logger.warn('authSync.cookie.rejected', {
        name: cookies[0]?.name ?? '',
        domain: cookies[0]?.domain ?? '',
        error: result.error.message,
      });
      return { status: 'ok', value: { failed: 1 } };
    }
    const middle = Math.ceil(cookies.length / 2);
    const left = await this.setCookieBatchWithIsolation(connection, target, cookies.slice(0, middle));
    if (left.status !== 'ok') return left;
    const right = await this.setCookieBatchWithIsolation(connection, target, cookies.slice(middle));
    if (right.status !== 'ok') return right;
    return { status: 'ok', value: { failed: left.value.failed + right.value.failed } };
  }

  private async seedCookiesIntoTarget(
    connection: CdpConnection,
    target: TargetInfo,
    cookies: CdpCookie[],
    verify = true,
    clearFirst = false,
    expectedCookies: CdpCookie[] = cookies,
  ): Promise<TargetCommandResult<{ failed: number; verified: boolean; verificationError?: string }>> {
    if (clearFirst) {
      const cleared = await this.runTargetCommand(connection, target, 'Network.clearBrowserCookies', async (sessionId) => {
        await connection.send('Network.clearBrowserCookies', {}, sessionId);
      });
      if (cleared.status !== 'ok') return cleared;
    }
    let failed = 0;
    for (let index = 0; index < cookies.length; index += 100) {
      const result = await this.setCookieBatchWithIsolation(connection, target, cookies.slice(index, index + 100));
      if (result.status !== 'ok') return result;
      failed += result.value.failed;
    }
    if (!verify) return { status: 'ok', value: { failed, verified: true } };
    const verified = await this.verifyCookiesInTarget(connection, target, expectedCookies);
    if (verified.status !== 'ok') return verified;
    return verified.value
      ? { status: 'ok', value: { failed, verified: true } }
      : { status: 'ok', value: { failed, verified: false, verificationError: 'Cookie readback mismatch' } };
  }

  private async deleteCookieFromTarget(
    connection: CdpConnection,
    target: TargetInfo,
    cookie: CdpCookie,
    expectedCookies: CdpCookie[],
  ): Promise<TargetCommandResult<{ verified: boolean }>> {
    const params: Record<string, unknown> = { name: cookie.name, domain: cookie.domain, path: cookie.path };
    if (cookie.partitionKey) params.partitionKey = cookie.partitionKey;
    return await this.runTargetCommand(connection, target, 'Network.deleteCookies', async (sessionId) => {
      await connection.send('Network.deleteCookies', params, sessionId);
      const response = await connection.send<{ cookies?: CdpCookie[] }>('Network.getAllCookies', {}, sessionId);
      const actual = new Map((response.cookies ?? []).map((candidate) => [cookieReadbackKey(candidate), candidate.value]));
      const deletedKey = cookieReadbackKey(cookie);
      const eligible = expectedCookies.filter((candidate) => candidate.expires === undefined || candidate.expires > Date.now() / 1_000);
      return {
        verified: !actual.has(deletedKey)
          && eligible.every((candidate) => actual.get(cookieReadbackKey(candidate)) === candidate.value),
      };
    });
  }

  private async verifyCookiesInTarget(
    connection: CdpConnection,
    target: TargetInfo,
    expectedCookies: CdpCookie[],
  ): Promise<TargetCommandResult<boolean>> {
    return await this.runTargetCommand(connection, target, 'Network.getAllCookies', async (sessionId) => {
      const eligible = expectedCookies.filter((cookie) => cookie.expires === undefined || cookie.expires > Date.now() / 1_000);
      const response = await connection.send<{ cookies?: CdpCookie[] }>('Network.getAllCookies', {}, sessionId);
      const actual = new Map((response.cookies ?? []).map((cookie) => [cookieReadbackKey(cookie), cookie.value]));
      return eligible.every((cookie) => actual.get(cookieReadbackKey(cookie)) === cookie.value);
    });
  }

  private async applyCookiesToRepresentatives(
    connection: CdpConnection,
    pages: TargetInfo[],
    cookies: CdpCookie[],
    markSeeded: boolean,
  ): Promise<CookieApplyOutcome> {
    const representatives = this.destinationRepresentatives(pages);
    const spaces: AuthSyncSpaceCounts = {
      discovered: representatives.size,
      applied: 0,
      skipped: 0,
      failed: 0,
      verified: 0,
    };
    let set = 0;
    let failed = 0;
    let firstError: string | null = null;
    for (const [contextKey, target] of representatives) {
      const outcome = await this.seedCookiesIntoTarget(
        connection,
        target,
        cookies,
        true,
        markSeeded && !this.seededBrowserContexts.has(contextKey),
      );
      this.accumulateTargetOutcome(spaces, outcome);
      if (outcome.status === 'ok') {
        set = Math.max(set, cookies.length - outcome.value.failed);
        failed = Math.max(failed, outcome.value.failed);
        if (markSeeded && this.isVerifiedCookieOutcome(outcome)) this.seededBrowserContexts.add(contextKey);
        else if (markSeeded) this.seededBrowserContexts.delete(contextKey);
        if (outcome.value.verificationError) firstError ??= outcome.value.verificationError;
      } else {
        if (outcome.status === 'skipped') this.seededBrowserContexts.delete(contextKey);
        firstError ??= outcome.error.message;
      }
    }
    return { set, failed, spaces, error: firstError };
  }

  private async applyPendingDeletions(
    connection: CdpConnection,
    pages: TargetInfo[],
    spaces: AuthSyncSpaceCounts,
  ): Promise<number> {
    if (this.pendingDeletions.size === 0) return 0;
    const representatives = this.destinationRepresentatives(pages);
    let allApplied = representatives.size > 0;
    for (const [contextKey, target] of representatives) {
      if (!this.seededBrowserContexts.has(contextKey)) { allApplied = false; continue; }
      for (const cookie of this.pendingDeletions.values()) {
        const outcome = await this.deleteCookieFromTarget(connection, target, cookie, this.cookies);
        if (outcome.status === 'ok' && outcome.value.verified) continue;
        allApplied = false;
        this.seededBrowserContexts.delete(contextKey);
        spaces.applied = Math.max(0, spaces.applied - 1);
        spaces.verified = Math.max(0, spaces.verified - 1);
        if (outcome.status === 'skipped') spaces.skipped += 1;
        else spaces.failed += 1;
        break;
      }
    }
    if (!allApplied) return 0;
    const deleted = this.pendingDeletions.size;
    this.pendingDeletions.clear();
    return deleted;
  }

  private async applyStorageToPages(connection: CdpConnection, pages: TargetInfo[]): Promise<AuthSyncSpaceCounts> {
    const contexts = new Map<string, { applied: boolean; skipped: boolean; failed: boolean; verified: boolean }>();
    for (const page of pages) {
      const contextKey = destinationContextKey(page);
      const state = contexts.get(contextKey) ?? { applied: true, skipped: false, failed: false, verified: true };
      const outcome = await this.prepareStorageForTarget(connection, page);
      if (outcome.status === 'skipped') { state.applied = false; state.skipped = true; state.verified = false; }
      else if (outcome.status === 'failed') { state.applied = false; state.failed = true; state.verified = false; }
      else if (!outcome.value.verified) { state.applied = false; state.failed = true; state.verified = false; }
      contexts.set(contextKey, state);
    }
    const values = Array.from(contexts.values());
    return {
      discovered: contexts.size,
      applied: values.filter((state) => state.applied).length,
      skipped: values.filter((state) => state.skipped).length,
      failed: values.filter((state) => state.failed).length,
      verified: values.filter((state) => state.verified).length,
    };
  }

  private async prepareStorageForTarget(
    connection: CdpConnection,
    target: TargetInfo,
  ): Promise<TargetCommandResult<{ verified: boolean }>> {
    const script = buildStorageBootstrap(this.storageSnapshot);
    const origin = targetOrigin(target.url);
    const previous = this.injectedScripts.get(target.targetId);
    if (previous?.generation === this.storageGeneration && previous.appliedOrigin === (origin ?? undefined)) {
      return { status: 'ok', value: { verified: true } };
    }
    if (!previous || previous.generation !== this.storageGeneration) {
      const registered = await this.runTargetCommand(connection, target, 'Page.addScriptToEvaluateOnNewDocument', async (sessionId) => {
        if (previous?.identifier) {
          await connection.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: previous.identifier }, sessionId).catch(() => undefined);
        }
        return await connection.send<{ identifier?: string }>(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: script },
          sessionId,
        );
      });
      if (registered.status !== 'ok') return registered;
      this.injectedScripts.set(target.targetId, { identifier: registered.value.identifier, generation: this.storageGeneration });
    }
    const expected = origin ? this.storageSnapshot[origin] : undefined;
    if (!expected) {
      const registered = this.injectedScripts.get(target.targetId);
      if (registered) registered.appliedOrigin = origin ?? undefined;
      return { status: 'ok', value: { verified: true } };
    }
    const evaluated = await this.runTargetCommand(connection, target, 'Runtime.evaluate', async (sessionId) => {
      return await connection.send<{ result?: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression: script, returnByValue: true },
        sessionId,
      );
    });
    if (evaluated.status !== 'ok') return evaluated;
    const verified = storageReadbackMatches(evaluated.value.result?.value, expected);
    if (verified) {
      const registered = this.injectedScripts.get(target.targetId);
      if (registered) registered.appliedOrigin = origin ?? undefined;
    }
    return { status: 'ok', value: { verified } };
  }

  private isVerifiedCookieOutcome(
    outcome: TargetCommandResult<{ failed: number; verified: boolean; verificationError?: string }>,
  ): boolean {
    return outcome.status === 'ok'
      && outcome.value.failed === 0
      && outcome.value.verified
      && !outcome.value.verificationError;
  }

  private accumulateTargetOutcome(
    spaces: AuthSyncSpaceCounts,
    outcome: TargetCommandResult<unknown>,
  ): void {
    if (outcome.status === 'skipped') { spaces.skipped += 1; return; }
    if (outcome.status === 'failed') { spaces.failed += 1; return; }
    const value = outcome.value as { failed?: unknown; verified?: unknown; verificationError?: unknown } | undefined;
    if (
      (typeof value?.failed === 'number' && value.failed > 0)
      || value?.verified === false
      || value?.verificationError
    ) spaces.failed += 1;
    else spaces.applied += 1;
    if (value?.verified === true) spaces.verified += 1;
  }

  private mergeSpaceCounts(left: AuthSyncSpaceCounts, right: AuthSyncSpaceCounts): AuthSyncSpaceCounts {
    if (left.discovered === 0) return right;
    if (right.discovered === 0) return left;
    return {
      discovered: Math.max(left.discovered, right.discovered),
      applied: Math.min(left.applied, right.applied),
      skipped: Math.max(left.skipped, right.skipped),
      failed: Math.max(left.failed, right.failed),
      verified: Math.min(left.verified, right.verified),
    };
  }

  private finishCookieHealth(spaces: AuthSyncSpaceCounts, explicitError: string | null = null): void {
    this.cookieSpaceCounts = { ...spaces };
    this.cookieApplyErrorValue = this.spaceApplyError(spaces, explicitError);
    this.refreshAggregateHealth();
  }

  private finishStorageHealth(spaces: AuthSyncSpaceCounts, explicitError: string | null = null): void {
    this.storageSpaceCounts = { ...spaces };
    this.storageApplyErrorValue = this.storageCounts.origins === 0
      ? null
      : this.spaceApplyError(spaces, explicitError);
    this.refreshAggregateHealth();
  }

  private spaceApplyError(spaces: AuthSyncSpaceCounts, explicitError: string | null): string | null {
    if (explicitError || spaces.failed > 0 || spaces.skipped > 0) {
      return explicitError ?? `Space apply incomplete: ${spaces.failed} failed, ${spaces.skipped} skipped`;
    }
    return null;
  }

  private refreshAggregateHealth(): void {
    this.latestSpaceCounts = this.storageCounts.origins > 0
      ? this.mergeSpaceCounts(this.cookieSpaceCounts, this.storageSpaceCounts)
      : { ...this.cookieSpaceCounts };
    this.lastApplyErrorValue = this.cookieApplyErrorValue ?? this.storageApplyErrorValue;
    const spaces = this.latestSpaceCounts;
    if (
      !this.lastApplyErrorValue
      && this.hasSourceSnapshot
      && spaces.discovered > 0
      && spaces.applied === spaces.discovered
      && spaces.verified === spaces.discovered
    ) {
      this.lastSuccessfulApplyAtValue = new Date().toISOString();
    }
  }

  private recordApplyFailure(reason: string, error: unknown): AuthSyncResult {
    const message = errorMessage(error);
    if (reason.includes('storage')) {
      this.storageSpaceCounts = {
        ...this.storageSpaceCounts,
        failed: Math.max(1, this.storageSpaceCounts.failed),
      };
      this.storageApplyErrorValue = message;
    } else {
      this.cookieSpaceCounts = {
        ...this.cookieSpaceCounts,
        failed: Math.max(1, this.cookieSpaceCounts.failed),
      };
      this.cookieApplyErrorValue = message;
    }
    this.refreshAggregateHealth();
    const spaces = this.latestSpaceCounts;
    this.logger.warn('authSync.apply.failed', { reason, error: this.lastApplyErrorValue });
    return this.recordResult(reason, 0, this.cookies.length, 0, spaces);
  }

  private recordResult(
    reason: string,
    set: number,
    failed: number,
    deleted: number,
    spaces: AuthSyncSpaceCounts = this.latestSpaceCounts,
  ): AuthSyncResult {
    this.lastResult = {
      completedAt: new Date().toISOString(),
      reason,
      sourceReceivedAt: this.sourceReceivedAt,
      cookies: { source: this.cookies.length, set, failed, deleted },
      storage: this.storageCounts,
      spaces: { ...spaces },
      error: this.lastApplyErrorValue,
    };
    return this.lastResult;
  }

  private async exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.operation.then(task, task);
    this.operation = run.catch(() => undefined);
    return await run;
  }

  async reconcileDestinationTargets(): Promise<void> {
    await this.requestReconcile();
  }

  private requestReconcile(): Promise<void> {
    this.reconcileRequested = true;
    if (this.reconcilePromise) return this.reconcilePromise;
    const queued = this.exclusive(async () => {
      let passes = 0;
      while (this.reconcileRequested && passes < 2) {
        this.reconcileRequested = false;
        await this.reconcileOnce();
        passes += 1;
      }
    });
    const tracked = queued.finally(() => {
      if (this.reconcilePromise === tracked) this.reconcilePromise = null;
      if (this.reconcileRequested && !this.closing && this.destinationConnected) {
        void this.requestReconcile().catch((error: Error) => this.logReconcileFailure(error));
      }
    });
    this.reconcilePromise = tracked;
    return tracked;
  }

  private async reconcileOnce(): Promise<void> {
    const connection = this.destination;
    if (!connection || !this.destinationConnected) return;
    const pages = await this.getLiveDestinationPages(connection);
    const representatives = this.destinationRepresentatives(pages);
    const cookieSpaces: AuthSyncSpaceCounts = {
      discovered: representatives.size,
      applied: 0,
      skipped: 0,
      failed: 0,
      verified: 0,
    };
    let allDeletionsApplied = representatives.size > 0;
    for (const [contextKey, target] of representatives) {
      if (!this.hasSourceSnapshot) continue;
      if (this.seededBrowserContexts.has(contextKey)) {
        cookieSpaces.applied += 1;
        cookieSpaces.verified += 1;
      } else {
        const outcome = await this.seedCookiesIntoTarget(connection, target, this.cookies, true, true);
        this.accumulateTargetOutcome(cookieSpaces, outcome);
        if (!this.isVerifiedCookieOutcome(outcome)) {
          allDeletionsApplied = false;
          continue;
        }
        this.seededBrowserContexts.add(contextKey);
      }
      for (const cookie of this.pendingDeletions.values()) {
        const deleted = await this.deleteCookieFromTarget(connection, target, cookie, this.cookies);
        if (deleted.status === 'ok' && deleted.value.verified) continue;
        allDeletionsApplied = false;
        this.seededBrowserContexts.delete(contextKey);
        cookieSpaces.applied = Math.max(0, cookieSpaces.applied - 1);
        cookieSpaces.verified = Math.max(0, cookieSpaces.verified - 1);
        if (deleted.status === 'skipped') cookieSpaces.skipped += 1;
        else cookieSpaces.failed += 1;
        break;
      }
    }
    if (allDeletionsApplied) {
      this.pendingDeletions.clear();
    }
    const storageSpaces = await this.applyStorageToPages(connection, pages);
    this.finishCookieHealth(cookieSpaces);
    this.finishStorageHealth(storageSpaces);
  }

  private onDestinationEvent(connection: CdpConnection, event: CdpEvent): void {
    if (connection !== this.destination) return;
    if (event.method === 'Target.targetDestroyed') {
      if (event.params?.targetId) this.invalidateDestinationTarget(event.params.targetId);
      this.scheduleEventReconcile();
      return;
    }
    if (!['Target.targetCreated', 'Target.targetInfoChanged'].includes(event.method)) return;
    const targetInfo = event.params?.targetInfo;
    if (!targetInfo || !isDestinationPage(targetInfo)) return;
    this.scheduleEventReconcile();
  }

  private scheduleEventReconcile(): void {
    if (this.eventReconcileTimer || this.closing) return;
    this.eventReconcileTimer = setTimeout(() => {
      this.eventReconcileTimer = null;
      void this.requestReconcile().catch((error: Error) => this.logReconcileFailure(error));
    }, 100);
  }

  private logReconcileFailure(error: Error): void {
    this.cookieSpaceCounts = {
      ...this.cookieSpaceCounts,
      failed: Math.max(1, this.cookieSpaceCounts.failed),
    };
    this.cookieApplyErrorValue = error.message;
    this.refreshAggregateHealth();
    this.logger.warn('authSync.targetReconcile.failed', { error: error.message });
  }

  async disconnectDestination(): Promise<void> {
    this.lifecycleGeneration += 1;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    if (this.eventReconcileTimer) clearTimeout(this.eventReconcileTimer);
    this.eventReconcileTimer = null;
    const connection = this.destination;
    if (this.destination === connection) this.destination = null;
    this.reconcileRequested = false;
    this.reconcilePromise = null;
    this.destinationSessions.clear();
    this.destinationSessionPromises.clear();
    this.targetGenerations.clear();
    this.injectedScripts.clear();
    this.seededBrowserContexts.clear();
    connection?.close();
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.disconnectDestination();
  }
}
