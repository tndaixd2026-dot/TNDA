// 系統狀態：名單、各場的盤況與投資、走勢歷史、結算結果。
// 所有規則都在這裡驗證；HTTP 層只負責轉送。狀態存在記憶體，並寫入 DATA_DIR/state.json 以防重啟遺失。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BUDGET,
  INVEST_ERROR_MESSAGE,
  checkInvest,
  competitionRanks,
  computeResults,
  groupTotals,
  sumAlloc,
  type Member,
} from '../shared/rules.ts';
import { COURSE_CSV_LABEL, nameKey, normalizeName, parseRosterCsv, sortGroups } from '../shared/roster.ts';
import {
  COURSE_IDS,
  courseLabel,
  type AdminOverview,
  type Allocation,
  type CourseId,
  type HistoryPoint,
  type MeState,
  type MyCourse,
  type Phase,
  type PublicCourse,
  type PublicState,
  type Results,
  type RosterEntry,
  type RosterPreview,
} from '../shared/types.ts';

export interface CourseState {
  phase: Phase;
  openedAt: number | null;
  darkAt: number | null;
  darkEndsAt: number | null;
  closedAt: number | null;
  /** 學生姓名 → 投資 */
  alloc: Record<string, Allocation>;
  history: HistoryPoint[];
  /** 進入暗盤時的歷史長度；暗盤期間只公開這之前的點 */
  darkHistoryLen: number | null;
  /** 封盤時凍結的結算結果 */
  results: Results | null;
}

export interface AppState {
  version: 1;
  active: CourseId;
  roster: RosterEntry[];
  /** nameKey → 最後登入時間 */
  logins: Record<string, number>;
  courses: Record<CourseId, CourseState>;
}

export type StoreEvent =
  | { type: 'state' }
  | { type: 'me'; names: string[] | 'all' }
  | { type: 'point'; course: CourseId; point: HistoryPoint }
  | { type: 'history' };

export interface StoreOptions {
  /** null 表示只存在記憶體（測試用） */
  dataDir: string | null;
  darkMs: number;
  seed: RosterEntry[];
  now?: () => number;
  log?: (msg: string) => void;
}

export interface Fail {
  ok: false;
  status: number;
  code: string;
  message: string;
}
export type Result<T> = { ok: true; value: T } | Fail;

function fail(status: number, code: string, message: string): Fail {
  return { ok: false, status, code, message };
}
function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function isCourseId(value: unknown): value is CourseId {
  return value === 'wed' || value === 'thu';
}

function freshCourse(): CourseState {
  return {
    phase: 'pending',
    openedAt: null,
    darkAt: null,
    darkEndsAt: null,
    closedAt: null,
    alloc: {},
    history: [],
    darkHistoryLen: null,
    results: null,
  };
}

interface RosterIndex {
  /** nameKey → 正式姓名 */
  byKey: Map<string, string>;
  /** 正式姓名 → 各課堂組別 */
  membership: Map<string, Partial<Record<CourseId, string>>>;
  groups: Record<CourseId, string[]>;
  members: Record<CourseId, Member[]>;
}

function buildIndex(roster: readonly RosterEntry[]): RosterIndex {
  const byKey = new Map<string, string>();
  const membership = new Map<string, Partial<Record<CourseId, string>>>();
  const groupSets: Record<CourseId, string[]> = { wed: [], thu: [] };
  const members: Record<CourseId, Member[]> = { wed: [], thu: [] };
  for (const e of roster) {
    const key = nameKey(e.name);
    let name = byKey.get(key);
    if (!name) {
      name = normalizeName(e.name);
      byKey.set(key, name);
    }
    const m = membership.get(name) ?? {};
    if (m[e.course]) continue; // 同一堂課重複出現時以第一筆為準
    m[e.course] = e.group;
    membership.set(name, m);
    groupSets[e.course].push(e.group);
    members[e.course].push({ name, group: e.group });
  }
  for (const c of COURSE_IDS) members[c].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  return {
    byKey,
    membership,
    groups: { wed: sortGroups(groupSets.wed), thu: sortGroups(groupSets.thu) },
    members,
  };
}

function normalizeLoaded(raw: unknown, seed: RosterEntry[]): AppState {
  const s = raw as Partial<AppState> | null;
  if (!s || s.version !== 1 || !Array.isArray(s.roster) || !s.courses) {
    throw new Error('state.json 格式不符');
  }
  const courses = {} as Record<CourseId, CourseState>;
  for (const c of COURSE_IDS) {
    courses[c] = { ...freshCourse(), ...(s.courses[c] ?? {}) };
  }
  return {
    version: 1,
    active: isCourseId(s.active) ? s.active : 'wed',
    roster: s.roster.length ? s.roster : seed,
    logins: s.logins ?? {},
    courses,
  };
}

