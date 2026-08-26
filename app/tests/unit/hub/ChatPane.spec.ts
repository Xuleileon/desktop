import { describe, expect, it } from 'vitest';
import { isTerminalChatSession } from '../../../src/renderer/hub/chat/ChatPane';

describe('isTerminalChatSession', () => {
  it('keeps the composer available for resumable stopped sessions', () => {
    expect(isTerminalChatSession('stopped', true)).toBe(false);
  });

  it('treats inactive sessions without a provider resume id as terminal', () => {
    expect(isTerminalChatSession('stopped', false)).toBe(true);
    expect(isTerminalChatSession('idle', undefined)).toBe(true);
  });

  it('keeps active sessions available before a provider resume id arrives', () => {
    expect(isTerminalChatSession('running', false)).toBe(false);
    expect(isTerminalChatSession('paused', true)).toBe(false);
  });
});
