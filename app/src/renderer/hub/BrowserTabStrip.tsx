import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TabInfo } from '../../shared/session-schemas';
import { useI18n } from './i18n';

export type BrowserPageTab = TabInfo;

interface BrowserTabStripProps {
  sessionId: string;
  running: boolean;
  onTakeOver?: () => void;
}

function displayTitle(tab: BrowserPageTab, newTabLabel: string): string {
  const title = tab.title.trim();
  if (title && title !== 'New Tab') return title;
  if (tab.url === 'about:blank') return newTabLabel;
  try {
    return new URL(tab.url).hostname.replace(/^www\./, '') || newTabLabel;
  } catch {
    return title || newTabLabel;
  }
}

function tabDescription(
  tab: BrowserPageTab,
  title: string,
  labels: { root: string; pinned: string; loading: string; separator: string },
): string {
  const parts = [title];
  if (tab.isRoot) parts.push(labels.root);
  if (tab.pinned) parts.push(labels.pinned);
  if (tab.isLoading) parts.push(labels.loading);
  return parts.join(labels.separator);
}

function GlobeIcon(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.15" />
      <path d="M2 7h10M7 2c1.45 1.55 1.45 8.45 0 10M7 2C5.55 3.55 5.55 10.45 7 12" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" />
    </svg>
  );
}

function RootIcon(): React.ReactElement {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2 5.25L6 2l4 3.25V10H7.5V7H4.5v3H2V5.25z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  );
}

