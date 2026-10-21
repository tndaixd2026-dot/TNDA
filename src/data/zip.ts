// 讀取 .zip（匯入檔＋照片／影片）。只讀需要的部分：先讀檔尾的目錄，
// 檔案內容等到真的要上傳時才解壓，所以很大的壓縮檔也不會一次佔滿記憶體。
// 支援「不壓縮」與 deflate（Windows、macOS、Python 預設的格式），以及 zip64。

export interface ZipEntry {
  /** 壓縮檔裡的路徑，一律用「/」分隔 */
  path: string;
  /** 解壓後的大小 */
  size: number;
  read(): Promise<Uint8Array>;
}

export class ZipError extends Error {}

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** 系統自動產生、不是使用者放進去的檔案 */
export function isJunkPath(path: string): boolean {
  const base = path.split('/').pop() ?? '';
  return path.startsWith('__MACOSX/') || base === '.DS_Store' || base.startsWith('._') || base === 'Thumbs.db' || base === 'desktop.ini';
}

/** 看檔頭判斷是不是 zip */
export async function looksLikeZip(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  return head.length === 4 && view(head).getUint32(0, true) === LOCAL;
}

export async function readZip(blob: Blob): Promise<ZipEntry[]> {
  // 目錄結尾記錄在檔尾 22 bytes 以內，前面最多再加 64 KB 的註解
  const tailStart = Math.max(0, blob.size - 22 - 0xffff);
  const tail = new Uint8Array(await blob.slice(tailStart).arrayBuffer());
  const tv = view(tail);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === EOCD) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new ZipError('這不是有效的 .zip 檔（可能沒有下載完整）。');
  let count = tv.getUint16(at + 10, true);
  let dirSize = tv.getUint32(at + 12, true);
  let dirOffset = tv.getUint32(at + 16, true);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    const locAt = at - 20;
    if (locAt < 0 || tv.getUint32(locAt, true) !== EOCD64_LOCATOR) throw new ZipError('看不懂這個 .zip 的格式。');
    const recAt = num(tv.getBigUint64(locAt + 8, true));
    const rec = view(new Uint8Array(await blob.slice(recAt, recAt + 56).arrayBuffer()));
    if (rec.getUint32(0, true) !== EOCD64) throw new ZipError('看不懂這個 .zip 的格式。');
    count = num(rec.getBigUint64(32, true));
    dirSize = num(rec.getBigUint64(40, true));
    dirOffset = num(rec.getBigUint64(48, true));
  }
  if (dirOffset + dirSize > blob.size) throw new ZipError('這個 .zip 不完整（可能沒有下載完整）。');

  const dir = new Uint8Array(await blob.slice(dirOffset, dirOffset + dirSize).arrayBuffer());
  const dv = view(dir);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > dir.length || dv.getUint32(p, true) !== CENTRAL) throw new ZipError('這個 .zip 的目錄損壞了。');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    let packed = dv.getUint32(p + 20, true);
    let size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let offset = dv.getUint32(p + 42, true);
    const rawName = dir.subarray(p + 46, p + 46 + nameLen);
    const extra = dir.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    p += 46 + nameLen + extraLen + commentLen;

    let unicodeName: string | undefined;
    const ev = view(extra);
    for (let e = 0; e + 4 <= extra.length; ) {
      const id = ev.getUint16(e, true);
      const len = ev.getUint16(e + 2, true);
      const body = e + 4;
      if (id === 0x0001) {
        // zip64：只有原本欄位是 0xFFFFFFFF 的才會出現在這裡，順序固定
        let q = body;
        if (size === 0xffffffff) {
          size = num(ev.getBigUint64(q, true));
          q += 8;
        }
        if (packed === 0xffffffff) {
          packed = num(ev.getBigUint64(q, true));
          q += 8;
        }
        if (offset === 0xffffffff) offset = num(ev.getBigUint64(q, true));
      } else if (id === 0x7075 && len > 5) {
        // Info-ZIP 的 UTF-8 檔名
        unicodeName = new TextDecoder().decode(extra.subarray(body + 5, body + len));
      }
      e = body + len;
    }

    const path = normalizePath(flags & 0x800 ? new TextDecoder().decode(rawName) : unicodeName ?? decodeName(rawName));
    if (!path || path.endsWith('/') || isJunkPath(path)) continue;
    if (flags & 0x1) throw new ZipError(`壓縮檔有設定密碼（${path}），請改用沒有密碼的壓縮檔。`);
    if (method !== 0 && method !== 8) throw new ZipError(`「${path}」用了不支援的壓縮方式，請用系統內建的「壓縮」重新打包。`);
    entries.push({ path, size, read: () => readEntry(blob, { path, method, crc, packed, size, offset }) });
  }
  return entries;
}

async function readEntry(blob: Blob, e: { path: string; method: number; crc: number; packed: number; size: number; offset: number }): Promise<Uint8Array> {
  const head = view(new Uint8Array(await blob.slice(e.offset, e.offset + 30).arrayBuffer()));
  if (head.byteLength < 30 || head.getUint32(0, true) !== LOCAL) throw new ZipError(`「${e.path}」損壞了，讀不出來。`);
  const start = e.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  const raw = blob.slice(start, start + e.packed);
  let out: Uint8Array;
  if (e.method === 0) out = new Uint8Array(await raw.arrayBuffer());
  else {
    try {
      out = await inflate(raw, e.size);
    } catch (err) {
      if (err instanceof ZipError) throw err;
      throw new ZipError(`「${e.path}」解壓縮失敗，檔案可能損壞了。`);
    }
  }
  if (out.length !== e.size || crc32(out) !== e.crc) throw new ZipError(`「${e.path}」內容不完整或損壞了。`);
  return out;
}

/** 解壓到宣告的大小為止；超過就停（避免被灌爆記憶體） */
async function inflate(raw: Blob, size: number): Promise<Uint8Array> {
  const reader = raw.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const out = new Uint8Array(size);
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > size) {
      await reader.cancel();
      throw new ZipError('檔案內容比壓縮檔記錄的大，可能損壞了。');
    }
    out.set(value, n);
    n += value.length;
  }
  return n === size ? out : out.subarray(0, n);
}

/** 沒有標示 UTF-8 的舊格式：macOS 其實是 UTF-8，繁中 Windows 則是 Big5 */
function decodeName(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('big5').decode(bytes);
    } catch {
      return new TextDecoder().decode(bytes);
    }
  }
}

export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.normalize('NFC').replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/') + (/[/\\]$/.test(path) ? '/' : '');
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

function num(n: bigint): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('這個 .zip 太大了。');
  return Number(n);
}

let table: Uint32Array | undefined;
export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
