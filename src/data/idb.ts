// 以 IndexedDB 快取加密檔案（依 blob sha，內容不會變），重新整理時不用重新下載全部貼文。

import type { BlobCache } from '../core/repo.ts';
import { MemoryBlobCache } from '../core/repo.ts';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tnda-relay', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('blobs');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IdbBlobCache implements BlobCache {
  private db: Promise<IDBDatabase | null>;
  private mem = new MemoryBlobCache();

  constructor() {
    this.db = typeof indexedDB === 'undefined' ? Promise.resolve(null) : open().catch(() => null);
  }

  async get(sha: string): Promise<string | undefined> {
    const hit = await this.mem.get(sha);
    if (hit !== undefined) return hit;
    const db = await this.db;
    if (!db) return undefined;
    return new Promise((resolve) => {
      try {
        const req = db.transaction('blobs').objectStore('blobs').get(sha);
        req.onsuccess = () => resolve(req.result as string | undefined);
        req.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  }

  async set(sha: string, text: string): Promise<void> {
    await this.mem.set(sha, text);
    const db = await this.db;
    if (!db) return;
    try {
      db.transaction('blobs', 'readwrite').objectStore('blobs').put(text, sha);
    } catch {
      /* 快取失敗不影響功能 */
    }
  }

  static async clear(): Promise<void> {
    if (typeof indexedDB === 'undefined') return;
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('tnda-relay');
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  }
}
