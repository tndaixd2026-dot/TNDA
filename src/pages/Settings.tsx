import { useEffect, useState } from 'preact/hooks';
import type { MentionMode, Settings } from '../core/types.ts';
import {
  beginSetup,
  demoSeededAt,
  disconnect,
  refreshScheduler,
  resetDemo,
  runSchedulerNow,
  saveSettings,
  toast,
  updateConfig,
  useApp,
} from '../data/store.ts';
import { DEMO_ONLY, buildDeviceLink } from '../data/config.ts';
import { fmtDateTime, fmtRelative } from '../core/time.ts';
import { Btn, Modal, Seg, Switch, askConfirm, copyText, downloadText } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import {
  RUN_SOURCE_LABEL,
  SCHEDULER_STALE_MS,
  bareToken,
  cronTokenUrl,
  dispatchBody,
  dispatchUrl,
  makeClient,
  runSource,
  storeSyncKeySecret,
  testCronToken,
} from '../data/setup.ts';
import { SECRET_NAME } from '../core/repo.ts';

export function SettingsPage() {
  const { settings, config, scheduler } = useApp((s) => ({ settings: s.settings, config: s.config, scheduler: s.scheduler }));
  const [form, setForm] = useState<Settings>(settings);
  const [saving, setSaving] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [secretBusy, setSecretBusy] = useState(false);
  useEffect(() => setForm(settings), [settings]);
  useEffect(() => {
    void refreshScheduler();
  }, []);
  const dirty = JSON.stringify(form) !== JSON.stringify(settings);
  const github = config.mode === 'github';
  const actionsUrl = `https://github.com/${config.owner}/${config.repo}/actions/workflows/scheduler.yml`;

  return (
    <>
      <div class="page-head">
        <div class="titles">
          <div class="eyebrow">TNDA RELAY / SETTINGS</div>
          <h1 class="page-title">設定</h1>
          <p class="page-sub">發送者的名稱與頭像、雲端同步、排程器與這台裝置的偏好。</p>
        </div>
      </div>

      <div class="settings-grid">
        <section class="card card-pad stack">
          <div>
            <h3>發送者</h3>
            <p class="small muted">Discord 上顯示的名稱與頭像，所有裝置共用。</p>
          </div>
          <div class="field">
            <label for="s-name">名稱</label>
            <input id="s-name" class="input" maxLength={80} value={form.senderName} onInput={(e) => setForm({ ...form, senderName: (e.currentTarget as HTMLInputElement).value })} />
            <span class="help">不能包含「discord」或「clyde」。</span>
          </div>
          <div class="field">
            <label for="s-avatar">頭像圖片網址（選填）</label>
            <div class="row" style={{ flexWrap: 'nowrap' }}>
              {form.avatarUrl ? <img src={form.avatarUrl} alt="" width={38} height={38} style={{ borderRadius: '50%', objectFit: 'cover', flex: 'none' }} /> : null}
              <input id="s-avatar" class="input mono" value={form.avatarUrl} placeholder="https://…/logo.png" onInput={(e) => setForm({ ...form, avatarUrl: (e.currentTarget as HTMLInputElement).value.trim() })} />
            </div>
            <span class="help">留空會使用 Discord 上 Webhook 本身的頭像。</span>
          </div>
          <div class="field">
            <label for="s-footer">卡片頁尾</label>
            <input id="s-footer" class="input" value={form.footer} placeholder="例如：有問題請在討論室發問" onInput={(e) => setForm({ ...form, footer: (e.currentTarget as HTMLInputElement).value })} />
          </div>
          <div class="field">
            <span class="label">預設標註</span>
            <Seg<MentionMode>
              label="預設標註"
              value={form.defaultMention}
              onChange={(v) => setForm({ ...form, defaultMention: v })}
              options={[
                { value: 'none', label: '不標註' },
                { value: 'everyone', label: '@everyone' },
                { value: 'here', label: '@here' },
              ]}
            />
          </div>
          <div class="row">
            <Btn
              variant="primary"
              busy={saving}
              disabled={!dirty || /discord|clyde/i.test(form.senderName)}
              onClick={async () => {
                setSaving(true);
                await saveSettings(form);
                setSaving(false);
              }}
            >
              儲存
            </Btn>
            {dirty ? (
              <Btn variant="ghost" onClick={() => setForm(settings)}>
                還原
              </Btn>
            ) : null}
          </div>
        </section>

        <section class="card card-pad stack">
          <div>
            <h3>雲端同步</h3>
            <p class="small muted">
              {github ? '資料以 AES-256-GCM 加密後存在 GitHub repo，任何裝置登入後都看得到同一份。' : '目前是 Demo 模式，資料只存在這個瀏覽器。'}
            </p>
          </div>
          {github ? (
            <>
              <dl class="kv">
                <dt>Repo</dt>
                <dd>
                  <a href={`https://github.com/${config.owner}/${config.repo}`} target="_blank" rel="noopener noreferrer">
                    {config.owner}/{config.repo}
                  </a>
                </dd>
                <dt>資料分支</dt>
                <dd class="mono">{config.branch}</dd>
                <dt>Token</dt>
                <dd class="mono">{config.token.slice(0, 11)}••••••••</dd>
                <dt>同步金鑰</dt>
                <dd class="mono" style={{ wordBreak: 'break-all' }}>
                  {showKey ? config.syncKey : `${config.syncKey.slice(0, 9)}••••-••••-••••`}
                </dd>
              </dl>
              <div class="row">
                <Btn size="sm" icon="eye" onClick={() => setShowKey(!showKey)}>
                  {showKey ? '隱藏金鑰' : '顯示金鑰'}
                </Btn>
                <Btn
                  size="sm"
                  icon="copy"
                  onClick={async () => {
                    const ok = await copyText(config.syncKey);
                    toast(ok ? 'ok' : 'error', ok ? '已複製同步金鑰' : '無法複製，請點「顯示金鑰」後手動選取');
                  }}
                >
                  複製金鑰
                </Btn>
                <Btn
                  size="sm"
                  icon="download"
                  onClick={() =>
                    downloadText(
                      `TNDA-Relay-同步金鑰-${config.repo}.txt`,
                      `TNDA Relay 同步金鑰（請妥善保存，遺失將無法解開資料）\n\nRepo：${config.owner}/${config.repo}\n資料分支：${config.branch}\n同步金鑰：${config.syncKey}\n\n建立時間：${new Date().toLocaleString('zh-TW')}\n`,
                    )
                  }
                >
                  下載備份
                </Btn>
              </div>
              <div class="callout">
                <Icon name="phone" />
                <span style={{ flex: 1 }}>想在手機或其他電腦使用？產生一個連結，打開就自動設定好。</span>
                <Btn size="sm" icon="qr" onClick={() => setLinkOpen(true)}>
                  連結其他裝置
                </Btn>
              </div>
            </>
          ) : (
            <div class="stack-sm">
              {!DEMO_ONLY ? (
                <Btn variant="primary" icon="branch" onClick={beginSetup}>
                  連接 GitHub，開始正式使用
                </Btn>
              ) : (
                <div class="callout">
                  <Icon name="info" />
                  <span>這是展示版。正式版部署在 GitHub Pages，資料會加密同步到 GitHub、由 GitHub Actions 準時發送到 Discord。</span>
                </div>
              )}
              <div class="row">
                <Btn
                  size="sm"
                  icon="refresh"
                  onClick={async () => {
                    if (await askConfirm({ title: '重設範例資料？', body: '你在 Demo 中新增或修改的內容會被清除。', confirmLabel: '重設', danger: true })) resetDemo();
                  }}
                >
                  重設範例資料
                </Btn>
                <span class="small faint">範例產生於 {demoSeededAt() ? fmtRelative(Date.parse(demoSeededAt()!)) : '剛剛'}</span>
              </div>
            </div>
          )}
        </section>

        <section class="card card-pad stack">
          <div>
            <h3>排程器</h3>
            <p class="small muted">排程器（GitHub Actions）負責把到期的貼文發到 Discord，公開 repo 完全免費。</p>
          </div>
          {scheduler.runs.length ? (
            <div class="delivery-list">
              {scheduler.runs.slice(0, 5).map((r) => {
                const ok = r.conclusion === 'success';
                const running = r.status !== 'completed';
                return (
                  <div key={r.id} class="delivery">
                    <span class={`d-icon ${running ? 'wait' : ok ? 'ok' : 'bad'}`}>
                      <Icon name={running ? 'clock' : ok ? 'check' : 'x'} />
                    </span>
                    <div>
                      <div>
                        {fmtDateTime(r.created_at)} <span class="faint small">· {RUN_SOURCE_LABEL[runSource(r)]}</span>
                      </div>
                      <div class="small muted">{running ? '執行中' : ok ? '完成' : `失敗（${r.conclusion}）`}</div>
                    </div>
                    {github ? (
                      <a class="btn btn-ghost btn-sm" href={r.html_url} target="_blank" rel="noopener noreferrer">
                        紀錄
                      </a>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div class="callout callout-warn">
              <Icon name="alert" />
              <span>{scheduler.error ? `讀不到執行紀錄：${scheduler.error}` : '還沒有執行紀錄。排程器第一次執行可能要等 5～15 分鐘。'}</span>
            </div>
          )}
          <div class="row">
            <Btn size="sm" icon="play" onClick={() => void runSchedulerNow()}>
              立即執行一次
            </Btn>
            {github ? (
              <>
                <a class="btn btn-sm" href={actionsUrl} target="_blank" rel="noopener noreferrer">
                  <Icon name="external" />
                  在 GitHub 查看
                </a>
                <Btn
                  size="sm"
                  icon="key"
                  busy={secretBusy}
                  onClick={async () => {
                    setSecretBusy(true);
                    try {
                      await storeSyncKeySecret(makeClient(config.owner, config.repo, config.token), config.syncKey);
                      toast('ok', `已把同步金鑰存到 GitHub Secret（${SECRET_NAME}）`);
                    } catch (err) {
                      toast('error', `無法設定 Secret：${(err as Error).message}。請確認 Token 有 Secrets 寫入權限，或手動設定。`);
                    } finally {
                      setSecretBusy(false);
                    }
                  }}
                >
                  重新設定排程器金鑰
                </Btn>
              </>
            ) : null}
          </div>
          <p class="small faint">網站開著時，「準時代發」會在時間一到就由這台裝置直接送出，不必等排程器。</p>
        </section>

        {github ? <CronSetup /> : null}

        <section class="card card-pad stack">
          <div>
            <h3>這台裝置</h3>
            <p class="small muted">只影響目前這個瀏覽器。</p>
          </div>
          {github ? (
            <Switch id="s-precision" checked={config.precision} onChange={(v) => updateConfig({ precision: v })}>
              準時代發：網站開著時，到時間就由這台裝置直接發送
            </Switch>
          ) : null}
          <div class="row">
            <span class="small muted" style={{ minWidth: 72 }}>
              介面主題
            </span>
            <Seg
              label="介面主題"
              value={config.theme}
              onChange={(v) => updateConfig({ theme: v })}
              options={[
                { value: 'system', label: '跟隨系統' },
                { value: 'light', label: <><Icon name="sun" /> 淺色</> },
                { value: 'dark', label: <><Icon name="moon" /> 深色</> },
              ]}
            />
          </div>
          <div class="row">
            <span class="small muted" style={{ minWidth: 72 }}>
              預覽主題
            </span>
            <Seg label="Discord 預覽主題" value={config.previewTheme} onChange={(v) => updateConfig({ previewTheme: v })} options={[{ value: 'dark', label: 'Discord 深色' }, { value: 'light', label: 'Discord 淺色' }]} />
          </div>
          {!DEMO_ONLY ? (
            <div>
              <Btn
                variant="danger"
                icon="logout"
                onClick={async () => {
                  const ok = await askConfirm({
                    title: github ? '中斷這台裝置的連線？' : '離開 Demo？',
                    body: github ? '會清除這台裝置上的 Token、同步金鑰與快取。GitHub 上的資料不受影響，之後可以重新連接。請先確認同步金鑰已備份。' : '會清除 Demo 資料並回到起始畫面。',
                    confirmLabel: github ? '中斷連線' : '離開 Demo',
                    danger: true,
                  });
                  if (ok) await disconnect();
                }}
              >
                {github ? '中斷連線並清除這台裝置的資料' : '離開 Demo'}
              </Btn>
            </div>
          ) : null}
        </section>
      </div>

      {linkOpen ? <DeviceLinkModal onClose={() => setLinkOpen(false)} /> : null}
    </>
  );
}

function DeviceLinkModal({ onClose }: { onClose: () => void }) {
  const config = useApp((s) => s.config);
  const link = buildDeviceLink(config);
  const [svg, setSvg] = useState('');
  const [reveal, setReveal] = useState(false);
  useEffect(() => {
    if (!reveal) return;
    void import('uqr').then(({ renderSVG }) => setSvg(renderSVG(link, { pixelSize: 6, border: 1 })));
  }, [reveal, link]);
  return (
    <Modal title="連結其他裝置" onClose={onClose}>
      <div class="stack" style={{ marginTop: 8 }}>
        <div class="callout callout-warn">
          <Icon name="lock" />
          <span>這個連結包含你的 Token 與同步金鑰，等同完整權限。只在自己的裝置上使用，不要傳給別人或貼到群組。</span>
        </div>
        {reveal ? (
          <>
            <div class="qr" dangerouslySetInnerHTML={{ __html: svg }} aria-label="裝置連結 QR Code" />
            <p class="small muted" style={{ textAlign: 'center' }}>
              用手機相機掃描，或複製連結到另一台電腦的瀏覽器打開。
            </p>
          </>
        ) : (
          <Btn variant="primary" icon="qr" onClick={() => setReveal(true)}>
            我了解，顯示 QR Code
          </Btn>
        )}
      </div>
      <div class="modal-actions">
        <Btn onClick={onClose}>關閉</Btn>
        {reveal ? (
          <Btn
            icon="copy"
            onClick={async () => {
              const ok = await copyText(link);
              toast(ok ? 'ok' : 'error', ok ? '已複製裝置連結' : '無法複製');
            }}
          >
            複製連結
          </Btn>
        ) : null}
      </div>
    </Modal>
  );
}

/** 外部定時器設定：GitHub 內建的定時排程對新 repo 常常數小時才跑一次，改由 cron-job.org 每 5 分鐘觸發 */
function CronSetup() {
  const { config, runs } = useApp((s) => ({ config: s.config, runs: s.scheduler.runs }));
  const [branch, setBranch] = useState('');
  const [cronToken, setCronToken] = useState('');
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => {
    makeClient(config.owner, config.repo, config.token)
      .getRepo()
      .then((r) => setBranch(r.default_branch))
      .catch(() => setBranch(''));
  }, [config.owner, config.repo, config.token]);
  const working = runs.some((r) => runSource(r) === 'cron' && Date.now() - Date.parse(r.created_at) < SCHEDULER_STALE_MS);
  const url = dispatchUrl(config.owner, config.repo);
  const body = dispatchBody(branch || '（讀取中…）');
  const token = bareToken(cronToken);
  const copy = async (text: string, label: string) => {
    const ok = await copyText(text);
    toast(ok ? 'ok' : 'error', ok ? `已複製${label}` : '無法複製，請手動選取');
  };
  const runTest = async () => {
    setTesting(true);
    setTest(await testCronToken(config.owner, config.repo, cronToken, branch));
    setTesting(false);
    setTimeout(() => void refreshScheduler(), 8000);
  };
  return (
    <section class="card card-pad stack" style={{ gridColumn: '1 / -1' }}>
      <div class="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3>準時發送設定（外部定時器）</h3>
          <p class="small muted">
            GitHub 內建的定時排程對新 repo 常常好幾個小時才跑一次。用免費的 cron-job.org 每 5 分鐘叫醒排程器，貼文就會準時發出，網站不用開著。只需要設定一次。
          </p>
        </div>
        <span class={`pill ${working ? 'pill-ok' : 'pill-warn'}`}>
          <span class="dot" />
          {working ? '運作中' : '尚未偵測到'}
        </span>
      </div>
      <ol class="ol">
        <li>
          建立一個只給定時器用的 Token：打開{' '}
          <a href={cronTokenUrl(config.owner, config.repo)} target="_blank" rel="noopener noreferrer">
            建立 Token 頁面
          </a>
          ，Repository access 只選 <code class="inline">{config.owner}/{config.repo}</code>，權限只要 <b>Actions：Read and write</b>，Expiration 選一年。這個 Token 只能叫醒排程器，碰不到你的資料。
        </li>
        <li>
          把 Token 貼在這裡按「測試」，先確認它能叫醒排程器（只用來測試，不會儲存）：
          <div class="row" style={{ marginTop: 8, gap: 8 }}>
            <input
              class="input mono"
              type="password"
              autocomplete="off"
              aria-label="定時器 Token"
              placeholder="github_pat_…"
              style={{ flex: '1 1 220px', minWidth: 0 }}
              value={cronToken}
              onInput={(e) => {
                setCronToken((e.currentTarget as HTMLInputElement).value);
                setTest(null);
              }}
            />
            <Btn size="sm" icon="zap" busy={testing} disabled={!token || !branch} onClick={() => void runTest()}>
              測試
            </Btn>
          </div>
          {test ? (
            <div class={`callout ${test.ok ? 'callout-ok' : 'callout-bad'}`} role="status" style={{ marginTop: 8 }}>
              <Icon name={test.ok ? 'check' : 'alert'} />
              <span>{test.message}</span>
            </div>
          ) : null}
        </li>
        <li>
          到{' '}
          <a href="https://cron-job.org/" target="_blank" rel="noopener noreferrer">
            cron-job.org
          </a>{' '}
          免費註冊，按「CREATE CRONJOB」照下表填寫。Request method、Headers、Request body 在「ADVANCED」分頁：
        </li>
      </ol>
      <div class="perm-table cron-table">
        <b>URL</b>
        <code class="inline">{url}</code>
        <Btn size="sm" variant="ghost" iconOnly icon="copy" onClick={() => void copy(url, '網址')}>
          複製網址
        </Btn>
        <b>Execution schedule</b>
        <span>Every 5 minutes</span>
        <span />
        <b>Request method</b>
        <span>
          <b>POST</b>（預設是 GET，一定要改）
        </span>
        <span />
        <b>Headers</b>
        <span>
          <code class="inline">Authorization</code>：<code class="inline">Bearer 定時器 Token</code>（Bearer 後面空一格）
          <br />
          <code class="inline">Accept</code>：<code class="inline">application/vnd.github+json</code>
        </span>
        <span class="row" style={{ gap: 2, flexWrap: 'nowrap' }}>
          <Btn
            size="sm"
            variant="ghost"
            iconOnly
            icon="copy"
            disabled={!token}
            title={token ? undefined : '先在第 2 步貼上 Token'}
            onClick={() => void copy(`Bearer ${token}`, ' Authorization 內容（含 Token）')}
          >
            複製 Authorization 內容
          </Btn>
          <Btn size="sm" variant="ghost" iconOnly icon="copy" onClick={() => void copy('application/vnd.github+json', ' Accept 內容')}>
            複製 Accept 內容
          </Btn>
        </span>
        <b>Request body</b>
        <code class="inline">{body}</code>
        <Btn size="sm" variant="ghost" iconOnly icon="copy" disabled={!branch} onClick={() => void copy(body, '內容')}>
          複製內容
        </Btn>
      </div>
      <div class="callout">
        <Icon name="info" />
        <span>這個網址是給 cron-job.org 呼叫的，不是網頁。直接用瀏覽器打開會顯示「404 Not Found」，這是正常的。</span>
      </div>
      <ol class="ol" start={4}>
        <li>
          存檔後在 cron-job.org 按「TEST RUN」或看「History」：顯示 <b>204</b> 就是成功。5 分鐘內，上方「排程器」的紀錄會出現「外部定時器」，右上角會變成「運作中」。
        </li>
        <li>
          其他代碼：<b>401</b> Token 貼錯或 Bearer 後面沒空格；<b>403</b> Token 權限不足；<b>404</b> 網址打錯、Request method 不是 POST，或 Token 沒選到這個 repo；<b>422</b> Request body 打錯。
        </li>
      </ol>
    </section>
  );
}
