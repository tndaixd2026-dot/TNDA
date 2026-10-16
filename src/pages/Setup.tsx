// 初始設定精靈：連接 GitHub → 建立加密資料空間 → 匯入頻道 → 測試發送。

import { useMemo, useState } from 'preact/hooks';
import type { Channel } from '../core/types.ts';
import { generateSyncKey, normalizeSyncKey } from '../core/crypto.ts';
import { mergeChannels, parseWebhookBlock } from '../core/channels.ts';
import { GitHubDataRepo, SECRET_NAME } from '../core/repo.ts';
import { executeWebhook } from '../core/discord.ts';
import { backToWelcome, connectGitHub, updateConfig, useApp } from '../data/store.ts';
import { checkSyncKey, checkToken, createDataSpace, makeClient, storeSyncKeySecret, tokenCreateUrl, type TokenCheck } from '../data/setup.ts';
import { Btn, copyText, downloadText } from '../ui/kit.tsx';
import { BrandMark, Icon } from '../ui/icons.tsx';
import { KIND_LABEL } from './Channels.tsx';

type Step = 'repo' | 'data' | 'channels' | 'test' | 'done';
const STEPS: Array<[Step, string]> = [
  ['repo', '連接 GitHub'],
  ['data', '加密資料空間'],
  ['channels', '匯入頻道'],
  ['test', '測試發送'],
  ['done', '完成'],
];

