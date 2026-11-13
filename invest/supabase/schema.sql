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
  amount bigint not null check (amount > 0 and amount <= 500000),
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

alter table invest.config enable row level security;
alter table invest.roster enable row level security;
alter table invest.course enable row level security;
alter table invest.alloc enable row level security;
alter table invest.presence enable row level security;
alter table invest.history enable row level security;

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

-- ---------- 狀態計算 ----------

-- 目前各組獲得的投資總額（不含倒扣）
create or replace function invest.totals(c text) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_object_agg(u.grp, coalesce(t.total, 0)), '{}'::jsonb)
  from unnest(invest.groups(c)) as u(grp)
  left join (
    select a.grp, sum(a.amount) as total from invest.alloc a where a.course = c group by a.grp
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
  - 各組最終金額 = 投進來的總額 − 自己組員沒花完的錢（只倒扣這一場有登入過的人）
  - 依最終金額排名（同分同名次、下一名順延）→ 倍率 ×3、×2、×1.5、其餘 ×1；最高的組即使為負數也得獎
  - 個人報酬 = Σ（投在該組的金額 × 該組倍率），未花完的錢不計入；個人名次只算有投資的人
*/
create or replace function invest.compute_results(c text) returns jsonb
language sql stable set search_path = '' as $$
  with g as (
    select u.grp, u.ord from unnest(invest.groups(c)) with ordinality as u(grp, ord)
  ),
  m as (
    select r.name_key, r.name, r.grp as own from invest.roster r where r.course = c
  ),
  va as (
    select a.name_key, a.grp, a.amount
    from invest.alloc a
    join m on m.name_key = a.name_key
    join g on g.grp = a.grp
    where a.course = c and a.grp <> m.own
  ),
  inv as (
    select m.name_key, m.name, m.own,
           coalesce((select sum(va.amount) from va where va.name_key = m.name_key), 0) as invested
    from m
  ),
  ded as (
    select inv.own as grp, inv.name, 1000000 - inv.invested as unspent
    from inv
    where inv.invested < 1000000
      and (inv.invested > 0
           or exists (select 1 from invest.presence p where p.course = c and p.name_key = inv.name_key))
  ),
  gr0 as (
    select g.grp, g.ord,
           coalesce((select sum(va.amount) from va where va.grp = g.grp), 0) as raw,
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
    select inv.name, inv.own, inv.invested,
           coalesce((select sum(va.amount * grm.mult) from va join grm on grm.grp = va.grp
                     where va.name_key = inv.name_key), 0) as payout
    from inv
    where inv.invested > 0
  ),
  pr as (
    select pay.*, rank() over (order by pay.payout desc) as rnk from pay
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
               'unspent', 1000000 - pr.invested, 'payout', pr.payout, 'rank', pr.rnk)
             order by pr.rnk, pr.name collate "C")
      from pr), '[]'::jsonb),
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

create or replace function invest.public_course(c text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  cs invest.course;
  hidden boolean;
  tot jsonb;
  v_groups jsonb;
begin
  select * into cs from invest.course where course = c;
  hidden := cs.phase = 'dark';
  if cs.phase = 'closed' and cs.results is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', g ->> 'group', 'total', g -> 'final', 'rank', g -> 'rank',
             'members', (select count(*) from invest.roster ro where ro.course = c and ro.grp = g ->> 'group'))
           order by invest.group_num(g ->> 'group') nulls last, (g ->> 'group') collate "C"), '[]'::jsonb)
      into v_groups
      from jsonb_array_elements(cs.results -> 'groups') g;
  else
    tot := invest.totals(c);
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', x.grp,
             'total', case when hidden then null else x.v end,
             'rank', case when hidden then null else x.rk end,
             'members', x.cnt)
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
    'openedAt', invest.ms(cs.opened_at),
    'darkAt', invest.ms(cs.dark_at),
    'darkEndsAt', invest.ms(cs.dark_ends_at),
    'closedAt', invest.ms(cs.closed_at),
    'groups', v_groups,
    'students', (select count(*) from invest.roster r where r.course = c),
    'joined', (select count(*) from invest.roster r where r.course = c and invest.is_present(c, r.name_key)),
    'fullyInvested', (
      select count(*) from invest.roster r
      where r.course = c
        and (select coalesce(sum(a.amount), 0) from invest.alloc a where a.course = c and a.name_key = r.name_key) = 1000000),
    'results', case when cs.phase = 'closed' and cs.results is not null then invest.public_results(cs.results) end
  );
end
$$;

create or replace function invest.public_state() returns jsonb
language sql volatile set search_path = '' as $$
  select jsonb_build_object(
    'version', cfg.version,
    'now', invest.ms(clock_timestamp()),
    'active', cfg.active,
    'darkMs', cfg.dark_ms,
    'courses', jsonb_build_object('wed', invest.public_course('wed'), 'thu', invest.public_course('thu'))
  )
  from invest.config cfg where cfg.id = 1
$$;

