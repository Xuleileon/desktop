import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app as electronApp, nativeImage } from 'electron';
import type { ActivitySummaryApp, ActivityUsageSummary } from './activitySummary';

const APP_PATH_CACHE = new Map<string, string | null>();
const ICON_DATA_URL_CACHE = new Map<string, string | null>();

export async function withActivityAppIcons(summary: ActivityUsageSummary): Promise<ActivityUsageSummary> {
  if (process.platform !== 'darwin') return summary;

  const apps = await Promise.all(summary.apps.map(async (app) => ({
    ...app,
    iconDataUrl: await loadActivityAppIcon(app),
  })));

  return {
    ...summary,
    apps,
  };
}

async function loadActivityAppIcon(app: ActivitySummaryApp): Promise<string | undefined> {
  const cacheKey = app.bundleId || app.appName;
  const cachedIcon = ICON_DATA_URL_CACHE.get(cacheKey);
  if (cachedIcon !== undefined) return cachedIcon ?? undefined;

  const appPath = await resolveActivityAppPath(app);
  if (!appPath) {
    ICON_DATA_URL_CACHE.set(cacheKey, null);
    return undefined;
  }

  try {
    const bundleIconDataUrl = await loadIconDataUrlFromAppBundle(appPath);
    if (bundleIconDataUrl) {
      ICON_DATA_URL_CACHE.set(cacheKey, bundleIconDataUrl);
      return bundleIconDataUrl;
    }

    const icon = await electronApp.getFileIcon(appPath, { size: 'normal' });
    if (icon.isEmpty()) {
      ICON_DATA_URL_CACHE.set(cacheKey, null);
      return undefined;
    }
    const dataUrl = icon.resize({ width: 32, height: 32, quality: 'best' }).toDataURL();
    ICON_DATA_URL_CACHE.set(cacheKey, dataUrl);
    return dataUrl;
  } catch {
    ICON_DATA_URL_CACHE.set(cacheKey, null);
    return undefined;
  }
}

async function resolveActivityAppPath(app: ActivitySummaryApp): Promise<string | null> {
  const cacheKey = app.bundleId || app.appName;
  const cachedPath = APP_PATH_CACHE.get(cacheKey);
  if (cachedPath !== undefined) return cachedPath;

  const resolved = await findAppPath(app);
  APP_PATH_CACHE.set(cacheKey, resolved);
  return resolved;
}

async function findAppPath(app: ActivitySummaryApp): Promise<string | null> {
  if (app.bundleId) {
    const byBundleId = await findAppPathByBundleId(app.bundleId);
    if (byBundleId) return byBundleId;
  }
  return findAppPathByName(app.appName);
}

async function findAppPathByBundleId(bundleId: string): Promise<string | null> {
  try {
    const output = await execFileText('mdfind', [`kMDItemCFBundleIdentifier == ${JSON.stringify(bundleId)}`]);
    return firstUsableAppPath(output.split('\n'));
  } catch {
    return null;
  }
}

function findAppPathByName(appName: string): string | null {
  const candidates = [
    path.join('/Applications', `${appName}.app`),
    path.join(os.homedir(), 'Applications', `${appName}.app`),
    path.join('/System/Applications', `${appName}.app`),
    path.join('/System/Applications/Utilities', `${appName}.app`),
  ];
  return firstUsableAppPath(candidates);
}

function firstUsableAppPath(candidates: string[]): string | null {
  for (const raw of candidates) {
    const candidate = raw.trim();
    if (!candidate || !candidate.endsWith('.app')) continue;
    if (candidate.includes('/.Trash/')) continue;
    if (!fs.existsSync(candidate)) continue;
    return candidate;
  }
  return null;
}

async function loadIconDataUrlFromAppBundle(appPath: string): Promise<string | null> {
  const iconPath = await resolveBundleIconPath(appPath);
  if (!iconPath) return null;
  return convertIcnsToPngDataUrl(iconPath);
}

async function resolveBundleIconPath(appPath: string): Promise<string | null> {
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');
  const iconNames = await readBundleIconNames(appPath);
  for (const iconName of iconNames) {
    const iconPath = resolveIconResourcePath(resourcesPath, iconName);
    if (iconPath) return iconPath;
  }
  return findFirstIcns(resourcesPath);
}

async function readBundleIconNames(appPath: string): Promise<string[]> {
  const infoPath = path.join(appPath, 'Contents', 'Info.plist');
  try {
    const output = await execFileText('plutil', ['-convert', 'json', '-o', '-', infoPath]);
    const parsed = JSON.parse(output) as {
      CFBundleIconFile?: unknown;
      CFBundleIconName?: unknown;
      CFBundleIcons?: {
        CFBundlePrimaryIcon?: {
          CFBundleIconFiles?: unknown;
        };
      };
    };

    const names = new Set<string>();
    addIconName(names, parsed.CFBundleIconFile);
    const iconFiles = parsed.CFBundleIcons?.CFBundlePrimaryIcon?.CFBundleIconFiles;
    if (Array.isArray(iconFiles)) {
      for (const iconFile of iconFiles) addIconName(names, iconFile);
    }
    addIconName(names, parsed.CFBundleIconName);
    return [...names];
  } catch {
    return [];
  }
}

function addIconName(names: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed) names.add(trimmed);
}

function resolveIconResourcePath(resourcesPath: string, iconName: string): string | null {
  const candidates = path.extname(iconName)
    ? [path.join(resourcesPath, iconName)]
    : [path.join(resourcesPath, `${iconName}.icns`), path.join(resourcesPath, iconName)];
  return candidates.find((candidate) => fs.existsSync(candidate) && candidate.endsWith('.icns')) ?? null;
}

function findFirstIcns(resourcesPath: string): string | null {
  try {
    const files = fs.readdirSync(resourcesPath)
      .filter((file) => file.toLowerCase().endsWith('.icns'))
      .sort((a, b) => {
        const aPreferred = a.toLowerCase() === 'app.icns' || a.toLowerCase() === 'icon.icns';
        const bPreferred = b.toLowerCase() === 'app.icns' || b.toLowerCase() === 'icon.icns';
        if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
        return a.localeCompare(b);
      });
    const first = files[0];
    return first ? path.join(resourcesPath, first) : null;
  } catch {
    return null;
  }
}

async function convertIcnsToPngDataUrl(iconPath: string): Promise<string | null> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-app-icon-'));
  const outPath = path.join(tempDir, `${randomUUID()}.png`);
  try {
    await execFileText('sips', ['-Z', '64', '-s', 'format', 'png', iconPath, '--out', outPath]);
    const png = fs.readFileSync(outPath);
    if (png.length === 0) return null;
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) return null;
    return icon.resize({ width: 32, height: 32, quality: 'best' }).toDataURL();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 2_000, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}
