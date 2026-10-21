// 測試用：產生 .zip（可選擇壓縮方式、檔名編碼、zip64），模擬各種系統打包出來的檔案。

import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../src/data/zip.ts';

export interface ZipInput {
  name: string;
  data: Uint8Array | string;
  /** 0 不壓縮、8 deflate */
  method?: 0 | 8;
  /** 檔名的原始位元組（例如 Big5），不設定 UTF-8 旗標 */
  rawName?: Uint8Array;
  encrypted?: boolean;
}

export function makeZip(inputs: ZipInput[], opts: { zip64?: boolean; comment?: string } = {}): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of inputs) {
    const data = typeof f.data === 'string' ? Buffer.from(f.data) : Buffer.from(f.data);
    const method = f.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = f.rawName ? Buffer.from(f.rawName) : Buffer.from(f.name);
    const flags = (f.rawName ? 0 : 0x800) | (f.encrypted ? 1 : 0);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const extra = opts.zip64 ? Buffer.alloc(4 + 24) : Buffer.alloc(0);
    if (opts.zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(data.length), 4);
      extra.writeBigUInt64LE(BigInt(body.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(opts.zip64 ? 0xffffffff : body.length, 20);
    c.writeUInt32LE(opts.zip64 ? 0xffffffff : data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(extra.length, 30);
    c.writeUInt32LE(opts.zip64 ? 0xffffffff : offset, 42);
    centrals.push(c, name, extra);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const parts = [...locals, dir];
  const comment = Buffer.from(opts.comment ?? '');
  if (opts.zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeBigUInt64LE(BigInt(inputs.length), 24);
    rec.writeBigUInt64LE(BigInt(inputs.length), 32);
    rec.writeBigUInt64LE(BigInt(dir.length), 40);
    rec.writeBigUInt64LE(BigInt(offset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(offset + dir.length), 8);
    loc.writeUInt32LE(1, 16);
    parts.push(rec, loc);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(opts.zip64 ? 0xffff : inputs.length, 8);
  end.writeUInt16LE(opts.zip64 ? 0xffff : inputs.length, 10);
  end.writeUInt32LE(opts.zip64 ? 0xffffffff : dir.length, 12);
  end.writeUInt32LE(opts.zip64 ? 0xffffffff : offset, 16);
  end.writeUInt16LE(comment.length, 20);
  parts.push(end, comment);
  return new Uint8Array(Buffer.concat(parts));
}
