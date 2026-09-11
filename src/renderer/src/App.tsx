import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type {
  AppAlert,
  AppSettings,
  AppStatus,
  LogEntry,
  RecordingInfo,
  TabId,
  TargetRemovalResult,
  UiState,
} from '@shared/types';
import { AlertBanner, InfoBar, StatusBand, TabBar, type TabBadges } from './components/Shell';
import { Toast, type ToastMessage } from './components/Toast';
import { HistoryTab } from './tabs/HistoryTab';
import { LogTab } from './tabs/LogTab';
import { RecordingsTab } from './tabs/RecordingsTab';
import { SettingsTab } from './tabs/SettingsTab';
import { TargetsTab } from './tabs/TargetsTab';
import { pruneRecordingPreviewImages } from './lib/recording-preview-cache';

export function App(): ReactElement {
  const [status, setStatus] = useState<AppStatus>();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [settings, setSettings] = useState<AppSettings>();
  const [now, setNow] = useState(() => Date.now());
  const [logFilter, setLogFilter] = useState<string>();
  const [toast, setToast] = useState<ToastMessage>();
  const [loginPending, setLoginPending] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const toastId = useRef(0);
  const uiEdits = useRef({ revision: 0, pending: 0 });
  const targetsRevision = useRef(0);

  // 対象操作の応答は対象だけに反映し、タブや表示設定の楽観更新を巻き戻さない
  const applyTargets = useCallback((next: AppSettings) => {
    targetsRevision.current += 1;
    setSettings((current) => (current ? { ...current, targets: next.targets } : next));
  }, []);

  // 初期状態の取得と、main からの更新通知の購読
  useEffect(() => {
    let cancelled = false;
    let latestRequest = 0;
    const refreshSettings = async (): Promise<void> => {
      const request = ++latestRequest;
      const uiRevision = uiEdits.current.revision;
      const uiPending = uiEdits.current.pending > 0;
      const targetRevision = targetsRevision.current;
      const next = await window.api.getSettings();
      if (cancelled || request !== latestRequest) return;
      setSettings((current) => {
        if (!current) return next;
        // 取得開始後の操作と未保存の UI 更新を優先し、古い応答を混ぜない
        const keepUi =
          uiPending || uiEdits.current.pending > 0 || uiRevision !== uiEdits.current.revision;
        return {
          ...next,
          ui: keepUi ? current.ui : next.ui,
          targets: targetRevision === targetsRevision.current ? next.targets : current.targets,
        };
      });
    };
    // 購読を先に開始し、初期取得が遅れても受信済みの通知を巻き戻さない。
    let statusReceived = false;
    let logsReceived = false;
    const unsubscribeStatus = window.api.onStatusChanged((next) => {
      statusReceived = true;
      setStatus(next);
    });
    const unsubscribeLogs = window.api.onLogsChanged((next) => {
      logsReceived = true;
      setLogs(next);
    });
    const unsubscribeSettings = window.api.onSettingsChanged(() => void refreshSettings());
    void window.api.getStatus().then((next) => {
      if (!cancelled && !statusReceived) setStatus(next);
    });
    void window.api.getLogs().then((next) => {
      if (!cancelled && !logsReceived) setLogs(next);
    });
    void refreshSettings();
    return () => {
      cancelled = true;
      unsubscribeStatus();
      unsubscribeLogs();
      unsubscribeSettings();
    };
  }, []);

  // 画像の寿命はタブではなく録画に合わせ、非表示中に終了した録画の分も解放する。
  useEffect(() => {
    pruneRecordingPreviewImages(status?.recordings ?? []);
  }, [status?.recordings]);

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

  const updateUi = useCallback(
    (patch: Partial<UiState>) => {
      uiEdits.current.revision += 1;
      uiEdits.current.pending += 1;
      setSettings((prev) => (prev ? { ...prev, ui: { ...prev.ui, ...patch } } : prev));
      void window.api.updateUi(patch).then(
        () => {
          uiEdits.current.pending -= 1;
        },
        () => {
          uiEdits.current.pending -= 1;
          showToast('画面の状態を保存できませんでした');
        },
      );
    },
    [showToast],
  );

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

  // 確認ダイアログと登録解除が完了するまで、ログアウトボタンを無効にする
  const logout = useCallback(async () => {
    setLogoutPending(true);
    try {
      await window.api.logout();
    } catch {
      showToast('ログアウトできませんでした。もう一度お試しください。');
    } finally {
      setLogoutPending(false);
    }
  }, [showToast]);

  const onAlertAction = useCallback(
    (alert: AppAlert) => {
      if (alert.kind === 'output-dir' || alert.kind === 'disk-space') {
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
    ({ settings: nextSettings, removed, previousOrder }: TargetRemovalResult) => {
      applyTargets(nextSettings);
      if (removed.length === 0) {
        return;
      }
      // 取り消しは一括で行い、失敗時も同じ削除内容で再試行できるようにする
      let restoring = false;
      const restore = (): void => {
        if (restoring) {
          return;
        }
        restoring = true;
        showToast('録画対象を元に戻しています…');
        void window.api.restoreTargets(removed, previousOrder).then(
          (restoredSettings) => {
            applyTargets(restoredSettings);
            showToast('録画対象を元に戻しました');
          },
          () => {
            restoring = false;
            showToast('録画対象を元に戻せませんでした', '再試行', restore);
          },
        );
      };
      const label = removed.length === 1 ? removed[0].name : `${removed.length} 件の配信者`;
      showToast(`${label} を録画対象から削除しました`, '取り消す', restore);
    },
    [showToast, applyTargets],
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
  const unread = logs.filter(
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
      <StatusBand
        status={status}
        pollIntervalSec={settings.pollIntervalSec}
        enabledTargets={settings.targets.filter((t) => t.enabled).length}
      />
      <AlertBanner alert={status.alerts[0]} onAction={onAlertAction} />
      {status.update.release && (
        <div className="update-banner" role="status">
          <span>新しいバージョン v{status.update.release.version} があります</span>
          <button
            className="btn btn-secondary sm"
            onClick={() => {
              void window.api.openReleasePage().catch(() => {
                showToast('リリースページを開けませんでした');
              });
            }}
          >
            リリースページを開く
          </button>
        </div>
      )}
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
            // 再ログインしたら確認済みのフォロー状態を捨てて取り直す (key で作り直す)
            key={`${status.auth.loggedIn ? 'in' : 'out'}:${status.auth.revision}`}
            now={now}
            targets={settings.targets}
            loggedIn={status.auth.loggedIn}
            onRemoved={onTargetRemoved}
            onSettingsChanged={applyTargets}
          />
        )}
        {tab === 'history' && (
          <HistoryTab
            historyVersion={status.historyVersion}
            now={now}
            onShowFile={(path) => void window.api.openPath(path)}
            onShowLog={showLog}
          />
        )}
        {tab === 'log' && (
          <LogTab
            logs={logs}
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
            now={now}
            loginPending={loginPending}
            logoutPending={logoutPending}
            onLogin={() => void login()}
            onLogout={() => void logout()}
            onChooseOutputDir={chooseOutputDir}
          />
        )}
      </main>
      <InfoBar outputDir={settings.outputDir} lastReceivedAt={status.push.lastReceivedAt} />
      <Toast toast={toast} onDismiss={dismissToast} />
    </div>
  );
}
