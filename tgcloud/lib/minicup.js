// ⚡️ Mini-cup: a small, quick warm-up tournament — separate from the big tournament (lib/tournament.js).
// A few qualifier rooms, the best team(s) of each go to a final, the champion gets the prize right in the bot
// (a VPN subscription through the VPN bot, with the same signed one-time claim as the giveaways, or a text).
//
// Flow: create (name → rooms → teams per room to the final → prize) → publish in the channel with a
// «✅ register» button → leaders register their team name in the bot → close registration: teams are split
// into rooms at random and posted → per room: send ID/Pass to that room's leaders only, pick the winner(s) →
// the final: post the finalists, send ID/Pass, pick the champion → the champion is posted and gets the prize.
// Nothing is ever deleted; every channel post happens only when the admin presses its button.
//
// Cup: settings mc:<id> (admin writes only) · teams: table mc_teams (many leaders register at once).
// Callbacks: mc:<act>:<id>[:arg] (admin), mc:j:<id> (the channel's register button, anyone).
// Waiting states: st.w = mc:new:<field> / mc:room:<id>:<grp> (admin), mc:team:<id> (a leader).
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { esc, call, send, now, LINE } from './util.js';
import * as store from './store.js';
import { claimParam } from './claim.js';

const B = (text, data, style) => ({ text, callback_data: data, ...(style ? { style } : {}) });
const G = (t, d) => B(t, d, 'success');
const R = (t, d) => B(t, d, 'danger');
const U = (t, d) => B(t, d, 'primary');
const BACK = [B('🔙 برگشت به منو', 'menu')];
const fa = (n) => Number(n || 0).toLocaleString('fa-IR');
const MEDAL = ['🥇', '🥈', '🥉'];

// VPN prizes (the VPN bot gives them; the signed claim carries GB and days)
const VPN = [
  { id: 'v10', gb: 10, days: 30, label: 'اشتراک VPN ۱۰ گیگ ۳۰ روزه' },
  { id: 'v20', gb: 20, days: 30, label: 'اشتراک VPN ۲۰ گیگ ۳۰ روزه' },
  { id: 'v50', gb: 50, days: 30, label: 'اشتراک VPN ۵۰ گیگ ۳۰ روزه' },
];
const CLAIM_BASE = 800000; // claim ids for cups (giveaways use their own small ids)

// ---------- data ----------
const getCup = async (id) => JSON.parse((await store.getSetting(`mc:${id}`)) || 'null');
const saveCup = (c) => store.setSetting(`mc:${c.id}`, JSON.stringify(c));
async function activeCup() {
  const id = Number(await store.getSetting('mc_active')) || 0;
  return id ? getCup(id) : null;
}
const teams = (cupId) => db.all(sql`SELECT * FROM mc_teams WHERE cup_id = ${cupId} ORDER BY id`);
const teamCount = async (cupId) => (await db.get(sql`SELECT count(*) AS n FROM mc_teams WHERE cup_id = ${cupId}`))?.n || 0;
const prizeLabel = (c) => c.prize?.label || '—';
const roomName = (g) => `روم ${fa(g + 1)}`;
const CAP_PER_ROOM = 25; // squads in a PUBG custom room

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

// ---------- the channel posts ----------
function announceText(c, n) {
  return `⚡️ <b>${esc(c.name)}</b>\n${LINE}\n` +
    '🎮 یه تورنمنت کوچیک و سریع برای گرم شدن دست‌ها!\n\n' +
    `🏟 <b>${fa(c.rooms)}</b> روم مقدماتی\n` +
    `🔥 از هر روم <b>${fa(c.adv)}</b> تیم میره فینال\n` +
    `🏆 جایزه‌ی قهرمان: <b>${esc(prizeLabel(c))}</b>\n\n` +
    `👥 تیم‌های ثبت‌نامی: <b>${fa(n)}</b> از ${fa(c.rooms * CAP_PER_ROOM)}\n\n` +
    (c.status === 'reg' ? '👇 <b>لیدر تیم</b> دکمه‌ی ثبت‌نام رو بزنه' : '🔒 ثبت‌نام بسته شد');
}
const regKb = (c, n) => (c.status === 'reg' ? [[{ text: `✅ ثبت‌نام تیم (${fa(n)})`, callback_data: `mc:j:${c.id}`, style: 'success' }]] : []);

