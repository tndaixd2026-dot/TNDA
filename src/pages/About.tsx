import { Icon, type IconName } from '../ui/icons.tsx';
import { navigate } from '../data/store.ts';
import { Btn } from '../ui/kit.tsx';

const FEATURES: Array<[IconName, string, string]> = [
  ['sparkles', '智慧整理', '辨識中文日期（明天、下週三、10/21（三））、時間區間、截止日、地點、連結與攜帶物品，還會提醒「寫錯星期」。'],
  ['bell', '提醒鏈', '一則作業自動建立「截止前 3 天、前 1 天、當天」多次提醒；訊息中的倒數由 Discord 即時計算。'],
  ['hash', '多頻道發送', '依課程與類型建議頻道；同一則公告可同時發到多個群組，學員與業師頻道會分開標示。'],
  ['calendar', '行事曆與紀錄', '月曆同時顯示發文、上課與截止時間，拖曳就能改期；紀錄可搜尋、篩選、匯出 CSV。'],
  ['undo', '撤回與修改', '發錯可以一鍵從 Discord 撤回，或直接修改已發送的訊息內容。'],
  ['repeat', '每週重複', '固定的上課提醒設定一次，每週同一時間自動發送，時間戳也會跟著往後推。'],
  ['shield', '端對端加密', '貼文與 Webhook 用 AES-256-GCM 加密後才存到公開 repo，只有持有同步金鑰的裝置與排程器能讀。'],
  ['zap', '不重複、不漏發', '發送前先以 Git 版本比對「認領」，排程器與多台裝置同時運作也只會送出一次；失敗自動重試。'],
];

export function About() {
  return (
    <div class="stack" style={{ gap: 22 }}>
      <section class="about-hero">
        <div class="eyebrow" style={{ color: 'inherit', opacity: 0.8 }}>
          TNDA RELAY · 課務發報台
        </div>
        <h2>貼上一段話，學生就在對的頻道、對的時間收到整齊的公告</h2>
        <p>
          老師每天要在 Discord 的十幾個聊天室發上課提醒、作業截止、補課與表單。這個平台把「整理格式、選頻道、記得準時發」這三件事自動化，而且不需要伺服器、不需要付費。
        </p>
        <div class="row" style={{ marginTop: 16 }}>
          <Btn onClick={() => navigate('compose')} icon="pen">
            試著發一則
          </Btn>
        </div>
      </section>

      <section class="card card-pad">
        <h3 style={{ fontSize: 16, marginBottom: 10 }}>運作方式</h3>
        <div class="arch">
          <svg viewBox="0 0 900 250" role="img" aria-label="架構圖：瀏覽器整理並加密資料，存到 GitHub repo；GitHub Actions 每 5 分鐘解密並發送到 Discord。">
            <defs>
              <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0 10 5 0 10z" fill="var(--ink-3)" />
              </marker>
            </defs>
            {[
              { x: 10, title: '瀏覽器', lines: ['貼上 → 智慧整理', 'Discord 預覽', 'AES-256 加密'], icon: '①' },
              { x: 245, title: 'GitHub repo', lines: ['tnda-data 分支', '每則貼文一個加密檔', '版本比對防衝突'], icon: '②' },
              { x: 480, title: 'GitHub Actions', lines: ['每 5 分鐘執行', '解密、找出到期貼文', '認領 → 發送 → 記錄'], icon: '③' },
              { x: 715, title: 'Discord', lines: ['17 個聊天室', 'Webhook 發文', '時間戳即時倒數'], icon: '④' },
            ].map((b) => (
              <g key={b.title}>
                <rect x={b.x} y="40" width="175" height="150" rx="14" fill="var(--surface-2)" stroke="var(--line-strong)" />
                <text x={b.x + 18} y="74" font-size="15" font-weight="700" fill="var(--ink)">
                  {b.icon} {b.title}
                </text>
                {b.lines.map((l, i) => (
                  <text key={l} x={b.x + 18} y={106 + i * 26} font-size="13" fill="var(--ink-2)">
                    {l}
                  </text>
                ))}
              </g>
            ))}
            <line x1="188" y1="115" x2="242" y2="115" stroke="var(--ink-3)" stroke-width="2" marker-end="url(#arr)" />
            <line x1="423" y1="115" x2="477" y2="115" stroke="var(--ink-3)" stroke-width="2" marker-end="url(#arr)" />
            <line x1="658" y1="115" x2="712" y2="115" stroke="var(--ink-3)" stroke-width="2" marker-end="url(#arr)" />
            <path d="M97 192 C 97 235, 800 235, 800 192" fill="none" stroke="var(--post)" stroke-width="2" stroke-dasharray="6 5" marker-end="url(#arr)" />
            <text x="450" y="244" text-anchor="middle" font-size="12.5" fill="var(--post-text)">
              網站開著時「準時代發」：時間一到由瀏覽器直接送出
            </text>
            <text x="10" y="24" font-size="12.5" fill="var(--ink-3)">
              沒有自己的伺服器：網站在 GitHub Pages、資料在 GitHub repo、排程在 GitHub Actions，全部免費
            </text>
          </svg>
        </div>
      </section>

      <section>
        <h3 style={{ fontSize: 16, marginBottom: 10 }}>功能</h3>
        <div class="feature-grid">
          {FEATURES.map(([icon, t, d]) => (
            <div key={t} class="feature">
              <Icon name={icon} />
              <b>{t}</b>
              <p>{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section class="grid-2">
        <div class="card card-pad">
          <h3 style={{ fontSize: 16, marginBottom: 6 }}>費用：NT$0</h3>
          <ul class="small muted" style={{ margin: 0, paddingLeft: '1.2em' }}>
            <li>GitHub Pages：公開 repo 免費託管網站</li>
            <li>GitHub Actions：公開 repo 的執行時間不限</li>
            <li>Discord Webhook：免費、不需要建立機器人</li>
            <li>智慧整理在瀏覽器裡完成，不呼叫付費 AI</li>
          </ul>
        </div>
        <div class="card card-pad">
          <h3 style={{ fontSize: 16, marginBottom: 6 }}>使用上的限制</h3>
          <ul class="small muted" style={{ margin: 0, paddingLeft: '1.2em' }}>
            <li>GitHub 排程在尖峰可能延遲幾分鐘；網站開著時會準時代發</li>
            <li>圖片需使用網址，暫不支援直接上傳檔案</li>
            <li>同步金鑰遺失就無法解開資料，請務必備份</li>
          </ul>
        </div>
      </section>
    </div>
  );
}
