import { randomUUID } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AuthSyncEngine,
  AuthSyncSourceGate,
  type AuthSyncLogger,
  type AuthSyncResult,
  type AuthSyncSpaceCounts,
  type AuthSyncStorageCounts,
} from './engine';

export const AUTH_SYNC_PORT = 17331;

interface AuthSyncEngineLike {
  readonly destinationConnected: boolean;
  readonly hasSourceSnapshot: boolean;
  readonly sourceReceivedAt: string | null;
  readonly sourceCookieCount: number;
  readonly storageCounts: AuthSyncStorageCounts;
  readonly lastResult: AuthSyncResult | null;
  readonly syncState: 'running' | 'degraded' | 'waiting';
  readonly lastSuccessfulApplyAt: string | null;
  readonly lastApplyError: string | null;
  readonly reconcileBacklog: number;
  readonly spaceCounts: AuthSyncSpaceCounts;
  connect(): Promise<void>;
  waitForDisconnect(): Promise<string>;
  acceptSnapshot(payload: unknown): Promise<AuthSyncResult>;
  acceptCookieChange(payload: unknown): Promise<AuthSyncResult | null>;
  acceptStorage(payload: Record<string, unknown>): Promise<AuthSyncResult>;
  syncNow(): Promise<AuthSyncResult>;
  disconnectDestination(): Promise<void>;
  close(): Promise<void>;
}

export interface AuthSyncServerOptions {
  cdpDiscoveryUrl: string;
  host?: string;
  port?: number;
  logger: AuthSyncLogger;
  engine?: AuthSyncEngineLike;
  retryDelayMs?: number;
  sourceLeaseMs?: number;
}

export interface AuthSyncServerHandle {
  url: string;
  close(): Promise<void>;
}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  const raw = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(raw),
  });
  response.end(raw);
}

async function readJson(request: IncomingMessage, maxBytes = 32 * 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error('request body too large');
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request body must be an object');
  return value as Record<string, unknown>;
}

function extensionOrigin(request: IncomingMessage): string | null {
  const origin = request.headers.origin;
  return typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin) ? origin : null;
}

export async function createAuthSyncServer(options: AuthSyncServerOptions): Promise<AuthSyncServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? AUTH_SYNC_PORT;
  const retryDelayMs = options.retryDelayMs ?? 2_000;
  const engine = options.engine ?? new AuthSyncEngine(options.cdpDiscoveryUrl, options.logger);
  const sourceGate = new AuthSyncSourceGate(options.sourceLeaseMs);
  const instanceId = randomUUID();
  let stopping = false;
  let connectionError: string | null = null;
  let lastRequestError: string | null = null;
  let signalStop: (() => void) | null = null;
  const stopSignal = new Promise<void>((resolve) => { signalStop = resolve; });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}`);
    const origin = extensionOrigin(request);
    if (origin) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'Origin');
      response.setHeader('access-control-allow-headers', 'content-type, x-browser-use-auth-sync');
      response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    }
    if (request.method === 'OPTIONS') {
      response.statusCode = origin ? 204 : 403;
      response.end();
      return;
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      const sourceBinding = sourceGate.status;
      const extensionConnected = engine.hasSourceSnapshot
        && (!sourceBinding.identified || sourceBinding.leaseActive);
      const state = connectionError || !extensionConnected
        ? 'waiting'
        : lastRequestError
          ? 'degraded'
          : engine.syncState;
      sendJson(response, 200, {
        state,
        instanceId,
        sourceMode: 'chrome-extension',
        sourceBinding,
        destinationConnected: engine.destinationConnected,
        extensionConnected,
        sourceReceivedAt: engine.sourceReceivedAt,
        sourceCookieCount: engine.sourceCookieCount,
        storage: engine.storageCounts,
        spaces: engine.spaceCounts,
        lastSync: engine.lastResult,
        lastSuccessfulApplyAt: engine.lastSuccessfulApplyAt,
        lastApplyError: lastRequestError ?? engine.lastApplyError,
        backlog: engine.reconcileBacklog,
        error: connectionError ?? lastRequestError ?? engine.lastApplyError,
      });
      return;
    }
    const validPost = request.method === 'POST' && [
      '/extension/snapshot',
      '/extension/cookie-change',
      '/extension/storage',
      '/sync',
    ].includes(url.pathname);
    if (!validPost) {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }
    if (!origin || request.headers['x-browser-use-auth-sync'] !== '1') {
      sendJson(response, 403, { error: 'extension_origin_required' });
      return;
    }
    try {
      const payload = url.pathname === '/sync' ? {} : await readJson(request);
      const admission = url.pathname.startsWith('/extension/') ? sourceGate.admit(payload) : null;
      if (admission && !admission.accepted) {
        options.logger.warn('authSync.source.ignored', {
          path: url.pathname,
          status: admission.status,
          sourceId: admission.sourceId,
          activeSourceId: admission.activeSourceId,
          epoch: admission.epoch,
          revision: admission.revision,
          lastRevision: admission.lastRevision,
        });
        if (admission.status === 'duplicate') {
          sendJson(response, 200, { ok: true, ignored: true, admission });
          return;
        }
        const status = admission.status === 'invalid_metadata' ? 400 : 409;
        sendJson(response, status, {
          ok: false,
          ignored: true,
          error: admission.status,
          admission,
        });
        return;
      }
      let result: AuthSyncResult | null;
      if (url.pathname === '/extension/snapshot') result = await engine.acceptSnapshot(payload);
      else if (url.pathname === '/extension/cookie-change') result = await engine.acceptCookieChange(payload);
      else if (url.pathname === '/extension/storage') result = await engine.acceptStorage(payload);
      else result = await engine.syncNow();
      lastRequestError = result?.error ?? null;
      sendJson(response, 200, { ok: true, result, admission });
    } catch (error) {
      const message = (error as Error).message || 'auth sync failed';
      lastRequestError = message;
      options.logger.warn('authSync.request.failed', { path: url.pathname, error: message });
      sendJson(response, engine.destinationConnected ? 400 : 503, { ok: false, error: message });
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await engine.close().catch(() => undefined);
    throw error;
  }
  const address = server.address() as AddressInfo;
  const serviceUrl = `http://${host}:${address.port}`;
  options.logger.info('authSync.server.started', { url: serviceUrl, cdpDiscoveryUrl: options.cdpDiscoveryUrl });

  const wait = async (): Promise<void> => {
    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, retryDelayMs)),
      stopSignal,
    ]);
  };
  const maintainDestination = async (): Promise<void> => {
    while (!stopping) {
      try {
        await engine.connect();
        connectionError = null;
        options.logger.info('authSync.desktop.connected');
        await Promise.race([engine.waitForDisconnect(), stopSignal]);
        if (stopping) break;
        throw new Error('Browser Use Desktop disconnected');
      } catch (error) {
        if (!stopping) {
          connectionError = (error as Error).message || 'Desktop unavailable';
          options.logger.warn('authSync.desktop.waiting', { error: connectionError });
        }
      } finally {
        await engine.disconnectDestination().catch(() => undefined);
      }
      if (!stopping) await wait();
    }
  };
  const maintainTask = maintainDestination();
  void maintainTask.catch((error: Error) => {
    if (!stopping) options.logger.warn('authSync.desktop.maintainerFailed', { error: error.message });
  });

  return {
    url: serviceUrl,
    close: async () => {
      if (stopping) return;
      stopping = true;
      signalStop?.();
      await engine.close();
      await maintainTask.catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      options.logger.info('authSync.server.stopped');
    },
  };
}