/** Keep the announcement's count and button up to date. */
async function refreshPost(c) {
  if (!c.post) return;
  const n = await teamCount(c.id);
  await call('editMessageText', { chat_id: c.chat, message_id: c.post, text: announceText(c, n), parse_mode: 'HTML', reply_markup: { inline_keyboard: regKb(c, n) } });
}

// ---------- the admin panel ----------
export async function home(uid, st, mid = null) {
  st.w = null;
  const c = await activeCup();
  if (!c) {
    const past = Number(await store.getSetting('mc_last')) || 0;
    return edit(uid, mid,
      `⚡️ <b>مینی‌کاپ</b>\n${LINE}\n` +
      'یه تورنمنت کوچیک و سریع، جدا از تورنمنت اصلی، برای اینکه اعضای کانال دستشون گرم بشه:\n\n' +
      '1️⃣ چند تا روم مقدماتی\n2️⃣ برنده‌های هر روم میرن فینال\n3️⃣ قهرمان جایزه‌ش رو مستقیم از ربات می‌گیره 🎁\n\n' +
      (past ? `🗂 تا الان ${fa(past)} مینی‌کاپ برگزار شده.` : ''),
      [[G('➕ ساخت مینی‌کاپ جدید', 'mc:new')], BACK]);
  }
  return panel(uid, c, mid);
}

async function panel(uid, c, mid = null, note = '') {
  const list = await teams(c.id);
  const n = list.length;
  const head = `⚡️ <b>${esc(c.name)}</b>\n${LINE}\n🏆 جایزه: <b>${esc(prizeLabel(c))}</b>\n` +
    `🏟 ${fa(c.rooms)} روم · از هر روم ${fa(c.adv)} تیم به فینال\n👥 تیم‌ها: <b>${fa(n)}</b>\n`;
  let body = '';
  const rows = [];
  if (c.status === 'draft') {
    body = '\n📝 هنوز توی کانال منتشر نشده.';
    rows.push([G('📢 انتشار توی کانال', `mc:pub:${c.id}`)]);
  } else if (c.status === 'reg') {
    body = '\n🟢 <b>ثبت‌نام بازه.</b>' + (n ? `\n\n${list.slice(-15).map((t, i) => `${fa(n - Math.min(n, 15) + i + 1)}. ${esc(t.team)}`).join('\n')}${n > 15 ? '\n…' : ''}` : '');
    if (n >= 2) rows.push([R(`🔒 بستن ثبت‌نام و چیدن ${fa(c.rooms)} روم`, `mc:close:${c.id}`)]);
  } else if (c.status === 'rooms') {
    body = '\n🏟 <b>مرحله‌ی مقدماتی</b>\n';
    for (let g = 0; g < c.rooms; g++) {
      const inRoom = list.filter((t) => t.grp === g);
      const won = inRoom.filter((t) => t.fin);
      body += `\n${roomName(g)} (${fa(inRoom.length)} تیم): ${won.length ? '✅ ' + won.map((t) => esc(t.team)).join('، ') : '⏳'}`;
      rows.push([U(`🔑 آیدی/پسورد ${roomName(g)}`, `mc:key:${c.id}:${g}`), G(`🏆 برنده‌ی ${roomName(g)}`, `mc:win:${c.id}:${g}`)]);
    }
    if (list.filter((t) => t.fin).length && Array.from({ length: c.rooms }, (_, g) => list.some((t) => t.grp === g && t.fin)).every(Boolean)) {
      rows.push([R('🔥 اعلام فینال توی کانال', `mc:final:${c.id}`)]);
    }
  } else if (c.status === 'final') {
    const fin = list.filter((t) => t.fin);
    body = `\n🔥 <b>فینال</b>\n${fin.map((t) => `• ${esc(t.team)}`).join('\n')}`;
    rows.push([U('🔑 آیدی/پسورد فینال', `mc:key:${c.id}:f`)]);
    rows.push([G('👑 انتخاب قهرمان', `mc:champ:${c.id}`)]);
  }
  rows.push([B('❌ لغو این مینی‌کاپ', `mc:cancel:${c.id}`)], BACK);
  return edit(uid, mid, head + body + (note ? `\n\n${note}` : ''), rows);
}

