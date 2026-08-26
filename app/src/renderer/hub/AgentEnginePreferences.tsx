import React, { useCallback, useEffect, useState } from 'react';
import { EngineLogo } from './EnginePicker';
import { useI18n } from './i18n';

interface EnginePreferenceView {
  id: string;
  displayName: string;
  model: string;
  leanMode: boolean;
  models: Array<{ id: string; label: string }>;
  modelConfigurable: boolean;
}

export function AgentEnginePreferences(): React.ReactElement {
  const { tr } = useI18n();
  const [items, setItems] = useState<EnginePreferenceView[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const api = window.electronAPI?.settings?.enginePreferences;
    if (!api) return;
    try {
      setItems(await api.get());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const persist = useCallback(async (item: EnginePreferenceView) => {
    const api = window.electronAPI?.settings?.enginePreferences;
    if (!api) return;
    setSaving(item.id);
    try {
      await api.save({ engineId: item.id, model: item.model.trim(), leanMode: item.leanMode });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  }, []);

  const update = (id: string, patch: Partial<EnginePreferenceView>): void => {
    setItems((current) => current.map((item) => {
      if (item.id !== id) return item;
      return { ...item, ...patch };
    }));
  };

  return (
    <div className="conn-card agent-engine-preferences">
      <div className="conn-card__header">
        <div className="conn-card__icon conn-card__icon--letter">A</div>
        <div className="conn-card__info">
          <div className="conn-card__title-row">
            <span className="conn-card__name">{tr('Agent frameworks', 'Agent 框架')}</span>
          </div>
          <span className="conn-card__subtitle">
            {tr('Choose each CLI agent model. Lean mode skips external MCP startup.', '为每个 CLI Agent 选择模型；精简模式会跳过外部 MCP 启动。')}
          </span>
        </div>
      </div>
      {items.map((item) => (
        <div className="conn-card__sub agent-engine-preferences__row" key={item.id}>
          <div className="agent-engine-preferences__identity">
            <EngineLogo id={item.id} />
            <span className="conn-card__name conn-card__name--sub">{item.displayName}</span>
          </div>
          <label className="conn-card__field conn-card__field--wide">
            <span className="conn-card__field-label">{tr('Model', '模型')}</span>
            {item.modelConfigurable ? (
              <input
                className="conn-card__api-key-input agent-engine-preferences__model"
                list={`engine-models-${item.id}`}
                value={item.model}
                placeholder={tr('Default (leave empty) or custom model ID', '留空使用默认模型，或输入自定义模型 ID')}
                onChange={(event) => update(item.id, { model: event.target.value })}
                onBlur={() => { const current = items.find((entry) => entry.id === item.id); if (current) void persist(current); }}
                onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
              />
            ) : (
              <span className="agent-engine-preferences__external-model">
                {tr('Configured by the active BrowserCode provider', '由当前 BrowserCode 提供商配置')}
              </span>
            )}
            <datalist id={`engine-models-${item.id}`}>
              {item.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
            </datalist>
          </label>
          <label className="agent-engine-preferences__lean">
            <span>
              <strong>{tr('Lean mode', '精简模式')}</strong>
              <small>{tr('No external MCP', '不加载外部 MCP')}</small>
            </span>
            <button
              type="button"
              className="settings-pane__toggle"
              data-on={item.leanMode}
              disabled={saving === item.id}
              aria-label={tr(`Toggle lean mode for ${item.displayName}`, `切换 ${item.displayName} 精简模式`)}
              onClick={() => {
                const next = { ...item, leanMode: !item.leanMode };
                update(item.id, { leanMode: next.leanMode });
                void persist(next);
              }}
            >
              <span className="settings-pane__toggle-thumb" />
            </button>
          </label>
        </div>
      ))}
      {items.length === 0 && !error && <div className="conn-card__sub">{tr('Loading agent frameworks…', '正在加载 Agent 框架…')}</div>}
      {error && <div className="conn-card__api-key-edit"><span className="conn-card__api-key-error">{error}</span></div>}
    </div>
  );
}
