// 排程器的本機快取：Actions 先用 git 取出資料分支，排程器直接讀檔，
// 不必每個檔案都呼叫一次 GitHub API（GITHUB_TOKEN 每小時只有 1000 次）。
// 以 git blob sha 當 key，所以檔案若在取出後被改過，sha 對不上就會改走 API，不會讀到舊資料。

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryBlobCache } from '../src/core/repo.ts';

/** 與 git 相同的 blob sha：sha1("blob <長度>\0" + 內容) */
export function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** 把資料夾裡的檔案（不含 .git）依 blob sha 放進快取；資料夾不存在時回傳空快取 */
export async function blobCacheFromDir(dir: string): Promise<{ cache: MemoryBlobCache; files: number }> {
  const cache = new MemoryBlobCache();
  let files = 0;
  const walk = async (path: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const full = join(path, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const bytes = await readFile(full);
        await cache.set(gitBlobSha(bytes), bytes.toString('utf8'));
        files++;
      }
    }
  };
  await walk(dir);
  return { cache, files };
}
