/**
 * `chatfile://` protocol — serves files that live under the harness outputs dir
 * so the renderer can `<img src="chatfile:///abs/path">` screenshots and other
 * agent-produced media without granting blanket filesystem access.
 *
 * Security: the requested abs path is canonicalized, then required to live
 * under `<harnessDir>/outputs/`. Anything else returns 403. Symlink escapes are
 * blocked by `fs.realpathSync`.
 *
 * Register order matters in Electron: `registerSchemesAsPrivileged` MUST run
 * before `app.whenReady`, while `protocol.handle` must run after.
 */

import { protocol, net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mainLogger } from '../logger';
import { harnessDir } from '../hl/harness';

export const CHATFILE_SCHEME = 'chatfile';

function withTrailingSep(p: string): string {
  return p.endsWith(path.sep) ? p : p + path.sep;
}

export function registerChatfilePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: CHATFILE_SCHEME,
      privileges: {
        // `standard: true` makes the URL parser treat `chatfile://` like http —
        // so `chatfile:///abs/path` reliably parses with hostname="" and
        // pathname="/abs/path" rather than the looser opaque-path semantics
        // non-standard schemes get.
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: false,
        stream: true,
      },
    },
  ]);
}

export function registerChatfileHandler(): void {
  const configuredRoot = path.resolve(path.join(harnessDir(), 'outputs'));
  let canonicalRoot: string | null = null;

  const getRoot = (): string => {
    if (canonicalRoot) return canonicalRoot;
    try {
      canonicalRoot = withTrailingSep(fs.realpathSync(configuredRoot));
    } catch {
      canonicalRoot = withTrailingSep(configuredRoot);
    }
    return canonicalRoot;
  };

  protocol.handle(CHATFILE_SCHEME, async (req) => {
    let absPath: string;
    try {
      const url = new URL(req.url);
      // Renderer URLs carry the absolute path in a query parameter. Putting a
      // Windows path directly after the authority (for example `filesC:\\...`)
      // makes Chromium parse the drive letter as part of the host and reduces
      // pathname to `/`.
      const encodedPath = url.searchParams.get('path');
      absPath = encodedPath ?? decodeURIComponent(url.pathname);
      if (process.platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(absPath)) {
        absPath = absPath.slice(1);
      }
    } catch (err) {
      mainLogger.warn('chatfile.badUrl', { url: req.url, error: (err as Error).message });
      return new Response('bad url', { status: 400 });
    }

    let realPath: string;
    try {
      realPath = fs.realpathSync(absPath);
    } catch (err) {
      mainLogger.warn('chatfile.notFound', { url: req.url, absPath, error: (err as Error).message });
      return new Response('not found', { status: 404 });
    }

    const root = getRoot();
    if (!realPath.startsWith(root)) {
      mainLogger.warn('chatfile.deniedOutsideRoot', { requested: absPath, realPath, root });
      return new Response('forbidden', { status: 403 });
    }

    // Use pathToFileURL so paths containing spaces ("Application Support") and
    // other URL-significant chars get encoded correctly.
    return net.fetch(pathToFileURL(realPath).toString());
  });

  mainLogger.info('chatfile.registered', { root: configuredRoot });
}
