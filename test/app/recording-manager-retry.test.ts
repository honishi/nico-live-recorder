import {
  setupRecordingManager,
  recordCalls,
  getProgramInfo,
  info,
  nextRecordCall,
  finishedResult,
  dir,
  history,
  manager,
  skipRetryWait,
} from '../helpers/recording-manager';
import fs from 'node:fs';
import path from 'node:path';
import { NicoLiveProgramStatus } from '../../src/main/vendor/nico-client/types';
import { waitFor } from '../helpers/fake-watch-server';

describe('RecordingManager: retry', () => {
  setupRecordingManager();

  test('映像が異常終了したら、最新の番組情報で連番の別ファイルとして再開する', async () => {
    await manager.startRecording('lv1', 'manual');
    const first = await nextRecordCall(0);
    getProgramInfo.mockResolvedValue(info({ webSocketUrl: 'wss://watch.example/2' }));
    first.resolve(
      finishedResult(first, { video: undefined, errors: [{ target: 'video', message: 'boom' }] }),
    );

    // 5 秒の待ちの後に再開する
    await skipRetryWait(5_500);
    const second = await nextRecordCall(1);
    expect(second.options.attempt).toBe(2);
    expect(second.options.prefetchBackwardComments).toBe(false);
    expect(second.options.programInfo?.webSocketUrl).toBe('wss://watch.example/2');
    expect(second.options.commentsPath).toBe(first.options.outputDir + '/rec.comments.csv');

    second.resolve(finishedResult(second));
    await waitFor(() => history.get('lv1')?.state === 'done');
    expect(history.get('lv1')?.videoPaths).toHaveLength(2);
    expect(history.get('lv1')?.attempt).toBe(2);
  });

  test.each(['csv', 'jsonl'])(
    '履歴の %s を持つ番組を再開すると、CSV だけを引き継ぐ',
    async (extension) => {
      const commentsPath = path.join(dir, `previous.comments.${extension}`);
      const original = extension === 'csv' ? 'existing csv\n' : '{"content":"過去のコメント"}\n';
      fs.writeFileSync(commentsPath, original);
      history.upsert({
        programId: 'lv1',
        title: 'タイトル',
        source: 'manual',
        state: 'failed',
        startedAt: new Date().toISOString(),
        commentCount: 42,
        videoBytes: 0,
        outputDir: dir,
        commentsPath,
      });
      await manager.startRecording('lv1', 'manual');
      const call = await nextRecordCall(0);
      expect(call.options.commentsPath).toBe(extension === 'csv' ? commentsPath : undefined);
      expect(call.options.prefetchBackwardComments).toBe(extension !== 'csv');
      expect((await manager.getRecordings())[0].commentCount).toBe(extension === 'csv' ? 42 : 0);
      expect(fs.readFileSync(commentsPath, 'utf8')).toBe(original);
    },
  );

  test('再開前の確認で番組情報が取れなくても、終了扱いにせずもう一度試す', async () => {
    await manager.startRecording('lv1', 'manual');
    const first = await nextRecordCall(0);
    getProgramInfo.mockRejectedValue(new Error('offline'));
    first.resolve(finishedResult(first, { video: { reason: 'idle', video: {} } }));

    await skipRetryWait(5_500);
    const second = await nextRecordCall(1);
    expect(second.options.attempt).toBe(2);
    expect(history.get('lv1')?.state).not.toBe('done');
  });

  test('番組が終わっていたら、そこまでの録画で完了にする', async () => {
    await manager.startRecording('lv1', 'manual');
    const first = await nextRecordCall(0);
    getProgramInfo.mockResolvedValue(info({ status: NicoLiveProgramStatus.ended }));
    first.resolve(finishedResult(first, { video: { reason: 'disconnected', video: {} } }));

    await skipRetryWait(5_500);
    await waitFor(() => history.get('lv1')?.state === 'done');
    expect(recordCalls).toHaveLength(1);
    expect(history.get('lv1')?.error).toBeUndefined();
  });

  test('放送中に視聴 URL が取れなければ、完了ではなく理由付きの失敗にする', async () => {
    await manager.startRecording('lv1', 'manual');
    const first = await nextRecordCall(0);
    getProgramInfo.mockResolvedValue(info({ webSocketUrl: undefined }));
    first.resolve(finishedResult(first, { video: { reason: 'disconnected', video: {} } }));
    await skipRetryWait(5_500);
    await waitFor(() => history.get('lv1')?.state === 'failed');
    expect(history.get('lv1')?.error).toContain('視聴接続情報');
    expect(recordCalls).toHaveLength(1);
  });
});
