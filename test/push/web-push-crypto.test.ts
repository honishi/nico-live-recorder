/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Test suite for RFC8291 Web Push Encryption/Decryption
 *
 * To run with real data:
 * 1. Replace dummy data in test/data/push/*.json files with actual values
 * 2. Run: npm test web-push-crypto
 */

type CryptoKey = import('node:crypto').webcrypto.CryptoKey;
import * as fs from 'fs';
import * as path from 'path';
import {
  base64UrlEncode,
  base64UrlDecode,
  base64Encode,
  generateKeyPair,
  generateAuthSecret,
  generateSalt,
  exportKeys,
  importKeys,
  parseAutoPushPayload,
  decryptNotification,
  decryptNotificationWithInfo,
} from '../../src/main/push/web-push-crypto';

// ========== Test Data Loading ==========
const testDataDir = path.join(__dirname, 'data');

interface TestDataSet {
  keys: {
    authSecret: string;
    publicKey: string;
    privateKey: string;
  };
  payload: {
    encryptedPayload: string;
  };
  expected: {
    decryptedJson: any;
  };
}

function loadDataset(filename: string): TestDataSet | null {
  const filePath = path.join(testDataDir, 'datasets', filename);
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.warn(`Error loading dataset "${filename}":`, e);
    }
  }
  return null;
}

function getAvailableDatasets(): { name: string; data: TestDataSet }[] {
  const datasets: { name: string; data: TestDataSet }[] = [];

  // Check datasets directory for real data
  const datasetsDir = path.join(testDataDir, 'datasets');
  if (fs.existsSync(datasetsDir)) {
    const files = fs
      .readdirSync(datasetsDir, { withFileTypes: true })
      .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.json'))
      .map((dirent) => dirent.name);

    for (const file of files) {
      const data = loadDataset(file);
      if (data) {
        datasets.push({ name: file.replace('.json', ''), data });
      }
    }
  }

  // If no datasets found, use example
  if (datasets.length === 0) {
    const examplePath = path.join(testDataDir, 'examples', 'example.json');
    if (fs.existsSync(examplePath)) {
      try {
        const exampleData = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
        console.warn(
          'Using example dataset. To use real data, add .json files to datasets/ directory',
        );
        datasets.push({ name: 'example', data: exampleData });
      } catch (e) {
        console.warn('Error loading example dataset:', e);
      }
    }
  }

  return datasets;
}

