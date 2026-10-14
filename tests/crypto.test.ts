import { describe, expect, it } from 'vitest';
import sodium from 'libsodium-wrappers';
import {
  decryptJSON,
  encryptJSON,
  generateSyncKey,
  importSyncKey,
  normalizeSyncKey,
  parseSyncKey,
  utf8ToBase64,
  base64ToUtf8,
} from '../src/core/crypto.ts';
import { encryptSecretValue } from '../src/data/sealedbox.ts';

describe('同步金鑰', () => {
  it('產生的金鑰格式正確且可解析', () => {
    const key = generateSyncKey();
    expect(key).toMatch(/^TNDA(-[0-9A-HJKMNP-TV-Z]{4}){8}$/);
    expect(parseSyncKey(key)?.length).toBe(20);
  });
  it('容忍小寫、空白與易混淆字元', () => {
    const key = generateSyncKey();
    const messy = key.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o');
    expect(normalizeSyncKey(messy)).toBe(key);
  });
  it('長度不對時回傳 null', () => {
    expect(parseSyncKey('TNDA-1234')).toBeNull();
  });
});

describe('AES-GCM 加解密', () => {
  it('來回加解密', async () => {
    const key = await importSyncKey(generateSyncKey());
    const data = { title: '上課提醒', n: 1, list: ['a', 'b'] };
    const env = await encryptJSON(key, data, 'posts/p_1.json');
    expect(env.ct).not.toContain('上課');
    expect(await decryptJSON(key, env, 'posts/p_1.json')).toEqual(data);
  });
  it('換了檔案路徑（AAD）就解不開', async () => {
    const key = await importSyncKey(generateSyncKey());
    const env = await encryptJSON(key, { a: 1 }, 'posts/a.json');
    await expect(decryptJSON(key, env, 'posts/b.json')).rejects.toThrow();
  });
  it('錯的金鑰解不開', async () => {
    const k1 = await importSyncKey(generateSyncKey());
    const k2 = await importSyncKey(generateSyncKey());
    const env = await encryptJSON(k1, { a: 1 }, 'x');
    await expect(decryptJSON(k2, env, 'x')).rejects.toThrow();
  });
  it('UTF-8 base64', () => {
    expect(base64ToUtf8(utf8ToBase64('中文 ✓ emoji 📚'))).toBe('中文 ✓ emoji 📚');
  });
});

describe('GitHub Secret 加密（sealed box）', () => {
  it('能被 libsodium 正確解開', async () => {
    await sodium.ready;
    const kp = sodium.crypto_box_keypair();
    const pk = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
    const sealed = encryptSecretValue('TNDA-SECRET-VALUE', pk);
    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL),
      kp.publicKey,
      kp.privateKey,
    );
    expect(sodium.to_string(opened)).toBe('TNDA-SECRET-VALUE');
  });
});
