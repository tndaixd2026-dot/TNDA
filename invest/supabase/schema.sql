-- =====================================================================
-- 期末提報「即時投資」— 資料庫（Supabase Postgres；本機備援版用 PGlite 跑同一份）
--
-- 所有規則都在這裡驗證與結算。網頁只能呼叫 public.invest_* 這幾個 RPC 函式
-- （SECURITY DEFINER），資料表放在不對外公開的 invest schema。
-- 這個檔案可以重複執行（會更新函式、保留資料）。
--
-- 第一次設定管理員密碼：select invest.set_admin_password('你的密碼');
-- =====================================================================

create schema if not exists invest;
revoke all on schema invest from public;

-- ---------- 資料表 ----------

create table if not exists invest.config (
  id int primary key default 1 check (id = 1),
  admin_hash text,
  active text not null default 'wed' check (active in ('wed', 'thu')),
  dark_ms int not null default 300000 check (dark_ms > 0),
  -- 任何公開狀態變動都會 +1；前端用它判斷要不要重抓
  version bigint not null default 1
);
insert into invest.config (id) values (1) on conflict (id) do nothing;

create table if not exists invest.roster (
  course text not null check (course in ('wed', 'thu')),
  name_key text not null,
  name text not null,
  grp text not null,
  primary key (course, name_key)
);

create table if not exists invest.course (
  course text primary key check (course in ('wed', 'thu')),
  phase text not null default 'pending' check (phase in ('pending', 'open', 'dark', 'closed')),
  opened_at timestamptz,
  dark_at timestamptz,
  dark_ends_at timestamptz,
  closed_at timestamptz,
  -- 暗盤開始時最後一個走勢點的 id；暗盤期間只公開 id <= 這個值的點
  dark_history_id bigint,
  -- 取消封盤時用來還原
  closed_from text,
  dark_left_ms bigint,
  -- 封盤時凍結的完整結算（含姓名，只給管理員）
  results jsonb
);
insert into invest.course (course) values ('wed'), ('thu') on conflict (course) do nothing;

create table if not exists invest.alloc (
  course text not null,
  name_key text not null,
  grp text not null,
  amount bigint not null check (amount > 0),
  primary key (course, name_key, grp)
);

-- 這一場有登入過的人（沒登入過的缺席者封盤時不倒扣）
create table if not exists invest.presence (
  course text not null,
  name_key text not null,
  at timestamptz not null default now(),
  primary key (course, name_key)
);

create table if not exists invest.history (
  id bigserial primary key,
  course text not null,
  t timestamptz not null,
  totals jsonb not null,
  mark text
);
create index if not exists history_course_id on invest.history (course, id);

-- 出席紀錄（登入動畫的「出席率行情看板」用）：一列 = 一位學生 × 一場 × 一週
create table if not exists invest.attendance (
  course text not null check (course in ('wed', 'thu')),
  name_key text not null,
  week int not null check (week between 0 and 60),
  status text not null check (status in ('present', 'late', 'leave', 'absent')),
  primary key (course, name_key, week)
);
-- 看板是否公開（學生登入頁看得到姓名與出席率）
alter table invest.config add column if not exists board_visible boolean not null default true;

-- 帳號：學生（名單匯入時自動建立，密碼 = 生日後四碼）、業師／老師、訪客（密碼預設 TNDA）
-- 業師、老師、訪客兩場都能投、每場各 100 萬；投資算進各組總額，但不倒扣、不參加股神獎
create table if not exists invest.account (
  name_key text primary key,
  name text not null,
  role text not null default 'student' check (role in ('student', 'mentor', 'guest')),
  salt text,
  pw_hash text,
  -- 連續輸錯 5 次鎖 1 分鐘
  fails int not null default 0,
  locked_until timestamptz
);
-- 登入後發給手機的憑證（存在手機的 localStorage）
create table if not exists invest.session (
  token text primary key,
  name_key text not null,
  created_at timestamptz not null default now()
);
create index if not exists session_key on invest.session (name_key);

-- 各組作品：封面照片（JPEG data URL，管理員頁上傳時先縮小）與題目 slogan
create table if not exists invest.group_info (
  course text not null check (course in ('wed', 'thu')),
  grp text not null,
  slogan text not null default '',
  cover text,
  cover_ver int not null default 0,
  primary key (course, grp)
);

-- 業師總結的投影片（由管理員一頁一頁切換）
create table if not exists invest.slide (
  id bigserial primary key,
  pos int not null default 0,
  kind text not null default 'text' check (kind in ('title', 'text', 'recap')),
  title text not null default '',
  subtitle text not null default '',
  body text not null default '',
  image text,
  image_ver int not null default 0
);

-- 大螢幕舞台：market（盤況）→ awards（頒獎，一步一步揭曉）→ summary（業師總結投影片）
alter table invest.config add column if not exists stage_mode text not null default 'market';
alter table invest.config add column if not exists stage_step int not null default 0;
-- 封盤後結果先不公開，頒獎揭曉該場第一名時才公開（大螢幕、學生手機）
alter table invest.course add column if not exists revealed boolean not null default false;

-- 沒有單一組上限（可以 all in 100 萬）；舊版的 50 萬上限拿掉
alter table invest.alloc drop constraint if exists alloc_amount_check;
alter table invest.alloc add constraint alloc_amount_check check (amount > 0 and amount <= 1000000);

-- 報告時段：管理員在某組上台時按「開始報告」→ 簡報 3 分 ×1.4、Demo 7 分 ×1.2、業師講評 6 分 ×1.1，之後 ×1
alter table invest.course add column if not exists presenting text;
alter table invest.course add column if not exists presenting_at timestamptz;
-- 各組最近一次開始報告的時間（組別 → 毫秒），管理員頁顯示「已報告」
alter table invest.course add column if not exists presented jsonb not null default '{}'::jsonb;

-- TNDA 天使投資獎（業師評分的組別獎）：管理員選得獎組別；頒獎走到這一步才公開
alter table invest.course add column if not exists angel jsonb not null default '[]'::jsonb;
alter table invest.course add column if not exists angel_revealed boolean not null default false;

-- 每一筆投資（由 alloc 的觸發器維護，加總永遠等於 alloc.amount）：
-- 下單當下決定時段加權；撤回時先扣最晚的
create table if not exists invest.lot (
  id bigserial primary key,
  course text not null,
  name_key text not null,
  grp text not null,
  amount bigint not null check (amount > 0),
  weight numeric(3, 1) not null default 1,
  -- 從該組開始報告到下單的毫秒數（同分比快慢用；報告時段以外 = 16 分鐘）
  delay_ms bigint not null default 960000,
  at timestamptz not null default now()
);
create index if not exists lot_owner on invest.lot (course, name_key, grp, id);

alter table invest.config enable row level security;
alter table invest.roster enable row level security;
alter table invest.course enable row level security;
alter table invest.alloc enable row level security;
alter table invest.presence enable row level security;
alter table invest.history enable row level security;
alter table invest.attendance enable row level security;
alter table invest.account enable row level security;
alter table invest.session enable row level security;
alter table invest.group_info enable row level security;
alter table invest.slide enable row level security;
alter table invest.lot enable row level security;

-- ---------- 小工具 ----------

create or replace function invest.ms(ts timestamptz) returns bigint
language sql immutable set search_path = '' as $$
  select (extract(epoch from ts) * 1000)::bigint
$$;

-- 去掉前後空白與零寬字元、全形半形統一（與 shared/roster.ts 的 normalizeName 相同）
create or replace function invest.norm_name(s text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(
           regexp_replace(
             regexp_replace(normalize(coalesce(s, ''), NFKC), '[​-‍﻿]', '', 'g'),
             '^\s+|\s+$', '', 'g'),
           '\s+', ' ', 'g')
$$;

create or replace function invest.name_key(s text) returns text
language sql immutable set search_path = '' as $$
  select lower(invest.norm_name(s))
$$;

create or replace function invest.course_label(c text) returns text
language sql immutable set search_path = '' as $$
  select case c when 'wed' then '上半場・週三' else '下半場・週四' end
$$;

create or replace function invest.err(code text, message text) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('error', code, 'message', message)
$$;

create or replace function invest.cn_digit(ch text) returns int
language sql immutable set search_path = '' as $$
  select case ch
    when '零' then 0 when '〇' then 0 when '一' then 1 when '二' then 2 when '兩' then 2
    when '三' then 3 when '四' then 4 when '五' then 5 when '六' then 6 when '七' then 7
    when '八' then 8 when '九' then 9 else null end
$$;

create or replace function invest.cn_num(s text) returns int
language plpgsql immutable set search_path = '' as $$
declare
  m text[];
  ch text;
  d int;
  res int := 0;
begin
  if s = '十' then return 10; end if;
  m := regexp_match(s, '^([一二兩三四五六七八九])?十([一二三四五六七八九])?$');
  if m is not null then
    return coalesce(invest.cn_digit(m[1]), 1) * 10 + coalesce(invest.cn_digit(m[2]), 0);
  end if;
  foreach ch in array regexp_split_to_array(s, '') loop
    d := invest.cn_digit(ch);
    if d is null then return null; end if;
    res := res * 10 + d;
  end loop;
  return res;
end
$$;

-- 「第3組」「第三組」「3」→ 3（與 shared/roster.ts 的 groupNumber 相同）
create or replace function invest.group_num(label text) returns int
language plpgsql immutable set search_path = '' as $$
declare
  s text := btrim(normalize(coalesce(label, ''), NFKC));
  m text[];
begin
  m := regexp_match(s, '^第?\s*([0-9]+|[零〇一二兩三四五六七八九十]+)\s*組');
  if m is null then
    m := regexp_match(s, '^(?:group|g)?\s*([0-9]+)\y', 'i');
  end if;
  if m is null then return null; end if;
  if m[1] ~ '^[0-9]+$' then return m[1]::int; end if;
  return invest.cn_num(m[1]);
end
$$;

-- 某堂課的組別（依組號排序）
create or replace function invest.groups(c text) returns text[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(g.grp order by invest.group_num(g.grp) nulls last, g.grp collate "C"), '{}')
  from (select distinct r.grp from invest.roster r where r.course = c) g
$$;

create or replace function invest.bump() returns void
language sql volatile set search_path = '' as $$
  update invest.config set version = version + 1 where id = 1
$$;

create or replace function invest.check_admin(pw text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(
    (select cfg.admin_hash is not null
        and cfg.admin_hash = encode(sha256(convert_to(invest.norm_name(pw), 'UTF8')), 'hex')
     from invest.config cfg where cfg.id = 1),
    false)
$$;

-- 設定管理員密碼（只能從 SQL Editor／管理工具執行，不對外公開）
create or replace function invest.set_admin_password(pw text) returns void
language sql volatile set search_path = '' as $$
  update invest.config
     set admin_hash = encode(sha256(convert_to(invest.norm_name(pw), 'UTF8')), 'hex')
   where id = 1
$$;

-- 帳號密碼：每個帳號自己的 salt；密碼前後空白、全形半形、英文大小寫不影響
create or replace function invest.pw_hash(salt text, pw text) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(salt || ':' || upper(invest.norm_name(pw)), 'UTF8')), 'hex')
$$;

