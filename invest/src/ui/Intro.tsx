// 學生登入頁的進場動畫：過去一年的活動照片快速閃過（每張 0.1 秒），最後收在「LIVE MARKET」。
//
// 照片來源：`${INTRO_BASE}manifest.json`，格式 { "photos": ["001.webp", …] }，路徑相對於 manifest。
// - 正式版：Supabase Storage 的公開 bucket（照片不進 git，換照片不用重新部署）
// - 本機版：invest/public/intro/（不進 git）
// 沒有照片時改播一段只有文字的短版，不會整個畫面黑白閃爍。
//
// 安全與體驗：
// - 先把照片下載、解碼好才開始播，播放中不會卡住或閃白；網路太慢（4 秒）就用已載入的照片
// - 隨時可以點「SKIP」或點畫面跳過；每個分頁只播一次
// - 系統設定「減少動態效果」時不播（快速閃爍的畫面可能讓光敏感的人不適）
// - 照片放在畫面中間的視窗框裡，不是整個螢幕閃
import { useEffect, useRef, useState } from 'preact/hooks';
import { reducedMotion } from './motion.ts';
import { Sparkle, WinBar } from './y2k.tsx';

const INTRO_BASE = import.meta.env.VITE_INTRO_PHOTOS ?? '';
const FRAME_MS = 100;
const LOAD_DEADLINE_MS = 4000;
const SEEN_KEY = 'invest.introSeen';

const WORDS = ['TNDA', '2026', 'NEXT D', 'PITCH', 'DEMO', 'CREW', 'IDEA', 'BUILD', 'SHIP', 'VOTE', 'INVEST', 'LIVE', 'MARKET'];

export function shouldPlayIntro(): boolean {
  const q = new URLSearchParams(location.search).get('intro');
  if (q === '0') return false;
  if (q === '1') return true;
  if (reducedMotion()) return false;
  try {
    return sessionStorage.getItem(SEEN_KEY) !== '1';
  } catch {
    return true;
  }
}

function markSeen() {
  try {
    sessionStorage.setItem(SEEN_KEY, '1');
  } catch {
    // 私密瀏覽：下次再播一次也沒關係
  }
}

async function loadManifest(signal: AbortSignal): Promise<string[]> {
  if (!INTRO_BASE) return [];
  const base = new URL(INTRO_BASE, location.href);
  const res = await fetch(new URL('manifest.json', base), { signal, cache: 'no-cache' });
  if (!res.ok) return [];
  const data = (await res.json()) as { photos?: unknown };
  if (!Array.isArray(data.photos)) return [];
  return data.photos.filter((p): p is string => typeof p === 'string').map((p) => new URL(p, base).href);
}

function preload(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      // decode() 讓第一次顯示時不用再解碼，0.1 秒切換才會順
      (img.decode ? img.decode() : Promise.resolve()).then(
        () => resolve(url),
        () => resolve(url),
      );
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

type Stage = 'loading' | 'flash' | 'title' | 'out';

export function Intro({ onDone }: { onDone: () => void }) {
  const [stage, setStage] = useState<Stage>('loading');
  const [photos, setPhotos] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(0);
  const [total, setTotal] = useState(0);
  const [frame, setFrame] = useState(0);
  const done = useRef(false);

  function finish() {
    if (done.current) return;
    done.current = true;
    markSeen();
    setStage('out');
    setTimeout(onDone, 550);
  }

  // 1. 載入照片
  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;
    (async () => {
      let urls: string[] = [];
      try {
        urls = await Promise.race([
          loadManifest(ctrl.signal),
          new Promise<string[]>((r) => setTimeout(() => r([]), 2500)),
        ]);
      } catch {
        urls = [];
      }
      if (cancelled) return;
      setTotal(urls.length);
      const ok: (string | null)[] = new Array(urls.length).fill(null);
      let count = 0;
      const all = Promise.all(
        urls.map((u, i) =>
          preload(u).then((r) => {
            ok[i] = r;
            if (r) setLoaded(++count);
          }),
        ),
      );
      await Promise.race([all, new Promise((r) => setTimeout(r, urls.length ? LOAD_DEADLINE_MS : 0))]);
      if (cancelled) return;
      const ready = ok.filter((u): u is string => !!u);
      setPhotos(ready);
      setStage('flash');
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, []);

  // 2. 快速閃過：以實際經過的時間決定第幾張，掉幀也不會拖慢
  const frames = photos.length >= 5 ? photos.length : WORDS.length;
  useEffect(() => {
    if (stage !== 'flash') return;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const i = Math.floor((t - start) / FRAME_MS);
      if (i >= frames) {
        setStage('title');
        return;
      }
      setFrame(i);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stage, frames]);

  // 3. 標題停一下就淡出
  useEffect(() => {
    if (stage !== 'title') return;
    const id = setTimeout(finish, 1100);
    return () => clearTimeout(id);
  }, [stage]);

  const usePhotos = photos.length >= 5;
  const counter = `${String(Math.min(frame + 1, frames)).padStart(3, '0')}/${String(frames).padStart(3, '0')}`;
  const pct = stage === 'loading' ? (total ? loaded / total : 0) : stage === 'flash' ? (frame + 1) / frames : 1;
  const blocks = 12;

  return (
    <div class={`intro intro-${stage}`} onClick={finish} role="presentation">
      <Sparkle class="intro-spark s1" size={34} color="#fff" />
      <Sparkle class="intro-spark s2" size={22} color="#000" />
      <Sparkle class="intro-spark s3" size={16} color="#fff" />
      <div class="intro-window">
        <WinBar title={stage === 'loading' ? 'LOADING…' : usePhotos ? 'MEMORIES_2026.EXE' : 'LIVE_MARKET.EXE'} />
        <div class="intro-stage">
          {stage === 'loading' && (
            <div class="intro-loading">
              <Sparkle size={40} color="var(--tnda-orange)" class="spin" />
              <span>{total ? `LOADING ${loaded}/${total}` : 'LOADING'}</span>
            </div>
          )}
          {stage === 'flash' &&
            (usePhotos ? (
              photos.map((src, i) => (
                <img key={src} src={src} alt="" class={`intro-photo${i === frame ? ' on' : ''}`} draggable={false} />
              ))
            ) : (
              <div class="intro-word">{WORDS[frame]}</div>
            ))}
          {(stage === 'title' || stage === 'out') && (
            <div class="intro-title">
              <Sparkle size={44} color="var(--tnda-orange)" class="pop" />
              <span class="display">Live Market</span>
              <span class="intro-title-zh">即時投資</span>
            </div>
          )}
        </div>
        <div class="intro-foot">
          <span class="intro-counter">{stage === 'flash' ? counter : stage === 'loading' ? 'PLEASE WAIT' : 'READY'}</span>
          <span class="intro-bar" aria-hidden="true">
            {Array.from({ length: blocks }, (_, i) => (
              <i key={i} class={i < Math.round(pct * blocks) ? 'on' : ''} />
            ))}
          </span>
        </div>
      </div>
      <button
        type="button"
        class="intro-skip"
        onClick={(e) => {
          e.stopPropagation();
          finish();
        }}
      >
        Skip →
      </button>
    </div>
  );
}
