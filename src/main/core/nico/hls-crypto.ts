import crypto from 'node:crypto';

/** 鍵の取得・検証は呼び出し元に任せ、HLSのIV生成と復号だけを行う。 */
export function decryptHlsSegment(
  data: Buffer,
  key: Buffer,
  sequence: number,
  ivHex?: string,
): Buffer {
  const iv = Buffer.alloc(16);
  if (ivHex) {
    // 不正IVの許容範囲は呼び出し元ごとに維持し、ここでは検証を追加しない。
    Buffer.from(ivHex.padStart(32, '0'), 'hex').copy(iv);
  } else {
    iv.writeBigUInt64BE(BigInt(sequence), 8);
  }
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}
