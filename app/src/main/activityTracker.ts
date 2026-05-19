import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { activityEventsPath } from './activityPaths';
import type { ChannelLogger } from './logger';
import { loggerFactory } from './logger';

const DEFAULT_INTERVAL_MS = 5_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 60_000;
const ACTIVITY_SCHEMA_VERSION = 1;
const OSASCRIPT_TIMEOUT_MS = 3_000;

const activityLogger = loggerFactory.getLogger('activity');

export type ActivitySource = 'macos-jxa';
export type BrowserActivityKind = 'safari' | 'chromium';

export interface BrowserActivity {
  kind: BrowserActivityKind;
  appName: string;
  url?: string;
  title?: string;
}

export interface ActivitySnapshot {
  capturedAt: string;
  source: ActivitySource;
  appName: string;
  bundleId?: string;
  processId?: number;
  windowTitle?: string;
  browser?: BrowserActivity;
  probeError?: string;
}

interface ActivityAppRef {
  appName: string;
  bundleId?: string;
}

interface ActivityEventBase {
  schemaVersion: typeof ACTIVITY_SCHEMA_VERSION;
  type: string;
  at: string;
}

export interface ActivitySampleEvent extends ActivityEventBase {
  type: 'activity.sample';
  sample: ActivitySnapshot;
}

export interface ActivityAppSwitchEvent extends ActivityEventBase {
  type: 'activity.app_switch';
  from: ActivityAppRef;
  to: ActivityAppRef;
  previousStartedAt: string;
  previousEndedAt: string;
  previousDurationMs: number;
}

export interface ActivityAppIntervalEvent extends ActivityEventBase {
  type: 'activity.app_interval';
  reason: 'app_switch' | 'tracker_stop';
  app: ActivityAppRef;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  lastWindowTitle?: string;
  lastBrowser?: BrowserActivity;
}

export interface ActivityBrowserTabEvent extends ActivityEventBase {
  type: 'activity.browser_tab';
  app: ActivityAppRef;
  browser: BrowserActivity;
}

export interface ActivityErrorEvent extends ActivityEventBase {
  type: 'activity.error';
  stage: 'probe' | 'write';
  error: string;
}

export type ActivityEvent =
  | ActivitySampleEvent
  | ActivityAppSwitchEvent
  | ActivityAppIntervalEvent
  | ActivityBrowserTabEvent
  | ActivityErrorEvent;

export type ActivityEventWriter = (event: ActivityEvent) => void;

export interface ActivityTrackerOptions {
  userDataPath: string;
  intervalMs?: number;
  querySnapshot?: () => Promise<ActivitySnapshot>;
  logger?: ChannelLogger;
}

const MAC_ACTIVITY_JXA = String.raw`
const CHROMIUM_BUNDLE_IDS = {
  "com.google.Chrome": true,
  "com.google.Chrome.canary": true,
  "org.chromium.Chromium": true,
  "com.brave.Browser": true,
  "com.microsoft.edgemac": true,
  "company.thebrowser.Browser": true,
  "com.vivaldi.Vivaldi": true,
  "com.operasoftware.Opera": true
};

function stringOrNull(value) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text.length > 0 ? text : null;
}

function readSafari(appName) {
  try {
    const safari = Application(appName);
    const documents = safari.documents();
    if (!documents || documents.length === 0) return null;
    const doc = documents[0];
    return {
      kind: "safari",
      appName,
      url: stringOrNull(doc.url()),
      title: stringOrNull(doc.name())
    };
  } catch (error) {
    return { kind: "safari", appName, error: String(error) };
  }
}

function readChromium(appName) {
  try {
    const browser = Application(appName);
    const windows = browser.windows();
    if (!windows || windows.length === 0) return null;
    const tab = windows[0].activeTab();
    return {
      kind: "chromium",
      appName,
      url: stringOrNull(tab.url()),
      title: stringOrNull(tab.title())
    };
  } catch (error) {
    return { kind: "chromium", appName, error: String(error) };
  }
}

function run() {
  const snapshot = {
    capturedAt: new Date().toISOString(),
    source: "macos-jxa"
  };

  try {
    const systemEvents = Application("System Events");
    const frontmost = systemEvents.applicationProcesses.whose({ frontmost: true })()[0];
    snapshot.appName = stringOrNull(frontmost.name());
    snapshot.bundleId = stringOrNull(frontmost.bundleIdentifier());
    snapshot.processId = Number(frontmost.unixId());
    try {
      snapshot.windowTitle = frontmost.windows.length > 0
        ? stringOrNull(frontmost.windows[0].name())
        : null;
    } catch (error) {
      snapshot.windowTitle = null;
      snapshot.probeError = String(error);
    }

    if (snapshot.bundleId === "com.apple.Safari") {
      snapshot.browser = readSafari(snapshot.appName || "Safari");
    } else if (snapshot.bundleId && CHROMIUM_BUNDLE_IDS[snapshot.bundleId]) {
      snapshot.browser = readChromium(snapshot.appName || snapshot.bundleId);
    }

    return JSON.stringify(snapshot);
  } catch (error) {
    snapshot.ok = false;
    snapshot.error = String(error);
    return JSON.stringify(snapshot);
  }
}
`;

