import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildActivityUsageSummary,
  readActivityUsageSummary,
  type ActivityUsageSummary,
} from '../../src/main/activitySummary';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('activity usage summary', () => {
  it('derives app totals and daily buckets from sample events', () => {
    const firstDay = new Date(2026, 4, 17, 23, 50, 0);
    const secondDay = new Date(2026, 4, 18, 0, 10, 0);
    const now = new Date(2026, 4, 18, 0, 20, 0);

    const summary = buildActivityUsageSummary([
      sample('Google Chrome', 'com.google.Chrome', firstDay),
      {
        schemaVersion: 1,
        type: 'activity.app_switch',
        at: secondDay.toISOString(),
        from: { appName: 'Google Chrome', bundleId: 'com.google.Chrome' },
        to: { appName: 'Cursor', bundleId: 'com.todesktop.230313mzl4w4u92' },
      },
      sample('Cursor', 'com.todesktop.230313mzl4w4u92', secondDay, 'agent.ts'),
    ], {
      now,
      windowDays: 2,
      maxSampleGapMs: 30 * 60_000,
    });

    expect(app(summary, 'com.google.Chrome')?.totalMs).toBe(20 * 60_000);
    expect(app(summary, 'com.todesktop.230313mzl4w4u92')?.totalMs).toBe(10 * 60_000);
    expect(app(summary, 'com.todesktop.230313mzl4w4u92')?.switchCount).toBe(1);
    expect(app(summary, 'com.todesktop.230313mzl4w4u92')?.lastWindowTitle).toBe('agent.ts');

    const yesterday = day(summary, firstDay);
    const today = day(summary, secondDay);
    expect(durationFor(yesterday, 'com.google.Chrome')).toBe(10 * 60_000);
    expect(durationFor(today, 'com.google.Chrome')).toBe(10 * 60_000);
    expect(durationFor(today, 'com.todesktop.230313mzl4w4u92')).toBe(10 * 60_000);
  });

  it('skips long gaps so sleep time is not counted as app usage', () => {
    const morning = new Date(2026, 4, 18, 9, 0, 0);
    const afternoon = new Date(2026, 4, 18, 14, 0, 0);

    const summary = buildActivityUsageSummary([
      sample('Google Chrome', 'com.google.Chrome', morning),
      sample('Cursor', 'com.todesktop.230313mzl4w4u92', afternoon),
    ], {
      now: new Date(2026, 4, 18, 14, 1, 0),
      windowDays: 1,
      maxSampleGapMs: 2 * 60_000,
    });

    expect(app(summary, 'com.google.Chrome')?.totalMs ?? 0).toBe(0);
    expect(app(summary, 'com.todesktop.230313mzl4w4u92')?.totalMs).toBe(60_000);
  });

  it('returns an empty summary when the activity file does not exist', () => {
    const userDataPath = makeTempDir();
    const summary = readActivityUsageSummary({
      userDataPath,
      now: new Date(2026, 4, 18, 12, 0, 0),
    });

    expect(summary.fileExists).toBe(false);
    expect(summary.totalMs).toBe(0);
    expect(summary.apps).toEqual([]);
    expect(summary.daily).toHaveLength(7);
  });

  it('reads JSONL from the activity file and reports malformed lines', () => {
    const userDataPath = makeTempDir();
    const filePath = path.join(userDataPath, 'activity', 'activity-events.jsonl');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const start = new Date(2026, 4, 18, 10, 0, 0);
    const end = new Date(2026, 4, 18, 10, 5, 0);
    fs.writeFileSync(filePath, [
      JSON.stringify(sample('Google Chrome', 'com.google.Chrome', start)),
      'not json',
      JSON.stringify(sample('Cursor', 'com.todesktop.230313mzl4w4u92', end)),
      '',
    ].join('\n'));

    const summary = readActivityUsageSummary({
      userDataPath,
      now: new Date(2026, 4, 18, 10, 6, 0),
      windowDays: 1,
      maxSampleGapMs: 10 * 60_000,
    });

    expect(summary.fileExists).toBe(true);
    expect(summary.parseErrorCount).toBe(1);
    expect(app(summary, 'com.google.Chrome')?.totalMs).toBe(5 * 60_000);
    expect(app(summary, 'com.todesktop.230313mzl4w4u92')?.totalMs).toBe(60_000);
  });
});

function sample(appName: string, bundleId: string, capturedAt: Date, windowTitle?: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    type: 'activity.sample',
    at: capturedAt.toISOString(),
    sample: {
      capturedAt: capturedAt.toISOString(),
      source: 'macos-jxa',
      appName,
      bundleId,
      windowTitle,
    },
  };
}

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-summary-'));
  tempDirs.push(dir);
  return dir;
}

function app(summary: ActivityUsageSummary, appKey: string) {
  return summary.apps.find((entry) => entry.appKey === appKey);
}

function day(summary: ActivityUsageSummary, date: Date) {
  const found = summary.daily.find((entry) => entry.date === localDateKey(date));
  if (!found) throw new Error(`Missing day ${localDateKey(date)}`);
  return found;
}

function durationFor(daySummary: ActivityUsageSummary['daily'][number], appKey: string): number {
  return daySummary.apps.find((entry) => entry.appKey === appKey)?.durationMs ?? 0;
}

function localDateKey(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
