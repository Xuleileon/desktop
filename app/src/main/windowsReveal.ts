import path from 'node:path';

export interface WindowsExplorerOpenSpec {
  openPath: string;
  args: string[];
}

/**
 * Explorer's `/select` parser is not reliable for paths containing spaces.
 * Open an existing directory instead: the requested directory itself, or the
 * parent directory of a requested file.
 */
export function windowsExplorerOpenSpec(
  resolvedPath: string,
  isDirectory: boolean,
): WindowsExplorerOpenSpec {
  const openPath = isDirectory ? resolvedPath : path.win32.dirname(resolvedPath);
  return {
    openPath,
    // Let Node quote this single argv entry. Explorer's `/select` parser and
    // Electron shell.openPath both produced native "Location unavailable"
    // dialogs for Browser Use paths containing spaces on Windows.
    args: [openPath],
  };
}
