type HeaderMap = Record<string, string>;

export interface BrowserIdentity {
  userAgent: string;
  chromiumVersion: string;
  jsPlatform: string;
  platformLabel: string;
  acceptLanguageHeader: string;
  acceptLanguageOverride: string;
  language: string;
  languages: string[];
}

function chromiumVersion(version = process.versions.chrome ?? '146.0.0.0'): string {
  return /^\d+\.\d+\.\d+\.\d+$/.test(version) ? version : '146.0.0.0';
}

function platformParts(platform: NodeJS.Platform): Pick<BrowserIdentity, 'jsPlatform' | 'platformLabel'> & { uaPlatform: string } {
  if (platform === 'win32') {
    return {
      uaPlatform: 'Windows NT 10.0; Win64; x64',
      jsPlatform: 'Win32',
      platformLabel: 'Windows',
    };
  }
  if (platform === 'linux') {
    return {
      uaPlatform: 'X11; Linux x86_64',
      jsPlatform: 'Linux x86_64',
      platformLabel: 'Linux',
    };
  }
  return {
    uaPlatform: 'Macintosh; Intel Mac OS X 10.15',
    jsPlatform: 'MacIntel',
    platformLabel: 'macOS',
  };
}

export function buildBrowserIdentity(opts: {
  chromiumVersion?: string;
  platform?: NodeJS.Platform;
} = {}): BrowserIdentity {
  const version = chromiumVersion(opts.chromiumVersion);
  const major = version.split('.')[0];
  const platform = platformParts(opts.platform ?? process.platform);
  // Keep the public identity coherent with Electron's actual Chromium engine.
  // Pretending Chromium is Firefox creates contradictions across UA, TLS,
  // WebGL and the exposed web-platform feature set that are easier to detect
  // than a normal, reduced Chrome UA.
  const userAgent = `Mozilla/5.0 (${platform.uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  return {
    userAgent,
    chromiumVersion: version,
    jsPlatform: platform.jsPlatform,
    platformLabel: platform.platformLabel,
    acceptLanguageHeader: 'zh-CN,zh;q=0.9,en;q=0.8',
    acceptLanguageOverride: 'zh-CN,zh,en',
    language: 'zh-CN',
    languages: ['zh-CN', 'zh', 'en'],
  };
}

function setHeader(headers: HeaderMap, name: string, value: string): void {
  const existing = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  headers[existing ?? name] = value;
}

function hasHeader(headers: HeaderMap, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

export function withBrowserIdentityHeaders(headers: HeaderMap, identity = buildBrowserIdentity()): HeaderMap {
  const next = { ...headers };
  setHeader(next, 'User-Agent', identity.userAgent);
  setHeader(next, 'Accept-Language', identity.acceptLanguageHeader);
  // Keep native hint coverage, but never leak an Electron brand. Do not add
  // hints Chromium did not request; only normalize the two brand-bearing
  // fields when they are already present.
  const major = identity.chromiumVersion.split('.')[0];
  if (hasHeader(next, 'sec-ch-ua')) {
    setHeader(next, 'sec-ch-ua', `"Not_A Brand";v="99", "Chromium";v="${major}"`);
  }
  if (hasHeader(next, 'sec-ch-ua-full-version-list')) {
    setHeader(next, 'sec-ch-ua-full-version-list', `"Not_A Brand";v="99.0.0.0", "Chromium";v="${identity.chromiumVersion}"`);
  }
  return next;
}
