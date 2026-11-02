// The match schedule. The admin picks the first day and the nightly window (default 20:30 to 24:00); every group
// plays all its matches of a stage back to back (30 min a match, 10 min between them), the next group after a
// 20 min break; what doesn't fit tonight moves to the next night, and every stage starts on a new night.
// An hour before a group's first match, its leaders get "are you ready?" (lib/tournament.js announce).
// The players' registration deadline is 1, 2 or 3 days before the first match (the admin picks it, regDays);
// a team registering after it gets an hour.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { now } from './util.js';
import * as store from './store.js';
import { getT, stg, fmt, announce, groupLabel, APP } from './tournament.js';
import { send } from './util.js';

export const DEFAULTS = { day: null, from: '20:30', to: '24:00', len: 30, gap: 10, ggap: 20, regDays: 2 };
export const LATE = 3600; // a team registering after the deadline gets an hour
export const CALL_BEFORE = 3600; // "are you ready?" an hour before
const BLOCK_SPAN = 3 * 3600; // matches of a group within 3 hours of its first one are announced together

export const settings = (t) => ({ ...DEFAULTS, ...JSON.parse(t?.sched || '{}') });
const mins = (hhmm) => {
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})$/);
  return m && Number(m[1]) <= 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null;
};
/** 'YYYY-MM-DD' (the bot's local day) + minutes after its midnight -> unix time */
async function at(day, minutes) {
  const [y, mo, d] = day.split('-').map(Number);
  return Date.UTC(y, mo - 1, d) / 1000 + minutes * 60 - (await store.tz()) * 60;
}

/** The settings -> [{ stage, group, no, at }] or an error text. */
export async function buildPlan(t, cfg) {
  const c = { ...DEFAULTS, ...cfg };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.day || '')) return 'روز شروع رو انتخاب کن.';
  const from = mins(c.from);
  let to = mins(c.to);
  const len = Number(c.len), gap = Number(c.gap), ggap = Number(c.ggap);
  if (from == null || to == null) return 'ساعت‌ها رو این‌جوری بده: 20:30';
  if (to <= from) to += 1440; // e.g. 20:30 to 00:30
  if (![len, gap, ggap].every((x) => Number.isInteger(x) && x >= 0 && x <= 180) || len < 10) return 'مدت مچ و استراحت‌ها درست نیست.';
  if (![1, 2, 3].includes(Number(c.regDays))) return 'مهلت ثبت‌نام باید ۱، ۲ یا ۳ روز قبل از اولین مچ باشه.';
  const rows = [];
  let night = -1, cursor = from, prev = null;
  // a bracket format names its own order (A, B, semi-final 1, C, D, …); otherwise stage by stage
  const order = fmt(t).order || Object.entries(stg(t)).flatMap(([stage, s]) => s.groups.map((g) => [stage, g]));
  for (const [stage, g] of order) {
    const s = stg(t)[stage];
    const block = s.matches * len + (s.matches - 1) * gap;
    if (block > to - from) return `مچ‌های یه گروه (${s.matches} مچ) توی این بازه‌ی ساعت جا نمیشن؛ بازه رو بزرگ‌تر کن.`;
    // a new stage starts a new night (in a bracket order only the final does); what doesn't fit goes to the next
    const fresh = night < 0 || (fmt(t).order ? stage === 'FINAL' && prev !== 'FINAL' : stage !== prev);
    if (fresh || cursor + block > to) {
      night += 1;
      cursor = from;
    }
    for (let k = 0; k < s.matches; k++) rows.push({ stage, group: g, no: k + 1, at: await at(c.day, night * 1440 + cursor + k * (len + gap)) });
    cursor += block + ggap;
    prev = stage;
  }
  return rows;
}

/** Saves the settings and the new schedule; unplayed matches move with it; the players' deadline follows. */
export async function savePlan(t, cfg) {
  const rows = await buildPlan(t, cfg);
  if (typeof rows === 'string') return rows;
  await db.run(sql`UPDATE tournaments SET sched = ${JSON.stringify({ ...DEFAULTS, ...cfg, regDays: Number(cfg.regDays ?? DEFAULTS.regDays) })} WHERE id = ${t.id}`);
  await db.run(sql`DELETE FROM plan WHERE tournament_id = ${t.id}`);
  for (const r of rows) {
    // a time already past is never announced again
    await db.run(sql`INSERT INTO plan (tournament_id, stage, group_name, match_number, starts_at, called)
      VALUES (${t.id}, ${r.stage}, ${r.group}, ${r.no}, ${r.at}, ${r.at <= now() ? 1 : 0})`);
    await db.run(sql`UPDATE matches SET starts_at = ${r.at} WHERE tournament_id = ${t.id} AND stage = ${r.stage} AND group_name = ${r.group} AND match_number = ${r.no} AND is_confirmed = 0`);
  }
  await applyDeadline(t.id);
  return rows;
}