export type Store = ReturnType<typeof createStore>;

export function createStore(opts: StoreOptions) {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const darkMs = opts.darkMs;
  const statePath = opts.dataDir ? join(opts.dataDir, 'state.json') : null;

  let state: AppState = {
    version: 1,
    active: 'wed',
    roster: opts.seed,
    logins: {},
    courses: { wed: freshCourse(), thu: freshCourse() },
  };

  if (opts.dataDir) mkdirSync(opts.dataDir, { recursive: true });
  if (statePath && existsSync(statePath)) {
    try {
      state = normalizeLoaded(JSON.parse(readFileSync(statePath, 'utf8')), opts.seed);
      log(`已從 ${statePath} 載入資料`);
    } catch (err) {
      const backup = `${statePath}.corrupt-${now()}`;
      renameSync(statePath, backup);
      log(`⚠️ 無法讀取 ${statePath}（${(err as Error).message}），已備份到 ${backup} 並從頭開始`);
    }
  }

  let index = buildIndex(state.roster);

  // ---- 事件 ----
  const listeners = new Set<(e: StoreEvent) => void>();
  function emit(e: StoreEvent) {
    for (const fn of listeners) fn(e);
  }

  // ---- 存檔 ----
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();
  function scheduleSave() {
    if (!statePath || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const json = JSON.stringify(state);
      const tmp = `${statePath}.tmp`;
      writing = writing
        .then(() => writeFile(tmp, json))
        .then(() => rename(tmp, statePath))
        .catch((err: unknown) => log(`⚠️ 存檔失敗：${(err as Error).message}`));
    }, 200);
  }
  function flush() {
    if (!statePath) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const tmp = `${statePath}.flush`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, statePath);
  }

  // ---- 暗盤計時 ----
  const darkTimers: Partial<Record<CourseId, ReturnType<typeof setTimeout>>> = {};
  function clearDarkTimer(course: CourseId) {
    const t = darkTimers[course];
    if (t) clearTimeout(t);
    delete darkTimers[course];
  }
  function scheduleDarkTimer(course: CourseId) {
    clearDarkTimer(course);
    const cs = state.courses[course];
    if (cs.phase !== 'dark' || cs.darkEndsAt === null) return;
    const delay = Math.max(0, cs.darkEndsAt - now());
    darkTimers[course] = setTimeout(() => {
      delete darkTimers[course];
      if (!expireDarkIfDue(course)) scheduleDarkTimer(course);
    }, delay + 5);
  }
  /** 暗盤時間到了就封盤；回傳是否已封盤 */
  function expireDarkIfDue(course: CourseId): boolean {
    const cs = state.courses[course];
    if (cs.phase !== 'dark') return cs.phase === 'closed';
    if (cs.darkEndsAt !== null && now() >= cs.darkEndsAt) {
      doClose(course);
      log(`${courseLabel(course)} 暗盤倒數結束，自動封盤`);
      return true;
    }
    return false;
  }

  // ---- 走勢 ----
  function recordPoint(course: CourseId, mark?: HistoryPoint['mark']) {
    const cs = state.courses[course];
    const t = now();
    const totals =
      mark === 'close' && cs.results
        ? Object.fromEntries(cs.results.groups.map((g) => [g.group, g.final]))
        : groupTotals(index.groups[course], cs.alloc);
    const last = cs.history[cs.history.length - 1];
    let point: HistoryPoint;
    // 一秒內的連續變動合併成一個點，避免歷史無限膨脹
    if (!mark && last && !last.mark && t - last.t < 1000) {
      last.totals = totals;
      point = last;
    } else {
      point = mark ? { t, totals, mark } : { t, totals };
      cs.history.push(point);
    }
    if (cs.phase !== 'dark') emit({ type: 'point', course, point });
  }

  function visibleHistory(course: CourseId): HistoryPoint[] {
    const cs = state.courses[course];
    if (cs.phase === 'dark' && cs.darkHistoryLen !== null) return cs.history.slice(0, cs.darkHistoryLen);
    return cs.history;
  }

  // ---- 查詢 ----
  function publicCourse(course: CourseId): PublicCourse {
    const cs = state.courses[course];
    const members = index.members[course];
    const memberCount = new Map<string, number>();
    for (const m of members) memberCount.set(m.group, (memberCount.get(m.group) ?? 0) + 1);

    let groupIds = index.groups[course];
    let totals: number[];
    let ranks: number[];
    if (cs.phase === 'closed' && cs.results) {
      const byGroup = new Map(cs.results.groups.map((g) => [g.group, g]));
      groupIds = sortGroups(byGroup.keys());
      totals = groupIds.map((g) => byGroup.get(g)?.final ?? 0);
      ranks = groupIds.map((g) => byGroup.get(g)?.rank ?? 0);
    } else {
      const t = groupTotals(groupIds, cs.alloc);
      totals = groupIds.map((g) => t[g]);
      ranks = competitionRanks(totals);
    }
    const hidden = cs.phase === 'dark';
    return {
      course,
      phase: cs.phase,
      openedAt: cs.openedAt,
      darkAt: cs.darkAt,
      darkEndsAt: cs.darkEndsAt,
      closedAt: cs.closedAt,
      groups: groupIds.map((id, i) => ({
        id,
        total: hidden ? null : totals[i],
        rank: hidden ? null : ranks[i],
        members: memberCount.get(id) ?? 0,
      })),
      students: members.length,
      joined: members.filter((m) => state.logins[nameKey(m.name)] !== undefined).length,
      fullyInvested: members.filter((m) => sumAlloc(cs.alloc[m.name]) === BUDGET).length,
      results: cs.phase === 'closed' ? cs.results : null,
    };
  }

  function getPublic(): PublicState {
    return {
      now: now(),
      active: state.active,
      darkMs,
      courses: { wed: publicCourse('wed'), thu: publicCourse('thu') },
    };
  }

  function myCourse(name: string, course: CourseId): MyCourse | undefined {
    const group = index.membership.get(name)?.[course];
    if (!group) return undefined;
    const cs = state.courses[course];
    const alloc = { ...(cs.alloc[name] ?? {}) };
    const invested = sumAlloc(alloc);
    let result: MyCourse['result'] = null;
    if (cs.phase === 'closed' && cs.results) {
      const r = cs.results.investors.find((i) => i.name === name);
      if (r) result = { payout: r.payout, rank: r.rank, of: cs.results.investors.length };
    }
    return { course, group, alloc, invested, remaining: BUDGET - invested, result };
  }

  function resolveName(input: unknown): string | null {
    if (typeof input !== 'string' || input.length > 100) return null;
    return index.byKey.get(nameKey(input)) ?? null;
  }

  function getMe(input: unknown): MeState | null {
    const name = resolveName(input);
    if (!name) return null;
    const courses: MeState['courses'] = {};
    for (const c of COURSE_IDS) {
      const mc = myCourse(name, c);
      if (mc) courses[c] = mc;
    }
    return { name, courses };
  }

  function notInRoster(input: unknown): Fail {
    const shown = typeof input === 'string' ? normalizeName(input).slice(0, 40) : '';
    return fail(404, 'not_in_roster', `名單中找不到「${shown}」，請確認姓名或洽助教`);
  }

  // ---- 學生操作 ----
  function login(input: unknown): Result<MeState> {
    const name = resolveName(input);
    if (!name) return notInRoster(input);
    state.logins[nameKey(name)] = now();
    scheduleSave();
    emit({ type: 'state' });
    return ok(getMe(name)!);
  }

  function invest(input: unknown, course: unknown, group: unknown, amount: unknown): Result<MeState> {
    if (!isCourseId(course)) return fail(400, 'bad_course', '場次錯誤');
    const name = resolveName(input);
    if (!name) return notInRoster(input);
    const own = index.membership.get(name)?.[course];
    if (!own) return fail(403, 'not_in_course', `你不在${courseLabel(course)}的名單中`);
    expireDarkIfDue(course);
    const cs = state.courses[course];
    const current = cs.alloc[name] ?? {};
    const err = checkInvest({
      phase: cs.phase,
      groups: index.groups[course],
      ownGroup: own,
      current,
      group: typeof group === 'string' ? group : '',
      amount: typeof amount === 'number' ? amount : Number.NaN,
    });
    if (err) {
      const status = err === 'not_open' || err === 'closed' ? 409 : 400;
      return fail(status, err, INVEST_ERROR_MESSAGE[err]);
    }
    const g = group as string;
    const a = amount as number;
    if ((current[g] ?? 0) !== a) {
      const next = { ...current };
      if (a === 0) delete next[g];
      else next[g] = a;
      if (Object.keys(next).length) cs.alloc[name] = next;
      else delete cs.alloc[name];
      recordPoint(course);
      emit({ type: 'state' });
      emit({ type: 'me', names: [name] });
      scheduleSave();
    }
    return ok(getMe(name)!);
  }

  // ---- 管理員操作 ----
  function setActive(course: unknown): Result<null> {
    if (!isCourseId(course)) return fail(400, 'bad_course', '場次錯誤');
    state.active = course;
    emit({ type: 'state' });
    scheduleSave();
    return ok(null);
  }

  function openMarket(course: CourseId): Result<null> {
    const cs = state.courses[course];
    if (cs.phase !== 'pending') return fail(409, 'bad_phase', '只有「未開盤」時可以開盤');
    if (index.groups[course].length < 2) return fail(409, 'no_groups', '名單裡至少要有兩組才能開盤');
    cs.phase = 'open';
    cs.openedAt = now();
    recordPoint(course, 'open');
    emit({ type: 'state' });
    scheduleSave();
    log(`${courseLabel(course)} 開盤`);
    return ok(null);
  }

  function goDark(course: CourseId): Result<null> {
    const cs = state.courses[course];
    if (cs.phase !== 'open') return fail(409, 'bad_phase', '只有「開盤中」可以進入暗盤');
    recordPoint(course, 'dark');
    cs.phase = 'dark';
    cs.darkAt = now();
    cs.darkEndsAt = cs.darkAt + darkMs;
    cs.darkHistoryLen = cs.history.length;
    scheduleDarkTimer(course);
    emit({ type: 'state' });
    scheduleSave();
    log(`${courseLabel(course)} 進入暗盤，${Math.round(darkMs / 1000)} 秒後封盤`);
    return ok(null);
  }

  function doClose(course: CourseId) {
    const cs = state.courses[course];
    clearDarkTimer(course);
    cs.results = computeResults(index.groups[course], index.members[course], cs.alloc);
    cs.phase = 'closed';
    cs.closedAt = now();
    recordPoint(course, 'close');
    emit({ type: 'state' });
    emit({ type: 'history' });
    emit({ type: 'me', names: 'all' });
    scheduleSave();
  }

  function closeMarket(course: CourseId): Result<null> {
    const cs = state.courses[course];
    if (cs.phase !== 'open' && cs.phase !== 'dark') return fail(409, 'bad_phase', '只有「開盤中」或「暗盤」可以封盤');
    doClose(course);
    log(`${courseLabel(course)} 手動封盤`);
    return ok(null);
  }

  function phaseAction(course: unknown, action: unknown): Result<null> {
    if (!isCourseId(course)) return fail(400, 'bad_course', '場次錯誤');
    if (action === 'open') return openMarket(course);
    if (action === 'dark') return goDark(course);
    if (action === 'close') return closeMarket(course);
    return fail(400, 'bad_action', '未知的操作');
  }

  function reset(course: unknown): Result<null> {
    if (!isCourseId(course)) return fail(400, 'bad_course', '場次錯誤');
    clearDarkTimer(course);
    state.courses[course] = freshCourse();
    emit({ type: 'state' });
    emit({ type: 'history' });
    emit({ type: 'me', names: 'all' });
    scheduleSave();
    log(`${courseLabel(course)} 已重置`);
    return ok(null);
  }

  function previewRoster(csv: unknown): RosterPreview {
    const text = typeof csv === 'string' ? csv : '';
    const parsed = parseRosterCsv(text);
    const errors = [...parsed.errors];
    const courses = COURSE_IDS.filter((c) => parsed.entries.some((e) => e.course === c));
    for (const c of courses) {
      if (state.courses[c].phase === 'closed') {
        errors.push(`${courseLabel(c)}已封盤，結果已凍結；要改名單請先重置該場`);
      }
    }
    const nextIndex = buildIndex([
      ...state.roster.filter((e) => !courses.includes(e.course)),
      ...parsed.entries,
    ]);
    const summary = courses.map((course) => {
      const counts = new Map<string, number>();
      for (const m of nextIndex.members[course]) counts.set(m.group, (counts.get(m.group) ?? 0) + 1);
      return {
        course,
        students: nextIndex.members[course].length,
        groups: nextIndex.groups[course].map((group) => ({ group, count: counts.get(group) ?? 0 })),
      };
    });
    for (const s of summary) {
      if (s.groups.length < 2) errors.push(`${courseLabel(s.course)}只有 ${s.groups.length} 組，至少要兩組才能投資`);
    }
    const dropped: RosterPreview['dropped'] = [];
    for (const course of courses) {
      for (const [name, alloc] of Object.entries(state.courses[course].alloc)) {
        const canonical = nextIndex.byKey.get(nameKey(name));
        const own = canonical ? nextIndex.membership.get(canonical)?.[course] : undefined;
        if (!own) {
          dropped.push({ name, course, reason: '已不在名單中，投資會被清除' });
          continue;
        }
        if (alloc[own]) dropped.push({ name, course, reason: `改到「${own}」，原本投給這組的錢會退回` });
        for (const g of Object.keys(alloc)) {
          if (!nextIndex.groups[course].includes(g)) {
            dropped.push({ name, course, reason: `「${g}」已不存在，投給這組的錢會退回` });
          }
        }
      }
    }
    return { ok: errors.length === 0, errors, entries: parsed.entries, courses, summary, dropped };
  }

  function applyRoster(csv: unknown): Result<RosterPreview> {
    const preview = previewRoster(csv);
    if (!preview.ok) return fail(400, 'bad_roster', preview.errors.join('\n'));
    state.roster = [
      ...state.roster.filter((e) => !preview.courses.includes(e.course)),
      ...preview.entries,
    ];
    index = buildIndex(state.roster);
    for (const course of preview.courses) {
      const cs = state.courses[course];
      const groups = index.groups[course];
      const pruned: Record<string, Allocation> = {};
      for (const [name, alloc] of Object.entries(cs.alloc)) {
        const canonical = index.byKey.get(nameKey(name));
        const own = canonical ? index.membership.get(canonical)?.[course] : undefined;
        if (!canonical || !own) continue;
        const next: Allocation = {};
        for (const [g, a] of Object.entries(alloc)) {
          if (g !== own && groups.includes(g)) next[g] = a;
        }
        if (Object.keys(next).length) pruned[canonical] = next;
      }
      cs.alloc = pruned;
      if (cs.phase === 'open' || cs.phase === 'dark') recordPoint(course);
    }
    emit({ type: 'state' });
    emit({ type: 'history' });
    emit({ type: 'me', names: 'all' });
    scheduleSave();
    log(`已匯入名單：${preview.courses.map((c) => `${COURSE_CSV_LABEL[c]} ${preview.summary.find((s) => s.course === c)?.students ?? 0} 人`).join('、')}`);
    return ok(preview);
  }

  function adminOverview(): AdminOverview {
    const courses = {} as AdminOverview['courses'];
    for (const c of COURSE_IDS) {
      const cs = state.courses[c];
      courses[c] = {
        phase: cs.phase,
        groups: index.groups[c],
        students: index.members[c].map((m) => {
          const invested = sumAlloc(cs.alloc[m.name]);
          return {
            name: m.name,
            group: m.group,
            invested,
            remaining: BUDGET - invested,
            joined: state.logins[nameKey(m.name)] !== undefined,
          };
        }),
      };
    }
    return { active: state.active, darkMs, roster: state.roster, courses };
  }

  function resultsCsv(course: unknown): string | null {
    if (!isCourseId(course)) return null;
    const r = state.courses[course].results;
    if (!r) return null;
    const cell = (v: string | number) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows: (string | number)[][] = [
      [`${courseLabel(course)} 組別排名`],
      ['名次', '組別', '投資總額', '倒扣', '最終金額', '倍率', '倒扣明細'],
      ...r.groups.map((g) => [
        g.rank,
        g.group,
        g.raw,
        g.penalty,
        g.final,
        g.multiplier,
        g.deductions.map((d) => `${d.name} ${d.unspent}`).join('；'),
      ]),
      [],
      [`${courseLabel(course)} 個人報酬`],
      ['名次', '姓名', '組別', '已投資', '未花完', '報酬'],
      ...r.investors.map((i) => [i.rank, i.name, i.group, i.invested, i.unspent, i.payout]),
      [],
      ['一飛沖天獎', r.rocket.join('、')],
      ['股神獎', r.stockGods.join('、')],
    ];
    return '﻿' + rows.map((row) => row.map(cell).join(',')).join('\n') + '\n';
  }

  // 啟動時若有進行中的暗盤，接續倒數（重啟期間已到時間就直接封盤）
  for (const c of COURSE_IDS) {
    if (!expireDarkIfDue(c)) scheduleDarkTimer(c);
  }

  return {
    subscribe(fn: (e: StoreEvent) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getPublic,
    getMe,
    resolveName,
    visibleHistory,
    login,
    invest,
    setActive,
    phaseAction,
    reset,
    previewRoster,
    applyRoster,
    adminOverview,
    resultsCsv,
    flush,
    /** 測試或關機時停止計時器並等待存檔完成 */
    async dispose() {
      for (const c of COURSE_IDS) clearDarkTimer(c);
      await writing;
      flush();
    },
  };
}
