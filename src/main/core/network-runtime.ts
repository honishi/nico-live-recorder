import { install } from 'undici';

// Electron 内蔵の Undici に修正が届くまで、通信開始前に配布パッケージの実装へ揃える。
// fetch だけでなく WebSocket・Request・Response 等も置き換え、実装の混在を避ける。
install();
