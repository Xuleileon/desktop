import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyBrowserHarnessEnv, browserHarnessReplPort } from '../../../src/main/hl/engines/browserHarnessEnv';
import type { SpawnContext } from '../../../src/main/hl/engines/types';

function spawnContext(targetId: string): SpawnContext {
  return {
    prompt: 'Open example.com',
    harnessDir: '/tmp/harness',
    sessionId: 'session-123',
    targetId,
    cdpPort: 9222,
    attachmentRefs: [],
  };
}

describe('browser harness environment', () => {
  it('scopes the REPL port to the assigned target as well as the app session', () => {
    const firstTarget = browserHarnessReplPort('session-123', 'target-a');
    const secondTarget = browserHarnessReplPort('session-123', 'target-b');

    expect(browserHarnessReplPort('session-123', 'target-a')).toBe(firstTarget);
    expect(secondTarget).not.toBe(firstTarget);
  });

  it('gives reruns with a replacement browser target a fresh REPL port', () => {
    const firstEnv = applyBrowserHarnessEnv(spawnContext('old-target'), {});
    const rerunEnv = applyBrowserHarnessEnv(spawnContext('new-target'), {});

    expect(firstEnv.CDP_REPL_PORT).toBe(browserHarnessReplPort('session-123', 'old-target'));
    expect(rerunEnv.CDP_REPL_PORT).toBe(browserHarnessReplPort('session-123', 'new-target'));
    expect(rerunEnv.CDP_REPL_PORT).not.toBe(firstEnv.CDP_REPL_PORT);
  });

  it('replaces inherited REPL ownership values from the desktop launch environment', () => {
    const env = applyBrowserHarnessEnv(spawnContext('target-a'), {
      CDP_REPL_PORT: '19876',
      CDP_REPL_LOG: '/tmp/previous-session.log',
    });

    expect(env.CDP_REPL_PORT).toBe(browserHarnessReplPort('session-123', 'target-a'));
    expect(env.CDP_REPL_LOG).toBe(path.join('/tmp/harness', 'browser-harness-js-session-123.log'));
  });

  it('puts provider-neutral agent-skill and Browser Harness JS CLIs on PATH', () => {
    const env = applyBrowserHarnessEnv(spawnContext('target-a'), { PATH: '/usr/bin' });

    expect(env.PATH?.split(path.delimiter).slice(0, 3)).toEqual([
      path.join('/tmp/harness', 'agent-skill'),
      path.join('/tmp/harness', 'browser-harness-js', 'sdk'),
      '/usr/bin',
    ]);
  });

  it('preserves the canonical Windows Path key without creating a duplicate PATH', () => {
    const env = applyBrowserHarnessEnv(spawnContext('target-a'), {
      Path: 'C:\\Program Files\\nodejs;C:\\Windows\\System32',
    });

    expect(env.Path?.split(path.delimiter).slice(-2)).toEqual([
      'C:\\Program Files\\nodejs',
      'C:\\Windows\\System32',
    ]);
    expect(env.PATH).toBeUndefined();
  });
});
