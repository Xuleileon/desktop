import React, { useEffect, useState } from 'react';
import { useI18n } from './i18n';

export interface EnginePreferenceView {
  id: string;
  displayName: string;
  model: string;
  leanMode: boolean;
  models: Array<{ id: string; label: string }>;
  modelConfigurable: boolean;
  leanModeConfigurable: boolean;
}

let cachedPreferences: EnginePreferenceView[] | null = null;
let pendingPreferences: Promise<EnginePreferenceView[]> | null = null;

export async function loadPreferences(): Promise<EnginePreferenceView[]> {
  if (cachedPreferences && cachedPreferences.length > 0) return cachedPreferences;
  if (!pendingPreferences) {
    const api = window.electronAPI?.settings?.enginePreferences;
    pendingPreferences = api ? api.get() : Promise.resolve([]);
  }
  try {
    cachedPreferences = await pendingPreferences;
    return cachedPreferences;
  } finally {
    pendingPreferences = null;
  }
}

function updateCache(next: EnginePreferenceView): void {
  if (!cachedPreferences) return;
  cachedPreferences = cachedPreferences.map((item) => item.id === next.id ? next : item);
}

export function EnginePreferenceControls({ engineId }: { engineId: string }): React.ReactElement | null {
  const { tr } = useI18n();
  const [item, setItem] = useState<EnginePreferenceView | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadPreferences()
      .then((items) => {
        if (!cancelled) setItem(items.find((entry) => entry.id === engineId) ?? null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => { cancelled = true; };
  }, [engineId]);

  const persist = async (next: EnginePreferenceView): Promise<void> => {
    const api = window.electronAPI?.settings?.enginePreferences;
    if (!api) return;
    setSaving(true);
    try {
      await api.save({ engineId: next.id, model: next.model.trim(), leanMode: next.leanMode });
      const saved = { ...next, model: next.model.trim() };
      setItem(saved);
      updateCache(saved);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!item || (!item.modelConfigurable && !item.leanModeConfigurable)) return null;

  return (
    <div className="engine-preference-controls">
      {item.modelConfigurable && (
        <label className="engine-preference-controls__model">
          <span className="conn-card__field-label">{tr('Model', '模型')}</span>
          <input
            className="conn-card__api-key-input"
            list={`engine-models-${item.id}`}
            value={item.model}
            placeholder={tr('Default model or custom model ID', '默认模型，或输入自定义模型 ID')}
            onChange={(event) => setItem({ ...item, model: event.target.value })}
            onBlur={() => { void persist(item); }}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
          />
          <datalist id={`engine-models-${item.id}`}>
            {item.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
          </datalist>
        </label>
      )}
      {item.leanModeConfigurable && (
        <div className="engine-preference-controls__lean">
          <span>
            <strong>{tr('Lean mode', '精简模式')}</strong>
            <small>{engineId === 'browsercode'
              ? tr('Do not load external plugins', '不加载外部插件')
              : tr('Do not load external MCP', '不加载外部 MCP')}</small>
          </span>
          <button
            type="button"
            className="settings-pane__toggle"
            data-on={item.leanMode}
            disabled={saving}
            aria-label={tr(`Toggle lean mode for ${item.displayName}`, `切换 ${item.displayName} 精简模式`)}
            onClick={() => {
              const next = { ...item, leanMode: !item.leanMode };
              setItem(next);
              void persist(next);
            }}
          >
            <span className="settings-pane__toggle-thumb" />
          </button>
        </div>
      )}
      {error && <span className="conn-card__api-key-error engine-preference-controls__error">{error}</span>}
    </div>
  );
}
