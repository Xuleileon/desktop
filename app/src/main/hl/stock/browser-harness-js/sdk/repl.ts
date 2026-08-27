/**
 * CDP REPL — HTTP server holding one persistent CDP Session.
 *
 * Endpoints (bind 127.0.0.1:9876 by default; override with $CDP_REPL_PORT):
 *   POST /eval     body = raw JS to evaluate (NOT JSON-wrapped).
 *                  Top-level await supported. Single expression auto-returns.
 *                  Response: {"ok":true,"result":<json>} | {"ok":false,"error":..,"stack"?:..}
 *   GET  /health   {"ok":true,"uptime":<seconds>,"connected":<bool>,"sessionId":<string|null>}
 *   POST /quit     graceful shutdown. Returns {"ok":true} then exits.
 *
 * State: `session`, the active sessionId, event subscribers, and any
 * `globalThis.<name>` you set persist across requests for the lifetime of
 * the process.
 */

import { Session, listPageTargets, resolveWsUrl, detectBrowsers } from './session.ts';
import * as Generated from './generated.ts';

const DEFAULT_EVAL_TIMEOUT_MS = 60_000;
const MIN_EVAL_TIMEOUT_MS = 100;
const MAX_EVAL_TIMEOUT_MS = 120_000;

function isExpression(code: string): boolean {
  const trimmed = code.trim();
  if (!trimmed) return false;
  if (/[;\n]/.test(trimmed)) return false;
  if (/^(let|const|var|if|for|while|do|switch|class|function|throw|try|return|import|export)\b/.test(trimmed)) return false;
  return true;
}

function serialize(v: unknown): unknown {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(v, (_k, val) => typeof val === 'bigint' ? val.toString() : val));
  } catch {
    return String(v);
  }
}

export async function runSnippet(code: string): Promise<unknown> {
  const body = isExpression(code) ? `return (${code});` : code;
  const wrapped = `(async () => { ${body} })()`;
  return await (0, eval)(wrapped);
}

export class EvalTimeoutError extends Error {
  constructor(public timeoutMs: number) {
    super(`Browser Harness eval timed out after ${timeoutMs}ms; the REPL was recycled to discard unfinished work.`);
    this.name = 'EvalTimeoutError';
  }
}

export async function runSnippetWithTimeout(
  code: string,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new EvalTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([runSnippet(code), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function boundedTimeoutMs(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

const TEXT = { 'content-type': 'text/plain; charset=utf-8' } as const;

/**
 * Render a value to the body of a successful /eval response.
 * - undefined / null / "" / {} / []  → empty (caller prints nothing)
 * - string → raw (no JSON quotes)
 * - everything else → JSON
 */
function renderResult(v: unknown): string {
  const s = serialize(v);
  if (s === undefined || s === null) return '';
  if (typeof s === 'string') return s;
  if (Array.isArray(s) && s.length === 0) return '';
  if (typeof s === 'object' && s !== null && Object.keys(s as object).length === 0) return '';
  return JSON.stringify(s);
}

export function startReplServer(): void {
  const session = new Session();
  const resourceSessionId = process.env.BU_SESSION_ID ?? 'unknown';
  const assignedTargetId = process.env.BU_TARGET_ID ?? '';
  const port = Number(process.env.CDP_REPL_PORT ?? 9876);
  const evalTimeoutMs = boundedTimeoutMs(
    process.env.CDP_EVAL_TIMEOUT_MS,
    DEFAULT_EVAL_TIMEOUT_MS,
    MIN_EVAL_TIMEOUT_MS,
    MAX_EVAL_TIMEOUT_MS,
  );
  const startedAt = Date.now();
  let evalInFlight = false;
  let recycling = false;

  (globalThis as any).session = session;
  // Bind helpers to the singleton session so the agent calls
  // `listPageTargets()` with no host/port confusion.
  (globalThis as any).listPageTargets = () => listPageTargets(session);
  (globalThis as any).resolveWsUrl = resolveWsUrl;
  (globalThis as any).detectBrowsers = detectBrowsers;
  (globalThis as any).CDP = Generated;

  async function connectToAssignedTarget(): Promise<{ targetId: string; port: number; sessionId: string | null }> {
    const targetId = process.env.BU_TARGET_ID;
    const assignedPort = Number(process.env.BU_CDP_PORT ?? 9222);
    if (!targetId) throw new Error('BU_TARGET_ID is required');
    if (!Number.isFinite(assignedPort)) throw new Error(`invalid BU_CDP_PORT: ${process.env.BU_CDP_PORT}`);

    if (!session.isConnected()) {
      await session.connect({ port: assignedPort, targetId });
    } else {
      try {
        await session.use(targetId);
      } catch {
        session.close();
        await session.connect({ port: assignedPort, targetId });
      }
    }

    await Promise.all([
      session.Page.enable().catch(() => {}),
      session.DOM.enable().catch(() => {}),
      session.Runtime.enable().catch(() => {}),
      session.Network.enable().catch(() => {}),
    ]);

    return { targetId, port: assignedPort, sessionId: session.getActiveSession() ?? null };
  }

  (globalThis as any).connectToAssignedTarget = connectToAssignedTarget;

  let server: ReturnType<typeof Bun.serve>;
  const recycleAfterResponse = () => {
    if (recycling) return;
    recycling = true;
    // Promise.race cannot cancel arbitrary evaluated JavaScript. Terminating
    // this small per-conversation process is the only reliable way to discard
    // late global mutations and reject every pending CDP command.
    setTimeout(() => {
      server.stop(true);
      session.close();
      process.exit(124);
    }, 100);
  };

  server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === 'GET' && url.pathname === '/health') {
        return Response.json({
          ok: true,
          uptime: Math.floor((Date.now() - startedAt) / 1000),
          connected: session.isConnected(),
          sessionId: session.getActiveSession() ?? null,
          resourceSessionId,
          targetId: assignedTargetId,
          evalInFlight,
        });
      }

      if (req.method === 'POST' && url.pathname === '/eval') {
        const code = await req.text();
        if (!code.trim()) {
          return new Response('empty body\n', { status: 400, headers: TEXT });
        }
        if (recycling) {
          return new Response('REPL is recycling after a timed-out eval\n', { status: 503, headers: TEXT });
        }
        if (evalInFlight) {
          return new Response('another eval is still running\n', { status: 409, headers: TEXT });
        }
        evalInFlight = true;
        try {
          const result = await runSnippetWithTimeout(code, evalTimeoutMs, recycleAfterResponse);
          const body = renderResult(result);
          return new Response(body, { status: 200, headers: TEXT });
        } catch (e: any) {
          const msg = (e?.stack ?? e?.message ?? String(e)) + '\n';
          const status = e instanceof EvalTimeoutError ? 504 : 500;
          return new Response(msg, { status, headers: TEXT });
        } finally {
          evalInFlight = false;
        }
      }

      if (req.method === 'POST' && url.pathname === '/quit') {
        // Delay shutdown so the response flushes over the wire first.
        setTimeout(() => { server.stop(true); session.close(); process.exit(0); }, 50);
        return Response.json({ ok: true });
      }

      return new Response('not found', { status: 404 });
    },
  });

  console.log(JSON.stringify({
    ok: true,
    ready: true,
    port: server.port,
    evalTimeoutMs,
    message: `CDP REPL listening on http://127.0.0.1:${server.port}`,
  }));
}

if (import.meta.main) startReplServer();
