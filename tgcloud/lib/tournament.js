// PUBG Mobile tournament: 80 teams -> 4 groups of 20 (2 matches, top 10 of each go on; A+B and C+D) -> 2 groups of 20
// (3 matches, top 10 of each) -> a final lobby of 20 (4 matches). Every number lives in the database
// (tournaments, teams, group_members, stage_groups, matches, match_scores, shots); the AI only reads the
// scoreboard screenshots, points are computed here (PMGC table) and the admin confirms each match.
import { db, api } from 'sdk';
import { sql } from 'sdk/db';
import { esc, btn, grid, call, send, now, digits, LINE } from './util.js';
import * as store from './store.js';
import { geminiVision, visionKeys } from './ai.js';
import { parseWhen } from './flow.js';
import { groupMembers, matchScores, playerScores } from '../schema.js';

// ---------- rules ----------
// Three fixed formats; every team count a format accepts (min..max) ends in a final lobby of at most 20:
//   big    44-80:  4 groups (11-20 each, 2 matches, top 10); A+B -> semi-final 1, C+D -> semi-final 2 (3 matches, top 10) -> final 20 (4 matches)
//   fifty  22-50:  2 groups (11-25 each, 3 matches, top 10) -> final 20 (4 matches)
//   medium 22-40:  2 groups (11-20 each, 3 matches, top 10) -> final 20 (4 matches)
//   small  8-20:   one lobby, 4 matches, the table decides
const FINAL = { code: 'fi', label: 'فینال بزرگ', groups: ['F'], matches: 4, adv: 0, next: null, lobby: 20 };
export const FORMATS = {
  big: {
    label: '🏆 بزرگ', max: 80, min: 44,
    desc: '۸۰ تیم (۳۲۰ بازیکن): ۴ گروه ۲۰ تیمی (۲ مچ) ← ۱۰ تیم اول A و B نیمه‌نهایی ۱، ۱۰ تیم اول C و D نیمه‌نهایی ۲ (۲۰ تیمی، ۳ مچ) ← فینال ۲۰ تیمی (۴ مچ)',
    stages: {
      // 20 a lobby, not 25: a full room lags (Erangel) and every team still finds its slot
      ROUND_1: { code: 'r1', label: 'مرحله‌ی اول (مقدماتی)', groups: ['A', 'B', 'C', 'D'], matches: 2, adv: 10, next: 'SEMI_FINAL', lobby: 20 },
      // a bracket: semi-final 1 is A + B (drawn as soon as both are done), semi-final 2 is C + D
      SEMI_FINAL: { code: 'sf', label: 'نیمه‌نهایی', groups: ['1', '2'], matches: 3, adv: 10, next: 'FINAL', lobby: 20, feed: { 1: ['A', 'B'], 2: ['C', 'D'] } },
      FINAL,
    },
    // the nights' order: A, B, then their semi-final; C, D, then theirs; the final on its own night
    order: [['ROUND_1', 'A'], ['ROUND_1', 'B'], ['SEMI_FINAL', '1'], ['ROUND_1', 'C'], ['ROUND_1', 'D'], ['SEMI_FINAL', '2'], ['FINAL', 'F']],
  },
  fifty: {
    label: '🥇 ۵۰ تیمی', max: 50, min: 22,
    desc: '۵۰ تیم (۲۰۰ بازیکن): ۲ گروه ۲۵ تیمی (۳ مچ) ← فینال ۲۰ تیمی (۴ مچ)',
    stages: {
      ROUND_1: { code: 'r1', label: 'مرحله‌ی گروهی', groups: ['A', 'B'], matches: 3, adv: 10, next: 'FINAL', lobby: 25 },
      FINAL,
    },
  },
  medium: {
    label: '🥈 متوسط', max: 40, min: 22,
    desc: '۴۰ تیم (۱۶۰ بازیکن): ۲ گروه ۲۰ تیمی (۳ مچ) ← فینال ۲۰ تیمی (۴ مچ)',
    stages: {
      ROUND_1: { code: 'r1', label: 'مرحله‌ی گروهی', groups: ['A', 'B'], matches: 3, adv: 10, next: 'FINAL', lobby: 20 },
      FINAL,
    },
  },
  small: {
    label: '🥉 کوچیک', max: 20, min: 8,
    desc: '۲۰ تیم (۸۰ بازیکن): یک لابی، ۴ مچ؛ جمع امتیاز ۴ مچ قهرمان رو مشخص می‌کنه',
    stages: { FINAL: { ...FINAL, label: 'فینال' } },
  },
};
export const fmt = (t) => FORMATS[t?.format] || FORMATS.big;
export const stg = (t) => fmt(t).stages;
export const firstStage = (t) => Object.keys(stg(t))[0];
const CODE = { ROUND_1: 'r1', SEMI_FINAL: 'sf', FINAL: 'fi' };
const BY_CODE = { r1: 'ROUND_1', sf: 'SEMI_FINAL', fi: 'FINAL' };
export const MAPS = ['Erangel', 'Miramar', 'Sanhok', 'Vikendi', 'Rondo', 'Livik'];
// about how long a match lasts (minutes): the admin is asked for the result after it
export const MAP_MIN = { Erangel: 30, Miramar: 45, Sanhok: 25, Vikendi: 35, Rondo: 40, Livik: 15 };
export const groupLabel = (stage, g) => (stage === 'FINAL' ? 'لابی فینال' : `گروه ${g}`);

// PMGC: 1 point a kill; placement 10, 6, 5, 4, 3, 2, 1, 1, then 0
const PLACEMENT = { 1: 10, 2: 6, 3: 5, 4: 4, 5: 3, 6: 2, 7: 1, 8: 1 };
export const placementPoints = (rank) => PLACEMENT[rank] || 0;

// ---------- data ----------
const one = async (q) => (await db.get(q)) || null;

export const current = () => one(sql`SELECT * FROM tournaments ORDER BY id DESC LIMIT 1`);
export const getT = (id) => one(sql`SELECT * FROM tournaments WHERE id = ${Number(id)}`);
const getMatch = (id) => one(sql`SELECT * FROM matches WHERE match_id = ${Number(id)}`);
export const teamCount = async (tid) => (await db.get(sql`SELECT COUNT(*) AS n FROM teams WHERE tournament_id = ${tid}`)).n;

/** The teams of a lobby (stage + group), by slot. */
const lobby = (tid, stage, g) => db.all(sql`SELECT t.team_id, t.team_name, t.igl_name, t.clan_tag, t.members, t.leader_chat_id, gm.slot_number
  FROM group_members gm JOIN teams t ON t.team_id = gm.team_id
  WHERE gm.tournament_id = ${tid} AND gm.stage = ${stage} AND gm.group_name = ${g} ORDER BY gm.slot_number`);

export const groupMatches = (tid, stage, g) => db.all(sql`SELECT * FROM matches WHERE tournament_id = ${tid} AND stage = ${stage} AND group_name = ${g} ORDER BY match_number`);
const groupDone = async (tid, stage, g) => !!(await one(sql`SELECT done FROM stage_groups WHERE tournament_id = ${tid} AND stage = ${stage} AND group_name = ${g}`))?.done;

/**
 * The table of a group: points, then kills, then chicken dinners, then the better rank in the last
 * confirmed match (then the slot, so the order is always the same).
 */
export async function standings(tid, stage, g) {
  return db.all(sql`SELECT gm.team_id, t.team_name, gm.slot_number, gm.qualified,
      COALESCE(SUM(s.total_match_points), 0) AS pts, COALESCE(SUM(s.kills), 0) AS kills,
      COALESCE(SUM(s.placement_points), 0) AS pp,
      COALESCE(SUM(CASE WHEN s.placement_rank = 1 THEN 1 ELSE 0 END), 0) AS wwcd,
      COUNT(s.id) AS played,
      COALESCE((SELECT s2.placement_rank FROM match_scores s2 WHERE s2.team_id = gm.team_id AND s2.match_id = (
        SELECT m3.match_id FROM matches m3 WHERE m3.tournament_id = ${tid} AND m3.stage = ${stage} AND m3.group_name = ${g}
          AND m3.is_confirmed = 1 ORDER BY m3.match_number DESC LIMIT 1)), 999) AS last_rank
    FROM group_members gm JOIN teams t ON t.team_id = gm.team_id
    LEFT JOIN match_scores s ON s.team_id = gm.team_id AND s.match_id IN (
      SELECT m.match_id FROM matches m WHERE m.tournament_id = ${tid} AND m.stage = ${stage} AND m.group_name = ${g} AND m.is_confirmed = 1)
    WHERE gm.tournament_id = ${tid} AND gm.stage = ${stage} AND gm.group_name = ${g}
    GROUP BY gm.team_id
    ORDER BY pts DESC, kills DESC, wwcd DESC, last_rank ASC, gm.slot_number ASC`);
}

