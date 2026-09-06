import type { FollowStatus } from './types';

export interface FollowView {
  entries: Record<string, FollowStatus>;
  checking?: string;
  service?: FollowStatus;
}

/**
 * 画面で必要な行だけを問い合わせる。DOM の監視とは分け、時刻と表示対象で制御する。
 * メイン側は待機列を持たないので、非表示になった行は次の送信候補から外すだけでよい。
 */
export class FollowRequests {
  private readonly visible = new Map<string, number>();
  private entries: Record<string, FollowStatus> = {};
  private service?: FollowStatus;
  private checking?: string;
  private manualId?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private active = true;
  private disposed = false;

  constructor(
    private readonly request: (userId: string, manual: boolean) => Promise<FollowStatus>,
    private readonly changed: (view: FollowView) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** 新たに見えた行は 200ms 待つ。高速スクロールで通過しただけなら送信しない */
  setVisible(userId: string, visible: boolean): void {
    if (visible) {
      if (!this.visible.has(userId)) {
        this.visible.set(userId, this.now() + 200);
      }
    } else {
      this.visible.delete(userId);
      if (this.manualId === userId) {
        this.manualId = undefined;
      }
    }
    this.schedule();
  }

  /** ウィンドウ非表示中は新規取得を止め、戻った後も表示の安定を待つ */
  setActive(active: boolean): void {
    if (active && !this.active) {
      for (const userId of this.visible.keys()) {
        this.visible.set(userId, this.now() + 200);
      }
    }
    this.active = active;
    this.schedule();
  }

  /** 対象追加など別経路で得た結果も再利用する */
  accept(userId: string, status: FollowStatus): void {
    this.entries = { ...this.entries, [userId]: status };
    if (status.servicePaused) {
      this.service = status;
    }
    this.emit();
    this.schedule();
  }

  retry(userId: string): void {
    if (!this.visible.has(userId) || !this.active) {
      return;
    }
    this.manualId = userId;
    this.schedule();
  }

  /** 停止中でも確認済みのキャッシュを選ばず、再確認が必要な表示行から再開する */
  retryVisible(): void {
    for (const userId of this.visible.keys()) {
      const status = this.entries[userId];
      if (status?.state !== 'done' || status.retryAt <= this.now()) {
        this.retry(userId);
        return;
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.visible.clear();
  }

  private emit(): void {
    if (!this.disposed) {
      this.changed({ entries: this.entries, checking: this.checking, service: this.service });
    }
  }

  /** 各行のキャッシュ期限と API 全体の休止の両方を守る */
  private dueAt(userId: string, visibleAt: number): number {
    const status = this.entries[userId];
    const manual = this.manualId === userId;
    if (!manual && (status?.state === 'stopped' || this.service?.state === 'stopped')) {
      return Infinity;
    }
    return Math.max(visibleAt, status?.retryAt ?? 0, this.service?.retryAt ?? 0);
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.disposed || !this.active || this.checking) {
      return;
    }
    let selected: string | undefined;
    let earliest = Infinity;
    for (const [userId, visibleAt] of this.visible) {
      const at = this.dueAt(userId, visibleAt);
      if (at < earliest) {
        selected = userId;
        earliest = at;
      }
    }
    if (selected !== undefined) {
      const userId = selected;
      // 長い Retry-After もタイマーの整数上限で即時実行にならないようにする
      this.timer = setTimeout(
        () => {
          if (this.now() < earliest) {
            this.schedule();
          } else {
            void this.check(userId);
          }
        },
        Math.min(2_147_483_647, Math.max(0, earliest - this.now())),
      );
    }
  }

  private async check(userId: string): Promise<void> {
    this.checking = userId;
    const manual = this.manualId === userId;
    this.emit();
    try {
      const status = await this.request(userId, manual);
      if (this.disposed) {
        return;
      }
      // 通信開始を待っている間は手動再確認の意図も保持する
      if (manual && status.state !== 'waiting') {
        this.manualId = undefined;
      }
      if (!status.servicePaused && this.service) {
        this.service = undefined;
        // サービス全体の停止から復帰したら、他の表示行も再び確認対象にする
        this.entries = Object.fromEntries(
          Object.entries(this.entries).map(([id, entry]) => [
            id,
            entry.servicePaused
              ? { ...entry, state: 'waiting' as const, servicePaused: false, retryAt: 0 }
              : entry,
          ]),
        );
      }
      this.accept(userId, status);
    } catch {
      // IPC の失敗で無限に再送しない。再ログインや手動再確認でやり直せる
      this.manualId = undefined;
      this.accept(userId, {
        result: this.entries[userId]?.result ?? 'unknown',
        stale:
          this.entries[userId]?.result !== undefined && this.entries[userId]?.result !== 'unknown',
        state: 'stopped',
        retryAt: this.now() + 30_000,
      });
    } finally {
      this.checking = undefined;
      this.emit();
      this.schedule();
    }
  }
}