create or replace function invest.set_password(k text, pw text) returns void
language plpgsql volatile set search_path = '' as $$
declare
  v_salt text := replace(gen_random_uuid()::text, '-', '');
begin
  update invest.account
     set salt = v_salt, pw_hash = invest.pw_hash(v_salt, pw), fails = 0, locked_until = null
   where name_key = k;
  delete from invest.session s where s.name_key = k;
end
$$;

-- 名單上的學生都要有帳號（還沒設密碼的不能登入）
create or replace function invest.ensure_student_accounts() returns void
language sql volatile set search_path = '' as $$
  insert into invest.account (name_key, name, role)
  select distinct on (r.name_key) r.name_key, r.name, 'student' from invest.roster r
  on conflict (name_key) do nothing
$$;

create or replace function invest.session_key(p_token text) returns text
language sql stable set search_path = '' as $$
  select s.name_key from invest.session s where s.token = p_token and length(coalesce(p_token, '')) between 32 and 100
$$;

create or replace function invest.role_of(k text) returns text
language sql stable set search_path = '' as $$
  select coalesce((select a.role from invest.account a where a.name_key = k), 'student')
$$;

-- ---------- 報告時段加權 ----------

-- 開始報告後經過 elapsed 毫秒的加權（與 shared/rules.ts 的 PRESENT_STAGES 相同）
create or replace function invest.stage_weight(elapsed bigint) returns numeric
language sql immutable set search_path = '' as $$
  select case when elapsed is null or elapsed < 0 then 1.0
              when elapsed < 180000 then 1.4
              when elapsed < 600000 then 1.2
              when elapsed < 960000 then 1.1
              else 1.0 end
$$;

-- 某組現在是不是正在報告；是的話回傳開始報告後經過的毫秒數，否則 null
create or replace function invest.present_elapsed(c text, g text) returns bigint
language sql stable set search_path = '' as $$
  select invest.ms(now()) - invest.ms(cs.presenting_at)
  from invest.course cs
  where cs.course = c and cs.presenting = g and cs.presenting_at is not null
$$;

-- alloc 變動時維護 lot：增加的部分記一筆（當下加權）；減少時先扣最晚的；刪除就全部清掉
create or replace function invest.sync_lots() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_old bigint := 0;
  v_new bigint := 0;
  v_course text;
  v_key text;
  v_grp text;
  v_elapsed bigint;
  v_cut bigint;
  l record;
begin
  if tg_op in ('UPDATE', 'DELETE') then v_old := old.amount; end if;
  if tg_op in ('INSERT', 'UPDATE') then
    v_new := new.amount; v_course := new.course; v_key := new.name_key; v_grp := new.grp;
  else
    v_course := old.course; v_key := old.name_key; v_grp := old.grp;
  end if;
  if tg_op = 'UPDATE' and (old.course, old.name_key, old.grp) is distinct from (new.course, new.name_key, new.grp) then
    delete from invest.lot lt where lt.course = old.course and lt.name_key = old.name_key and lt.grp = old.grp;
    v_old := 0;
  end if;
  if v_new > v_old then
    -- 只有學生的錢吃時段加權；業師、老師、來賓一律 ×1
    v_elapsed := case when invest.role_of(v_key) = 'student' then invest.present_elapsed(v_course, v_grp) end;
    insert into invest.lot (course, name_key, grp, amount, weight, delay_ms)
    values (v_course, v_key, v_grp, v_new - v_old, invest.stage_weight(v_elapsed),
            case when v_elapsed is null or v_elapsed < 0 then 960000 else least(v_elapsed, 960000) end);
  elsif v_new < v_old then
    v_cut := v_old - v_new;
    for l in select lt.id, lt.amount from invest.lot lt
              where lt.course = v_course and lt.name_key = v_key and lt.grp = v_grp
              order by lt.id desc loop
      exit when v_cut <= 0;
      if l.amount <= v_cut then
        delete from invest.lot lt where lt.id = l.id;
        v_cut := v_cut - l.amount;
      else
        update invest.lot set amount = amount - v_cut where id = l.id;
        v_cut := 0;
      end if;
    end loop;
  end if;
  return null;
end
$$;

drop trigger if exists alloc_lots on invest.alloc;
create trigger alloc_lots after insert or update or delete on invest.alloc
  for each row execute function invest.sync_lots();

-- 舊資料（加權功能上線前的投資）補成 ×1 的一筆
insert into invest.lot (course, name_key, grp, amount)
select a.course, a.name_key, a.grp, a.amount from invest.alloc a
where not exists (select 1 from invest.lot lt where lt.course = a.course and lt.name_key = a.name_key and lt.grp = a.grp);

-- ---------- 狀態計算 ----------

-- 目前各組獲得的投資總額（每筆 × 時段加權，不含倒扣）
create or replace function invest.totals(c text) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_object_agg(u.grp, coalesce(t.total, 0)), '{}'::jsonb)
  from unnest(invest.groups(c)) as u(grp)
  left join (
    select lt.grp, sum(lt.amount * lt.weight) as total from invest.lot lt where lt.course = c group by lt.grp
  ) t on t.grp = u.grp
$$;

-- 這一場有沒有登入過（有投資也算）
create or replace function invest.is_present(c text, k text) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from invest.presence p where p.course = c and p.name_key = k)
      or exists (select 1 from invest.alloc a where a.course = c and a.name_key = k)
$$;

create or replace function invest.mark_present(c text, k text) returns void
language plpgsql volatile set search_path = '' as $$
begin
  if not exists (select 1 from invest.roster r where r.course = c and r.name_key = k) then return; end if;
  insert into invest.presence (course, name_key) values (c, k) on conflict do nothing;
  if found then perform invest.bump(); end if;
end
$$;

/*
  封盤結算（與 shared/rules.ts 的 computeResults 相同，測試會逐一比對）：
  - 每一筆投資（invest.lot）在下單當下決定時段加權 ×1.4／×1.2／×1.1／×1
  - 各組最終金額 = Σ（每筆金額 × 加權）− 自己組員沒花完的錢（只倒扣這一場有登入過的人）
  - 依最終金額排名（同分同名次、下一名順延）→ 倍率 ×3、×2、×1.5、其餘 ×1；最高的組即使為負數也得獎
  - 個人報酬 = Σ（每筆金額 × 加權 × 該組倍率），未花完的錢不計入；個人名次只算有投資的人
  - 報酬同分時比下注快慢（delay_ms 依金額加權平均，四捨五入到毫秒，小者在前）；仍相同才並列
  - 業師、老師、訪客（account.role <> 'student'）：投資算進各組總額；不倒扣、不參加股神獎與個人名次（另列在 others）
*/
create or replace function invest.compute_results(c text) returns jsonb
language sql stable set search_path = '' as $$
  with g as (
    select u.grp, u.ord from unnest(invest.groups(c)) with ordinality as u(grp, ord)
  ),
  m as (
    select r.name_key, r.name, r.grp as own, true as student from invest.roster r where r.course = c
    union all
    select ac.name_key, ac.name, null, false from invest.account ac
    where ac.role <> 'student' and not exists (select 1 from invest.roster r where r.course = c and r.name_key = ac.name_key)
  ),
  va as (
    select lt.name_key, lt.grp, lt.amount, lt.weight, lt.delay_ms
    from invest.lot lt
    join m on m.name_key = lt.name_key
    join g on g.grp = lt.grp
    where lt.course = c and (m.own is null or lt.grp <> m.own)
  ),
  inv as (
    select m.name_key, m.name, m.own, m.student,
           coalesce((select sum(va.amount) from va where va.name_key = m.name_key), 0) as invested
    from m
  ),
  ded as (
    select inv.own as grp, inv.name, 1000000 - inv.invested as unspent
    from inv
    where inv.student and inv.invested < 1000000
      and (inv.invested > 0
           or exists (select 1 from invest.presence p where p.course = c and p.name_key = inv.name_key))
  ),
  gr0 as (
    select g.grp, g.ord,
           coalesce((select sum(va.amount * va.weight) from va where va.grp = g.grp), 0) as raw,
           coalesce((select sum(ded.unspent) from ded where ded.grp = g.grp), 0) as penalty
    from g
  ),
  gr as (
    select gr0.*, gr0.raw - gr0.penalty as fin,
           rank() over (order by gr0.raw - gr0.penalty desc) as rnk
    from gr0
  ),
  grm as (
    select gr.*, (case gr.rnk when 1 then 3 when 2 then 2 when 3 then 1.5 else 1 end)::numeric as mult
    from gr
  ),
  pay as (
    select inv.name, inv.own, inv.invested, inv.student,
           coalesce((select sum(va.amount * va.weight * grm.mult) from va join grm on grm.grp = va.grp
                     where va.name_key = inv.name_key), 0) as payout,
           round((select sum(va.amount * va.delay_ms) from va where va.name_key = inv.name_key)::numeric
                 / inv.invested) as delay
    from inv
    where inv.invested > 0
  ),
  pr as (
    select pay.*, rank() over (order by pay.payout desc, pay.delay asc) as rnk from pay where pay.student
  )
  select jsonb_build_object(
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
               'group', grm.grp, 'raw', grm.raw, 'penalty', grm.penalty, 'final', grm.fin,
               'rank', grm.rnk, 'multiplier', grm.mult,
               'deductions', coalesce((
                 select jsonb_agg(jsonb_build_object('name', d.name, 'unspent', d.unspent)
                                  order by d.unspent desc, d.name collate "C")
                 from ded d where d.grp = grm.grp), '[]'::jsonb))
             order by grm.rnk, grm.ord)
      from grm), '[]'::jsonb),
    'investors', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', pr.name, 'group', pr.own, 'invested', pr.invested,
               'unspent', 1000000 - pr.invested, 'payout', pr.payout, 'delayMs', pr.delay, 'rank', pr.rnk)
             order by pr.rnk, pr.name collate "C")
      from pr), '[]'::jsonb),
    'others', coalesce((
      select jsonb_agg(jsonb_build_object('name', pay.name, 'invested', pay.invested, 'payout', pay.payout)
             order by pay.payout desc, pay.name collate "C")
      from pay where not pay.student), '[]'::jsonb),
    'rocket', coalesce((select jsonb_agg(grm.grp order by grm.ord) from grm where grm.rnk = 1), '[]'::jsonb),
    'stockGods', coalesce((select jsonb_agg(pr.name order by pr.name collate "C") from pr where pr.rnk = 1), '[]'::jsonb)
  )
$$;

