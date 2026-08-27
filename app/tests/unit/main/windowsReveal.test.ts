import { describe, expect, it } from 'vitest';
import { windowsExplorerOpenSpec } from '../../../src/main/windowsReveal';

describe('windowsExplorerOpenSpec', () => {
  const directory = 'C:\\Users\\example\\AppData\\Roaming\\Browser Use\\harness\\outputs\\run-123';
  const file = `${directory}\\result.json`;

  it('opens a directory directly instead of trying to select it', () => {
    expect(windowsExplorerOpenSpec(directory, true)).toEqual({
      openPath: directory,
      args: [directory],
    });
  });

  it('opens the parent directory for a file path containing spaces', () => {
    expect(windowsExplorerOpenSpec(file, false)).toEqual({
      openPath: directory,
      args: [directory],
    });
  });
});