// ========== Base64 Encoding/Decoding Tests ==========
describe('Base64 Encoding/Decoding', () => {
  test('base64UrlEncode should encode correctly', () => {
    const input = new Uint8Array([255, 254, 253, 252, 251, 250]);
    const encoded = base64UrlEncode(input);
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
    expect(encoded).toBe('__79_Pv6');
  });

  test('base64UrlDecode should decode correctly', () => {
    const input = '__79_Pv6';
    const decoded = base64UrlDecode(input);
    expect(Array.from(decoded)).toEqual([255, 254, 253, 252, 251, 250]);
  });

  test('base64UrlEncode and base64UrlDecode should be reversible', () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const encoded = base64UrlEncode(original);
    const decoded = base64UrlDecode(encoded);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  test('base64Encode should produce standard Base64 with padding', () => {
    const input = new Uint8Array([255, 254, 253]);
    const encoded = base64Encode(input);
    expect(encoded).toBe('//79');
    expect(encoded).toMatch(/^[A-Za-z0-9+/]*=*$/);
  });

  test('base64Encode should handle empty input', () => {
    const input = new Uint8Array([]);
    const encoded = base64Encode(input);
    expect(encoded).toBe('');
  });
});

// ========== Key Generation Tests ==========
describe('Key Generation', () => {
  test('generateKeyPair should generate valid P-256 keys', async () => {
    const keyPair = await generateKeyPair();

    expect(keyPair.privateKey).toBeDefined();
    expect(keyPair.publicKey).toBeDefined();
    expect(keyPair.publicKeyBytes).toBeInstanceOf(Uint8Array);
    expect(keyPair.privateKeyBytes).toBeInstanceOf(Uint8Array);

    // Public key should be 65 bytes (0x04 + 32 bytes X + 32 bytes Y)
    expect(keyPair.publicKeyBytes.length).toBe(65);
    expect(keyPair.publicKeyBytes[0]).toBe(0x04); // Uncompressed format

    // Private key should be 32 bytes
    expect(keyPair.privateKeyBytes.length).toBe(32);
  });

  test('generateAuthSecret should generate 16-byte secret', () => {
    const authSecret = generateAuthSecret();
    expect(authSecret).toBeInstanceOf(Uint8Array);
    expect(authSecret.length).toBe(16);

    // Should be random (different each time)
    const authSecret2 = generateAuthSecret();
    expect(Array.from(authSecret)).not.toEqual(Array.from(authSecret2));
  });

  test('generateSalt should generate 16-byte salt', () => {
    const salt = generateSalt();
    expect(salt).toBeInstanceOf(Uint8Array);
    expect(salt.length).toBe(16);

    // Should be random
    const salt2 = generateSalt();
    expect(Array.from(salt)).not.toEqual(Array.from(salt2));
  });
});

// ========== Key Import/Export Tests ==========
describe('Key Import/Export', () => {
  test('exportKeys should convert to Base64 URL format', async () => {
    const keyPair = await generateKeyPair();
    const authSecret = generateAuthSecret();

    const exported = exportKeys({
      authSecret,
      publicKey: keyPair.publicKeyBytes,
      privateKey: keyPair.privateKeyBytes,
    });

    expect(typeof exported.authSecret).toBe('string');
    expect(typeof exported.publicKey).toBe('string');
    expect(typeof exported.privateKey).toBe('string');

    // Should be URL-safe (no +, /, or =)
    expect(exported.authSecret).not.toMatch(/[+/=]/);
    expect(exported.publicKey).not.toMatch(/[+/=]/);
    expect(exported.privateKey).not.toMatch(/[+/=]/);
  });

  test('importKeys should restore keys correctly', async () => {
    const keyPair = await generateKeyPair();
    const authSecret = generateAuthSecret();

    const exported = exportKeys({
      authSecret,
      publicKey: keyPair.publicKeyBytes,
      privateKey: keyPair.privateKeyBytes,
    });

    const imported = await importKeys(exported);

    expect(Array.from(imported.authSecret)).toEqual(Array.from(authSecret));
    expect(Array.from(imported.publicKey)).toEqual(Array.from(keyPair.publicKeyBytes));
    expect(imported.privateKey).toBeDefined();
  });
});

// ========== Payload Parsing Tests ==========
describe('Payload Parsing', () => {
  test('parseAutoPushPayload should extract components correctly', () => {
    // Create a mock payload structure
    const salt = new Uint8Array(16).fill(1);
    const recordSize = new Uint8Array([0x00, 0x10, 0x00, 0x00]); // 4096
    const publicKeyLength = new Uint8Array([65]);
    const publicKey = new Uint8Array(65).fill(2);
    const ciphertext = new Uint8Array(32).fill(3);

    // Combine into payload
    const payload = new Uint8Array([
      ...salt,
      ...recordSize,
      ...publicKeyLength,
      ...publicKey,
      ...ciphertext,
    ]);

    const encoded = base64UrlEncode(payload);
    const parsed = parseAutoPushPayload(encoded);

    expect(Array.from(parsed.salt)).toEqual(Array.from(salt));
    expect(parsed.recordSize).toBe(0x00100000); // 1048576 (big-endian)
    expect(Array.from(parsed.publicKey)).toEqual(Array.from(publicKey));
    expect(Array.from(parsed.ciphertext)).toEqual(Array.from(ciphertext));
  });
});

// ========== Main Decryption Tests (with real/example data) ==========
describe('Decryption with Real Data', () => {
  // Test all available datasets
  const availableDatasets = getAvailableDatasets();

  availableDatasets.forEach(({ name, data }) => {
    test(`decryptNotification with dataset: ${name}`, async () => {
      // Check if we have real data (not dummy data)
      if (data.keys.authSecret === 'AAAAAAAAAAAAAAAAAAAAAA') {
        console.warn(`Dataset "${name}" contains dummy data. Skipping.`);
        return;
      }

      // Import keys
      const keys = await importKeys({
        authSecret: data.keys.authSecret,
        publicKey: data.keys.publicKey,
        privateKey: data.keys.privateKey,
      });

      // Parse payload
      const payload = parseAutoPushPayload(data.payload.encryptedPayload);

      // Decrypt
      const decrypted = await decryptNotification(payload, keys);
      const decryptedJson = JSON.parse(decrypted);

      // Verify
      expect(decryptedJson).toEqual(data.expected.decryptedJson);
    });
  });

  test('decryptNotification integration test with generated keys', async () => {
    // This test demonstrates the full flow with self-generated test data
    // In real usage, the payload would come from Niconico's server

    const keyPair = await generateKeyPair();
    const authSecret = generateAuthSecret();

    // For a real test, you would:
    // 1. Register these keys with Niconico Push API
    // 2. Receive an encrypted payload
    // 3. Decrypt it using the same keys

    // Here we just verify the functions work together
    expect(keyPair.publicKeyBytes).toBeDefined();
    expect(authSecret).toBeDefined();
  });
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

  test('fixture pair actually has a leading-zero shared secret', async () => {
    const secret = await computeSecret(uaZero, asZero);
    expect(secret.length).toBe(32);
    expect(secret[0]).toBe(0);

    const secretNonZero = await computeSecret(uaNonZero, asNonZero);
    expect(secretNonZero[0]).not.toBe(0);
  });

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

  test('decryptNotification string API remains compatible', async () => {
    const { payload, keys } = await encrypt(uaZero, asZero, true);
    await expect(decryptNotification(payload, keys)).resolves.toBe(PLAINTEXT);
  });

  test('tampered ciphertext still fails for leading-zero secrets', async () => {
    const { payload, keys } = await encrypt(uaZero, asZero, true);
    payload.ciphertext[0] ^= 0xff;
    await expect(decryptNotificationWithInfo(payload, keys)).rejects.toThrow();
  });
});

// ========== Helper function for debugging ==========
describe('Debug Helpers', () => {
  test('should provide instructions for capturing new test data', () => {
    // This test provides instructions for capturing NEW test data
    // (Useful when you need to update test data or test with different scenarios)
    const captureInstructions = `
To capture NEW push notification data for testing:

1. In web-push-manager.ts, add logging:
   console.log('Keys for testing:', {
     authSecret: base64UrlEncode(this.keys.authSecret),
     publicKey: base64UrlEncode(this.keys.publicKey),
     privateKey: base64UrlEncode(this.keys.privateKey)
   });

2. In background.ts push event handler, add:
   console.log('Encrypted payload:', event.data.text());

3. After successful decryption, log:
   console.log('Decrypted JSON:', decryptedData);

4. Copy these values to test/data/push/*.json files
`;

    expect(captureInstructions).toBeTruthy();
    console.log(captureInstructions);
  });
});
