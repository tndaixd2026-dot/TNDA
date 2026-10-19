import { describe, expect, it } from 'vitest';
import { WrongPasswordError, openVault, parseVault, passwordProblem, sealVault, type LoginSecrets } from '../src/core/vault.ts';

const SECRETS: LoginSecrets = { owner: 'me', repo: 'TNDA', branch: 'tnda-data', token: 'github_pat_secret', syncKey: 'TNDA-AAAA-BBBB' };
const FAST = 100_000;

describe('密碼登入檔', () => {
  it('用正確密碼可以解開，檔案裡看不到 Token 與金鑰', async () => {
    const vault = await sealVault('TNDA課務每週一中午發', SECRETS, FAST);
    const text = JSON.stringify(vault);
    expect(text).not.toContain('github_pat');
    expect(text).not.toContain('TNDA-AAAA');
    expect(await openVault('TNDA課務每週一中午發', parseVault(text))).toEqual(SECRETS);
  });

  it('密碼錯誤或檔案被改過都會拒絕', async () => {
    const vault = await sealVault('correct horse battery', SECRETS, FAST);
    await expect(openVault('correct horse batterY', vault)).rejects.toBeInstanceOf(WrongPasswordError);
    const tampered = { ...vault, ct: vault.ct.slice(0, -4) + (vault.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
    await expect(openVault('correct horse battery', tampered)).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('同一組密碼每次加密結果都不同（隨機 salt）', async () => {
    const a = await sealVault('correct horse battery', SECRETS, FAST);
    const b = await sealVault('correct horse battery', SECRETS, FAST);
    expect(a.salt).not.toBe(b.salt);
    expect(a.ct).not.toBe(b.ct);
  });

  it('預設使用 60 萬次 PBKDF2，不接受太低的次數', async () => {
    const v = await sealVault('correct horse battery', SECRETS);
    expect(v.iter).toBe(600_000);
    expect(() => parseVault(JSON.stringify({ ...v, iter: 1000 }))).toThrow('格式不正確');
  });

  it('擋掉太弱的密碼', () => {
    expect(passwordProblem('short')).toMatch('至少');
    expect(passwordProblem('0912345678')).toMatch('數字');
    expect(passwordProblem('aaaaaaaaaaaa')).toMatch('同一個字');
    expect(passwordProblem('password1234')).toMatch('常見');
    expect(passwordProblem('TNDA課務每週一中午發')).toBeNull();
    expect(passwordProblem('課務發報台好用嗎好用')).toBeNull();
  });
});
