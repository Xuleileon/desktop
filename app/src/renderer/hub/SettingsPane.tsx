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
import { useI18n, type AppLocale } from './i18n';

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
  const { tr } = useI18n();
  return (
    <div className="settings-card">
      <SettingsRow
        label={tr('Theme', '主题')}
        sublabel={
          mode === 'system'
            ? tr(`Following your system (${resolved}).`, `跟随系统（${resolved === 'dark' ? '深色' : '浅色'}）。`)
            : tr('Choose how Browser Use looks across windows.', '选择 Browser Use 在各窗口中的外观。')
        }
      >
        <SegmentedControl
          value={mode}
          options={APPEARANCE_OPTIONS.map((option) => ({
            ...option,
            label: option.value === 'light' ? tr('Light', '浅色') : option.value === 'dark' ? tr('Dark', '深色') : tr('System', '跟随系统'),
            hint: option.value === 'system' ? tr('Follow your operating system', '跟随操作系统设置') : option.hint,
          }))}
          onChange={setMode}
          ariaLabel={tr('Theme', '主题')}
        />
      </SettingsRow>
    </div>
  );
}

function SpinnerVerbsSection(): React.ReactElement {
  const { tr } = useI18n();
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
        label={tr('Spinner verb', '运行提示词')}
        sublabel={tr('The word shown next to the busy spinner. Cycles through the list while the agent runs.', 'Agent 运行时在加载图标旁循环显示的词语。')}
      >
        <select
          className="settings-pane__select"
          value={presetId}
          onChange={(e) => setPreset(e.target.value as SpinnerPresetId)}
          aria-label={tr('Spinner verb preset', '运行提示词预设')}
        >
          {presetOptions.map(([id, preset]) => (
            <option key={id} value={id}>{preset.label}</option>
          ))}
          <option value="custom">{tr('Custom', '自定义')}</option>
        </select>
      </SettingsRow>

      <SettingsRow
        label={tr('Preview', '预览')}
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
          label={tr('Custom verbs', '自定义提示词')}
          sublabel={tr('One verb per line. Blank lines are ignored. Falls back to "Working" if empty.', '每行一个词，忽略空行；留空时使用 Working。')}
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
        label={tr('Cycle interval', '切换间隔')}
        sublabel={tr(`How long each verb stays visible (${(cycleMs / 1000).toFixed(1)}s).`, `每个提示词显示 ${(cycleMs / 1000).toFixed(1)} 秒。`)}
      >
        <input
          type="range"
          min={MIN_CYCLE_MS}
          max={MAX_CYCLE_MS}
          step={100}
          value={cycleMs}
          onChange={(e) => setCycleMs(Number(e.target.value))}
          aria-label={tr('Spinner verb cycle interval', '运行提示词切换间隔')}
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

function AppSection(): React.ReactElement {
  const { locale, setLocale, tr } = useI18n();
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
      ? tr('Checking latest version...', '正在检查最新版本…')
      : updateReady
        ? tr('Update is ready to install.', '更新已准备好安装。')
        : updateBusy
          ? tr('Checking for updates...', '正在检查更新…')
          : onLatest
            ? tr('You are on the latest version.', '当前已是最新版本。')
            : info.latestVersion
              ? tr(`Latest version is ${info.latestVersion}.`, `最新版本为 ${info.latestVersion}。`)
              : canDownloadUpdate
                ? tr('Checks on startup and every hour.', '启动时及每小时自动检查更新。')
                : tr('In-app updates are available in packaged release builds.', '应用内更新仅在正式安装版中可用。')
  );
  const buttonLabel = !info || checking
    ? tr('Checking...', '检查中…')
    : installing
      ? tr('Restarting...', '正在重启…')
      : updateReady
        ? tr('Restart to install', '重启并安装')
        : onLatest
          ? tr('On latest', '已是最新')
          : canDownloadUpdate
            ? tr('Download update', '下载更新')
            : tr('Unavailable', '不可用');

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
      <SettingsRow
        label={tr('Language', '语言')}
        sublabel={tr('Choose the display language. Changes apply immediately.', '选择界面语言，修改后立即生效。')}
      >
        <SegmentedControl<AppLocale>
          value={locale}
          options={[
            { value: 'zh-CN', label: '简体中文' },
            { value: 'en-US', label: 'English' },
          ]}
          onChange={setLocale}
          ariaLabel={tr('Language', '语言')}
        />
      </SettingsRow>
      <div className="settings-pane__row">
        <div>
          <div className="settings-pane__label">{tr('Version', '版本')}</div>
          <div className="settings-pane__sublabel">
            {info ? `Browser Use ${info.version}` : tr('Detecting version...', '正在检测版本…')}
          </div>
        </div>
        {info && <span className="settings-pane__value">v{info.version}</span>}
      </div>
      <div className="settings-pane__row">
        <div>
          <div className="settings-pane__label">{tr('Updates', '更新')}</div>
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
  const { tr } = useI18n();
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
        <div className="settings-pane__label">{tr('Tab layout', '标签页布局')}</div>
        <div className="settings-pane__sublabel">
          {tr('Pick where the agent session tabs live. Top reclaims sidebar width for the browser viewport.', '选择 Agent 会话标签的位置；顶部布局可为浏览器腾出更多宽度。')}
        </div>
      </div>
      <div className="layout-picker" role="radiogroup" aria-label={tr('Tab layout', '标签页布局')}>
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
          <div className="layout-picker__label">{tr('Side', '侧边')}</div>
          <div className="layout-picker__desc">{tr('Vertical sidebar on the left. Roomy session labels.', '左侧垂直栏，会话标题空间更充足。')}</div>
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
          <div className="layout-picker__label">{tr('Top', '顶部')}</div>
          <div className="layout-picker__desc">{tr('Horizontal terminal-style strip. Wider browser viewport.', '顶部横向标签栏，浏览器视口更宽。')}</div>
        </button>
      </div>
    </div>
  );
}