// ---------- creating a cup ----------
async function draftStep(uid, st, mid) {
  const d = st.mc || {};
  if (!d.name) {
    st.w = 'mc:new:name';
    const next = (Number(await store.getSetting('mc_last')) || 0) + 1;
    return edit(uid, mid, `⚡️ <b>مینی‌کاپ جدید</b> — ۱ از ۴\n${LINE}\n✍️ اسمش چی باشه؟ بفرست، یا دکمه رو بزن.`,
      [[G(`⚡️ مینی‌کاپ #${fa(next)}`, 'mc:nn')], [B('❌ لغو', 'mc:home')]]);
  }
  st.w = 'mc:new:wait'; // keeps the draft (st.mc) in the session between the button steps
  if (!d.rooms) {
    return edit(uid, mid, `⚡️ <b>${esc(d.name)}</b> — ۲ از ۴\n${LINE}\n🏟 چند تا روم مقدماتی؟`,
      [[2, 3, 4].map((n) => U(`${fa(n)} روم`, `mc:nr:${n}`)), [B('❌ لغو', 'mc:home')]]);
  }
  if (!d.adv) {
    return edit(uid, mid, `⚡️ <b>${esc(d.name)}</b> — ۳ از ۴\n${LINE}\n🔥 از هر روم چند تا تیم بره فینال؟`,
      [[1, 2, 3].map((n) => U(`${fa(n)} تیم`, `mc:na:${n}`)), [B('❌ لغو', 'mc:home')]]);
  }
  if (!d.prize) {
    st.w = 'mc:new:prize';
    return edit(uid, mid, `⚡️ <b>${esc(d.name)}</b> — ۴ از ۴\n${LINE}\n🏆 جایزه‌ی قهرمان چی باشه؟\n\n` +
      '🔐 اشتراک VPN: قهرمان مستقیم از ربات VPN تحویل می‌گیره (یه بار، فقط برای خودش).\n✍️ یا هر جایزه‌ی دیگه‌ای رو بنویس و بفرست (مثلاً «۶۰ یوسی»).',
    [...VPN.map((v) => [G(`🔐 ${v.label}`, `mc:np:${v.id}`)]), [B('❌ لغو', 'mc:home')]]);
  }
  const chs = (await store.user(uid)).channels;
  if (!d.chat) {
    if (chs.length === 1) d.chat = chs[0].id;
    else {
      return edit(uid, mid, `⚡️ <b>${esc(d.name)}</b>\n${LINE}\n📢 توی کدوم کانال؟`,
        [...chs.map((ch) => [U(ch.title, `mc:nc:${ch.id}`)]), [B('❌ لغو', 'mc:home')]]);
    }
  }
  // all set: save it as a draft and show the panel
  const id = (Number(await store.getSetting('mc_last')) || 0) + 1;
  await store.setSetting('mc_last', String(id));
  const cup = { id, name: d.name, rooms: d.rooms, adv: d.adv, prize: d.prize, chat: d.chat, status: 'draft', post: null, created: now() };
  await saveCup(cup);
  await store.setSetting('mc_active', String(id));
  st.mc = null;
  st.w = null;
  return panel(uid, cup, mid, '✅ ساخته شد. «انتشار توی کانال» رو بزن تا ثبت‌نام شروع بشه.');
}

