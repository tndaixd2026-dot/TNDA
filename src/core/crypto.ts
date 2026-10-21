// 端對端加密：所有貼文與頻道設定在寫進公開 repo 之前，都會用「同步金鑰」以 AES-256-GCM 加密。
// 同一份程式碼同時跑在瀏覽器與 Node（皆使用 WebCrypto）。

import type { Envelope } from './types.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Crockford Base32（去掉容易混淆的 I、L、O、U）
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_BYTES = 20;

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function utf8ToBase64(text: string): string {
  return bytesToBase64(encoder.encode(text));
}

export function base64ToUtf8(b64: string): string {
  return decoder.decode(base64ToBytes(b64));
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text) {
    const idx = B32.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** 產生新的同步金鑰，格式：TNDA-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX */
export function generateSyncKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const body = base32Encode(bytes);
  return 'TNDA-' + (body.match(/.{4}/g) ?? []).join('-');
}

/** 解析使用者輸入的同步金鑰；容忍大小寫、空白、易混淆字元。 */
export function parseSyncKey(input: string): Uint8Array | null {
  let s = input.toUpperCase().replace(/[\s-]/g, '');
  if (s.startsWith('TNDA')) s = s.slice(4);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== 32) return null;
  const bytes = base32Decode(s);
  return bytes && bytes.length === KEY_BYTES ? bytes : null;
}

export function normalizeSyncKey(input: string): string | null {
  const bytes = parseSyncKey(input);
  if (!bytes) return null;
  return 'TNDA-' + (base32Encode(bytes).match(/.{4}/g) ?? []).join('-');
}

export async function importSyncKey(input: string): Promise<CryptoKey> {
  const bytes = parseSyncKey(input);
  if (!bytes) throw new Error('同步金鑰格式不正確');
  const base = await crypto.subtle.importKey('raw', bytes as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('tnda-relay/v1'),
      info: encoder.encode('data'),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** 以檔案路徑作為附加驗證資料（AAD），避免加密檔被搬到別的路徑冒用。 */
export async function encryptJSON(key: CryptoKey, data: unknown, aad: string): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(JSON.stringify(data)),
  );
  return { tnda: 1, alg: 'A256GCM', iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ct)) };
}

export async function decryptJSON<T>(key: CryptoKey, env: Envelope, aad: string): Promise<T> {
  if (!env || env.tnda !== 1 || env.alg !== 'A256GCM') throw new Error('不支援的加密格式');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(env.iv) as BufferSource, additionalData: encoder.encode(aad) },
    key,
    base64ToBytes(env.ct) as BufferSource,
  );
  return JSON.parse(decoder.decode(plain)) as T;
}

const FILE_MAGIC = encoder.encode('TNDAF1');

/** 加密二進位檔案（附檔）：TNDAF1 + 12 bytes IV + 密文，路徑作為 AAD */
export async function encryptBytes(key: CryptoKey, data: Uint8Array, aad: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, data as BufferSource));
  const out = new Uint8Array(FILE_MAGIC.length + iv.length + ct.length);
  out.set(FILE_MAGIC, 0);
  out.set(iv, FILE_MAGIC.length);
  out.set(ct, FILE_MAGIC.length + iv.length);
  return out;
}

export async function decryptBytes(key: CryptoKey, blob: Uint8Array, aad: string): Promise<Uint8Array> {
  if (blob.length < FILE_MAGIC.length + 12 || FILE_MAGIC.some((b, i) => blob[i] !== b)) throw new Error('不支援的附檔格式');
  const iv = blob.subarray(FILE_MAGIC.length, FILE_MAGIC.length + 12);
  const ct = blob.subarray(FILE_MAGIC.length + 12);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: encoder.encode(aad) }, key, ct as BufferSource));
}

export function isEnvelope(value: unknown): value is Envelope {
  const v = value as Envelope;
  return !!v && typeof v === 'object' && v.tnda === 1 && typeof v.iv === 'string' && typeof v.ct === 'string';
}

export function randomId(prefix: string, length = 12): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${prefix}_${out}`;
}
