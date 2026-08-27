import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { AuthSyncEngine, type TargetInfo } from '../../src/main/auth-sync/engine';

interface CdpCall {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

function storedCookieKey(cookie: Record<string, unknown>): string {
  const partition = cookie.partitionKey as Record<string, unknown> | undefined;
  return JSON.stringify([
    String(cookie.domain ?? '').trim().toLowerCase(),
    cookie.path ?? '/',
    cookie.name ?? '',
    partition?.topLevelSite ?? '',
    partition?.hasCrossSiteAncestor ?? null,
  ]);
}

function targetContext(target: TargetInfo | undefined): string {
  return target?.browserContextId ?? '__default_browser_context__';
}

const cleanups: Array<() => Promise<void>> = [];

async function eventually(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  assertion();
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('AuthSyncEngine target lifecycle', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('coalesces target events, seeds and reads back new Spaces, and retries a stale session only once', async () => {
    let targets: TargetInfo[] = [
      { targetId: 'page-a', type: 'page', url: 'https://example.com/app', browserContextId: 'space-a' },
    ];
    const calls: CdpCall[] = [];
    const sessionTargets = new Map<string, string>();
    const contextCookies = new Map<string, Array<Record<string, unknown>>>();
    let nextSession = 1;
    let failNextSetFor: string | null = null;
    let rejectCookieName: string | null = null;
    let rejectDeleteName: string | null = null;
    const forcedCookieValues = new Map<string, string>();
    let storageReadback: Record<string, string> = { theme: 'dark' };
    let browserSocket: WebSocket | null = null;
    let connectionCount = 0;
    let outstandingCommands = 0;
    let maxOutstandingCommands = 0;

    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    const wsPort = (wss.address() as AddressInfo).port;
    wss.on('connection', (socket) => {
      connectionCount += 1;
      browserSocket = socket;
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as {
          id: number;
          method: string;
          params?: Record<string, unknown>;
          sessionId?: string;
        };
        outstandingCommands += 1;
        maxOutstandingCommands = Math.max(maxOutstandingCommands, outstandingCommands);
        const respond = (payload: Record<string, unknown>): void => {
          socket.send(JSON.stringify(payload));
          outstandingCommands -= 1;
        };
        const params = message.params ?? {};
        calls.push({ method: message.method, params, sessionId: message.sessionId });
        const targetId = message.sessionId ? sessionTargets.get(message.sessionId) : undefined;
        if (message.method === 'Target.getTargets') {
          respond({ id: message.id, result: { targetInfos: targets } });
          return;
        }
        if (message.method === 'Target.attachToTarget') {
          const attachedTarget = String(params.targetId);
          const sessionId = `session-${attachedTarget}-${nextSession++}`;
          sessionTargets.set(sessionId, attachedTarget);
          respond({ id: message.id, result: { sessionId } });
          return;
        }
        if (message.method === 'Network.setCookies' && targetId) {
          if (failNextSetFor === targetId) {
            failNextSetFor = null;
            respond({ id: message.id, error: { message: 'Session with given id not found' } });
            return;
          }
          const incomingCookies = (params.cookies as Array<Record<string, unknown>> | undefined) ?? [];
          if (rejectCookieName && incomingCookies.some((cookie) => cookie.name === rejectCookieName)) {
            respond({ id: message.id, error: { message: 'Invalid cookie fields' } });
            return;
          }
          const target = targets.find((item) => item.targetId === targetId);
          const context = targetContext(target);
          const stored = new Map((contextCookies.get(context) ?? []).map((cookie) => [storedCookieKey(cookie), cookie]));
          for (const cookie of incomingCookies) {
            const forcedValue = forcedCookieValues.get(String(cookie.name));
            stored.set(storedCookieKey(cookie), forcedValue === undefined ? cookie : { ...cookie, value: forcedValue });
          }
          contextCookies.set(context, Array.from(stored.values()));
        }
        if (message.method === 'Network.clearBrowserCookies' && targetId) {
          const target = targets.find((item) => item.targetId === targetId);
          contextCookies.set(targetContext(target), []);
          respond({ id: message.id, result: {} });
          return;
        }
        if (message.method === 'Network.deleteCookies' && targetId) {
          if (params.name === rejectDeleteName) {
            respond({ id: message.id, error: { message: 'Delete rejected' } });
            return;
          }
          const target = targets.find((item) => item.targetId === targetId);
          const context = targetContext(target);
          const deletedKey = storedCookieKey(params);
          contextCookies.set(
            context,
            (contextCookies.get(context) ?? []).filter((cookie) => storedCookieKey(cookie) !== deletedKey),
          );
          respond({ id: message.id, result: {} });
          return;
        }
        if (message.method === 'Network.getCookies' && targetId) {
          const target = targets.find((item) => item.targetId === targetId);
          const context = targetContext(target);
          respond({ id: message.id, result: { cookies: contextCookies.get(context) ?? [] } });
          return;
        }
        if (message.method === 'Network.getAllCookies' && targetId) {
          const target = targets.find((item) => item.targetId === targetId);
          const context = targetContext(target);
          respond({ id: message.id, result: { cookies: contextCookies.get(context) ?? [] } });
          return;
        }
        if (message.method === 'Page.addScriptToEvaluateOnNewDocument') {
          respond({ id: message.id, result: { identifier: `script-${targetId}` } });
          return;
        }
        if (message.method === 'Runtime.evaluate') {
          respond({
            id: message.id,
            result: { result: { value: { localStorage: storageReadback, sessionStorage: {} } } },
          });
          return;
        }
        respond({ id: message.id, result: {} });
      });
    });

    const discovery = http.createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}` }));
    });
    const discoveryPort = await listen(discovery);
    const engine = new AuthSyncEngine(
      `http://127.0.0.1:${discoveryPort}/json/version`,
      { info: vi.fn(), warn: vi.fn() },
    );
    cleanups.push(async () => {
      await engine.close();
      await new Promise<void>((resolve) => discovery.close(() => resolve()));
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    });