// ---------- the admin's buttons (mc:…) ----------
export async function action(uid, st, data, mid) {
  const [, act, a, b] = data.split(':');
  if (act === 'home' || !act) { st.mc = null; return home(uid, st, mid); }
  if (act === 'new') {
    if (await activeCup()) return home(uid, st, mid);
    st.mc = {};
    return draftStep(uid, st, mid);
  }
  if (act === 'nn' || act === 'nr' || act === 'na' || act === 'np' || act === 'nc') {
    st.mc = st.mc || {};
    if (act === 'nn') st.mc.name = `مینی‌کاپ #${fa((Number(await store.getSetting('mc_last')) || 0) + 1)}`;
    if (act === 'nr') st.mc.rooms = Math.min(4, Math.max(2, Number(a)));
    if (act === 'na') st.mc.adv = Math.min(3, Math.max(1, Number(a)));
    if (act === 'np') { const v = VPN.find((x) => x.id === a); if (v) st.mc.prize = { kind: 'vpn', gb: v.gb, days: v.days, label: v.label }; }
    if (act === 'nc') st.mc.chat = Number(a);
    return draftStep(uid, st, mid);
  }

  const c = await getCup(Number(a));
  if (!c) return home(uid, st, mid);

  switch (act) {
    case 'pub': { // publish the announcement in the channel
      if (c.status !== 'draft') return panel(uid, c, mid);
      c.status = 'reg';
      const r = await call('sendMessage', { chat_id: c.chat, text: announceText(c, 0), parse_mode: 'HTML', reply_markup: { inline_keyboard: regKb(c, 0) } });
      if (!r.ok) { c.status = 'draft'; return panel(uid, c, mid, `⚠️ نتونستم توی کانال بفرستم: ${esc(r.description || '')}`); }
      c.post = r.result.message_id;
      await saveCup(c);
      return panel(uid, c, mid, '📢 توی کانال منتشر شد؛ ثبت‌نام شروع شد.');
    }
    case 'close': // ask first
      return edit(uid, mid, `🔒 ثبت‌نام بسته بشه و تیم‌ها شانسی توی ${fa(c.rooms)} روم چیده بشن؟\n\nلیست روم‌ها توی کانال منتشر میشه.`,
        [[R('🔒 آره، ببند و بچین', `mc:closey:${c.id}`)], [G('❌ نه', `mc:home`)]]);
    case 'closey': {
      if (c.status !== 'reg') return panel(uid, c, mid);
      const list = await teams(c.id);
      // shuffle, then deal the teams round the rooms
      for (let i = list.length - 1; i > 0; i--) {
        const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
        [list[i], list[j]] = [list[j], list[i]];
      }
      for (let i = 0; i < list.length; i++) await db.run(sql`UPDATE mc_teams SET grp = ${i % c.rooms} WHERE id = ${list[i].id}`);
      c.status = 'rooms';
      await saveCup(c);
      await refreshPost(c);
      const fresh = await teams(c.id);
      const text = `⚡️ <b>${esc(c.name)}</b> — روم‌ها چیده شد!\n${LINE}\n` +
        Array.from({ length: c.rooms }, (_, g) => `🏟 <b>${roomName(g)}</b>\n${fresh.filter((t) => t.grp === g).map((t) => `• ${esc(t.team)}`).join('\n')}`).join('\n\n') +
        `\n\n🔑 آیدی و پسورد هر روم <b>فقط برای لیدرهای همون روم</b> توی ربات فرستاده میشه.\n🔥 از هر روم ${fa(c.adv)} تیم میره فینال!`;
      await call('sendMessage', { chat_id: c.chat, text, parse_mode: 'HTML', reply_parameters: c.post ? { message_id: c.post, allow_sending_without_reply: true } : undefined });
      return panel(uid, c, mid, '✅ روم‌ها چیده و توی کانال منتشر شد.');
    }
    case 'key': { // ID/Pass to one room's leaders (or the finalists)
      st.w = `mc:room:${c.id}:${b}`;
      const who = b === 'f' ? 'فینال' : roomName(Number(b));
      return edit(uid, mid, `🔑 <b>آیدی و پسورد ${who}</b>\n${LINE}\nبفرستش؛ فقط برای لیدرهای ${who} توی ربات فرستاده میشه.\n\nمثال:\n<code>ID: 1234567\nPass: 999</code>`,
        [[B('❌ لغو', `mc:home`)]]);
    }
    case 'win': { // pick a room's winner(s): toggle a team
      const g = Number(b);
      const inRoom = (await teams(c.id)).filter((t) => t.grp === g);
      const picked = inRoom.filter((t) => t.fin).length;
      return edit(uid, mid, `🏆 <b>برنده‌ی ${roomName(g)}</b>\n${LINE}\n${fa(c.adv)} تیم رو انتخاب کن (${fa(picked)} از ${fa(c.adv)}):`,
        [...inRoom.map((t) => [(t.fin ? G : B)(`${t.fin ? '✅ ' : ''}${t.team}`, `mc:tw:${c.id}:${t.id}`)]), [U('✔️ تمام', `mc:home`)]]);
    }
    case 'tw': { // toggle one team as a room winner
      const t = await db.get(sql`SELECT * FROM mc_teams WHERE id = ${Number(b)} AND cup_id = ${c.id}`);
      if (!t || c.status !== 'rooms') return panel(uid, c, mid);
      const picked = (await teams(c.id)).filter((x) => x.grp === t.grp && x.fin).length;
      if (!t.fin && picked >= c.adv) return action(uid, st, `mc:win:${c.id}:${t.grp}`, mid);
      await db.run(sql`UPDATE mc_teams SET fin = ${t.fin ? 0 : 1} WHERE id = ${t.id}`);
      return action(uid, st, `mc:win:${c.id}:${t.grp}`, mid);
    }
    case 'final': {
      if (c.status !== 'rooms') return panel(uid, c, mid);
      const fin = (await teams(c.id)).filter((t) => t.fin);
      c.status = 'final';
      await saveCup(c);
      await call('sendMessage', { chat_id: c.chat, parse_mode: 'HTML', reply_parameters: c.post ? { message_id: c.post, allow_sending_without_reply: true } : undefined,
        text: `🔥 <b>فینال ${esc(c.name)}</b>\n${LINE}\n${fin.map((t) => `⚔️ ${esc(t.team)}`).join('\n')}\n\n🏆 جایزه‌ی قهرمان: <b>${esc(prizeLabel(c))}</b>\n🍀 موفق باشید!` });
      for (const t of fin) await send(t.uid, `🔥 <b>تیمت رفت فینال!</b>\n⚡️ ${esc(c.name)}\n\nآیدی و پسورد روم فینال همین‌جا برات میاد.`, false);
      return panel(uid, c, mid, '🔥 فینال اعلام شد.');
    }
    case 'champ': {
      const fin = (await teams(c.id)).filter((t) => t.fin);
      return edit(uid, mid, `👑 <b>قهرمان کیه؟</b>\n${LINE}\nبعد از انتخاب، اسمش توی کانال اعلام میشه و جایزه مستقیم توی ربات براش فرستاده میشه.`,
        [...fin.map((t) => [G(`👑 ${t.team}`, `mc:cy:${c.id}:${t.id}`)]), [B('❌ لغو', `mc:home`)]]);
    }
    case 'cy': { // confirm the champion
      const t = await db.get(sql`SELECT * FROM mc_teams WHERE id = ${Number(b)} AND cup_id = ${c.id}`);
      if (!t) return panel(uid, c, mid);
      return edit(uid, mid, `👑 قهرمان: <b>${esc(t.team)}</b>؟\n\nاعلام توی کانال + فرستادن جایزه (${esc(prizeLabel(c))}) برای لیدرش.`,
        [[G('✅ آره، اعلام کن', `mc:cz:${c.id}:${t.id}`)], [B('❌ نه', `mc:champ:${c.id}`)]]);
    }
    case 'cz': {
      if (c.status !== 'final') return panel(uid, c, mid);
      const t = await db.get(sql`SELECT * FROM mc_teams WHERE id = ${Number(b)} AND cup_id = ${c.id}`);
      if (!t) return panel(uid, c, mid);
      c.status = 'done';
      c.champion = { uid: t.uid, team: t.team };
      await saveCup(c);
      await store.setSetting('mc_active', null);
      await call('sendMessage', { chat_id: c.chat, parse_mode: 'HTML', reply_parameters: c.post ? { message_id: c.post, allow_sending_without_reply: true } : undefined,
        text: `👑 <b>قهرمان ${esc(c.name)}</b>\n${LINE}\n🏆 <b>${esc(t.team)}</b>\n\n🎁 جایزه: ${esc(prizeLabel(c))}\n\n🔥 مرسی از همه‌ی تیم‌ها، تا مینی‌کاپ بعدی!` });
      const delivered = await givePrize(c, t);
      st.w = null;
      return edit(uid, mid, `👑 <b>${esc(t.team)}</b> قهرمان شد و توی کانال اعلام شد.\n\n` +
        (delivered ? '🎁 جایزه توی ربات براش فرستاده شد.' : '⚠️ نتونستم جایزه رو توی ربات براش بفرستم (ربات رو بلاک کرده؟)؛ خودت بهش بده.'),
      [[G('➕ مینی‌کاپ بعدی', 'mc:new')], BACK]);
    }
    case 'cancel':
      return edit(uid, mid, `❌ «${esc(c.name)}» لغو بشه؟\n\n(پستی پاک نمیشه؛ فقط ثبت‌نام بسته و این مینی‌کاپ تموم میشه.)`,
        [[R('❌ آره، لغو کن', `mc:cancely:${c.id}`)], [G('نه', 'mc:home')]]);
    case 'cancely':
      c.status = 'cancelled';
      await saveCup(c);
      await store.setSetting('mc_active', null);
      await refreshPost({ ...c, status: 'closed' });
      return home(uid, st, mid);
    default:
      return panel(uid, c, mid);
  }
}