-- 去掉學生姓名明細，給大螢幕與學生端
create or replace function invest.public_results(r jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'groups', coalesce((select jsonb_agg(e.g - 'deductions' order by e.ord)
                        from jsonb_array_elements(r -> 'groups') with ordinality as e(g, ord)), '[]'::jsonb),
    'rocket', r -> 'rocket',
    'stockGods', coalesce((select jsonb_agg(jsonb_build_object('name', i ->> 'name', 'group', i ->> 'group', 'payout', i -> 'payout')
                                            order by (i ->> 'name') collate "C")
                           from jsonb_array_elements(r -> 'investors') as i
                           where (i ->> 'rank')::int = 1), '[]'::jsonb),
    'investorCount', jsonb_array_length(r -> 'investors')
  )
$$;

-- 記錄走勢點；一秒內的連續變動合併成一點
create or replace function invest.record_point(c text, p_mark text) returns void
language plpgsql volatile set search_path = '' as $$
declare
  tot jsonb;
  last_id bigint;
  last_t timestamptz;
  last_mark text;
begin
  if p_mark = 'close' then
    select coalesce(jsonb_object_agg(g ->> 'group', g -> 'final'), '{}'::jsonb) into tot
    from invest.course cs, jsonb_array_elements(cs.results -> 'groups') g
    where cs.course = c;
  else
    tot := invest.totals(c);
  end if;
  select h.id, h.t, h.mark into last_id, last_t, last_mark
  from invest.history h where h.course = c order by h.id desc limit 1;
  if p_mark is null and last_id is not null and last_mark is null and now() - last_t < interval '1 second' then
    update invest.history set totals = tot where id = last_id;
  else
    insert into invest.history (course, t, totals, mark) values (c, now(), tot, p_mark);
  end if;
end
$$;

create or replace function invest.do_close(c text, p_at timestamptz) returns void
language plpgsql volatile set search_path = '' as $$
declare
  cs invest.course;
begin
  select * into cs from invest.course where course = c for update;
  update invest.course
     set closed_from = case when cs.phase = 'dark' then 'dark' else 'open' end,
         dark_left_ms = case when cs.phase = 'dark' then greatest(0, invest.ms(cs.dark_ends_at) - invest.ms(p_at)) end,
         results = invest.compute_results(c),
         phase = 'closed',
         closed_at = p_at
   where course = c;
  perform invest.record_point(c, 'close');
  perform invest.bump();
end
$$;

-- 暗盤時間到就封盤（每次有人查詢狀態或下單時都會檢查）；回傳是否已封盤
create or replace function invest.expire_due(c text) returns boolean
language plpgsql volatile set search_path = '' as $$
declare
  cs invest.course;
begin
  select * into cs from invest.course where course = c;
  if cs.phase = 'dark' and now() >= cs.dark_ends_at then
    select * into cs from invest.course where course = c for update;
    if cs.phase = 'dark' and now() >= cs.dark_ends_at then
      perform invest.do_close(c, cs.dark_ends_at);
      return true;
    end if;
  end if;
  return cs.phase = 'closed';
end
$$;

-- 某組的公開資訊：slogan、封面版本、組員姓名（頒獎與暗盤輪播會顯示）
create or replace function invest.group_public(c text, g text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'slogan', coalesce((select gi.slogan from invest.group_info gi where gi.course = c and gi.grp = g), ''),
    'coverVer', (select case when gi.cover is not null then gi.cover_ver end from invest.group_info gi where gi.course = c and gi.grp = g),
    'memberNames', coalesce((select jsonb_agg(r.name order by r.name collate "C") from invest.roster r where r.course = c and r.grp = g), '[]'::jsonb)
  )
$$;

create or replace function invest.public_course(c text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  cs invest.course;
  hidden boolean;
  shown boolean;
  tot jsonb;
  v_groups jsonb;
begin
  select * into cs from invest.course where course = c;
  -- 暗盤、以及封盤後頒獎揭曉前：各組金額與名次都不公開
  shown := cs.phase = 'closed' and cs.results is not null and cs.revealed;
  hidden := cs.phase = 'dark' or (cs.phase = 'closed' and not shown);
  if shown then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', g ->> 'group', 'total', g -> 'final', 'rank', g -> 'rank',
             'members', (select count(*) from invest.roster ro where ro.course = c and ro.grp = g ->> 'group'))
             || invest.group_public(c, g ->> 'group')
           order by invest.group_num(g ->> 'group') nulls last, (g ->> 'group') collate "C"), '[]'::jsonb)
      into v_groups
      from jsonb_array_elements(cs.results -> 'groups') g;
  else
    tot := invest.totals(c);
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', x.grp,
             'total', case when hidden then null else x.v end,
             'rank', case when hidden then null else x.rk end,
             'members', x.cnt) || invest.group_public(c, x.grp)
           order by x.ord), '[]'::jsonb)
      into v_groups
      from (
        select u.grp, u.ord, (tot ->> u.grp)::numeric as v,
               rank() over (order by (tot ->> u.grp)::numeric desc) as rk,
               (select count(*) from invest.roster ro where ro.course = c and ro.grp = u.grp) as cnt
        from unnest(invest.groups(c)) with ordinality as u(grp, ord)
      ) x;
  end if;
  return jsonb_build_object(
    'course', c,
    'phase', cs.phase,
    'revealed', shown,
    'openedAt', invest.ms(cs.opened_at),
    'darkAt', invest.ms(cs.dark_at),
    'darkEndsAt', invest.ms(cs.dark_ends_at),
    'closedAt', invest.ms(cs.closed_at),
    'presenting', case when cs.presenting is not null and cs.phase <> 'closed' then
                    jsonb_build_object('group', cs.presenting, 'startedAt', invest.ms(cs.presenting_at)) end,
    'presented', cs.presented,
    'angel', case when cs.angel_revealed then cs.angel end,
    'groups', v_groups,
    'students', (select count(*) from invest.roster r where r.course = c),
    'joined', (select count(*) from invest.roster r where r.course = c and invest.is_present(c, r.name_key)),
    'fullyInvested', (
      select count(*) from invest.roster r
      where r.course = c
        and (select coalesce(sum(a.amount), 0) from invest.alloc a where a.course = c and a.name_key = r.name_key) = 1000000),
    'results', case when shown then invest.public_results(cs.results) end
  );
end
$$;

-- ---------- 大螢幕舞台：頒獎與業師總結 ----------

-- 頒獎的每一步（依兩場的封盤結果自動產生）：開場 → 每場（開場 → 第 3、2 名 → 第 1 名一飛沖天 → 股神 → 完整排名）→ 結束
create or replace function invest.award_steps() returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  steps jsonb := jsonb_build_array(jsonb_build_object('kind', 'title', 'label', '頒獎典禮開場'));
  c text;
  cs invest.course;
  r int;
begin
  foreach c in array array['wed', 'thu'] loop
    select * into cs from invest.course co where co.course = c;
    if cs.phase <> 'closed' or cs.results is null then continue; end if;
    steps := steps || jsonb_build_array(jsonb_build_object('kind', 'intro', 'course', c, 'label', invest.course_label(c) || '：開場'));
    for r in
      select distinct (g ->> 'rank')::int as rk from jsonb_array_elements(cs.results -> 'groups') g
      where (g ->> 'rank')::int <= 3 order by rk desc
    loop
      steps := steps || jsonb_build_array(jsonb_build_object(
        'kind', case when r = 1 then 'rocket' else 'podium' end, 'course', c, 'rank', r,
        'label', invest.course_label(c) || case when r = 1 then '：第 1 名・一飛沖天獎' else format('：第 %s 名', r) end));
    end loop;
    steps := steps || jsonb_build_array(
      jsonb_build_object('kind', 'stockgod', 'course', c, 'label', invest.course_label(c) || '：股神獎'),
      jsonb_build_object('kind', 'angel', 'course', c, 'label', invest.course_label(c) || '：TNDA 天使投資獎'),
      jsonb_build_object('kind', 'ranking', 'course', c, 'label', invest.course_label(c) || '：完整排名'));
  end loop;
  return steps || jsonb_build_array(jsonb_build_object('kind', 'finale', 'label', '頒獎結束'));
end
$$;

create or replace function invest.award_scene(st jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  c text := st ->> 'course';
  cs invest.course;
  v jsonb := st;
begin
  if c is not null then select * into cs from invest.course co where co.course = c; end if;
  if st ->> 'kind' = 'intro' then
    v := v || jsonb_build_object(
      'groups', jsonb_array_length(cs.results -> 'groups'),
      'investors', jsonb_array_length(cs.results -> 'investors'),
      'students', (select count(*) from invest.roster r where r.course = c));
  elsif st ->> 'kind' in ('podium', 'rocket') then
    v := v || jsonb_build_object('groups', coalesce((
      select jsonb_agg((g - 'deductions') || invest.group_public(c, g ->> 'group')
                       order by invest.group_num(g ->> 'group') nulls last)
      from jsonb_array_elements(cs.results -> 'groups') g
      where (g ->> 'rank')::int = (st ->> 'rank')::int), '[]'::jsonb));
  elsif st ->> 'kind' = 'stockgod' then
    v := v || jsonb_build_object(
      'winners', invest.public_results(cs.results) -> 'stockGods',
      'investors', jsonb_array_length(cs.results -> 'investors'));
  elsif st ->> 'kind' = 'angel' then
    -- 還沒選得獎組別時 groups 是空的（大螢幕顯示「業師評分中」）
    v := v || jsonb_build_object('groups', coalesce((
      select jsonb_agg(jsonb_build_object('group', a.grp)
                       || coalesce((select (g - 'deductions') from jsonb_array_elements(cs.results -> 'groups') g
                                    where g ->> 'group' = a.grp), '{}'::jsonb)
                       || invest.group_public(c, a.grp)
                       order by invest.group_num(a.grp) nulls last)
      from jsonb_array_elements_text(cs.angel) as a(grp)), '[]'::jsonb));
  elsif st ->> 'kind' = 'ranking' then
    v := v || jsonb_build_object('results', invest.public_results(cs.results));
  elsif st ->> 'kind' = 'finale' then
    v := v || jsonb_build_object('courses', coalesce((
      select jsonb_agg(jsonb_build_object(
               'course', co.course,
               'rocket', co.results -> 'rocket',
               'stockGods', invest.public_results(co.results) -> 'stockGods',
               'angel', case when co.angel_revealed then co.angel else '[]'::jsonb end) order by co.course desc)
      from invest.course co where co.phase = 'closed' and co.results is not null and co.revealed), '[]'::jsonb));
  end if;
  return v;
end
$$;

-- 業師總結「數字回顧」頁
create or replace function invest.recap() returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'course', co.course,
           'students', (select count(*) from invest.roster r where r.course = co.course),
           'joined', (select count(*) from invest.roster r where r.course = co.course and invest.is_present(co.course, r.name_key)),
           'invested', (select coalesce(sum(a.amount), 0) from invest.alloc a where a.course = co.course),
           'investors', (select count(distinct a.name_key) from invest.alloc a where a.course = co.course),
           'rocket', case when co.revealed then co.results -> 'rocket' end,
           'stockGods', case when co.revealed then invest.public_results(co.results) -> 'stockGods' end,
           'angel', case when co.angel_revealed then co.angel end)
         order by co.course desc), '[]'::jsonb)
  from invest.course co