function shuffle(list) {
  const a = [...list];
  const rnd = () => {
    try { return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32; } catch { return Math.random(); }
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Messages to many leaders, a few at a time (Telegram allows ~30 a second). -> how many arrived */
/** team_id -> the Telegram chats of its players (and its leader, for a team added by hand). */
export async function chatsByTeam(tid) {
  const out = {};
  const add = (team, chat) => { if (chat) (out[team] ||= new Set()).add(Number(chat)); };
  for (const x of await db.all(sql`SELECT team_id, leader_chat_id FROM teams WHERE tournament_id = ${tid}`)) add(x.team_id, x.leader_chat_id);
  for (const x of await db.all(sql`SELECT team_id, user_id FROM team_players WHERE tournament_id = ${tid}`)) add(x.team_id, x.user_id);
  return out;
}
/**
 * "Are you ready?" for matches of a lobby: each leader gets the times, their slot and "✅ we're ready" (for all
 * these matches at once); the other players get the times. -> how many players were reached
 */
export async function announce(t, stage, g, ms) {
  const list = await lobby(t.id, stage, g);
  const members = await db.all(sql`SELECT team_id, user_id FROM team_players WHERE tournament_id = ${t.id} AND role = 'member'`);
  const head = `🏆 ${esc(t.name)}\n🎮 ${esc(stg(t)[stage].label)} · ${groupLabel(stage, g)}`;
  const times = [];
  for (const m of ms) times.push(`▫️ مچ ${m.match_number}${m.map_name ? ' · 🗺 ' + esc(m.map_name) : ''} · ⏰ <b>${await store.localStr(m.starts_at)}</b>`);
  const ids = ms.map((m) => m.match_id).join('-');
  const out = [];
  for (const x of list) {
    if (x.leader_chat_id) {
      out.push([x.leader_chat_id, `⏰ <b>تیم ${esc(x.team_name)}، آماده‌اید؟</b>\n\n${head}\n${times.join('\n')}\n🎯 اسلات شما: <b>${x.slot_number}</b>\n\n` +
        '👑 تو لیدری: «✅ آماده‌ایم» رو بزن تا ادمین بدونه تیمت میاد. آیدی و رمز روم قبل از شروع برات میاد.',
      [[btn('✅ آماده‌ایم', `tp:r:${ids}`)], [btn('📊 داشبورد تیم من', 'tp:d')]]]);
    }
    for (const p of members.filter((y) => y.team_id === x.team_id)) {
      out.push([p.user_id, `⏰ <b>تیم ${esc(x.team_name)}: زمان مچ‌ها</b>\n\n${head}\n${times.join('\n')}\n🎯 اسلات: <b>${x.slot_number}</b>\n\nسر وقت آنلاین باش! لیدرت آمادگی تیم رو اعلام می‌کنه.`,
        [[btn('📊 داشبورد تیم من', 'tp:d')]]]);
    }
  }
  return notifyMany(out);
}

/** Right before the draw: teams that never got their 4 players are removed (lib/players.js registers them). */
async function dropPending(tid) {
  const chats = await chatsByTeam(tid);
  const list = await db.all(sql`SELECT team_id, team_name FROM teams WHERE tournament_id = ${tid} AND status = 'pending'`);
  for (const x of list) {
    await db.run(sql`DELETE FROM team_players WHERE team_id = ${x.team_id}`);
    await db.run(sql`DELETE FROM teams WHERE team_id = ${x.team_id}`);
  }
  await notifyMany(list.flatMap((x) => [...(chats[x.team_id] || [])].map((c) => [c, `⌛️ تورنمنت شروع شد و تیم <b>${esc(x.team_name)}</b> هنوز ۴ نفر نشده بود، برای همین ثبت‌نامش لغو شد.`])));
  return list.length;
}

/** [[team_id, text]] -> one message to every player of each team */
async function notifyTeams(tid, list, kb = false) {
  const chats = await chatsByTeam(tid);
  return notifyMany(list.flatMap(([team, text]) => [...(chats[team] || [])].map((chat) => [chat, text, kb])));
}

export async function notifyMany(list) {
  let ok = 0;
  for (let i = 0; i < list.length; i += 20) {
    const res = await Promise.all(list.slice(i, i + 20).map(([chat, text, kb = false]) => (chat ? send(chat, text, kb) : { ok: false })));
    ok += res.filter((r) => r.ok).length;
  }
  return ok;
}

// ---------- the draw: random groups and slots for a stage ----------
export async function drawStage(tid, stage, from) {
  const S = stg(await getT(tid));
  const cfg = S[stage];
  // only one tap switches the tournament to this stage
  const won = (await db.run(sql`UPDATE tournaments SET status = ${stage}, reg_open = 0 WHERE id = ${tid} AND status = ${from} RETURNING id`)).rows[0];
  if (!won) return null;
  const list = shuffle(await db.all(sql`SELECT team_id FROM teams WHERE tournament_id = ${tid} AND current_stage = ${stage} ORDER BY team_id`));
  const rows = list.map((t, i) => ({
    tournamentId: tid, stage, groupName: cfg.groups[i % cfg.groups.length], teamId: t.team_id,
    slotNumber: Math.floor(i / cfg.groups.length) + 1,
  }));
  await db.run(sql`DELETE FROM group_members WHERE tournament_id = ${tid} AND stage = ${stage}`);
  for (let i = 0; i < rows.length; i += 50) await db.insert(groupMembers).values(rows.slice(i, i + 50)).run();
  for (const g of cfg.groups) {
    await db.run(sql`INSERT INTO stage_groups (tournament_id, stage, group_name, done) VALUES (${tid}, ${stage}, ${g}, 0)
      ON CONFLICT(tournament_id, stage, group_name) DO NOTHING`);
  }
  await db.run(sql`UPDATE teams SET
      group_name = (SELECT gm.group_name FROM group_members gm WHERE gm.team_id = teams.team_id AND gm.tournament_id = ${tid} AND gm.stage = ${stage}),
      slot_number = (SELECT gm.slot_number FROM group_members gm WHERE gm.team_id = teams.team_id AND gm.tournament_id = ${tid} AND gm.stage = ${stage})
    WHERE tournament_id = ${tid} AND current_stage = ${stage}`);
  const t = await getT(tid);
  const all = await db.all(sql`SELECT team_id, team_name, group_name, slot_number FROM teams WHERE tournament_id = ${tid} AND current_stage = ${stage}`);
  await notifyTeams(tid, all.map((x) => [x.team_id, `🏆 <b>${esc(t.name)}</b>\n\n🎮 ${cfg.label}\n👥 تیم: <b>${esc(x.team_name)}</b>\n` +
    `📍 ${groupLabel(stage, x.group_name)} · اسلات <b>${x.slot_number}</b>\n🎯 ${cfg.matches} مچ` + (cfg.adv ? ` · ${cfg.adv} تیم اول هر گروه صعود می‌کنن` : '') +
    '\n\n⏰ زمان هر مچ همین‌جا اعلام میشه و 🔑 آیدی و رمز روم برای لیدر میاد.']), [[btn('📊 داشبورد تیم من', 'tp:d')]]);
  return rows.length;
}

/** One group of a bracket stage (cfg.feed): the qualified teams of its feeder groups, random slots. -> teams or null */
export async function drawGroup(tid, stage, g, feeders, from) {
  // only one call draws a group
  const won = (await db.run(sql`INSERT INTO stage_groups (tournament_id, stage, group_name, done) VALUES (${tid}, ${stage}, ${g}, 0)
    ON CONFLICT(tournament_id, stage, group_name) DO NOTHING RETURNING id`)).rows[0];
  if (!won) return null;
  await db.run(sql`UPDATE tournaments SET status = ${stage}, reg_open = 0 WHERE id = ${tid} AND status = ${from}`);
  const ids = [];
  for (const f of feeders) {
    for (const x of await db.all(sql`SELECT team_id FROM group_members WHERE tournament_id = ${tid} AND stage = ${from} AND group_name = ${f} AND qualified = 1`)) ids.push(x.team_id);
  }
  const rows = shuffle(ids).map((id, i) => ({ tournamentId: tid, stage, groupName: g, teamId: id, slotNumber: i + 1 }));
  if (rows.length) await db.insert(groupMembers).values(rows).run();
  for (const r of rows) await db.run(sql`UPDATE teams SET group_name = ${g}, slot_number = ${r.slotNumber} WHERE team_id = ${r.teamId}`);
  const t = await getT(tid);
  const cfg = stg(t)[stage];
  const all = await db.all(sql`SELECT team_id, team_name, group_name, slot_number FROM teams WHERE tournament_id = ${tid} AND current_stage = ${stage} AND group_name = ${g}`);
  await notifyTeams(tid, all.map((x) => [x.team_id, `🏆 <b>${esc(t.name)}</b>\n\n🎮 ${cfg.label}\n👥 تیم: <b>${esc(x.team_name)}</b>\n` +
    `📍 ${groupLabel(stage, x.group_name)} · اسلات <b>${x.slot_number}</b>\n🎯 ${cfg.matches} مچ` + (cfg.adv ? ` · ${cfg.adv} تیم اول صعود می‌کنن` : '') +
    '\n\n⏰ زمان هر مچ همین‌جا اعلام میشه و 🔑 آیدی و رمز روم برات میاد.']), [[btn('📊 داشبورد تیم من', 'tp:d')]]);
  return rows.length;
}

// ---------- the end of a group: who goes on ----------
export async function finalizeGroup(tid, stage, g) {
  const S = stg(await getT(tid));
  const cfg = S[stage];
  const won = (await db.run(sql`UPDATE stage_groups SET done = 1 WHERE tournament_id = ${tid} AND stage = ${stage} AND group_name = ${g} AND done = 0 RETURNING id`)).rows[0];
  if (!won) return null;
  const table = await standings(tid, stage, g);
  for (let i = 0; i < table.length; i++) {
    await db.run(sql`UPDATE group_members SET final_rank = ${i + 1}, qualified = ${i < cfg.adv ? 1 : 0}
      WHERE tournament_id = ${tid} AND stage = ${stage} AND team_id = ${table[i].team_id}`);
  }
  const inGroup = sql`SELECT team_id FROM group_members WHERE tournament_id = ${tid} AND stage = ${stage} AND group_name = ${g}`;
  if (cfg.next) {
    await db.run(sql`UPDATE teams SET current_stage = ${cfg.next}, group_name = NULL, slot_number = NULL
      WHERE team_id IN (SELECT team_id FROM group_members WHERE tournament_id = ${tid} AND stage = ${stage} AND group_name = ${g} AND qualified = 1)`);
    await db.run(sql`UPDATE teams SET current_stage = 'ELIMINATED' WHERE team_id IN (${inGroup}) AND current_stage = ${stage}`);
  } else if (table[0]) {
    await db.run(sql`UPDATE teams SET current_stage = 'CHAMPION' WHERE team_id = ${table[0].team_id}`);
  }
  const t = await getT(tid);
  await notifyTeams(tid, table.map((r, i) => [r.team_id, `🏆 <b>${esc(t.name)}</b> · ${cfg.label}\n\n👥 <b>${esc(r.team_name)}</b>\n📊 رتبه <b>${i + 1}</b> · ${r.pts} امتیاز (🔫 ${r.kills} کیل)\n\n` +
    (!cfg.next ? (i < 3 ? ['🥇 <b>قهرمان تورنمنت شدید!</b> 🎉', '🥈 <b>نایب‌قهرمان شدید!</b> 🎉', '🥉 <b>تیم سوم شدید!</b> 🎉'][i] : '🙏 ممنون که تا فینال اومدید.')
      : i < cfg.adv ? `✅ <b>به ${S[cfg.next].label} صعود کردید!</b> 🎉\nگروه و اسلات جدید به‌زودی برات میاد.` : '❌ متاسفانه حذف شدید. ممنون که شرکت کردید 🙏')]));
  // a bracket: the next stage's group this one feeds is drawn once all its feeder groups are done
  const feed = cfg.next && S[cfg.next].feed;
  if (feed) {
    const [ng, from] = Object.entries(feed).find(([, list]) => list.includes(g)) || [];
    let n = null;
    if (ng) {
      let ready = true;
      for (const f of from) if (!(await groupDone(tid, stage, f))) ready = false;
      if (ready) n = await drawGroup(tid, cfg.next, ng, from, stage);
    }
    return { stageDone: false, next: n != null ? cfg.next : null, group: n != null ? ng : null, n };
  }
  // the whole stage is over (every group of the format, drawn or not): the next stage's draw, or the end
  const doneN = (await db.get(sql`SELECT COUNT(*) AS n FROM stage_groups WHERE tournament_id = ${tid} AND stage = ${stage} AND done = 1`)).n;
  if (doneN < cfg.groups.length) return { stageDone: false };
  if (cfg.next) {
    const n = await drawStage(tid, cfg.next, stage);
    return { stageDone: true, next: cfg.next, n };
  }
  await db.run(sql`UPDATE tournaments SET status = 'DONE' WHERE id = ${tid}`);
  return { stageDone: true, done: true };
}

// ---------- results of a match: AI rows + the admin's fixes ----------
/**
 * One row per rank: the first screenshot that shows a rank wins (a squad seen at the bottom of one
 * screenshot and the top of the next counts once), a matched team beats an unmatched one, the admin's own
 * fixes beat everything; a team that shows up at two ranks keeps only its first (the other is flagged).
 */
export async function merged(m) {
  const byRank = new Map();
  const list = await db.all(sql`SELECT rows FROM shots WHERE match_id = ${m.match_id} AND status = 'ok' ORDER BY id`);
  for (const s of list) {
    for (const r of JSON.parse(s.rows || '[]')) {
      const old = byRank.get(r.rank);
      if (!old || (old.team_id == null && r.team_id != null)) byRank.set(r.rank, { ...r, src: 'ai' });
    }
  }
  const draft = JSON.parse(m.draft || '{}');
  for (const [rank, v] of Object.entries(draft)) {
    if (v === null) byRank.delete(Number(rank));
    else {
      // the screenshot's players stay when the fix keeps the same team at that rank
      const old = byRank.get(Number(rank));
      byRank.set(Number(rank), { rank: Number(rank), team_id: v.team_id, kills: v.kills, names: [], players: old?.team_id === v.team_id ? old.players : [], src: 'manual' });
    }
  }
  const rows = [...byRank.values()].sort((a, b) => a.rank - b.rank);
  // a team twice: a manual row keeps it, otherwise the better rank
  const owner = new Map();
  for (const r of rows.filter((x) => x.src === 'manual').concat(rows.filter((x) => x.src !== 'manual'))) {
    if (r.team_id == null) continue;
    if (owner.has(r.team_id)) {
      r.dup = r.team_id;
      r.team_id = null;
    } else owner.set(r.team_id, r.rank);
  }
  return rows;
}

/** Problems that stop the confirm (errors) and things to know (warns). */
async function check(m, rows) {
  const teamsIn = await lobby(m.tournament_id, m.stage, m.group_name);
  const ids = new Set(teamsIn.map((t) => t.team_id));
  const errors = [], warns = [];
  if (!rows.length) errors.push('هیچ نتیجه‌ای ثبت نشده.');
  for (const r of rows) {
    if (r.rank < 1 || r.rank > teamsIn.length) errors.push(`رتبه‌ی ${r.rank} بیشتر از تعداد تیم‌های لابی (${teamsIn.length}) است.`);
    if (r.team_id == null) errors.push(`رتبه‌ی ${r.rank}: تیمش مشخص نیست${r.dup ? ' (این تیم توی رتبه‌ی دیگه هم اومده)' : ''}.`);
    else if (!ids.has(r.team_id)) errors.push(`رتبه‌ی ${r.rank}: این تیم توی این لابی نیست.`);
    if (!Number.isInteger(r.kills) || r.kills < 0 || r.kills > 99) errors.push(`رتبه‌ی ${r.rank}: تعداد کیل درست نیست.`);
  }
  const seen = new Set(rows.map((r) => r.team_id));
  const missing = teamsIn.filter((t) => !seen.has(t.team_id));
  if (missing.length && !errors.length) warns.push(`${missing.length} تیم توی نتیجه نیستن و برای این مچ ۰ امتیاز می‌گیرن:\n` + missing.map((t) => `▫️ اسلات ${t.slot_number}: ${esc(t.team_name)}`).join('\n'));
  return { errors, warns, teamsIn };
}

// ---------- reading a screenshot ----------
export const SYSTEM = `You are an expert PUBG Mobile tournament data extractor.
I am providing you with post-match scoreboard screenshots from a single match, along with a JSON list of registered teams in this lobby (including team_id, team_name, igl_name, clan_tag and slot_number).
Instead of raw screenshots the input may also be ONE tidy summary (an image or plain text, often made by another AI) listing every squad by rank: rank, team name or clan tag and/or player names, and kills. Read it the same way.

Your tasks:
1. Identify each squad block in the screenshots. Note their match rank (e.g., #1, #2, ... #25).
2. For each squad, sum up the individual kills of all players in that squad to calculate \`total_kills\`.
3. Match each squad to the correct \`team_id\` from the provided registered teams list by comparing the team name or player names in the input with the registered \`team_name\`, \`players\`, \`igl_name\` or \`clan_tag\` (use fuzzy matching as players might have special symbols). If only a team total is given, use it as \`total_kills\` and leave \`players\` empty.
4. If a squad shows up in two overlapping screenshots, only include it ONCE.
5. If a squad cannot be matched with 100% certainty, set \`team_id\` to null and include the raw player names in \`unmatched_names\` so the admin can fix it manually.
6. For every squad, also list each player as shown in the screenshot with their own kills in \`players\`.

Return ONLY a valid JSON array with this exact schema:
[
  {
    "rank": 1,
    "team_id": 14,
    "team_name": "Team Immortal",
    "total_kills": 16,
    "unmatched_names": null,
    "players": [{ "name": "×͜×ALI", "kills": 7 }, { "name": "×͜×REZA", "kills": 5 }, { "name": "×͜×AMIR", "kills": 3 }, { "name": "×͜×SINA", "kills": 1 }]
  }
]`;
export const SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      rank: { type: 'INTEGER' },
      team_id: { type: 'INTEGER', nullable: true },
      team_name: { type: 'STRING', nullable: true },
      total_kills: { type: 'INTEGER' },
      unmatched_names: { type: 'ARRAY', items: { type: 'STRING' }, nullable: true },
      players: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, kills: { type: 'INTEGER' } }, required: ['name', 'kills'] } },
    },
    required: ['rank', 'total_kills'],
  },
};