function PrivacySection(): React.ReactElement {
  const { tr } = useI18n();
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
          <div className="settings-pane__label">{tr('Allow telemetry to help us make this app better', '允许匿名遥测以帮助改进应用')}</div>
          <div className="settings-pane__sublabel">{tr('Anonymous only — app version, OS, feature usage, and crash reports.', '仅包含匿名信息：应用版本、操作系统、功能使用情况和崩溃报告。')}</div>
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
          <div className="settings-pane__label">{tr('System notifications', '系统通知')}</div>
          <div className="settings-pane__sublabel">{tr('Managed by your operating system.', '由操作系统管理。')}</div>
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
  const { tr, tx } = useI18n();
  const [recording, setRecording] = useState(false);
  const [firstKey, setFirstKey] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const isGlobalShortcut = kb.id === 'action.createPane';

  const finishRecording = useCallback(async (keys: string[]) => {
    setRecording(false);
    setFirstKey(null);
    (document.activeElement as HTMLElement | null)?.blur?.();
    const ok = await onUpdate(kb.id, keys);
    setRecordingError(ok ? null : tr('That shortcut is unavailable. Choose another one.', '该快捷键不可用，请选择其他组合。'));
  }, [kb.id, onUpdate, tr]);

  useEffect(() => {
    if (!recording) return;
    const timer = setTimeout(() => {
      if (firstKey) {
        void finishRecording([firstKey]);
      } else {
        setRecording(false);
        setRecordingError(tr('No shortcut was detected. Choose another combination.', '未检测到快捷键，请选择其他组合。'));
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
        setRecordingError(tr('That shortcut is unavailable. Choose another one.', '该快捷键不可用，请选择其他组合。'));
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
  }, [finishRecording, firstKey, isGlobalShortcut, platform, recording, tr]);

  return (
    <div className={`settings-pane__row${isOverridden ? ' settings-pane__row--modified' : ''}`}>
      <div className="settings-pane__label-block">
        <span className="settings-pane__label">{tx(kb.label)}</span>
        <span className="settings-pane__sublabel">{tx(kb.category)}</span>
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
              {firstKey ? `${formatShortcut(firstKey)} + ...` : tr('Press key...', '请按键…')}
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
          title={tr('Reset to default', '恢复默认')}
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
  const { tr } = useI18n();
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
              <h1 className="settings-page__title">{tr('Settings', '设置')}</h1>
            </div>
          </header>

          <nav className="settings-page__tabs" aria-label={tr('Settings sections', '设置分类')}>
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`settings-page__tab${activeSection === tab.id ? ' settings-page__tab--active' : ''}`}
                onClick={() => scrollToSection(tab.id)}
                data-settings-tab={tab.id}
              >
                {tab.id === 'settings-application' ? tr(tab.label, '应用')
                  : tab.id === 'settings-appearance' ? tr(tab.label, '外观')
                    : tab.id === 'settings-model-providers' ? tr(tab.label, '模型提供商')
                      : tab.id === 'settings-connections' ? tr(tab.label, '连接')
                        : tab.id === 'settings-browser-sync' ? tr(tab.label, '浏览器同步')
                          : tab.id === 'settings-shortcuts' ? tr(tab.label, '快捷键')
                            : tr(tab.label, '隐私')}
              </button>
            ))}
          </nav>

          <section id="settings-application" className="settings-page__section">
            <div className="settings-section-header">
              <h2 className="settings-section-header__title">{tr('Application', '应用')}</h2>
            </div>
            <AppSection />
            <LayoutSection />
          </section>

          <section id="settings-appearance" className="settings-page__section">
            <div className="settings-section-header">
              <h2 className="settings-section-header__title">{tr('Appearance', '外观')}</h2>
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
              <h2 className="settings-section-header__title">{tr('Shortcuts', '快捷键')}</h2>
              {Object.keys(overrides).length > 0 && (
                <button className="settings-pane__reset-all" onClick={onResetAll}>{tr('Reset all', '全部重置')}</button>
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
              <h2 className="settings-section-header__title">{tr('Privacy', '隐私')}</h2>
            </div>
            <PrivacySection />
          </section>
        </div>
      </div>
    </div>
  );
}
