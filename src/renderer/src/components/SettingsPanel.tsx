import type { AppSettings } from '@shared/types';

interface Props {
  settings: AppSettings;
  run: (task: () => Promise<unknown>) => Promise<void>;
}

export function SettingsPanel({ settings, run }: Props): JSX.Element {
  const toggle = (key: 'recordOngoingOnStart' | 'pushEnabled' | 'notificationsEnabled') =>
    void run(() => window.api.updateSettings({ [key]: !settings[key] }));

  return (
    <>
      <h2>設定</h2>
      <dl className="kv">
        <dt>保存先</dt>
        <dd>
          <code className="path" title={settings.outputDir}>
            {settings.outputDir}
          </code>
          <div className="row">
            <button onClick={() => void run(() => window.api.chooseOutputDir())}>変更</button>
            <button
              className="secondary"
              onClick={() => void run(() => window.api.openOutputDir())}
            >
              開く
            </button>
          </div>
        </dd>
        <dt>ポーリング間隔</dt>
        <dd>
          {/* 設定値が外から変わったら key で入力欄を作り直して同期する */}
          <input
            type="number"
            min={10}
            max={600}
            key={settings.pollIntervalSec}
            defaultValue={settings.pollIntervalSec}
            onBlur={(e) => {
              const value = Number(e.target.value);
              if (Number.isFinite(value) && value !== settings.pollIntervalSec) {
                void run(() => window.api.updateSettings({ pollIntervalSec: value }));
              }
            }}
          />{' '}
          秒
        </dd>
      </dl>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.pushEnabled}
          onChange={() => toggle('pushEnabled')}
        />
        push 通知で放送開始を検知する
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.recordOngoingOnStart}
          onChange={() => toggle('recordOngoingOnStart')}
        />
        起動時に放送中だった対象も録画する
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.notificationsEnabled}
          onChange={() => toggle('notificationsEnabled')}
        />
        録画の開始・終了をデスクトップ通知する
      </label>
    </>
  );
}
