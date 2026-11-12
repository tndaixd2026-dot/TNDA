// 金額與時間的顯示格式。

const WAN = 10_000;

/** 以「萬」為單位的數字字串（不含單位）：350000 → "35"、525000 → "52.5"、-120000 → "-12"。 */
export function wan(amount: number): string {
  const w = amount / WAN;
  const rounded = Math.round(w * 100) / 100;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '');
  return text.replace('-', '−');
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
