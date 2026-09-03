import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type {
  AppAlert,
  AppSettings,
  AppStatus,
  RecordingInfo,
  TabId,
  TargetUser,
  UiState,
} from '@shared/types';
import { AlertBanner, InfoBar, StatusBand, TabBar, type TabBadges } from './components/Shell';
import { Toast, type ToastMessage } from './components/Toast';
import { HistoryTab } from './tabs/HistoryTab';
import { LogTab } from './tabs/LogTab';
import { RecordingsTab } from './tabs/RecordingsTab';
import { SettingsTab } from './tabs/SettingsTab';
import { TargetsTab } from './tabs/TargetsTab';

export function App(): ReactElement {
  const [status, setStatus] = useState<AppStatus>();
  const [settings, setSettings] = useState<AppSettings>();
  const [now, setNow] = useState(() => Date.now());
  const [logFilter, setLogFilter] = useState<string>();
  const [toast, setToast] = useState<ToastMessage>();
  const [loginPending, setLoginPending] = useState(false);
  const toastId = useRef(0);

  // 初期状態の取得と、main からの更新通知の購読
  useEffect(() => {
    let cancelled = false;
    void Promise.all([window.api.getStatus(), window.api.getSettings()]).then(
      ([nextStatus, nextSettings]) => {
        if (!cancelled) {
          setStatus(nextStatus);
          setSettings(nextSettings);
        }
      },
    );
    const unsubscribe = window.api.onStatusChanged((next) => {
      setStatus(next);
      void window.api.getSettings().then(setSettings);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // 経過時間の表示を 1 秒ごとに進める
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const showToast = useCallback((text: string, actionLabel?: string, onAction?: () => void) => {
    toastId.current += 1;
    setToast({ id: toastId.current, text, actionLabel, onAction });
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToast((current) => (current?.id === id ? undefined : current));
  }, []);

  const updateUi = useCallback((patch: Partial<UiState>) => {
    setSettings((prev) => (prev ? { ...prev, ui: { ...prev.ui, ...patch } } : prev));
    void window.api.updateUi(patch);
  }, []);

  const selectTab = useCallback(
    (tab: TabId) => {
      // ログタブを開いた瞬間に未読を 0 にする
      updateUi(tab === 'log' ? { tab, logSeenAt: new Date().toISOString() } : { tab });
    },
    [updateUi],
  );

  const login = useCallback(async () => {
    setLoginPending(true);
    try {
      await window.api.login();
    } finally {
      // 閉じられた場合も少し待ってから元に戻す
      setTimeout(() => setLoginPending(false), 500);
    }
  }, []);

  const chooseOutputDir = useCallback(async () => {
    await window.api.chooseOutputDir();
  }, []);

  const onAlertAction = useCallback(
    (alert: AppAlert) => {
      if (alert.kind === 'output-dir') {
        void chooseOutputDir();
      } else if (alert.kind === 'auth-expired') {
        void login();
      } else {
        void window.api.reconnectPush();
      }
    },
    [chooseOutputDir, login],
  );

  const stopRecording = useCallback(
    (recording: RecordingInfo) => {
      void window.api.stopRecording(recording.programId).then(() => {
        const path = recording.videoPath;
        showToast(
          '録画を停止しました',
          path ? 'フォルダで表示' : undefined,
          path ? () => void window.api.openPath(path) : undefined,
        );
      });
    },
    [showToast],
  );

  const onTargetRemoved = useCallback(
    (target: TargetUser) => {
      showToast(`${target.name} を削除しました`, '取り消す', () => {
        void window.api.restoreTarget(target);
      });
    },
    [showToast],
  );

  const showLog = useCallback(
    (programId: string) => {
      setLogFilter(programId);
      selectTab('log');
    },
    [selectTab],
  );

  if (!status || !settings) {
    return <div className="loading">読み込み中…</div>;
  }

  const tab = settings.ui.tab;
  const seenAt = settings.ui.logSeenAt ? new Date(settings.ui.logSeenAt).getTime() : 0;
  const unread = status.logs.filter(
    (e) => (e.level === 'warn' || e.level === 'error') && new Date(e.ts).getTime() > seenAt,
  );
  const badges: TabBadges | undefined = status.auth.loggedIn
    ? {
        recording: status.recordings.filter((r) => r.state === 'recording').length,
        targets: settings.targets.length,
        unreadWarn: unread.filter((e) => e.level === 'warn').length,
        unreadError: unread.filter((e) => e.level === 'error').length,
      }
    : undefined;

  return (
    <div className="shell">
      <StatusBand status={status} pollIntervalSec={settings.pollIntervalSec} />
      <AlertBanner alert={status.alerts[0]} onAction={onAlertAction} />
      <TabBar active={tab} badges={badges} onSelect={selectTab} />
      <main className={`content ${tab === 'settings' ? 'scroll' : ''}`}>
        {tab === 'recordings' && (
          <RecordingsTab
            recordings={status.recordings}
            loggedIn={status.auth.loggedIn}
            loginPending={loginPending}
            now={now}
            onLogin={() => void login()}
            onChooseOutputDir={() => void chooseOutputDir()}
            onStop={stopRecording}
            onShowFile={(path) => void window.api.openPath(path)}
            onShowHistory={() => selectTab('history')}
            onShowLog={showLog}
          />
        )}
        {tab === 'targets' && (
          <TargetsTab
            targets={settings.targets}
            loggedIn={status.auth.loggedIn}
            onRemoved={onTargetRemoved}
          />
        )}
        {tab === 'history' && (
          <HistoryTab
            recordings={status.recordings}
            now={now}
            onShowFile={(path) => void window.api.openPath(path)}
            onShowLog={showLog}
          />
        )}
        {tab === 'log' && (
          <LogTab
            logs={status.logs}
            ui={settings.ui}
            filter={logFilter}
            onClearFilter={() => setLogFilter(undefined)}
            onUpdateUi={updateUi}
            onCopied={() => showToast('ログをコピーしました')}
          />
        )}
        {tab === 'settings' && (
          <SettingsTab
            settings={settings}
            status={status}
            loginPending={loginPending}
            onLogin={() => void login()}
            onLogout={() => void window.api.logout()}
            onChooseOutputDir={chooseOutputDir}
          />
        )}
      </main>
      <InfoBar outputDir={settings.outputDir} lastReceivedAt={status.push.lastReceivedAt} />
      <Toast toast={toast} onDismiss={dismissToast} />
    </div>
  );
}
