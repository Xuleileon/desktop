import fs from 'node:fs';
import { activityEventsPath } from './activityPaths';

const DEFAULT_WINDOW_DAYS = 7;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 30;
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;
const DEFAULT_MAX_SAMPLE_GAP_MS = 2 * 60 * 1000;

export interface ActivitySummaryApp {
  appKey: string;
  appName: string;
  bundleId?: string;
  iconDataUrl?: string;
  totalMs: number;
  percent: number;
  switchCount: number;
  lastSeenAt?: string;
  lastWindowTitle?: string;
}

export interface ActivitySummaryDayApp {
  appKey: string;
  durationMs: number;
}

export interface ActivitySummaryDay {
  date: string;
  totalMs: number;
  apps: ActivitySummaryDayApp[];
}

export interface ActivityUsageSummary {
  filePath: string;
  fileExists: boolean;
  generatedAt: string;
  windowDays: number;
  totalMs: number;
  sampleCount: number;
  parseErrorCount: number;
  truncated: boolean;
  startAt?: string;
  endAt?: string;
  apps: ActivitySummaryApp[];
  daily: ActivitySummaryDay[];
}

interface ActivitySummaryOptions {
  userDataPath: string;
  windowDays?: number;
  now?: Date;
  maxBytes?: number;
  maxSampleGapMs?: number;
}

interface ActivitySampleForSummary {
  capturedAt: string;
  atMs: number;
  appKey: string;
  appName: string;
  bundleId?: string;
  windowTitle?: string;
}

interface AppAccumulator {
  appKey: string;
  appName: string;
  bundleId?: string;
  totalMs: number;
  switchCount: number;
  lastSeenAt?: string;
  lastWindowTitle?: string;
}

interface ParsedActivityEvents {
  records: Record<string, unknown>[];
  parseErrorCount: number;
  truncated: boolean;
  fileExists: boolean;
}

export function readActivityUsageSummary(options: ActivitySummaryOptions): ActivityUsageSummary {
  const filePath = activityEventsPath(options.userDataPath);
  const parsed = readActivityEventRecords(filePath, options.maxBytes ?? DEFAULT_MAX_BYTES);
  return buildActivityUsageSummary(parsed.records, {
    filePath,
    fileExists: parsed.fileExists,
    now: options.now,
    parseErrorCount: parsed.parseErrorCount,
    truncated: parsed.truncated,
    windowDays: options.windowDays,
    maxSampleGapMs: options.maxSampleGapMs,
  });
}

export function buildActivityUsageSummary(
  records: Record<string, unknown>[],
  options: {
    filePath?: string;
    fileExists?: boolean;
    now?: Date;
    parseErrorCount?: number;
    truncated?: boolean;
    windowDays?: number;
    maxSampleGapMs?: number;
  } = {},
): ActivityUsageSummary {
  const now = options.now ?? new Date();
  const windowDays = clampWindowDays(options.windowDays);
  const rangeStartMs = startOfLocalDay(addLocalDays(now, -(windowDays - 1))).getTime();
  const dayMap = makeEmptyDayMap(now, windowDays);
  const apps = new Map<string, AppAccumulator>();
  const samples = records
    .map(parseSampleRecord)
    .filter((sample): sample is ActivitySampleForSummary => Boolean(sample))
    .sort((a, b) => a.atMs - b.atMs);

  for (const record of records) {
    const to = parseAppSwitchTo(record);
    if (!to) continue;
    const app = ensureApp(apps, to.appKey, to.appName, to.bundleId);
    app.switchCount += 1;
  }

  const maxSampleGapMs = options.maxSampleGapMs ?? DEFAULT_MAX_SAMPLE_GAP_MS;
  let startAt: string | undefined;
  let endAt: string | undefined;

  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    if (!startAt) startAt = sample.capturedAt;
    endAt = sample.capturedAt;

    const app = ensureApp(apps, sample.appKey, sample.appName, sample.bundleId);
    app.lastSeenAt = sample.capturedAt;
    app.lastWindowTitle = sample.windowTitle ?? app.lastWindowTitle;

    const nextMs = i + 1 < samples.length ? samples[i + 1].atMs : now.getTime();
    const durationMs = nextMs - sample.atMs;
    if (durationMs <= 0 || durationMs > maxSampleGapMs) continue;
    addDuration(apps, dayMap, sample, Math.max(sample.atMs, rangeStartMs), nextMs);
  }

  const appSummaries = [...apps.values()]
    .filter((app) => app.totalMs > 0 || app.switchCount > 0)
    .sort((a, b) => b.totalMs - a.totalMs || a.appName.localeCompare(b.appName));

  const totalMs = appSummaries.reduce((sum, app) => sum + app.totalMs, 0);

  return {
    filePath: options.filePath ?? '',
    fileExists: options.fileExists ?? true,
    generatedAt: now.toISOString(),
    windowDays,
    totalMs,
    sampleCount: samples.length,
    parseErrorCount: options.parseErrorCount ?? 0,
    truncated: options.truncated ?? false,
    startAt,
    endAt,
    apps: appSummaries.map((app) => ({
      appKey: app.appKey,
      appName: app.appName,
      bundleId: app.bundleId,
      totalMs: app.totalMs,
      percent: totalMs > 0 ? app.totalMs / totalMs : 0,
      switchCount: app.switchCount,
      lastSeenAt: app.lastSeenAt,
      lastWindowTitle: app.lastWindowTitle,
    })),
    daily: [...dayMap.entries()].map(([date, dayApps]) => {
      const dayEntries = [...dayApps.entries()]
        .map(([appKey, durationMs]) => ({ appKey, durationMs }))
        .filter((entry) => entry.durationMs > 0)
        .sort((a, b) => b.durationMs - a.durationMs);
      return {
        date,
        totalMs: dayEntries.reduce((sum, entry) => sum + entry.durationMs, 0),
        apps: dayEntries,
      };
    }),
  };
}