export function Setup() {
  const config = useApp((s) => s.config);
  const [step, setStep] = useState<Step>('repo');
  const [owner, setOwner] = useState(config.owner);
  const [repo, setRepo] = useState(config.repo);
  const [token, setToken] = useState(config.token);
  const [check, setCheck] = useState<TokenCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newKey] = useState(() => generateSyncKey());
  const [existingKey, setExistingKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [secretState, setSecretState] = useState<'ok' | 'manual' | null>(null);
  const [syncKey, setSyncKey] = useState('');
  const [importText, setImportText] = useState('');
  const [channels, setChannels] = useState<Channel[]>([]);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const client = useMemo(() => makeClient(owner, repo, token), [owner, repo, token]);
  const idx = STEPS.findIndex(([s]) => s === step);

  async function guard(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const finish = () => {
    updateConfig({ mode: 'github', owner: owner.trim(), repo: repo.trim(), token: token.trim(), syncKey });
    void connectGitHub();
  };

  const parsed = importText.trim() ? parseWebhookBlock(importText, channels) : null;
  const testChannel = channels.find((c) => c.audience === 'test' && c.webhook) ?? channels.find((c) => c.webhook);

  return (
    <div class="wizard">
      <div class="row">
        <BrandMark />
        <div style={{ flex: 1 }}>
          <div class="eyebrow">初始設定</div>
          <h1 class="page-title" style={{ fontSize: 26 }}>
            連接你的 GitHub
          </h1>
        </div>
        <Btn variant="ghost" icon="left" onClick={backToWelcome}>
          返回
        </Btn>
      </div>
      <div class="steps" aria-label="設定步驟">
        {STEPS.map(([s, label], i) => (
          <div key={s} class={`s ${i === idx ? 'on' : i < idx ? 'done' : ''}`}>
            {i + 1}. {label}
          </div>
        ))}
      </div>

      {error ? (
        <div class="callout callout-bad" style={{ marginBottom: 14 }}>
          <Icon name="alert" />
          <span>{error}</span>
        </div>
      ) : null}

      {step === 'repo' ? (
        <section class="card card-pad stack">
          <p class="muted">
            網站會用一組只限這個 repo 的 <b>GitHub Token</b> 讀寫加密資料、設定排程器。Token 只存在這台裝置的瀏覽器。
          </p>
          <ol class="ol">
            <li>
              打開{' '}
              <a href={tokenCreateUrl(owner, repo)} target="_blank" rel="noopener noreferrer">
                建立 Fine-grained Token 頁面 <Icon name="external" style={{ width: 13, height: 13, verticalAlign: '-1px' }} />
              </a>
              （已盡量幫你預填）。
            </li>
            <li>
              Repository access 選「Only select repositories」，選擇 <code class="inline">{owner}/{repo}</code>。
            </li>
            <li>Repository permissions 設定以下三項（Metadata 會自動加入）：</li>
          </ol>
          <div class="perm-table">
            <b>Contents</b>
            <span>Read and write（讀寫加密的排程資料）</span>
            <b>Secrets</b>
            <span>Read and write（把同步金鑰交給排程器，只需要第一次）</span>
            <b>Actions</b>
            <span>Read and write（查看排程器狀態、按「立即執行」）</span>
          </div>
          <ol class="ol" start={4}>
            <li>Expiration 建議選一年，到期後回到「設定」更新即可。</li>
            <li>
              按 Generate token，複製 <code class="inline">github_pat_</code> 開頭的字串貼到下面。
            </li>
          </ol>
          <div class="grid-2">
            <div class="field">
              <label for="w-owner">GitHub 帳號</label>
              <input id="w-owner" class="input mono" value={owner} onInput={(e) => setOwner((e.currentTarget as HTMLInputElement).value.trim())} />
            </div>
            <div class="field">
              <label for="w-repo">Repo 名稱</label>
              <input id="w-repo" class="input mono" value={repo} onInput={(e) => setRepo((e.currentTarget as HTMLInputElement).value.trim())} />
            </div>
          </div>
          <div class="field">
            <label for="w-token">Token</label>
            <input id="w-token" class="input mono" type="password" autocomplete="off" placeholder="github_pat_…" value={token} onInput={(e) => setToken((e.currentTarget as HTMLInputElement).value.trim())} />
          </div>
          {check ? (
            <div class={`callout ${check.ok ? 'callout-ok' : 'callout-bad'}`}>
              <Icon name={check.ok ? 'check' : 'alert'} />
              <span>
                {check.message}
                {check.ok && !check.canSecrets ? '（注意：這個 Token 沒有 Secrets 權限，稍後需要手動設定排程器金鑰）' : ''}
              </span>
            </div>
          ) : null}
          <div class="row" style={{ justifyContent: 'flex-end' }}>
            <Btn
              variant="primary"
              icon="right"
              busy={busy}
              disabled={!owner || !repo || !token}
              onClick={() =>
                guard(async () => {
                  const r = await checkToken(client, config.branch);
                  setCheck(r);
                  if (r.ok) setStep('data');
                })
              }
            >
              檢查並繼續
            </Btn>
          </div>
        </section>
      ) : null}

      {step === 'data' && check?.dataState === 'missing' ? (
        <section class="card card-pad stack">
          <h2 style={{ fontSize: 18 }}>建立加密資料空間</h2>
          <p class="muted">
            所有貼文與 Webhook 會用下面這組<b>同步金鑰</b>加密後才存到 repo 的 <code class="inline">{config.branch}</code> 分支，別人就算看得到 repo 也讀不懂內容。在其他裝置登入時也需要它。
          </p>
          <div class="key-box">{newKey}</div>
          <div class="row" style={{ justifyContent: 'center' }}>
            <Btn size="sm" icon="copy" onClick={() => void copyText(newKey)}>
              複製
            </Btn>
            <Btn size="sm" icon="download" onClick={() => downloadText(`TNDA-Relay-同步金鑰-${repo}.txt`, `TNDA Relay 同步金鑰\nRepo：${owner}/${repo}\n同步金鑰：${newKey}\n`)}>
              下載備份
            </Btn>
          </div>
          <label class="check" for="w-saved">
            <input id="w-saved" type="checkbox" checked={saved} onChange={(e) => setSaved((e.currentTarget as HTMLInputElement).checked)} />
            <span>我已經把同步金鑰存在安全的地方（例如密碼管理器）。遺失金鑰就無法解開資料。</span>
          </label>
          <div class="row" style={{ justifyContent: 'flex-end' }}>
            <Btn
              variant="primary"
              icon="lock"
              busy={busy}
              disabled={!saved}
              onClick={() =>
                guard(async () => {
                  await createDataSpace(client, newKey, [], config.branch);
                  setSyncKey(newKey);
                  try {
                    await storeSyncKeySecret(client, newKey);
                    setSecretState('ok');
                  } catch {
                    setSecretState('manual');
                  }
                  setStep('channels');
                })
              }
            >
              建立並繼續
            </Btn>
          </div>
        </section>
      ) : null}

      {step === 'data' && check?.dataState === 'exists' ? (
        <section class="card card-pad stack">
          <h2 style={{ fontSize: 18 }}>輸入同步金鑰</h2>
          <p class="muted">這個 repo 已經有加密資料了。請輸入第一次設定時產生的同步金鑰（TNDA- 開頭）。</p>
          <input id="w-key" class="input mono" placeholder="TNDA-XXXX-XXXX-…" value={existingKey} onInput={(e) => setExistingKey((e.currentTarget as HTMLInputElement).value)} />
          <div class="row" style={{ justifyContent: 'flex-end' }}>
            <Btn
              variant="primary"
              icon="key"
              busy={busy}
              disabled={!normalizeSyncKey(existingKey)}
              onClick={() =>
                guard(async () => {
                  const key = normalizeSyncKey(existingKey)!;
                  const r = await checkSyncKey(client, key, config.branch);
                  if (r !== 'ok') throw new Error('金鑰不正確，解不開這個 repo 的資料。');
                  setSyncKey(key);
                  const repoData = await GitHubDataRepo.open(client, key, { branch: config.branch });
                  const snap = await repoData.load();
                  setChannels(snap.channels);
                  setSecretState(null);
                  setStep(snap.channels.some((c) => c.webhook) ? 'done' : 'channels');
                })
              }
            >
              驗證
            </Btn>
          </div>
        </section>
      ) : null}

      {step === 'channels' ? (
        <section class="card card-pad stack">
          <h2 style={{ fontSize: 18 }}>匯入 Discord 頻道</h2>
          <p class="muted">貼上你整理好的 Webhook 清單：群組標題用【】，下一行頻道名稱，再下一行網址。也可以先跳過，之後在「頻道」頁設定。</p>
          <textarea
            id="w-import"
            class="textarea mono"
            rows={10}
            style={{ fontSize: 13 }}
            placeholder={'【A｜大群組名稱】\n公告\nhttps://discord.com/api/webhooks/…\n\n【測試區】\nhttps://discord.com/api/webhooks/…'}
            value={importText}
            onInput={(e) => setImportText((e.currentTarget as HTMLTextAreaElement).value)}
          />
          {parsed ? (
            <div class="stack-sm">
              {parsed.warnings.map((w, i) => (
                <div key={i} class="callout callout-warn">
                  <Icon name="alert" />
                  <span>{w}</span>
                </div>
              ))}
              {parsed.channels.length ? (
                <div class="chips">
                  {parsed.channels.map((c) => (
                    <span key={c.id} class={`chip ${c.audience === 'staff' ? 'staff' : ''}`}>
                      <b>{c.group}</b>
                      {c.name} · {KIND_LABEL[c.kind]}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <div class="row" style={{ justifyContent: 'flex-end' }}>
            <Btn variant="ghost" onClick={() => setStep('done')}>
              先跳過
            </Btn>
            <Btn
              variant="primary"
              icon="check"
              busy={busy}
              disabled={!parsed?.channels.length}
              onClick={() =>
                guard(async () => {
                  const repoData = await GitHubDataRepo.open(client, syncKey, { branch: config.branch });
                  await repoData.load();
                  const merged = mergeChannels(channels, parsed!.channels);
                  await repoData.saveChannels(merged);
                  setChannels(merged);
                  setStep('test');
                })
              }
            >
              加密儲存 {parsed?.channels.length ?? 0} 個頻道
            </Btn>
          </div>
        </section>
      ) : null}

      {step === 'test' ? (
        <section class="card card-pad stack">
          <h2 style={{ fontSize: 18 }}>測試發送</h2>
          {testChannel ? (
            <>
              <p class="muted">
                送一則「連線測試」到 <b>{testChannel.groupName}／{testChannel.name}</b>，確認 Webhook 正常。
              </p>
              {testResult ? (
                <div class={`callout ${testResult.ok ? 'callout-ok' : 'callout-bad'}`}>
                  <Icon name={testResult.ok ? 'check' : 'alert'} />
                  <span>{testResult.text}</span>
                </div>
              ) : null}
              <div class="row" style={{ justifyContent: 'flex-end' }}>
                <Btn variant="ghost" onClick={() => setStep('done')}>
                  {testResult?.ok ? '繼續' : '跳過'}
                </Btn>
                <Btn
                  variant="primary"
                  icon="send"
                  busy={busy}
                  onClick={() =>
                    guard(async () => {
                      const r = await executeWebhook(testChannel.webhook!, {
                        username: 'TNDA 課務小幫手',
                        allowed_mentions: { parse: [] },
                        embeds: [{ title: '✅ TNDA Relay 已連線', description: '設定完成！之後排程的公告會從這裡準時發出。', color: 0x2fb36d }],
                      });
                      setTestResult(r.ok ? { ok: true, text: '已送出，請到 Discord 確認是否收到。' } : { ok: false, text: r.error ?? '發送失敗' });
                      if (r.ok) setTimeout(() => setStep('done'), 900);
                    })
                  }
                >
                  送出測試訊息
                </Btn>
              </div>
            </>
          ) : (
            <div class="row" style={{ justifyContent: 'flex-end' }}>
              <Btn variant="primary" onClick={() => setStep('done')}>
                繼續
              </Btn>
            </div>
          )}
        </section>
      ) : null}

      {step === 'done' ? (
        <section class="card card-pad stack">
          <h2 style={{ fontSize: 18 }}>設定完成</h2>
          <div class="stack-sm">
            <div class="callout callout-ok">
              <Icon name="check" />
              <span>
                已連上 <b>{owner}/{repo}</b>，資料以同步金鑰加密。
              </span>
            </div>
            {secretState === 'ok' ? (
              <div class="callout callout-ok">
                <Icon name="check" />
                <span>排程器金鑰（{SECRET_NAME}）已自動存到 GitHub Secrets，排程器可以開始工作。</span>
              </div>
            ) : null}
            {secretState === 'manual' ? (
              <div class="callout callout-warn">
                <Icon name="alert" />
                <span>
                  無法自動設定排程器金鑰，請手動新增：打開{' '}
                  <a href={`https://github.com/${owner}/${repo}/settings/secrets/actions/new`} target="_blank" rel="noopener noreferrer">
                    New repository secret
                  </a>
                  ，Name 填 <code class="inline">{SECRET_NAME}</code>，Secret 填你的同步金鑰。{' '}
                  <button type="button" class="btn btn-sm" onClick={() => void copyText(syncKey)}>
                    複製金鑰
                  </button>
                </span>
              </div>
            ) : null}
            <div class="callout">
              <Icon name="info" />
              <span>
                <b>最後一步：</b>進入網站後到「設定 → 準時發送設定」，用免費的 cron-job.org 每 5 分鐘叫醒排程器（約 5 分鐘設定）。GitHub 內建的定時排程常常好幾個小時才跑一次，沒有這一步，網站沒開著時貼文可能會晚發。
              </span>
            </div>
          </div>
          <div class="row" style={{ justifyContent: 'flex-end' }}>
            <Btn variant="primary" icon="right" onClick={finish}>
              開始使用
            </Btn>
          </div>
        </section>
      ) : null}
    </div>
  );
}
