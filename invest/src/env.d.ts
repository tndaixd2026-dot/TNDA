interface ImportMetaEnv {
  /** Supabase 專案網址；空字串表示連同一台主機（本機版） */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase anon（publishable）金鑰：公開的，只能呼叫 invest_* RPC */
  readonly VITE_SUPABASE_ANON_KEY?: string;
}