/** The AI's answer -> clean rows (a team not in this lobby becomes "unmatched"). */
export function cleanRows(raw, teamsIn) {
  const ids = new Set(teamsIn.map((t) => t.team_id));
  const arr = JSON.parse(String(raw).replace(/^```(?:json)?|```$/g, '').trim());
  const out = new Map();
  for (const r of Array.isArray(arr) ? arr : []) {
    const rank = Number(r?.rank), kills = Number(r?.total_kills);
    if (!Number.isInteger(rank) || rank < 1 || rank > 25 || out.has(rank)) continue;
    const tid = Number.isInteger(Number(r.team_id)) && ids.has(Number(r.team_id)) && r.team_id !== null ? Number(r.team_id) : null;
    const names = (Array.isArray(r.unmatched_names) ? r.unmatched_names : []).map((x) => String(x).slice(0, 40)).slice(0, 6);
    if (tid == null && r.team_name) names.unshift(String(r.team_name).slice(0, 40));
    const players = (Array.isArray(r.players) ? r.players : []).slice(0, 5)
      .map((x) => ({ name: String(x?.name || '').slice(0, 40), kills: Number(x?.kills) }))
      .filter((x) => x.name && Number.isInteger(x.kills) && x.kills >= 0 && x.kills <= 60);
    out.set(rank, { rank, team_id: tid, kills: Number.isInteger(kills) && kills >= 0 && kills <= 99 ? kills : 0, names, players });
  }
  return [...out.values()].sort((a, b) => a.rank - b.rank);
}

/** A scoreboard screenshot from the admin (photo or image file) for match `mid`. */
export async function takeShot(uid, mid, m) {
  const file = m.photo ? m.photo[m.photo.length - 1] : m.document;
  const mime = m.photo ? 'image/jpeg' : m.document.mime_type;
  return readResult(uid, mid, file.file_unique_id, async () => ({ images: [{ mime, data: await api.getFileContent(file.file_id) }] }), '📸 عکس');
}

/** A tidy results list pasted as text (e.g. written by another AI from the screenshots). */
export async function takeText(uid, mid, text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.codePointAt(0)) | 0;
  return readResult(uid, mid, `txt:${h}`, async () => ({ images: [], extra: '\n\nThe results as text:\n' + text.slice(0, 6000) }), '📝 متن');
}

async function readResult(uid, mid, key, input, what) {
  const match = await getMatch(mid);
  if (!match) return send(uid, '⚠️ این مچ پیدا نشد.', backT());
  if (match.is_confirmed) return send(uid, '🔒 این مچ تایید شده؛ اول «♻️ باز کردن دوباره» رو بزن.', backM(mid));
  if (!(await visionKeys()).length) return send(uid, '🔑 برای خوندن نتایج اول کلید Gemini رو ثبت کن (یا نتایج رو دستی وارد کن).', [[btn('🔑 تنظیمات API', 'ak')], ...backM(mid)]);
  // the same picture twice (album re-sent): read once
  if (await one(sql`SELECT id FROM shots WHERE match_id = ${mid} AND file_id = ${key}`)) {
    return send(uid, 'ℹ️ این قبلاً خونده شده.', [[btn('👁 پیش‌نمایش نتایج', `tn:pv:${mid}`)], ...backM(mid)]);
  }
  const row = (await db.run(sql`INSERT INTO shots (match_id, file_id, status, created) VALUES (${mid}, ${key}, 'wait', ${now()}) RETURNING id`)).rows[0];
  const teamsIn = await lobby(match.tournament_id, match.stage, match.group_name);
  try {
    const { images, extra = '' } = await input();
    const raw = await geminiVision({
      system: SYSTEM,
      prompt: 'Registered teams in this lobby (JSON):\n' + JSON.stringify(teamsIn.map((t) => ({ team_id: t.team_id, team_name: t.team_name, igl_name: t.igl_name,
        clan_tag: t.clan_tag, players: JSON.parse(t.members || '[]'), slot_number: t.slot_number }))) + extra,
      images,
      schema: SCHEMA,
    });
    const rows = cleanRows(raw, teamsIn);
    await db.run(sql`UPDATE shots SET rows = ${JSON.stringify(rows)}, status = 'ok' WHERE id = ${row.id}`);
    const bad = rows.filter((r) => r.team_id == null).length;
    return send(uid, `${what} خونده شد: <b>${rows.length}</b> تیم` + (rows.length ? ` (رتبه‌ی ${rows[0].rank} تا ${rows[rows.length - 1].rank})` : '') +
      (bad ? `\n⚠️ ${bad} تیم شناخته نشد؛ توی پیش‌نمایش درستش کن.` : '') + '\n\nاگه عکس دیگه‌ای مونده بفرست، وگرنه پیش‌نمایش رو ببین.',
    [[btn('👁 پیش‌نمایش و تایید', `tn:pv:${mid}`)], ...backM(mid)]);
  } catch (e) {
    console.warn('shot', e.message);
    // a failed read can be sent again
    await db.run(sql`DELETE FROM shots WHERE id = ${row.id}`);
    return send(uid, `⚠️ نتونستم بخونمش.\n<code>${esc(String(e.message).slice(0, 200))}</code>\n\nدوباره بفرست، یا نتایج رو دستی وارد کن.`,
      [[btn('✍️ ورود دستی', `tn:man:${mid}`)], ...backM(mid)]);
  }
}

// ---------- screens ----------
const backT = () => [[btn('🔙 برگشت به تورنمنت', 'tn')]];
const backG = (stage, g) => [[btn(`🔙 برگشت به ${groupLabel(stage, g)}`, `tn:g:${CODE[stage]}:${g}`)]];
const backM = (mid) => [[btn('🔙 برگشت به مچ', `tn:m:${mid}`)]];
const statusText = (t) => ({ REG: '📝 ثبت‌نام', DONE: '🏁 تموم شده' }[t.status] || '🎮 ' + stg(t)[t.status].label);
/** The stages of a format, one line each (for the bot and the registration post). */
export function planLines(t) {
  return Object.values(stg(t)).map((c) => `${c.next ? '🎮' : '👑'} <b>${c.label}:</b> ` +
    (c.groups.length > 1 ? `${c.groups.length} گروه (${c.groups.join('، ')})، هر گروه تا ${c.lobby} تیم` : `یک لابی، تا ${c.lobby} تیم`) +
    ` · ${c.matches} مچ` + (c.adv ? ` · ${c.adv} تیم اول هر گروه صعود می‌کنن` : ' · قهرمان، دوم و سوم از جدول این مرحله مشخص میشن'));
}
const startText = (t, n) => {
  const c = stg(t)[firstStage(t)];
  return c.groups.length > 1 ? `${n} تیم شانسی توی ${c.groups.length} گروه (${c.groups.join('، ')}) چیده میشن و اسلات می‌گیرن`
    : `${n} تیم توی یک لابی، شانسی اسلات ۱ تا ${n} می‌گیرن`;
};

export async function home(uid) {
  const t = await current();
  if (!t) {
    return send(uid, '🏆 <b>تورنمنت پابجی</b>\n\nهنوز تورنمنتی نساختی.\n\n' +
      Object.values(FORMATS).map((f) => `${f.label}: ${f.desc}`).join('\n') + '\n\n' +
      '📸 نتیجه‌ی هر مچ: اسکرین‌شات‌های جدول آخر بازی رو بفرست، هوش مصنوعی می‌خونه، تو تایید می‌کنی.',
    [[btn('➕ ساخت تورنمنت جدید', 'tn:new')], [btn('🔙 برگشت به منو', 'menu')]]);
  }
  const n = await teamCount(t.id);
  const L = [`🏆 <b>${esc(t.name)}</b>`, '', `📐 نوع: <b>${fmt(t).label}</b>`, `وضعیت: <b>${statusText(t)}</b>`, `👥 تیم‌ها: <b>${n}</b>/${fmt(t).max}` + (t.status === 'REG' ? ` (⏳ ناقص: ${(await db.get(sql`SELECT COUNT(*) AS n FROM teams WHERE tournament_id = ${t.id} AND status = 'pending'`)).n})` : '')];
  const kb = [];
  if (t.status === 'REG') {
    L.push(`📝 ثبت‌نام: <b>${t.reg_open ? '🟢 باز' : '🔴 بسته'}</b>`, '', 'لیدرها با لینک ثبت‌نام (یا پست کانال) خودشون ثبت‌نام می‌کنن؛ تیم‌ها رو دستی هم می‌تونی اضافه کنی.',
      `وقتی تیم‌ها کامل شد (حداقل ${fmt(t).min} تیم)، «شروع تورنمنت» رو بزن تا ربات قرعه‌کشی کنه.`, '', ...planLines(t));
    kb.push([btn('📢 پست ثبت‌نام تو کانال', 'tn:post'), btn('🔗 لینک ثبت‌نام', 'tn:link')],
      [btn(`👥 تیم‌ها (${n})`, 'tn:teams:0'), btn('➕ افزودن دستی تیم', 'tn:add')],
      [btn(t.reg_open ? '🔴 بستن ثبت‌نام' : '🟢 باز کردن ثبت‌نام', 'tn:reg')],
      [btn('🎲 شروع تورنمنت (قرعه‌کشی و اسلات‌ها)', 'tn:start')]);
  } else {
    for (const [stage, cfg] of Object.entries(stg(t))) {
      const gs = await db.all(sql`SELECT group_name, done FROM stage_groups WHERE tournament_id = ${t.id} AND stage = ${stage} ORDER BY id`);
      if (!gs.length) continue;
      L.push('', `<b>${cfg.label}</b>`);
      const row = [];
      for (const g of gs) {
        const ms = await groupMatches(t.id, stage, g.group_name);
        const ok = ms.filter((x) => x.is_confirmed).length;
        L.push(`▫️ ${groupLabel(stage, g.group_name)}: مچ ${ok}/${cfg.matches}${g.done ? ' ✅' : ''}`);
        row.push(btn(`${g.done ? '✅' : '🎮'} ${groupLabel(stage, g.group_name)}`, `tn:g:${cfg.code}:${g.group_name}`));
      }
      // only the stage being played gets big buttons; finished stages stay reachable too
      kb.push(...grid(row, 2));
    }
    if (t.status === 'DONE') L.push('', '🏁 تورنمنت تموم شد. نتیجه‌ی فینال توی «لابی فینال» هست.');
    kb.push([btn(`👥 تیم‌ها (${n})`, 'tn:teams:0')]);
    if (t.status === 'DONE') kb.push([btn('➕ تورنمنت جدید', 'tn:new')]);
  }
  kb.push([{ text: '🛠 پنل ادمین (برنامه‌ی مچ‌ها، آمادگی تیم‌ها)', web_app: { url: `${APP}?t=${t.id}&admin=1` } }], [appBtn(t.id)], [btn('🔑 تنظیمات API', 'ak'), btn('❓ راهنما', 'tn:help')], [btn('🗑 حذف این تورنمنت', 'tn:delt')], [btn('🔙 برگشت به منو', 'menu')]);
  return send(uid, L.join('\n'), kb);
}

