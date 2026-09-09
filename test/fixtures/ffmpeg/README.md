# 多重化・プレビュー検証用メディア

外部から取得した録画ではなく、黒一色の 64×64 映像 (H.264、10 fps、2 秒) と無音 (AAC、48 kHz、stereo、2 秒) を生成した fMP4 です。このディレクトリの MP4 は CC0-1.0 として提供します。

生成コマンド (開発用 FFmpeg の libx264 / AAC / lavfi を使用。同梱ビルドには H.264 / AAC エンコーダを含めません。MJPEG エンコーダはプレビュー画像用です):

```bash
ffmpeg -f lavfi -i 'color=c=black:s=64x64:r=10:d=2' -an -c:v libx264 -preset ultrafast -threads 1 -pix_fmt yuv420p -movflags +frag_keyframe+empty_moov+default_base_moof video.mp4
ffmpeg -f lavfi -i 'anullsrc=r=48000:cl=stereo' -t 2 -vn -c:a aac -movflags +frag_keyframe+empty_moov+default_base_moof audio.mp4
ffmpeg -i video.mp4 -i audio.mp4 -map 0:v -map 1:a -c copy -movflags +frag_keyframe+empty_moov+default_base_moof combined.mp4
```

`preview-colors.mp4` は左上が赤・右上が緑・左下が青・右下が白の640×360映像です。320×180へ実際に縮小し、JPEGの寸法と各領域の内部色を検証します。色の境界から8pxは除外し、H.264/JPEGの圧縮誤差はRGB各成分20まで許容します。黒一色やJPEGマーカーの確認だけでは見逃す、x86向け縮小処理の色化けを検出するための入力です。この合成MP4もCC0-1.0です。

```bash
ffmpeg -f lavfi -i 'color=c=red:s=640x360:r=1:d=1,drawbox=x=320:y=0:w=320:h=180:color=lime:t=fill,drawbox=x=0:y=180:w=320:h=180:color=blue:t=fill,drawbox=x=320:y=180:w=320:h=180:color=white:t=fill' -an -c:v libx264 -preset ultrafast -threads 1 -pix_fmt yuv420p -movflags +frag_keyframe+empty_moov+default_base_moof preview-colors.mp4
```
