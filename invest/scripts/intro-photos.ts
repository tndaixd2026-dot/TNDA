// 準備學生登入頁進場動畫的照片。
//
//   node scripts/intro-photos.ts <照片資料夾> [--count 50] [--upload]
//
// 1. 依檔名排序讀取 JPG／PNG／WebP（要照時間順序就用日期開頭命名）；超過 --count 張就平均挑選
// 2. 用 ffmpeg 轉正方向、置中裁成 4:5、縮成 540×675 的 WebP（每張約 20–40 KB），
//    存到 public/intro/001.webp…，並產生 manifest.json（本機版直接讀這裡；不進 git）
// 3. 加 --upload：上傳到 Supabase Storage 的公開 bucket「intro」（正式版讀這裡，換照片不用重新部署）
//    需要環境變數 SUPABASE_SERVICE_ROLE_KEY（Supabase 後台 Project Settings → API Keys 的 secret／service_role key；
//    只在自己電腦上用，不要放進 git）
//
// 需要先安裝 ffmpeg。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'public', 'intro');
const BUCKET = 'intro';
const W = 540;
const H = 675;

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith('--'));
const countArg = args.indexOf('--count');
const count = countArg >= 0 ? Number(args[countArg + 1]) : 50;
const upload = args.includes('--upload');

if (!src) {
  console.error('用法：node scripts/intro-photos.ts <照片資料夾> [--count 50] [--upload]');
  process.exit(1);
}

const files = readdirSync(src)
  .filter((f) => /\.(jpe?g|png|webp)$/i.test(f) && statSync(join(src, f)).isFile())
  .sort((a, b) => a.localeCompare(b, 'zh-Hant', { numeric: true }));
if (files.length === 0) {
  console.error(`在 ${src} 找不到 JPG／PNG／WebP 照片（iPhone 的 HEIC 請先轉成 JPG）`);
  process.exit(1);
}

// 平均挑選：保留頭尾，中間等距
const picked =
  files.length <= count ? files : Array.from({ length: count }, (_, i) => files[Math.round((i * (files.length - 1)) / (count - 1))]);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const names: string[] = [];
let bytes = 0;
picked.forEach((f, i) => {
  const name = `${String(i + 1).padStart(3, '0')}.webp`;
  execFileSync(
    'ffmpeg',
    [
      '-loglevel', 'error', '-y',
      '-i', join(src, f),
      '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`,
      '-frames:v', '1',
      '-c:v', 'libwebp', '-quality', '62', '-compression_level', '6',
      '-map_metadata', '-1',
      join(OUT, name),
    ],
    { stdio: 'inherit' },
  );
  bytes += statSync(join(OUT, name)).size;
  names.push(name);
});
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ photos: names }, null, 2) + '\n');
console.log(`已處理 ${names.length} 張（來源 ${files.length} 張），共 ${(bytes / 1024 / 1024).toFixed(2)} MB → ${OUT}`);
console.log(`播放時間約 ${(names.length * 0.1).toFixed(1)} 秒`);

if (upload) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error('要上傳請設定環境變數 SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  const deploy = JSON.parse(readFileSync(join(root, 'deploy.config.json'), 'utf8')) as { supabaseUrl: string };
  const base = deploy.supabaseUrl.replace(/\/+$/, '');
  const auth = { apikey: key, authorization: `Bearer ${key}` };

  // 建立公開 bucket（已存在就略過）
  const mk = await fetch(`${base}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true, allowed_mime_types: ['image/webp', 'application/json'] }),
  });
  if (!mk.ok && mk.status !== 409) {
    const text = await mk.text();
    if (!/already exists/i.test(text)) throw new Error(`建立 bucket 失敗：${mk.status} ${text}`);
  }

  const put = async (name: string, type: string, cache: string) => {
    const res = await fetch(`${base}/storage/v1/object/${BUCKET}/${name}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': type, 'x-upsert': 'true', 'cache-control': cache },
      body: readFileSync(join(OUT, name)),
    });
    if (!res.ok) throw new Error(`上傳 ${name} 失敗：${res.status} ${await res.text()}`);
  };
  for (const n of names) await put(n, 'image/webp', 'max-age=3600');
  // manifest 最後才傳，快取時間短：換照片後一分鐘內生效
  await put('manifest.json', 'application/json', 'max-age=60');
  console.log(`已上傳到 ${base}/storage/v1/object/public/${BUCKET}/（${names.length} 張＋manifest.json）`);
  if (extname(names[0]) !== '.webp') console.warn('注意：檔名不是 .webp');
}
