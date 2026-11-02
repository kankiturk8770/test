// The admin panel of the tournament Mini App: POST /api/tadmin { t, act, … }. Only the owner and the admins.
//   act: get | sched { day, from, to, len, gap, ggap } | slot { id, at } | call { stage, group } | reg { open } | drop { team }
//        | time { stage, group, no, at } (one match's time) | room { stage, group, no, id, pass } (to every player of the lobby) | start { stage, group, no, map, chan } (the game began: the
//        channel hears it) | result { id } (the bot asks for the screenshots)
import { db, EndpointError } from 'sdk';
import { sql } from 'sdk/db';
import { isOwner, tz, user, getSetting, setSetting } from '../lib/store.js';
import { current, getT, stg, notifyMany, chatsByTeam, startMatch, askResult, liveView, roomFromApp } from '../lib/tournament.js';
import { settings, savePlan, moveSlot, planOf, callNow, deadline, setTime } from '../lib/schedule.js';

const fail = (msg) => { throw new EndpointError(msg, { code: 'BAD' }); };

export default async function (input, ctx) {
  const uid = ctx?.initData?.user?.id;
  if (!uid || !(await isOwner(uid))) throw new EndpointError('فقط ادمین‌ها', { code: 'NOT_ADMIN' });
  const t = input?.t ? await getT(input.t) : await current();
  if (!t) fail('تورنمنتی نیست');
  const act = input?.act || 'get';
  if (act === 'sched') {
    const r = await savePlan(t, { day: String(input.day || ''), from: String(input.from || ''), to: String(input.to || ''), len: Number(input.len), gap: Number(input.gap), ggap: Number(input.ggap), regDays: Number(input.regDays ?? 2) });
    if (typeof r === 'string') fail(r);
  } else if (act === 'slot') {
    const e = await moveSlot(t, Number(input.id), Number(input.at));
    if (e) fail(e);
  } else if (act === 'call') {
    if (!stg(t)[input.stage]?.groups.includes(String(input.group))) fail('گروه درست نیست');
    const r = await callNow(t, input.stage, String(input.group));
    if (typeof r === 'string') fail(r);
  } else if (act === 'reg') {
    if (t.status !== 'REG') fail('ثبت‌نام تموم شده');
    await db.run(sql`UPDATE tournaments SET reg_open = ${input.open ? 1 : 0} WHERE id = ${t.id}`);
  } else if (act === 'drop') {
    if (t.status !== 'REG') fail('بعد از شروع تورنمنت تیم حذف نمیشه');
    const team = await db.get(sql`SELECT * FROM teams WHERE team_id = ${Number(input.team)} AND tournament_id = ${t.id}`);
    if (!team) fail('تیم پیدا نشد');
    const chats = (await chatsByTeam(t.id))[team.team_id] || new Set();
    await db.run(sql`DELETE FROM team_players WHERE team_id = ${team.team_id}`);
    await db.run(sql`DELETE FROM teams WHERE team_id = ${team.team_id}`);
    await notifyMany([...chats].map((c) => [c, `ℹ️ ادمین تیم «${team.team_name}» رو از تورنمنت «${t.name}» حذف کرد.`]));
  } else if (act === 'start') {
    const chans = (await user({ id: uid })).channels;
    const chan = chans.find((c) => String(c.id) === String(input.chan))?.id || null;
    await setSetting('tn_chan', chan ? String(chan) : '0'); // the next start offers the same channel
    const e = await startMatch(uid, t, String(input.stage), String(input.group), Number(input.no), String(input.map), chan);
    if (e) fail(e);
  } else if (act === 'time') {
    const e = await setTime(t, String(input.stage), String(input.group), Number(input.no), Number(input.at));
    if (e) fail(e);
  } else if (act === 'room') {
    const r = await roomFromApp(t, String(input.stage), String(input.group), Number(input.no), input.id, input.pass);
    if (typeof r === 'string') fail(r);
    const v = await view(await getT(t.id), uid);
    v.note = r.text.replace(/<\/?b>/g, '');
    return v;
  } else if (act === 'result') {
    const e = await askResult(uid, Number(input.id));
    if (e) fail(e);
  } else if (act !== 'get') fail('دستور نامعلوم');
  return view(await getT(t.id), uid);
}

async function view(t, uid) {
  const teams = await db.all(sql`SELECT team_id, team_name, clan_tag, status, invite_until FROM teams WHERE tournament_id = ${t.id} ORDER BY team_id`);
  const players = await db.all(sql`SELECT team_id, pubg_name, pubg_id, role FROM team_players WHERE tournament_id = ${t.id} ORDER BY id`);
  const open = await db.all(sql`SELECT match_id, stage, group_name, match_number, starts_at FROM matches WHERE tournament_id = ${t.id} AND is_confirmed = 0 ORDER BY starts_at, match_id`);
  const ready = await db.all(sql`SELECT r.match_id, COUNT(*) AS n FROM match_ready r JOIN matches m ON m.match_id = r.match_id WHERE m.tournament_id = ${t.id} GROUP BY r.match_id`);
  const lobby = await db.all(sql`SELECT stage, group_name, COUNT(*) AS n FROM group_members WHERE tournament_id = ${t.id} GROUP BY stage, group_name`);
  return {
    sched: settings(t), deadline: await deadline(t.id), tz: await tz(), now: Math.floor(Date.now() / 1000), status: t.status, regOpen: !!t.reg_open,
    plan: (await planOf(t.id)).map((r) => ({ id: r.id, stage: r.stage, group: r.group_name, no: r.match_number, at: r.starts_at, called: !!r.called })),
    teams: teams.map((x) => ({ id: x.team_id, name: x.team_name, tag: x.clan_tag, pending: x.status === 'pending', until: x.invite_until,
      players: players.filter((p) => p.team_id === x.team_id).map((p) => ({ n: p.pubg_name, id: p.pubg_id, lead: p.role === 'leader' })) })),
    open: open.map((m) => ({ id: m.match_id, stage: m.stage, group: m.group_name, no: m.match_number, at: m.starts_at,
      ready: ready.find((r) => r.match_id === m.match_id)?.n || 0, of: lobby.find((l) => l.stage === m.stage && l.group_name === m.group_name)?.n || 0 })),
    stages: Object.entries(stg(t)).map(([k, c]) => ({ key: k, label: c.label, groups: c.groups, matches: c.matches })),
    live: await liveView(t),
    chans: (await user({ id: uid })).channels.map((c) => ({ id: String(c.id), title: c.title })), chan: await getSetting('tn_chan'),
  };
}