/** One slot moved by hand. */
export async function moveSlot(t, id, ts) {
  const r = await db.get(sql`SELECT * FROM plan WHERE id = ${Number(id)} AND tournament_id = ${t.id}`);
  if (!r) return 'این مچ توی برنامه پیدا نشد.';
  await db.run(sql`UPDATE plan SET starts_at = ${ts}, called = ${ts <= now() ? 1 : 0} WHERE id = ${r.id}`);
  await db.run(sql`UPDATE matches SET starts_at = ${ts} WHERE tournament_id = ${t.id} AND stage = ${r.stage} AND group_name = ${r.group_name} AND match_number = ${r.match_number} AND is_confirmed = 0`);
  await applyDeadline(t.id);
  return null;
}

/** One match's time set by hand in the Mini App (the row is made when missing). -> null or an error text */
export async function setTime(t, stage, g, no, ts) {
  const cfg = stg(t)[stage];
  if (!cfg?.groups.includes(g) || !Number.isInteger(no) || no < 1 || no > cfg.matches) return 'این مچ توی برنامه نیست.';
  if (!Number.isInteger(ts) || ts < now() - 30 * 86400 || ts > now() + 120 * 86400) return 'تاریخ و ساعت درست نیست.';
  await db.run(sql`INSERT INTO plan (tournament_id, stage, group_name, match_number, starts_at, called, pinged)
    VALUES (${t.id}, ${stage}, ${g}, ${no}, ${ts}, ${ts <= now() ? 1 : 0}, ${ts <= now() ? 1 : 0})
    ON CONFLICT(tournament_id, stage, group_name, match_number) DO UPDATE SET starts_at = excluded.starts_at, called = excluded.called, pinged = excluded.pinged`);
  await db.run(sql`UPDATE matches SET starts_at = ${ts} WHERE tournament_id = ${t.id} AND stage = ${stage} AND group_name = ${g} AND match_number = ${no} AND is_confirmed = 0`);
  await applyDeadline(t.id);
  return null;
}

/** Every tick: 10 minutes before a drawn group's match, the admins get "send the room, then start". */
export async function pingAdmins() {
  const due = await db.all(sql`SELECT * FROM plan WHERE pinged = 0 AND starts_at <= ${now() + 600} AND starts_at > ${now() - 1800} LIMIT 5`);
  for (const p of due) {
    if (!(await db.run(sql`UPDATE plan SET pinged = 1 WHERE id = ${p.id} AND pinged = 0 RETURNING id`)).rows[0]) continue;
    const t = await getT(p.tournament_id);
    if (!t || !stg(t)[p.stage]) continue;
    if (!(await db.get(sql`SELECT id FROM stage_groups WHERE tournament_id = ${t.id} AND stage = ${p.stage} AND group_name = ${p.group_name} AND done = 0`))) continue;
    const m = await db.get(sql`SELECT started_at, is_confirmed FROM matches WHERE tournament_id = ${t.id} AND stage = ${p.stage} AND group_name = ${p.group_name} AND match_number = ${p.match_number}`);
    if (m?.started_at || m?.is_confirmed) continue;
    const mins = Math.max(0, Math.round((p.starts_at - now()) / 60));
    for (const id of await store.staffIds()) {
      await send(id, `⏰ <b>${mins ? `${mins} دقیقه تا ` : 'وقت '}${groupLabel(p.stage, p.group_name)} · مچ ${p.match_number}</b> (${await store.localStr(p.starts_at)})\n🏆 ${t.name}\n\n` +
        '۱) روم رو بساز و آیدی و رمز رو از پنل بفرست\n۲) وقتی توی بازی استارت زدی «▶️ شروع مچ» رو بزن',
      [[{ text: '🛠 پنل مدیریت مچ‌ها', web_app: { url: `${APP}?t=${t.id}&admin=1` } }]]);
    }
  }
}

export const planOf = (tid) => db.all(sql`SELECT * FROM plan WHERE tournament_id = ${tid} ORDER BY starts_at, id`);

