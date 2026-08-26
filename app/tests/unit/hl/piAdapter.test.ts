import { describe, expect, it, vi } from 'vitest';
import type { EngineAdapter, ParseContext, SpawnContext } from '../../../src/main/hl/engines/types';

vi.mock('../../../src/main/logger', () => ({
  mainLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { get } = await import('../../../src/main/hl/engines/registry');
await import('../../../src/main/hl/engines/pi/adapter');

function adapter(): EngineAdapter {
  const value = get('pi');
  if (!value) throw new Error('Pi adapter not registered');
  return value;
}

function spawnContext(): SpawnContext {
  return {
    prompt: 'Open example.com',
    harnessDir: '/tmp/harness',
    sessionId: '11111111-1111-4111-8111-111111111111',
    targetId: 'target-1',
    cdpPort: 9222,
    model: 'openai-codex/gpt-5.6-sol',
    attachmentRefs: [],
  };
}

function parseContext(): ParseContext {
  return {
    iter: 0,
    pendingTools: new Map(),
    harnessHelpersPath: '/tmp/harness/helpers.js',
    harnessToolsPath: '/tmp/harness/TOOLS.json',
    harnessSkillPath: '/tmp/harness/AGENTS.md',
  };
}

describe('Pi adapter', () => {
  it('uses JSON print mode, stdin and the custom model without disabling Pi extensions', () => {
    const value = adapter();
    const ctx = spawnContext();
    const prompt = value.wrapPrompt(ctx);
    expect(value.buildSpawnArgs(ctx, prompt)).toEqual([
      '--print', '--mode', 'json', '--approve',
      '--session-id', ctx.sessionId,
      '--model', 'openai-codex/gpt-5.6-sol',
    ]);
    expect(value.getStdinPayload?.(ctx, prompt)).toBe(prompt);
  });

  it('translates session, tool and completion events', () => {
    const value = adapter();
    const ctx = parseContext();
    expect(value.parseLine(JSON.stringify({ type: 'session', id: 'pi-session' }), ctx).capturedSessionId).toBe('pi-session');
    expect(value.parseLine(JSON.stringify({ type: 'turn_start' }), ctx).events).toEqual([]);
    expect(ctx.iter).toBe(1);

    expect(value.parseLine(JSON.stringify({
      type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'echo ok' },
    }), ctx).events).toEqual([{ type: 'tool_call', name: 'bash', args: { command: 'echo ok' }, iteration: 1 }]);

    expect(value.parseLine(JSON.stringify({
      type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false,
    }), ctx).events[0]).toMatchObject({ type: 'tool_result', name: 'bash', ok: true, preview: 'ok' });

    value.parseLine(JSON.stringify({
      type: 'message_end', message: { role: 'assistant', model: 'gpt-5.6-sol', content: [{ type: 'text', text: 'Finished' }] },
    }), ctx);
    expect(value.parseLine(JSON.stringify({ type: 'agent_end', messages: [], willRetry: false }), ctx)).toEqual({
      events: [{ type: 'done', summary: 'Finished', iterations: 1 }],
      terminalDone: true,
    });
  });

  it('keeps Pi reasoning separate from streamed answer text', () => {
    const value = adapter();
    const ctx = parseContext();
    const thinking = value.parseLine(JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'checking cookies' },
    }), ctx);
    const text = value.parseLine(JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Final answer' },
    }), ctx);

    expect(thinking.events).toEqual([{ type: 'thinking', text: 'checking cookies' }]);
    expect(text.events).toEqual([{ type: 'text', text: 'Final answer' }]);
  });

  it('surfaces terminal errors carried only by agent_end', () => {
    const value = adapter();
    const ctx = parseContext();
    const result = value.parseLine(JSON.stringify({
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'error', errorMessage: '400 invalid max_tokens' }],
      willRetry: false,
    }), ctx);
    expect(result).toEqual({
      events: [{ type: 'error', message: '400 invalid max_tokens' }],
      terminalError: '400 invalid max_tokens',
    });
  });

  it('surfaces exhausted auto retries', () => {
    const value = adapter();
    const result = value.parseLine(JSON.stringify({
      type: 'auto_retry_end', success: false, finalError: 'provider unavailable',
    }), parseContext());
    expect(result.terminalError).toBe('provider unavailable');
    expect(result.events).toEqual([{ type: 'error', message: 'provider unavailable' }]);
  });
});
