import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ConnectionsPane, type SettingsProviderFocusRequest } from './ConnectionsPane';
import type { ActionId, KeyBinding } from './keybindings';
import { fallbackShortcutPlatform, keyboardEventToShortcut } from '../../shared/hotkeys';
import { useThemeMode } from '../design/useThemeMode';
import type { ThemeMode } from '../design/themeMode';
import { useToast } from '@/renderer/components/base/Toast';
import {
  PRESETS as SPINNER_VERB_PRESETS,
  useSpinnerVerbsStore,
  MIN_CYCLE_MS,
  MAX_CYCLE_MS,
  type SpinnerPresetId,
} from './chat/spinnerVerbs';

/**
 * Generic settings primitives. Add a new option type and every section that
 * uses it (Appearance, future Density / Accent / etc.) gets the same UI.
 */
interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

interface SettingsRowProps {
  label: string;
  sublabel?: string;
  children: React.ReactNode;
}

function SettingsRow({ label, sublabel, children }: SettingsRowProps): React.ReactElement {
  return (
    <div className="settings-pane__row">
      <div>
        <div className="settings-pane__label">{label}</div>
        {sublabel && <div className="settings-pane__sublabel">{sublabel}</div>}
      </div>
      {children}
    </div>
  );
}

interface SegmentedControlProps<T extends string> {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
}