const HELP = '❓ <b>راهنمای تورنمنت</b>\n\n' +
  '0️⃣ <b>نوع تورنمنت:</b> موقع ساخت یکی رو انتخاب می‌کنی:\n' +
  Object.values(FORMATS).map((f) => `${f.label}: ${f.desc}`).join('\n') + '\n\n' +
  '1️⃣ <b>ثبت‌نام:</b> «📢 پست ثبت‌نام» رو تو کانال بذار. لیدر هر تیم دکمه رو می‌زنه، ربات براش باز میشه و اسم تیم، اسم خودش داخل بازی و تگ کلن رو می‌فرسته. رمز روم‌ها هم خصوصی برای همین لیدر میاد.\n\n' +
  '2️⃣ <b>شروع:</b> «🎲 شروع تورنمنت» ← ربات تیم‌ها رو شانسی توی گروه‌ها می‌چینه و به هر تیم اسلات میده؛ به لیدرها هم خبر میده.\n\n' +
  '3️⃣ <b>هر مچ:</b> وارد گروه شو ← «شروع مچ بعدی» ← مپ رو انتخاب کن ← «🔑 ارسال آیدی و رمز روم» (برای همه‌ی لیدرهای اون گروه خصوصی میره).\n\n' +
  '4️⃣ <b>نتیجه:</b> «📸 ارسال اسکرین‌شات‌ها» ← ۴ یا ۵ اسکرین‌شات جدول آخر بازی رو (آلبومی یا تک‌تک) بفرست. اگه یه تیم توی دو عکس تکرار بشه، فقط یه بار حساب میشه.\n' +
  'بعد «👁 پیش‌نمایش» رو ببین؛ اگه تیمی شناخته نشده یا عددی غلطه، این‌جوری درستش کن:\n<code>رتبه اسلات کیل</code>\nمثلا <code>3 12 7</code> یعنی رتبه‌ی ۳ = تیم اسلات ۱۲ با ۷ کیل. برای حذف یه رتبه: <code>حذف 3</code>\n' +
  'آخر سر «✅ تایید نهایی». تا تایید نکنی هیچ امتیازی ثبت نمیشه.\n\n' +
  '5️⃣ <b>امتیاز (PMGC):</b> هر کیل ۱ امتیاز · رتبه‌ی ۱: ۱۰ · ۲: ۶ · ۳: ۵ · ۴: ۴ · ۵: ۳ · ۶: ۲ · ۷ و ۸: ۱ · بقیه ۰\n' +
  'تساوی: اول کیل بیشتر، بعد چیکن دینر بیشتر، بعد رتبه‌ی بهتر توی آخرین مچ.\n\n' +
  '6️⃣ <b>صعود:</b> بعد از تایید آخرین مچ هر گروه، ربات خودش ۱۰ تیم اول رو بالا می‌بره و بقیه رو حذف می‌کنه. وقتی همه‌ی گروه‌ها تموم شد، قرعه‌ی مرحله‌ی بعد خودکار انجام میشه. بعد از فینال، قهرمان، دوم و سوم اعلام میشن.\n\n' +
  '📱 <b>مینی‌اپ:</b> توضیحات، تیم‌های هر گروه، مسیر تورنمنت و جدول زنده رو برای همه نشون میده.\n\n' +
  '🔑 کلید Gemini (و کلید Pro) رو از «🔑 تنظیمات API» ثبت کن.';

/** The table of a group as text. */
async function tableText(t, stage, g, { channel = false } = {}) {
  const cfg = stg(t)[stage];
  const rows = await standings(t.id, stage, g);
  const played = (await groupMatches(t.id, stage, g)).filter((x) => x.is_confirmed).length;
  const done = await groupDone(t.id, stage, g);
  const L = [`🏆 <b>${esc(t.name)}</b>`, `${cfg.label} · ${groupLabel(stage, g)}`, `📊 بعد از مچ ${played} از ${cfg.matches}${done ? ' · نهایی ✅' : ''}`, '', LINE];
  const MED = ['🥇', '🥈', '🥉'];
  rows.forEach((r, i) => {
    if (cfg.adv && i === cfg.adv) L.push('➖➖➖ <i>خط صعود</i> ➖➖➖');
    const mark = cfg.adv ? (i < cfg.adv ? (done ? '✅' : '🔼') : (done ? '❌' : '')) : (MED[i] || '');
    L.push(`${i + 1}. ${mark} <b>${esc(r.team_name)}</b>${channel ? '' : ` <i>(اسلات ${r.slot_number})</i>`}\n     ⭐️ <b>${r.pts}</b> امتیاز · 🔫 ${r.kills} کیل · 📍 ${r.pp} امتیاز رتبه${r.wwcd ? ` · 🍗 ${r.wwcd}` : ''}`);
  });
  if (!rows.length) L.push('هنوز تیمی نیست.');
  L.push(LINE);
  if (!cfg.next && done && rows.length >= 3) {
    L.push('', `🥇 <b>قهرمان:</b> ${esc(rows[0].team_name)}`, `🥈 <b>نایب‌قهرمان:</b> ${esc(rows[1].team_name)}`, `🥉 <b>سوم:</b> ${esc(rows[2].team_name)}`);
  }
  return L.join('\n');
}

async function groupPage(uid, stage, g) {
  const t = await current();
  if (!t || !stg(t)[stage]) return home(uid);
  const cfg = stg(t)[stage];
  const ms = await groupMatches(t.id, stage, g);
  const done = await groupDone(t.id, stage, g);
  const kb = ms.map((x) => [btn(`${x.is_confirmed ? '✅' : '⏳'} مچ ${x.match_number}${x.map_name ? ' · ' + x.map_name : ''}`, `tn:m:${x.match_id}`)]);
  const last = ms[ms.length - 1];
  if (!done && ms.length < cfg.matches && (!last || last.is_confirmed)) kb.push([btn(`➕ شروع مچ ${ms.length + 1}`, `tn:nm:${cfg.code}:${g}`)]);
  kb.push([btn('📢 ارسال جدول به کانال', `tn:pub:${cfg.code}:${g}`), btn('🔄 تازه‌سازی', `tn:g:${cfg.code}:${g}`)]);
  kb.push([btn('🔙 برگشت به تورنمنت', 'tn')]);
  const text = await tableText(t, stage, g);
  return send(uid, text.length > 4000 ? text.slice(0, 3990) + '…' : text, kb);
}

async function matchPage(uid, mid) {
  const m = await getMatch(mid);
  if (!m) return home(uid);
  const t = await getT(m.tournament_id);
  const cfg = stg(t)[m.stage];
  const rows = await merged(m);
  const nShots = (await db.get(sql`SELECT COUNT(*) AS n FROM shots WHERE match_id = ${mid} AND status = 'ok'`)).n;
  const L = [`🏆 <b>${esc(t.name)}</b>`, `${cfg.label} · ${groupLabel(m.stage, m.group_name)} · <b>مچ ${m.match_number} از ${cfg.matches}</b>`, '',
    `🗺 مپ: <b>${esc(m.map_name || 'انتخاب نشده')}</b>`,
    `⏰ زمان: <b>${m.starts_at ? await store.localStr(m.starts_at) : 'تعیین نشده'}</b>` + (m.starts_at ? ` · ✅ آماده: <b>${(await db.get(sql`SELECT COUNT(*) AS n FROM match_ready WHERE match_id = ${mid}`)).n}</b> از ${(await lobby(m.tournament_id, m.stage, m.group_name)).length} تیم` : ''),
    ...(m.started_at ? [`▶️ شروع: <b>${await store.localStr(m.started_at)}</b> · پایان حدودی: <b>${await store.localStr(m.ends_at)}</b>`] : []),
    `🔑 روم: ${m.room ? '✅ فرستاده شد' : '❌ هنوز نفرستادی'}`,
    `📸 اسکرین‌شات‌ها: <b>${nShots}</b> · تیم‌های خونده‌شده: <b>${rows.length}</b>`, `وضعیت: <b>${m.is_confirmed ? '✅ تایید شده' : '⏳ منتظر نتیجه'}</b>`];
  const kb = [];
  if (!m.is_confirmed) {
    kb.push(...grid(MAPS.map((x, i) => btn((m.map_name === x ? '✅ ' : '🗺 ') + x, `tn:map:${mid}:${i}`)), 3));
    kb.push([btn(m.starts_at ? '⏰ تغییر زمان مچ' : '⏰ تعیین زمان مچ (پیام «آماده‌اید؟»)', `tn:time:${mid}`)],
      [btn('🔑 ارسال آیدی و رمز روم', `tn:room:${mid}`)],
      [btn('📸 ارسال اسکرین‌شات‌ها', `tn:shot:${mid}`), btn('✍️ ورود دستی', `tn:man:${mid}`)],
      [btn('👁 پیش‌نمایش نتایج', `tn:pv:${mid}`), btn('✅ تایید نهایی', `tn:ok:${mid}`)],
      [btn('🧹 پاک کردن نتایج این مچ', `tn:clr:${mid}`)]);
  } else {
    kb.push([btn('👁 نتایج این مچ', `tn:pv:${mid}`)]);
    if (!(await groupDone(m.tournament_id, m.stage, m.group_name))) kb.push([btn('♻️ باز کردن دوباره (برای اصلاح)', `tn:reopen:${mid}`)]);
  }
  kb.push(...backG(m.stage, m.group_name));
  return send(uid, L.join('\n'), kb);
}

