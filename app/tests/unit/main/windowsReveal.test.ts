import { describe, expect, it } from 'vitest';
import { windowsExplorerRevealSpec } from '../../../src/main/windowsReveal';

describe('windowsExplorerRevealSpec', () => {
  const directory = 'C:\\Users\\dingx\\AppData\\Roaming\\Browser Use\\harness\\outputs\\run-123';
  const file = `${directory}\\result.json`;

  it('opens a directory directly instead of trying to select it', () => {
    expect(windowsExplorerRevealSpec(directory, true)).toEqual({
      args: [directory],
      mode: 'open-directory',
    });
  });

  it('keeps /select and the quoted file path in one verbatim argument', () => {
    expect(windowsExplorerRevealSpec(file, false)).toEqual({
      args: [`/select,"${file}"`],
      mode: 'select-file',
      windowsVerbatimArguments: true,
    });
  });
});