$$;

create or replace function invest.slide_scene(sl invest.slide) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'kind', sl.kind, 'id', sl.id, 'title', sl.title, 'subtitle', sl.subtitle, 'body', sl.body,
    'imageVer', case when sl.image is not null then sl.image_ver end,
    'label', coalesce(nullif(sl.title, ''), case sl.kind when 'recap' then '數字回顧' else '投影片' end))
  || case when sl.kind = 'recap' then jsonb_build_object('recap', invest.recap()) else '{}'::jsonb end
$$;

-- 大螢幕目前要顯示的內容（公開）
create or replace function invest.stage_public() returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  cfg invest.config;
  steps jsonb;
  n int;
  i int;
  sl invest.slide;
begin
  select * into cfg from invest.config c where c.id = 1;
  if cfg.stage_mode = 'awards' then
    steps := invest.award_steps();
    n := jsonb_array_length(steps);
    i := least(greatest(cfg.stage_step, 0), n - 1);
    return jsonb_build_object('mode', 'awards', 'step', i, 'total', n, 'scene', invest.award_scene(steps -> i));
  elsif cfg.stage_mode = 'summary' then
    select count(*) into n from invest.slide;
    if n = 0 then return jsonb_build_object('mode', 'market', 'step', 0, 'total', 0, 'scene', null); end if;
    i := least(greatest(cfg.stage_step, 0), n - 1);
    select * into sl from invest.slide order by pos, id offset i limit 1;
    return jsonb_build_object('mode', 'summary', 'step', i, 'total', n, 'scene', invest.slide_scene(sl));
  end if;
  return jsonb_build_object('mode', 'market', 'step', 0, 'total', 0, 'scene', null);
end
$$;

-- 管理員看的舞台狀態：多了每一步的名稱（「下一步：…」）
create or replace function invest.admin_stage() returns jsonb
language sql stable set search_path = '' as $$
  select invest.stage_public() || jsonb_build_object(
    'awardLabels', (select coalesce(jsonb_agg(s ->> 'label' order by o), '[]'::jsonb)
                    from jsonb_array_elements(invest.award_steps()) with ordinality as x(s, o)),
    'slideLabels', (select coalesce(jsonb_agg(invest.slide_scene(sl) ->> 'label' order by sl.pos, sl.id), '[]'::jsonb)
                    from invest.slide sl))
$$;

-- 頒獎走到某場的「第 1 名」那一步，該場結果就公開（大螢幕、學生手機同步）；業師總結時全部公開
create or replace function invest.apply_reveal() returns void
language plpgsql volatile set search_path = '' as $$
declare
  cfg invest.config;
begin
  select * into cfg from invest.config c where c.id = 1;
  if cfg.stage_mode = 'summary' then
    update invest.course set revealed = true where phase = 'closed' and results is not null and not revealed;
    update invest.course set angel_revealed = true
     where phase = 'closed' and results is not null and not angel_revealed and jsonb_array_length(angel) > 0;
  elsif cfg.stage_mode = 'awards' then
    update invest.course co set revealed = true
     where co.phase = 'closed' and co.results is not null and not co.revealed
       and exists (select 1 from jsonb_array_elements(invest.award_steps()) with ordinality as x(s, o)
                   where x.s ->> 'kind' = 'rocket' and x.s ->> 'course' = co.course and x.o - 1 <= cfg.stage_step);
    -- 天使投資獎：走到（或走過）這一場的天使投資獎那一步，且已選了得獎組別，才公開
    update invest.course co set angel_revealed = true
     where co.phase = 'closed' and co.results is not null and not co.angel_revealed and jsonb_array_length(co.angel) > 0
       and exists (select 1 from jsonb_array_elements(invest.award_steps()) with ordinality as x(s, o)
                   where x.s ->> 'kind' = 'angel' and x.s ->> 'course' = co.course and x.o - 1 <= cfg.stage_step);
  end if;
end
$$;

create or replace function invest.public_state() returns jsonb
language sql volatile set search_path = '' as $$
  select jsonb_build_object(
    'version', cfg.version,
    'now', invest.ms(clock_timestamp()),
    'active', cfg.active,
    'darkMs', cfg.dark_ms,
    'courses', jsonb_build_object('wed', invest.public_course('wed'), 'thu', invest.public_course('thu')),
    'stage', invest.stage_public()
  )
  from invest.config cfg where cfg.id = 1
$$;

-- 某個人的資料（只有自己的投資）。學生：名單上有的場次；業師、老師、訪客：兩場都有（沒有自己的組）
create or replace function invest.me(k text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  res jsonb := '{}'::jsonb;
  c text;
  v_role text := invest.role_of(k);
  v_own text;
  v_name text;
  cs invest.course;
  v_roster_name text;
  v_alloc jsonb;
  v_weighted jsonb;
  v_inv numeric;
  v_result jsonb;
  v_ded numeric;
  inv jsonb;
begin
  select a.name into v_name from invest.account a where a.name_key = k;
  foreach c in array array['wed', 'thu'] loop
    v_own := null;
    if v_role = 'student' then
      -- 注意：查不到時 select into 會把變數設成 null，所以名字另外接，不能直接蓋掉 v_name
      select ro.grp, ro.name into v_own, v_roster_name from invest.roster ro where ro.course = c and ro.name_key = k;
      if not found then continue; end if;
      v_name := coalesce(v_name, v_roster_name);
    end if;
    select * into cs from invest.course co where co.course = c;
    select coalesce(jsonb_object_agg(a.grp, a.amount), '{}'::jsonb), coalesce(sum(a.amount), 0)
      into v_alloc, v_inv
      from invest.alloc a where a.course = c and a.name_key = k;
    select coalesce(jsonb_object_agg(w.grp, w.v), '{}'::jsonb) into v_weighted
      from (select lt.grp, sum(lt.amount * lt.weight) as v from invest.lot lt
            where lt.course = c and lt.name_key = k group by lt.grp) w;
    v_result := null;
    v_ded := null;
    -- 頒獎揭曉該場第一名之後才公開
    if cs.phase = 'closed' and cs.results is not null and cs.revealed then
      if v_role = 'student' then
        select i into inv from jsonb_array_elements(cs.results -> 'investors') i where i ->> 'name' = v_name;
        if inv is not null then
          v_result := jsonb_build_object('payout', inv -> 'payout', 'rank', inv -> 'rank',
                                         'of', jsonb_array_length(cs.results -> 'investors'));
        end if;
        select coalesce((
          select (d ->> 'unspent')::numeric
          from jsonb_array_elements(cs.results -> 'groups') g, jsonb_array_elements(g -> 'deductions') d
          where g ->> 'group' = v_own and d ->> 'name' = v_name), 0) into v_ded;
      else
        select i into inv from jsonb_array_elements(cs.results -> 'others') i where i ->> 'name' = v_name;
        if inv is not null then
          v_result := jsonb_build_object('payout', inv -> 'payout', 'rank', null, 'of', null);
        end if;
      end if;
    end if;
    res := res || jsonb_build_object(c, jsonb_build_object(
      'course', c, 'group', v_own, 'alloc', v_alloc, 'weighted', v_weighted, 'invested', v_inv,
      'remaining', 1000000 - v_inv, 'result', v_result, 'deducted', v_ded,
      'awaiting', cs.phase = 'closed' and not cs.revealed));
  end loop;
  return jsonb_build_object('name', v_name, 'role', v_role, 'courses', res);
end
$$;

create or replace function invest.visible_history(c text, after_id bigint) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'id', h.id, 't', invest.ms(h.t), 'totals', h.totals, 'mark', h.mark)) order by h.id), '[]'::jsonb)
  from invest.history h
  join invest.course cs on cs.course = h.course
  where h.course = c
    and h.id >= coalesce(after_id, 0)
    and (cs.phase not in ('dark', 'closed') or cs.revealed or cs.dark_history_id is null or h.id <= cs.dark_history_id)
    and (h.mark is distinct from 'close' or cs.revealed)
$$;

create or replace function invest.admin_course(c text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'phase', cs.phase,
    'groups', to_jsonb(invest.groups(c)),
    'angel', cs.angel,
    'students', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', s.name, 'group', s.grp, 'invested', s.inv, 'remaining', 1000000 - s.inv,
               'joined', invest.is_present(c, s.name_key))
             order by s.name collate "C")
      from (
        select r.name, r.grp, r.name_key,
               (select coalesce(sum(a.amount), 0) from invest.alloc a where a.course = c and a.name_key = r.name_key) as inv
        from invest.roster r where r.course = c
      ) s), '[]'::jsonb),
    'reopenTo', case when cs.phase = 'closed' then
                  case when cs.closed_from = 'dark' and coalesce(cs.dark_left_ms, 0) > 0 then 'dark' else 'open' end
                end,
    'reopenDarkLeftMs', case when cs.phase = 'closed' and cs.closed_from = 'dark' then cs.dark_left_ms end
  )
  from invest.course cs where cs.course = c
$$;

create or replace function invest.admin_overview() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'active', cfg.active,
    'darkMs', cfg.dark_ms,
    'roster', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'course', r.course, 'group', r.grp)
                       order by r.course desc, r.name collate "C")
      from invest.roster r), '[]'::jsonb),
    'courses', jsonb_build_object('wed', invest.admin_course('wed'), 'thu', invest.admin_course('thu')),
    'board', jsonb_build_object(
      'visible', cfg.board_visible,
      'wed', (select jsonb_build_object('students', count(distinct a.name_key), 'weeks', count(distinct a.week))
              from invest.attendance a where a.course = 'wed'),
      'thu', (select jsonb_build_object('students', count(distinct a.name_key), 'weeks', count(distinct a.week))
              from invest.attendance a where a.course = 'thu')),
    'stage', invest.admin_stage(),
    'groupInfo', jsonb_build_object(
      'wed', (select coalesce(jsonb_agg(jsonb_build_object('group', u.g, 'slogan', coalesce(gi.slogan, ''),
                'coverVer', case when gi.cover is not null then gi.cover_ver end) order by u.o), '[]'::jsonb)
              from unnest(invest.groups('wed')) with ordinality as u(g, o)
              left join invest.group_info gi on gi.course = 'wed' and gi.grp = u.g),
      'thu', (select coalesce(jsonb_agg(jsonb_build_object('group', u.g, 'slogan', coalesce(gi.slogan, ''),
                'coverVer', case when gi.cover is not null then gi.cover_ver end) order by u.o), '[]'::jsonb)
              from unnest(invest.groups('thu')) with ordinality as u(g, o)
              left join invest.group_info gi on gi.course = 'thu' and gi.grp = u.g)),
    'slides', (select coalesce(jsonb_agg(jsonb_build_object('id', sl.id, 'kind', sl.kind, 'title', sl.title,
                 'subtitle', sl.subtitle, 'body', sl.body,
                 'imageVer', case when sl.image is not null then sl.image_ver end) order by sl.pos, sl.id), '[]'::jsonb)
               from invest.slide sl),
    'accounts', (select coalesce(jsonb_agg(jsonb_build_object('name', a.name, 'role', a.role,
                   'hasPassword', a.pw_hash is not null, 'locked', a.locked_until is not null and a.locked_until > now())
                   order by case a.role when 'student' then 0 when 'mentor' then 1 else 2 end, a.name collate "C"), '[]'::jsonb)
                 from invest.account a
                 where a.role <> 'student' or exists (select 1 from invest.roster r where r.name_key = a.name_key))
  )
  from invest.config cfg where cfg.id = 1
