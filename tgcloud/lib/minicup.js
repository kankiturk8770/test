// ⚡️ Mini-cup: a small, quick warm-up tournament — separate from the big tournament (lib/tournament.js has its
// own tables; this keeps its cup in settings and its teams in mc_teams). It only borrows the big tournament's
// screenshot reader (Gemini) and its scoring: PMGC placement points + 1 point a kill.
//
// Flow: create (name → groups → teams per group to the final → matches per lobby → prize) → publish in the
// channel with a «✅ register» button → leaders register a team name (in-game names optional) → close: the
// teams are dealt into groups of up to 20 → per group: ID/Pass to its leaders, each match's result from the
// scoreboard screenshot (or typed), the table → the best of each group go to the final, the rest are out →
// the final's matches the same way → the champion (first in the final's table) is posted and told the prize.
// Nothing is ever deleted; every channel post happens only when the admin presses its button.
//
// Cup: settings mc:<id> = { …, res: { g0: [match rows…], g1: […], f: […] } } (admin writes only).
// Callbacks: mc:<act>:<id>[:…] (admin), mc:j:<id> (the channel's register button, anyone).
// Waiting: st.w = mc:new:<field> / mc:room:<id>:<lobby> / mc:shot:<id>:<lobby>:<no> (admin), mc:team:<id> (leader).
import { db, api } from 'sdk';
import { sql } from 'sdk/db';
import { esc, call, send, now, digits, LINE } from './util.js';
import * as store from './store.js';
import { geminiVision, visionKeys } from './ai.js';
import { SYSTEM, SCHEMA, cleanRows, placementPoints } from './tournament.js';

const B = (text, data, style) => ({ text, callback_data: data, ...(style ? { style } : {}) });
const G = (t, d) => B(t, d, 'success');
const R = (t, d) => B(t, d, 'danger');
const U = (t, d) => B(t, d, 'primary');
const BACK = [B('🔙 برگشت به منو', 'menu')];
const fa = (n) => Number(n || 0).toLocaleString('fa-IR');
const PER_GROUP = 20; // teams in one lobby
const LETTERS = 'ABCD';
const lobbyName = (key) => (key === 'f' ? 'فینال' : `گروه ${LETTERS[Number(key.slice(1))]}`);
const MEDAL = ['🥇', '🥈', '🥉'];

// ---------- data ----------
const getCup = async (id) => JSON.parse((await store.getSetting(`mc:${id}`)) || 'null');
const saveCup = (c) => store.setSetting(`mc:${c.id}`, JSON.stringify(c));
async function activeCup() {
  const id = Number(await store.getSetting('mc_active')) || 0;
  return id ? getCup(id) : null;
}
const teams = (cupId) => db.all(sql`SELECT * FROM mc_teams WHERE cup_id = ${cupId} ORDER BY id`);
const teamCount = async (cupId) => (await db.get(sql`SELECT count(*) AS n FROM mc_teams WHERE cup_id = ${cupId}`))?.n || 0;
const capacity = (c) => c.groups * PER_GROUP;
const lobbyKeys = (c) => Array.from({ length: c.groups }, (_, g) => `g${g}`);

/** The teams of a lobby, numbered #1… by registration order (the admin's manual results use these numbers). */
async function lobby(c, key) {
  const all = await teams(c.id);
  return key === 'f' ? all.filter((t) => t.fin) : all.filter((t) => t.grp === Number(key.slice(1)));
}
const played = (c, key) => (c.res?.[key] || []).length;
const lobbyDone = (c, key) => played(c, key) >= c.matches;

/** The table of a lobby: points, then kills, then chicken dinners, then the better rank in the last match. */
async function standings(c, key) {
  const list = await lobby(c, key);
  const row = new Map(list.map((t) => [t.id, { id: t.id, team: t.team, uid: t.uid, pts: 0, kills: 0, wwcd: 0, last: 999 }]));
  const ms = c.res?.[key] || [];
  ms.forEach((m, i) => {
    for (const r of m) {
      const x = row.get(r.team);
      if (!x) continue;
      x.pts += r.pts;
      x.kills += r.kills;
      if (r.rank === 1) x.wwcd++;
      if (i === ms.length - 1) x.last = r.rank;
    }
  });
  return [...row.values()].sort((a, b) => b.pts - a.pts || b.kills - a.kills || b.wwcd - a.wwcd || a.last - b.last || a.id - b.id);
}

