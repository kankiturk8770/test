// The tournament Mini App's data (webapp/tournament/): POST /api/tournament { t: id } -> everything the page shows.
// Open to anyone inside Telegram. Only team names and in-game names leave the bot: no Telegram id or username.
import { db, EndpointError } from 'sdk';
import { sql } from 'sdk/db';
import { current, standings, fmt, stg, placementPoints } from '../lib/tournament.js';
import { isOwner, tz, getSetting } from '../lib/store.js';
import { deadline } from '../lib/schedule.js';

// "×͜×ALI" on the scoreboard = "×͜×Ali" registered: letters and digits only, lower case
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const same = (a, b) => a && b && (a === b || (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a))));

export default async function (input, ctx) {
  const id = Number(input?.t);
  const t = id ? await db.get(sql`SELECT * FROM tournaments WHERE id = ${id}`) : await current();
  if (!t) throw new EndpointError('هنوز تورنمنتی ساخته نشده', { code: 'NO_TOURNAMENT' });
  const f = fmt(t);
  const all = await db.all(sql`SELECT team_id, team_name, igl_name, members, current_stage, group_name, slot_number, status FROM teams WHERE tournament_id = ${t.id} ORDER BY team_id`);
  const done = await db.all(sql`SELECT * FROM matches WHERE tournament_id = ${t.id} AND is_confirmed = 1 ORDER BY confirmed_at, match_id`);
  const scores = await db.all(sql`SELECT s.* FROM match_scores s JOIN matches m ON m.match_id = s.match_id WHERE m.tournament_id = ${t.id} AND m.is_confirmed = 1`);
  const pscores = await db.all(sql`SELECT p.* FROM player_scores p JOIN matches m ON m.match_id = p.match_id WHERE m.tournament_id = ${t.id} AND m.is_confirmed = 1`);

  // teams: members with their own kills (scoreboard names matched to the registered ones)
  const teams = {};
  for (const x of all) {
    const reg = JSON.parse(x.members || '[]');
    teams[x.team_id] = { name: x.team_name, pending: x.status === 'pending', stage: x.current_stage, group: x.group_name, slot: x.slot_number,
      members: (reg.length ? reg : [x.igl_name]).map((n) => ({ n, k: 0, key: norm(n) })), kills: 0, wwcd: 0, played: 0, pts: 0 };
  }
  for (const s of scores) {
    const tm = teams[s.team_id];
    if (!tm) continue;
    tm.kills += s.kills; tm.pts += s.total_match_points; tm.played += 1;
    if (s.placement_rank === 1) tm.wwcd += 1;
  }
  for (const p of pscores) {
    const tm = teams[p.team_id];
    if (!tm) continue;
    const key = norm(p.player_name);
    let m = tm.members.find((x) => same(x.key, key));
    if (!m) tm.members.push((m = { n: p.player_name, k: 0, key, sub: true })); // a name not registered (a sub)
    m.k += p.kills;
  }
  for (const tm of Object.values(teams)) tm.members.forEach((m) => delete m.key);

  // stages and groups with their tables
  const order = ['REG', ...Object.keys(stg(t)), 'DONE'];
  const now = order.indexOf(t.status);
  const stages = [];
  for (const [key, c] of Object.entries(stg(t))) {
    const at = order.indexOf(key);
    const groups = [];
    for (const g of c.groups) {
      const sg = await db.get(sql`SELECT done FROM stage_groups WHERE tournament_id = ${t.id} AND stage = ${key} AND group_name = ${g}`);
      if (!sg) {
        groups.push({ name: g, drawn: false, done: false, played: 0, rows: [] });
        continue;
      }
      const played = done.filter((m) => m.stage === key && m.group_name === g).length;
      const rows = (await standings(t.id, key, g)).map((r, i) => ({ rank: i + 1, id: r.team_id, slot: r.slot_number,
        pts: r.pts, kills: r.kills, pp: r.pp, wwcd: r.wwcd, played: r.played, q: sg.done && c.adv ? (i < c.adv ? 1 : 0) : null }));
      groups.push({ name: g, drawn: true, done: !!sg.done, played, rows });
    }
    const live = groups.some((x) => x.drawn && !x.done), over = groups.every((x) => x.done);
    stages.push({ key, label: c.label, groups, matches: c.matches, adv: c.adv, lobby: c.lobby, next: c.next,
      // the bracket as a list: the platform can't send number-like keys ({ 1: [...] })
      feed: c.feed ? Object.entries(c.feed).map(([g, from]) => ({ g, from })) : null,
      state: over || now > at && !live ? 'done' : live || now === at ? 'live' : 'wait' });
  }

  // played matches, newest first: placings, kills, and the players' kills
  const matches = done.slice().reverse().map((m) => ({
    stage: m.stage, label: stg(t)[m.stage]?.label || '', group: m.group_name, no: m.match_number, map: m.map_name,
    rows: scores.filter((s) => s.match_id === m.match_id).sort((a, b) => a.placement_rank - b.placement_rank)
      .map((s) => ({ rank: s.placement_rank, id: s.team_id, kills: s.kills, pts: s.total_match_points })),
    top: pscores.filter((p) => p.match_id === m.match_id).sort((a, b) => b.kills - a.kills).slice(0, 5)
      .map((p) => ({ n: p.player_name, id: p.team_id, k: p.kills })),
  }));

  const champ = all.find((x) => x.current_stage === 'CHAMPION');
  // who is looking: their own team (never anyone's Telegram id), and whether they manage the bot
  const uid = ctx?.initData?.user?.id;
  const meP = uid && (await db.get(sql`SELECT team_id, role, pubg_name FROM team_players WHERE tournament_id = ${t.id} AND user_id = ${uid}`));
  const meL = !meP && uid && (await db.get(sql`SELECT team_id FROM teams WHERE tournament_id = ${t.id} AND leader_chat_id = ${uid}`));
  const me = meP ? { team: meP.team_id, role: meP.role, name: meP.pubg_name } : meL ? { team: meL.team_id, role: 'leader', name: null } : null;
  const plan = await db.all(sql`SELECT stage, group_name, match_number, starts_at FROM plan WHERE tournament_id = ${t.id} ORDER BY starts_at, id`);
  const played = new Set(done.map((m) => `${m.stage}:${m.group_name}:${m.match_number}`));
  return {
    t: { id: t.id, name: t.name, status: t.status, regOpen: !!t.reg_open, format: t.format || 'big', label: f.label, desc: f.desc, max: f.max, min: f.min },
    // a list, not an object keyed by id: the platform can't send number-like keys
    teams: Object.entries(teams).map(([id, x]) => ({ id: Number(id), ...x })), order: all.map((x) => x.team_id), stages, matches,
    podium: t.status === 'DONE' ? (stages.at(-1)?.groups[0]?.rows || []).slice(0, 3).map((r) => r.id) : [],
    champion: champ ? champ.team_id : null,
    schedule: plan.map((r) => ({ stage: r.stage, group: r.group_name, no: r.match_number, at: r.starts_at, done: played.has(`${r.stage}:${r.group_name}:${r.match_number}`) })),
    deadline: await deadline(t.id),
    me, staff: !!(uid && (await isOwner(uid))), tz: await tz(), now: Math.floor(Date.now() / 1000),
    bot: await getSetting('bot_username'),
    points: [1, 2, 3, 4, 5, 6, 7, 8, 9].map(placementPoints),
  };
}