$$;

-- 出席率行情：目前場次每位學生「每週累計出席率」的走勢
-- 出席 = 參＋遲；應到 = 參＋遲＋假＋缺（請假也算未出席）。還沒有任何應到的週次為 null。
create or replace function invest.attendance_board(c text) returns jsonb
language sql stable set search_path = '' as $$
  with w as (
    select coalesce(array_agg(distinct a.week order by a.week), '{}') as weeks
    from invest.attendance a where a.course = c
  ),
  r as (select ro.name_key, ro.name, ro.grp from invest.roster ro where ro.course = c),
  grid as (
    select r.name_key, wk.week, a.status
    from r cross join w cross join unnest(w.weeks) as wk(week)
    left join invest.attendance a on a.course = c and a.name_key = r.name_key and a.week = wk.week
  ),
  cum as (
    select g.name_key, g.week,
           sum(case when g.status in ('present', 'late') then 1 else 0 end) over (partition by g.name_key order by g.week) as att,
           sum(case when g.status in ('present', 'late', 'leave', 'absent') then 1 else 0 end) over (partition by g.name_key order by g.week) as cnt
    from grid g
  ),
  ser as (
    select cu.name_key,
           jsonb_agg(case when cu.cnt > 0 then round(cu.att * 1000.0 / cu.cnt) / 10 end order by cu.week) as series,
           (array_agg(cu.att order by cu.week desc))[1] as att,
           (array_agg(cu.cnt order by cu.week desc))[1] as cnt
    from cum cu group by cu.name_key
  )
  select jsonb_build_object(
    'course', c,
    'weeks', to_jsonb(w.weeks),
    -- 還沒匯入任何出席資料時不回傳姓名
    'rows', case when coalesce(array_length(w.weeks, 1), 0) = 0 then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'group', r.grp, 'series', s.series,
                                          'attended', s.att, 'total', s.cnt)
                       order by invest.group_num(r.grp) nulls last, r.grp collate "C", r.name collate "C")
      from r join ser s using (name_key)), '[]'::jsonb) end
  )
  from w
$$;

-- =====================================================================
-- 對外 RPC（網頁呼叫）：成功回傳資料；業務錯誤回傳 {"error": 代碼, "message": 說明}
-- =====================================================================