/** The champion's prize, straight into the bot: a VPN claim button (signed, one-time) or the text prize. */
async function givePrize(c, t) {
  const p = c.prize || {};
  if (p.kind === 'vpn') {
    const secret = await store.getSetting('claim_secret');
    if (secret) {
      const vpnBot = (await store.getSetting('vpn_bot')) || 'Kankivpn_bot';
      const param = await claimParam(secret, { gid: CLAIM_BASE + c.id, n: 0, uid: t.uid, gb: p.gb, days: p.days, tag: 'MiniCup' });
      const r = await send(t.uid, `👑🎉 <b>تبریک! تیم «${esc(t.team)}» قهرمان ${esc(c.name)} شد!</b>\n\n🎁 جایزه‌ت: <b>${esc(p.label)}</b>\n\n` +
        '👇 دکمه رو بزن؛ ربات VPN باز میشه و اشتراکت رو به اسم خودت تحویل میده.\n⚠️ فقط برای حساب خودت کار می‌کنه و فقط یه بار.',
      [[{ text: '🎁 دریافت اشتراک', url: `https://t.me/${vpnBot}?start=${param}`, style: 'success' }]]);
      return r.ok;
    }
  }
  const r = await send(t.uid, `👑🎉 <b>تبریک! تیم «${esc(t.team)}» قهرمان ${esc(c.name)} شد!</b>\n\n🎁 جایزه‌ت: <b>${esc(p.label || '')}</b>\nادمین کانال به‌زودی جایزه‌ت رو میده.`, false);
  await send(store.OWNER_ID, `🎁 جایزه‌ی «${esc(p.label || '')}» رو به لیدر «${esc(t.team)}» بده: <a href="tg://user?id=${t.uid}">پیام به لیدر</a>`, false);
  return r.ok;
}

