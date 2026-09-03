/**
 * RFC8291 - Message Encryption for Web Push
 * Implementation of encryption/decryption processing
 */
// Node の WebCrypto 型 (ブラウザの lib.dom を使わないため明示する)
type CryptoKey = import('node:crypto').webcrypto.CryptoKey;

// ========== Base64 Encoding/Decoding ==========
/**
 * Base64 encode (URL-safe)
 */
export function base64UrlEncode(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return btoa(toBinaryString(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Base64 decode (URL-safe)
 */
export function base64UrlDecode(str: string): Uint8Array {
  // Add padding
  const padding = (4 - (str.length % 4)) % 4;
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padding);

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Standard Base64 encode (with padding)
 */
export function base64Encode(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return btoa(toBinaryString(bytes));
}

// ========== Key Generation ==========
/**
 * Generate ECDH key pair
 */
export async function generateKeyPair(): Promise<{
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyBytes: Uint8Array;
  privateKeyBytes: Uint8Array;
}> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    true,
    ['deriveBits'],
  );

  // Export public key
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const publicKeyBytes = new Uint8Array([
    0x04, // Uncompressed point format
    ...base64UrlDecode(publicKeyJwk.x!),
    ...base64UrlDecode(publicKeyJwk.y!),
  ]);

  // Export private key
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  const privateKeyBytes = base64UrlDecode(privateKeyJwk.d!);

  return {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    publicKeyBytes,
    privateKeyBytes,
  };
}

/**
 * Generate authentication secret (16 bytes)
 */
export function generateAuthSecret(): Uint8Array {
  const authSecret = new Uint8Array(16);
  crypto.getRandomValues(authSecret);
  return authSecret;
}

/**
 * Generate salt (16 bytes)
 */
export function generateSalt(): Uint8Array {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return salt;
}

// ========== Key Import/Export ==========
/**
 * Convert key information to storage format
 */
export function exportKeys(keys: {
  authSecret: Uint8Array;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}): {
  authSecret: string;
  publicKey: string;
  privateKey: string;
} {
  return {
    authSecret: base64UrlEncode(keys.authSecret),
    publicKey: base64UrlEncode(keys.publicKey),
    privateKey: base64UrlEncode(keys.privateKey),
  };
}

/**
 * Restore saved key information
 */
export async function importKeys(keys: {
  authSecret: string;
  publicKey: string;
  privateKey: string;
}): Promise<{
  authSecret: Uint8Array;
  publicKey: Uint8Array;
  privateKey: CryptoKey;
}> {
  const authSecret = base64UrlDecode(keys.authSecret);
  const publicKeyBytes = base64UrlDecode(keys.publicKey);
  const privateKeyBytes = base64UrlDecode(keys.privateKey);

  // Import private key as CryptoKey
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: base64UrlEncode(privateKeyBytes),
      x: base64UrlEncode(publicKeyBytes.slice(1, 33)),
      y: base64UrlEncode(publicKeyBytes.slice(33, 65)),
      ext: true,
    },
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    false,
    ['deriveBits'],
  );

  return {
    authSecret,
    publicKey: publicKeyBytes,
    privateKey,
  };
}

// ========== Payload Parsing ==========
/**
 * Parse AutoPush notification payload
 */
export function parseAutoPushPayload(data: string): {
  ciphertext: Uint8Array;
  header: Uint8Array;
  salt: Uint8Array;
  publicKey: Uint8Array;
  recordSize: number;
} {
  // Base64 decode
  const decoded = base64UrlDecode(data);

  // Payload structure (aes128gcm):
  // - salt: 16 bytes
  // - record size: 4 bytes (big-endian)
  // - public key length: 1 byte
  // - public key: 65 bytes (uncompressed P-256)
  // - ciphertext: remainder

  const salt = decoded.slice(0, 16);
  const recordSize = (decoded[16] << 24) | (decoded[17] << 16) | (decoded[18] << 8) | decoded[19];
  const publicKeyLength = decoded[20];
  const publicKey = decoded.slice(21, 21 + publicKeyLength);
  const header = decoded.slice(0, 21 + publicKeyLength);
  const ciphertext = decoded.slice(21 + publicKeyLength);

  return {
    salt: new Uint8Array(salt),
    publicKey: new Uint8Array(publicKey),
    ciphertext: new Uint8Array(ciphertext),
    header: new Uint8Array(header),
    recordSize,
  };
}

interface NotificationPayload {
  ciphertext: Uint8Array;
  header: Uint8Array;
  salt: Uint8Array;
  publicKey: Uint8Array;
  recordSize: number;
}

interface NotificationKeys {
  authSecret: Uint8Array;
  privateKey: CryptoKey;
  publicKey: Uint8Array;
}

export interface DecryptionResult {
  plaintext: string;
  /**
   * True when decryption only succeeded with the leading zero byte of the
   * ECDH shared secret stripped (compat mode for Niconico's sender, which
   * uses a variable-length shared secret representation instead of the
   * fixed 32 bytes required by RFC 8291).
   */
  usedSharedSecretFallback: boolean;
}

