import { describe, expect, it } from 'vitest';
import { ZipError, crc32, readZip } from '../src/data/zip.ts';
import { ImportError, loadImportFiles, parseImportBundle } from '../src/data/importer.ts';
import { makeZip } from './zipfile.ts';

const bytes = (n: number, seed = 1) => new Uint8Array(n).map((_, i) => (i * 31 + seed) % 256);
const blob = (b: Uint8Array) => new Blob([b as BlobPart]);
const file = (name: string, data: Uint8Array | string, type = '') => new File([data as BlobPart], name, { type });

const manifest = (attachments: unknown[]) =>
  JSON.stringify({ tnda: 'import', v: 1, name: '測試', posts: [{ title: 't', at: '2026-12-01T12:00:00+08:00', to: [{ group: '互動學程', channel: '公告欄' }], content: '參訪', attachments }] });

describe('讀取 .zip', () => {
  it('不壓縮與 deflate 的檔案都讀得出來，內容與原檔相同', async () => {
    const video = bytes(200_000);
    const entries = await readZip(blob(makeZip([{ name: 'posts.json', data: '{}' }, { name: 'media/影片.mp4', data: video, method: 0 }, { name: 'media/01.png', data: bytes(5000, 7) }])));
    expect(entries.map((e) => [e.path, e.size])).toEqual([
      ['posts.json', 2],
      ['media/影片.mp4', 200_000],
      ['media/01.png', 5000],
    ]);
    expect(await entries[1].read()).toEqual(video);
    expect(await entries[2].read()).toEqual(bytes(5000, 7));
  });

  it('略過資料夾與 macOS／Windows 自動產生的檔案', async () => {
    const zip = makeZip([
      { name: 'TNDA/', data: '' },
      { name: 'TNDA/posts.json', data: '{}' },
      { name: '__MACOSX/TNDA/._posts.json', data: 'x' },
      { name: 'TNDA/.DS_Store', data: 'x' },
      { name: 'TNDA/Thumbs.db', data: 'x' },
    ]);
    expect((await readZip(blob(zip))).map((e) => e.path)).toEqual(['TNDA/posts.json']);
  });

  it('沒有標示 UTF-8 的中文檔名：繁中 Windows 的 Big5 也認得', async () => {
    const big5 = new Uint8Array([188, 118, 164, 249, 47, 166, 230, 181, 123, 46, 112, 110, 103]);
    const utf8 = new TextEncoder().encode('影片/行程.png');
    const entries = await readZip(blob(makeZip([{ name: '', rawName: big5, data: 'a' }, { name: '', rawName: utf8, data: 'b' }])));
    expect(entries.map((e) => e.path)).toEqual(['影片/行程.png', '影片/行程.png']);
  });

  it('zip64 格式與檔尾註解', async () => {
    const entries = await readZip(blob(makeZip([{ name: 'a.bin', data: bytes(3000) }], { zip64: true, comment: '備註' })));
    expect(entries[0].size).toBe(3000);
    expect(await entries[0].read()).toEqual(bytes(3000));
  });

  it('有密碼、不是 zip、內容損壞時說明原因', async () => {
    await expect(readZip(blob(makeZip([{ name: 'a.txt', data: 'x', encrypted: true }])))).rejects.toThrow('密碼');
    await expect(readZip(blob(new TextEncoder().encode('not a zip at all, just text')))).rejects.toThrow(ZipError);
    const zip = makeZip([{ name: 'a.bin', data: bytes(4000), method: 0 }]);
    zip[30 + 5 + 100] ^= 0xff;
    const [entry] = await readZip(blob(zip));
    await expect(entry.read()).rejects.toThrow('損壞');
  });

  it('CRC32 與標準值相同', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('匯入 .zip／多個檔案', () => {
  it('.zip：posts.json 引用同一包裡的照片與影片，路徑相對於 posts.json', async () => {
    const png = bytes(800, 3);
    const mp4 = bytes(150_000, 9);
    const zip = makeZip([
      { name: 'TNDA-匯入/posts.json', data: manifest(['media/01.png', { file: 'media/demo.mp4', name: '02-示範影片.mp4' }]) },
      { name: 'TNDA-匯入/media/01.png', data: png },
      { name: 'TNDA-匯入/media/demo.mp4', data: mp4, method: 0 },
    ]);
    const src = await loadImportFiles([file('TNDA-匯入.zip', zip)]);
    expect(src.base).toBe('TNDA-匯入');
    const [a, b] = parseImportBundle(src.text, src.files, src.base).posts[0].attachments!;
    expect(a).toMatchObject({ name: '01.png', type: 'image/png', size: 800 });
    expect(b).toMatchObject({ name: '02-示範影片.mp4', type: 'video/mp4', size: 150_000 });
    expect(await a.source.read()).toEqual(png);
    expect(await b.source.read()).toEqual(mp4);
  });

  it('同一個檔案被多則貼文引用時是同一個來源（只上傳一次）', async () => {
    const zip = makeZip([
      { name: 'posts.json', data: JSON.stringify({ tnda: 'import', posts: [0, 1].map((i) => ({ at: '2026-12-01T12:00:00+08:00', to: [{ id: 'a' }], content: `第${i}則`, attachments: ['海報.png'] })) }) },
      { name: '海報.png', data: bytes(10) },
    ]);
    const src = await loadImportFiles([file('a.zip', zip)]);
    const posts = parseImportBundle(src.text, src.files, src.base).posts;
    expect(posts[0].attachments![0].source).toBe(posts[1].attachments![0].source);
  });

  it('找不到 posts.json 時，用內容是匯入檔的 .json', async () => {
    const zip = makeZip([{ name: 'notes.json', data: '{"a":1}' }, { name: '12-17 參訪.json', data: manifest([]) }]);
    const src = await loadImportFiles([file('a.zip', zip)]);
    expect(parseImportBundle(src.text).name).toBe('測試');
    await expect(loadImportFiles([file('b.zip', makeZip([{ name: 'a.png', data: 'x' }]))])).rejects.toThrow('posts.json');
  });

  it('.json 加上照片一起選取，用檔名對應（資料夾不同也可以）', async () => {
    const src = await loadImportFiles([file('posts.json', manifest(['media/01.png', 'clip.mov'])), file('01.png', bytes(20), 'image/png'), file('clip.mov', bytes(30), 'video/quicktime')]);
    const files = parseImportBundle(src.text, src.files, src.base).posts[0].attachments!;
    expect(files.map((f) => [f.name, f.type, f.size])).toEqual([
      ['01.png', 'image/png', 20],
      ['clip.mov', 'video/quicktime', 30],
    ]);
  });

  it('缺檔案、多選了 .zip、多個 .json 時說明原因', async () => {
    const src = await loadImportFiles([file('posts.json', manifest(['01.png']))]);
    expect(() => parseImportBundle(src.text, src.files, src.base)).toThrow('同一個 .zip');
    const withOther = await loadImportFiles([file('posts.json', manifest(['01.png'])), file('02.png', 'x')]);
    expect(() => parseImportBundle(withOther.text, withOther.files)).toThrow('找不到檔案「01.png」');
    await expect(loadImportFiles([file('a.zip', makeZip([])), file('b.png', 'x')])).rejects.toThrow('只選那一個');
    await expect(loadImportFiles([file('a.json', '{}'), file('b.json', '{}')])).rejects.toThrow('一個匯入檔');
    await expect(loadImportFiles([file('a.png', 'x')])).rejects.toThrow(ImportError);
  });

  it('.json 加上 .pptx 不會被誤認成 .zip', async () => {
    const pptx = makeZip([{ name: '[Content_Types].xml', data: '<x/>' }]);
    const src = await loadImportFiles([file('posts.json', manifest(['簡報.pptx'])), file('簡報.pptx', pptx)]);
    const [f] = parseImportBundle(src.text, src.files).posts[0].attachments!;
    expect(f.type).toMatch('presentation');
    expect(await f.source.read()).toEqual(pptx);
  });

  it('只選一個 .json 仍然可以（沒有附檔，或附檔是 base64）', async () => {
    const src = await loadImportFiles([file('posts.json', manifest([]))]);
    expect(parseImportBundle(src.text, src.files).posts).toHaveLength(1);
  });
});
