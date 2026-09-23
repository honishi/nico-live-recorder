import fs from 'node:fs';
import path from 'node:path';

/** fd 3・4 を保存し、指定の終了コードで終わる。Node スクリプトなので Windows でも動く。 */
export function writeFakeFfmpeg(dir: string): string {
  const script = path.join(dir, 'fake-ffmpeg.cjs');
  fs.writeFileSync(
    script,
    [
      "const fs = require('node:fs');",
      "const net = require('node:net');",
      'const out = process.argv[process.argv.length - 1];',
      'const copy = (fd, file) =>',
      '  new Promise((resolve) => {',
      '    let input;',
      '    try {',
      '      input = new net.Socket({ fd, readable: true, writable: false });',
      '    } catch {',
      '      resolve(); // その fd が渡されていない (音声なし) ときは何もしない',
      '      return;',
      '    }',
      '    const output = fs.createWriteStream(file);',
      '    input.pipe(output);',
      "    output.on('close', resolve);",
      "    input.on('error', () => output.end());",
      '  });',
      "Promise.all([copy(3, out), copy(4, out + '.audio')]).then(() => {",
      '  process.exit(Number(process.env.FAKE_FFMPEG_EXIT || 0));',
      '});',
      '',
    ].join('\n'),
  );
  return script;
}