async function previewPage(uid, mid) {
  const m = await getMatch(mid);
  if (!m) return home(uid);
  const teamsIn = await lobby(m.tournament_id, m.stage, m.group_name);
  const byId = Object.fromEntries(teamsIn.map((x) => [x.team_id, x]));
  let rows;
  if (m.is_confirmed) {
    rows = (await db.all(sql`SELECT team_id, placement_rank AS rank, kills, placement_points AS pp, total_match_points AS pts FROM match_scores WHERE match_id = ${mid} ORDER BY placement_rank`));
  } else rows = await merged(m);
  const L = [`👁 <b>نتایج مچ ${m.match_number}</b> · ${groupLabel(m.stage, m.group_name)}${m.is_confirmed ? ' · ✅ تایید شده' : ' · پیش‌نویس'}`, ''];
  for (const r of rows) {
    const t = byId[r.team_id];
    const pp = placementPoints(r.rank);
    if (t) L.push(`#${r.rank} ${r.src === 'manual' ? '✍️' : ''}<b>${esc(t.team_name)}</b> (اسلات ${t.slot_number}) · 🔫 ${r.kills} · ⭐️ ${pp + r.kills}`);
    else L.push(`#${r.rank} ⚠️ <b>ناشناس</b> · 🔫 ${r.kills}${r.dup ? ' · تکراری' : ''}${r.names?.length ? `\n     <i>${esc(r.names.join('، '))}</i>` : ''}`);
  }
  if (!rows.length) L.push('هنوز نتیجه‌ای نیست. اسکرین‌شات‌ها رو بفرست یا دستی وارد کن.');
  const kb = [];
  if (!m.is_confirmed) {
    const { errors, warns } = await check(m, rows);
    if (errors.length) L.push('', '⛔️ <b>قبل از تایید درستشون کن:</b>', ...errors.slice(0, 15).map((e) => '▫️ ' + e));
    if (warns.length) L.push('', 'ℹ️ ' + warns.join('\n'));
    L.push('', '✍️ <b>اصلاح:</b> بفرست <code>رتبه اسلات کیل</code> (مثلا <code>3 12 7</code>) · حذف: <code>حذف 3</code>');
    kb.push([btn('✅ تایید نهایی', `tn:ok:${mid}`), btn('📸 عکس بیشتر', `tn:shot:${mid}`)]);
  }
  kb.push(...backM(mid));
  const text = L.join('\n');
  return send(uid, text.length > 4000 ? text.slice(0, 3990) + '…' : text, kb);
}

async function teamsPage(uid, page = 0) {
  const t = await current();
  if (!t) return home(uid);
  const PER = 20;
  const all = await db.all(sql`SELECT * FROM teams WHERE tournament_id = ${t.id} ORDER BY team_id`);
  const pages = Math.max(1, Math.ceil(all.length / PER));
  page = Math.min(Math.max(0, page), pages - 1);
  const list = all.slice(page * PER, page * PER + PER);
  const ST = { ROUND_1: '🎮', SEMI_FINAL: '🔥', FINAL: '👑', ELIMINATED: '❌', CHAMPION: '🏆' };
  const L = [`👥 <b>تیم‌ها</b> (${all.length}/${fmt(t).max}) · صفحه ${page + 1}/${pages}`, ''];
  for (const x of list) {
    L.push(`<code>${x.team_id}</code> ${ST[x.current_stage] || ''} <b>${esc(x.team_name)}</b> · 🎮 ${esc(JSON.parse(x.members || '[]').join('، ') || x.igl_name)}` +
      `${x.group_name ? ` · ${x.group_name}/${x.slot_number}` : ''}${x.status === 'pending' ? ' · ⏳ ناقص' : ''}${x.leader_chat_id ? '' : ' · 🔕'}`);
  }
  if (!all.length) L.push('هنوز تیمی ثبت‌نام نکرده.');
  L.push('', '🔕 = لیدر ربات رو استارت نکرده (رمز روم براش نمیره)',
    '✏️ ویرایش: <code>شماره | اسم تیم | بازیکن ۱ | بازیکن ۲ | بازیکن ۳ | بازیکن ۴</code>' + (t.status === 'REG' ? '\n🗑 حذف: <code>حذف شماره</code>' : ''));
  const nav = [];
  if (page > 0) nav.push(btn('⬅️ قبلی', `tn:teams:${page - 1}`));
  if (page < pages - 1) nav.push(btn('بعدی ➡️', `tn:teams:${page + 1}`));
  return { text: L.join('\n'), kb: [...(nav.length ? [nav] : []), ...(t.status === 'REG' ? [[btn('➕ افزودن دستی تیم', 'tn:add')]] : []), ...backT()] };
}

