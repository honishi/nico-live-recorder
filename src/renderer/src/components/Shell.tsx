import type { ReactElement } from 'react';
import type { AppAlert, AppStatus, TabId } from '@shared/types';
import { formatClock } from '../lib/format';

// ---------------------------------------------------------------------------
// 状態帯
// ---------------------------------------------------------------------------

interface StatusBandProps {
  status: AppStatus;
  pollIntervalSec: number;
  /** 有効な録画対象の数。0 件だと監視を止めるので、その理由を示す */
  enabledTargets: number;
}

export function StatusBand({
  status,
  pollIntervalSec,
  enabledTargets,
}: StatusBandProps): ReactElement {
  const { loggedIn } = status.auth;
  const pushConnected = status.push.state === 'connected';
  const detection = status.detectorRunning
    ? `監視中 ${pollIntervalSec} 秒`
    : loggedIn && enabledTargets === 0
      ? '監視停止 (対象なし)'
      : '監視停止';
  return (
    <div className="status-band">
      <span className={`status-item ${loggedIn ? 'ok' : 'warn'}`}>
        <span className="dot" />
        {loggedIn ? 'ログイン中' : '未ログイン'}
      </span>
      <span className={`status-item ${pushConnected ? 'ok' : 'off'}`}>
        <span className="dot" />
        {pushConnected ? 'push 接続済み' : 'push 未接続'}
      </span>
      <span className={`status-item ${status.detectorRunning ? 'ok' : 'off'}`}>
        <span className="dot" />
        {detection}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 警告バナー (解消するまで続く問題を 1 件だけ)
// ---------------------------------------------------------------------------

interface AlertBannerProps {
  alert?: AppAlert;
  onAction: (alert: AppAlert) => void;
}

export function AlertBanner({ alert, onAction }: AlertBannerProps): ReactElement | null {
  if (!alert) {
    return null;
  }
  return (
    <div className={`alert-banner ${alert.severity === 'error' ? 'error' : ''}`}>
      <span className="alert-message">
        <span className="dot" />
        {alert.message}
      </span>
      <button className="btn btn-secondary sm" onClick={() => onAction(alert)}>
        {alert.actionLabel}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// タブ行
// ---------------------------------------------------------------------------

export interface TabBadges {
  recording: number;
  targets: number;
  unreadWarn: number;
  unreadError: number;
}

interface TabBarProps {
  active: TabId;
  badges?: TabBadges;
  onSelect: (tab: TabId) => void;
}

const TABS: { id: TabId; label: string }[] = [
  { id: 'recordings', label: '録画' },
  { id: 'targets', label: '対象' },
  { id: 'history', label: '履歴' },
  { id: 'log', label: 'ログ' },
];

export function TabBar({ active, badges, onSelect }: TabBarProps): ReactElement {
  const unread = badges ? badges.unreadWarn + badges.unreadError : 0;
  const badgeFor = (id: TabId): ReactElement | null => {
    if (!badges) {
      return null;
    }
    if (id === 'recordings' && badges.recording > 0) {
      return <span className="badge badge-tab-rec">{badges.recording}</span>;
    }
    if (id === 'targets' && badges.targets > 0) {
      return <span className="badge badge-count">{badges.targets}</span>;
    }
    if (id === 'log' && unread > 0) {
      return (
        <span className={`badge ${badges.unreadError > 0 ? 'badge-tab-error' : 'badge-tab-warn'}`}>
          {unread > 99 ? '99+' : unread}
        </span>
      );
    }
    return null;
  };
  return (
    <nav className="tab-bar">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          className={`tab ${active === tab.id ? 'active' : ''}`}
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
          {badgeFor(tab.id)}
        </button>
      ))}
      <span className="tab-spacer" />
      <button
        className={`tab ${active === 'settings' ? 'active' : ''}`}
        onClick={() => onSelect('settings')}
      >
        設定
      </button>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// 情報バー
// ---------------------------------------------------------------------------

interface InfoBarProps {
  outputDir: string;
  lastReceivedAt?: string;
}

export function InfoBar({ outputDir, lastReceivedAt }: InfoBarProps): ReactElement {
  return (
    <footer className="info-bar">
      <span className="mono ellipsis" title={outputDir}>
        {outputDir}
      </span>
      <span>{lastReceivedAt ? `最終受信 ${formatClock(lastReceivedAt)}` : '最終受信 —'}</span>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// 空状態
// ---------------------------------------------------------------------------

interface EmptyStateProps {
  title: string;
  description: string;
}

export function EmptyState({ title, description }: EmptyStateProps): ReactElement {
  return (
    <div className="empty">
      <span className="title">{title}</span>
      <span className="desc">{description}</span>
    </div>
  );
}