function tableText(rows, top = 0) {
  return rows.map((r, i) => `${MEDAL[i] || `${fa(i + 1)}.`} <b>${esc(r.team)}</b> — ${fa(r.pts)} امتیاز · ${fa(r.kills)} کیل` +
    (top && i === top - 1 && rows.length > top ? `\n${'┄'.repeat(12)} ⬆️ صعود` : '')).join('\n');
}

async function botName() {
  let n = await store.getSetting('bot_username');
  if (!n) {
    n = (await call('getMe', {})).result?.username;
    if (n) await store.setSetting('bot_username', n);
  }
  return n;
}

async function edit(uid, mid, text, kb) {
  kb = kb.filter((r) => r && r.length);
  if (mid) {
    const r = await call('editMessageText', { chat_id: uid, message_id: mid, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: kb } });
    if (r.ok || /not modified/i.test(r.description || '')) return r;
  }
  return send(uid, text, kb);
}
const toChannel = (c, text) => call('sendMessage', { chat_id: c.chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
  ...(c.post ? { reply_parameters: { message_id: c.post, allow_sending_without_reply: true } } : {}) });

// ---------- the announcement ----------
function announceText(c, n) {
  return `⚡️ <b>${esc(c.name)}</b>\n${LINE}\n` +
    '🎮 یه تورنمنت کوچیک و سریع برای گرم شدن دست‌ها!\n\n' +
    `👥 <b>${fa(c.groups)}</b> گروه ${fa(PER_GROUP)} تیمی · هر گروه <b>${fa(c.matches)}</b> مچ\n` +
    `🔥 <b>${fa(c.adv)}</b> تیم اول هر گروه (با امتیاز) میرن فینال\n` +
    '📊 امتیاز: رتبه + ۱ امتیاز برای هر کیل\n' +
    (c.prize ? `🏆 جایزه‌ی قهرمان: <b>${esc(c.prize)}</b>\n` : '') +
    `\n📝 تیم‌های ثبت‌نامی: <b>${fa(n)}</b> از ${fa(capacity(c))}\n\n` +
    (c.status === 'reg' ? '👇 <b>لیدر تیم</b> دکمه‌ی ثبت‌نام رو بزنه' : '🔒 ثبت‌نام بسته شد');
}
const regKb = (c, n) => (c.status === 'reg' ? [[{ text: `✅ ثبت‌نام تیم (${fa(n)}/${fa(capacity(c))})`, callback_data: `mc:j:${c.id}`, style: 'success' }]] : []);

async function refreshPost(c) {
  if (!c.post) return;
  const n = await teamCount(c.id);
  await call('editMessageText', { chat_id: c.chat, message_id: c.post, text: announceText(c, n), parse_mode: 'HTML', reply_markup: { inline_keyboard: regKb(c, n) } });
}

// ---------- the admin's panel ----------
export async function home(uid, st, mid = null) {
  st.w = null;
  st.mcr = null;
  const c = await activeCup();
  if (c) return panel(uid, c, mid);
  const past = Number(await store.getSetting('mc_last')) || 0;
  return edit(uid, mid,
    `⚡️ <b>مینی‌کاپ</b>\n${LINE}\n` +
    'یه تورنمنت کوچیک و سریع، جدا از تورنمنت اصلی، برای اینکه اعضای کانال دستشون گرم بشه:\n\n' +
    `1️⃣ تیم‌ها توی گروه‌های ${fa(PER_GROUP)} تیمی\n2️⃣ نتیجه‌ی هر مچ از روی اسکرین‌شات، امتیازها خودکار\n3️⃣ تیم‌های بالای جدول هر گروه میرن فینال\n4️⃣ قهرمان فینال جایزه می‌گیره 🏆\n\n` +
    (past ? `🗂 تا الان ${fa(past)} مینی‌کاپ ساخته شده.` : ''),
    [[G('➕ ساخت مینی‌کاپ جدید', 'mc:new')], BACK]);
}

