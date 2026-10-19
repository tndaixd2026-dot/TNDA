import { useState } from 'preact/hooks';
import { acceptLink, beginSetup, connectGitHub, disconnect, loginWithPassword, rejectLink, startDemo, useApp } from '../data/store.ts';
import { BrandMark, Icon } from '../ui/icons.tsx';
import { Btn } from '../ui/kit.tsx';

function PasswordLogin() {
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: Event) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    const problem = await loginWithPassword(password, remember);
    setBusy(false);
    if (problem) setError(problem);
  }
  return (
    <form class="pw-login stack" onSubmit={(e) => void submit(e)}>
      <div class="field">
        <label for="login-pw">
          <Icon name="lock" style={{ width: 15, height: 15, verticalAlign: '-2px' }} /> 用密碼登入
        </label>
        <div class="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
          <input
            id="login-pw"
            class="input"
            type="password"
            autocomplete="current-password"
            value={password}
            onInput={(e) => {
              setPassword((e.currentTarget as HTMLInputElement).value);
              setError('');
            }}
            style={{ flex: 1, minWidth: 0 }}
          />
          <Btn type="submit" variant="primary" icon="right" busy={busy} disabled={!password}>
            登入
          </Btn>
        </div>
      </div>
      <label class="row small" style={{ gap: 8, cursor: 'pointer' }}>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember((e.currentTarget as HTMLInputElement).checked)} />
        記住這台裝置（公用電腦請取消，關掉瀏覽器就會登出）
      </label>
      {busy ? <p class="small muted">正在解開登入資料…</p> : null}
      {error ? (
        <div class="callout callout-bad" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </div>
      ) : null}
    </form>
  );
}

function Postmark() {
  return (
    <svg class="postmark" viewBox="0 0 200 200" aria-hidden="true">
      <circle cx="100" cy="100" r="90" fill="none" stroke="currentColor" stroke-width="5" />
      <circle cx="100" cy="100" r="66" fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="6 6" />
      <text x="100" y="92" text-anchor="middle" font-size="22" font-family="var(--font-mono)" fill="currentColor" font-weight="700">
        TNDA
      </text>
      <text x="100" y="120" text-anchor="middle" font-size="16" font-family="var(--font-mono)" fill="currentColor">
        RELAY
      </text>
    </svg>
  );
}

export function Welcome() {
  return (
    <div class="welcome">
      <section class="welcome-art">
        <div class="row" style={{ gap: 12 }}>
          <svg viewBox="0 0 40 40" width="44" height="44" aria-hidden="true">
            <circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" stroke-width="2" />
            <path d="M15.5 27V13h5.5a4 4 0 0 1 0 8h-5.5M21 21l4.5 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.14em', fontSize: 13 }}>TNDA RELAY</span>
        </div>
        <h1>
          課務發報台
          <br />
          貼上公告，準時送到每個 Discord 頻道
        </h1>
        <p>把上課提醒、作業截止、補課通知隨手貼上，系統自動整理成整齊的 Discord 卡片，排好時間就交給它。資料加密存在你自己的 GitHub，全程免費。</p>
        <div class="flow">
          {[
            ['貼上', '老師的原始文字，日期、地點、連結自動辨識'],
            ['整理', '轉成 Discord 卡片，倒數時間由 Discord 即時更新'],
            ['排程', '選頻道與時間，也可以一次建立多次提醒'],
            ['發送', 'GitHub Actions 每 5 分鐘檢查，準時送出並留下紀錄'],
          ].map(([t, d], i) => (
            <div key={t} class="flow-step">
              <span class="n">{i + 1}</span>
              <span>
                <b>{t}</b>
                <span>{d}</span>
              </span>
            </div>
          ))}
        </div>
        <Postmark />
      </section>
      <section class="welcome-panel">
        <h2 style={{ fontSize: 22 }}>開始使用</h2>
        <PasswordLogin />
        <div class="or-divider" role="separator">
          <span>或</span>
        </div>
        <button type="button" class="choice" onClick={beginSetup}>
          <span class="c-icon">
            <Icon name="branch" />
          </span>
          <span>
            <b>連接我的 GitHub</b>
            <span>正式使用：資料加密同步到 repo，排程器自動發到 Discord。第一次大約 5 分鐘設定。</span>
          </span>
          <Icon name="right" />
        </button>
        <button type="button" class="choice" onClick={() => void startDemo()}>
          <span class="c-icon">
            <Icon name="play" />
          </span>
          <span>
            <b>先看看 Demo</b>
            <span>用範例資料體驗所有功能，不會真的發到 Discord。</span>
          </span>
          <Icon name="right" />
        </button>
        <button type="button" class="choice" onClick={beginSetup}>
          <span class="c-icon">
            <Icon name="phone" />
          </span>
          <span>
            <b>用 Token 與同步金鑰登入</b>
            <span>還沒設定登入密碼、或忘記密碼時使用；也可以在已登入的裝置用「連結其他裝置」掃描 QR Code。</span>
          </span>
          <Icon name="right" />
        </button>
        <p class="small faint" style={{ marginTop: 8 }}>
          <Icon name="lock" style={{ width: 14, height: 14, verticalAlign: '-2px' }} /> Token 與同步金鑰只存在這台裝置的瀏覽器裡，不會傳到任何第三方伺服器。
        </p>
      </section>
    </div>
  );
}

export function Loader() {
  return (
    <div class="center-screen">
      <div class="loader">
        <BrandMark />
        <span>正在同步資料…</span>
      </div>
    </div>
  );
}

export function LinkConfirm() {
  const offer = useApp((s) => s.linkOffer);
  if (!offer) return null;
  return (
    <div class="center-screen">
      <div class="card card-pad stack" style={{ maxWidth: 480 }}>
        <div class="row">
          <BrandMark />
          <h1 style={{ fontSize: 20 }}>連結這台裝置？</h1>
        </div>
        <p class="muted">
          這個連結會把 <b>{offer.owner}/{offer.repo}</b> 的發文資料同步到這台裝置。只在你自己的裝置上使用。
        </p>
        <div class="row" style={{ justifyContent: 'flex-end' }}>
          <Btn onClick={rejectLink}>取消</Btn>
          <Btn variant="primary" icon="check" onClick={() => void acceptLink()}>
            連結並開始使用
          </Btn>
        </div>
      </div>
    </div>
  );
}

export function ErrorScreen() {
  const error = useApp((s) => s.error);
  return (
    <div class="center-screen">
      <div class="card card-pad stack" style={{ maxWidth: 520 }}>
        <div class="row">
          <span class="d-icon bad" style={{ width: 34, height: 34, borderRadius: '50%', display: 'grid', placeItems: 'center' }}>
            <Icon name="alert" />
          </span>
          <h1 style={{ fontSize: 20 }}>{error?.title ?? '發生錯誤'}</h1>
        </div>
        <p class="muted">{error?.detail}</p>
        <div class="row" style={{ justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={() => void disconnect()}>
            清除設定，重新開始
          </Btn>
          {error?.kind === 'branch' || error?.kind === 'key' || error?.kind === 'token' ? (
            <Btn onClick={beginSetup}>重新設定</Btn>
          ) : null}
          <Btn variant="primary" icon="refresh" onClick={() => void connectGitHub()}>
            再試一次
          </Btn>
        </div>
      </div>
    </div>
  );
}