let activeTracker: ActivityTracker | null = null;

export function startActivityTracker(options: ActivityTrackerOptions): ActivityTracker | null {
  if (process.platform !== 'darwin') {
    options.logger?.info('activity.tracker.unsupportedPlatform', { platform: process.platform });
    return null;
  }
  if (process.env.AGB_ACTIVITY_TRACKER === '0') {
    options.logger?.info('activity.tracker.disabledByEnv');
    return null;
  }
  if (activeTracker) return activeTracker;

  activeTracker = new ActivityTracker(options);
  activeTracker.start();
  return activeTracker;
}

export function stopActivityTracker(): void {
  activeTracker?.stop();
  activeTracker = null;
}

export class ActivityJsonlStore {
  private readonly filePath: string;

  constructor(userDataPath: string) {
    this.filePath = activityEventsPath(userDataPath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  append(event: ActivityEvent): void {
    fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, 'utf-8');
  }

  getFilePath(): string {
    return this.filePath;
  }
}

export class ActivityEventRecorder {
  private currentIntervalStart: ActivitySnapshot | null = null;
  private lastSample: ActivitySnapshot | null = null;
  private lastBrowserKey: string | null = null;

  constructor(private readonly writeEvent: ActivityEventWriter) {}

  recordSample(sample: ActivitySnapshot): void {
    const previous = this.lastSample;
    if (!previous) {
      this.currentIntervalStart = sample;
      this.emitSample(sample);
      this.emitBrowserTabIfChanged(sample);
      this.lastSample = sample;
      return;
    }

    if (appKey(previous) !== appKey(sample)) {
      this.emitCurrentInterval('app_switch', sample.capturedAt);
      const startedAt = this.currentIntervalStart?.capturedAt ?? previous.capturedAt;
      this.writeEvent({
        schemaVersion: ACTIVITY_SCHEMA_VERSION,
        type: 'activity.app_switch',
        at: sample.capturedAt,
        from: appRef(previous),
        to: appRef(sample),
        previousStartedAt: startedAt,
        previousEndedAt: sample.capturedAt,
        previousDurationMs: durationMs(startedAt, sample.capturedAt),
      });
      this.currentIntervalStart = sample;
      this.lastBrowserKey = null;
    }

    this.emitSample(sample);
    this.emitBrowserTabIfChanged(sample);
    this.lastSample = sample;
  }

  stop(endedAt: string): void {
    this.emitCurrentInterval('tracker_stop', endedAt);
    this.currentIntervalStart = null;
    this.lastSample = null;
    this.lastBrowserKey = null;
  }

  private emitSample(sample: ActivitySnapshot): void {
    this.writeEvent({
      schemaVersion: ACTIVITY_SCHEMA_VERSION,
      type: 'activity.sample',
      at: sample.capturedAt,
      sample,
    });
  }

  private emitBrowserTabIfChanged(sample: ActivitySnapshot): void {
    if (!sample.browser || !sample.browser.url) return;
    const nextKey = `${appKey(sample)}\n${sample.browser.url}\n${sample.browser.title ?? ''}`;
    if (nextKey === this.lastBrowserKey) return;
    this.writeEvent({
      schemaVersion: ACTIVITY_SCHEMA_VERSION,
      type: 'activity.browser_tab',
      at: sample.capturedAt,
      app: appRef(sample),
      browser: sample.browser,
    });
    this.lastBrowserKey = nextKey;
  }

  private emitCurrentInterval(reason: ActivityAppIntervalEvent['reason'], endedAt: string): void {
    const start = this.currentIntervalStart;
    const last = this.lastSample;
    if (!start || !last) return;
    this.writeEvent({
      schemaVersion: ACTIVITY_SCHEMA_VERSION,
      type: 'activity.app_interval',
      at: endedAt,
      reason,
      app: appRef(start),
      startedAt: start.capturedAt,
      endedAt,
      durationMs: durationMs(start.capturedAt, endedAt),
      lastWindowTitle: last.windowTitle,
      lastBrowser: last.browser,
    });
  }
}

export class ActivityTracker {
  private readonly intervalMs: number;
  private readonly querySnapshot: () => Promise<ActivitySnapshot>;
  private readonly store: ActivityJsonlStore;
  private readonly recorder: ActivityEventRecorder;
  private readonly logger: ChannelLogger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(options: ActivityTrackerOptions) {
    this.intervalMs = clampInterval(options.intervalMs ?? readIntervalMs());
    this.querySnapshot = options.querySnapshot ?? queryMacActivitySnapshot;
    this.store = new ActivityJsonlStore(options.userDataPath);
    this.logger = options.logger ?? activityLogger;
    this.recorder = new ActivityEventRecorder((event) => {
      try {
        this.store.append(event);
      } catch (err) {
        this.logger.warn('activity.writeFailed', { error: (err as Error).message });
      }
    });
  }