function readActivityEventRecords(filePath: string, maxBytes: number): ParsedActivityEvents {
  if (!fs.existsSync(filePath)) {
    return {
      records: [],
      parseErrorCount: 0,
      truncated: false,
      fileExists: false,
    };
  }

  const stat = fs.statSync(filePath);
  const truncated = stat.size > maxBytes;
  const offset = truncated ? stat.size - maxBytes : 0;
  const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, buffer.length, offset);
  } finally {
    fs.closeSync(fd);
  }

  let text = buffer.toString('utf8');
  if (truncated) {
    const firstNewline = text.indexOf('\n');
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
  }

  const records: Record<string, unknown>[] = [];
  let parseErrorCount = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed)) records.push(parsed);
      else parseErrorCount += 1;
    } catch {
      parseErrorCount += 1;
    }
  }

  return {
    records,
    parseErrorCount,
    truncated,
    fileExists: true,
  };
}

function parseSampleRecord(record: Record<string, unknown>): ActivitySampleForSummary | null {
  if (record.type !== 'activity.sample') return null;
  const sample = objectField(record, 'sample');
  if (!sample) return null;
  const capturedAt = stringField(sample, 'capturedAt') ?? stringField(record, 'at');
  const appName = stringField(sample, 'appName');
  if (!capturedAt || !appName) return null;
  const atMs = new Date(capturedAt).getTime();
  if (!Number.isFinite(atMs)) return null;
  const bundleId = stringField(sample, 'bundleId') ?? undefined;
  return {
    capturedAt,
    atMs,
    appKey: bundleId || appName,
    appName,
    bundleId,
    windowTitle: stringField(sample, 'windowTitle') ?? undefined,
  };
}

function parseAppSwitchTo(record: Record<string, unknown>): { appKey: string; appName: string; bundleId?: string } | null {
  if (record.type !== 'activity.app_switch') return null;
  const to = objectField(record, 'to');
  if (!to) return null;
  const appName = stringField(to, 'appName');
  if (!appName) return null;
  const bundleId = stringField(to, 'bundleId') ?? undefined;
  return {
    appKey: bundleId || appName,
    appName,
    bundleId,
  };
}

function addDuration(
  apps: Map<string, AppAccumulator>,
  dayMap: Map<string, Map<string, number>>,
  sample: ActivitySampleForSummary,
  startMs: number,
  endMs: number,
): void {
  if (endMs <= startMs) return;
  const app = ensureApp(apps, sample.appKey, sample.appName, sample.bundleId);
  const durationMs = endMs - startMs;
  app.totalMs += durationMs;

  let cursor = startMs;
  while (cursor < endMs) {
    const nextMidnightMs = nextLocalMidnightMs(cursor);
    const segmentEnd = Math.min(endMs, nextMidnightMs);
    const date = localDateKey(new Date(cursor));
    const day = dayMap.get(date);
    if (day) day.set(sample.appKey, (day.get(sample.appKey) ?? 0) + (segmentEnd - cursor));
    cursor = segmentEnd;
  }
}

function ensureApp(
  apps: Map<string, AppAccumulator>,
  appKey: string,
  appName: string,
  bundleId?: string,
): AppAccumulator {
  const existing = apps.get(appKey);
  if (existing) {
    existing.appName = appName || existing.appName;
    existing.bundleId = bundleId ?? existing.bundleId;
    return existing;
  }
  const next: AppAccumulator = {
    appKey,
    appName,
    bundleId,
    totalMs: 0,
    switchCount: 0,
  };
  apps.set(appKey, next);
  return next;
}

function makeEmptyDayMap(now: Date, windowDays: number): Map<string, Map<string, number>> {
  const days = new Map<string, Map<string, number>>();
  const start = startOfLocalDay(addLocalDays(now, -(windowDays - 1)));
  for (let i = 0; i < windowDays; i += 1) {
    days.set(localDateKey(addLocalDays(start, i)), new Map());
  }
  return days;
}

function clampWindowDays(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_WINDOW_DAYS;
  return Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, Math.round(value ?? DEFAULT_WINDOW_DAYS)));
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function nextLocalMidnightMs(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

function localDateKey(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function objectField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return isRecord(record[key]) ? record[key] : null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
