import {
  setupRecordingManager,
  notifications,
  recordCalls,
  getProgramInfo,
  info,
  nextRecordCall,
  finishedResult,
  dir,
  settings,
  history,
  manager,
} from '../helpers/recording-manager';
import fs from 'node:fs';
import path from 'node:path';
import { ERROR_CODES } from '../../src/shared/types';
import { parseErrorCode } from '../../src/shared/types';
import { NicoLiveProgramStatus } from '../../src/main/vendor/nico-client/types';
import { waitFor } from '../helpers/fake-watch-server';

describe('RecordingManager: timeshift', () => {
  setupRecordingManager();

  test('映像成功・コメント一部失敗は動画を取り直さずdone/partialで履歴に残す', async () => {
    settings.update({ notificationsEnabled: true });
    getProgramInfo.mockResolvedValue(info({ status: NicoLiveProgramStatus.ended }));
    await manager.startRecording('lv1', 'manual');
    const call = await nextRecordCall(0);
    const result = finishedResult(call, {
      timeshift: { completion: 'partial' },
      errors: [{ target: 'comments', message: 'COMMENT_VIEW_TIMEOUT' }],
    });
    fs.mkdirSync(call.options.outputDir, { recursive: true });
    fs.writeFileSync(path.join(call.options.outputDir, 'rec.ts'), 'video');
    call.resolve(result);
    await waitFor(() => !manager.hasActiveRecordings());
    expect(history.get('lv1')).toMatchObject({
      state: 'done',
      completion: 'partial',
      videoBytes: 5,
      error: 'comments: COMMENT_VIEW_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recordCalls).toHaveLength(1);
    expect(notifications).toEqual([
      { title: 'タイムシフト録画を開始しました', body: 'alice タイトル' },
      {
        title: 'タイムシフト録画が一部失敗しました',
        body: expect.stringContaining('タイトル') as string,
      },
    ]);
  });

  test('視聴できないタイムシフトや取得できない番組はコード付きの例外にする', async () => {
    getProgramInfo.mockResolvedValueOnce(
      info({ status: NicoLiveProgramStatus.ended, webSocketUrl: undefined }),
    );
    await expect(manager.startRecording('lv1', 'manual')).rejects.toSatisfy(
      (e: Error) => parseErrorCode(e.message) === ERROR_CODES.timeshiftUnavailable,
    );
    getProgramInfo.mockRejectedValueOnce(new Error('network'));
    await expect(manager.startRecording('lv1', 'manual')).rejects.toSatisfy(
      (e: Error) => parseErrorCode(e.message) === ERROR_CODES.programUnavailable,
    );
    expect(recordCalls).toHaveLength(0);
    expect(await manager.getRecordings()).toEqual([]);
  });

  test.each(['complete', 'partial', 'cancelled'] as const)(
    '手動タイムシフトの%sを区別し、自動再試行しない',
    async (completion) => {
      settings.update({ notificationsEnabled: true });
      getProgramInfo.mockResolvedValue(info({ status: NicoLiveProgramStatus.ended }));
      await manager.startRecording('lv1', 'manual');
      const call = await nextRecordCall(0);
      expect(call.options.mode).toBe('timeshift');
      const progress = {
        phase: 'comments' as const,
        savedSegments: 10,
        totalSegments: 10,
        comments: 'pending' as const,
      };
      call.options.onTimeshiftProgress?.(progress);
      expect((await manager.getRecordings())[0]).toMatchObject({
        state: 'finishing',
        timeshift: progress,
      });
      fs.mkdirSync(call.options.outputDir, { recursive: true });
      if (completion !== 'partial')
        fs.writeFileSync(path.join(call.options.outputDir, 'rec.ts'), 'video');
      fs.writeFileSync(path.join(call.options.outputDir, 'rec.comments.csv'), 'comments');
      if (completion === 'cancelled') manager.stopRecording('lv1');
      call.resolve(
        finishedResult(call, {
          timeshift: { completion, progress },
          ...(completion === 'partial'
            ? { video: undefined, errors: [{ target: 'video', message: 'failed' }] }
            : {}),
        }),
      );
      await waitFor(() => !manager.hasActiveRecordings());
      expect(history.get('lv1')).toMatchObject({
        mode: 'timeshift',
        completion,
        state: completion === 'partial' ? 'failed' : 'done',
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(recordCalls).toHaveLength(1);
      expect(getProgramInfo).toHaveBeenCalledOnce();
      const titles = {
        complete: 'タイムシフト録画が終了しました',
        partial: 'タイムシフト録画に失敗しました',
        cancelled: 'タイムシフト録画を停止しました',
      };
      expect(notifications).toEqual([
        { title: 'タイムシフト録画を開始しました', body: 'alice タイトル' },
        { title: titles[completion], body: expect.stringContaining('タイトル') as string },
      ]);
      if (completion === 'cancelled') {
        expect(history.match({ state: 'done' })).toEqual([]);
        expect(history.match({ state: 'cancelled' })).toHaveLength(1);
      }
    },
  );

  test('タイムシフトの録り直しは旧CSVを残し、今回の件数だけを数える', async () => {
    const oldVideo = path.join(dir, 'old.ts');
    const oldCsv = path.join(dir, 'old.comments.csv');
    fs.writeFileSync(oldVideo, 'video');
    fs.writeFileSync(oldCsv, 'old comments');
    history.upsert({
      programId: 'lv1',
      title: 'old',
      source: 'manual',
      state: 'done',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      outputDir: dir,
      commentCount: 999,
      videoBytes: 5,
      videoPath: oldVideo,
      commentsPath: oldCsv,
    });
    getProgramInfo.mockResolvedValue(info({ status: NicoLiveProgramStatus.ended }));
    await manager.startRecording('lv1', 'manual');
    const call = await nextRecordCall(0);
    expect(call.options.commentsPath).toBeUndefined();
    const result = finishedResult(call, { timeshift: { completion: 'complete' } });
    fs.mkdirSync(call.options.outputDir, { recursive: true });
    fs.writeFileSync(path.join(call.options.outputDir, 'rec.comments.csv'), 'new comments');
    call.options.onComment?.({} as never, 2);
    call.resolve(result);
    await waitFor(() => !manager.hasActiveRecordings());
    const entry = history.get('lv1')!;
    expect(entry.commentCount).toBe(2);
    expect(entry.commentsPaths).toEqual([oldCsv, entry.commentsPath]);
    expect(entry.videoPaths).toContain(oldVideo);
    expect(fs.readFileSync(oldCsv, 'utf8')).toBe('old comments');
    expect(await manager.getCommentPaths('lv1')).toEqual(entry.commentsPaths);
  });

  test('自動ライブ録画と手動タイムシフトを同時に動かし停止を分離する', async () => {
    getProgramInfo
      .mockResolvedValueOnce(info())
      .mockResolvedValueOnce(
        info({ nicoliveProgramId: 'lv2', status: NicoLiveProgramStatus.ended }),
      );
    await manager.startRecording('lv1', 'push');
    await manager.startRecording('lv2', 'manual');
    const live = await nextRecordCall(0);
    const timeshift = await nextRecordCall(1);
    expect(live.options.mode).toBe('live');
    expect(timeshift.options.mode).toBe('timeshift');
    manager.stopRecording('lv2');
    expect(timeshift.signal?.aborted).toBe(true);
    expect(live.signal?.aborted).toBe(false);
    timeshift.resolve(finishedResult(timeshift, { timeshift: { completion: 'cancelled' } }));
    live.resolve(finishedResult(live));
    await waitFor(() => !manager.hasActiveRecordings());
    expect(history.get('lv1')).toMatchObject({ state: 'done', mode: 'live' });
    expect(history.get('lv1')?.completion).toBeUndefined();
  });
});