  start(): void {
    if (this.timer) return;
    this.logger.info('activity.tracker.started', {
      intervalMs: this.intervalMs,
      filePath: this.store.getFilePath(),
    });
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.recorder.stop(new Date().toISOString());
    this.logger.info('activity.tracker.stopped', { filePath: this.store.getFilePath() });
  }

  getEventsPath(): string {
    return this.store.getFilePath();
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const sample = await this.querySnapshot();
      this.recorder.recordSample(sample);
    } catch (err) {
      const at = new Date().toISOString();
      const message = (err as Error).message;
      this.logger.warn('activity.probeFailed', { error: message });
      try {
        this.store.append({
          schemaVersion: ACTIVITY_SCHEMA_VERSION,
          type: 'activity.error',
          at,
          stage: 'probe',
          error: message,
        });
      } catch (writeErr) {
        this.logger.warn('activity.errorWriteFailed', { error: (writeErr as Error).message });
      }
    } finally {
      this.inFlight = false;
    }
  }
}

export function queryMacActivitySnapshot(): Promise<ActivitySnapshot> {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', MAC_ACTIVITY_JXA],
      { timeout: OSASCRIPT_TIMEOUT_MS, maxBuffer: 128 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const suffix = stderr.trim() ? `: ${stderr.trim()}` : '';
          reject(new Error(`macOS activity probe failed${suffix || `: ${error.message}`}`));
          return;
        }
        try {
          resolve(parseMacActivitySnapshot(stdout));
        } catch (err) {
          reject(err);
        }
      },
    );
  });
}

export function parseMacActivitySnapshot(stdout: string): ActivitySnapshot {
  const parsed = parseJsonObject(stdout.trim());
  if (parsed['ok'] === false) {
    throw new Error(stringField(parsed, 'error') ?? 'macOS activity probe returned ok=false');
  }

  const appName = stringField(parsed, 'appName');
  if (!appName) throw new Error('macOS activity probe did not return appName');

  const browserRecord = objectField(parsed, 'browser');
  const browser = browserRecord ? parseBrowserActivity(browserRecord) : undefined;

  return {
    capturedAt: stringField(parsed, 'capturedAt') ?? new Date().toISOString(),
    source: 'macos-jxa',
    appName,
    bundleId: stringField(parsed, 'bundleId') ?? undefined,
    processId: numberField(parsed, 'processId') ?? undefined,
    windowTitle: stringField(parsed, 'windowTitle') ?? undefined,
    browser,
    probeError: stringField(parsed, 'probeError') ?? undefined,
  };
}

function parseBrowserActivity(record: Record<string, unknown>): BrowserActivity | undefined {
  const kind = stringField(record, 'kind');
  if (kind !== 'safari' && kind !== 'chromium') return undefined;
  const appName = stringField(record, 'appName');
  if (!appName) return undefined;
  const error = stringField(record, 'error');
  if (error) return undefined;
  return {
    kind,
    appName,
    url: stringField(record, 'url') ?? undefined,
    title: stringField(record, 'title') ?? undefined,
  };
}

function parseJsonObject(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  const record = asRecord(parsed);
  if (!record) throw new Error('macOS activity probe did not return a JSON object');
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function objectField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return asRecord(record[key]);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== 'string') return null;
  return value.length > 0 ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function appRef(sample: ActivitySnapshot): ActivityAppRef {
  return {
    appName: sample.appName,
    bundleId: sample.bundleId,
  };
}

function appKey(sample: ActivitySnapshot): string {
  return sample.bundleId || sample.appName;
}

function durationMs(startedAt: string, endedAt: string): number {
  const started = new Date(startedAt).getTime();
  const ended = new Date(endedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return 0;
  return Math.max(0, ended - started);
}

function readIntervalMs(): number {
  const raw = process.env.AGB_ACTIVITY_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_MS;
  return parsed;
}

function clampInterval(intervalMs: number): number {
  if (!Number.isFinite(intervalMs)) return DEFAULT_INTERVAL_MS;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(intervalMs)));
}
