// 密碼登入：把這台裝置的 Token 與同步金鑰用密碼加密，存成資料分支上的 login.json。
// 新裝置只要輸入密碼就能解開並登入。
// 這個檔案在公開 repo 上，任何人都能下載並離線猜密碼，所以用 PBKDF2 拉長每次猜測的時間，並要求足夠長的密碼。

import { base64ToBytes, bytesToBase64 } from './crypto.ts';

export const VAULT_PATH = 'login.json';
/** OWASP 建議的 PBKDF2-HMAC-SHA256 次數 */
export const VAULT_ITERATIONS = 600_000;
export const MIN_PASSWORD_LENGTH = 10;
const AAD = new TextEncoder().encode('tnda-login/v1');

export interface LoginVault {
  tnda: 'login';
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iter: number;
  salt: string;
  iv: string;
  ct: string;
  updatedAt: string;
}

export interface LoginSecrets {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  syncKey: string;
}

export class WrongPasswordError extends Error {
  constructor() {
    super('密碼不正確');
    this.name = 'WrongPasswordError';
  }
}

/** 密碼太弱時回傳原因 */
export function passwordProblem(password: string): string | null {
  const pw = password.normalize('NFC');
  if ([...pw].length < MIN_PASSWORD_LENGTH) return `密碼至少要 ${MIN_PASSWORD_LENGTH} 個字`;
  if (/^(.)\1*$/u.test(pw)) return '不能全部是同一個字';
  if (/^\d+$/.test(pw)) return '不能只有數字（例如生日、電話）';
  if (/^(?:0123456789|1234567890|abcdefghij|qwertyuiop|password)/i.test(pw)) return '太常見了，請換一個';
  return null;
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sealVault(password: string, secrets: LoginSecrets, iterations = VAULT_ITERATIONS): Promise<LoginVault> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  const plain = new TextEncoder().encode(JSON.stringify(secrets));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, plain));
  return {
    tnda: 'login',
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iter: iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ct: bytesToBase64(ct),
    updatedAt: new Date().toISOString(),
  };
}

export function parseVault(text: string): LoginVault {
  const v = JSON.parse(text) as LoginVault;
  if (v?.tnda !== 'login' || v.v !== 1 || v.kdf !== 'PBKDF2-SHA256' || !(v.iter >= 100_000)) {
    throw new Error('登入檔格式不正確');
  }
  return v;
}

export async function openVault(password: string, vault: LoginVault): Promise<LoginSecrets> {
  const key = await deriveKey(password, base64ToBytes(vault.salt), vault.iter);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(vault.iv) as BufferSource, additionalData: AAD },
      key,
      base64ToBytes(vault.ct) as BufferSource,
    );
  } catch {
    throw new WrongPasswordError();
  }
  const s = JSON.parse(new TextDecoder().decode(plain)) as LoginSecrets;
  if (!s.owner || !s.repo || !s.token || !s.syncKey) throw new Error('登入檔內容不完整');
  return s;
}
