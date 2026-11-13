// 金額與時間的顯示格式。

const WAN = 10_000;

/**
 * 以「萬」為單位的精確數字字串（不含單位），最小單位到 1 元：
 * 350000 → "35"、525000 → "52.5"、123456 → "12.3456"、-120000 → "−12"。
 * 個人報酬可能有 0.5 元（×1.5），也會精確顯示。
 */
export function wan(amount: number): string {
  const abs = Math.abs(amount);
  const whole = Math.floor(abs / WAN);
  const rest = abs - whole * WAN;
  let text = String(whole);
  if (rest > 0) text += '.' + (rest / WAN).toFixed(5).slice(2).replace(/0+$/, '');
  return amount < 0 ? `−${text}` : text;
}

/** 學生輸入的「萬」金額 → 整數元。小數最多 4 位（= 1 元）；格式不對回傳 null。 */
export function parseWanInput(input: string): number | null {
  const s = input.normalize('NFKC').trim().replace(/,/g, '');
  const m = /^(\d+)(?:\.(\d{0,4}))?$/.exec(s);
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(4, '0');
  return Number(m[1]) * WAN + Number(frac);
}

/** 「123,456 元」 */
export function yuanText(amount: number): string {
  return `${amount.toLocaleString('zh-TW')} 元`;
}

/** 帶單位：「35 萬」 */
export function wanText(amount: number): string {
  return `${wan(amount)} 萬`;
}

export function signedWan(amount: number): string {
  if (amount > 0) return `+${wan(amount)}`;
  return wan(amount);
}

/** 毫秒 → 「04:59」 */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function clockTime(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