async function panel(uid, c, mid = null, note = '') {
  const n = await teamCount(c.id);
  let text = `⚡️ <b>${esc(c.name)}</b>\n${LINE}\n` +
    `👥 ${fa(c.groups)} گروه · ${fa(c.matches)} مچ · ${fa(c.adv)} تیم از هر گروه به فینال\n` +
    (c.prize ? `🏆 جایزه: <b>${esc(c.prize)}</b>\n` : '') + `📝 تیم‌ها: <b>${fa(n)}</b> از ${fa(capacity(c))}\n`;
  const rows = [];
  if (c.status === 'draft') {
    text += '\n📝 هنوز توی کانال منتشر نشده.';
    rows.push([G('📢 انتشار توی کانال', `mc:pub:${c.id}`)]);
  } else if (c.status === 'reg') {
    const list = await teams(c.id);
    text += '\n🟢 <b>ثبت‌نام بازه.</b>' + (list.length ? '\n\n' + list.slice(-12).map((t) => `▫️ ${esc(t.team)}`).join('\n') + (list.length > 12 ? '\n…' : '') : '');
    if (n >= 2) rows.push([R(`🔒 بستن ثبت‌نام و چیدن گروه‌ها`, `mc:close:${c.id}`)]);
  } else if (c.status === 'groups' || c.status === 'final') {
    const keys = c.status === 'final' ? ['f'] : lobbyKeys(c);
    text += c.status === 'final' ? '\n🔥 <b>فینال</b>\n' : '\n🏟 <b>مرحله‌ی گروهی</b>\n';
    for (const key of keys) {
      const p = played(c, key);
      text += `\n${lobbyName(key)}: مچ ${fa(p)} از ${fa(c.matches)} ${lobbyDone(c, key) ? '✅' : '⏳'}`;
      rows.push([U(`🔑 رمز ${lobbyName(key)}`, `mc:key:${c.id}:${key}`),
        lobbyDone(c, key) ? B(`📊 جدول ${lobbyName(key)}`, `mc:tbl:${c.id}:${key}`) : G(`📸 نتیجه‌ی مچ ${fa(p + 1)} ${lobbyName(key)}`, `mc:shot:${c.id}:${key}:${p + 1}`)]);
      if (p && !lobbyDone(c, key)) rows.push([B(`📊 جدول ${lobbyName(key)} (تا الان)`, `mc:tbl:${c.id}:${key}`)]);
    }
    if (c.status === 'groups' && keys.every((k) => lobbyDone(c, k))) rows.push([R('🔥 اعلام فینالیست‌ها توی کانال', `mc:final:${c.id}`)]);
    if (c.status === 'final' && lobbyDone(c, 'f')) rows.push([R('👑 اعلام قهرمان', `mc:champ:${c.id}`)]);
  }
  rows.push([B('❌ لغو این مینی‌کاپ', `mc:cancel:${c.id}`)], BACK);
  return edit(uid, mid, text + (note ? `\n\n${note}` : ''), rows);
}

// ---------- creating a cup ----------
async function draftStep(uid, st, mid) {
  const d = st.mc || {};
  const step = (n, q, kb) => edit(uid, mid, `⚡️ <b>${esc(d.name || 'مینی‌کاپ جدید')}</b> — ${fa(n)} از ۵\n${LINE}\n${q}`, [...kb, [B('❌ لغو', 'mc:home')]]);
  if (!d.name) {
    st.w = 'mc:new:name';
    const next = (Number(await store.getSetting('mc_last')) || 0) + 1;
    return step(1, '✍️ اسمش چی باشه؟ بفرست، یا دکمه رو بزن.', [[G(`⚡️ مینی‌کاپ #${fa(next)}`, 'mc:nn')]]);
  }
  st.w = 'mc:new:wait'; // keeps the draft (st.mc) in the session between the button steps
  if (!d.groups) return step(2, `👥 چند تا گروه؟ (هر گروه تا ${fa(PER_GROUP)} تیم)`, [[2, 3, 4].map((n) => U(`${fa(n)} گروه (${fa(n * PER_GROUP)} تیم)`, `mc:ng:${n}`))]);
  if (!d.adv) {
    // the final is one lobby too: at most 20 teams
    const opts = [Math.floor(PER_GROUP / d.groups / 2), Math.floor(PER_GROUP / d.groups)].filter((x, i, a) => x >= 1 && a.indexOf(x) === i);
    return step(3, `🔥 از هر گروه چند تیمِ بالای جدول بره فینال؟`, [opts.map((n) => U(`${fa(n)} تیم (فینال ${fa(n * d.groups)} تیمی)`, `mc:na:${n}`))]);
  }
  if (!d.matches) return step(4, '🎮 هر گروه (و فینال) چند تا مچ؟', [[1, 2, 3].map((n) => U(`${fa(n)} مچ`, `mc:nm:${n}`))]);
  if (d.prize === undefined) {
    st.w = 'mc:new:prize';
    return step(5, '🏆 جایزه‌ی قهرمان چیه؟ بنویس و بفرست (مثلاً «۶۰ یوسی»)، یا:', [[B('بدون جایزه', 'mc:np')]]);
  }
  const chs = (await store.user(uid)).channels;
  if (!d.chat) {
    if (chs.length === 1) d.chat = chs[0].id;
    else return edit(uid, mid, `📢 توی کدوم کانال؟`, [...chs.map((ch) => [U(ch.title, `mc:nc:${ch.id}`)]), [B('❌ لغو', 'mc:home')]]);
  }
  const id = (Number(await store.getSetting('mc_last')) || 0) + 1;
  await store.setSetting('mc_last', String(id));
  const cup = { id, name: d.name, groups: d.groups, adv: d.adv, matches: d.matches, prize: d.prize || '',
    chat: d.chat, status: 'draft', post: null, res: {}, created: now() };
  await saveCup(cup);
  await store.setSetting('mc_active', String(id));
  st.mc = null;
  st.w = null;
  return panel(uid, cup, mid, '✅ ساخته شد. «انتشار توی کانال» رو بزن تا ثبت‌نام شروع بشه.');
}

