type CryptoKey = import('node:crypto').webcrypto.CryptoKey;
import {
  base64UrlEncode,
  base64UrlDecode,
  base64Encode,
  importKeys,
  parseAutoPushPayload,
  decryptNotificationWithInfo,
} from '../../../src/main/vendor/web-push/web-push-crypto';

// 登録先が要求する標準形式と、保存・受信に使う URL 形式を固定値で検証する。
test('Base64 の URL 形式と標準形式を区別し、padding を扱う', () => {
  const bytes = new Uint8Array([251, 255, 255, 255]);
  expect(base64UrlEncode(bytes)).toBe('-____w');
  expect(base64Encode(bytes)).toBe('+////w==');
  expect(base64UrlDecode('-____w')).toEqual(bytes);
});

// ========== Shared Secret Fallback (RFC 8291 vs legacy sender) ==========
//
// Niconico's sender derives encryption keys from a variable-length ECDH shared
// secret (leading zero byte stripped), while RFC 8291 mandates the fixed
// 32-byte representation. decryptNotificationWithInfo must handle both.
// Fixed key pairs below are pre-generated so the leading-zero case is
// deterministic (shared secret of uaZero x asZero starts with 0x00).
describe('Shared secret fallback', () => {
  const uaZero = {
    d: '2Ja65pt0kK-IznORbXFGsW4845d4W88vsm4Fo1g10nk',
    x: 'qFsnlDTdz46J6ffEpwI51ad_lbfQkicsEwwuWstbujQ',
    y: 'yLHr-TGqNOXKz2pedlrUTE0As5QcAcqfQXBRvskl-Qc',
  };
  const asZero = {
    d: 'doEIdg3cYn36Voh49JhbADbDeSvAfNWWoUhA1OTa_Gg',
    x: 'qPcOMC3C7LKGP0hDdG9NqSQ5jcYCQEQJ2Zj3UGnQ5NM',
    y: 'mq1g8tXcnMRN9KTDATIuTvdbPqkNw9lb5h7OMouJmW0',
  };
  const uaNonZero = {
    d: '_69Bt7pewiuoy0XdEdfNRHOn2zRfXYPRJ7i5OKubZgU',
    x: 'HnqXT6_mGO5NjoRIrgHvswBIcF_kbgA6Sx3FxUuSf1k',
    y: 'h6l8JMDGt9_DzmRjgfk12-jADpFMD90zFNrDFr4nLlI',
  };
  const asNonZero = {
    d: 'vJY6f_IGco4r09dn_SPxaSRZWbSUkce6anPgLAKiTJM',
    x: 'shhlJ96iNzUmt-tkzryGnRBmwbKVNoeY6fyyMFfaVeE',
    y: 'VLN6CVlqL6UVDa_5g_YDs5DFxZ0Qq10UeliClsv_XJ8',
  };

  const PLAINTEXT = '{"title":"test","body":"hello"}';
  const AUTH_SECRET = new Uint8Array(16).fill(1);
  const SALT = new Uint8Array(16).fill(2);

  type Jwk = { d: string; x: string; y: string };

  function toBuffer(view: Uint8Array): ArrayBuffer {
    return view.slice().buffer;
  }

  function publicKeyBytes(jwk: Jwk): Uint8Array {
    return new Uint8Array([0x04, ...base64UrlDecode(jwk.x), ...base64UrlDecode(jwk.y)]);
  }

  async function importPrivate(jwk: Jwk): Promise<CryptoKey> {
    return crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y, ext: true },
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
  }

  async function importPublic(jwk: Jwk): Promise<CryptoKey> {
    return crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true },
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
  }

  async function computeSecret(privateJwk: Jwk, publicJwk: Jwk): Promise<Uint8Array> {
    const priv = await importPrivate(privateJwk);
    const pub = await importPublic(publicJwk);
    const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
    return new Uint8Array(bits);
  }

  async function hkdf(
    salt: Uint8Array,
    ikm: Uint8Array,
    info: Uint8Array,
    length: number,
  ): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey('raw', toBuffer(ikm), 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: toBuffer(salt), info: toBuffer(info) },
      key,
      length * 8,
    );
    return new Uint8Array(bits);
  }

  /**
   * RFC 8188/8291 sender-side encryption (single record, aes128gcm).
   * stripLeadingZero=true emulates Niconico's legacy shared secret handling.
   */
  async function encrypt(
    uaJwk: Jwk,
    asJwk: Jwk,
    stripLeadingZero: boolean,
  ): Promise<{
    payload: ReturnType<typeof parseAutoPushPayload>;
    keys: { authSecret: Uint8Array; privateKey: CryptoKey; publicKey: Uint8Array };
  }> {
    const uaPub = publicKeyBytes(uaJwk);
    const asPub = publicKeyBytes(asJwk);

    let secret = await computeSecret(asJwk, uaJwk);
    if (stripLeadingZero && secret[0] === 0) {
      secret = secret.slice(1);
    }

    const encoder = new TextEncoder();
    const infoLabel = encoder.encode('WebPush: info\0');
    const prkInfo = new Uint8Array([...infoLabel, ...uaPub, ...asPub]);
    const ikm = await hkdf(AUTH_SECRET, secret, prkInfo, 32);
    const cek = await hkdf(SALT, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
    const nonce = await hkdf(SALT, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);

    const record = new Uint8Array([...encoder.encode(PLAINTEXT), 0x02]); // final record delimiter
    const key = await crypto.subtle.importKey('raw', toBuffer(cek), { name: 'AES-GCM' }, false, [
      'encrypt',
    ]);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: toBuffer(nonce), tagLength: 128 },
        key,
        toBuffer(record),
      ),
    );

    // aes128gcm binary payload: salt(16) | rs(4) | idlen(1) | as_pub(65) | ciphertext
    const binary = new Uint8Array([...SALT, 0, 0, 16, 0, asPub.length, ...asPub, ...ciphertext]);
    return {
      payload: parseAutoPushPayload(base64UrlEncode(binary)),
      // Build the receiver keys through the production import path
      keys: await importKeys({
        authSecret: base64UrlEncode(AUTH_SECRET),
        publicKey: base64UrlEncode(uaPub),
        privateKey: uaJwk.d,
      }),
    };
  }

  test('RFC-compliant sender with leading-zero secret decrypts without fallback', async () => {
    const { payload, keys } = await encrypt(uaZero, asZero, false);
    const result = await decryptNotificationWithInfo(payload, keys);
    expect(result.plaintext).toBe(PLAINTEXT);
    expect(result.usedSharedSecretFallback).toBe(false);
  });

  test('legacy sender with leading-zero secret decrypts via fallback', async () => {
    const { payload, keys } = await encrypt(uaZero, asZero, true);
    const result = await decryptNotificationWithInfo(payload, keys);
    expect(result.plaintext).toBe(PLAINTEXT);
    expect(result.usedSharedSecretFallback).toBe(true);
  });

  test('non-zero secret decrypts without fallback regardless of sender', async () => {
    const { payload, keys } = await encrypt(uaNonZero, asNonZero, true);
    const result = await decryptNotificationWithInfo(payload, keys);
    expect(result.plaintext).toBe(PLAINTEXT);
    expect(result.usedSharedSecretFallback).toBe(false);
  });

  test('tampered ciphertext still fails for leading-zero secrets', async () => {
    const { payload, keys } = await encrypt(uaZero, asZero, true);
    payload.ciphertext[0] ^= 0xff;
    await expect(decryptNotificationWithInfo(payload, keys)).rejects.toThrow();
  });
});
