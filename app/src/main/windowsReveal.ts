export interface WindowsExplorerRevealSpec {
  args: string[];
  mode: 'open-directory' | 'select-file';
  windowsVerbatimArguments?: boolean;
}

/**
 * Build the command line expected by Explorer's non-standard argument parser.
 * `/select,` and the quoted file path must be one verbatim argument; passing
 * them as two argv entries makes Explorer treat the parent directory as an
 * unavailable location on paths containing spaces.
 */
export function windowsExplorerRevealSpec(
  resolvedPath: string,
  isDirectory: boolean,
): WindowsExplorerRevealSpec {
  if (isDirectory) {
    return {
      args: [resolvedPath],
      mode: 'open-directory',
    };
  }

  return {
    args: [`/select,"${resolvedPath}"`],
    mode: 'select-file',
    windowsVerbatimArguments: true,
  };
}