    await engine.connect();
    await engine.connect();
    expect(connectionCount).toBe(1);
    await engine.acceptSnapshot({ cookies: [
      { name: 'sid', value: 'one', domain: '.example.com', path: '/' },
      { name: 'pref', value: 'blue', domain: '.example.com', path: '/' },
      { name: 'stable', value: 'yes', domain: '.example.com', path: '/' },
      { name: 'partitioned', value: 'a', domain: '.example.com', path: '/', partitionKey: { topLevelSite: 'https://a.example', hasCrossSiteAncestor: false } },
      { name: 'partitioned', value: 'b', domain: '.example.com', path: '/', partitionKey: { topLevelSite: 'https://b.example', hasCrossSiteAncestor: false } },
      { name: 'scope', value: 'host-old', domain: 'example.com', path: '/' },
      { name: 'scope', value: 'host', domain: 'example.com', path: '/' },
      { name: 'scope', value: 'domain', domain: '.example.com', path: '/' },
    ] });
    await engine.acceptStorage({ origin: 'https://example.com', localStorage: { theme: 'dark' } });
    expect(calls.some((call) => call.method === 'Network.getAllCookies')).toBe(true);
    expect(engine.sourceCookieCount).toBe(7);
    expect((contextCookies.get('space-a') ?? []).filter((cookie) => cookie.name === 'scope'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ value: 'host', domain: 'example.com' }),
        expect.objectContaining({ value: 'domain', domain: '.example.com' }),
      ]));

    targets = [...targets, {
      targetId: 'page-b',
      type: 'page',
      url: 'https://example.com/second',
      browserContextId: 'space-b',
    }];
    browserSocket?.send(JSON.stringify({
      method: 'Target.targetCreated',
      params: { targetInfo: targets[1] },
    }));
    await eventually(() => {
      expect(calls.some((call) => call.method === 'Network.getAllCookies'
        && sessionTargets.get(call.sessionId ?? '') === 'page-b')).toBe(true);
      expect(calls.some((call) => call.method === 'Runtime.evaluate'
        && sessionTargets.get(call.sessionId ?? '') === 'page-b')).toBe(true);
    });
    expect(calls.some((call) => call.method === 'Network.clearBrowserCookies'
      && sessionTargets.get(call.sessionId ?? '') === 'page-b')).toBe(true);
      expect(calls.some((call) => call.method === 'Network.setCookies'
      && sessionTargets.get(call.sessionId ?? '') === 'page-b'
      && (call.params.cookies as unknown[]).length === 7)).toBe(true);

    const beforeDiff = calls.length;
    failNextSetFor = 'page-a';
    await engine.acceptSnapshot({ cookies: [
      { name: 'sid', value: 'two', domain: '.example.com', path: '/' },
      { name: 'pref', value: 'green', domain: '.example.com', path: '/' },
      { name: 'stable', value: 'yes', domain: '.example.com', path: '/' },
      { name: 'partitioned', value: 'a', domain: '.example.com', path: '/', partitionKey: { topLevelSite: 'https://a.example', hasCrossSiteAncestor: false } },
      { name: 'partitioned', value: 'b', domain: '.example.com', path: '/', partitionKey: { topLevelSite: 'https://b.example', hasCrossSiteAncestor: false } },
    ] });
    const diffCalls = calls.slice(beforeDiff);
    const pageASetCalls = diffCalls.filter((call) => call.method === 'Network.setCookies'
      && sessionTargets.get(call.sessionId ?? '') === 'page-a');
    expect(pageASetCalls).toHaveLength(2);
    expect(pageASetCalls.every((call) => (call.params.cookies as unknown[]).length === 2)).toBe(true);

    rejectCookieName = 'rejected';
    await engine.acceptSnapshot({ cookies: [
      { name: 'sid', value: 'two', domain: '.example.com', path: '/' },
      { name: 'pref', value: 'green', domain: '.example.com', path: '/' },
      { name: 'stable', value: 'yes', domain: '.example.com', path: '/' },
      { name: 'partitioned', value: 'a', domain: '.example.com', path: '/', partitionKey: { topLevelSite: 'https://a.example', hasCrossSiteAncestor: false } },
      { name: 'partitioned', value: 'b', domain: '.example.com', path: '/', partitionKey: { topLevelSite: 'https://b.example', hasCrossSiteAncestor: false } },
      { name: 'rejected', value: 'x', domain: '.example.com', path: '/' },
    ] });
    expect(engine.syncState).toBe('degraded');
    expect(engine.lastApplyError).not.toBeNull();
    rejectCookieName = null;
    await engine.acceptSnapshot({ cookies: [
      { name: 'sid', value: 'two', domain: '.example.com', path: '/' },
      { name: 'pref', value: 'green', domain: '.example.com', path: '/' },
      { name: 'stable', value: 'yes', domain: '.example.com', path: '/' },
      { name: 'partitioned', value: 'a', domain: '.example.com', path: '/', partitionKey: { topLevelSite: 'https://a.example', hasCrossSiteAncestor: false } },
      { name: 'partitioned', value: 'b', domain: '.example.com', path: '/', partitionKey: { topLevelSite: 'https://b.example', hasCrossSiteAncestor: false } },
      { name: 'rejected', value: 'x', domain: '.example.com', path: '/' },
    ] });
    expect(engine.syncState).toBe('running');
    expect(engine.lastApplyError).toBeNull();

    forcedCookieValues.set('sid', 'stale-value');
    const freshCookieSnapshot = [
      { name: 'sid', value: 'fresh', domain: '.example.com', path: '/' },
      { name: 'pref', value: 'green', domain: '.example.com', path: '/' },
      { name: 'stable', value: 'yes', domain: '.example.com', path: '/' },
      { name: 'partitioned', value: 'a', domain: '.example.com', path: '/', partitionKey: { topLevelSite: 'https://a.example', hasCrossSiteAncestor: false } },
      { name: 'partitioned', value: 'b', domain: '.example.com', path: '/', partitionKey: { topLevelSite: 'https://b.example', hasCrossSiteAncestor: false } },
      { name: 'rejected', value: 'x', domain: '.example.com', path: '/' },
    ];
    await engine.acceptSnapshot({ cookies: freshCookieSnapshot });
    expect(engine.syncState).toBe('degraded');
    expect(engine.lastApplyError).toContain('Cookie readback mismatch');
    await engine.acceptStorage({ origin: 'https://example.com', localStorage: { theme: 'dark' } });
    expect(engine.syncState).toBe('degraded');
    expect(engine.lastApplyError).toContain('Cookie readback mismatch');
    forcedCookieValues.delete('sid');
    await engine.acceptSnapshot({ cookies: freshCookieSnapshot });
    expect(engine.syncState).toBe('running');

    const drifted = (contextCookies.get('space-a') ?? []).map((cookie) =>
      cookie.name === 'sid' ? { ...cookie, value: 'destination-drift' } : cookie,
    );
    contextCookies.set('space-a', drifted);
    await engine.acceptSnapshot({ cookies: freshCookieSnapshot });
    expect(engine.syncState).toBe('degraded');
    expect(engine.lastApplyError).toContain('Cookie readback mismatch');
    await engine.reconcileDestinationTargets();
    expect(engine.syncState).toBe('running');
    expect((contextCookies.get('space-a') ?? []).find((cookie) => cookie.name === 'sid')?.value).toBe('fresh');

    await engine.acceptSnapshot({ cookies: [
      { name: 'sid', value: 'fresh', domain: '.example.com', path: '/' },
      { name: 'pref', value: 'green', domain: '.example.com', path: '/' },
      { name: 'stable', value: 'yes', domain: '.example.com', path: '/' },
      { name: 'partitioned', value: 'b', domain: '.example.com', path: '/', partitionKey: { topLevelSite: 'https://b.example', hasCrossSiteAncestor: false } },
      { name: 'rejected', value: 'x', domain: '.example.com', path: '/' },
    ] });
    for (const context of ['space-a', 'space-b']) {
      const partitioned = (contextCookies.get(context) ?? []).filter((cookie) => cookie.name === 'partitioned');
      expect(partitioned).toHaveLength(1);
      expect((partitioned[0]?.partitionKey as Record<string, unknown>).topLevelSite).toBe('https://b.example');
    }

    rejectDeleteName = 'stable';
    const withoutStable = [
      { name: 'sid', value: 'fresh', domain: '.example.com', path: '/' },
      { name: 'pref', value: 'green', domain: '.example.com', path: '/' },
      { name: 'partitioned', value: 'b', domain: '.example.com', path: '/', partitionKey: { topLevelSite: 'https://b.example', hasCrossSiteAncestor: false } },
      { name: 'rejected', value: 'x', domain: '.example.com', path: '/' },
    ];
    await engine.acceptSnapshot({ cookies: withoutStable });
    expect(engine.syncState).toBe('degraded');
    rejectDeleteName = null;
    await engine.acceptSnapshot({ cookies: withoutStable });
    expect(engine.syncState).toBe('running');
    for (const context of ['space-a', 'space-b']) {
      expect((contextCookies.get(context) ?? []).some((cookie) => cookie.name === 'stable')).toBe(false);
    }

    storageReadback = { theme: 'dark', stale: 'must-be-cleared' };
    await engine.acceptStorage({ origin: 'https://example.com', localStorage: { theme: 'dark' } });
    expect(engine.syncState).toBe('degraded');
    browserSocket?.send(JSON.stringify({
      method: 'Target.targetInfoChanged',
      params: { targetInfo: targets[0] },
    }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(engine.syncState).toBe('degraded');
    storageReadback = { theme: 'dark' };
    browserSocket?.send(JSON.stringify({
      method: 'Target.targetInfoChanged',
      params: { targetInfo: targets[0] },
    }));
    await eventually(() => expect(engine.syncState).toBe('running'));

    const beforeBurst = calls.filter((call) => call.method === 'Target.getTargets').length;
    for (let index = 0; index < 20; index += 1) {
      browserSocket?.send(JSON.stringify({
        method: 'Target.targetInfoChanged',
        params: { targetInfo: targets[0] },
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterBurst = calls.filter((call) => call.method === 'Target.getTargets').length;
    expect(afterBurst - beforeBurst).toBeLessThanOrEqual(2);
    expect(maxOutstandingCommands).toBe(1);
    expect(engine.syncState).toBe('running');
    expect(engine.lastSuccessfulApplyAt).not.toBeNull();

    const beforeDefaultContext = calls.length;
    targets = [
      { targetId: 'default-a', type: 'page', url: 'https://example.com/one' },
      { targetId: 'default-b', type: 'page', url: 'https://example.com/two' },
    ];
    await engine.reconcileDestinationTargets();
    const defaultContextCookieWrites = calls.slice(beforeDefaultContext).filter((call) =>
      call.method === 'Network.setCookies'
      && ['default-a', 'default-b'].includes(sessionTargets.get(call.sessionId ?? '') ?? ''),
    );
    expect(defaultContextCookieWrites).toHaveLength(1);
    expect(engine.spaceCounts.discovered).toBe(1);

    await engine.disconnectDestination();
    await Promise.all([engine.connect(), engine.connect()]);
    expect(connectionCount).toBe(2);
    expect(engine.destinationConnected).toBe(true);
    expect(engine.syncState).toBe('running');
    expect(maxOutstandingCommands).toBe(1);
  });
});