// ---------- registration ----------
const clean = (s, max) => String(s || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

/** "name | igl | tag" -> { teamName, iglName, clanTag } or an error text */
const TEAM_FORMAT = 'اسم تیم و بعد اسم داخل بازی ۴ بازیکن (اولی لیدر؛ یه بازیکن ذخیره هم اختیاریه)، هر کدوم توی یه خط یا با | جدا';
/** "team | p1 | p2 | p3 | p4 [| p5] [| leader id]" (or one per line) -> { teamName, iglName, members, leader } or an error text */
function parseTeam(text) {
  const p = String(text).split(/[|｜\n]/).map((x) => clean(x, 40)).filter(Boolean);
  const leader = p.length > 1 && /^\d{5,15}$/.test(digits(p[p.length - 1])) ? Number(digits(p.pop())) : null;
  const [teamName, ...players] = p;
  if (!teamName || players.length < 4 || players.length > 5) return TEAM_FORMAT;
  if (new Set(players.map((x) => x.toLowerCase())).size !== players.length) return 'اسم دو تا بازیکن یکیه؛ اسم دقیق هر کدوم رو بنویس.';
  return { teamName, iglName: players[0], clanTag: null, members: players, leader };
}

/** -> [ok, text] */
async function addTeam(t, x, leader, un = null) {
  if (t.status !== 'REG') return [false, '⛔️ ثبت‌نام این تورنمنت تموم شده.'];
  if (await one(sql`SELECT team_id FROM teams WHERE tournament_id = ${t.id} AND lower(team_name) = lower(${x.teamName})`)) return [false, `⚠️ تیمی به اسم «${esc(x.teamName)}» قبلاً ثبت شده.`];
  if (leader && (await one(sql`SELECT team_id FROM teams WHERE tournament_id = ${t.id} AND leader_chat_id = ${leader}`))) return [false, '⚠️ این لیدر قبلاً یه تیم ثبت کرده.'];
  const row = (await db.run(sql`INSERT INTO teams (tournament_id, team_name, igl_name, clan_tag, members, leader_chat_id, leader_un, current_stage, created)
    VALUES (${t.id}, ${x.teamName}, ${x.iglName}, ${x.clanTag}, ${JSON.stringify(x.members || [x.iglName])}, ${leader || null}, ${un}, ${firstStage(t)}, ${now()})
    ON CONFLICT(tournament_id, team_name) DO NOTHING RETURNING team_id`)).rows[0];
  if (!row) return [false, `⚠️ تیمی به اسم «${esc(x.teamName)}» قبلاً ثبت شده.`];
  // two teams taking the last place at once: the later one is out
  const rank = (await db.get(sql`SELECT COUNT(*) AS n FROM teams WHERE tournament_id = ${t.id} AND team_id <= ${row.team_id}`)).n;
  if (rank > fmt(t).max) {
    await db.run(sql`DELETE FROM teams WHERE team_id = ${row.team_id}`);
    return [false, `⛔️ ظرفیت ${fmt(t).max} تیم پر شده.`];
  }
  return [true, row.team_id, rank];
}

// The Mini App (static site, webapp/tournament/): description, teams, the path and the live tables.
export const APP = 'https://app8719466331.tgcloud.ai/tournament/';
const appBtn = (tid, text = '📱 مینی‌اپ تورنمنت') => ({ text, web_app: { url: `${APP}?t=${tid}` } });
/** A link that works in a channel too: it opens the bot, which answers with the Mini App button. */
async function viewLink(tid) {
  const bot = (await store.getSetting('bot_username')) || (await call('getMe', {})).result?.username;
  return `https://t.me/${bot}?start=tv_${tid}`;
}
/** /start tv_<tid> (anyone) */
export async function viewStart(uid, tid) {
  const t = await getT(tid);
  if (!t) return send(uid, '⛔️ این تورنمنت پیدا نشد.', false);
  return send(uid, `🏆 <b>${esc(t.name)}</b>\n\n📱 توضیحات تورنمنت، تیم‌های هر گروه، مسیر مرحله‌ها و جدول زنده رو توی مینی‌اپ ببین 👇`, [[appBtn(t.id, '📱 باز کردن مینی‌اپ تورنمنت')]]);
}

async function regLink() {
  const bot = (await store.getSetting('bot_username')) || (await call('getMe', {})).result?.username;
  const t = await current();
  return t ? `https://t.me/${bot}?start=tr_${t.id}` : null;
}

// ---------- owner: buttons (tn…) ----------
export async function action(uid, st, data, mid) {
  st.w = null;
  if (data === 'tn') return home(uid);
  if (data === 'tn:help') return send(uid, HELP, backT());
  if (data === 'tn:new') {
    const t = await current();
    if (t && t.status !== 'DONE') return send(uid, '⚠️ یه تورنمنت در جریانه. اول تمومش کن یا حذفش کن.', backT());
    return send(uid, '🏆 <b>نوع تورنمنت رو انتخاب کن</b>\n\n' + Object.values(FORMATS).map((f) => `${f.label}\n${f.desc}`).join('\n\n') +
      '\n\n<i>هر تیم یه اسکواد ۴ نفره‌ست. لابی‌های فینال حداکثر ۲۰ تیمه؛ لابی‌های مرحله‌ی اول بزرگ و ۵۰ تیمی تا ۲۵ تیم.</i>',
    [...Object.entries(FORMATS).map(([k, f]) => [btn(`${f.label} (${f.min} تا ${f.max} تیم)`, `tn:new:${k}`)]), ...backT()]);
  }
  if (data.startsWith('tn:new:') && FORMATS[data.slice(7)]) {
    const t = await current();
    if (t && t.status !== 'DONE') return send(uid, '⚠️ یه تورنمنت در جریانه. اول تمومش کن یا حذفش کن.', backT());
    st.w = 'tn:name:' + data.slice(7);
    return send(uid, `${FORMATS[data.slice(7)].label}\n\n🏆 <b>اسم تورنمنت</b> رو بفرست:\n\nمثلا: لیگ کانکی فصل ۱`, backT());
  }
  const t = await current();
  if (!t) return home(uid);
  if (data === 'tn:reg' && t.status === 'REG') {
    await db.run(sql`UPDATE tournaments SET reg_open = ${t.reg_open ? 0 : 1} WHERE id = ${t.id}`);
    return home(uid);
  }
  if (data === 'tn:link') return send(uid, `🔗 <b>لینک ثبت‌نام</b>\n\n${esc(await regLink())}\n\nهر لیدری این لینک رو بزنه، ربات براش باز میشه و ثبت‌نام می‌کنه.`, backT());
  if (data === 'tn:post' || data.startsWith('tn:post:')) {
    const u = await store.user(uid);
    if (!u.channels.length) return send(uid, '📢 اول یه کانال به ربات وصل کن.', [[btn('📢 کانال‌های من', 'chs')], ...backT()]);
    const ch = data === 'tn:post' && u.channels.length === 1 ? u.channels[0] : u.channels.find((c) => String(c.id) === data.slice(8));
    if (!ch) return send(uid, '📢 تو کدوم کانال بذارم؟', [...u.channels.map((c) => [btn(c.title, `tn:post:${c.id}`)]), ...backT()]);
    const r = await call('sendMessage', { chat_id: ch.id, parse_mode: 'HTML', text: `🏆🔥 <b>ثبت‌نام تورنمنت ${esc(t.name)}</b> 🔥🏆\n\n${LINE}\n\n` +
      `👥 ظرفیت: <b>${fmt(t).max} تیم</b> (اسکواد)\n\n${planLines(t).join('\n')}\n\n` +
      '📊 امتیازدهی رسمی PMGC (هر کیل ۱ امتیاز)\n\n' + `${LINE}\n👇 <b>لیدر تیم دکمه‌ی زیر رو بزنه</b> 👇`,
    reply_markup: { inline_keyboard: [[{ text: '📝 ثبت‌نام تیم', url: await regLink(), style: 'success' }], [{ text: '📊 تیم‌ها، مسیر و جدول زنده', url: await viewLink(t.id) }]] } });
    return send(uid, r.ok ? `✅ پست ثبت‌نام تو «${esc(ch.title)}» رفت.` : `⚠️ نرفت: ${esc(r.description)}`, backT());
  }
  if (data.startsWith('tn:teams:')) {
    const p = await teamsPage(uid, Number(data.slice(9)));
    st.w = 'tn:team';
    return send(uid, p.text, p.kb);
  }
  if (data === 'tn:add') {
    if (t.status !== 'REG') return send(uid, '⛔️ ثبت‌نام تموم شده.', backT());
    st.w = 'tn:add';
    return send(uid, '➕ <b>افزودن دستی تیم</b>\n\nهر تیم توی یه خط:\n<code>اسم تیم | بازیکن ۱ (لیدر) | بازیکن ۲ | بازیکن ۳ | بازیکن ۴ | آیدی عددی لیدر</code>\n\n' +
      'بازیکن ذخیره (پنجم) و آیدی عددی اختیاری‌ان. بدون آیدی، رمز روم برای اون لیدر نمیره؛ بهتره لیدر خودش با لینک ثبت‌نام کنه.\n\nمثال:\n<code>Kanki Team | ×͜×ALI | ×͜×REZA | ×͜×AMIR | ×͜×SINA</code>', backT());
  }
  if (data === 'tn:start' || data === 'tn:start!') {
    if (t.status !== 'REG') return home(uid);
    const n = await teamCount(t.id);
    const pend = (await db.get(sql`SELECT COUNT(*) AS n FROM teams WHERE tournament_id = ${t.id} AND status = 'pending'`)).n;
    if (n - pend < fmt(t).min) return send(uid, `⚠️ برای شروع حداقل ${fmt(t).min} تیم کامل لازمه (الان ${n - pend} تیم کامل${pend ? ` و ${pend} تیم ناقص` : ''}).`, backT());
    if (data === 'tn:start') {
      return send(uid, `🎲 <b>شروع تورنمنت</b>\n\n${startText(t, n - pend)}؛` + (pend ? ` ${pend} تیمی که هنوز ۴ نفر نشدن حذف میشن؛` : '') + ` ثبت‌نام بسته میشه و به لیدرها خبر میره.\n\n⚠️ این کار برگشت نداره. مطمئنی؟`,
        [[btn('✅ آره، شروع کن', 'tn:start!')], ...backT()]);
    }
    await dropPending(t.id);
    const k = await drawStage(t.id, firstStage(t), 'REG');
    if (k === null) return home(uid);
    await send(uid, `✅ <b>قرعه انجام شد!</b> ${k} تیم چیده شدن و به لیدرها خبر رفت.`, false);
    return home(uid);
  }
  if (data === 'tn:delt') {
    return send(uid, `🗑 <b>حذف تورنمنت «${esc(t.name)}»</b>\n\nهمه‌ی تیم‌ها، مچ‌ها و امتیازهاش برای همیشه پاک میشن. مطمئنی؟`, [[btn('🗑 آره، حذف کن', 'tn:delt!')], ...backT()]);
  }
  if (data === 'tn:delt!') {
    await db.run(sql`DELETE FROM shots WHERE match_id IN (SELECT match_id FROM matches WHERE tournament_id = ${t.id})`);
    await db.run(sql`DELETE FROM match_scores WHERE match_id IN (SELECT match_id FROM matches WHERE tournament_id = ${t.id})`);
    await db.run(sql`DELETE FROM player_scores WHERE match_id IN (SELECT match_id FROM matches WHERE tournament_id = ${t.id})`);
    await db.run(sql`DELETE FROM match_ready WHERE match_id IN (SELECT match_id FROM matches WHERE tournament_id = ${t.id})`);
    await db.run(sql`DELETE FROM team_players WHERE tournament_id = ${t.id}`);
    await db.run(sql`DELETE FROM plan WHERE tournament_id = ${t.id}`);
    await db.run(sql`DELETE FROM matches WHERE tournament_id = ${t.id}`);
    await db.run(sql`DELETE FROM group_members WHERE tournament_id = ${t.id}`);
    await db.run(sql`DELETE FROM stage_groups WHERE tournament_id = ${t.id}`);
    await db.run(sql`DELETE FROM teams WHERE tournament_id = ${t.id}`);
    await db.run(sql`DELETE FROM tournaments WHERE id = ${t.id}`);
    await send(uid, '🗑 تورنمنت حذف شد.', false);
    return home(uid);
  }
  let mm = data.match(/^tn:(g|nm|pub):(r1|sf|fi):(\w+)(?::(-?\d+))?$/);
  if (mm) {
    const stage = BY_CODE[mm[2]], g = mm[3];
    if (!stg(t)[stage]?.groups.includes(g)) return home(uid);
    if (mm[1] === 'g') return groupPage(uid, stage, g);
    if (mm[1] === 'nm') return newMatch(uid, t, stage, g);
    return publishTable(uid, t, stage, g, mm[4]);
  }
  mm = data.match(/^tn:(m|map|room|time|shot|man|pv|ok|ok!|clr|clr!|reopen|reopen!):(\d+)(?::(\d+))?$/);
  if (!mm) return home(uid);
  const [, act, id, arg] = mm;
  const m = await getMatch(id);
  if (!m || m.tournament_id !== t.id) return home(uid);
  // on an open match's screens, screenshots and "rank slot kills" lines are taken any time
  if (!m.is_confirmed) st.w = `tn:shot:${m.match_id}`;
  if (act === 'm') return matchPage(uid, m.match_id);
  if (act === 'pv') return previewPage(uid, m.match_id);
  if (act === 'reopen' || act === 'reopen!') {
    if (!m.is_confirmed || (await groupDone(t.id, m.stage, m.group_name))) return matchPage(uid, m.match_id);
    const later = await one(sql`SELECT match_id FROM matches WHERE tournament_id = ${t.id} AND stage = ${m.stage} AND group_name = ${m.group_name} AND match_number > ${m.match_number} AND is_confirmed = 1`);
    if (later) return send(uid, '⚠️ مچ بعدی این گروه تایید شده؛ اول اون رو باز کن.', backM(m.match_id));
    if (act === 'reopen') return send(uid, '♻️ امتیازهای این مچ از جدول برداشته میشه تا اصلاحش کنی و دوباره تایید کنی. باشه؟', [[btn('✅ آره', `tn:reopen!:${m.match_id}`)], ...backM(m.match_id)]);
    await db.run(sql`UPDATE matches SET is_confirmed = 0, confirmed_at = NULL WHERE match_id = ${m.match_id}`);
    await db.run(sql`DELETE FROM match_scores WHERE match_id = ${m.match_id}`);
    await db.run(sql`DELETE FROM player_scores WHERE match_id = ${m.match_id}`);
    return matchPage(uid, m.match_id);
  }
  if (m.is_confirmed) return matchPage(uid, m.match_id);
  if (act === 'map' && MAPS[Number(arg)]) {
    await db.run(sql`UPDATE matches SET map_name = ${MAPS[Number(arg)]} WHERE match_id = ${m.match_id}`);
    return matchPage(uid, m.match_id);
  }
  if (act === 'time') {
    st.w = `tn:time:${m.match_id}`;
    return send(uid, `⏰ <b>زمان مچ ${m.match_number}</b> رو بفرست (ساعت ربات):\n\nمثلا <code>21:30</code> یا <code>+45</code> برای ۴۵ دقیقه دیگه.\n\n` +
      'به همه‌ی بازیکن‌های تیم‌های این لابی پیام «آماده‌اید؟» با زمان مچ و دکمه‌ی «✅ آماده‌ایم» میره.', backM(m.match_id));
  }
  if (act === 'room') {
    st.w = `tn:room:${m.match_id}`;
    return send(uid, '🔑 <b>آیدی و رمز روم</b> رو بفرست، هر کدوم توی یه خط:\n\n<code>1234567\n8899</code>\n\n' +
      'برای همه‌ی بازیکن‌های تیم‌های این گروه خصوصی میره، با اسلات هر تیم؛ آیدی و رمز با یه ضربه کپی میشن.', backM(m.match_id));
  }
  if (act === 'shot') {
    st.w = `tn:shot:${m.match_id}`;
    const ai = (await visionKeys()).length;
    return send(uid, await resultAsk(m) + (ai ? '' : '\n\n⚠️ کلید Gemini ثبت نشده؛ اول از «🔑 تنظیمات API» ثبتش کن.'),
      [[btn('👁 پیش‌نمایش و تایید', `tn:pv:${m.match_id}`)], ...backM(m.match_id)]);
  }
  if (act === 'man') {
    st.w = `tn:shot:${m.match_id}`;
    return send(uid, '✍️ <b>ورود دستی نتایج</b>\n\nهر تیم توی یه خط:\n<code>رتبه اسلات کیل</code>\n\nمثال:\n<code>1 7 12\n2 19 5\n3 3 9</code>\n\n' +
      '(رتبه = جایگاه تیم توی مچ، اسلات = شماره‌ی تیم توی لابی)\nحذف یه رتبه: <code>حذف 3</code>\n\n' +
      `اسلات‌های این لابی رو از «👥 تیم‌ها» یا جدول گروه ببین.`, [[btn('👁 پیش‌نمایش نتایج', `tn:pv:${m.match_id}`)], ...backM(m.match_id)]);
  }
  if (act === 'clr') return send(uid, '🧹 همه‌ی عکس‌های خونده‌شده و اصلاحیه‌های این مچ پاک بشن؟', [[btn('✅ آره، پاک کن', `tn:clr!:${m.match_id}`)], ...backM(m.match_id)]);
  if (act === 'clr!') {
    await db.run(sql`DELETE FROM shots WHERE match_id = ${m.match_id}`);
    await db.run(sql`UPDATE matches SET draft = NULL WHERE match_id = ${m.match_id}`);
    return matchPage(uid, m.match_id);
  }
  if (act === 'ok' || act === 'ok!') return confirmMatch(uid, t, m, act === 'ok!');
  return home(uid);
}

async function newMatch(uid, t, stage, g) {
  const cfg = stg(t)[stage];
  if (!(await one(sql`SELECT id FROM stage_groups WHERE tournament_id = ${t.id} AND stage = ${stage} AND group_name = ${g}`)) || (await groupDone(t.id, stage, g))) return groupPage(uid, stage, g);
  const ms = await groupMatches(t.id, stage, g);
  if (ms.length >= cfg.matches) return groupPage(uid, stage, g);
  if (ms.length && !ms[ms.length - 1].is_confirmed) return send(uid, `⚠️ اول نتیجه‌ی مچ ${ms.length} رو تایید کن.`, backG(stage, g));
  const at = await one(sql`SELECT starts_at FROM plan WHERE tournament_id = ${t.id} AND stage = ${stage} AND group_name = ${g} AND match_number = ${ms.length + 1}`);
  await db.run(sql`INSERT INTO matches (tournament_id, stage, group_name, match_number, is_confirmed, starts_at, created)
    VALUES (${t.id}, ${stage}, ${g}, ${ms.length + 1}, 0, ${at?.starts_at ?? null}, ${now()}) ON CONFLICT(tournament_id, stage, group_name, match_number) DO NOTHING`);
  const m = await one(sql`SELECT match_id FROM matches WHERE tournament_id = ${t.id} AND stage = ${stage} AND group_name = ${g} AND match_number = ${ms.length + 1}`);
  return matchPage(uid, m.match_id);
}

async function confirmMatch(uid, t, m, sure) {
  const rows = await merged(m);
  const { errors, warns } = await check(m, rows);
  if (errors.length) return previewPage(uid, m.match_id);
  if (!sure) {
    return send(uid, `✅ <b>تایید نهایی مچ ${m.match_number}</b> · ${groupLabel(m.stage, m.group_name)}\n\n${rows.length} تیم ثبت میشن.` +
      (warns.length ? '\n\nℹ️ ' + warns.join('\n') : '') + '\n\nبعد از تایید، امتیازها توی جدول حساب میشن. مطمئنی؟',
    [[btn('✅ آره، ثبت کن', `tn:ok!:${m.match_id}`), btn('👁 پیش‌نمایش', `tn:pv:${m.match_id}`)], ...backM(m.match_id)]);
  }
  // scores first (the same rows again on a double tap), then the switch that only one tap wins
  await db.run(sql`DELETE FROM match_scores WHERE match_id = ${m.match_id}`);
  await db.insert(matchScores).values(rows.map((r) => ({
    matchId: m.match_id, teamId: r.team_id, placementRank: r.rank, kills: r.kills,
    placementPoints: placementPoints(r.rank), totalMatchPoints: placementPoints(r.rank) + r.kills,
  }))).onConflictDoNothing().run();
  await db.run(sql`DELETE FROM player_scores WHERE match_id = ${m.match_id}`);
  const ps = rows.flatMap((r) => (r.players || []).map((p) => ({ matchId: m.match_id, teamId: r.team_id, playerName: p.name, kills: p.kills })));
  if (ps.length) await db.insert(playerScores).values(ps).run();
  const won = (await db.run(sql`UPDATE matches SET is_confirmed = 1, confirmed_at = ${now()} WHERE match_id = ${m.match_id} AND is_confirmed = 0 RETURNING match_id`)).rows[0];
  if (!won) return matchPage(uid, m.match_id);
  const cfg = stg(t)[m.stage];
  const played = (await groupMatches(t.id, m.stage, m.group_name)).filter((x) => x.is_confirmed).length;
  let note = `✅ <b>مچ ${m.match_number} ثبت شد.</b>`;
  if (played >= cfg.matches) {
    const r = await finalizeGroup(t.id, m.stage, m.group_name);
    if (r) {
      note += cfg.next ? `\n\n🏁 ${groupLabel(m.stage, m.group_name)} تموم شد: ${cfg.adv} تیم اول به ${stg(t)[cfg.next].label} رفتن و به لیدرها خبر داده شد.`
        : '\n\n🏁 <b>فینال تموم شد!</b> به لیدرها خبر داده شد.';
      if (r.group) note += `\n\n🎲 قرعه‌ی ${stg(t)[r.next].label} · ${groupLabel(r.next, r.group)} انجام شد (${r.n} تیم) و اسلات‌ها برای بازیکن‌ها رفت.`;
      else if (r.next) note += `\n\n🎲 همه‌ی گروه‌های این مرحله تموم شد؛ قرعه‌ی ${stg(t)[r.next].label} انجام شد (${r.n} تیم) و گروه و اسلات جدید برای لیدرها رفت.`;
    }
  }
  await send(uid, note, false);
  return groupPage(uid, m.stage, m.group_name);
}

async function publishTable(uid, t, stage, g, chatId) {
  const u = await store.user(uid);
  if (!u.channels.length) return send(uid, '📢 اول یه کانال به ربات وصل کن.', [[btn('📢 کانال‌های من', 'chs')], ...backG(stage, g)]);
  const ch = chatId ? u.channels.find((c) => String(c.id) === chatId) : u.channels.length === 1 ? u.channels[0] : null;
  const code = CODE[stage];
  if (!ch) return send(uid, '📢 تو کدوم کانال بفرستم؟', [...u.channels.map((c) => [btn(c.title, `tn:pub:${code}:${g}:${c.id}`)]), ...backG(stage, g)]);
  const text = await tableText(t, stage, g, { channel: true });
  const r = await call('sendMessage', { chat_id: ch.id, text: text.slice(0, 4096), parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  return send(uid, r.ok ? `✅ جدول تو «${esc(ch.title)}» رفت.` : `⚠️ نرفت: ${esc(r.description)}`, backG(stage, g));
}

// ---------- live matches (the Mini App's admin tab) ----------
/** What the bot says when it waits for a match's result. */
async function resultAsk(m) {
  const t = await getT(m.tournament_id);
  return `📸 <b>نتیجه‌ی ${groupLabel(m.stage, m.group_name)} · مچ ${m.match_number}</b>${m.map_name ? ` · 🗺 ${esc(m.map_name)}` : ''}\n${esc(t?.name || '')}\n\n` +
    'یکی از این‌ها رو بفرست:\n' +
    '▫️ اسکرین‌شات‌های جدول آخر بازی (۴ یا ۵ تا، آلبومی یا تک‌تک)؛ تیم تکراری بین دو عکس یه بار حساب میشه\n' +
    '▫️ یا <b>یه عکس مرتب</b> از رتبه ۱ تا ۲۵ (مثلا ساخته‌ی هوش مصنوعی گوگل)\n' +
    '▫️ یا همون لیست رو <b>به صورت متن</b> paste کن، هر تیم یه خط:\n<code>1 Team Falcon 12</code>\n\n' +
    'بعد از آخرین عکس «👁 پیش‌نمایش و تایید» رو بزن.\n✍️ دستی: <code>رتبه اسلات کیل</code> (مثلا <code>3 12 7</code>)';
}

/** "▶️ start": the match exists, its map and start are kept, the channel hears it. -> null or an error text */
export async function startMatch(uid, t, stage, g, no, map, chatId) {
  const cfg = stg(t)[stage];
  if (!MAP_MIN[map]) return 'نقشه رو انتخاب کن.';
  const m = await ensureMatch(t, stage, g, no);
  if (typeof m === 'string') return m;
  const ends = now() + MAP_MIN[map] * 60;
  // one tap wins (a double tap doesn't post twice)
  const won = (await db.run(sql`UPDATE matches SET map_name = ${map}, started_at = ${now()}, ends_at = ${ends}, started_by = ${uid}, end_pinged = 0
    WHERE match_id = ${m.match_id} AND started_at IS NULL RETURNING match_id`)).rows[0];
  if (!won) return 'این مچ قبلاً شروع شده.';
  await db.run(sql`UPDATE plan SET called = 1 WHERE tournament_id = ${t.id} AND stage = ${stage} AND group_name = ${g} AND match_number = ${no}`);
  if (chatId) {
    const text = `🔴 <b>مچ شروع شد!</b>\n\n🏆 <b>${esc(t.name)}</b>\n🎮 ${esc(cfg.label)} · ${groupLabel(stage, g)} · مچ <b>${no}</b> از ${cfg.matches}\n` +
      `🗺 نقشه: <b>${esc(map)}</b>\n⏱ پایان حدودی: <b>${(await store.localStr(ends)).replace(/^امروز /, '')}</b>\n\n` +
      `🍗 به همه‌ی تیم‌ها موفق باشید! نتیجه و جدول بعد از بازی همین‌جا میاد.\n📊 <a href="${await viewLink(t.id)}">جدول زنده‌ی تورنمنت</a>`;
    const r = await call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    if (!r.ok) return `مچ شروع شد ولی پست کانال نرفت: ${r.description}`;
  }
  return null;
}

/** "📸 send the result": the bot waits for this match's screenshots (the next photos go to it). */
export async function askResult(uid, mid) {
  const m = await getMatch(mid);
  if (!m || m.is_confirmed) return 'این مچ پیدا نشد یا نتیجه‌اش ثبت شده.';
  const st = await store.getSession(uid);
  st.w = `tn:shot:${m.match_id}`;
  await store.saveSession(uid, st);
  await send(uid, await resultAsk(m), [[btn('👁 پیش‌نمایش و تایید', `tn:pv:${m.match_id}`), btn('✍️ ورود دستی', `tn:man:${m.match_id}`)], ...backM(m.match_id)]);
  return null;
}

/** "ID: 1234567 / Pass: 8899", or just the two on two lines (or one line) -> { id, pass } | null */
export function parseRoom(text) {
  const x = digits(String(text || ''));
  const id = x.match(/(?:id|آیدی|ایدی|روم)\s*[:：=-]?\s*([A-Za-z0-9]{3,20})/i)?.[1];
  const pass = x.match(/(?:pass(?:word)?|رمز|پسورد)\s*[:：=-]?\s*(\S{1,20})/i)?.[1];
  if (id && pass) return { id, pass };
  const parts = x.split(/[\s,،|/]+/).filter(Boolean);
  return parts.length === 2 ? { id: parts[0].slice(0, 20), pass: parts[1].slice(0, 20) } : null;
}

/** The match row of a lobby's match number (made when missing). -> the row, or an error text */
async function ensureMatch(t, stage, g, no) {
  const cfg = stg(t)[stage];
  if (!cfg?.groups.includes(g)) return 'گروه درست نیست.';
  if (!(await one(sql`SELECT id FROM stage_groups WHERE tournament_id = ${t.id} AND stage = ${stage} AND group_name = ${g}`))) return 'این گروه هنوز قرعه‌کشی نشده.';
  if (await groupDone(t.id, stage, g)) return 'این گروه تموم شده.';
  if (!Number.isInteger(no) || no < 1 || no > cfg.matches) return 'شماره‌ی مچ درست نیست.';
  if (no > 1 && !(await one(sql`SELECT match_id FROM matches WHERE tournament_id = ${t.id} AND stage = ${stage} AND group_name = ${g} AND match_number = ${no - 1} AND (started_at IS NOT NULL OR is_confirmed = 1)`))) {
    return `اول مچ ${no - 1} این گروه رو شروع کن.`;
  }
  const at = await one(sql`SELECT starts_at FROM plan WHERE tournament_id = ${t.id} AND stage = ${stage} AND group_name = ${g} AND match_number = ${no}`);
  await db.run(sql`INSERT INTO matches (tournament_id, stage, group_name, match_number, is_confirmed, starts_at, created)
    VALUES (${t.id}, ${stage}, ${g}, ${no}, 0, ${at?.starts_at ?? null}, ${now()}) ON CONFLICT(tournament_id, stage, group_name, match_number) DO NOTHING`);
  const m = await one(sql`SELECT * FROM matches WHERE tournament_id = ${t.id} AND stage = ${stage} AND group_name = ${g} AND match_number = ${no}`);
  return m.is_confirmed ? 'نتیجه‌ی این مچ قبلاً ثبت شده.' : m;
}

/** The room's id and password to every player of the lobby, with their slot; both copy with one tap. -> { ok, of, text } */
export async function sendRoom(t, m, id, pass) {
  await db.run(sql`UPDATE matches SET room = ${`ID: ${id}\nPass: ${pass}`} WHERE match_id = ${m.match_id}`);
  const list = await lobby(t.id, m.stage, m.group_name);
  const chats = await chatsByTeam(t.id);
  const kb = [[{ text: '📋 کپی آیدی روم', copy_text: { text: id } }, { text: '📋 کپی رمز', copy_text: { text: pass } }]];
  const out = [];
  for (const x of list) {
    const text = `🔑 <b>روم مچ ${m.match_number}</b> · ${esc(t.name)}\n${esc(stg(t)[m.stage].label)} · ${groupLabel(m.stage, m.group_name)}${m.map_name ? ` · 🗺 ${esc(m.map_name)}` : ''}\n\n` +
      `🆔 آیدی روم: <code>${esc(id)}</code>\n🔒 رمز: <code>${esc(pass)}</code>\n\n👥 تیم: <b>${esc(x.team_name)}</b>\n🎯 اسلات شما: <b>${x.slot_number}</b>\n\n` +
      '👆 روی آیدی یا رمز بزنی کپی میشه (یا دکمه‌های پایین). سریع وارد شو و توی اسلات خودت بشین.\n🔒 رمز رو به کسی خارج از تیمت نده.';
    for (const c of chats[x.team_id] || []) out.push([c, text, kb]);
  }
  const ok = await notifyMany(out);
  const teamsReached = list.filter((x) => (chats[x.team_id] || new Set()).size).length;
  return { ok, of: out.length, text: `🔑 آیدی و رمز روم برای <b>${ok}</b> بازیکن از ${out.length} (${teamsReached} تیم از ${list.length}) رفت.` +
    (out.length - ok ? `\n⚠️ ${out.length - ok} نفر نگرفتن (ربات رو بلاک کردن یا استارت نکردن).` : '') };
}

/** The Mini App's "🔑 send the room" for a lobby's match number. -> { text } or an error text */
export async function roomFromApp(t, stage, g, no, id, pass) {
  id = String(id || '').trim(); pass = String(pass || '').trim();
  if (!/^\S{1,20}$/.test(id) || !/^\S{1,20}$/.test(pass)) return 'آیدی و رمز روم رو بنویس (بدون فاصله).';
  const m = await ensureMatch(t, stage, g, no);
  if (typeof m === 'string') return m;
  return sendRoom(t, m, digits(id), digits(pass));
}

/** Every tick: a started match whose time is up -> "send the result" to whoever started it. */
export async function endReminders() {
  const due = await db.all(sql`SELECT * FROM matches WHERE started_at IS NOT NULL AND is_confirmed = 0 AND end_pinged = 0 AND ends_at <= ${now()} LIMIT 5`);
  for (const m of due) {
    if (!(await db.run(sql`UPDATE matches SET end_pinged = 1 WHERE match_id = ${m.match_id} AND end_pinged = 0 RETURNING match_id`)).rows[0]) continue;
    const t = await getT(m.tournament_id);
    await send(m.started_by || Number(store.OWNER_ID), `⏰ <b>${groupLabel(m.stage, m.group_name)} · مچ ${m.match_number}</b> (${esc(m.map_name || '')}) احتمالاً تموم شد.\n🏆 ${esc(t?.name || '')}\n\n` +
      'وقتی جدول آخر بازی اومد، «📸 ارسال نتیجه» رو بزن و عکس‌ها رو بفرست.', [[btn('📸 ارسال نتیجه', `tn:shot:${m.match_id}`)], [btn('🎮 صفحه‌ی مچ', `tn:m:${m.match_id}`)]]);
  }
}

/** The admin tab's match list: every match of the tournament in play order, with its time, room and state. */
export async function liveView(t) {
  if (t.status === 'REG' && !(await one(sql`SELECT id FROM plan WHERE tournament_id = ${t.id} LIMIT 1`))) return null;
  const S = stg(t);
  const ms = await db.all(sql`SELECT m.*, (SELECT COUNT(*) FROM shots s WHERE s.match_id = m.match_id AND s.status = 'ok') AS shots
    FROM matches m WHERE m.tournament_id = ${t.id}`);
  const plan = await db.all(sql`SELECT stage, group_name, match_number, starts_at FROM plan WHERE tournament_id = ${t.id}`);
  const sg = await db.all(sql`SELECT stage, group_name, done FROM stage_groups WHERE tournament_id = ${t.id}`);
  const tops = await db.all(sql`SELECT s.match_id, t.team_name AS n, s.kills AS k FROM match_scores s JOIN teams t ON t.team_id = s.team_id
    JOIN matches m ON m.match_id = s.match_id WHERE m.tournament_id = ${t.id} AND s.placement_rank = 1`);
  const order = fmt(t).order || Object.entries(S).flatMap(([stage, c]) => c.groups.map((g) => [stage, g]));
  const groups = order.map(([stage, g]) => {
    const c = S[stage], row = sg.find((x) => x.stage === stage && x.group_name === g);
    const feed = c.feed?.[g];
    const list = [];
    for (let no = 1; no <= c.matches; no++) {
      const m = ms.find((x) => x.stage === stage && x.group_name === g && x.match_number === no);
      list.push({ no, id: m?.match_id || null, plan: plan.find((p) => p.stage === stage && p.group_name === g && p.match_number === no)?.starts_at || null,
        map: m?.map_name || null, started: m?.started_at || null, ends: m?.ends_at || null, done: !!m?.is_confirmed, shots: m?.shots || 0,
        drafted: m?.draft && m.draft !== '{}' ? 1 : 0, top: tops.find((x) => x.match_id === m?.match_id) || null,
        room: m?.room ? (m.room.match(/^ID: (\S+)/)?.[1] || '✓') : null });
    }
    return { stage, g, label: groupLabel(stage, g), stageLabel: c.label, drawn: !!row, done: !!row?.done, matches: list,
      from: feed ? feed.join(' و ') : null, adv: c.adv, lobby: c.lobby };
  });
  return { groups, total: groups.reduce((n, x) => n + x.matches.length, 0), maps: MAPS.map((n) => ({ n, min: MAP_MIN[n] })) };
}

// ---------- owner: typed answers (st.w = tn:…) ----------
/** -> true when the message was for the tournament */
export async function input(uid, st, m) {
  const w = st.w || '';
  const text = (m.text || m.caption || '').trim();
  if (w.startsWith('tn:shot:') && (m.photo || (m.document && /^image\//.test(m.document.mime_type || '')))) {
    await takeShot(uid, Number(w.slice(8)), m);
    return true;
  }
  if (!text) return false;
  if (w.startsWith('tn:name:') && FORMATS[w.slice(8)]) {
    st.w = null;
    const t = await current();
    if (t && t.status !== 'DONE') return home(uid).then(() => true);
    const name = clean(text, 60);
    if (!name) return true;
    await db.run(sql`INSERT INTO tournaments (name, status, reg_open, format, created) VALUES (${name}, 'REG', 1, ${w.slice(8)}, ${now()})`);
    await send(uid, `✅ تورنمنت «${esc(name)}» ساخته شد و ثبت‌نامش بازه.`, false);
    await home(uid);
    return true;
  }
  const t = await current();
  if (!t) {
    st.w = null;
    return false;
  }
  if (w === 'tn:add') {
    const out = [];
    for (const line of text.split('\n').map((x) => x.trim()).filter(Boolean)) {
      const x = parseTeam(line);
      if (typeof x === 'string') {
        out.push(`⚠️ ${esc(line)}: ${x}`);
        continue;
      }
      const [ok, res, rank] = await addTeam(t, x, x.leader);
      out.push(ok ? `✅ ${esc(x.teamName)} (${rank}/${fmt(t).max})` : `${res}`);
    }
    await send(uid, out.join('\n').slice(0, 4000) + '\n\nتیم بعدی رو بفرست یا برگرد.', [[btn('👥 تیم‌ها', 'tn:teams:0')], ...backT()]);
    return true;
  }
  if (w === 'tn:team') {
    const del = digits(text).match(/^(?:حذف|del)\s*(\d+)$/i);
    if (del) {
      if (t.status !== 'REG') return send(uid, '⛔️ بعد از شروع تورنمنت تیم حذف نمیشه.', backT()).then(() => true);
      const r = (await db.run(sql`DELETE FROM teams WHERE team_id = ${Number(del[1])} AND tournament_id = ${t.id} RETURNING team_name`)).rows[0];
      await send(uid, r ? `🗑 «${esc(r.team_name)}» حذف شد.` : '⚠️ این شماره پیدا نشد.', false);
    } else {
      const cut = text.indexOf('|');
      const id = Number(digits(text.slice(0, cut).trim()));
      const x = cut > 0 ? parseTeam(text.slice(cut + 1)) : null;
      if (!Number.isInteger(id) || !x) return false;
      if (typeof x === 'string') return send(uid, '⚠️ ' + x, false).then(() => true);
      const dupe = await one(sql`SELECT team_id FROM teams WHERE tournament_id = ${t.id} AND lower(team_name) = lower(${x.teamName}) AND team_id != ${id}`);
      if (dupe) await send(uid, '⚠️ این اسم مال یه تیم دیگه‌ست.', false);
      else {
        const r = (await db.run(sql`UPDATE teams SET team_name = ${x.teamName}, igl_name = ${x.iglName}, members = ${JSON.stringify(x.members)}
          WHERE team_id = ${id} AND tournament_id = ${t.id} RETURNING team_id`)).rows[0];
        await send(uid, r ? '✏️ تیم ویرایش شد.' : '⚠️ این شماره پیدا نشد.', false);
      }
    }
    const pg = await teamsPage(uid, 0);
    st.w = 'tn:team';
    await send(uid, pg.text, pg.kb);
    return true;
  }
  if (w.startsWith('tn:time:')) {
    const mt = await getMatch(w.slice(8));
    if (!mt || mt.tournament_id !== t.id || mt.is_confirmed) return false;
    const ts = await parseWhen(text);
    if (!ts) return send(uid, '⚠️ ساعت رو این‌جوری بفرست: <code>21:30</code> یا <code>+45</code>', backM(mt.match_id)).then(() => true);
    st.w = `tn:shot:${mt.match_id}`;
    await db.run(sql`UPDATE matches SET starts_at = ${ts} WHERE match_id = ${mt.match_id}`);
    await db.run(sql`DELETE FROM match_ready WHERE match_id = ${mt.match_id}`); // a new time: everyone says it again
    const when = await store.localStr(ts);
    await db.run(sql`UPDATE plan SET starts_at = ${ts}, called = 1 WHERE tournament_id = ${t.id} AND stage = ${mt.stage} AND group_name = ${mt.group_name} AND match_number = ${mt.match_number}`);
    const ok = await announce(t, mt.stage, mt.group_name, [{ ...mt, starts_at: ts }]);
    await send(uid, `⏰ زمان مچ ${mt.match_number}: <b>${when}</b>\n📨 پیام «آماده‌اید؟» برای <b>${ok}</b> بازیکن رفت (دکمه‌ی آمادگی برای لیدرها).`, false);
    await matchPage(uid, mt.match_id);
    return true;
  }
  if (w.startsWith('tn:room:')) {
    st.w = null;
    const mt = await getMatch(w.slice(8));
    if (!mt || mt.tournament_id !== t.id) return false;
    if (!mt.is_confirmed) st.w = `tn:shot:${mt.match_id}`;
    const r = parseRoom(text);
    if (!r) return send(uid, '⚠️ آیدی و رمز رو این‌جوری بفرست:\n<code>1234567\n8899</code>', backM(mt.match_id)).then(() => true);
    const res = await sendRoom(t, mt, r.id, r.pass);
    await send(uid, res.text, false);
    await matchPage(uid, mt.match_id);
    return true;
  }
  if (w.startsWith('tn:shot:')) {
    const mt = await getMatch(w.slice(8));
    if (!mt || mt.tournament_id !== t.id || mt.is_confirmed) return false;
    const res = await manualLines(mt, text);
    // not "rank slot kills": a results list (e.g. from Google's AI) for the AI to read
    if (!res) return text.split('\n').filter((x) => x.trim()).length >= 3 ? takeText(uid, mt.match_id, text).then(() => true) : false;
    await send(uid, res, false);
    await previewPage(uid, mt.match_id);
    return true;
  }
  return false;
}

/** "rank slot kills" / "حذف rank" lines -> the match's draft; -> a report, or null when it isn't that */
async function manualLines(m, text) {
  const draft = JSON.parse(m.draft || '{}');
  const list = await lobby(m.tournament_id, m.stage, m.group_name);
  const bySlot = Object.fromEntries(list.map((x) => [x.slot_number, x]));
  const out = [];
  let any = false;
  for (const raw of digits(text).split('\n').map((x) => x.trim()).filter(Boolean)) {
    let mm = raw.match(/^(?:حذف|del|-)\s*#?(\d{1,2})$/i);
    if (mm) {
      draft[Number(mm[1])] = null;
      out.push(`🗑 رتبه‌ی ${mm[1]} حذف شد`);
      any = true;
      continue;
    }
    mm = raw.match(/^#?(\d{1,2})[\s,،:|\-]+(\d{1,2})[\s,،:|\-]+(\d{1,2})$/);
    if (!mm) {
      out.push(`⚠️ نفهمیدم: ${esc(raw)}`);
      continue;
    }
    any = true;
    const [rank, slot, kills] = [Number(mm[1]), Number(mm[2]), Number(mm[3])];
    if (rank < 1 || rank > list.length) {
      out.push(`⚠️ رتبه‌ی ${rank} درست نیست (۱ تا ${list.length})`);
      continue;
    }
    const team = bySlot[slot];
    if (!team) {
      out.push(`⚠️ اسلات ${slot} توی این لابی نیست`);
      continue;
    }
    // a team at one rank only: drop it from any other manual rank
    for (const [k, v] of Object.entries(draft)) if (v && v.team_id === team.team_id && Number(k) !== rank) delete draft[k];
    draft[rank] = { team_id: team.team_id, kills };
    out.push(`✅ #${rank} ${esc(team.team_name)} · 🔫 ${kills}`);
  }
  if (!any && out.length && out.every((x) => x.startsWith('⚠️ نفهمیدم'))) return null;
  await db.run(sql`UPDATE matches SET draft = ${JSON.stringify(draft)} WHERE match_id = ${m.match_id}`);
  return out.join('\n').slice(0, 3500);
}