// ---------- typed input ----------
/** The admin's typed answers (st.w = mc:new:… / mc:room:…). -> true when handled */
export async function adminInput(uid, st, m) {
  const t = (m.text || '').trim();
  if (!t) return false;
  const [, what, a, b] = st.w.split(':');
  if (what === 'new') {
    if (a === 'wait') return false; // a button step: typed text isn't an answer
    st.mc = st.mc || {};
    if (a === 'name') st.mc.name = t.slice(0, 40);
    if (a === 'prize') st.mc.prize = { kind: 'text', label: t.slice(0, 60) };
    await draftStep(uid, st, null);
    return true;
  }
  if (what === 'room') {
    const c = await getCup(Number(a));
    if (!c) return false;
    const list = (await teams(c.id)).filter((x) => (b === 'f' ? x.fin : x.grp === Number(b)));
    const who = b === 'f' ? 'فینال' : roomName(Number(b));
    let ok = 0;
    for (const x of list) {
      const r = await send(x.uid, `🔑 <b>${who} — ${esc(c.name)}</b>\n\n<code>${esc(t)}</code>\n\n🔥 موفق باشید!`, false);
      if (r.ok) ok++;
    }
    st.w = null;
    await panel(uid, c, null, `🔑 برای ${fa(ok)} از ${fa(list.length)} لیدر ${who} فرستاده شد.` + (ok < list.length ? '\n⚠️ بقیه ربات رو بلاک کردن یا هنوز استارتش نکردن.' : ''));
    return true;
  }
  return false;
}

