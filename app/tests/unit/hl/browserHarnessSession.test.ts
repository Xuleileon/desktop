import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadSessionModule(): Promise<any> {
  // Keep the stock Bun SDK out of the Electron app's TypeScript program while
  // still exercising the real source through Vitest's runtime transformer.
  const modulePath = '../../../src/main/hl/stock/browser-harness-js/sdk/session.ts';
  return await import(modulePath);
}

async function createSession(options: Record<string, unknown> = {}): Promise<any> {
  const { Session } = await loadSessionModule();
  return new Session(options);
}

type Listener = (event: { data?: string }) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static sent: Array<Record<string, unknown>> = [];
  static ignoredMethods = new Set<string>();
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.OPEN;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit('open', {}));
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(raw: string): void {
    const request = JSON.parse(raw) as Record<string, unknown>;
    FakeWebSocket.sent.push(request);
    const method = request.method;
    if (typeof method === 'string' && FakeWebSocket.ignoredMethods.has(method)) return;
    const result = method === 'Target.attachToTarget'
      ? { sessionId: 'assigned-cdp-session' }
      : method === 'Target.getTargets'
        ? {
            targetInfos: [
              { targetId: 'assigned-target', browserContextId: 'space-context', type: 'page', url: 'about:blank' },
              { targetId: 'space-popup', browserContextId: 'space-context', type: 'page', url: 'https://example.com' },
              { targetId: 'nested-popup', openerId: 'space-popup', browserContextId: 'space-context', type: 'page', url: 'https://example.org' },
              { targetId: 'other-conversation', browserContextId: 'other-context', type: 'page', url: 'https://private.example' },
            ],
          }
        : {};
    queueMicrotask(() => this.emit('message', {
      data: JSON.stringify({ id: request.id, result }),
    }));
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => this.emit('close', {}));
  }

  respond(id: number, result: unknown = {}): void {
    this.emit('message', { data: JSON.stringify({ id, result }) });
  }

  private emit(type: string, event: { data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe('Browser Harness conversation target isolation', () => {
  beforeEach(() => {
    FakeWebSocket.sent = [];
    FakeWebSocket.ignoredMethods.clear();
    FakeWebSocket.instances = [];
    vi.stubEnv('BU_TARGET_ID', 'assigned-target');
    vi.stubEnv('BU_CDP_PORT', '61589');
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:61589/devtools/browser/test' }),
      url,
    })));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('forces the assigned endpoint, exposes Space popups, and hides every other conversation', async () => {
    const session = await createSession();

    await session.connect();
    const result = await session.Target.getTargets() as {
      targetInfos: Array<{ targetId: string }>;
    };

    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:61589/json/version',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.targetInfos).toEqual([
      { targetId: 'assigned-target', browserContextId: 'space-context', type: 'page', url: 'about:blank' },
      { targetId: 'space-popup', browserContextId: 'space-context', type: 'page', url: 'https://example.com' },
      { targetId: 'nested-popup', openerId: 'space-popup', browserContextId: 'space-context', type: 'page', url: 'https://example.org' },
    ]);
    expect(FakeWebSocket.sent.find((message) => message.method === 'Target.attachToTarget')).toMatchObject({
      params: { targetId: 'assigned-target', flatten: true },
    });
    const connectMethods = FakeWebSocket.sent.map((message) => message.method);
    expect(connectMethods).toContain('Target.activateTarget');
    expect(connectMethods.indexOf('Target.activateTarget')).toBeLessThan(connectMethods.indexOf('Target.attachToTarget'));
  });

  it('allows switching inside the Space but rejects other conversations and browser-global control', async () => {
    const session = await createSession();
    await session.connect();

    await session.Target.getTargets();
    FakeWebSocket.sent = [];
    await expect(session.use('space-popup')).resolves.toBe('assigned-cdp-session');
    expect(FakeWebSocket.sent.slice(0, 2)).toMatchObject([
      { method: 'Target.activateTarget', params: { targetId: 'space-popup' } },
      { method: 'Target.attachToTarget', params: { targetId: 'space-popup', flatten: true } },
    ]);
    await expect(session.Target.activateTarget({ targetId: 'nested-popup' })).resolves.toEqual({});
    await expect(session.Target.closeTarget({ targetId: 'space-popup' })).resolves.toEqual({});
    await expect(session.Target.closeTarget({ targetId: 'assigned-target' })).rejects.toThrow('root target');
    await expect(session.use('other-conversation')).rejects.toThrow('belongs to another conversation Space');
    await expect(session.connect({ port: 9222, targetId: 'other-conversation' })).rejects.toThrow('not assigned');
    await expect(session.Target.activateTarget({ targetId: 'other-conversation' })).rejects.toThrow('assigned conversation Space');
    await expect(session.Target.createTarget({ url: 'https://example.com' })).rejects.toThrow('not available');
    await expect(session.Browser.close()).rejects.toThrow('browser-global');
  });

  it('routes normal page calls through the assigned CDP session', async () => {
    const session = await createSession();
    await session.connect();

    await session.Page.navigate({ url: 'https://example.com' });

    expect(FakeWebSocket.sent.find((message) => message.method === 'Page.navigate')).toMatchObject({
      sessionId: 'assigned-cdp-session',
      params: { url: 'https://example.com' },
    });
  });

  it('times out and removes a CDP command that never receives a response', async () => {
    const session = await createSession({ callTimeoutMs: 100 });
    await session.connect();
    FakeWebSocket.ignoredMethods.add('Page.navigate');

    await expect(session.Page.navigate({ url: 'https://slow.example' }))
      .rejects.toThrow('CDP call Page.navigate timed out after 100ms');

    expect((session as any).pending.size).toBe(0);
    const request = FakeWebSocket.sent.find((message) => message.method === 'Page.navigate');
    FakeWebSocket.instances.at(-1)?.respond(request?.id as number, { late: true });
    expect((session as any).pending.size).toBe(0);
    await expect(session.Browser.getVersion()).resolves.toEqual({});
  });

  it('rejects and clears pending commands when the CDP socket closes', async () => {
    const session = await createSession({ callTimeoutMs: 1_000 });
    await session.connect();
    FakeWebSocket.ignoredMethods.add('Page.navigate');

    const pending = session.Page.navigate({ url: 'https://closed.example' });
    session.close();

    await expect(pending).rejects.toThrow('CDP socket closed');
    expect((session as any).pending.size).toBe(0);
  });

  it('requires awaiting listPageTargets before array or serialization operations', async () => {
    const { listPageTargets } = await loadSessionModule();
    const session = await createSession();
    await session.connect();

    const missingAwait = /listPageTargets\(\) returns a Promise; use `await listPageTargets\(\)`/;
    expect(() => (listPageTargets(session) as any).find(() => true)).toThrow(missingAwait);
    expect(() => Object.values(listPageTargets(session) as any)).toThrow(missingAwait);
    expect(() => JSON.stringify(listPageTargets(session))).toThrow(missingAwait);
    expect(() => ({ ...(listPageTargets(session) as any) })).toThrow(missingAwait);

    await expect(listPageTargets(session)).resolves.toEqual([
      { targetId: 'assigned-target', browserContextId: 'space-context', type: 'page', url: 'about:blank' },
      { targetId: 'space-popup', browserContextId: 'space-context', type: 'page', url: 'https://example.com' },
      { targetId: 'nested-popup', openerId: 'space-popup', browserContextId: 'space-context', type: 'page', url: 'https://example.org' },
    ]);
  });
});
