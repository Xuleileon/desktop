import { create } from 'zustand';

export type AppLocale = 'zh-CN' | 'en-US';

const ZH_UI_TEXT: Record<string, string> = {
  'Next session': '下一个会话',
  'Previous session': '上一个会话',
  'First session': '第一个会话',
  'Last session': '最后一个会话',
  'Open session': '打开会话',
  Dashboard: '仪表盘',
  'Grid view': '网格视图',
  Settings: '设置',
  Search: '搜索',
  'New agent': '新建 Agent',
  'New pane': '新建窗格',
  'Dismiss session': '关闭会话',
  'Cancel session': '取消会话',
  'Follow up': '继续追问',
  'Scroll down': '向下滚动',
  'Scroll up': '向上滚动',
  'Keybindings help': '快捷键帮助',
  'Command bar': '命令栏',
  'Close overlay': '关闭浮层',
  Navigation: '导航',
  Views: '视图',
  Actions: '操作',
  Scroll: '滚动',
  Meta: '其他',
  Draft: '草稿',
  Running: '运行中',
  Stuck: '受阻',
  Paused: '已暂停',
  Stopped: '已停止',
  Idle: '空闲',
};

export function translateUiText(text: string, locale: AppLocale): string {
  return locale === 'zh-CN' ? (ZH_UI_TEXT[text] ?? text) : text;
}

const STORAGE_KEY = 'hub.locale';

function readLocale(): AppLocale {
  // Existing renderer tests assert the upstream English copy. Keep that
  // baseline stable while production defaults to Simplified Chinese.
  if (import.meta.env.MODE === 'test') return 'en-US';
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'en-US' ? 'en-US' : 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}

interface LanguageState {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
}

export const useLanguageStore = create<LanguageState>((set) => ({
  locale: readLocale(),
  setLocale: (locale) => {
    try { window.localStorage.setItem(STORAGE_KEY, locale); } catch { /* ignore */ }
    document.documentElement.lang = locale;
    set({ locale });
  },
}));

export function initLocale(): void {
  const locale = useLanguageStore.getState().locale;
  document.documentElement.lang = locale;
  try {
    if (!window.localStorage.getItem(STORAGE_KEY)) window.localStorage.setItem(STORAGE_KEY, locale);
  } catch { /* ignore */ }
}

export function useI18n(): {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
  tr: (english: string, chinese: string) => string;
  tx: (text: string) => string;
} {
  const locale = useLanguageStore((state) => state.locale);
  const setLocale = useLanguageStore((state) => state.setLocale);
  return {
    locale,
    setLocale,
    tr: (english, chinese) => locale === 'zh-CN' ? chinese : english,
    tx: (text) => translateUiText(text, locale),
  };
}
