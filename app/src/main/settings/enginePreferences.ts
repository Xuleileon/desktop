import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { mainLogger } from '../logger';

export interface EnginePreference {
  model: string;
  leanMode: boolean;
}

export type EnginePreferences = Record<string, EnginePreference>;

function preferencesPath(): string {
  return path.join(app.getPath('userData'), 'engine-preferences.json');
}

function normalizePreference(value: unknown): EnginePreference {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    model: typeof record.model === 'string' ? record.model.trim().slice(0, 200) : '',
    leanMode: record.leanMode === true,
  };
}

export function loadEnginePreferences(): EnginePreferences {
  try {
    const parsed = JSON.parse(fs.readFileSync(preferencesPath(), 'utf8')) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).map(([id, value]) => [id, normalizePreference(value)]));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      mainLogger.warn('enginePreferences.load.failed', { error: (err as Error).message });
    }
    return {};
  }
}

export function loadEnginePreference(engineId: string): EnginePreference {
  return loadEnginePreferences()[engineId] ?? { model: '', leanMode: false };
}

export function saveEnginePreference(engineId: string, preference: EnginePreference): EnginePreference {
  const normalized = normalizePreference(preference);
  const target = preferencesPath();
  const temp = `${target}.${process.pid}.tmp`;
  const all = loadEnginePreferences();
  all[engineId] = normalized;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, target);
  mainLogger.info('enginePreferences.saved', {
    engineId,
    model: normalized.model || null,
    leanMode: normalized.leanMode,
  });
  return normalized;
}
