// GitHub Actions Secret 需要用 repo 的公開金鑰以 libsodium sealed box 加密。
// 這裡用 tweetnacl + blake2b 實作同樣的演算法（體積比 libsodium 小很多）。

import nacl from 'tweetnacl';
import { blake2b } from 'blakejs';
import { base64ToBytes, bytesToBase64 } from '../core/crypto.ts';

export function sealedBox(message: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
  const eph = nacl.box.keyPair();
  const nonceInput = new Uint8Array(64);
  nonceInput.set(eph.publicKey, 0);
  nonceInput.set(recipientPublicKey, 32);
  const nonce = blake2b(nonceInput, undefined, 24);
  const boxed = nacl.box(message, nonce, recipientPublicKey, eph.secretKey);
  const out = new Uint8Array(32 + boxed.length);
  out.set(eph.publicKey, 0);
  out.set(boxed, 32);
  return out;
}

export function encryptSecretValue(value: string, publicKeyBase64: string): string {
  return bytesToBase64(sealedBox(new TextEncoder().encode(value), base64ToBytes(publicKeyBase64)));
}
