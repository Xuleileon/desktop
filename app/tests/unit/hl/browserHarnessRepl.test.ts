import { describe, expect, it, vi } from 'vitest';

const modulePath = '../../../src/main/hl/stock/browser-harness-js/sdk/repl.ts';
const { EvalTimeoutError, runSnippet, runSnippetWithTimeout } = await import(modulePath);

describe('Browser Harness REPL eval bounds', () => {
  it('keeps normal snippet evaluation behavior', async () => {
    await expect(runSnippet('1 + 2')).resolves.toBe(3);
    await expect(runSnippet('const value = 4; return value * 2')).resolves.toBe(8);
  });

  it('fails a non-settling eval at the deadline and requests a fatal recycle', async () => {
    const recycle = vi.fn();

    await expect(runSnippetWithTimeout('await new Promise(() => {})', 20, recycle))
      .rejects.toEqual(expect.any(EvalTimeoutError));
    expect(recycle).toHaveBeenCalledTimes(1);
  });
});