export async function decryptNotification(
  payload: NotificationPayload,
  keys: NotificationKeys,
): Promise<string> {
  return (await decryptNotificationWithInfo(payload, keys)).plaintext;
}

/**
 * Decrypt a notification, trying the RFC 8291 compliant 32-byte shared secret
 * first and falling back to the legacy stripped representation when the
 * secret has a leading zero byte (~1/256 of messages).
 */
export async function decryptNotificationWithInfo(
  payload: NotificationPayload,
  keys: NotificationKeys,
): Promise<DecryptionResult> {
  const asPublicKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(payload.publicKey),
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    false,
    [],
  );

  const sharedSecret = await computeSharedSecret(keys.privateKey, asPublicKey);

  try {
    return {
      plaintext: await deriveKeysAndDecrypt(sharedSecret, payload, keys),
      usedSharedSecretFallback: false,
    };
  } catch (error) {
    // Compat fallback: senders that strip the leading zero derive different keys
    if (sharedSecret.length > 0 && sharedSecret[0] === 0) {
      return {
        plaintext: await deriveKeysAndDecrypt(sharedSecret.slice(1), payload, keys),
        usedSharedSecretFallback: true,
      };
    }
    throw error;
  }
}

async function deriveKeysAndDecrypt(
  sharedSecret: Uint8Array,
  payload: NotificationPayload,
  keys: NotificationKeys,
): Promise<string> {
  const infoLabel = encodeText('WebPush: info\0');
  const context = new Uint8Array(keys.publicKey.length + payload.publicKey.length);
  context.set(keys.publicKey, 0);
  context.set(payload.publicKey, keys.publicKey.length);

  const prkInfo = new Uint8Array(infoLabel.length + context.length);
  prkInfo.set(infoLabel);
  prkInfo.set(context, infoLabel.length);

  const prk = await hkdf(keys.authSecret, sharedSecret, prkInfo, 32);

  const nonceInfo = encodeText('Content-Encoding: nonce\0');
  const cekInfo = encodeText('Content-Encoding: aes128gcm\0');
  const baseNonce = await hkdf(payload.salt, prk, nonceInfo, 12);
  const cek = await hkdf(payload.salt, prk, cekInfo, 16);

  const key = await crypto.subtle.importKey('raw', toArrayBuffer(cek), { name: 'AES-GCM' }, false, [
    'decrypt',
  ]);

  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: toArrayBuffer(baseNonce),
      tagLength: 128,
    },
    key,
    toArrayBuffer(payload.ciphertext),
  );

  return processDecryptedBytes(new Uint8Array(decrypted));
}

// ========== Internal Utilities ==========
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Encode text as UTF-8 using a shared TextEncoder instance. */
function encodeText(text: string): Uint8Array {
  return textEncoder.encode(text);
}

/** Decode UTF-8 bytes using a shared TextDecoder instance. */
function decodeText(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

/** Create a detached ArrayBuffer copy suitable for Web Crypto raw inputs. */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.slice().buffer;
}

/** Convert a byte array into a binary string compatible with window.btoa. */
function toBinaryString(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return binary;
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const actualSalt = salt.length === 0 ? new Uint8Array(32) : salt;
  const saltKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(actualSalt),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const prkBytes = new Uint8Array(await crypto.subtle.sign('HMAC', saltKey, toArrayBuffer(ikm)));

  const prkKey = await crypto.subtle.importKey(
    'raw',
    prkBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const output = new Uint8Array(length);
  let t = new Uint8Array(0);
  let offset = 0;

  for (let i = 1; offset < length; i++) {
    const input = new Uint8Array(t.length + info.length + 1);
    input.set(t);
    input.set(info, t.length);
    input[t.length + info.length] = i;

    t = new Uint8Array(await crypto.subtle.sign('HMAC', prkKey, input));

    const copyLength = Math.min(t.length, length - offset);
    output.set(t.subarray(0, copyLength), offset);
    offset += copyLength;
  }

  return output;
}

async function computeSharedSecret(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
): Promise<Uint8Array> {
  const sharedSecret = await crypto.subtle.deriveBits(
    {
      name: 'ECDH',
      public: publicKey,
    },
    privateKey,
    256,
  );

  return new Uint8Array(sharedSecret);
}

/** Strip padding bytes and normalise decrypted payload to UTF-8 text. */
function processDecryptedBytes(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    throw new Error('Decrypted data is empty');
  }

  let processed = bytes;
  const lastByte = bytes[bytes.length - 1];
  if (lastByte === 0x02 || lastByte === 0x01) {
    processed = bytes.slice(0, -1);
  }

  if (processed.length === 0) {
    throw new Error('Decrypted data has no content after trimming');
  }

  const firstByte = processed[0];
  if (firstByte === 0x7b || firstByte === 0x5b) {
    return decodeText(processed);
  }

  const paddingLength = firstByte;
  if (paddingLength === 0 && processed.length > 1) {
    return decodeText(processed.slice(1));
  }

  if (paddingLength + 1 <= processed.length) {
    return decodeText(processed.slice(paddingLength + 1));
  }

  return decodeText(processed);
}