-- 公開狀態。since = 前端手上的版本；沒變就只回 {unchanged: true}
create or replace function public.invest_state(since bigint default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_since bigint := since;
  v_version bigint;
begin
  perform invest.expire_due('wed');
  perform invest.expire_due('thu');
  select cfg.version into v_version from invest.config cfg where cfg.id = 1;
  if v_since is not null and v_since = v_version then
    return jsonb_build_object('unchanged', true, 'version', v_version, 'now', invest.ms(clock_timestamp()));
  end if;
  return invest.public_state();
end
$$;

-- 走勢（暗盤期間不含暗盤後的點）。after_* = 前端已有的最後一點 id（含該點，因為最後一點可能被合併更新）
create or replace function public.invest_history(after_wed bigint default 0, after_thu bigint default 0) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_wed bigint := after_wed;
  v_thu bigint := after_thu;
begin
  perform invest.expire_due('wed');
  perform invest.expire_due('thu');
  return jsonb_build_object('wed', invest.visible_history('wed', v_wed), 'thu', invest.visible_history('thu', v_thu));
end
$$;

-- 登入：姓名＋密碼（學生＝生日後四碼；業師、老師、訪客預設 TNDA）→ 發給手機一個憑證 token
-- 舊版用姓名直接登入的函式移除（參數名稱改了，要先 drop）
drop function if exists public.invest_me(text);
drop function if exists public.invest_invest(text, text, text, numeric);

create or replace function public.invest_login(name text, password text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_input text := name;
  v_key text := invest.name_key(name);
  v_pw text := password;
  acc invest.account;
  v_token text;
  v_active text;
begin
  if length(coalesce(v_input, '')) > 100 or length(coalesce(v_pw, '')) > 100 then
    return invest.err('bad_login', '姓名或密碼太長');
  end if;
  select * into acc from invest.account a where a.name_key = v_key for update;
  if not found or (acc.role = 'student' and not exists (select 1 from invest.roster r where r.name_key = v_key)) then
    return invest.err('not_in_roster', format('名單中找不到「%s」，請確認姓名或洽助教', left(invest.norm_name(v_input), 40)));
  end if;
  if acc.pw_hash is null then
    return invest.err('no_password', '這個帳號還沒設定密碼，請洽助教');
  end if;
  if acc.locked_until is not null and acc.locked_until > now() then
    return invest.err('locked', '密碼錯太多次，請 1 分鐘後再試，或洽助教');
  end if;
  if invest.pw_hash(acc.salt, coalesce(v_pw, '')) <> acc.pw_hash then
    update invest.account
       set fails = case when acc.fails + 1 >= 5 then 0 else acc.fails + 1 end,
           locked_until = case when acc.fails + 1 >= 5 then now() + interval '1 minute' end
     where name_key = v_key;
    return invest.err('bad_password',
      case when acc.role = 'student' then '密碼錯誤：學生密碼是生日後四碼（例如 4 月 3 日 → 0403）'
           else '密碼錯誤，請洽助教' end);
  end if;
  update invest.account set fails = 0, locked_until = null where name_key = v_key;
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into invest.session (token, name_key) values (v_token, v_key);
  select cfg.active into v_active from invest.config cfg where cfg.id = 1;
  perform invest.expire_due(v_active);
  perform invest.mark_present(v_active, v_key);
  return jsonb_build_object('token', v_token, 'me', invest.me(v_key));
end
$$;

-- 重新整理自己的資料；同時記錄「出席目前這一場」（手機每 15 秒一次）
create or replace function public.invest_me(token text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_key text := invest.session_key(token);
  v_active text;
begin
  if v_key is null then return invest.err('bad_session', '登入已失效，請重新登入'); end if;
  select cfg.active into v_active from invest.config cfg where cfg.id = 1;
  perform invest.expire_due(v_active);
  perform invest.mark_present(v_active, v_key);
  return invest.me(v_key);
end
$$;

-- 下單：把某組的投資設成 amount（絕對值）。所有規則在這裡驗證
create or replace function public.invest_invest(token text, course text, grp text, amount numeric) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_key text := invest.session_key(token);
  v_course text := course;
  v_grp text := grp;
  v_amount numeric := amount;
  v_role text;
  v_own text;
  cs invest.course;
  v_others numeric;
  v_current numeric;
begin
  if v_key is null then return invest.err('bad_session', '登入已失效，請重新登入'); end if;
  if v_course is null or v_course not in ('wed', 'thu') then
    return invest.err('bad_course', '場次錯誤');
  end if;
  v_role := invest.role_of(v_key);
  if v_role = 'student' then
    if not exists (select 1 from invest.roster r where r.name_key = v_key) then
      return invest.err('not_in_roster', '名單中找不到這個名字，請確認姓名或洽助教');
    end if;
    select r.grp into v_own from invest.roster r where r.course = v_course and r.name_key = v_key;
    if v_own is null then
      return invest.err('not_in_course', format('你不在%s的名單中', invest.course_label(v_course)));
    end if;
  end if;

  perform invest.expire_due(v_course);
  -- 鎖住這一場：同一場的下單一筆一筆處理，餘額不會被同時扣兩次
  select * into cs from invest.course co where co.course = v_course for update;

  if cs.phase = 'pending' then return invest.err('not_open', '還沒開盤，開盤後才能投資'); end if;
  if cs.phase = 'closed' then return invest.err('closed', '已經封盤，不能再調整'); end if;
  if v_grp is null or not (v_grp = any (invest.groups(v_course))) then
    return invest.err('unknown_group', '沒有這個組別');
  end if;
  if v_own is not null and v_grp = v_own then return invest.err('own_group', '不能投資自己那組'); end if;
  if v_amount is null or v_amount < 0 or v_amount <> trunc(v_amount) then
    return invest.err('bad_amount', '金額必須是 0 以上的整數');
  end if;

  select coalesce(sum(a.amount), 0) into v_others
    from invest.alloc a where a.course = v_course and a.name_key = v_key and a.grp <> v_grp;
  if v_others + v_amount > 1000000 then return invest.err('over_budget', '餘額不足'); end if;

  select coalesce(max(a.amount), 0) into v_current
    from invest.alloc a where a.course = v_course and a.name_key = v_key and a.grp = v_grp;
  if v_current <> v_amount then
    if v_amount = 0 then
      delete from invest.alloc a where a.course = v_course and a.name_key = v_key and a.grp = v_grp;
    else
      insert into invest.alloc (course, name_key, grp, amount) values (v_course, v_key, v_grp, v_amount::bigint)
      on conflict on constraint alloc_pkey do update set amount = excluded.amount;
    end if;
    if v_role = 'student' then
      insert into invest.presence (course, name_key) values (v_course, v_key) on conflict do nothing;
    end if;
    perform invest.record_point(v_course, null);
    perform invest.bump();
  end if;
  return invest.me(v_key);
end
$$;

-- ---------- 管理員（每次都驗證密碼） ----------

create or replace function public.invest_admin_check(pw text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when invest.check_admin(pw) then jsonb_build_object('ok', true)
              else invest.err('unauthorized', '管理員密碼錯誤') end
$$;

create or replace function public.invest_admin_overview(pw text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not invest.check_admin(pw) then return invest.err('unauthorized', '管理員密碼錯誤'); end if;
  perform invest.expire_due('wed');
  perform invest.expire_due('thu');
  return invest.admin_overview();
end
$$;

create or replace function public.invest_admin_set_active(pw text, course text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_course text := course;
begin
  if not invest.check_admin(pw) then return invest.err('unauthorized', '管理員密碼錯誤'); end if;
  if v_course is null or v_course not in ('wed', 'thu') then return invest.err('bad_course', '場次錯誤'); end if;
  update invest.config set active = v_course where id = 1;
  perform invest.bump();
  return invest.admin_overview();
end
$$;

-- action：open 開盤、dark 進入暗盤、close 立即封盤、reopen 取消封盤
create or replace function public.invest_admin_phase(pw text, course text, action text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_course text := course;
  v_action text := action;
  cs invest.course;
  v_dark_ms int;
  v_last record;
begin
  if not invest.check_admin(pw) then return invest.err('unauthorized', '管理員密碼錯誤'); end if;
  if v_course is null or v_course not in ('wed', 'thu') then return invest.err('bad_course', '場次錯誤'); end if;
  perform invest.expire_due(v_course);
  select * into cs from invest.course co where co.course = v_course for update;

  if v_action = 'open' then
    if cs.phase <> 'pending' then return invest.err('bad_phase', '只有「未開盤」時可以開盤'); end if;
    if coalesce(array_length(invest.groups(v_course), 1), 0) < 2 then
      return invest.err('no_groups', '名單裡至少要有兩組才能開盤');
    end if;
    update invest.course set phase = 'open', opened_at = now() where invest.course.course = v_course;
    perform invest.record_point(v_course, 'open');

  elsif v_action = 'dark' then
    if cs.phase <> 'open' then return invest.err('bad_phase', '只有「開盤中」可以進入暗盤'); end if;
    perform invest.record_point(v_course, 'dark');
    select cfg.dark_ms into v_dark_ms from invest.config cfg where cfg.id = 1;
    update invest.course
       set phase = 'dark',
           dark_at = now(),
           dark_ends_at = now() + make_interval(secs => v_dark_ms / 1000.0),
           dark_history_id = (select max(h.id) from invest.history h where h.course = v_course)
     where invest.course.course = v_course;

  elsif v_action = 'close' then
    if cs.phase not in ('open', 'dark') then return invest.err('bad_phase', '只有「開盤中」或「暗盤」可以封盤'); end if;
    perform invest.do_close(v_course, now());
    return invest.admin_overview();

  elsif v_action = 'reopen' then
    -- 取消封盤（誤按時用）：撤回結算、保留投資。暗盤中手動封盤且還有剩餘時間 → 回到暗盤；否則回到開盤中
    if cs.phase <> 'closed' then return invest.err('bad_phase', '只有「已封盤」可以取消封盤'); end if;
    select h.id, h.mark into v_last from invest.history h where h.course = v_course order by h.id desc limit 1;
    if v_last.mark = 'close' then delete from invest.history h where h.id = v_last.id; end if;
    if cs.closed_from = 'dark' and coalesce(cs.dark_left_ms, 0) > 0 then
      update invest.course
         set phase = 'dark',
             dark_ends_at = now() + make_interval(secs => cs.dark_left_ms / 1000.0),
             results = null, closed_at = null, closed_from = null, dark_left_ms = null, revealed = false,
             angel_revealed = false
       where invest.course.course = v_course;
    else
      update invest.course
         set phase = 'open', dark_at = null, dark_ends_at = null, dark_history_id = null,
             results = null, closed_at = null, closed_from = null, dark_left_ms = null, revealed = false,
             angel_revealed = false
       where invest.course.course = v_course;
    end if;

  else
    return invest.err('bad_action', '未知的操作');
  end if;

  perform invest.bump();
  return invest.admin_overview();
end
$$;

-- 某組上台：開始報告（三個時段自動計時）。grp 傳 null 或空字串 = 停止計時（沒有組在報告）
create or replace function public.invest_admin_present(pw text, course text, grp text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_course text := course;
  v_grp text := nullif(btrim(coalesce(grp, '')), '');
  cs invest.course;
begin
  if not invest.check_admin(pw) then return invest.err('unauthorized', '管理員密碼錯誤'); end if;
  if v_course is null or v_course not in ('wed', 'thu') then return invest.err('bad_course', '場次錯誤'); end if;
  perform invest.expire_due(v_course);
  select * into cs from invest.course co where co.course = v_course for update;
  if cs.phase = 'closed' then return invest.err('bad_phase', '已封盤，不能再開始報告'); end if;
  if v_grp is not null and not (v_grp = any (invest.groups(v_course))) then
    return invest.err('unknown_group', '沒有這個組別');
  end if;
  if v_grp is null then
    update invest.course set presenting = null, presenting_at = null where invest.course.course = v_course;
  else
    update invest.course
       set presenting = v_grp, presenting_at = now(),
           presented = cs.presented || jsonb_build_object(v_grp, invest.ms(now()))
     where invest.course.course = v_course;
  end if;
  perform invest.bump();
  return invest.admin_overview();
end
$$;

-- TNDA 天使投資獎（業師評分）：選這一場的得獎組別（可複選＝並列；傳空陣列＝清除）
create or replace function public.invest_admin_angel(pw text, course text, groups jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_course text := course;
  v_groups jsonb := coalesce(groups, '[]'::jsonb);
  g text;
  v_clean jsonb := '[]'::jsonb;
begin
  if not invest.check_admin(pw) then return invest.err('unauthorized', '管理員密碼錯誤'); end if;
  if v_course is null or v_course not in ('wed', 'thu') then return invest.err('bad_course', '場次錯誤'); end if;
  if jsonb_typeof(v_groups) <> 'array' then return invest.err('bad_groups', '組別格式錯誤'); end if;
  for g in select jsonb_array_elements_text(v_groups) loop
    if not (g = any (invest.groups(v_course))) then return invest.err('unknown_group', '沒有這個組別'); end if;
    if not v_clean ? g then v_clean := v_clean || to_jsonb(g); end if;
  end loop;
  perform 1 from invest.course co where co.course = v_course for update;
  update invest.course
     set angel = v_clean,
         -- 已經揭曉過又改得獎組別：重新揭曉（頒獎走到那一步時再公開）
         angel_revealed = angel_revealed and v_clean = angel and jsonb_array_length(v_clean) > 0
   where invest.course.course = v_course;
  perform invest.apply_reveal();
  perform invest.bump();
  return invest.admin_overview();
end
$$;

-- 重置某一場（彩排用）：清除投資、走勢、結果與出席紀錄，名單保留
create or replace function public.invest_admin_reset(pw text, course text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_course text := course;
begin
  if not invest.check_admin(pw) then return invest.err('unauthorized', '管理員密碼錯誤'); end if;
  if v_course is null or v_course not in ('wed', 'thu') then return invest.err('bad_course', '場次錯誤'); end if;
  perform 1 from invest.course co where co.course = v_course for update;
  delete from invest.alloc a where a.course = v_course;
  delete from invest.history h where h.course = v_course;
  delete from invest.presence p where p.course = v_course;
  update invest.course
     set phase = 'pending', opened_at = null, dark_at = null, dark_ends_at = null, closed_at = null,
         dark_history_id = null, closed_from = null, dark_left_ms = null, results = null, revealed = false,
         presenting = null, presenting_at = null, presented = '{}'::jsonb, angel = '[]'::jsonb, angel_revealed = false
   where invest.course.course = v_course;
  perform invest.bump();
  return invest.admin_overview();
end
$$;

-- 匯入名單。entries = [{name, course: 'wed'|'thu', group}]；apply = false 只預覽
-- 只取代 entries 裡出現的課堂；已封盤的場次不能改
create or replace function public.invest_admin_roster(pw text, entries jsonb, apply boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entries jsonb := entries;
  v_apply boolean := coalesce(apply, false);
  v_errors text[] := '{}';
  v_clean jsonb := '[]'::jsonb;
  v_seen jsonb := '{}'::jsonb;
  v_courses text[];
  v_summary jsonb := '[]'::jsonb;
  v_dropped jsonb := '[]'::jsonb;
  v_groups text[];
  e jsonb;
  i int := 0;
  v_name text;
  v_course text;
  v_group text;
  v_key text;
  c text;
  cs invest.course;
begin
  if not invest.check_admin(pw) then return invest.err('unauthorized', '管理員密碼錯誤'); end if;
  if v_entries is null or jsonb_typeof(v_entries) <> 'array' then return invest.err('bad_roster', '名單格式錯誤'); end if;

  for e in select x from jsonb_array_elements(v_entries) x loop
    i := i + 1;
    v_name := invest.norm_name(e ->> 'name');
    v_course := e ->> 'course';
    v_group := regexp_replace(btrim(coalesce(e ->> 'group', '')), '\s+', ' ', 'g');
    if v_name = '' then v_errors := v_errors || format('第 %s 筆：姓名是空的', i); continue; end if;
    if length(v_name) > 40 then v_errors := v_errors || format('第 %s 筆：姓名太長', i); continue; end if;
    if v_course is null or v_course not in ('wed', 'thu') then
      v_errors := v_errors || format('第 %s 筆：課堂必須是週三或週四', i); continue;
    end if;
    if v_group = '' then v_errors := v_errors || format('第 %s 筆：組別是空的', i); continue; end if;
    if length(v_group) > 60 then v_errors := v_errors || format('第 %s 筆：組別名稱太長', i); continue; end if;
    v_key := lower(v_name);
    if v_seen ? (v_course || ':' || v_key) then
      v_errors := v_errors || format('第 %s 筆：「%s」在%s重複出現', i, v_name,
                                     case v_course when 'wed' then '週三' else '週四' end);
      continue;
    end if;
    v_seen := v_seen || jsonb_build_object(v_course || ':' || v_key, true);
    v_clean := v_clean || jsonb_build_array(jsonb_build_object('name', v_name, 'course', v_course, 'group', v_group, 'key', v_key));
  end loop;
  if jsonb_array_length(v_clean) = 0 and coalesce(array_length(v_errors, 1), 0) = 0 then
    v_errors := v_errors || '沒有讀到任何名單資料'::text;
  end if;

  v_courses := array(
    select distinct x ->> 'course' as co from jsonb_array_elements(v_clean) x
    order by co desc  -- wed、thu
  );

  foreach c in array v_courses loop
    select * into cs from invest.course co where co.course = c;
    if cs.phase = 'closed' then
      v_errors := v_errors || format('%s已封盤，結果已凍結；要改名單請先重置該場', invest.course_label(c));
    end if;
    v_groups := array(
      select s.g from (select distinct x ->> 'group' as g from jsonb_array_elements(v_clean) x where x ->> 'course' = c) s
      order by invest.group_num(s.g) nulls last, s.g collate "C"
    );
    v_summary := v_summary || jsonb_build_array(jsonb_build_object(
      'course', c,
      'students', (select count(*) from jsonb_array_elements(v_clean) x where x ->> 'course' = c),
      'groups', coalesce((
        select jsonb_agg(jsonb_build_object('group', u.g, 'count',
                 (select count(*) from jsonb_array_elements(v_clean) x where x ->> 'course' = c and x ->> 'group' = u.g))
               order by u.o)
        from unnest(v_groups) with ordinality as u(g, o)), '[]'::jsonb)));
    if coalesce(array_length(v_groups, 1), 0) < 2 then
      v_errors := v_errors || format('%s只有 %s 組，至少要兩組才能投資', invest.course_label(c), coalesce(array_length(v_groups, 1), 0));
    end if;
    v_dropped := v_dropped || coalesce((
      select jsonb_agg(t.d order by t.ord, t.d ->> 'name')
      from (
        select jsonb_build_object('name', coalesce(ro.name, s.name_key), 'course', c, 'reason', '已不在名單中，投資會被清除') as d, 1 as ord
        from (select distinct a.name_key from invest.alloc a where a.course = c) s
        left join invest.roster ro on ro.course = c and ro.name_key = s.name_key
        where not exists (select 1 from jsonb_array_elements(v_clean) x where x ->> 'course' = c and x ->> 'key' = s.name_key)
        union all
        select jsonb_build_object('name', x ->> 'name', 'course', c, 'reason', format('改到「%s」，原本投給這組的錢會退回', x ->> 'group')), 2
        from jsonb_array_elements(v_clean) x
        join invest.alloc a on a.course = c and a.name_key = x ->> 'key' and a.grp = x ->> 'group'
        where x ->> 'course' = c
        union all
        select jsonb_build_object('name', x ->> 'name', 'course', c, 'reason', format('「%s」已不存在，投給這組的錢會退回', a.grp)), 3
        from jsonb_array_elements(v_clean) x
        join invest.alloc a on a.course = c and a.name_key = x ->> 'key'
        where x ->> 'course' = c and not (a.grp = any (v_groups))
      ) t), '[]'::jsonb);
  end loop;

  if v_apply and coalesce(array_length(v_errors, 1), 0) = 0 then
    delete from invest.roster r where r.course = any (v_courses);
    insert into invest.roster (course, name_key, name, grp)
    select x ->> 'course', x ->> 'key', x ->> 'name', x ->> 'group' from jsonb_array_elements(v_clean) x;
    perform invest.ensure_student_accounts();
    foreach c in array v_courses loop
      v_groups := invest.groups(c);
      delete from invest.alloc a
       where a.course = c
         and (not exists (select 1 from invest.roster ro where ro.course = c and ro.name_key = a.name_key)
              or exists (select 1 from invest.roster ro where ro.course = c and ro.name_key = a.name_key and ro.grp = a.grp)
              or not (a.grp = any (v_groups)));
      delete from invest.presence p
       where p.course = c
         and not exists (select 1 from invest.roster ro where ro.course = c and ro.name_key = p.name_key);
      select * into cs from invest.course co where co.course = c;
      if cs.phase in ('open', 'dark') then perform invest.record_point(c, null); end if;
    end loop;
    perform invest.bump();
  end if;

  return jsonb_build_object(
    'ok', coalesce(array_length(v_errors, 1), 0) = 0,
    'applied', v_apply and coalesce(array_length(v_errors, 1), 0) = 0,
    'errors', to_jsonb(v_errors),
    'entries', coalesce((select jsonb_agg(x - 'key') from jsonb_array_elements(v_clean) x), '[]'::jsonb),
    'courses', to_jsonb(v_courses),
    'summary', v_summary,
    'dropped', v_dropped
  );
end
$$;

-- 學生登入頁的進場動畫：目前場次的出席率行情看板（管理員可關閉）
create or replace function public.invest_intro_board() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when cfg.board_visible then invest.attendance_board(cfg.active)
              else jsonb_build_object('course', cfg.active, 'weeks', '[]'::jsonb, 'rows', '[]'::jsonb) end
  from invest.config cfg where cfg.id = 1
$$;

-- 匯入出席紀錄（整份取代）。entries = [{course: wed|thu, name, week, status: 參|遲|假|缺}]
-- 名單上找不到的姓名不匯入、列在 unmatched；apply = false 只預覽。entries = [] 且 apply = true 會清空。
create or replace function public.invest_admin_attendance(pw text, entries jsonb, apply boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_apply boolean := coalesce(apply, false);
  v_errors text[] := '{}';
  v_clean jsonb := '{}'::jsonb;  -- key: course:name_key:week → row（重複的以最後一筆為準）
  v_unmatched jsonb := '{}'::jsonb;
  e jsonb;
  i int := 0;
  v_course text;
  v_name text;
  v_key text;
  v_week int;
  v_status text;
  v_raw text;
begin
  if not invest.check_admin(pw) then return invest.err('unauthorized', '管理員密碼錯誤'); end if;
  if entries is null or jsonb_typeof(entries) <> 'array' then return invest.err('bad_attendance', '出席資料格式錯誤'); end if;

  for e in select x from jsonb_array_elements(entries) x loop
    i := i + 1;
    v_course := e ->> 'course';
    v_name := invest.norm_name(e ->> 'name');
    v_raw := btrim(coalesce(e ->> 'status', ''));
    v_status := case
      when v_raw in ('參', '出席', '到', 'present', 'P') then 'present'
      when v_raw in ('遲', '遲到', 'late', 'L') then 'late'
      when v_raw in ('假', '請假', 'leave', 'E') then 'leave'
      when v_raw in ('缺', '缺席', '曠', 'absent', 'A') then 'absent'
      else null end;
    if v_course is null or v_course not in ('wed', 'thu') then
      v_errors := v_errors || format('第 %s 筆：課堂必須是週三（VSAI）或週四（跨域）', i); continue;
    end if;
    if v_name = '' then v_errors := v_errors || format('第 %s 筆：姓名是空的', i); continue; end if;
    if (e ->> 'week') !~ '^\s*\d{1,2}\s*$' then v_errors := v_errors || format('第 %s 筆：週次要是數字', i); continue; end if;
    v_week := (e ->> 'week')::int;
    -- 未紀錄、尚未加入：略過不算
    if v_status is null then continue; end if;
    v_key := invest.name_key(v_name);
    if not exists (select 1 from invest.roster ro where ro.course = v_course and ro.name_key = v_key) then
      v_unmatched := v_unmatched || jsonb_build_object(v_course || ':' || v_key,
                       jsonb_build_object('course', v_course, 'name', v_name));
      continue;
    end if;
    v_clean := v_clean || jsonb_build_object(format('%s:%s:%s', v_course, v_key, v_week),
                 jsonb_build_object('course', v_course, 'key', v_key, 'week', v_week, 'status', v_status));
  end loop;

  if v_apply and coalesce(array_length(v_errors, 1), 0) = 0 then
    -- Supabase 的 safeupdate 不允許沒有 WHERE 的 DELETE
    delete from invest.attendance a where a.course in ('wed', 'thu');
    insert into invest.attendance (course, name_key, week, status)
    select x ->> 'course', x ->> 'key', (x ->> 'week')::int, x ->> 'status' from jsonb_each(v_clean) as t(k, x);
  end if;

  return jsonb_build_object(
    'ok', coalesce(array_length(v_errors, 1), 0) = 0,
    'applied', v_apply and coalesce(array_length(v_errors, 1), 0) = 0,
    'errors', to_jsonb(v_errors[1:20]),
    'records', (select count(*) from jsonb_each(v_clean)),
    'summary', coalesce((
      select jsonb_agg(jsonb_build_object('course', s.course, 'students', s.students, 'weeks', s.weeks) order by s.course desc)
      from (select x ->> 'course' as course, count(distinct x ->> 'key') as students,
                   count(distinct x ->> 'week') as weeks
            from jsonb_each(v_clean) as t(k, x) group by 1) s), '[]'::jsonb),
    'unmatched', coalesce((select jsonb_agg(x order by x ->> 'course' desc, x ->> 'name') from jsonb_each(v_unmatched) as t(k, x)), '[]'::jsonb)
  );
end
$$;

create or replace function public.invest_admin_board(pw text, visible boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not invest.check_admin(pw) then return invest.err('unauthorized', '管理員密碼錯誤'); end if;
  update invest.config set board_visible = coalesce(visible, true) where id = 1;
  return jsonb_build_object('visible', coalesce(visible, true));
end
$$;

-- 完整結算（含姓名），給管理員下載 CSV
create or replace function public.invest_admin_results(pw text, course text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_course text := course;
  v_results jsonb;
begin
  if not invest.check_admin(pw) then return invest.err('unauthorized', '管理員密碼錯誤'); end if;
  if v_course is null or v_course not in ('wed', 'thu') then return invest.err('bad_course', '場次錯誤'); end if;
  perform invest.expire_due(v_course);
  select co.results into v_results from invest.course co where co.course = v_course;
  if v_results is null then return invest.err('no_results', '這一場還沒有結算結果'); end if;
  return v_results;
end
$$;

-- ---------- 大螢幕舞台控制（頒獎、業師總結） ----------

-- 封面照片與投影片圖片另外抓（檔案大，不放在每 0.7 秒查詢一次的狀態裡）
create or replace function public.invest_group_cover(course text, grp text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('cover', (select gi.cover from invest.group_info gi where gi.course = $1 and gi.grp = $2))
$$;

create or replace function public.invest_slide_image(id bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('image', (select sl.image from invest.slide sl where sl.id = $1))
$$;

-- action：market（盤況）／awards（從頭開始頒獎）／summary（從頭開始業師總結）／next／prev／goto（step）
create or replace function public.invest_admin_stage(pw text, action text, step int default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_action text := action;
  v_step int := step;
  cfg invest.config;
  n int;
begin
  if not invest.check_admin(pw) then return invest.err('unauthorized', '管理員密碼錯誤'); end if;
  perform invest.expire_due('wed');
  perform invest.expire_due('thu');
  select * into cfg from invest.config c where c.id = 1 for update;
  if v_action in ('market', 'awards', 'summary') then
    if v_action = 'summary' and not exists (select 1 from invest.slide) then
      return invest.err('no_slides', '還沒有任何總結投影片');
    end if;
    update invest.config set stage_mode = v_action, stage_step = 0 where id = 1;
  elsif v_action in ('next', 'prev', 'goto') then
    if cfg.stage_mode = 'market' then return invest.err('bad_stage', '目前是盤況畫面，請先開始頒獎或業師總結'); end if;
    if cfg.stage_mode = 'awards' then n := jsonb_array_length(invest.award_steps());
    else select count(*) into n from invest.slide; end if;
    update invest.config
       set stage_step = least(greatest(case v_action when 'next' then cfg.stage_step + 1
                                                     when 'prev' then cfg.stage_step - 1
                                                     else coalesce(v_step, cfg.stage_step) end, 0), n - 1)
     where id = 1;
  else
    return invest.err('bad_action', '未知的操作');
  end if;
  perform invest.apply_reveal();
  perform invest.bump();
  return invest.admin_overview();
end
$$;

-- 各組作品：slogan 與封面（cover = 'data:image/jpeg;base64,…'；clear_cover = true 刪除封面）
create or replace function public.invest_admin_group(pw text, course text, grp text, slogan text default null,
                                                     cover text default null, clear_cover boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_course text := course;
  v_grp text := grp;
  v_slogan text := slogan;
  v_cover text := cover;
begin
  if not invest.check_admin(pw) then return invest.err('unauthorized', '管理員密碼錯誤'); end if;
  if v_course is null or v_course not in ('wed', 'thu') then return invest.err('bad_course', '場次錯誤'); end if;
  if v_grp is null or not (v_grp = any (invest.groups(v_course))) then return invest.err('unknown_group', '沒有這個組別'); end if;
  if v_slogan is not null and length(v_slogan) > 200 then return invest.err('too_long', 'slogan 最多 200 字'); end if;
  if v_cover is not null and (v_cover !~ '^data:image/(jpeg|png|webp);base64,' or length(v_cover) > 3000000) then
    return invest.err('bad_cover', '封面必須是 JPEG／PNG／WebP 圖片，而且不能超過 2 MB');
  end if;
  insert into invest.group_info (course, grp) values (v_course, v_grp) on conflict do nothing;
  update invest.group_info gi
     set slogan = coalesce(btrim(v_slogan), gi.slogan),
         cover = case when coalesce(clear_cover, false) then null else coalesce(v_cover, gi.cover) end,
         cover_ver = gi.cover_ver + case when v_cover is not null or coalesce(clear_cover, false) then 1 else 0 end
   where gi.course = v_course and gi.grp = v_grp;
  perform invest.bump();
  return invest.admin_overview();
end
$$;

-- 業師總結投影片：整份取代。slides = [{id?, kind: title|text|recap, title, subtitle, body, image?}]
-- image 欄位沒給 → 保留原本的圖；給 null → 刪除；給 data URL → 換圖
create or replace function public.invest_admin_slides(pw text, slides jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_slides jsonb := slides;
  e jsonb;
  i int := 0;
  v_id bigint;
  v_keep bigint[] := '{}';
begin
  if not invest.check_admin(pw) then return invest.err('unauthorized', '管理員密碼錯誤'); end if;
  if v_slides is null or jsonb_typeof(v_slides) <> 'array' or jsonb_array_length(v_slides) > 60 then
    return invest.err('bad_slides', '投影片格式錯誤（最多 60 頁）');
  end if;
  for e in select x from jsonb_array_elements(v_slides) x loop
    if coalesce(e ->> 'kind', 'text') not in ('title', 'text', 'recap') then return invest.err('bad_slides', '投影片類型錯誤'); end if;
    if length(coalesce(e ->> 'title', '')) > 200 or length(coalesce(e ->> 'subtitle', '')) > 300 or length(coalesce(e ->> 'body', '')) > 3000 then
      return invest.err('too_long', '投影片文字太長');
    end if;
    if e ? 'image' and e ->> 'image' is not null
       and ((e ->> 'image') !~ '^data:image/(jpeg|png|webp);base64,' or length(e ->> 'image') > 3000000) then
      return invest.err('bad_image', '圖片必須是 JPEG／PNG／WebP，而且不能超過 2 MB');
    end if;
  end loop;
  for e in select x from jsonb_array_elements(v_slides) x loop
    i := i + 1;
    v_id := nullif(e ->> 'id', '')::bigint;
    if v_id is null or not exists (select 1 from invest.slide sl where sl.id = v_id) then
      insert into invest.slide (pos, kind, title, subtitle, body) values (i, coalesce(e ->> 'kind', 'text'), '', '', '')
      returning invest.slide.id into v_id;
    end if;
    update invest.slide sl
       set pos = i, kind = coalesce(e ->> 'kind', 'text'),
           title = coalesce(e ->> 'title', ''), subtitle = coalesce(e ->> 'subtitle', ''), body = coalesce(e ->> 'body', ''),
           image = case when e ? 'image' then e ->> 'image' else sl.image end,
           image_ver = sl.image_ver + case when e ? 'image' then 1 else 0 end
     where sl.id = v_id;
    v_keep := v_keep || v_id;
  end loop;
  delete from invest.slide sl where not (sl.id = any (v_keep));
  perform invest.bump();
  return invest.admin_overview();
end
$$;

-- 帳號：entries = [{name, role: student|mentor|guest, password?}]
-- student：名單上要有這個人，設定密碼（生日後四碼）；mentor／guest：沒有就建立（密碼沒給 → TNDA），有就改密碼
create or replace function public.invest_admin_account_save(pw text, entries jsonb, apply boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_apply boolean := coalesce(apply, false);
  v_errors text[] := '{}';
  e jsonb;
  i int := 0;
  v_name text;
  v_key text;
  v_role text;
  v_pw text;
  acc invest.account;
  v_created int := 0;
  v_updated int := 0;
begin
  if not invest.check_admin(pw) then return invest.err('unauthorized', '管理員密碼錯誤'); end if;
  if entries is null or jsonb_typeof(entries) <> 'array' then return invest.err('bad_accounts', '帳號格式錯誤'); end if;
  perform invest.ensure_student_accounts();
  for e in select x from jsonb_array_elements(entries) x loop
    i := i + 1;
    v_name := invest.norm_name(e ->> 'name');
    v_key := invest.name_key(v_name);
    v_role := coalesce(e ->> 'role', 'student');
    v_pw := nullif(invest.norm_name(e ->> 'password'), '');
    if v_name = '' or length(v_name) > 40 then v_errors := v_errors || format('第 %s 筆：姓名是空的或太長', i); continue; end if;
    if v_role not in ('student', 'mentor', 'guest') then v_errors := v_errors || format('第 %s 筆：身分錯誤', i); continue; end if;
    if v_pw is not null and length(v_pw) > 40 then v_errors := v_errors || format('第 %s 筆：密碼太長', i); continue; end if;
    select * into acc from invest.account a where a.name_key = v_key;
    if v_role = 'student' then
      if not exists (select 1 from invest.roster r where r.name_key = v_key) then
        v_errors := v_errors || format('第 %s 筆：「%s」不在學生名單上', i, v_name); continue;
      end if;
      if v_pw is null then v_errors := v_errors || format('第 %s 筆：「%s」沒有密碼', i, v_name); continue; end if;
      if v_apply then perform invest.set_password(v_key, v_pw); end if;
      v_updated := v_updated + 1;
    else
      if found and acc.role = 'student' then
        v_errors := v_errors || format('第 %s 筆：「%s」是學生，不能改成業師或訪客', i, v_name); continue;
      end if;
      if not found then
        if v_apply then
          insert into invest.account (name_key, name, role) values (v_key, v_name, v_role);
          perform invest.set_password(v_key, coalesce(v_pw, 'TNDA'));
        end if;
        v_created := v_created + 1;
      else
        if v_apply then
          update invest.account set role = v_role, name = v_name where name_key = v_key;
          if v_pw is not null then perform invest.set_password(v_key, v_pw); end if;
        end if;
        v_updated := v_updated + 1;
      end if;
    end if;
  end loop;
  if v_apply and coalesce(array_length(v_errors, 1), 0) = 0 then perform invest.bump(); end if;
  return jsonb_build_object(
    'ok', coalesce(array_length(v_errors, 1), 0) = 0,
    'applied', v_apply,
    'errors', to_jsonb(v_errors[1:30]),
    'created', v_created,
    'updated', v_updated);
end
$$;

-- 刪除業師／訪客帳號（連同他的投資）；學生帳號跟著名單，不能在這裡刪
create or replace function public.invest_admin_account_delete(pw text, name text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_key text := invest.name_key(name);
  c text;
begin
  if not invest.check_admin(pw) then return invest.err('unauthorized', '管理員密碼錯誤'); end if;
  if not exists (select 1 from invest.account a where a.name_key = v_key and a.role <> 'student') then
    return invest.err('not_found', '找不到這個業師／訪客帳號');
  end if;
  foreach c in array array['wed', 'thu'] loop
    if exists (select 1 from invest.course co where co.course = c and co.phase = 'closed')
       and exists (select 1 from invest.alloc a where a.course = c and a.name_key = v_key) then
      return invest.err('closed', '這個帳號在已封盤的場次有投資，結果已凍結，不能刪除');
    end if;
  end loop;
  delete from invest.alloc a where a.name_key = v_key;
  delete from invest.session s where s.name_key = v_key;
  delete from invest.account a where a.name_key = v_key;
  foreach c in array array['wed', 'thu'] loop
    if exists (select 1 from invest.course co where co.course = c and co.phase in ('open', 'dark')) then
      perform invest.record_point(c, null);
    end if;
  end loop;
  perform invest.bump();
  return invest.admin_overview();
end
$$;

-- ---------- 預設資料 ----------
select invest.ensure_student_accounts();
-- 5 個訪客帳號 TNDA1～TNDA5（密碼 TNDA）
insert into invest.account (name_key, name, role)
select lower('TNDA' || n), 'TNDA' || n, 'guest' from generate_series(1, 5) n
on conflict (name_key) do nothing;
select invest.set_password(a.name_key, 'TNDA') from invest.account a where a.role = 'guest' and a.pw_hash is null;
-- 業師總結的預設投影片（之後在管理員頁修改）
insert into invest.slide (pos, kind, title, subtitle, body)
select v.pos, v.kind, v.title, v.subtitle, v.body
from (values (1, 'title', '業師總結', '一場體驗如何發生 × VSAI 互動機台原型實戰', ''),
             (2, 'recap', '數字回顧', '', ''),
             (3, 'text', '謝謝大家', 'TNDA · Next D', '')) as v(pos, kind, title, subtitle, body)
where not exists (select 1 from invest.slide);

-- ---------- 權限：網頁（anon）只能呼叫上面的 RPC ----------

revoke all on all tables in schema invest from public;
revoke all on all functions in schema invest from public;
do $$
declare
  fn text;
  has_role boolean;
begin
  foreach fn in array array[
    'invest_state(bigint)', 'invest_history(bigint, bigint)', 'invest_me(text)',
    'invest_invest(text, text, text, numeric)', 'invest_admin_check(text)', 'invest_admin_overview(text)',
    'invest_admin_set_active(text, text)', 'invest_admin_phase(text, text, text)', 'invest_admin_reset(text, text)',
    'invest_admin_roster(text, jsonb, boolean)', 'invest_admin_results(text, text)',
    'invest_intro_board()', 'invest_admin_attendance(text, jsonb, boolean)', 'invest_admin_board(text, boolean)',
    'invest_login(text, text)', 'invest_group_cover(text, text)', 'invest_slide_image(bigint)',
    'invest_admin_stage(text, text, integer)', 'invest_admin_group(text, text, text, text, text, boolean)',
    'invest_admin_slides(text, jsonb)', 'invest_admin_account_save(text, jsonb, boolean)', 'invest_admin_account_delete(text, text)',
    'invest_admin_present(text, text, text)', 'invest_admin_angel(text, text, jsonb)'
  ] loop
    execute format('revoke all on function public.%s from public', fn);
    select exists (select 1 from pg_roles where rolname = 'anon') into has_role;
    if has_role then
      execute format('grant execute on function public.%s to anon, authenticated', fn);
    end if;
  end loop;
end
$$;

-- 讓 Supabase 的 API 立即看到新函式
notify pgrst, 'reload schema';
