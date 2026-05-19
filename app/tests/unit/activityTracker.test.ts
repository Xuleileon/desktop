import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ActivityEventRecorder,
  ActivityJsonlStore,
  parseMacActivitySnapshot,
  type ActivityEvent,
  type ActivitySnapshot,
} from '../../src/main/activityTracker';
import { activityEventsPath } from '../../src/main/activityPaths';

function sample(overrides: Partial<ActivitySnapshot>): ActivitySnapshot {
  return {
    capturedAt: '2026-05-18T10:00:00.000Z',
    source: 'macos-jxa',
    appName: 'Linear',
    bundleId: 'com.linear',
    processId: 100,
    windowTitle: 'ENG-4713',
    ...overrides,
  };
}

describe('parseMacActivitySnapshot', () => {
  test('normalizes a frontmost app snapshot with browser tab details', () => {
    const parsed = parseMacActivitySnapshot(JSON.stringify({
      capturedAt: '2026-05-18T10:00:00.000Z',
      source: 'macos-jxa',
      appName: 'Google Chrome',
      bundleId: 'com.google.Chrome',
      processId: 1234,
      windowTitle: 'Browser Use',
      browser: {
        kind: 'chromium',
        appName: 'Google Chrome',
        url: 'https://linear.app/browser-use/issue/ENG-4713/foo',
        title: 'ENG-4713',
      },
    }));

    expect(parsed).toEqual({
      capturedAt: '2026-05-18T10:00:00.000Z',
      source: 'macos-jxa',
      appName: 'Google Chrome',
      bundleId: 'com.google.Chrome',
      processId: 1234,
      windowTitle: 'Browser Use',
      browser: {
        kind: 'chromium',
        appName: 'Google Chrome',
        url: 'https://linear.app/browser-use/issue/ENG-4713/foo',
        title: 'ENG-4713',
      },
      probeError: undefined,
    });
  });

  test('throws when the macOS probe reports failure', () => {
    expect(() => parseMacActivitySnapshot(JSON.stringify({
      ok: false,
      error: 'Not authorized to send Apple events to System Events.',
    }))).toThrow('Not authorized');
  });
});

describe('ActivityEventRecorder', () => {
  test('writes samples, browser-tab changes, app intervals, and app switches', () => {
    const events: ActivityEvent[] = [];
    const recorder = new ActivityEventRecorder((event) => events.push(event));

    recorder.recordSample(sample({
      capturedAt: '2026-05-18T10:00:00.000Z',
      appName: 'Google Chrome',
      bundleId: 'com.google.Chrome',
      browser: {
        kind: 'chromium',
        appName: 'Google Chrome',
        url: 'https://linear.app/browser-use/issue/ENG-4713/foo',
        title: 'ENG-4713',
      },
    }));
    recorder.recordSample(sample({
      capturedAt: '2026-05-18T10:00:05.000Z',
      appName: 'Google Chrome',
      bundleId: 'com.google.Chrome',
      windowTitle: 'GitHub',
      browser: {
        kind: 'chromium',
        appName: 'Google Chrome',
        url: 'https://github.com/browser-use/desktop',
        title: 'browser-use/desktop',
      },
    }));
    recorder.recordSample(sample({
      capturedAt: '2026-05-18T10:00:12.000Z',
      appName: 'Linear',
      bundleId: 'com.linear',
      windowTitle: 'ENG-4713',
    }));
    recorder.stop('2026-05-18T10:00:20.000Z');

    expect(events.map((event) => event.type)).toEqual([
      'activity.sample',
      'activity.browser_tab',
      'activity.sample',
      'activity.browser_tab',
      'activity.app_interval',
      'activity.app_switch',
      'activity.sample',
      'activity.app_interval',
    ]);

    expect(events[4]).toMatchObject({
      type: 'activity.app_interval',
      reason: 'app_switch',
      startedAt: '2026-05-18T10:00:00.000Z',
      endedAt: '2026-05-18T10:00:12.000Z',
      durationMs: 12_000,
      app: { appName: 'Google Chrome', bundleId: 'com.google.Chrome' },
      lastWindowTitle: 'GitHub',
    });
    expect(events[5]).toMatchObject({
      type: 'activity.app_switch',
      from: { appName: 'Google Chrome', bundleId: 'com.google.Chrome' },
      to: { appName: 'Linear', bundleId: 'com.linear' },
      previousDurationMs: 12_000,
    });
    expect(events[7]).toMatchObject({
      type: 'activity.app_interval',
      reason: 'tracker_stop',
      startedAt: '2026-05-18T10:00:12.000Z',
      endedAt: '2026-05-18T10:00:20.000Z',
      durationMs: 8_000,
    });
  });

  test('does not emit duplicate browser tab events for unchanged URL and title', () => {
    const events: ActivityEvent[] = [];
    const recorder = new ActivityEventRecorder((event) => events.push(event));
    const browser = {
      kind: 'chromium' as const,
      appName: 'Google Chrome',
      url: 'https://example.com',
      title: 'Example',
    };

    recorder.recordSample(sample({ appName: 'Google Chrome', bundleId: 'com.google.Chrome', browser }));
    recorder.recordSample(sample({
      capturedAt: '2026-05-18T10:00:05.000Z',
      appName: 'Google Chrome',
      bundleId: 'com.google.Chrome',
      browser,
    }));

    expect(events.filter((event) => event.type === 'activity.browser_tab')).toHaveLength(1);
  });
});

describe('ActivityJsonlStore', () => {
  test('persists JSONL events under userData/activity', () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-tracker-test-'));
    try {
      const store = new ActivityJsonlStore(userData);
      const filePath = activityEventsPath(userData);
      store.append({
        schemaVersion: 1,
        type: 'activity.sample',
        at: '2026-05-18T10:00:00.000Z',
        sample: sample({}),
      });

      expect(store.getFilePath()).toBe(filePath);
      const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        schemaVersion: 1,
        type: 'activity.sample',
        sample: { appName: 'Linear', bundleId: 'com.linear' },
      });
    } finally {
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });
});
