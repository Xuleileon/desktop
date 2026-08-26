import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function createSession(): Promise<any> {
  // Keep the stock Bun SDK out of the Electron app's TypeScript program while
  // still exercising the real source through Vitest's runtime transformer.
  const modulePath = '../../../src/main/hl/stock/browser-harness-js/sdk/session.ts';
  const { Session } = await import(modulePath);
  return new Session();
}

type Listener = (event: { data?: string }) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static sent: Array<Record<string, unknown>> = [];

  readyState = FakeWebSocket.OPEN;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
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
    const result = method === 'Target.attachToTarget'
      ? { sessionId: 'assigned-cdp-session' }
      : method === 'Target.getTargets'
        ? {
            targetInfos: [
              { targetId: 'assigned-target', type: 'page', url: 'about:blank' },
              { targetId: 'other-conversation', type: 'page', url: 'https://private.example' },
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

  private emit(type: string, event: { data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe('Browser Harness conversation target isolation', () => {
  beforeEach(() => {
    FakeWebSocket.sent = [];
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

  it('forces the assigned endpoint and hides every other page target', async () => {
    const session = await createSession();

    await session.connect();
    const result = await session.Target.getTargets() as {
      targetInfos: Array<{ targetId: string }>;
    };

    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:61589/json/version');
    expect(result.targetInfos).toEqual([{ targetId: 'assigned-target', type: 'page', url: 'about:blank' }]);
    expect(FakeWebSocket.sent.find((message) => message.method === 'Target.attachToTarget')).toMatchObject({
      params: { targetId: 'assigned-target', flatten: true },
    });
  });

  it('rejects reconnecting, switching, or browser-global control outside the assignment', async () => {
    const session = await createSession();
    await session.connect();

    await expect(session.use('other-conversation')).rejects.toThrow('belongs to another browser view');
    await expect(session.connect({ port: 9222, targetId: 'other-conversation' })).rejects.toThrow('not assigned');
    await expect(session.Target.activateTarget({ targetId: 'other-conversation' })).rejects.toThrow('assigned target');
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
});