function PinIcon({ pinned }: { pinned: boolean }): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill={pinned ? 'currentColor' : 'none'} aria-hidden="true">
      <path d="M4.5 2.25h5l-.8 3.1 1.55 1.55v1.1h-2.7L7 11.75 6.45 8h-2.7V6.9L5.3 5.35l-.8-3.1z" stroke="currentColor" strokeWidth="1.05" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon(): React.ReactElement {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3 3l6 6M9 3L3 9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

export function BrowserTabStrip({ sessionId, running, onTakeOver }: BrowserTabStripProps): React.ReactElement {
  const { tr } = useI18n();
  const [tabs, setTabs] = useState<BrowserPageTab[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const stripRef = useRef<HTMLDivElement>(null);

  const sessionsApi = window.electronAPI?.sessions;
  const eventsApi = window.electronAPI?.on;

  const refreshTabs = useCallback(async (): Promise<void> => {
    if (!sessionsApi?.getTabs) return;
    const next = (await sessionsApi.getTabs(sessionId)).filter((tab) => tab.type === 'page');
    setTabs(next);
    setLoading(false);
  }, [sessionId, sessionsApi]);

  useEffect(() => {
    let disposed = false;
    let receivedPush = false;
    setTabs([]);
    setLoading(true);
    setAnnouncement('');

    const off = eventsApi?.sessionTabsChanged?.((changedSessionId, changedTabs) => {
      if (disposed || changedSessionId !== sessionId) return;
      receivedPush = true;
      setTabs(changedTabs.filter((tab) => tab.type === 'page'));
      setLoading(false);
    });

    if (sessionsApi?.getTabs) {
      void sessionsApi.getTabs(sessionId).then((initialTabs) => {
        if (disposed || receivedPush) return;
        setTabs(initialTabs.filter((tab) => tab.type === 'page'));
        setLoading(false);
      }).catch(() => {
        if (!disposed) setLoading(false);
      });
    } else {
      setLoading(false);
    }

    return () => {
      disposed = true;
      off?.();
    };
  }, [eventsApi, sessionId, sessionsApi]);

  useEffect(() => {
    const activeTab = stripRef.current?.querySelector<HTMLElement>('[data-browser-tab-active="true"]');
    activeTab?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [tabs]);

  const activeTargetId = useMemo(() => tabs.find((tab) => tab.active)?.targetId, [tabs]);

  const runAction = useCallback(async (
    actionKey: string,
    action: (() => Promise<void>) | undefined,
    successAnnouncement: string,
  ): Promise<void> => {
    if (!action || pendingAction) return;
    setPendingAction(actionKey);
    setAnnouncement('');
    try {
      await action();
      setAnnouncement(successAnnouncement);
      // Push events are authoritative. This refresh is a compatibility fallback
      // for a main process that completed the operation before emitting one.
      await refreshTabs().catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setAnnouncement(`${tr('Action failed', '操作失败')}：${message}`);
    } finally {
      setPendingAction(null);
    }
  }, [pendingAction, refreshTabs, tr]);

  const activate = useCallback((tab: BrowserPageTab): void => {
    if (tab.active) return;
    void runAction(
      `activate:${tab.targetId}`,
      sessionsApi?.activatePage ? async () => {
        const result = await sessionsApi.activatePage(sessionId, tab.targetId);
        if (!result.activated) throw new Error(result.reason ?? tr('Unable to switch page', '页面无法切换'));
      } : undefined,
      `${tr('Switched to', '已切换到')}${displayTitle(tab, tr('New tab', '新标签页'))}`,
    );
  }, [runAction, sessionId, sessionsApi, tr]);

  const close = useCallback((tab: BrowserPageTab): void => {
    if (tab.isRoot) return;
    void runAction(
      `close:${tab.targetId}`,
      sessionsApi?.closePage ? async () => {
        const result = await sessionsApi.closePage(sessionId, tab.targetId);
        if (!result.closed) throw new Error(result.reason ?? tr('Unable to close page', '页面无法关闭'));
      } : undefined,
      `${tr('Closed ', '已关闭')}${displayTitle(tab, tr('New tab', '新标签页'))}`,
    );
  }, [runAction, sessionId, sessionsApi, tr]);

  const togglePinned = useCallback((tab: BrowserPageTab): void => {
    if (tab.isRoot) return;
    const nextPinned = !tab.pinned;
    void runAction(
      `pin:${tab.targetId}`,
      sessionsApi?.setPagePinned
        ? async () => {
          const result = await sessionsApi.setPagePinned(sessionId, tab.targetId, nextPinned);
          if (result.reason || result.pinned !== nextPinned) {
            throw new Error(result.reason ?? tr('Page pin state was not updated', '页面固定状态未更新'));
          }
        }
        : undefined,
      `${nextPinned ? tr('Pinned ', '已固定') : tr('Unpinned ', '已取消固定')}${displayTitle(tab, tr('New tab', '新标签页'))}`,
    );
  }, [runAction, sessionId, sessionsApi, tr]);

  const handleTabKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowLeft') nextIndex = index === 0 ? tabs.length - 1 : index - 1;
    if (event.key === 'ArrowRight') nextIndex = index === tabs.length - 1 ? 0 : index + 1;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null || !tabs[nextIndex]) return;
    event.preventDefault();
    const nextButton = stripRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex];
    nextButton?.focus();
    activate(tabs[nextIndex]);
  }, [activate, tabs]);

  return (
    <div className="browser-tabs" aria-label={tr('Browser pages', '浏览器页面')}>
      <div className="browser-tabs__scroller" ref={stripRef} role="tablist" aria-label={tr('Pages in this Space', '当前 Space 的页面')}>
        {tabs.map((tab, index) => {
          const actionBusy = pendingAction?.endsWith(`:${tab.targetId}`) === true;
          const title = displayTitle(tab, tr('New tab', '新标签页'));
          return (
            <div
              key={tab.targetId}
              className={`browser-tabs__tab${tab.active ? ' browser-tabs__tab--active' : ''}${tab.pinned ? ' browser-tabs__tab--pinned' : ''}`}
              data-browser-tab-active={tab.active ? 'true' : 'false'}
            >
              <button
                type="button"
                className="browser-tabs__select"
                role="tab"
                aria-selected={tab.active}
                aria-label={tabDescription(tab, title, {
                  root: tr('Root page', '根页面'),
                  pinned: tr('Pinned', '已固定'),
                  loading: tr('Loading', '正在加载'),
                  separator: tr(', ', '，'),
                })}
                tabIndex={tab.active || (!activeTargetId && index === 0) ? 0 : -1}
                disabled={actionBusy}
                onClick={() => activate(tab)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
                title={`${title}\n${tab.url}`}
              >
                <span className="browser-tabs__favicon">
                  {tab.isLoading ? (
                    <span className="browser-tabs__spinner" aria-hidden="true" />
                  ) : tab.faviconUrl ? (
                    <img
                      src={tab.faviconUrl}
                      alt=""
                      onError={(event) => { event.currentTarget.style.display = 'none'; }}
                    />
                  ) : (
                    <GlobeIcon />
                  )}
                </span>
                <span className="browser-tabs__title">{title}</span>
                {tab.isRoot && (
                  <span className="browser-tabs__root" title={tr('Space root page', 'Space 根页面')} aria-label={tr('Root page', '根页面')}>
                    <RootIcon />
                  </span>
                )}
              </button>
              {!tab.isRoot && (
                <div className="browser-tabs__tab-actions">
                  <button
                    type="button"
                    className={`browser-tabs__icon-btn browser-tabs__pin${tab.pinned ? ' browser-tabs__pin--active' : ''}`}
                    onClick={() => togglePinned(tab)}
                    disabled={actionBusy}
                    aria-label={tab.pinned ? `${tr('Unpin ', '取消固定')}${title}` : `${tr('Pin ', '固定')}${title}`}
                    title={tab.pinned ? tr('Unpin', '取消固定') : tr('Pin page', '固定页面')}
                  >
                    <PinIcon pinned={tab.pinned} />
                  </button>
                  <button
                    type="button"
                    className="browser-tabs__icon-btn browser-tabs__close"
                    onClick={() => close(tab)}
                    disabled={actionBusy}
                    aria-label={`${tr('Close ', '关闭')}${title}`}
                    title={tr('Close page', '关闭页面')}
                  >
                    <CloseIcon />
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {tabs.length === 0 && (
          <div className="browser-tabs__empty" role="status">
            {loading ? tr('Connecting to browser…', '正在连接浏览器…') : tr('No pages open yet', '尚未打开页面')}
          </div>
        )}
      </div>

      {running && onTakeOver && (
        <div className="browser-tabs__automation" role="status" aria-label={tr('Agent is controlling the browser', 'Agent 正在操作浏览器')}>
          <span className="browser-tabs__automation-dot" aria-hidden="true" />
          <span className="browser-tabs__automation-label">{tr('Agent is working', 'Agent 正在操作')}</span>
          <button
            type="button"
            className="browser-tabs__takeover"
            onClick={onTakeOver}
            aria-label={tr('Pause Agent and take over browser', '暂停 Agent 并接管浏览器')}
            title={tr('Pause Agent and control the browser manually', '暂停 Agent 并手动操作浏览器')}
          >
            {tr('Take over', '接管')}
          </button>
        </div>
      )}

      <span className="browser-tabs__sr-status" aria-live="polite">{announcement}</span>
    </div>
  );
}

export default BrowserTabStrip;