// ---------- the admin's buttons (mc:…) ----------
export async function action(uid, st, data, mid) {
  const [, act, a, b, c3] = data.split(':');
  if (!act || act === 'home') { st.mc = null; return home(uid, st, mid); }
  if (act === 'new') {
    if (await activeCup()) return home(uid, st, mid);
    st.mc = {};
    return draftStep(uid, st, mid);
  }
  if (['nn', 'ng', 'na', 'nm', 'np', 'nc'].includes(act)) {
    st.mc = st.mc || {};
    if (act === 'nn') st.mc.name = `مینی‌کاپ #${fa((Number(await store.getSetting('mc_last')) || 0) + 1)}`;
    if (act === 'ng') st.mc.groups = Math.min(4, Math.max(2, Number(a)));
    if (act === 'na') st.mc.adv = Math.max(1, Math.min(PER_GROUP, Number(a)));
    if (act === 'nm') st.mc.matches = Math.min(3, Math.max(1, Number(a)));
    if (act === 'np') st.mc.prize = '';
    if (act === 'nc') st.mc.chat = Number(a);
    return draftStep(uid, st, mid);
  }

  const c = await getCup(Number(a));
  if (!c) return home(uid, st, mid);
  st.w = null;

  switch (act) {
    case 'pub': {
      if (c.status !== 'draft') return panel(uid, c, mid);
      c.status = 'reg';
      const r = await call('sendMessage', { chat_id: c.chat, text: announceText(c, 0), parse_mode: 'HTML', reply_markup: { inline_keyboard: regKb(c, 0) } });
      if (!r.ok) { c.status = 'draft'; return panel(uid, c, mid, `⚠️ نتونستم توی کانال بفرستم: ${esc(r.description || '')}`); }
      c.post = r.result.message_id;
      await saveCup(c);
      return panel(uid, c, mid, '📢 توی کانال منتشر شد؛ ثبت‌نام شروع شد.');
    }
    case 'close':
      return edit(uid, mid, `🔒 ثبت‌نام بسته بشه و تیم‌ها شانسی توی ${fa(c.groups)} گروه چیده بشن؟\n\nلیست گروه‌ها توی کانال منتشر میشه.`,
        [[R('🔒 آره، ببند و بچین', `mc:closey:${c.id}`)], [G('❌ نه', 'mc:home')]]);
    case 'closey': {
      if (c.status !== 'reg') return panel(uid, c, mid);
      const list = await teams(c.id);
      for (let i = list.length - 1; i > 0; i--) {
        const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
        [list[i], list[j]] = [list[j], list[i]];
      }
      for (let i = 0; i < list.length; i++) await db.run(sql`UPDATE mc_teams SET grp = ${i % c.groups} WHERE id = ${list[i].id}`);
      c.status = 'groups';
      await saveCup(c);
      await refreshPost(c);
      {
        const parts = [];
        for (const key of lobbyKeys(c)) parts.push(`🏟 <b>${lobbyName(key)}</b>\n${(await lobby(c, key)).map((t) => `▫️ ${esc(t.team)}`).join('\n')}`);
        await toChannel(c, `⚡️ <b>${esc(c.name)}</b> — گروه‌ها چیده شد!\n${LINE}\n${parts.join('\n\n')}\n\n🔑 رمز روم هر گروه <b>فقط برای لیدرهای همون گروه</b> توی ربات میاد.\n🔥 ${fa(c.adv)} تیم اول هر گروه میرن فینال!`);
      }
      return panel(uid, c, mid, '✅ گروه‌ها چیده و توی کانال منتشر شد.');
    }
    case 'key': {
      st.w = `mc:room:${c.id}:${b}`;
      return edit(uid, mid, `🔑 <b>رمز ${lobbyName(b)}</b>\n${LINE}\nآیدی و پسورد رو بفرست؛ فقط برای لیدرهای ${lobbyName(b)} توی ربات فرستاده میشه.\n\nمثال:\n<code>ID: 1234567\nPass: 999</code>`,
        [[B('❌ لغو', 'mc:home')]]);
    }
    case 'shot': {
      const no = Number(c3);
      st.w = `mc:shot:${c.id}:${b}:${no}`;
      st.mcr = { id: c.id, key: b, no, rows: [] };
      const list = await lobby(c, b);
      const ai = (await visionKeys()).length > 0;
      return edit(uid, mid, `📸 <b>نتیجه‌ی مچ ${fa(no)} — ${lobbyName(b)}</b>\n${LINE}\n` +
        (ai ? '📸 اسکرین‌شات(های) جدول آخر بازی رو بفرست؛ خودم رتبه و کیل هر تیم رو می‌خونم و امتیاز می‌دم.\n\n' : '🔑 کلید Gemini ثبت نشده؛ نتیجه رو دستی بفرست.\n\n') +
        '✍️ دستی: هر خط «<b>رتبه شماره‌ی‌تیم کیل</b>»، مثلاً <code>1 5 12</code> یعنی تیم #۵ اول شد با ۱۲ کیل.\n\n' +
        `<b>تیم‌های ${lobbyName(b)}:</b>\n${list.map((t, i) => `#${fa(i + 1)} ${esc(t.team)}`).join('\n')}`,
      [[B('❌ لغو', 'mc:home')]]);
    }
    case 'ok': // confirm the read result
      return confirmResult(uid, st, c, mid);
    case 'tbl': { // the table: to the admin, with a button to post it
      const rows = await standings(c, b);
      return edit(uid, mid, `📊 <b>جدول ${lobbyName(b)}</b> — ${fa(played(c, b))} مچ\n${LINE}\n${tableText(rows, b === 'f' ? 0 : c.adv)}`,
        [[U('📢 انتشار این جدول توی کانال', `mc:tblp:${c.id}:${b}`)], [B('🔙 پنل مینی‌کاپ', 'mc:home')]]);
    }
    case 'tblp': {
      const rows = await standings(c, b);
      await toChannel(c, `📊 <b>جدول ${lobbyName(b)} — ${esc(c.name)}</b>\n${LINE}\n${tableText(rows, b === 'f' ? 0 : c.adv)}\n\n📊 امتیاز: رتبه + ۱ امتیاز برای هر کیل`);
      return panel(uid, c, mid, '📢 جدول توی کانال منتشر شد.');
    }
    case 'final': {
      if (c.status !== 'groups') return panel(uid, c, mid);
      const lines = [];
      const up = [];
      for (const key of lobbyKeys(c)) {
        const rows = await standings(c, key);
        const go = rows.slice(0, c.adv);
        up.push(...go);
        lines.push(`🏟 <b>${lobbyName(key)}</b>\n${go.map((r) => `✅ ${esc(r.team)} (${fa(r.pts)})`).join('\n')}`);
      }
      for (const r of up) await db.run(sql`UPDATE mc_teams SET fin = 1 WHERE id = ${r.id}`);
      c.status = 'final';
      await saveCup(c);
      await toChannel(c, `🔥 <b>فینالیست‌های ${esc(c.name)}</b>\n${LINE}\n${lines.join('\n\n')}\n\n` +
        (c.prize ? `🏆 جایزه‌ی قهرمان: <b>${esc(c.prize)}</b>\n` : '') + '🍀 موفق باشید! بقیه‌ی تیم‌ها مرسی که بودید 🙏');
      for (const r of up) await send(r.uid, `🔥 <b>تیمت «${esc(r.team)}» رفت فینال!</b>\n⚡️ ${esc(c.name)}\n\nرمز روم فینال همین‌جا برات میاد 🔑`, false);
      return panel(uid, c, mid, `🔥 ${fa(up.length)} فینالیست اعلام شدن.`);
    }
    case 'champ': {
      const rows = await standings(c, 'f');
      return edit(uid, mid, `👑 <b>نتیجه‌ی فینال</b>\n${LINE}\n${tableText(rows.slice(0, 10))}\n\nاعلام قهرمان توی کانال؟`,
        [[G(`👑 آره، «${rows[0]?.team || ''}» قهرمانه`, `mc:cz:${c.id}`)], [B('❌ نه', 'mc:home')]]);
    }
    case 'cz': {
      if (c.status !== 'final') return panel(uid, c, mid);
      const rows = await standings(c, 'f');
      const w = rows[0];
      c.status = 'done';
      c.champion = { team: w.team, uid: w.uid };
      await saveCup(c);
      await store.setSetting('mc_active', null);
      await toChannel(c, `👑 <b>قهرمان ${esc(c.name)}: ${esc(w.team)}</b>\n${LINE}\n${tableText(rows.slice(0, 10))}\n\n` +
        (c.prize ? `🏆 جایزه: <b>${esc(c.prize)}</b>\n\n` : '') + '🔥 مرسی از همه‌ی تیم‌ها، تا مینی‌کاپ بعدی!');
      await send(w.uid, `👑🎉 <b>تبریک! تیم «${esc(w.team)}» قهرمان ${esc(c.name)} شد!</b>` + (c.prize ? `\n\n🏆 جایزه‌ت: <b>${esc(c.prize)}</b>\nادمین کانال به‌زودی جایزه‌ت رو میده.` : ''), false);
      return edit(uid, mid, `👑 <b>${esc(w.team)}</b> قهرمان شد و توی کانال اعلام شد.` +
        (c.prize ? `\n\n🎁 جایزه («${esc(c.prize)}») رو به لیدرش بده: <a href="tg://user?id=${w.uid}">پیام به لیدر</a>` : ''),
      [[G('➕ مینی‌کاپ بعدی', 'mc:new')], BACK]);
    }
    case 'cancel':
      return edit(uid, mid, `❌ «${esc(c.name)}» لغو بشه؟\n\n(پستی پاک نمیشه؛ فقط این مینی‌کاپ تموم میشه.)`,
        [[R('❌ آره، لغو کن', `mc:cancely:${c.id}`)], [G('نه', 'mc:home')]]);
    case 'cancely':
      c.status = 'cancelled';
      await saveCup(c);
      await store.setSetting('mc_active', null);
      await refreshPost(c);
      return home(uid, st, mid);
    default:
      return panel(uid, c, mid);
  }
}

