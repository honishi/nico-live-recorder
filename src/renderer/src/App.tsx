import { useCallback, useEffect, useState } from 'react';
import type { AppSettings, AppStatus } from '@shared/types';
import { AuthPanel } from './components/AuthPanel';
import { LogPanel } from './components/LogPanel';
import { RecordingsPanel } from './components/RecordingsPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { TargetsPanel } from './components/TargetsPanel';

export function App(): JSX.Element {
  const [status, setStatus] = useState<AppStatus>();
  const [settings, setSettings] = useState<AppSettings>();
  const [error, setError] = useState<string>();

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

  const run = useCallback(async (task: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await task();
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  if (!status || !settings) {
    return <main className="app">読み込み中...</main>;
  }

  return (
    <main className="app">
      <header className="app-header">
        <h1>Nico Live Recorder</h1>
        <span className="version">v{status.version}</span>
      </header>
      {error && (
        <div className="banner error" onClick={() => setError(undefined)}>
          {error}
        </div>
      )}
      <div className="grid">
        <section className="card">
          <AuthPanel status={status} run={run} />
        </section>
        <section className="card">
          <SettingsPanel settings={settings} run={run} />
        </section>
        <section className="card wide">
          <TargetsPanel settings={settings} loggedIn={status.auth.loggedIn} run={run} />
        </section>
        <section className="card wide">
          <RecordingsPanel status={status} run={run} />
        </section>
        <section className="card wide">
          <LogPanel logs={status.logs} />
        </section>
      </div>
    </main>
  );
}