-- 某位學生的資料（只有自己的投資）
create or replace function invest.me(k text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  res jsonb := '{}'::jsonb;
  c text;
  r record;
  cs invest.course;
  v_name text;
  v_alloc jsonb;
  v_inv numeric;
  v_result jsonb;
  v_ded numeric;
  inv jsonb;
begin
  foreach c in array array['wed', 'thu'] loop
    select ro.name, ro.grp into r from invest.roster ro where ro.course = c and ro.name_key = k;
    if not found then continue; end if;
    v_name := coalesce(v_name, r.name);
    select * into cs from invest.course co where co.course = c;
    select coalesce(jsonb_object_agg(a.grp, a.amount), '{}'::jsonb), coalesce(sum(a.amount), 0)
      into v_alloc, v_inv
      from invest.alloc a where a.course = c and a.name_key = k;
    v_result := null;
    v_ded := null;
    if cs.phase = 'closed' and cs.results is not null then
      select i into inv from jsonb_array_elements(cs.results -> 'investors') i where i ->> 'name' = r.name;
      if inv is not null then
        v_result := jsonb_build_object('payout', inv -> 'payout', 'rank', inv -> 'rank',
                                       'of', jsonb_array_length(cs.results -> 'investors'));
      end if;
      select coalesce((
        select (d ->> 'unspent')::numeric
        from jsonb_array_elements(cs.results -> 'groups') g, jsonb_array_elements(g -> 'deductions') d
        where g ->> 'group' = r.grp and d ->> 'name' = r.name), 0) into v_ded;
    end if;
    res := res || jsonb_build_object(c, jsonb_build_object(
      'course', c, 'group', r.grp, 'alloc', v_alloc, 'invested', v_inv,
      'remaining', 1000000 - v_inv, 'result', v_result, 'deducted', v_ded));
  end loop;
  return jsonb_build_object('name', v_name, 'courses', res);
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
    and (cs.phase <> 'dark' or cs.dark_history_id is null or h.id <= cs.dark_history_id)
$$;

create or replace function invest.admin_course(c text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'phase', cs.phase,
    'groups', to_jsonb(invest.groups(c)),
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
    'courses', jsonb_build_object('wed', invest.admin_course('wed'), 'thu', invest.admin_course('thu'))
  )
  from invest.config cfg where cfg.id = 1
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

-- 登入／重新整理自己的資料；同時記錄「出席目前這一場」
create or replace function public.invest_me(name text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_input text := name;
  v_key text := invest.name_key(v_input);
  v_active text;
begin
  if length(coalesce(v_input, '')) > 100
     or not exists (select 1 from invest.roster r where r.name_key = v_key) then
    return invest.err('not_in_roster',
      format('名單中找不到「%s」，請確認姓名或洽助教', left(invest.norm_name(v_input), 40)));
  end if;
  select cfg.active into v_active from invest.config cfg where cfg.id = 1;
  perform invest.expire_due(v_active);
  perform invest.mark_present(v_active, v_key);
  return invest.me(v_key);
end
$$;

-- 下單：把某組的投資設成 amount（絕對值）。所有規則在這裡驗證
create or replace function public.invest_invest(name text, course text, grp text, amount numeric) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_key text := invest.name_key(name);
  v_course text := course;
  v_grp text := grp;
  v_amount numeric := amount;
  v_own text;
  cs invest.course;
  v_others numeric;
  v_current numeric;
begin
  if v_course is null or v_course not in ('wed', 'thu') then
    return invest.err('bad_course', '場次錯誤');
  end if;
  if not exists (select 1 from invest.roster r where r.name_key = v_key) then
    return invest.err('not_in_roster', '名單中找不到這個名字，請確認姓名或洽助教');
  end if;
  select r.grp into v_own from invest.roster r where r.course = v_course and r.name_key = v_key;
  if v_own is null then
    return invest.err('not_in_course', format('你不在%s的名單中', invest.course_label(v_course)));
  end if;

  perform invest.expire_due(v_course);
  -- 鎖住這一場：同一場的下單一筆一筆處理，餘額不會被同時扣兩次
  select * into cs from invest.course co where co.course = v_course for update;

  if cs.phase = 'pending' then return invest.err('not_open', '還沒開盤，開盤後才能投資'); end if;
  if cs.phase = 'closed' then return invest.err('closed', '已經封盤，不能再調整'); end if;
  if v_grp is null or not (v_grp = any (invest.groups(v_course))) then
    return invest.err('unknown_group', '沒有這個組別');
  end if;
  if v_grp = v_own then return invest.err('own_group', '不能投資自己那組'); end if;
  if v_amount is null or v_amount < 0 or v_amount <> trunc(v_amount) then
    return invest.err('bad_amount', '金額必須是 0 以上的整數');
  end if;
  if v_amount > 500000 then return invest.err('over_limit', '單一組最多只能投 50 萬'); end if;

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
    insert into invest.presence (course, name_key) values (v_course, v_key) on conflict do nothing;
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
             results = null, closed_at = null, closed_from = null, dark_left_ms = null
       where invest.course.course = v_course;
    else
      update invest.course
         set phase = 'open', dark_at = null, dark_ends_at = null, dark_history_id = null,
             results = null, closed_at = null, closed_from = null, dark_left_ms = null
       where invest.course.course = v_course;
    end if;

  else
    return invest.err('bad_action', '未知的操作');
  end if;

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
         dark_history_id = null, closed_from = null, dark_left_ms = null, results = null
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
    'invest_admin_roster(text, jsonb, boolean)', 'invest_admin_results(text, text)'
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