// ---------- anyone: registering a team ----------
/** The channel's «✅ register» button (mc:j:<id>): open the bot for the leader. */
export async function joinTap(c) {
  const cup = await getCup(Number(c.data.split(':')[2]));
  const alert = (text) => call('answerCallbackQuery', { callback_query_id: c.id, text, show_alert: true });
  if (!cup || cup.status !== 'reg') return alert('🔒 ثبت‌نام این مینی‌کاپ بسته شده.');
  if (await db.get(sql`SELECT 1 AS x FROM mc_teams WHERE cup_id = ${cup.id} AND uid = ${c.from.id}`)) return alert('✅ تیمت قبلاً ثبت شده!');
  return call('answerCallbackQuery', { callback_query_id: c.id, url: `https://t.me/${await botName()}?start=mc_${cup.id}` });
}

/** /start mc_<id>: ask the leader for the team name. */
export async function regStart(uid, st, id) {
  const cup = await getCup(id);
  if (!cup || cup.status !== 'reg') return send(uid, '🔒 ثبت‌نام این مینی‌کاپ بسته شده.', false);
  const mine = await db.get(sql`SELECT team FROM mc_teams WHERE cup_id = ${id} AND uid = ${uid}`);
  if (mine) return send(uid, `✅ تیم «${esc(mine.team)}» قبلاً توی ${esc(cup.name)} ثبت شده.\nآیدی و پسورد روم همین‌جا برات میاد.`, false);
  st.w = `mc:team:${id}`;
  return send(uid, `⚡️ <b>ثبت‌نام ${esc(cup.name)}</b>\n${LINE}\n🏆 جایزه‌ی قهرمان: ${esc(prizeLabel(cup))}\n\n✍️ <b>اسم تیمت رو بفرست:</b>`, false);
}

/** The leader's typed team name (st.w = mc:team:<id>). -> true when handled */
export async function teamInput(uid, st, m) {
  const id = Number(st.w.split(':')[2]);
  const name = (m.text || '').trim().replace(/\s+/g, ' ').slice(0, 30);
  if (!name || name.startsWith('/')) return false;
  st.w = null;
  const cup = await getCup(id);
  if (!cup || cup.status !== 'reg') { await send(uid, '🔒 ثبت‌نام بسته شده.', false); return true; }
  if ((await teamCount(id)) >= cup.rooms * CAP_PER_ROOM) { await send(uid, '⛔️ ظرفیت پر شده.', false); return true; }
  const from = m.from || {};
  const who = [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, 40) || (from.username ? '@' + from.username : String(uid));
  await db.run(sql`INSERT INTO mc_teams (cup_id, uid, name, team, fin, at) VALUES (${id}, ${uid}, ${who}, ${name}, 0, ${now()})
    ON CONFLICT(cup_id, uid) DO NOTHING`);
  await refreshPost(cup);
  await send(uid, `✅ <b>تیم «${esc(name)}» ثبت شد!</b>\n\nوقتی روم‌ها چیده بشن، آیدی و پسورد رومت همین‌جا برات میاد 🔑\nربات رو بلاک نکن 🙏`, false);
  return true;
}