// ---------- a match's result ----------
/** Merge new rows into the pending result: a rank already matched to a team keeps it; typed rows win. */
function mergeRows(pending, rows, typed) {
  const by = new Map(pending.map((r) => [r.rank, r]));
  for (const r of rows) {
    const old = by.get(r.rank);
    if (typed || !old || (old.team == null && r.team != null)) by.set(r.rank, r);
  }
  return [...by.values()].sort((x, y) => x.rank - y.rank);
}

async function preview(uid, st, c, note = '') {
  const p = st.mcr;
  const list = await lobby(c, p.key);
  const name = new Map(list.map((t, i) => [t.id, `#${fa(i + 1)} ${t.team}`]));
  const seen = new Map();
  const problems = [];
  const lines = p.rows.map((r) => {
    if (r.team == null) { problems.push(r.rank); return `${fa(r.rank)}. ❓ ${esc((r.names || []).join('، ') || 'ناشناس')} — ${fa(r.kills)} کیل`; }
    if (seen.has(r.team)) problems.push(r.rank);
    seen.set(r.team, r.rank);
    return `${fa(r.rank)}. ${esc(name.get(r.team) || '?')} — ${fa(r.kills)} کیل → <b>${fa(placementPoints(r.rank) + r.kills)}</b>`;
  });
  const missing = list.filter((t) => !seen.has(t.id));
  const ok = p.rows.length && !problems.length;
  return send(uid, `📋 <b>نتیجه‌ی مچ ${fa(p.no)} — ${lobbyName(p.key)}</b>\n${LINE}\n${lines.join('\n') || '—'}\n` +
    (problems.length ? `\n⚠️ رتبه‌ی ${problems.map(fa).join('، ')}: تیمش مشخص نیست یا تکراریه.\nدرستش کن: بفرست «رتبه شماره‌ی‌تیم کیل»، مثلاً <code>${problems[0]} 5 3</code>\n` : '') +
    (missing.length && ok ? `\nℹ️ ${fa(missing.length)} تیم توی نتیجه نیستن و ۰ امتیاز می‌گیرن: ${missing.map((t) => esc(t.team)).join('، ')}\n` : '') +
    '\n📸 اسکرین‌شات دیگه‌ای مونده؟ بفرست.' + (note ? `\n\n${note}` : ''),
  [ok ? [G('✅ تایید و ثبت امتیازها', `mc:ok:${c.id}`)] : [], [B('❌ لغو', 'mc:home')]].filter((r) => r.length));
}