/** regDays before the first match, or null while there is no schedule. */
export async function deadline(tid) {
  const r = await db.get(sql`SELECT MIN(starts_at) AS s FROM plan WHERE tournament_id = ${tid}`);
  if (!r?.s) return null;
  const days = Number(settings(await getT(tid)).regDays);
  return r.s - ([1, 2, 3].includes(days) ? days : DEFAULTS.regDays) * 86400;
}
/** The deadline a team registering now gets (a late team still gets an hour). */
export async function inviteUntil(tid) {
  const d = await deadline(tid);
  return d ? Math.max(d, now() + LATE) : null;
}
export async function applyDeadline(tid) {
  const until = await inviteUntil(tid);
  await db.run(sql`UPDATE teams SET invite_until = ${until}, reminded = 0 WHERE tournament_id = ${tid} AND status = 'pending'`);
}

/** Matches of a group to announce together: from its first unannounced slot, within 3 hours. */
async function block(t, stage, g, onlyDue) {
  const slots = await db.all(sql`SELECT * FROM plan WHERE tournament_id = ${t.id} AND stage = ${stage} AND group_name = ${g} AND called = 0 ORDER BY starts_at`);
  if (!slots.length || (onlyDue && slots[0].starts_at > now() + CALL_BEFORE)) return [];
  return slots.filter((x) => x.starts_at <= slots[0].starts_at + BLOCK_SPAN);
}

/** Creates the block's matches (with their times), marks the slots announced and sends "are you ready?". -> players reached or null */
async function callBlock(t, stage, g, slots) {
  const won = [];
  for (const sl of slots) if ((await db.run(sql`UPDATE plan SET called = 1 WHERE id = ${sl.id} AND called = 0 RETURNING id`)).rows[0]) won.push(sl);
  if (!won.length) return null;
  const ms = [];
  for (const sl of won) {
    await db.run(sql`INSERT INTO matches (tournament_id, stage, group_name, match_number, is_confirmed, starts_at, created)
      VALUES (${t.id}, ${stage}, ${g}, ${sl.match_number}, 0, ${sl.starts_at}, ${now()}) ON CONFLICT(tournament_id, stage, group_name, match_number) DO NOTHING`);
    await db.run(sql`UPDATE matches SET starts_at = ${sl.starts_at} WHERE tournament_id = ${t.id} AND stage = ${stage} AND group_name = ${g} AND match_number = ${sl.match_number} AND is_confirmed = 0`);
    const m = await db.get(sql`SELECT * FROM matches WHERE tournament_id = ${t.id} AND stage = ${stage} AND group_name = ${g} AND match_number = ${sl.match_number}`);
    if (m && !m.is_confirmed) ms.push(m);
  }
  return ms.length ? announce(t, stage, g, ms) : 0;
}

/** Every tick: the groups whose matches start within the hour (and are drawn) get "are you ready?". */
export async function callDue() {
  const due = await db.all(sql`SELECT DISTINCT tournament_id, stage, group_name FROM plan WHERE called = 0 AND starts_at <= ${now() + CALL_BEFORE} AND starts_at > ${now() - 1800} LIMIT 5`);
  for (const d of due) {
    const t = await getT(d.tournament_id);
    if (!t) continue;
    if (!(await db.get(sql`SELECT id FROM stage_groups WHERE tournament_id = ${t.id} AND stage = ${d.stage} AND group_name = ${d.group_name}`))) continue;
    await callBlock(t, d.stage, d.group_name, await block(t, d.stage, d.group_name, true));
  }
}

/** The admin's "📣 send now" for a group. -> players reached, or an error text */
export async function callNow(t, stage, g) {
  if (!(await db.get(sql`SELECT id FROM stage_groups WHERE tournament_id = ${t.id} AND stage = ${stage} AND group_name = ${g}`))) return 'این گروه هنوز قرعه‌کشی نشده.';
  const slots = await block(t, stage, g, false);
  if (slots.length) return (await callBlock(t, stage, g, slots)) ?? 0;
  // no schedule left: the open matches that already have a time
  const ms = (await db.all(sql`SELECT * FROM matches WHERE tournament_id = ${t.id} AND stage = ${stage} AND group_name = ${g} AND is_confirmed = 0 AND starts_at IS NOT NULL ORDER BY match_number`));
  return ms.length ? announce(t, stage, g, ms) : 'برای این گروه مچی با زمان مشخص نیست.';
}
