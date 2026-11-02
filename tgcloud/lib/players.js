// The players' side of a tournament (everyone who isn't an admin):
//   the leader opens the bot from the channel's "register" button (/start tr_<tid>), accepts the rules and gives
//   the team name, the team tag (e.g. MK) and their own in-game name + PUBG id; the bot gives an invite link
//   (t.me/<bot>?start=tj_<code>) that works for 2 hours. The 3 teammates open it and give their in-game name
//   + PUBG id; every name must contain the team tag. 4 players -> the team is registered. The deadline is 1-3 days
//   before the first match (lib/schedule.js): a team still not complete then is removed and the channel hears that
//   a place is free; a team registering after the deadline gets an hour. The players get a reminder 6 hours before.
//   Then "📊 داشبورد تیم من": the team, its next matches (with "✅ we're ready"), its results and its path.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { esc, btn, send, call, now, digits, LINE } from './util.js';
import * as store from './store.js';
import { current, getT, fmt, stg, standings, APP, teamCount, groupLabel, firstStage, groupMatches, notifyMany } from './tournament.js';
import { inviteUntil } from './schedule.js';

export const SQUAD = 4;
const one = async (q) => (await db.get(q)) || null;
const clean = (s, max) => String(s || '').replace(/[<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const code = () => [...crypto.getRandomValues(new Uint8Array(10))].map((x) => 'abcdefghijkmnpqrstuvwxyz23456789'[x % 32]).join('');
const appBtn = (tid) => ({ text: '📱 مینی‌اپ تورنمنت', web_app: { url: `${APP}?t=${tid}` } });
const DASH = [btn('📊 داشبورد تیم من', 'tp:d')];
const clock = async (ts) => store.localStr(ts);
async function bot() {
  return (await store.getSetting('bot_username')) || (await call('getMe', {})).result?.username;
}
const inviteLink = async (team) => `https://t.me/${await bot()}?start=tj_${team.invite}`;

export const RULES = '📜 <b>قوانین ثبت‌نام</b>\n\n' +
  `1️⃣ هر تیم <b>${SQUAD} نفره</b>‌ست: لیدر + ۳ بازیکن.\n` +
  '2️⃣ لیدر اسم تیم و یه <b>تگ تیم</b> انتخاب می‌کنه (مثلا <code>MK</code>).\n' +
  '3️⃣ <b>اسم داخل بازی هر ۴ نفر باید تگ تیم رو داشته باشه</b> (مثلا <code>MK·Ali</code> یا <code>MKReza</code>) تا نتیجه‌ی هر مچ درست به تیمتون برسه.\n' +
  '4️⃣ هر بازیکن اسم داخل بازی و <b>آیدی عددی پابجی</b> خودش رو دقیق می‌فرسته؛ اسم باید دقیقاً همونی باشه که توی بازیه.\n' +
  '5️⃣ بعد از ثبت لیدر، یه <b>لینک دعوت</b> برای ۳ هم‌تیمی ساخته میشه. هر ۳ نفر باید با همین لینک ثبت‌نام کنن و عضو ربات بشن.\n' +
  '6️⃣ ⚠️ <b>مهلت: چند روز قبل از اولین مچ</b> (ساعت دقیقش بعد از ثبت لیدر نوشته میشه). تیمی که تا اون موقع ۴ نفرش کامل نشه، <b>از تورنمنت حذف میشه</b> و جاش به یه تیم دیگه داده میشه. تیمی که بعد از مهلت ثبت‌نام کنه فقط <b>۱ ساعت</b> وقت داره.\n' +
  '7️⃣ هر نفر فقط توی یه تیم می‌تونه باشه.';

/** The player's row and their team in the newest tournament they joined, or null. */
async function mine(uid) {
  return one(sql`SELECT p.*, t.team_name, t.clan_tag, t.status AS team_status, t.invite, t.invite_until, t.current_stage, t.group_name, t.slot_number
    FROM team_players p JOIN teams t ON t.team_id = p.team_id WHERE p.user_id = ${uid} ORDER BY p.id DESC LIMIT 1`);
}
const playersOf = (teamId) => db.all(sql`SELECT * FROM team_players WHERE team_id = ${teamId} ORDER BY CASE role WHEN 'leader' THEN 0 ELSE 1 END, id`);

async function syncMembers(teamId) {
  const list = await playersOf(teamId);
  await db.run(sql`UPDATE teams SET members = ${JSON.stringify(list.map((x) => x.pubg_name))}, igl_name = ${list[0]?.pubg_name || ''} WHERE team_id = ${teamId}`);
  return list;
}

/** /start (anyone who isn't an admin): what they can do here. */
export async function userMenu(uid) {
  const t = await current();
  const p = await mine(uid);
  const kb = [];
  if (p) kb.push(DASH);
  else if (t && t.status === 'REG' && t.reg_open) kb.push([btn(`📝 ثبت‌نام تیم در «${t.name}»`, `tp:reg:${t.id}`)]);
  if (t) kb.push([appBtn(t.id)]);
  return send(uid, '🎮 <b>سلام! خوش اومدی</b> 👋\n\n' +
    (p ? `👥 تیمت: <b>${esc(p.team_name)}</b>\nاز «📊 داشبورد تیم من» مچ‌ها، نتیجه‌ها و مسیر تیمت رو ببین.`
      : t && t.status === 'REG' && t.reg_open ? `🏆 ثبت‌نام تورنمنت «${esc(t.name)}» بازه.\nاگه لیدر تیمی، «📝 ثبت‌نام تیم» رو بزن. اگه هم‌تیمی هستی، لینک دعوت رو از لیدرت بگیر.`
        : '🏆 برای ثبت‌نام توی تورنمنت، دکمه‌ی «ثبت‌نام» زیر پست تورنمنت توی کانال رو بزن.\n🎁 برای قرعه‌کشی‌ها، دکمه‌ی «شرکت» زیر پست کانال رو بزن.'),
  kb.length ? kb : false);
}

// ---------- the leader ----------
/** /start tr_<tid> or "📝 ثبت‌نام تیم": the rules first. */
export async function regIntro(uid, tid) {
  const t = await getT(tid);
  if (!t) return send(uid, '⛔️ این تورنمنت پیدا نشد.', false);
  if (await mine(uid).then((p) => p && p.tournament_id === t.id)) return dashboard(uid);
  if (t.status !== 'REG' || !t.reg_open) return send(uid, `⛔️ ثبت‌نام «${esc(t.name)}» بسته است.`, [[appBtn(t.id)]]);
  if ((await teamCount(t.id)) >= fmt(t).max) return send(uid, `⛔️ ظرفیت ${fmt(t).max} تیم پر شده.`, [[appBtn(t.id)]]);
  return send(uid, `🏆 <b>ثبت‌نام تورنمنت ${esc(t.name)}</b>\n${esc(fmt(t).desc)}\n\n${RULES}\n\n👇 اگه <b>لیدر تیم</b> هستی و قوانین رو قبول داری، دکمه‌ی زیر رو بزن. اگه هم‌تیمی هستی، فقط لینک دعوت لیدرت رو بزن.`,
    [[btn('✅ قوانین رو قبول دارم؛ لیدرم و تیم ثبت می‌کنم', `tp:lead:${t.id}`)], [appBtn(t.id)]]);
}

async function openReg(uid, tid) {
  const t = await getT(tid);
  if (!t || t.status !== 'REG' || !t.reg_open) return [null, send(uid, '⛔️ ثبت‌نام بسته است.', false)];
  if ((await teamCount(t.id)) >= fmt(t).max) return [null, send(uid, `⛔️ ظرفیت ${fmt(t).max} تیم پر شده.`, false)];
  if (await one(sql`SELECT id FROM team_players WHERE tournament_id = ${t.id} AND user_id = ${uid}`)) return [null, dashboard(uid)];
  return [t, null];
}

const CANCEL = [[btn('❌ لغو ثبت‌نام', 'tp:stop')]];

/** Typed answers (st.w = tp:name:<tid> / tp:tag:<tid> / tp:me:<tid> / tp:join:<teamId>). -> true when used */
export async function input(uid, st, text, from) {
  const w = st.w || '';
  const m = w.match(/^tp:(name|tag|me|join):(\d+)$/);
  if (!m || !text) return false;
  const [, step, id] = m;
  if (step === 'join') return joinAnswer(uid, st, Number(id), text);
  const [t, refused] = await openReg(uid, id);
  if (!t) {
    st.w = null;
    await refused;
    return true;
  }
  st.tp ||= {};
  if (step === 'name') {
    const name = clean(text, 30);
    if (name.length < 2) return send(uid, '⚠️ اسم تیم کوتاهه؛ دوباره بفرست.', CANCEL).then(() => true);
    if (await one(sql`SELECT team_id FROM teams WHERE tournament_id = ${t.id} AND lower(team_name) = lower(${name})`)) {
      return send(uid, `⚠️ تیمی به اسم «${esc(name)}» قبلاً ثبت شده؛ یه اسم دیگه بفرست.`, CANCEL).then(() => true);
    }
    st.tp.name = name;
    st.w = `tp:tag:${t.id}`;
    await send(uid, `👥 اسم تیم: <b>${esc(name)}</b>\n\n🏷 حالا <b>تگ تیم</b> رو بفرست (۲ تا ۸ حرف، بدون فاصله).\nمثلا: <code>MK</code>\n\n⚠️ اسم داخل بازی هر ۴ نفرتون باید این تگ رو داشته باشه.`, CANCEL);
    return true;
  }
  if (step === 'tag') {
    const tag = clean(text, 12);
    if (tag.length < 2 || tag.length > 8 || /\s/.test(tag)) return send(uid, '⚠️ تگ باید ۲ تا ۸ حرف و بدون فاصله باشه؛ مثلا <code>MK</code>', CANCEL).then(() => true);
    if (await one(sql`SELECT team_id FROM teams WHERE tournament_id = ${t.id} AND lower(clan_tag) = lower(${tag})`)) {
      return send(uid, `⚠️ تگ «${esc(tag)}» مال یه تیم دیگه‌ست؛ یه تگ دیگه بفرست.`, CANCEL).then(() => true);
    }
    st.tp.tag = tag;
    st.w = `tp:me:${t.id}`;
    await send(uid, `🏷 تگ تیم: <b>${esc(tag)}</b>\n\n👑 حالا <b>اسم داخل بازی</b> و <b>آیدی عددی پابجی</b> خودت رو بفرست، هر کدوم توی یه خط:\n\n<code>${esc(tag)}·Ali\n5123456789</code>`, CANCEL);
    return true;
  }
  // step me: the leader's own name + PUBG id -> the team (waiting for its players) and the invite link
  const pl = await parsePlayer(t, text, st.tp.tag);
  if (typeof pl === 'string') return send(uid, '⚠️ ' + pl, CANCEL).then(() => true);
  if (!st.tp.name || !st.tp.tag) {
    st.w = `tp:name:${t.id}`;
    return send(uid, '⚠️ اول اسم تیم رو بفرست.', CANCEL).then(() => true);
  }
  const c = code();
  const row = (await db.run(sql`INSERT INTO teams (tournament_id, team_name, igl_name, clan_tag, members, leader_chat_id, current_stage, status, invite, invite_until, created)
    VALUES (${t.id}, ${st.tp.name}, ${pl.name}, ${st.tp.tag}, ${JSON.stringify([pl.name])}, ${uid}, ${firstStage(t)}, 'pending', ${c}, ${await inviteUntil(t.id)}, ${now()})
    ON CONFLICT(tournament_id, team_name) DO NOTHING RETURNING team_id`)).rows[0];
  if (!row) {
    st.w = `tp:name:${t.id}`;
    return send(uid, `⚠️ همین الان یه تیم دیگه اسم «${esc(st.tp.name)}» رو گرفت؛ یه اسم دیگه بفرست.`, CANCEL).then(() => true);
  }
  // two teams taking the last place at once: the later one is out
  const rank = (await db.get(sql`SELECT COUNT(*) AS n FROM teams WHERE tournament_id = ${t.id} AND team_id <= ${row.team_id}`)).n;
  const added = rank <= fmt(t).max && (await db.run(sql`INSERT INTO team_players (tournament_id, team_id, user_id, pubg_name, pubg_id, role, created)
    VALUES (${t.id}, ${row.team_id}, ${uid}, ${pl.name}, ${pl.id}, 'leader', ${now()}) ON CONFLICT DO NOTHING RETURNING id`)).rows[0];
  if (!added) {
    await db.run(sql`DELETE FROM teams WHERE team_id = ${row.team_id}`);
    st.w = null;
    return send(uid, rank > fmt(t).max ? `⛔️ ظرفیت ${fmt(t).max} تیم پر شد.` : '⚠️ این آیدی پابجی یا حساب تلگرام قبلاً توی یه تیم دیگه ثبت شده.', false).then(() => true);
  }
  st.w = null;
  st.tp = null;
  const team = await one(sql`SELECT * FROM teams WHERE team_id = ${row.team_id}`);
  await send(uid, '✅ <b>تیم ساخته شد!</b> حالا هم‌تیمی‌هات رو دعوت کن 👇', false);
  await send(uid, `🚨 <b>هشدار جدی به لیدر</b> 🚨\n\nهر <b>۳ هم‌تیمیت</b> باید با لینک دعوت زیر ثبت‌نام کنن و عضو ربات بشن، ` +
    `<b>${team.invite_until ? 'تا ' + (await clock(team.invite_until)) : 'تا پایان مهلت ثبت‌نام (چند روز قبل از اولین مچ)'}</b>.\n\n` +
    '❌ اگه تا اون موقع تیمت ۴ نفر نشه، <b>تیمت از تورنمنت حذف میشه</b> و جاش به یه تیم دیگه داده میشه؛ این قانون برای همه‌ی تیم‌ها یکسانه و استثنا نداره.\n\n' +
    '✅ همین الان لینک رو براشون بفرست تا جاتون قطعی بشه.', false);
  await send(uid, await inviteText(team), [[{ text: '📤 فرستادن لینک برای هم‌تیمی‌ها', url: `https://t.me/share/url?url=${encodeURIComponent(await inviteLink(team))}&text=${encodeURIComponent(`دعوت به تیم ${team.team_name} برای تورنمنت`)}` }], DASH]);
  await staffNote(`📝 <b>تیم جدید (در انتظار بازیکن‌ها)</b>\n👥 ${esc(team.team_name)} · 🏷 ${esc(team.clan_tag)} · 👑 ${esc(pl.name)}`);
  return true;
}

async function inviteText(team) {
  return `🔗 <b>لینک دعوت تیم ${esc(team.team_name)}</b>\n\n<code>${esc(await inviteLink(team))}</code>\n\n` +
    `این لینک رو برای ۳ هم‌تیمیت بفرست. هر کدوم با زدنش، اسم داخل بازی و آیدی پابجی خودش رو ثبت می‌کنه.\n\n` +
    `🏷 اسم داخل بازی همه باید <b>${esc(team.clan_tag)}</b> رو داشته باشه.\n` +
    `⏳ مهلت: <b>${team.invite_until ? await clock(team.invite_until) : 'چند روز قبل از اولین مچ (زمانش به‌زودی اعلام میشه)'}</b>؛ اگه تا اون موقع ۴ نفر نشید، تیم از تورنمنت حذف میشه.`;
}

/** "name\nid" or "name | id" -> { name, id } or an error text */
async function parsePlayer(t, text, tag) {
  const p = String(text).split(/[\n|｜]/).map((x) => x.trim()).filter(Boolean);
  const name = clean(p[0], 30);
  const id = digits(p[1] || '').replace(/\D/g, '');
  if (!name || !id) return 'اسم داخل بازی و آیدی عددی پابجی رو هر کدوم توی یه خط بفرست.';
  if (!/^\d{5,15}$/.test(id)) return 'آیدی پابجی باید فقط عدد باشه (همون آیدی عددی که توی پروفایل بازیه).';
  if (tag && !name.toLowerCase().includes(String(tag).toLowerCase())) return `اسم داخل بازی باید تگ تیم «${esc(tag)}» رو داشته باشه؛ مثلا <code>${esc(tag)}·${esc(name)}</code>`;
  if (await one(sql`SELECT id FROM team_players WHERE tournament_id = ${t.id} AND pubg_id = ${id}`)) return 'این آیدی پابجی قبلاً توی این تورنمنت ثبت شده.';
  return { name, id };
}

// ---------- teammates ----------
async function inviteTeam(c) {
  return one(sql`SELECT * FROM teams WHERE invite = ${c} AND status = 'pending'`);
}

/** /start tj_<code> */
export async function joinIntro(uid, st, c) {
  const team = await inviteTeam(c);
  if (!team || (team.invite_until && team.invite_until < now())) return send(uid, '⛔️ این لینک دعوت باطل شده یا مهلتش تموم شده.\nاز لیدرت بخواه دوباره تیم رو ثبت کنه.', false);
  const t = await getT(team.tournament_id);
  const p = await one(sql`SELECT team_id FROM team_players WHERE tournament_id = ${t.id} AND user_id = ${uid}`);
  if (p) return p.team_id === team.team_id ? dashboard(uid) : send(uid, '⚠️ تو قبلاً توی یه تیم دیگه‌ی این تورنمنت ثبت شدی.', [DASH]);
  const list = await playersOf(team.team_id);
  if (list.length >= SQUAD) return send(uid, '⛔️ این تیم کامل شده.', false);
  st.w = `tp:join:${team.team_id}`;
  return send(uid, `🏆 <b>${esc(t.name)}</b>\n\n👥 دعوت به تیم <b>${esc(team.team_name)}</b> (🏷 ${esc(team.clan_tag)})\n👑 لیدر: ${esc(list[0]?.pubg_name || '')}\n👤 بازیکن‌ها: ${list.length} از ${SQUAD}\n\n${RULES}\n\n` +
    `👇 اگه قبول داری، <b>اسم داخل بازی</b> و <b>آیدی عددی پابجی</b> خودت رو بفرست، هر کدوم توی یه خط:\n\n<code>${esc(team.clan_tag)}·Reza\n5198765432</code>`, CANCEL);
}

async function joinAnswer(uid, st, teamId, text) {
  const team = await one(sql`SELECT * FROM teams WHERE team_id = ${teamId}`);
  if (!team || team.status !== 'pending' || (team.invite_until && team.invite_until < now())) {
    st.w = null;
    return send(uid, '⛔️ وقت این لینک دعوت تموم شده یا تیم کامل شده.', false).then(() => true);
  }
  const t = await getT(team.tournament_id);
  const pl = await parsePlayer(t, text, team.clan_tag);
  if (typeof pl === 'string') return send(uid, '⚠️ ' + pl, CANCEL).then(() => true);
  const list = await playersOf(team.team_id);
  if (list.some((x) => x.pubg_name.toLowerCase() === pl.name.toLowerCase())) return send(uid, '⚠️ این اسم رو یکی دیگه از تیم ثبت کرده.', CANCEL).then(() => true);
  if (list.length >= SQUAD) {
    st.w = null;
    return send(uid, '⛔️ این تیم کامل شده.', false).then(() => true);
  }
  const row = (await db.run(sql`INSERT INTO team_players (tournament_id, team_id, user_id, pubg_name, pubg_id, role, created)
    VALUES (${t.id}, ${team.team_id}, ${uid}, ${pl.name}, ${pl.id}, 'member', ${now()}) ON CONFLICT DO NOTHING RETURNING id`)).rows[0];
  st.w = null;
  if (!row) return send(uid, '⚠️ این آیدی پابجی یا حساب تلگرام قبلاً توی یه تیم ثبت شده.', false).then(() => true);
  // two players taking the last place at once: the later one is out
  const n = (await db.get(sql`SELECT COUNT(*) AS n FROM team_players WHERE team_id = ${team.team_id} AND id <= ${row.id}`)).n;
  if (n > SQUAD) {
    await db.run(sql`DELETE FROM team_players WHERE id = ${row.id}`);
    return send(uid, '⛔️ این تیم کامل شده.', false).then(() => true);
  }
  const players = await syncMembers(team.team_id);
  if (players.length >= SQUAD) {
    const done = (await db.run(sql`UPDATE teams SET status = 'ok', invite = NULL WHERE team_id = ${team.team_id} AND status = 'pending' RETURNING team_id`)).rows[0];
    if (done) {
      await notifyMany(players.map((x) => [x.user_id, `🎉 <b>تیم ${esc(team.team_name)} کامل شد و ثبت‌نامتون قطعی شد!</b>\n\n🎮 ${players.map((y) => esc(y.pubg_name)).join(' · ')}\n\nگروه، اسلات و زمان مچ‌ها همین‌جا برات میاد.`]));
      await staffNote(`✅ <b>تیم کامل شد</b> (${await teamCount(t.id)}/${fmt(t).max})\n👥 ${esc(team.team_name)} · 🏷 ${esc(team.clan_tag)}\n🎮 ${players.map((y) => esc(y.pubg_name)).join(' · ')}`);
    }
  } else {
    await send(team.leader_chat_id, `👤 <b>${esc(pl.name)}</b> به تیمت اضافه شد (${players.length} از ${SQUAD}).`, [DASH]);
    await send(uid, `✅ <b>ثبت شدی!</b> تیم ${esc(team.team_name)}: ${players.length} از ${SQUAD} نفر.\nوقتی تیم کامل بشه خبرت می‌کنم.`, [DASH]);
  }
  return true;
}

/** Registrations not completed in time are removed, with a reminder 6 hours before (called on every tick);
 *  the channel hears the places that came free (not right before the draw: `announce` false). */
export async function expireInvites(announce = true) {
  const soon = await db.all(sql`SELECT * FROM teams WHERE status = 'pending' AND reminded = 0 AND invite_until IS NOT NULL AND invite_until < ${now() + 6 * 3600} AND invite_until > ${now()} LIMIT 10`);
  for (const team of soon) {
    if (!(await db.run(sql`UPDATE teams SET reminded = 1 WHERE team_id = ${team.team_id} AND reminded = 0 RETURNING team_id`)).rows[0]) continue;
    const list = await playersOf(team.team_id);
    const text = `🚨 <b>یادآوری: تیم ${esc(team.team_name)} هنوز ${list.length} از ${SQUAD} نفره!</b>\n\n` +
      `اگه تا <b>${await clock(team.invite_until)}</b>، ${SQUAD - list.length} نفر دیگه با لینک دعوت لیدر ثبت‌نام نکنن، تیم از تورنمنت حذف میشه.`;
    await notifyMany(list.map((x) => [x.user_id, text, [DASH]]));
  }
  const late = await db.all(sql`SELECT * FROM teams WHERE status = 'pending' AND invite_until IS NOT NULL AND invite_until < ${now()} LIMIT 10`);
  const gone_ = {}; // tournament -> the removed teams' names
  for (const team of late) {
    const gone = (await db.run(sql`DELETE FROM teams WHERE team_id = ${team.team_id} AND status = 'pending' RETURNING team_id`)).rows[0];
    if (!gone) continue;
    const list = await playersOf(team.team_id);
    await db.run(sql`DELETE FROM team_players WHERE team_id = ${team.team_id}`);
    await notifyMany(list.map((x) => [x.user_id, `⌛️ <b>وقت ثبت‌نام تیم ${esc(team.team_name)} تموم شد</b> و تیم ${SQUAD} نفر نشد، برای همین ثبت‌نام لغو شد.\n\nاگه هنوز ثبت‌نام بازه، لیدر می‌تونه دوباره تیم رو ثبت کنه.`]));
    (gone_[team.tournament_id] ||= []).push(team.team_name);
  }
  if (announce) for (const [tid, names] of Object.entries(gone_)) await freePlaces(Number(tid), names).catch((e) => console.error('free places', e));
}

/** The channel the tournament posts go to: the one picked in the Mini App, or the only one; null = none. */
export async function tnChannel() {
  const v = await store.getSetting('tn_chan');
  if (v === '0') return null;
  const chans = (await store.user({ id: Number(store.OWNER_ID) })).channels;
  return chans.find((c) => String(c.id) === v)?.id || (chans.length === 1 ? chans[0].id : null);
}

/** Teams removed at the deadline: "N places are free, register now (an hour to complete)" in the channel. */
async function freePlaces(tid, names) {
  const t = await getT(tid);
  if (!t || t.status !== 'REG' || !t.reg_open) return;
  const free = fmt(t).max - (await teamCount(t.id));
  if (free <= 0) return;
  const link = `https://t.me/${await bot()}?start=tr_${t.id}`;
  const text = `⚠️ <b>جای خالی توی تورنمنت!</b>\n\n🏆 <b>${esc(t.name)}</b>\n` +
    `❌ ${names.map((n) => `«${esc(n)}»`).join('، ')} تا مهلت ${SQUAD} نفر نشد${names.length > 1 ? 'ن' : ''} و حذف ${names.length > 1 ? 'شدن' : 'شد'}.\n` +
    `🎟 <b>${free}</b> جای خالی برای ثبت‌نام داریم!\n\n⏱ تیمی که الان ثبت‌نام کنه فقط <b>۱ ساعت</b> وقت داره هر ${SQUAD} نفر رو کامل کنه.\n👇 سریع ثبت‌نام کن`;
  const ch = await tnChannel();
  const r = ch ? await call('sendMessage', { chat_id: ch, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [[{ text: '📝 ثبت‌نام تیم', url: link }]] } }) : { ok: false, description: 'کانالی انتخاب نشده' };
  await staffNote(`⌛️ ${names.length} تیم ناقص حذف شد: ${names.map(esc).join('، ')}\n🎟 ${free} جای خالی · ` +
    (r.ok ? '📢 توی کانال اعلام شد.' : `⚠️ پست کانال نرفت (${esc(r.description || '')}).`));
}

/** Removes the pending teams right before the draw. -> how many */
export async function dropPending(tid) {
  const list = await db.all(sql`SELECT team_id FROM teams WHERE tournament_id = ${tid} AND status = 'pending'`);
  for (const x of list) await db.run(sql`UPDATE teams SET invite_until = 0 WHERE team_id = ${x.team_id}`);
  await expireInvites(false);
  return list.length;
}

async function staffNote(text) {
  for (const id of await store.staffIds()) await send(id, text, [[btn('🏆 تورنمنت', 'tn')]]);
}

// ---------- the dashboard ----------
export async function dashboard(uid) {
  const p = await mine(uid);
  if (!p) return userMenu(uid);
  const t = await getT(p.tournament_id);
  const team = await one(sql`SELECT * FROM teams WHERE team_id = ${p.team_id}`);
  const players = await playersOf(team.team_id);
  const S = stg(t);
  const L = [`🏆 <b>${esc(t.name)}</b>`, LINE, `👥 تیم: <b>${esc(team.team_name)}</b> · 🏷 ${esc(team.clan_tag || '')}`,
    `👑 لیدر: <b>${esc(players[0]?.pubg_name || '')}</b>`, `🎮 بازیکن‌ها: ${players.map((x) => esc(x.pubg_name)).join(' · ')}`];
  const myKills = (await db.get(sql`SELECT COALESCE(SUM(k.kills), 0) AS n FROM player_scores k JOIN matches m ON m.match_id = k.match_id
    WHERE k.team_id = ${team.team_id} AND m.is_confirmed = 1 AND lower(k.player_name) = lower(${p.pubg_name})`)).n;
  const kb = [];
  if (team.status === 'pending') {
    L.push('', `⏳ <b>در انتظار تکمیل تیم: ${players.length} از ${SQUAD} نفر</b>`,
      `🚨 مهلت: <b>${team.invite_until ? await clock(team.invite_until) : 'چند روز قبل از اولین مچ'}</b>؛ تیم ناقص از تورنمنت حذف میشه.`);
    if (p.role === 'leader') kb.push([btn('🔗 لینک دعوت هم‌تیمی‌ها', 'tp:inv')]);
  } else if (t.status === 'REG') {
    L.push('', '✅ <b>ثبت‌نام کامل شد.</b> منتظر قرعه‌کشی گروه‌ها باش.');
  } else {
    const st = team.current_stage;
    L.push('', `📍 وضعیت: <b>${st === 'ELIMINATED' ? '❌ حذف شده' : st === 'CHAMPION' ? '🏆 قهرمان!' : '🎮 ' + esc(S[st]?.label || '')}</b>` +
      (team.group_name && S[st] ? ` · ${groupLabel(st, team.group_name)} · اسلات <b>${team.slot_number}</b>` : ''));
    // the next matches of the team's lobby
    if (S[st] && team.group_name) {
      const ms = await groupMatches(t.id, st, team.group_name);
      const open = ms.filter((m) => !m.is_confirmed);
      const left = S[st].matches - ms.length;
      L.push('', '🗓 <b>مچ‌های پیش رو</b>');
      for (const m of open) {
        const ready = await one(sql`SELECT id FROM match_ready WHERE match_id = ${m.match_id} AND team_id = ${team.team_id}`);
        L.push(`▫️ مچ ${m.match_number}${m.map_name ? ' · 🗺 ' + esc(m.map_name) : ''} · ${m.starts_at ? '⏰ <b>' + (await clock(m.starts_at)) + '</b>' : 'زمانش بعداً اعلام میشه'}${ready ? ' · ✅ آماده‌اید' : ''}`);
        if (m.starts_at && !ready && p.role === 'leader') kb.push([btn(`✅ آماده‌ایم (مچ ${m.match_number})`, `tp:r:${m.match_id}`)]);
      }
      for (let k = ms.length + 1; k <= ms.length + left; k++) {
        const at = await one(sql`SELECT starts_at FROM plan WHERE tournament_id = ${t.id} AND stage = ${st} AND group_name = ${team.group_name} AND match_number = ${k}`);
        L.push(`▫️ مچ ${k} · ${at ? '⏰ <b>' + (await clock(at.starts_at)) + '</b>' : 'زمانش بعداً اعلام میشه'}`);
      }
      if (!open.length && !left) L.push('▫️ مچ‌های این مرحله تموم شده.');
      const tbl = await standings(t.id, st, team.group_name);
      const i = tbl.findIndex((r) => r.team_id === team.team_id);
      if (myKills) L.push('', `💀 کیل‌های خودت: <b>${myKills}</b>`);
      if (i >= 0 && tbl[i].played) L.push('', `📈 جایگاه فعلی: <b>${i + 1}</b> از ${tbl.length} · ⭐ ${tbl[i].pts} امتیاز · 💀 ${tbl[i].kills} کیل` + (S[st].adv ? (i < S[st].adv ? ' · 🟢 توی خط صعود' : ' · 🔴 زیر خط صعود') : ''));
    }
  }
  // results so far
  const res = await db.all(sql`SELECT m.stage, m.group_name, m.match_number, m.map_name, s.placement_rank, s.kills, s.total_match_points
    FROM match_scores s JOIN matches m ON m.match_id = s.match_id WHERE s.team_id = ${team.team_id} AND m.is_confirmed = 1 ORDER BY m.confirmed_at, m.match_id`);
  if (res.length) {
    L.push('', '📊 <b>نتیجه‌های تیم</b>');
    for (const r of res) L.push(`▫️ ${esc(S[r.stage]?.label || '')} · مچ ${r.match_number}: رتبه <b>${r.placement_rank}</b> · 💀 ${r.kills} · ⭐ ${r.total_match_points}${r.placement_rank === 1 ? ' 🍗' : ''}`);
  }
  // the team's path
  if (t.status !== 'REG' && team.status === 'ok') {
    const path = [];
    for (const [key, c] of Object.entries(S)) {
      const gm = await one(sql`SELECT final_rank, qualified FROM group_members WHERE tournament_id = ${t.id} AND stage = ${key} AND team_id = ${team.team_id}`);
      if (!gm) path.push(`⏳ ${c.label}`);
      else if (gm.final_rank) path.push(`${gm.qualified === 0 ? '❌' : '✅'} ${c.label} (رتبه ${gm.final_rank})`);
      else path.push(`🎮 ${c.label}`);
    }
    path.push(team.current_stage === 'CHAMPION' ? '🏆 قهرمان!' : '🏆');
    L.push('', '🗺 <b>مسیر تیم</b>', path.join(' ← '));
  }
  if (t.status === 'REG' && p.role === 'leader') kb.push([btn('❌ لغو ثبت‌نام تیم', 'tp:x')]);
  kb.push([btn('🔄 تازه‌سازی', 'tp:d'), appBtn(t.id)]);
  return send(uid, L.join('\n'), kb);
}

/** "✅ آماده‌ایم": only the team's leader; one tap counts for every match announced with it. */
async function ready(c, uid, ids) {
  const alert = (text) => call('answerCallbackQuery', { callback_query_id: c.id, text, show_alert: true });
  let done = 0;
  for (const id of ids.slice(0, 6)) {
    const m = await one(sql`SELECT * FROM matches WHERE match_id = ${id}`);
    if (!m || m.is_confirmed) continue;
    const team = await one(sql`SELECT t.team_id FROM group_members gm JOIN teams t ON t.team_id = gm.team_id
      WHERE gm.tournament_id = ${m.tournament_id} AND gm.stage = ${m.stage} AND gm.group_name = ${m.group_name} AND t.leader_chat_id = ${uid}`);
    if (!team) continue;
    await db.run(sql`INSERT INTO match_ready (match_id, team_id, ts) VALUES (${m.match_id}, ${team.team_id}, ${now()}) ON CONFLICT(match_id, team_id) DO NOTHING`);
    done += 1;
  }
  if (!done) return alert('⛔️ فقط لیدر تیم می‌تونه آمادگی اعلام کنه، یا این مچ دیگه منتظر آمادگی نیست.');
  await alert('✅ ثبت شد؛ تیمتون آماده‌ست. موفق باشید! 🍀');
  return (await mine(uid)) ? dashboard(uid) : null;
}

// ---------- buttons (anyone): tp:… ----------
export async function callback(c) {
  const uid = c.from.id;
  const data = c.data;
  const st = await store.getSession(uid);
  try {
    if (data.startsWith('tp:reg:')) return await regIntro(uid, Number(data.slice(7)));
    if (data.startsWith('tp:lead:')) {
      const [t, refused] = await openReg(uid, data.slice(8));
      if (!t) return await refused;
      st.w = `tp:name:${t.id}`;
      st.tp = {};
      return await send(uid, '👥 <b>اسم تیم</b> رو بفرست:\n\nمثلا: <code>Kanki Team</code>', CANCEL);
    }
    if (data === 'tp:stop') {
      st.w = null;
      st.tp = null;
      return await send(uid, '❎ لغو شد.', false);
    }
    if (data.startsWith('tp:r:')) return await ready(c, uid, data.slice(5).split('-').map(Number).filter(Boolean));
    const p = await mine(uid);
    if (!p) return await userMenu(uid);
    if (data === 'tp:inv' && p.role === 'leader' && p.team_status === 'pending') {
      const team = await one(sql`SELECT * FROM teams WHERE team_id = ${p.team_id}`);
      return await send(uid, await inviteText(team), [DASH]);
    }
    const t = await getT(p.tournament_id);
    if ((data === 'tp:x' || data === 'tp:xx') && p.role === 'leader' && t.status === 'REG') {
      if (data === 'tp:x') return await send(uid, `❓ ثبت‌نام تیم «${esc(p.team_name)}» کلاً لغو بشه؟ (همه‌ی بازیکن‌ها از تیم بیرون میرن)`, [[btn('✅ آره، لغو کن', 'tp:xx'), btn('❌ نه', 'tp:d')]]);
      const list = await playersOf(p.team_id);
      await db.run(sql`DELETE FROM team_players WHERE team_id = ${p.team_id}`);
      await db.run(sql`DELETE FROM teams WHERE team_id = ${p.team_id}`);
      await notifyMany(list.filter((x) => x.user_id !== uid).map((x) => [x.user_id, `ℹ️ لیدر ثبت‌نام تیم «${esc(p.team_name)}» رو لغو کرد.`]));
      await staffNote(`🗑 تیم «${esc(p.team_name)}» ثبت‌نامش رو لغو کرد.`);
      return await send(uid, '🗑 ثبت‌نام تیم لغو شد.', false);
    }
    return await dashboard(uid);
  } finally {
    await store.saveSession(uid, st);
  }
}
