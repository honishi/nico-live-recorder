import { useState, type ReactElement } from 'react';
import type { AppSettings, AppStatus } from '@shared/types';
import { formatBytes } from '@shared/format';
import { MIN_FREE_SPACE_GB, POLL_INTERVAL_SEC } from '@shared/limits';
import { formatClock } from '../lib/format';

interface Props {
  settings: AppSettings;
  status: AppStatus;
  loginPending: boolean;
  onLogin: () => void;
  onLogout: () => void;
  onChooseOutputDir: () => Promise<void>;
}

export function SettingsTab({
  settings,
  status,
  loginPending,
  onLogin,
  onLogout,
  onChooseOutputDir,
}: Props): ReactElement {
  const [choosing, setChoosing] = useState(false);

  const toggle = (key: 'recordOngoingOnStart' | 'pushEnabled' | 'notificationsEnabled'): void => {
    void window.api.updateSettings({ [key]: !settings[key] });
  };
  const choose = async (): Promise<void> => {
    setChoosing(true);
    try {
      await onChooseOutputDir();
    } finally {
      setChoosing(false);
    }
  };

  return (
    <div className="settings">
      <section className="group">
        <span className="group-label">保存</span>
        <div className="group-body">
          <div className="setting-row">
            <span className="label">保存先</span>
            <span className="value mono ellipsis" style={{ fontSize: 'var(--fs-sub)' }}>
              {settings.outputDir}
            </span>
            <span className="buttons">
              <button
                className="btn btn-secondary sm"
                disabled={choosing}
                onClick={() => void choose()}
              >
                変更
              </button>
              <button
                className="btn btn-secondary sm"
                onClick={() => void window.api.openOutputDir()}
              >
                開く
              </button>
            </span>
          </div>
          <div className="divider" />
          <div className="setting-row">
            <span className="label">ポーリング間隔</span>
            <span className="value">
              {/* 設定値が外から変わったら key で入力欄を作り直して同期する */}
              <input
                type="number"
                className="input num"
                min={POLL_INTERVAL_SEC.min}
                max={POLL_INTERVAL_SEC.max}
                key={settings.pollIntervalSec}
                defaultValue={settings.pollIntervalSec}
                onBlur={(e) => {
                  const value = Number(e.target.value);
                  if (Number.isFinite(value) && value !== settings.pollIntervalSec) {
                    void window.api.updateSettings({ pollIntervalSec: value });
                  }
                }}
              />{' '}
              秒
            </span>
            <span />
          </div>
          <div className="divider" />
          <div className="setting-row">
            <span className="label">空き容量の警告</span>
            <span className="value">
              <input
                type="number"
                className="input num"
                min={MIN_FREE_SPACE_GB.min}
                max={MIN_FREE_SPACE_GB.max}
                key={settings.minFreeSpaceGb}
                defaultValue={settings.minFreeSpaceGb}
                onBlur={(e) => {
                  const value = Number(e.target.value);
                  if (Number.isFinite(value) && value !== settings.minFreeSpaceGb) {
                    void window.api.updateSettings({ minFreeSpaceGb: value });
                  }
                }}
              />{' '}
              GB を下回ったら警告
              <span className="help">
                {status.diskFreeBytes === undefined
                  ? '空き容量を取得できません'
                  : `現在の空き: ${formatBytes(status.diskFreeBytes)}`}
                {settings.minFreeSpaceGb === 0 && ' (0 は確認しない)'}
              </span>
            </span>
            <span />
          </div>
        </div>
      </section>

      <section className="group">
        <span className="group-label">検知と通知</span>
        <div className="group-body">
          <label className="check-row">
            <input
              type="checkbox"
              className="checkbox"
              checked={settings.pushEnabled}
              onChange={() => toggle('pushEnabled')}
            />
            <span className="text">
              push 通知で放送開始を検知する
              <span className="help">切ると検知はポーリングのみになり、最大で間隔ぶん遅れます</span>
            </span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              className="checkbox"
              checked={settings.recordOngoingOnStart}
              onChange={() => toggle('recordOngoingOnStart')}
            />
            <span className="text">起動時に放送中だった対象も録画する</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              className="checkbox"
              checked={settings.notificationsEnabled}
              onChange={() => toggle('notificationsEnabled')}
            />
            <span className="text">録画の開始・終了をデスクトップ通知する</span>
          </label>
        </div>
      </section>

      <section className="group">
        <span className="group-label">アカウント</span>
        <div className="group-body">
          <div className="account-row">
            {status.auth.loggedIn ? (
              <span>
                ログイン中
                <div className="sub">
                  {status.push.state === 'connected' ? 'push 接続済み' : 'push 未接続'}
                  {status.push.lastReceivedAt &&
                    ` — 最終受信 ${formatClock(status.push.lastReceivedAt)}`}
                </div>
              </span>
            ) : (
              <span>
                未ログイン
                <div className="sub">
                  {loginPending
                    ? 'ログインウィンドウで操作を完了してください'
                    : 'ログインすると push 通知で即時に検知できます'}
                </div>
              </span>
            )}
            {status.auth.loggedIn ? (
              <button className="btn btn-secondary sm" onClick={onLogout}>
                ログアウト
              </button>
            ) : (
              <button className="btn btn-primary sm" disabled={loginPending} onClick={onLogin}>
                {loginPending ? 'ログイン中…' : 'ログイン'}
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="group">
        <span className="group-label">情報</span>
        <div className="group-body">
          <div className="account-row">
            <span>
              Nico Live Recorder v{status.version}
              <div className="sub mono ellipsis" title={status.logFilePath}>
                ログの保存先: {status.logFilePath}
              </div>
            </span>
            <button className="btn btn-secondary sm" onClick={() => void window.api.openLogFile()}>
              ログを開く
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