async function confirmResult(uid, st, c, mid) {
  const p = st.mcr;
  if (!p || p.id !== c.id) return panel(uid, c, mid, '⌛️ این نتیجه دیگه باز نیست.');
  if (played(c, p.key) !== p.no - 1) return panel(uid, c, mid, 'ℹ️ این مچ قبلاً ثبت شده.');
  c.res = c.res || {};
  c.res[p.key] = c.res[p.key] || [];
  c.res[p.key].push(p.rows.filter((r) => r.team != null).map((r) => ({ rank: r.rank, team: r.team, kills: r.kills, pts: placementPoints(r.rank) + r.kills })));
  await saveCup(c);
  st.mcr = null;
  st.w = null;
  const rows = await standings(c, p.key);
  return send(uid, `✅ <b>مچ ${fa(p.no)} ${lobbyName(p.key)} ثبت شد.</b>\n\n📊 جدول تا الان:\n${tableText(rows.slice(0, 10), p.key === 'f' ? 0 : c.adv)}`,
    [[U('📢 انتشار جدول توی کانال', `mc:tblp:${c.id}:${p.key}`)], [B('🔙 پنل مینی‌کاپ', 'mc:home')]]);
}

/** «1 5 12» lines: rank, the team's # in the lobby list, kills. -> rows | null */
function parseManual(text, list) {
  const out = [];
  for (const line of digits(text).split('\n').map((x) => x.trim()).filter(Boolean)) {
    const m = line.match(/^#?(\d{1,2})[\s,.\-]+#?(\d{1,2})[\s,.\-]+(\d{1,2})$/);
    if (!m) return null;
    const [rank, no, kills] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (rank < 1 || rank > 25 || no < 1 || no > list.length) return null;
    out.push({ rank, team: list[no - 1].id, kills, names: [] });
  }
  return out.length ? out : null;
}

async function readShot(uid, st, c, m) {
  const p = st.mcr;
  const list = await lobby(c, p.key);
  if (!(await visionKeys()).length) return send(uid, '🔑 کلید Gemini ثبت نشده؛ نتیجه رو دستی بفرست («رتبه شماره‌ی‌تیم کیل»).', [[B('❌ لغو', 'mc:home')]]);
  const file = m.photo ? m.photo[m.photo.length - 1] : m.document;
  const mime = m.photo ? 'image/jpeg' : m.document.mime_type;
  await send(uid, '⏳ دارم اسکرین‌شات رو می‌خونم…', false);
  try {
    const images = [{ mime, data: await api.getFileContent(file.file_id) }];
    const teamsIn = list.map((t, i) => ({ team_id: t.id, team_name: t.team, players: JSON.parse(t.members || '[]'), slot_number: i + 1 }));
    const raw = await geminiVision({ system: SYSTEM, prompt: 'Registered teams in this lobby (JSON):\n' + JSON.stringify(teamsIn), images, schema: SCHEMA });
    const rows = cleanRows(raw, teamsIn).map((r) => ({ rank: r.rank, team: r.team_id, kills: r.kills, names: r.names }));
    p.rows = mergeRows(p.rows, rows, false);
    return preview(uid, st, c, `📸 خونده شد: ${fa(rows.length)} تیم.`);
  } catch (e) {
    console.warn('mc shot', e.message);
    return send(uid, `⚠️ نتونستم بخونمش؛ دوباره بفرست یا دستی وارد کن.\n<code>${esc(String(e.message).slice(0, 150))}</code>`, [[B('❌ لغو', 'mc:home')]]);
  }
}

// ---------- typed input ----------
/** The admin's answers (st.w = mc:new:… / mc:room:… / mc:shot:…). -> true when handled */
export async function adminInput(uid, st, m) {
  const t = (m.text || '').trim();
  const [, what, a, b] = st.w.split(':');
  if (what === 'new') {
    if (a === 'wait' || !t) return false; // a button step: typed text isn't an answer
    st.mc = st.mc || {};
    if (a === 'name') st.mc.name = t.slice(0, 40);
    if (a === 'prize') st.mc.prize = t.slice(0, 60);
    await draftStep(uid, st, null);
    return true;
  }
  if (what === 'room') {
    if (!t) return false;
    const c = await getCup(Number(a));
    if (!c) return false;
    const list = await lobby(c, b);
    let ok = 0;
    for (const x of list) {
      const r = await send(x.uid, `🔑 <b>رمز ${lobbyName(b)} — ${esc(c.name)}</b>\n\n<code>${esc(t)}</code>\n\n🔥 موفق باشید!`, false);
      if (r.ok) ok++;
    }
    st.w = null;
    await panel(uid, c, null, `🔑 برای ${fa(ok)} از ${fa(list.length)} لیدر ${lobbyName(b)} فرستاده شد.` + (ok < list.length ? '\n⚠️ بقیه ربات رو بلاک کردن.' : ''));
    return true;
  }
  if (what === 'shot') {
    const c = await getCup(Number(a));
    if (!c || !st.mcr || st.mcr.id !== c.id) return false;
    if (m.photo || m.document?.mime_type?.startsWith('image/')) { await readShot(uid, st, c, m); return true; }
    if (!t) return false;
    const rows = parseManual(t, await lobby(c, st.mcr.key));
    if (!rows) {
      await send(uid, '⚠️ متوجه نشدم. هر خط: «رتبه شماره‌ی‌تیم کیل»، مثلاً <code>1 5 12</code>', [[B('❌ لغو', 'mc:home')]]);
      return true;
    }
    st.mcr.rows = mergeRows(st.mcr.rows, rows, true);
    await preview(uid, st, c);
    return true;
  }
  return false;
}

// ---------- anyone: registering a team ----------
export async function joinTap(c) {
  const cup = await getCup(Number(c.data.split(':')[2]));
  const alert = (text) => call('answerCallbackQuery', { callback_query_id: c.id, text, show_alert: true });
  if (!cup || cup.status !== 'reg') return alert('🔒 ثبت‌نام این مینی‌کاپ بسته شده.');
  if (await db.get(sql`SELECT 1 AS x FROM mc_teams WHERE cup_id = ${cup.id} AND uid = ${c.from.id}`)) return alert('✅ تیمت قبلاً ثبت شده!');
  if ((await teamCount(cup.id)) >= capacity(cup)) return alert('⛔️ ظرفیت پر شده.');
  return call('answerCallbackQuery', { callback_query_id: c.id, url: `https://t.me/${await botName()}?start=mc_${cup.id}` });
}

/** /start mc_<id> */
export async function regStart(uid, st, id) {
  const cup = await getCup(id);
  if (!cup || cup.status !== 'reg') return send(uid, '🔒 ثبت‌نام این مینی‌کاپ بسته شده.', false);
  const mine = await db.get(sql`SELECT team FROM mc_teams WHERE cup_id = ${id} AND uid = ${uid}`);
  if (mine) return send(uid, `✅ تیم «${esc(mine.team)}» قبلاً توی ${esc(cup.name)} ثبت شده.\nرمز روم همین‌جا برات میاد 🔑`, false);
  st.w = `mc:team:${id}`;
  return send(uid, `⚡️ <b>ثبت‌نام ${esc(cup.name)}</b>\n${LINE}\n` + (cup.prize ? `🏆 جایزه‌ی قهرمان: ${esc(cup.prize)}\n\n` : '') +
    '✍️ <b>اسم تیمت رو بفرست.</b>\n\nاگه خواستی، توی خط‌های بعدی اسم داخل بازی بازیکن‌ها رو هم بنویس (اختیاری؛ برای اینکه ربات از روی اسکرین‌شات تیمت رو بهتر بشناسه):\n' +
    '<code>Wolves\n×͜×ALI\n×͜×REZA</code>', false);
}

export async function teamInput(uid, st, m) {
  const id = Number(st.w.split(':')[2]);
  const lines = (m.text || '').split('\n').map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
  if (!lines.length || lines[0].startsWith('/')) return false;
  st.w = null;
  const cup = await getCup(id);
  if (!cup || cup.status !== 'reg') { await send(uid, '🔒 ثبت‌نام بسته شده.', false); return true; }
  if ((await teamCount(id)) >= capacity(cup)) { await send(uid, '⛔️ ظرفیت پر شده.', false); return true; }
  const team = lines[0].slice(0, 30);
  const members = lines.slice(1, 6).map((x) => x.slice(0, 30));
  const from = m.from || {};
  const who = [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, 40) || String(uid);
  await db.run(sql`INSERT INTO mc_teams (cup_id, uid, name, team, members, fin, at) VALUES (${id}, ${uid}, ${who}, ${team}, ${JSON.stringify(members)}, 0, ${now()})
    ON CONFLICT(cup_id, uid) DO NOTHING`);
  await refreshPost(cup);
  await send(uid, `✅ <b>تیم «${esc(team)}» ثبت شد!</b>\n\nرمز روم گروهت همین‌جا برات میاد 🔑\nربات رو بلاک نکن 🙏`, false);
  return true;
}
