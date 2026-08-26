import { describe, expect, it } from 'vitest';
import {
  buildBrowserIdentity,
  withBrowserIdentityHeaders,
} from '../../../src/main/sessions/browserIdentity';

describe('browser identity', () => {
  it('builds a coherent reduced Chrome identity for macOS', () => {
    const identity = buildBrowserIdentity({
      chromiumVersion: '146.0.7680.188',
      platform: 'darwin',
    });

    expect(identity.userAgent).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    );
    expect(identity.chromiumVersion).toBe('146.0.7680.188');
    expect(identity.userAgent).not.toContain('Electron');
    expect(identity.userAgent).not.toContain('BrowserUse');
    expect(identity.userAgent).toContain('Chrome/146.0.0.0');
    expect(identity.jsPlatform).toBe('MacIntel');
    expect(identity.platformLabel).toBe('macOS');
  });

  it('sets coherent request headers and preserves native Chromium client hints', () => {
    const identity = buildBrowserIdentity({
      chromiumVersion: '146.0.7680.188',
      platform: 'win32',
    });

    const headers = withBrowserIdentityHeaders({
      Accept: 'text/html',
      'user-agent': 'Electron UA',
      'sec-ch-ua': '"Electron";v="41"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-ch-ua-arch': '"x86"',
      'sec-ch-ua-full-version-list': '"Electron";v="41.0.0.0"',
      'sec-ch-ua-form-factors': '"Unknown"',
      'sec-ch-ua-platform-version': '"15.0.0"',
    }, identity);

    expect(headers.Accept).toBe('text/html');
    expect(headers['user-agent']).toBe(identity.userAgent);
    expect(headers['sec-ch-ua']).toBe('"Not_A Brand";v="99", "Chromium";v="146"');
    expect(headers['sec-ch-ua-mobile']).toBe('?0');
    expect(headers['sec-ch-ua-platform']).toBe('"Windows"');
    expect(headers['sec-ch-ua-arch']).toBe('"x86"');
    expect(headers['sec-ch-ua-full-version-list']).toBe('"Not_A Brand";v="99.0.0.0", "Chromium";v="146.0.7680.188"');
    expect(headers['Accept-Language']).toBe('zh-CN,zh;q=0.9,en;q=0.8');
    expect(identity.acceptLanguageOverride).toBe('zh-CN,zh,en');
    expect(identity.languages).toEqual(['zh-CN', 'zh', 'en']);
  });

  it('builds platform-specific Chrome user agents', () => {
    const identity = buildBrowserIdentity({
      chromiumVersion: '146.0.7680.188',
      platform: 'linux',
    });

    expect(identity.userAgent).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    );
    expect(identity.jsPlatform).toBe('Linux x86_64');
    expect(identity.platformLabel).toBe('Linux');
  });

  it('does not invent client hints when none were present', () => {
    const identity = buildBrowserIdentity({
      chromiumVersion: '146.0.7680.188',
      platform: 'darwin',
    });

    const headers = withBrowserIdentityHeaders({ Accept: 'text/html' }, identity);

    expect(headers['User-Agent']).toBe(identity.userAgent);
    expect(headers['sec-ch-ua']).toBeUndefined();
    expect(headers['sec-ch-ua-full-version-list']).toBeUndefined();
    expect(headers['sec-ch-ua-platform-version']).toBeUndefined();
  });

});