function SegmentedControl<T extends string>({ value, options, onChange, ariaLabel }: SegmentedControlProps<T>): React.ReactElement {
  // Plain toggle-button group with aria-pressed, not role="radio". The radio
  // pattern requires roving tabindex + arrow-key nav; for a 3-option theme
  // picker that's overkill and a partial implementation is worse than none.
  return (
    <div className="settings-pane__segmented" role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={value === opt.value}
          className={`settings-pane__segment${value === opt.value ? ' settings-pane__segment--active' : ''}`}
          title={opt.hint}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

const APPEARANCE_OPTIONS: ReadonlyArray<SegmentedOption<ThemeMode>> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System', hint: 'Follow your operating system' },
];

function AppearanceSection(): React.ReactElement {
  const { mode, setMode, resolved } = useThemeMode();
  return (
    <div className="settings-card">
      <SettingsRow
        label="Theme"
        sublabel={
          mode === 'system'
            ? `Following your system (${resolved}).`
            : 'Choose how Browser Use looks across windows.'
        }
      >
        <SegmentedControl
          value={mode}
          options={APPEARANCE_OPTIONS}
          onChange={setMode}
          ariaLabel="Theme"
        />
      </SettingsRow>
    </div>
  );
}

function SpinnerVerbsSection(): React.ReactElement {
  const presetId = useSpinnerVerbsStore((s) => s.presetId);
  const customVerbs = useSpinnerVerbsStore((s) => s.customVerbs);
  const cycleMs = useSpinnerVerbsStore((s) => s.cycleMs);
  const setPreset = useSpinnerVerbsStore((s) => s.setPreset);
  const setCustomVerbs = useSpinnerVerbsStore((s) => s.setCustomVerbs);
  const setCycleMs = useSpinnerVerbsStore((s) => s.setCycleMs);

  const [draft, setDraft] = useState(customVerbs.join('\n'));
  // Keep the local textarea in sync when something else mutates the store
  // (e.g. preset reset), but don't fight the user mid-edit.
  const lastSyncedRef = useRef(customVerbs.join('\n'));
  useEffect(() => {
    const next = customVerbs.join('\n');
    if (next !== lastSyncedRef.current && next !== draft) {
      setDraft(next);
      lastSyncedRef.current = next;
    }
  }, [customVerbs, draft]);

  const presetOptions = [
    ...(Object.entries(SPINNER_VERB_PRESETS) as Array<[Exclude<SpinnerPresetId, 'custom'>, typeof SPINNER_VERB_PRESETS[keyof typeof SPINNER_VERB_PRESETS]]>),
  ];

  const activePreview = presetId === 'custom'
    ? (customVerbs.length > 0 ? customVerbs : ['Working'])
    : SPINNER_VERB_PRESETS[presetId].verbs;

  const commitDraft = (): void => {
    const next = draft.split('\n').map((v) => v.trim()).filter(Boolean);
    setCustomVerbs(next);
    lastSyncedRef.current = next.join('\n');
  };

  return (
    <div className="settings-card">
      <SettingsRow
        label="Spinner verb"
        sublabel="The word shown next to the busy spinner. Cycles through the list while the agent runs."
      >
        <select
          className="settings-pane__select"
          value={presetId}
          onChange={(e) => setPreset(e.target.value as SpinnerPresetId)}
          aria-label="Spinner verb preset"
        >
          {presetOptions.map(([id, preset]) => (
            <option key={id} value={id}>{preset.label}</option>
          ))}
          <option value="custom">Custom</option>
        </select>
      </SettingsRow>

      <SettingsRow
        label="Preview"
        sublabel={presetId === 'custom'
          ? `${activePreview.length} custom verb${activePreview.length === 1 ? '' : 's'}.`
          : SPINNER_VERB_PRESETS[presetId].description}
      >
        <div className="settings-pane__value" style={{ maxWidth: 320, textAlign: 'right' }}>
          {activePreview.slice(0, 6).join(' / ')}{activePreview.length > 6 ? ' ...' : ''}
        </div>
      </SettingsRow>

      {presetId === 'custom' && (
        <SettingsRow
          label="Custom verbs"
          sublabel={'One verb per line. Blank lines are ignored. Falls back to "Working" if empty.'}
        >
          <textarea
            className="settings-pane__textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            placeholder={'Brewing\nCooking\nThinking'}
            rows={6}
            spellCheck={false}
            style={{ minWidth: 260, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}
          />
        </SettingsRow>
      )}

      <SettingsRow
        label="Cycle interval"
        sublabel={`How long each verb stays visible (${(cycleMs / 1000).toFixed(1)}s).`}
      >
        <input
          type="range"
          min={MIN_CYCLE_MS}
          max={MAX_CYCLE_MS}
          step={100}
          value={cycleMs}
          onChange={(e) => setCycleMs(Number(e.target.value))}
          aria-label="Spinner verb cycle interval"
          style={{ width: 200 }}
        />
      </SettingsRow>
    </div>
  );
}

type ElectronPrivacyAPI = {
  get: () => Promise<{ telemetry: boolean; telemetryUpdatedAt: string | null; version: number }>;
  setTelemetry: (optedIn: boolean) => Promise<{ telemetry: boolean; telemetryUpdatedAt: string | null; version: number }>;
  openSystemNotifications: () => Promise<{ ok: boolean; error?: string }>;
};

type ElectronAppAPI = {
  getUpdateStatus: () => Promise<UpdateStatusEvent>;
  getInfo: () => Promise<{
    version: string;
    latestVersion: string | null;
    isLatestVersion: boolean | null;
    platform: string;
    packaged: boolean;
    updateSupported: boolean;
    canDownloadUpdate: boolean;
    updateFeedUrl: string;
  }>;
  downloadLatest: () => Promise<{
    ok: boolean;
    action: 'started-update-check' | 'unavailable';
    message: string;
  }>;
  installUpdate: () => Promise<{
    ok: boolean;
    action: 'install-started' | 'not-ready';
    message: string;
  }>;
  onUpdateStatus: (cb: (event: UpdateStatusEvent) => void) => () => void;
};

type UpdateStatusEvent = {
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'error' | 'unavailable';
  version?: string;
  message?: string;
  error?: string;
  progress?: {
    percent: number | null;
    transferred: number | null;
    total: number | null;
    bytesPerSecond: number | null;
  };
};

const ACTIVITY_APP_COLORS = [
  '#7dd3fc',
  '#34d399',
  '#f97316',
  '#a78bfa',
  '#facc15',
  '#f472b6',
  '#60a5fa',
  '#fb7185',
];
const ACTIVITY_OTHER_COLOR = 'rgba(var(--highlight-rgb), 0.28)';

interface ActivityDonutSlice {
  key: string;
  label: string;
  iconDataUrl?: string;
  durationMs: number;
  color: string;
  path: string;
}

interface ActivityHoverPoint {
  x: number;
  y: number;
}

function ActivitySection(): React.ReactElement {
  const api = window.electronAPI?.settings?.activity;
  const [summary, setSummary] = useState<ElectronActivityUsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoveredDonutSlice, setHoveredDonutSlice] = useState<string | null>(null);
  const [activityHoverPoint, setActivityHoverPoint] = useState<ActivityHoverPoint | null>(null);

  const loadSummary = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    setError(null);
    try {
      setSummary(await api.getSummary({ days: 7 }));
    } catch {
      setError('Could not read local activity.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (!api) return undefined;
    void loadSummary();
    const refreshTimer = window.setInterval(() => {
      void loadSummary();
    }, 15_000);
    return () => window.clearInterval(refreshTimer);
  }, [loadSummary]);

  const showActivityHoverPopup = useCallback((key: string, event: React.MouseEvent<Element>) => {
    setHoveredDonutSlice(key);
    setActivityHoverPoint(activityHoverPointFromMouse(event));
  }, []);

  const moveActivityHoverPopup = useCallback((event: React.MouseEvent<Element>) => {
    setActivityHoverPoint(activityHoverPointFromMouse(event));
  }, []);

  const focusActivityHoverPopup = useCallback((key: string, event: React.FocusEvent<Element>) => {
    setHoveredDonutSlice(key);
    setActivityHoverPoint(activityHoverPointFromElement(event.currentTarget));
  }, []);

  const clearActivityHoverPopup = useCallback(() => {
    setHoveredDonutSlice(null);
    setActivityHoverPoint(null);
  }, []);

  if (!api) {
    return (
      <div className="settings-card activity-card activity-card--empty">
        <div className="activity-card__header">
          <div>
            <div className="settings-pane__label">Applications</div>
            <div className="settings-pane__sublabel">Activity summary unavailable.</div>
          </div>
        </div>
      </div>
    );
  }

  const graphApps = summary?.apps.slice(0, 6) ?? [];
  const listApps = summary?.apps.slice(0, 10) ?? [];
  const graphAppKeys = new Set(graphApps.map((app) => app.appKey));
  const maxDailyMs = Math.max(1, ...(summary?.daily.map((day) => day.totalMs) ?? [0]));
  const hasUsage = (summary?.totalMs ?? 0) > 0;
  const donutSlices = summary ? buildActivityDonutSlices(graphApps, summary.totalMs) : [];
  const activeDonutSlice = donutSlices.find((slice) => slice.key === hoveredDonutSlice) ?? null;
  const updatedLabel = summary
    ? `${summary.fileExists ? 'Updated' : 'Waiting'} ${formatActivityTimestamp(summary.generatedAt)}`
    : loading
      ? 'Loading local activity...'
      : 'Waiting for local activity...';

  return (
    <div className="settings-card activity-card">
      <div className="activity-card__header">
        <div>
          <div className="settings-pane__label">Applications</div>
          <div className="settings-pane__sublabel">
            {error ?? updatedLabel}
          </div>
        </div>
        <button
          type="button"
          className="conn-card__btn conn-card__btn--secondary"
          onClick={() => { void loadSummary(); }}
          disabled={loading}
        >
          {loading ? 'Refreshing' : 'Refresh'}
        </button>
      </div>

      {summary && (
        <div className="activity-card__metrics">
          <div>
            <span>Tracked</span>
            <strong>{formatActivityDuration(summary.totalMs)}</strong>
          </div>
          <div>
            <span>Samples</span>
            <strong>{summary.sampleCount.toLocaleString()}</strong>
          </div>
          <div>
            <span>Apps</span>
            <strong>{summary.apps.length.toLocaleString()}</strong>
          </div>
        </div>
      )}

      {!summary || !hasUsage ? (
        <div className="activity-empty-state">
          {summary?.fileExists === false
            ? 'No activity file yet.'
            : 'No app samples yet.'}
        </div>
      ) : (
        <>
          <div className="activity-overview">
            <div className="activity-donut" aria-label="Application usage share">
              <div className="activity-donut__ring" onMouseLeave={clearActivityHoverPopup}>
                <svg className="activity-donut__svg" viewBox="0 0 200 200" role="img" aria-label="Application usage share">
                  {donutSlices.map((slice) => (
                    <path
                      key={slice.key}
                      className="activity-donut__slice"
                      d={slice.path}
                      fill={slice.color}
                      role="graphics-symbol"
                      tabIndex={0}
                      aria-label={`${slice.label}: ${formatActivityDuration(slice.durationMs)}`}
                      onMouseEnter={(event) => showActivityHoverPopup(slice.key, event)}
                      onMouseMove={moveActivityHoverPopup}
                      onFocus={(event) => focusActivityHoverPopup(slice.key, event)}
                      onBlur={clearActivityHoverPopup}
                    />
                  ))}
                </svg>
                <div className="activity-donut__hole">
                  <span>{formatActivityDuration(activeDonutSlice?.durationMs ?? summary.totalMs, true)}</span>
                  <small>{activeDonutSlice?.label ?? 'Total'}</small>
                </div>
              </div>
            </div>

            <div className="activity-app-list" aria-label="Applications by tracked time">
              {listApps.map((app, index) => (
                <div
                  className={`activity-app-row${hoveredDonutSlice === app.appKey ? ' activity-app-row--active' : ''}`}
                  key={app.appKey}
                  onMouseEnter={(event) => showActivityHoverPopup(app.appKey, event)}
                  onMouseMove={moveActivityHoverPopup}
                  onMouseLeave={clearActivityHoverPopup}
                  onFocus={(event) => focusActivityHoverPopup(app.appKey, event)}
                  onBlur={clearActivityHoverPopup}
                >
                  <span
                    className={`activity-app-row__avatar${app.iconDataUrl ? ' activity-app-row__avatar--icon' : ''}`}
                    style={{ backgroundColor: activityColor(index) }}
                    aria-hidden="true"
                  >
                    {app.iconDataUrl ? (
                      <img src={app.iconDataUrl} alt="" />
                    ) : (
                      appInitials(app.appName)
                    )}
                  </span>
                  <span className="activity-app-row__name" title={app.appName}>{app.appName}</span>
                  <span className="activity-app-row__time">{formatActivityDuration(app.totalMs, true)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="activity-week-chart" aria-label="Application usage by day">
            {summary.daily.map((day) => {
              const daySegments = graphApps
                .map((app, index) => ({
                  appKey: app.appKey,
                  label: app.appName,
                  color: activityColor(index),
                  durationMs: day.apps.find((entry) => entry.appKey === app.appKey)?.durationMs ?? 0,
                }))
                .filter((segment) => segment.durationMs > 0);
              const otherMs = day.apps
                .filter((entry) => !graphAppKeys.has(entry.appKey))
                .reduce((sum, entry) => sum + entry.durationMs, 0);
              if (otherMs > 0) {
                daySegments.push({
                  appKey: 'other',
                  label: 'Other',
                  color: ACTIVITY_OTHER_COLOR,
                  durationMs: otherMs,
                });
              }
              const barHeight = day.totalMs > 0 ? Math.max(4, (day.totalMs / maxDailyMs) * 100) : 0;
              return (
                <div className="activity-day" key={day.date}>
                  <div className="activity-day__value">{day.totalMs > 0 ? formatActivityDuration(day.totalMs, true) : ''}</div>
                  <div className="activity-day__track">
                    <div className="activity-day__bar" style={{ height: `${barHeight}%` }}>
                      {daySegments.map((segment) => (
                        <span
                          key={segment.appKey}
                          className="activity-day__segment"
                          title={`${segment.label}: ${formatActivityDuration(segment.durationMs)}`}
                          style={{
                            backgroundColor: segment.color,
                            height: `${(segment.durationMs / Math.max(1, day.totalMs)) * 100}%`,
                          }}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="activity-day__label">{formatActivityDayLabel(day.date)}</div>
                </div>
              );
            })}
          </div>

          {(summary.truncated || summary.parseErrorCount > 0) && (
            <div className="activity-card__note">
              {summary.truncated ? 'Showing the latest activity window.' : ''}
              {summary.parseErrorCount > 0 ? ` Skipped ${summary.parseErrorCount} malformed event${summary.parseErrorCount === 1 ? '' : 's'}.` : ''}
            </div>
          )}

          {activeDonutSlice && activityHoverPoint && (
            <div
              className="activity-hover-popup"
              role="tooltip"
              style={{
                left: `${activityHoverPoint.x}px`,
                top: `${activityHoverPoint.y}px`,
              }}
            >
              <span
                className={`activity-hover-popup__avatar${activeDonutSlice.iconDataUrl ? ' activity-hover-popup__avatar--icon' : ''}`}
                style={{ backgroundColor: activeDonutSlice.color }}
                aria-hidden="true"
              >
                {activeDonutSlice.iconDataUrl ? (
                  <img src={activeDonutSlice.iconDataUrl} alt="" />
                ) : (
                  appInitials(activeDonutSlice.label)
                )}
              </span>
              <span className="activity-hover-popup__name">{activeDonutSlice.label}</span>
              <span className="activity-hover-popup__time">{formatActivityDuration(activeDonutSlice.durationMs, true)}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function activityHoverPointFromMouse(event: React.MouseEvent<Element>): ActivityHoverPoint {
  const maxX = Math.max(16, window.innerWidth - 296);
  return {
    x: Math.min(Math.max(16, event.clientX + 14), maxX),
    y: Math.max(16, event.clientY - 12),
  };
}

function activityHoverPointFromElement(element: Element): ActivityHoverPoint {
  const rect = element.getBoundingClientRect();
  const maxX = Math.max(16, window.innerWidth - 296);
  return {
    x: Math.min(Math.max(16, rect.left + rect.width + 12), maxX),
    y: Math.max(16, rect.top + rect.height / 2),
  };
}

function activityColor(index: number): string {
  return ACTIVITY_APP_COLORS[index % ACTIVITY_APP_COLORS.length];
}

function buildActivityDonutSlices(apps: ElectronActivitySummaryApp[], totalMs: number): ActivityDonutSlice[] {
  if (totalMs <= 0) return [];
  const baseSlices = apps
    .map((app, index) => ({
      key: app.appKey,
      label: app.appName,
      iconDataUrl: app.iconDataUrl,
      durationMs: app.totalMs,
      color: activityColor(index),
    }))
    .filter((slice) => slice.durationMs > 0);
  const visibleMs = baseSlices.reduce((sum, slice) => sum + slice.durationMs, 0);
  const otherMs = Math.max(0, totalMs - visibleMs);
  const sourceSlices = otherMs > 0
    ? [...baseSlices, { key: 'other', label: 'Other', durationMs: otherMs, color: ACTIVITY_OTHER_COLOR }]
    : baseSlices;

  let cursor = 0;
  return sourceSlices.map((slice, index) => {
    const sweep = (slice.durationMs / totalMs) * 360;
    const startAngle = cursor;
    cursor += sweep;
    const endAngle = sourceSlices.length === 1
      ? 359.999
      : index === sourceSlices.length - 1
        ? 359.999
        : Math.max(startAngle + 0.001, Math.min(cursor, 359.999));
    return {
      ...slice,
      path: donutSegmentPath(100, 100, 88, 45, startAngle, endAngle),
    };
  });
}

function donutSegmentPath(
  centerX: number,
  centerY: number,
  outerRadius: number,
  innerRadius: number,
  startAngle: number,
  endAngle: number,
): string {
  const outerStart = polarPoint(centerX, centerY, outerRadius, startAngle);
  const outerEnd = polarPoint(centerX, centerY, outerRadius, endAngle);
  const innerEnd = polarPoint(centerX, centerY, innerRadius, endAngle);
  const innerStart = polarPoint(centerX, centerY, innerRadius, startAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    'Z',
  ].join(' ');
}

function polarPoint(centerX: number, centerY: number, radius: number, angle: number): { x: string; y: string } {
  const radians = (angle - 90) * (Math.PI / 180);
  return {
    x: (centerX + radius * Math.cos(radians)).toFixed(3),
    y: (centerY + radius * Math.sin(radians)).toFixed(3),
  };
}

function formatActivityDuration(ms: number, compact = false): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (compact) {
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }
  if (hours > 0) return `${hours} hour${hours === 1 ? '' : 's'} ${minutes} min`;
  return `${minutes} min`;
}

function formatActivityTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatActivityDayLabel(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return value;
  return `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
}

function appInitials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function AppSection(): React.ReactElement {
  const [info, setInfo] = useState<Awaited<ReturnType<ElectronAppAPI['getInfo']>> | null>(null);
  const [updateStatusEvent, setUpdateStatusEvent] = useState<UpdateStatusEvent>({ status: 'idle' });
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const api = window.electronAPI?.settings?.app;
  const onLatest = info?.isLatestVersion === true;
  const canDownloadUpdate = info?.canDownloadUpdate === true;
  const updateReady = updateStatusEvent.status === 'ready';
  const updateBusy = updateStatusEvent.status === 'checking' || updateStatusEvent.status === 'downloading';
  const updateActionDisabled = !api || !info || installing || (
    !updateReady && (checking || updateBusy || onLatest || !canDownloadUpdate)
  );
  const downloadProgress = updateStatusEvent.progress?.percent;
  const progressWidth = typeof downloadProgress === 'number'
    ? `${Math.max(2, Math.min(100, downloadProgress))}%`
    : updateStatusEvent.status === 'downloading'
      ? '18%'
      : '0%';
  const updateStatus = updateStatusEvent.message ?? (
    !info
      ? 'Checking latest version...'
      : updateReady
        ? 'Update is ready to install.'
        : updateBusy
          ? 'Checking for updates...'
          : onLatest
            ? 'You are on the latest version.'
            : info.latestVersion
              ? `Latest version is ${info.latestVersion}.`
              : canDownloadUpdate
                ? 'Checks on startup and every hour.'
                : 'In-app updates are available in packaged release builds.'
  );
  const buttonLabel = !info || checking
    ? 'Checking...'
    : installing
      ? 'Restarting...'
      : updateReady
        ? 'Restart to install'
        : onLatest
          ? 'On latest'
          : canDownloadUpdate
            ? 'Download update'
            : 'Unavailable';

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api?.getInfo() ?? Promise.resolve(null),
      api?.getUpdateStatus() ?? Promise.resolve<UpdateStatusEvent>({ status: 'idle' }),
    ])
      .then(([nextInfo, nextStatus]) => {
        if (cancelled) return;
        setInfo(nextInfo);
        setUpdateStatusEvent(nextStatus);
      })
      .catch(() => {
        if (cancelled) return;
        setInfo(null);
        setUpdateStatusEvent({ status: 'error', message: 'Could not read update status.' });
      });

    const unsubscribe = api?.onUpdateStatus((nextStatus) => {
      setUpdateStatusEvent(nextStatus);
      if (nextStatus.status !== 'ready') setInstalling(false);
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [api]);

  const handleDownloadLatest = useCallback(async () => {
    if (!api || checking || installing || onLatest || updateBusy || updateReady || !canDownloadUpdate) return;
    setChecking(true);
    setUpdateStatusEvent({ status: 'checking', message: 'Checking for updates...' });
    try {
      const result = await api.downloadLatest();
      setUpdateStatusEvent((current) => (
        current.status === 'checking' ? { status: result.ok ? 'checking' : 'unavailable', message: result.message } : current
      ));
      const next = await api.getInfo();
      setInfo(next);
    } catch {
      setUpdateStatusEvent({ status: 'error', message: 'Could not start the in-app update check. Please try again later.' });
    } finally {
      setChecking(false);
    }
  }, [api, canDownloadUpdate, checking, installing, onLatest, updateBusy, updateReady]);

  const handleInstallUpdate = useCallback(async () => {
    if (!api || installing || !updateReady) return;
    setInstalling(true);
    try {
      const result = await api.installUpdate();
      setUpdateStatusEvent((current) => ({
        ...current,
        message: result.message,
      }));
      if (!result.ok) setInstalling(false);
    } catch {
      setUpdateStatusEvent({ status: 'error', message: 'Could not restart to install the update.' });
      setInstalling(false);
    }
  }, [api, installing, updateReady]);

  const handleUpdateClick = updateReady ? handleInstallUpdate : handleDownloadLatest;

  return (
    <div className="settings-card">
      <div className="settings-pane__row">
        <div>
          <div className="settings-pane__label">Version</div>
          <div className="settings-pane__sublabel">
            {info ? `Browser Use ${info.version}` : 'Detecting version...'}
          </div>
        </div>
        {info && <span className="settings-pane__value">v{info.version}</span>}
      </div>
      <div className="settings-pane__row">
        <div>
          <div className="settings-pane__label">Updates</div>
          <div className="settings-pane__sublabel">
            {updateStatus}
          </div>
          {(updateStatusEvent.status === 'downloading' || updateStatusEvent.status === 'ready') && (
            <div className="settings-pane__progress" aria-hidden="true">
              <span
                className="settings-pane__progress-fill"
                style={{ width: updateStatusEvent.status === 'ready' ? '100%' : progressWidth }}
              />
            </div>
          )}
        </div>
        <button
          className="conn-card__btn conn-card__btn--secondary"
          onClick={handleUpdateClick}
          disabled={updateActionDisabled}
        >
          {buttonLabel}
        </button>
      </div>
    </div>
  );
}

type TabsPosition = 'side' | 'top';

function readTabsPosition(): TabsPosition {
  try {
    return window.localStorage.getItem('hub-tabs-position') === 'top' ? 'top' : 'side';
  } catch {
    return 'side';
  }
}

function LayoutSection(): React.ReactElement {
  const [position, setPosition] = useState<TabsPosition>(readTabsPosition);

  const choose = useCallback((next: TabsPosition) => {
    setPosition(next);
    try { window.localStorage.setItem('hub-tabs-position', next); } catch { /* ignore */ }
    // HubApp listens for this and dispatches pane:layout-change AFTER React
    // commits the new DOM, so AgentPane re-measures the correct bounds.
    window.dispatchEvent(new CustomEvent('hub:tabs-position-change', { detail: { position: next } }));
  }, []);

  return (
    <div className="settings-card layout-section">
      <div className="layout-section__header">
        <div className="settings-pane__label">Tab layout</div>
        <div className="settings-pane__sublabel">
          Pick where the agent session tabs live. Top reclaims sidebar width for the browser viewport.
        </div>
      </div>
      <div className="layout-picker" role="radiogroup" aria-label="Tab layout">
        <button
          type="button"
          role="radio"
          aria-checked={position === 'side'}
          className={`layout-picker__card${position === 'side' ? ' layout-picker__card--selected' : ''}`}
          onClick={() => choose('side')}
        >
          <div className="layout-picker__mockup layout-picker__mockup--side" aria-hidden="true">
            <div className="layout-picker__mockup-header" />
            <div className="layout-picker__mockup-tabs">
              <span className="layout-picker__mockup-row layout-picker__mockup-row--active" />
              <span className="layout-picker__mockup-row" />
              <span className="layout-picker__mockup-row" />
              <span className="layout-picker__mockup-row" />
            </div>
            <div className="layout-picker__mockup-viewport" />
          </div>
          <div className="layout-picker__label">Side</div>
          <div className="layout-picker__desc">Vertical sidebar on the left. Roomy session labels.</div>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={position === 'top'}
          className={`layout-picker__card${position === 'top' ? ' layout-picker__card--selected' : ''}`}
          onClick={() => choose('top')}
        >
          <div className="layout-picker__mockup layout-picker__mockup--top" aria-hidden="true">
            <div className="layout-picker__mockup-header" />
            <div className="layout-picker__mockup-tabs">
              <span className="layout-picker__mockup-chip layout-picker__mockup-chip--active" />
              <span className="layout-picker__mockup-chip" />
              <span className="layout-picker__mockup-chip" />
              <span className="layout-picker__mockup-chip" />
            </div>
            <div className="layout-picker__mockup-viewport" />
          </div>
          <div className="layout-picker__label">Top</div>
          <div className="layout-picker__desc">Horizontal terminal-style strip. Wider browser viewport.</div>
        </button>
      </div>
    </div>
  );
}

function PrivacySection(): React.ReactElement {
  const [telemetry, setTelemetry] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const api = (window as unknown as { electronAPI: { settings: { privacy: ElectronPrivacyAPI } } }).electronAPI.settings.privacy;
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    api.get().then((state) => {
      if (!cancelled) setTelemetry(state.telemetry);
    }).catch(() => { if (!cancelled) setTelemetry(false); });
    return () => { cancelled = true; };
  }, [api]);

  const handleToggle = useCallback(async () => {
    if (telemetry === null || saving) return;
    const next = !telemetry;
    setSaving(true);
    setTelemetry(next); // optimistic
    try {
      const res = await api.setTelemetry(next);
      setTelemetry(res.telemetry);
      toast.show({
        variant: 'success',
        title: res.telemetry ? 'Telemetry enabled' : 'Telemetry disabled',
      });
    } catch {
      setTelemetry(!next); // revert
      toast.show({
        variant: 'error',
        title: 'Could not save setting',
        message: 'Telemetry change could not be saved. Please try again.',
      });
    } finally {
      setSaving(false);
    }
  }, [telemetry, saving, api, toast]);

  return (
    <div className="settings-card">
      <div className="settings-pane__row">
        <div>
          <div className="settings-pane__label">Allow telemetry to help us make this app better</div>
          <div className="settings-pane__sublabel">Anonymous only — app version, OS, feature usage, and crash reports.</div>
        </div>
        <button
          className="settings-pane__toggle"
          role="switch"
          aria-checked={telemetry === true}
          data-on={telemetry === true}
          onClick={handleToggle}
          disabled={telemetry === null || saving}
        >
          <span className="settings-pane__toggle-thumb" />
        </button>
      </div>

      <div className="settings-pane__row">
        <div>
          <div className="settings-pane__label">System notifications</div>
          <div className="settings-pane__sublabel">Managed by your operating system.</div>
        </div>
        <button
          className="conn-card__btn conn-card__btn--secondary"
          onClick={() => { void api.openSystemNotifications(); }}
        >
          Open system settings
        </button>
      </div>
    </div>
  );
}

export type SettingsSectionId =
  | 'settings-model-providers'
  | 'settings-connections'
  | 'settings-browser-sync'
  | 'settings-activity'
  | 'settings-shortcuts'
  | 'settings-privacy'
  | 'settings-appearance'
  | 'settings-application';

export interface SettingsOpenIntent {
  requestId: number;
  sectionId?: SettingsSectionId;
  focusBrowserCodeProvider?: string;
}

const SETTINGS_TABS: Array<{ id: SettingsSectionId; label: string }> = [
  { id: 'settings-application', label: 'Application' },
  { id: 'settings-activity', label: 'Activity' },
  { id: 'settings-appearance', label: 'Appearance' },
  { id: 'settings-model-providers', label: 'Model providers' },
  { id: 'settings-connections', label: 'Connections' },
  { id: 'settings-browser-sync', label: 'Browser Sync' },
  { id: 'settings-shortcuts', label: 'Shortcuts' },
  { id: 'settings-privacy', label: 'Privacy' },
];

interface SettingsPaneProps {
  intent?: SettingsOpenIntent | null;
  keybindings: KeyBinding[];
  overrides: Record<string, string[]>;
  onUpdateBinding: (id: ActionId, keys: string[]) => Promise<boolean>;
  onResetBinding: (id: ActionId) => void;
  onResetAll: () => void;
  formatShortcut: (shortcut: string) => string;
}

interface KeybindRowProps {
  kb: KeyBinding;
  isOverridden: boolean;
  onUpdate: (id: ActionId, keys: string[]) => Promise<boolean>;
  onReset: (id: ActionId) => void;
  platform: string;
  formatShortcut: (shortcut: string) => string;
}

function KeybindRow({ kb, isOverridden, onUpdate, onReset, platform, formatShortcut }: KeybindRowProps): React.ReactElement {
  const [recording, setRecording] = useState(false);
  const [firstKey, setFirstKey] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const isGlobalShortcut = kb.id === 'action.createPane';

  const finishRecording = useCallback(async (keys: string[]) => {
    setRecording(false);
    setFirstKey(null);
    (document.activeElement as HTMLElement | null)?.blur?.();
    const ok = await onUpdate(kb.id, keys);
    setRecordingError(ok ? null : 'That shortcut is unavailable. Choose another one.');
  }, [kb.id, onUpdate]);

  useEffect(() => {
    if (!recording) return;
    const timer = setTimeout(() => {
      if (firstKey) {
        void finishRecording([firstKey]);
      } else {
        setRecording(false);
        setRecordingError('No shortcut was detected. Choose another combination.');
      }
    }, firstKey ? 700 : 8000);

    const handler = async (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        setRecording(false);
        setFirstKey(null);
        setRecordingError(null);
        return;
      }

      if (e.key === 'Unidentified') {
        clearTimeout(timer);
        setRecording(false);
        setFirstKey(null);
        setRecordingError('That shortcut is unavailable. Choose another one.');
        return;
      }

      const combo = keyboardEventToShortcut(e, platform);
      if (!combo) return;

      if (isGlobalShortcut && !e.metaKey && !e.ctrlKey && !e.altKey) return;

      if (firstKey) {
        clearTimeout(timer);
        await finishRecording([`${firstKey} ${combo}`]);
        return;
      }

      // If modifier present, commit immediately. Else wait briefly for possible chord.
      if (e.metaKey || e.ctrlKey || e.altKey) {
        clearTimeout(timer);
        await finishRecording([combo]);
        return;
      }

      setRecordingError(null);
      setFirstKey(combo);
    };
    window.addEventListener('keydown', handler, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handler, true);
    };
  }, [finishRecording, firstKey, isGlobalShortcut, platform, recording]);

  return (
    <div className={`settings-pane__row${isOverridden ? ' settings-pane__row--modified' : ''}`}>
      <div className="settings-pane__label-block">
        <span className="settings-pane__label">{kb.label}</span>
        <span className="settings-pane__sublabel">{kb.category}</span>
      </div>
      <div className="settings-pane__row-right">
        <button
          className={`settings-pane__key-btn${recording ? ' settings-pane__key-btn--recording' : ''}`}
          onClick={() => {
            setRecordingError(null);
            setRecording(true);
            setFirstKey(null);
          }}
        >
          {recording ? (
            <span className="settings-pane__recording">
              {firstKey ? `${formatShortcut(firstKey)} + ...` : 'Press key...'}
            </span>
          ) : (
            kb.keys.map((k, i) => (
              <kbd key={i} className="settings-pane__kbd">{formatShortcut(k)}</kbd>
            ))
          )}
        </button>
        <button
          className="settings-pane__reset-btn"
          onClick={() => onReset(kb.id)}
          title="Reset to default"
          style={{ visibility: isOverridden && !recording ? 'visible' : 'hidden' }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2.5 4.5h4a3 3 0 010 6h-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4.5 2.5L2.5 4.5 4.5 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {recordingError && <span className="settings-pane__key-error">{recordingError}</span>}
    </div>
  );
}

export function SettingsPane({ intent, keybindings, overrides, onUpdateBinding, onResetBinding, onResetAll, formatShortcut }: SettingsPaneProps): React.ReactElement {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('settings-application');
  const platform = window.electronAPI?.shell?.platform ?? fallbackShortcutPlatform();
  // Cookie sync is unsupported on Windows (Chromium ABE + DevTools hardening),
  // so the Browser Sync tab + section are hidden on win32.
  const tabs = platform === 'win32'
    ? SETTINGS_TABS.filter((tab) => tab.id !== 'settings-browser-sync')
    : SETTINGS_TABS;

  const scrollToSection = useCallback((id: SettingsSectionId, behavior: ScrollBehavior = 'smooth') => {
    const scroller = scrollerRef.current;
    const target = scroller?.querySelector<HTMLElement>(`#${id}`);
    if (!scroller || !target) return;
    const tabOffset = 96;
    scroller.scrollTo({
      top: Math.max(0, target.offsetTop - tabOffset),
      behavior,
    });
    setActiveSection(id);
  }, []);

  const updateActiveFromScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let next = tabs[0].id;
    const threshold = scroller.scrollTop + 112;
    for (const tab of tabs) {
      const section = scroller.querySelector<HTMLElement>(`#${tab.id}`);
      if (section && section.offsetTop <= threshold) next = tab.id;
    }
    setActiveSection(next);
  }, [tabs]);

  useEffect(() => {
    const sectionId = intent?.sectionId ?? (
      intent?.focusBrowserCodeProvider ? 'settings-model-providers' : undefined
    );
    if (!sectionId) return;
    requestAnimationFrame(() => scrollToSection(sectionId, 'auto'));
  }, [intent?.requestId, intent?.sectionId, intent?.focusBrowserCodeProvider, scrollToSection]);

  const providerFocus: SettingsProviderFocusRequest | null = intent?.focusBrowserCodeProvider
    ? { providerId: intent.focusBrowserCodeProvider, requestId: intent.requestId }
    : null;

  return (
    <div className="settings-page">
      <div className="settings-page__scroller" ref={scrollerRef} onScroll={updateActiveFromScroll}>
        <div className="settings-page__content">
          <header className="settings-page__header">
            <div>
              <span className="settings-page__eyebrow">Browser Use</span>
              <h1 className="settings-page__title">Settings</h1>
            </div>
          </header>

          <nav className="settings-page__tabs" aria-label="Settings sections">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`settings-page__tab${activeSection === tab.id ? ' settings-page__tab--active' : ''}`}
                onClick={() => scrollToSection(tab.id)}
                data-settings-tab={tab.id}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <section id="settings-application" className="settings-page__section">
            <div className="settings-section-header">
              <h2 className="settings-section-header__title">Application</h2>
            </div>
            <AppSection />
            <LayoutSection />
          </section>

          <section id="settings-activity" className="settings-page__section">
            <div className="settings-section-header">
              <h2 className="settings-section-header__title">Activity</h2>
            </div>
            <ActivitySection />
          </section>

          <section id="settings-appearance" className="settings-page__section">
            <div className="settings-section-header">
              <h2 className="settings-section-header__title">Appearance</h2>
            </div>
            <AppearanceSection />
            <SpinnerVerbsSection />
          </section>

          <ConnectionsPane
            embedded
            providerSectionId="settings-model-providers"
            connectionsSectionId="settings-connections"
            browserSyncSectionId="settings-browser-sync"
            focusBrowserCodeProvider={providerFocus}
          />

          <section id="settings-shortcuts" className="settings-page__section">
            <div className="settings-section-header">
              <h2 className="settings-section-header__title">Shortcuts</h2>
              {Object.keys(overrides).length > 0 && (
                <button className="settings-pane__reset-all" onClick={onResetAll}>Reset all</button>
              )}
            </div>
            <div className="settings-card settings-card--shortcuts">
              {keybindings.map((kb) => (
                <KeybindRow
                  key={kb.id}
                  kb={kb}
                  isOverridden={kb.id in overrides}
                  onUpdate={onUpdateBinding}
                  onReset={onResetBinding}
                  platform={platform}
                  formatShortcut={formatShortcut}
                />
              ))}
            </div>
          </section>

          <section id="settings-privacy" className="settings-page__section settings-page__section--last">
            <div className="settings-section-header">
              <h2 className="settings-section-header__title">Privacy</h2>
            </div>
            <PrivacySection />
          </section>
        </div>
      </div>
    </div>
  );
}
