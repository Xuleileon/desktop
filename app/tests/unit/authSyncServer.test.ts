import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type AddressInfo } from 'node:net';
import { createAuthSyncServer, type AuthSyncServerHandle } from '../../src/main/auth-sync/server';
import {
  AuthSyncSourceGate,
  destinationBrowserContextIds,
  type AuthSyncResult,
} from '../../src/main/auth-sync/engine';

const handles: AuthSyncServerHandle[] = [];

function result(reason: string): AuthSyncResult {
  return {
    completedAt: new Date().toISOString(),
    reason,
    sourceReceivedAt: new Date().toISOString(),
    cookies: { source: 1, set: 1, failed: 0, deleted: 0 },
    storage: { origins: 1, localItems: 1, sessionItems: 0 },
    spaces: { discovered: 1, applied: 1, skipped: 0, failed: 0, verified: 1 },
    error: null,
  };
}

function fakeEngine() {
  return {
    destinationConnected: true,
    hasSourceSnapshot: true,
    sourceReceivedAt: new Date().toISOString() as string | null,
    sourceCookieCount: 1,
    storageCounts: { origins: 0, localItems: 0, sessionItems: 0 },
    lastResult: null as AuthSyncResult | null,
    syncState: 'running' as const,
    lastSuccessfulApplyAt: new Date().toISOString(),
    lastApplyError: null as string | null,
    reconcileBacklog: 0,
    spaceCounts: { discovered: 1, applied: 1, skipped: 0, failed: 0, verified: 1 },
    connect: vi.fn(async () => undefined),
    waitForDisconnect: vi.fn(async () => await new Promise<string>(() => undefined)),
    acceptSnapshot: vi.fn(async () => result('extension-snapshot')),
    acceptCookieChange: vi.fn(async () => result('cookie-change')),
    acceptStorage: vi.fn(async () => result('storage-update')),
    syncNow: vi.fn(async () => result('manual-sync')),
    disconnectDestination: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe('authSyncServer', () => {
  afterEach(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()));
  });

  it('accepts cookie and storage snapshots directly from a Chrome extension', async () => {
    const engine = fakeEngine();
    const handle = await createAuthSyncServer({
      cdpDiscoveryUrl: 'http://127.0.0.1:1/json/version',
      port: 0,
      engine,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    handles.push(handle);
    const headers = {
      Origin: 'chrome-extension://nmdgpnljobcknhddkbbipdngbfdnlcai',
      'Content-Type': 'application/json',
      'X-Browser-Use-Auth-Sync': '1',
    };

    const cookieResponse = await fetch(`${handle.url}/extension/snapshot`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cookies: [{ name: 'sid', value: 'x', domain: '.example.com' }] }),
    });
    const storageResponse = await fetch(`${handle.url}/extension/storage`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ origin: 'https://example.com', localStorage: { theme: 'dark' } }),
    });

    expect(cookieResponse.status).toBe(200);
    expect(storageResponse.status).toBe(200);
    expect(engine.acceptSnapshot).toHaveBeenCalledOnce();
    expect(engine.acceptStorage).toHaveBeenCalledOnce();
  });

  it('binds the active Profile and rejects a second source before engine mutation', async () => {
    const engine = fakeEngine();
    const handle = await createAuthSyncServer({
      cdpDiscoveryUrl: 'http://127.0.0.1:1/json/version',
      port: 0,
      engine,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    handles.push(handle);
    const headers = {
      Origin: 'chrome-extension://nmdgpnljobcknhddkbbipdngbfdnlcai',
      'Content-Type': 'application/json',
      'X-Browser-Use-Auth-Sync': '1',
    };

    const first = await fetch(`${handle.url}/extension/snapshot`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sourceId: 'profile-a', epoch: 'worker-a', revision: 0, cookies: [] }),
    });
    const conflict = await fetch(`${handle.url}/extension/snapshot`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sourceId: 'profile-b', epoch: 'worker-b', revision: 0, cookies: [] }),
    });
    const conflictBody = await conflict.json() as Record<string, unknown>;
    const health = await (await fetch(`${handle.url}/health`)).json() as Record<string, unknown>;

    expect(first.status).toBe(200);
    expect(conflict.status).toBe(409);
    expect(conflictBody).toMatchObject({ ok: false, ignored: true, error: 'source_conflict' });
    expect(engine.acceptSnapshot).toHaveBeenCalledOnce();
    expect(health.sourceBinding).toMatchObject({
      identified: true,
      sourceId: 'profile-a',
      epoch: 'worker-a',
      revision: 0,
      leaseActive: true,
    });
  });

  it('ignores duplicate and stale revisions without replaying them into the engine', async () => {
    const engine = fakeEngine();
    const handle = await createAuthSyncServer({
      cdpDiscoveryUrl: 'http://127.0.0.1:1/json/version',
      port: 0,
      engine,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    handles.push(handle);
    const headers = {
      Origin: 'chrome-extension://nmdgpnljobcknhddkbbipdngbfdnlcai',
      'Content-Type': 'application/json',
      'X-Browser-Use-Auth-Sync': '1',
    };
    const write = async (revision: number) => await fetch(`${handle.url}/extension/cookie-change`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sourceId: 'profile-a',
        epoch: 'worker-a',
        revision,
        cookie: { name: 'sid', value: String(revision), domain: '.example.com' },
      }),
    });

    const accepted = await write(2);
    const stale = await write(1);
    const duplicate = await write(2);

    expect(accepted.status).toBe(200);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ ignored: true, error: 'stale_revision' });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({
      ok: true,
      ignored: true,
      admission: { status: 'duplicate' },
    });
    expect(engine.acceptCookieChange).toHaveBeenCalledOnce();
  });

  it('accepts a same-source worker reload with a reset revision and retires the old epoch', async () => {
    const engine = fakeEngine();
    const handle = await createAuthSyncServer({
      cdpDiscoveryUrl: 'http://127.0.0.1:1/json/version',
      port: 0,
      engine,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    handles.push(handle);
    const headers = {
      Origin: 'chrome-extension://nmdgpnljobcknhddkbbipdngbfdnlcai',
      'Content-Type': 'application/json',
      'X-Browser-Use-Auth-Sync': '1',
    };
    const write = async (epoch: string, revision: number, value: string) => await fetch(`${handle.url}/extension/snapshot`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sourceId: 'profile-a',
        epoch,
        revision,
        cookies: [{ name: 'sid', value, domain: '.example.com' }],
      }),
    });

    expect((await write('old-worker', 41, 'old')).status).toBe(200);
    expect((await write('new-worker', 0, 'new')).status).toBe(200);
    const delayedOld = await write('old-worker', 42, 'must-not-win');

    expect(delayedOld.status).toBe(409);
    expect(await delayedOld.json()).toMatchObject({ ignored: true, error: 'retired_epoch' });
    expect(engine.acceptSnapshot).toHaveBeenCalledTimes(2);
    expect(engine.acceptSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      epoch: 'new-worker',
      revision: 0,
    }));
  });

  it('never lets a legacy payload override an identified active source', async () => {
    const engine = fakeEngine();
    const handle = await createAuthSyncServer({
      cdpDiscoveryUrl: 'http://127.0.0.1:1/json/version',
      port: 0,
      engine,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    handles.push(handle);
    const headers = {
      Origin: 'chrome-extension://nmdgpnljobcknhddkbbipdngbfdnlcai',
      'Content-Type': 'application/json',
      'X-Browser-Use-Auth-Sync': '1',
    };

    await fetch(`${handle.url}/extension/snapshot`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sourceId: 'profile-a', epoch: 'worker-a', revision: 0, cookies: [] }),
    });
    const legacy = await fetch(`${handle.url}/extension/snapshot`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cookies: [{ name: 'sid', value: 'legacy', domain: '.example.com' }] }),
    });

    expect(legacy.status).toBe(409);
    expect(await legacy.json()).toMatchObject({ ignored: true, error: 'legacy_blocked' });
    expect(engine.acceptSnapshot).toHaveBeenCalledOnce();
  });

  it('rejects writes from ordinary web pages', async () => {
    const engine = fakeEngine();
    const handle = await createAuthSyncServer({
      cdpDiscoveryUrl: 'http://127.0.0.1:1/json/version',
      port: 0,
      engine,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    handles.push(handle);

    const response = await fetch(`${handle.url}/extension/snapshot`, {
      method: 'POST',
      headers: {
        Origin: 'https://example.com',
        'Content-Type': 'application/json',
        'X-Browser-Use-Auth-Sync': '1',
      },
      body: JSON.stringify({ cookies: [] }),
    });

    expect(response.status).toBe(403);
    expect(engine.acceptSnapshot).not.toHaveBeenCalled();
  });

  it('reports Desktop and extension connection state', async () => {
    const engine = fakeEngine();
    const handle = await createAuthSyncServer({
      cdpDiscoveryUrl: 'http://127.0.0.1:1/json/version',
      port: 0,
      engine,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    handles.push(handle);

    const response = await fetch(`${handle.url}/health`);
    const health = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(health.state).toBe('running');
    expect(health.destinationConnected).toBe(true);
    expect(health.extensionConnected).toBe(true);
    expect(health.sourceMode).toBe('chrome-extension');
    expect(health.lastSuccessfulApplyAt).toEqual(expect.any(String));
    expect(health.spaces).toEqual({ discovered: 1, applied: 1, skipped: 0, failed: 0, verified: 1 });
  });

  it('reports readback failures as degraded instead of connected', async () => {
    const engine = {
      ...fakeEngine(),
      syncState: 'degraded' as const,
      lastApplyError: 'Cookie readback mismatch',
      spaceCounts: { discovered: 1, applied: 0, skipped: 0, failed: 1, verified: 0 },
    };
    const handle = await createAuthSyncServer({
      cdpDiscoveryUrl: 'http://127.0.0.1:1/json/version',
      port: 0,
      engine,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    handles.push(handle);

    const response = await fetch(`${handle.url}/health`);
    const health = await response.json() as Record<string, unknown>;

    expect(health.state).toBe('degraded');
    expect(health.lastApplyError).toBe('Cookie readback mismatch');
  });

  it('cleans up the sync engine when the legacy port is already occupied', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as AddressInfo).port;
    const engine = fakeEngine();

    try {
      await expect(createAuthSyncServer({
        cdpDiscoveryUrl: 'http://127.0.0.1:1/json/version',
        port,
        engine,
        logger: { info: vi.fn(), warn: vi.fn() },
      })).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(engine.close).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe('AuthSyncSourceGate lease', () => {
  it('allows a different identified Profile only after the active lease expires', () => {
    let now = 1_000;
    const gate = new AuthSyncSourceGate(100, () => now);

    expect(gate.admit({ sourceId: 'profile-a', epoch: 'worker-a', revision: 0 }).status).toBe('accepted');
    now = 1_099;
    expect(gate.admit({ sourceId: 'profile-b', epoch: 'worker-b', revision: 0 }).status).toBe('source_conflict');
    now = 1_100;
    expect(gate.admit({ sourceId: 'profile-b', epoch: 'worker-b', revision: 0 }).status).toBe('accepted');
    expect(gate.status).toMatchObject({ sourceId: 'profile-b', leaseActive: true });
  });
});

describe('auth sync browser contexts', () => {
  it('targets every isolated Space once and ignores non-page targets', () => {
    expect(destinationBrowserContextIds([
      { targetId: 'page-a', type: 'page', url: 'https://a.example', browserContextId: 'space-a' },
      { targetId: 'popup-a', type: 'page', url: 'https://a.example/popup', browserContextId: 'space-a' },
      { targetId: 'page-b', type: 'page', url: 'https://b.example', browserContextId: 'space-b' },
      { targetId: 'worker', type: 'service_worker', url: 'https://a.example/sw.js', browserContextId: 'space-a' },
    ])).toEqual(['space-a', 'space-b']);
  });
});
