# 多重化検証用メディア

外部から取得した録画ではなく、黒一色の 64×64 映像 (H.264、10 fps、2 秒) と無音 (AAC、48 kHz、stereo、2 秒) を生成した fMP4 です。このディレクトリの MP4 は CC0-1.0 として提供します。

生成コマンド (開発用 FFmpeg の libx264 / AAC / lavfi を使用。同梱する多重化用ビルドにはエンコーダを含めません):

```bash
ffmpeg -f lavfi -i 'color=c=black:s=64x64:r=10:d=2' -an -c:v libx264 -preset ultrafast -threads 1 -pix_fmt yuv420p -movflags +frag_keyframe+empty_moov+default_base_moof video.mp4
ffmpeg -f lavfi -i 'anullsrc=r=48000:cl=stereo' -t 2 -vn -c:a aac -movflags +frag_keyframe+empty_moov+default_base_moof audio.mp4
ffmpeg -i video.mp4 -i audio.mp4 -map 0:v -map 1:a -c copy -movflags +frag_keyframe+empty_moov+default_base_moof combined.mp4
```
