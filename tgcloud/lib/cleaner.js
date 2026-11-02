// 🧹 Channel cleaner: delete the channel's posts that contain words the admin chooses.
//
// Telegram's rule for bots (Bot API, deleteMessage): "a message can only be deleted if it was sent less
// than 48 hours ago" — even for an admin bot. So:
//   • every new post is checked the moment it's published (and again when edited) and deleted if it matches;
//   • «پاکسازی» deletes the matching posts of the last 48 hours;
//   • older posts can't be deleted, but a bot may still EDIT them: «خالی کردن پست‌های قدیمی» turns each one
//     into a bare «🗑» (its photo/video replaced by a trash-can picture), a slice at a time.
// The bot never forwards or sends posts anywhere to read them: it reads each post as it's published.
//
// Callback data: cf:<act>:<chat>[:arg]   ·   waiting states: st.w = cf:<what>:<chat>
import { db, InputFile } from 'sdk';
import { sql } from 'sdk/db';
import { esc, call, send, now, LINE } from './util.js';
import * as store from './store.js';
import { blankPng } from './cleanblank.js';
import { buildMatcher, extractPost, normalize, compileKeyword, parseKeywordInput, regexError, snippet, variants } from './cleantext.js';

const WINDOW = 47 * 3600 + 1800; // a little under Telegram's 48 hours
const sleep = (ms) => (typeof setTimeout === 'function' ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const one = async (q) => (await db.get(q)) || null;

// colored buttons: green = success, red = danger, blue = primary
const B = (text, data, style) => ({ text, callback_data: data, ...(style ? { style } : {}) });
const G = (t, d) => B(t, d, 'success');
const R = (t, d) => B(t, d, 'danger');
const U = (t, d) => B(t, d, 'primary');
const onOff = (v) => (v ? 'روشن ✅' : 'خاموش ⛔️');
const tog = (v, t, d) => (v ? G : R)(`${t}: ${onOff(v)}`, d);
// the Mini App page that deletes old posts with the admin's own account (bots can't, people can)
const FULL = (chat, word = '', text = '🔐 حذف کامل پست‌های قدیمی (با اکانت خودت)') =>
  ({ text, web_app: { url: `https://app8719466331.tgcloud.ai/clean?c=${chat}${word ? `&w=${encodeURIComponent(word)}` : ''}` }, style: 'danger' });
const MODE = { word: 'خود کلمه', contains: 'هر جای متن', regex: 'Regex' };

// ---------- per-channel settings (in the settings table) ----------
const DEF = { auto: false, smart: false, links: false, fwd: false, notify: false, backup: null, last: 0, deleted: 0 };
export async function cfg(chat) {
  return { ...DEF, ...JSON.parse((await store.getSetting(`cl:${chat}`)) || '{}') };
}
async function patchCfg(chat, patch) {
  const c = { ...(await cfg(chat)), ...patch };
  await store.setSetting(`cl:${chat}`, JSON.stringify(c));
  return c;
}

// ---------- data ----------
const words = (chat, kind) => kind
  ? db.all(sql`SELECT * FROM cl_words WHERE chat_id = ${chat} AND kind = ${kind} ORDER BY id`)
  : db.all(sql`SELECT * FROM cl_words WHERE chat_id = ${chat} ORDER BY id`);

async function savePost(chat, msgId, p, date) {
  await db.run(sql`INSERT INTO cl_posts (chat_id, msg_id, body, mgroup, fwd, link, gone, date)
    VALUES (${chat}, ${msgId}, ${p.body || ''}, ${p.mediaGroup || null}, ${p.isForward ? 1 : 0}, ${p.hasLink ? 1 : 0}, 0, ${date || null})
    ON CONFLICT(chat_id, msg_id) DO UPDATE SET body = excluded.body, fwd = excluded.fwd, link = excluded.link,
      mgroup = coalesce(excluded.mgroup, cl_posts.mgroup), date = coalesce(cl_posts.date, excluded.date)`);
}

const matcherFor = async (chat, c, quick) => quick
  ? buildMatcher({ smartRoom: !!quick.smart }, [{ id: null, word: quick.word, mode: quick.mode, kind: 'block' }])
  : buildMatcher({ ruleLinks: c.links, ruleForward: c.fwd, smartRoom: c.smart }, await words(chat));

/** Matching live posts, split into deletable (last 48 h) and too old. */
async function collect(chat, matcher) {
  const fresh = [];
  const oldItems = [];
  let after = 0;
  const since = now() - WINDOW;
  for (;;) {
    const page = await db.all(sql`SELECT msg_id AS id, body, mgroup, fwd, link, date FROM cl_posts
      WHERE chat_id = ${chat} AND gone = 0 AND msg_id > ${after} ORDER BY msg_id LIMIT 500`);
    for (const p of page) {
      const m = matcher({ body: p.body, hasLink: !!p.link, isForward: !!p.fwd });
      if (!m) continue;
      const item = { id: p.id, body: p.body, mgroup: p.mgroup, reason: m.reason, kw: m.keywordId };
      if (p.date && p.date >= since) fresh.push(item);
      else oldItems.push(item);
    }
    if (page.length < 500) return { fresh, old: oldItems.length, oldItems };
    after = page[page.length - 1].id;
  }
}

// ---------- deleting ----------
async function tg(method, params) {
  for (let i = 0; i < 3; i++) {
    const r = await call(method, params);
    if (r.ok || r.code !== 429) return r;
    const wait = Number((r.description || '').match(/retry after (\d+)/i)?.[1] || 5);
    if (wait > 10) return r;
    await sleep(wait * 1000 + 300);
  }
  return call(method, params);
}

/**
 * Back up (optional) and delete posts and their album siblings. Only what Telegram really deleted is
 * counted and logged. -> { deleted, old, rate }
 */
async function removePosts(chat, c, items, src) {
  const byId = new Map(items.map((x) => [x.id, x]));
  for (const g of [...new Set(items.map((x) => x.mgroup).filter(Boolean))]) {
    for (const s of await db.all(sql`SELECT msg_id AS id FROM cl_posts WHERE chat_id = ${chat} AND mgroup = ${g} AND gone = 0`)) {
      if (!byId.has(s.id)) byId.set(s.id, { id: s.id, body: '', reason: 'آلبوم', kw: null });
    }
  }
  const ids = [...byId.keys()].sort((a, b) => a - b);
  const done = [];
  let old = 0;
  let rate = false;
  for (let i = 0; i < ids.length && !rate; i += 100) {
    const chunk = ids.slice(i, i + 100);
    if (c.backup) {
      const b = await tg('copyMessages', { chat_id: c.backup, from_chat_id: chat, message_ids: chunk, disable_notification: true });
      if (!b.ok) for (const id of chunk) await tg('copyMessage', { chat_id: c.backup, from_chat_id: chat, message_id: id, disable_notification: true });
    }
    const r = await tg('deleteMessages', { chat_id: chat, message_ids: chunk });
    if (r.ok) { done.push(...chunk); continue; }
    if (r.code === 429) { rate = true; break; }
    // one of them can't go: try each, and believe only a real success
    for (const id of chunk) {
      const x = await tg('deleteMessage', { chat_id: chat, message_id: id });
      const d = (x.description || '').toLowerCase();
      if (x.ok) done.push(id);
      else if (x.code === 429) { rate = true; break; }
      else if (d.includes('not found')) await db.run(sql`UPDATE cl_posts SET gone = 1 WHERE chat_id = ${chat} AND msg_id = ${id}`); // already gone
      else if (d.includes("can't be deleted")) {
        old++;
        await db.run(sql`UPDATE cl_posts SET date = 0 WHERE chat_id = ${chat} AND msg_id = ${id}`); // too old from now on
      }
    }
  }
  const hits = {};
  for (const id of done) {
    const x = byId.get(id);
    hits[x.kw] = (hits[x.kw] || 0) + 1;
    await db.run(sql`UPDATE cl_posts SET gone = 1 WHERE chat_id = ${chat} AND msg_id = ${id}`);
    await db.run(sql`INSERT INTO cl_logs (chat_id, msg_id, reason, snip, src, at) VALUES (${chat}, ${id}, ${x.reason}, ${snippet(x.body, 80)}, ${src}, ${now()})`);
  }
  for (const [kw, n] of Object.entries(hits)) {
    if (kw !== 'null' && kw !== 'undefined') await db.run(sql`UPDATE cl_words SET hits = hits + ${n} WHERE id = ${Number(kw)}`);
  }
  if (done.length) {
    const f = await cfg(chat);
    await patchCfg(chat, { deleted: (f.deleted || 0) + done.length });
    await db.run(sql`DELETE FROM cl_logs WHERE chat_id = ${chat} AND id NOT IN (SELECT id FROM cl_logs WHERE chat_id = ${chat} ORDER BY id DESC LIMIT 500)`);
  }
  return { deleted: done.length, old, rate };
}

// ---------- new posts (handlers/channel_post, edited_channel_post) ----------
export async function onChannelPost(m, edited = false) {
  const chat = m.chat.id;
  if (!(await one(sql`SELECT 1 AS x FROM channels WHERE chat_id = ${chat} LIMIT 1`))) return;
  const p = extractPost(m);
  await savePost(chat, m.message_id, p, m.date);
  const c = await cfg(chat);
  if (m.message_id > (c.last || 0)) await patchCfg(chat, { last: m.message_id });
  if (!c.auto) return;
  let hit = null;
  if (p.mediaGroup && (await one(sql`SELECT 1 AS x FROM cl_posts WHERE chat_id = ${chat} AND mgroup = ${p.mediaGroup} AND gone = 1 LIMIT 1`))) {
    hit = { reason: 'آلبوم', keywordId: null };
  } else {
    const matcher = await matcherFor(chat, c);
    if (matcher.empty) return;
    hit = matcher(p);
  }
  if (!hit) return;
  const r = await removePosts(chat, c, [{ id: m.message_id, body: p.body, mgroup: p.mediaGroup, reason: hit.reason, kw: hit.keywordId }], 'auto');
  if (r.deleted && c.notify) {
    await call('sendMessage', { chat_id: store.OWNER_ID, parse_mode: 'HTML', disable_notification: true,
      text: `🛡 یه پست${edited ? ' ویرایش‌شده' : ''} با «<b>${esc(hit.reason)}</b>» از کانال حذف شد.` });
  }
}

// ---------- screens ----------
async function edit(uid, mid, text, kb) {
  kb = kb.filter((r) => r.length);
  if (mid) {
    const r = await call('editMessageText', { chat_id: uid, message_id: mid, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: kb } });
    if (r.ok || /not modified/i.test(r.description || '')) return r;
  }
  return send(uid, text, kb);
}

const myChannels = async (uid) => (await store.user(uid)).channels;

export async function home(uid, mid = null) {
  const chs = await myChannels(uid);
  if (chs.length === 1) return panel(uid, chs[0].id, mid); // one channel: straight to it
  const rows = [];
  for (const ch of chs) {
    const c = await cfg(ch.id);
    rows.push([(c.auto ? G : U)(`${c.auto ? '🛡' : '📢'} ${snippet(ch.title || ch.id, 30)}`, `cf:p:${ch.id}`)]);
  }
  rows.push([B('➕ وصل کردن کانال', 'addch'), B('🔙 برگشت به منو', 'menu')]);
  return edit(uid, mid, `🧹 <b>پاکسازی کانال</b>\n${LINE}\n` + (chs.length ? 'یه کانال انتخاب کن 👇' : '⚠️ اول یه کانال به ربات وصل کن.'), rows);
}

async function rights(chat) {
  const me = (await call('getMe', {})).result?.id;
  const r = await call('getChatMember', { chat_id: chat, user_id: me });
  if (!r.ok) return '⚠️ ربات به این کانال دسترسی نداره.';
  if (r.result.status !== 'administrator') return '⚠️ ربات توی این کانال ادمین نیست.';
  if (r.result.can_delete_messages === false) return '⚠️ ربات دسترسی <b>«حذف پیام‌ها»</b> نداره.';
  return null;
}

/** The one screen: «send the word whose posts should go» + the auto-delete switch. (st.w = cf:quick:<chat>) */
export async function panel(uid, chat, mid = null, note = '') {
  const ch = (await myChannels(uid)).find((x) => String(x.id) === String(chat));
  if (!ch) return home(uid, mid);
  const warn = await rights(chat);
  const c = await cfg(chat);
  const auto = c.auto ? (await words(chat, 'block')).map((w) => `<code>${esc(w.word)}</code>`).join('، ') : '';
  return edit(uid, mid,
    `🧹 <b>پاک کردن پست‌های کانال</b>\n📢 ${esc(ch.title)}\n${LINE}\n` +
    '✍️ <b>کلمه‌ای که می‌خوای پست‌هاش پاک بشن رو همین‌جا بفرست.</b>\n' +
    'مثلاً: <code>روم</code>\n' +
    '💡 فارسی و انگلیسیش با هم پیدا میشه (روم = room = ROOM)\n' +
    '🔒 قبل از پاک کردن، تعداد رو نشونت میدم و ازت اجازه می‌گیرم.\n\n' +
    (c.auto ? `🛡 حذف خودکار: <b>روشن</b> — پست‌های جدیدی که ${auto} دارن، خودکار پاک میشن.`
      : '🛡 حذف خودکار: <b>خاموش</b> — ربات بدون اجازه‌ی تو هیچ پستی رو پاک نمی‌کنه.') +
    (warn ? `\n\n${warn}` : '') + (note ? `\n\n${note}` : ''),
    [
      [c.auto ? R('⛔️ خاموش کردن حذف خودکار', `cf:ao:${chat}`) : G('🛡 روشن کردن حذف خودکار پست‌های جدید', `cf:ai:${chat}`)],
      [B('🔙 برگشت به منو', 'menu')],
    ]);
}

const PAGE = 8;
async function wordList(uid, chat, kind, page, mid) {
  const list = await words(chat, kind);
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const allow = kind === 'allow';
  const rows = list.slice(page * PAGE, page * PAGE + PAGE).map((w) => [
    (allow ? G : U)(`${allow ? '✅' : '🚫'} ${snippet(w.word, 20)}`, `cf:wi:${w.id}`),
    B(`🔁 ${MODE[w.mode] || w.mode}`, `cf:wm:${w.id}:${page}`),
    R('✖️', `cf:wd:${w.id}:${page}`),
  ]);
  if (pages > 1) rows.push([B('◀️', `cf:w:${chat}:${kind}:${page - 1}`), B(`${page + 1}/${pages}`, 'noop'), B('▶️', `cf:w:${chat}:${kind}:${page + 1}`)]);
  rows.push([G(allow ? '➕ افزودن استثنا' : '➕ افزودن کلمه', `cf:wa:${chat}:${kind}`)]);
  if (list.length) rows.push([R('🧹 پاک کردن کل لیست', `cf:wc:${chat}:${kind}`)]);
  rows.push([B('🔙 پنل', `cf:p:${chat}`)]);
  return edit(uid, mid,
    `${allow ? '✅ <b>استثناها</b>' : '🚫 <b>کلمه‌های فیلتر</b>'}\n${LINE}\n` +
    (allow ? 'پستی که یکی از این‌ها رو داشته باشه <b>هیچ‌وقت</b> پاک نمیشه.' : 'هر پستی که یکی از این کلمه‌ها رو داشته باشه پاک میشه.') +
    `\n\n🔁 حالت: <b>خود کلمه</b> (پیش‌فرض: روم، روم‌ها، room، ROOM) ⇄ <b>هر جای متن</b> (حتی وسط کلمه‌های دیگه)`, rows);
}

const ADD_HELP = 'کلمه یا کلمه‌ها رو بفرست؛ چندتا رو خط به خط یا با کاما:\n<code>روم\nپرایز, خیار</code>\n\n' +
  '✨ فارسی و انگلیسیش با هم پیدا میشه: «روم» = room / ROOM / 𝗥𝗢𝗢𝗠 / R00M\n' +
  '✨ با پسوند هم پیدا میشه: روم‌ها، رومای، #روم_امشب — ولی «پرومیشن» نه\n' +
  '🔹 برای «هر جای متن» بین دو ستاره: <code>*روم*</code> · 🔹 Regex: <code>/prize|جایزه/</code>';

/** Delete the posts with the word: the bot deletes the last 48 hours; older ones go with the admin's account. */
async function purge(uid, chat, mid, quick = null, confirmed = false) {
  const c = await cfg(chat);
  const matcher = await matcherFor(chat, c, quick);
  if (matcher.empty) return panel(uid, chat, mid);
  const warn = await rights(chat);
  if (warn) return panel(uid, chat, mid, warn);
  const { fresh, old } = await collect(chat, matcher);
  if (!confirmed) {
    // nothing is deleted yet: show what was found and ask
    const w = esc(quick?.word || '');
    if (!fresh.length && !old) {
      return edit(uid, mid,
        `🔎 <b>«${w}»</b>\n${LINE}\n✨ پستی با این کلمه پیدا نکردم.\nاگه پست‌های خیلی قدیمی داری، با دکمه‌ی زیر کل کانال رو بگرد 👇\n\n✍️ برای یه کلمه‌ی دیگه، همین الان بفرستش.`,
        [[FULL(chat, quick?.word, '🔐 گشتن کل کانال (پست‌های قدیمی)')], [B('🔙 برگشت به منو', 'menu')]]);
    }
    return edit(uid, mid,
      `🔎 <b>«${w}»</b>\n${LINE}\n` +
      (fresh.length ? `🆕 <b>${fmt(fresh.length)}</b> پست از ۲ روز اخیر\n` : '') +
      (old ? `📦 <b>${fmt(old)}</b> پست قدیمی‌تر\n` : '') +
      '\n❓ <b>پاک کنم؟</b>' +
      (old ? '\n\n💡 پست‌های قدیمی رو تلگرام فقط به خودت اجازه میده پاک کنی؛ دکمه‌ی 🔐 صفحه‌ش رو باز می‌کنه.' : ''),
      [
        fresh.length ? [R(`🗑 آره، ${fmt(fresh.length)} پست رو پاک کن`, `cf:qy:${chat}`)] : [],
        old ? [FULL(chat, quick?.word, `🔐 پاک کردن ${fmt(old)} پست قدیمی`)] : [],
        [G('❌ نه، پاک نکن', `cf:p:${chat}`)],
      ]);
  }
  const r = fresh.length ? await removePosts(chat, c, fresh, quick ? 'quick' : 'purge') : { deleted: 0, old: 0, rate: false };
  const tooOld = old + r.old;
  const word = quick?.word || '';
  return edit(uid, mid,
    `🔎 <b>«${esc(word)}»</b>\n${LINE}\n` +
    (r.deleted ? `✅ <b>${fmt(r.deleted)}</b> پست پاک شد.\n` : '') +
    (r.rate ? '⏳ تلگرام چند ثانیه صبر خواست؛ دوباره همون کلمه رو بفرست.\n' : '') +
    (tooOld
      ? `\n📦 <b>${fmt(tooOld)}</b> پست قدیمی‌تر هم پیدا شد.\nتلگرام اجازه نمیده ربات پست‌های قدیمی (بیشتر از ۲ روز) رو پاک کنه؛ با دکمه‌ی قرمز زیر <b>خودت</b> پاکشون کن 👇\n`
      : !r.deleted ? '✨ پستی با این کلمه پیدا نکردم.\nاگه پست‌های خیلی قدیمی داری، با دکمه‌ی زیر کل کانال رو بگرد 👇\n' : '') +
    '\n✍️ برای یه کلمه‌ی دیگه، همین الان بفرستش.',
    [
      [FULL(chat, word, tooOld ? `🔐 پاک کردن ${fmt(tooOld)} پست قدیمی` : '🔐 گشتن کل کانال (پست‌های قدیمی)')],
      [B('🔙 برگشت به منو', 'menu')],
    ]);
}

// ---------- 🧽 blanking old posts (they can't be deleted, but they can be edited) ----------
// settings 'cl_blank' = { chat, uid, mid, quick, done, skipped, total }
const BLANK_BUDGET = 12000; // the heartbeat may add a slice right after
const getBlank = async () => JSON.parse((await store.getSetting('cl_blank')) || 'null');
const setBlank = (j) => store.setSetting('cl_blank', j ? JSON.stringify(j) : null);

/** Turn one post into «🗑». -> 'done' | 'gone' | 'skip' | 'rate' */
async function blankOne(chat, id) {
  let r = await tg('editMessageText', { chat_id: chat, message_id: id, text: '🗑' });
  if (r.ok) return 'done';
  let d = (r.description || '').toLowerCase();
  if (r.code === 429) return 'rate';
  if (d.includes('not modified')) return 'done';
  if (d.includes('not found')) return 'gone';
  if (!d.includes('no text')) return 'skip'; // a sticker, a poll, a service message…
  // a photo / video / file: swap it for the trash-can picture
  const cached = await store.getSetting('cl_blank_photo');
  const media = { type: 'photo', media: cached || new InputFile(blankPng(), 'deleted.png', { type: 'image/png' }), caption: '🗑' };
  r = await tg('editMessageMedia', { chat_id: chat, message_id: id, media });
  if (r.ok) {
    if (!cached && r.result?.photo?.length) await store.setSetting('cl_blank_photo', r.result.photo[r.result.photo.length - 1].file_id);
    return 'done';
  }
  if (r.code === 429) return 'rate';
  d = (r.description || '').toLowerCase();
  if (d.includes('not modified')) return 'done';
  // an album item may only become the same kind: at least empty its caption
  r = await tg('editMessageCaption', { chat_id: chat, message_id: id, caption: '🗑' });
  if (r.code === 429) return 'rate';
  return r.ok || /not modified/i.test(r.description || '') ? 'done' : 'skip';
}

/** One slice of the blanking job; updates its progress message. Buttons and the heartbeat call it. */
export async function blankTick(budget = BLANK_BUDGET) {
  const j = await getBlank();
  if (!j) return;
  const t0 = Date.now();
  const lock = (await db.run(sql`INSERT INTO settings (k, v) VALUES ('cl_blank_lock', ${String(now())})
    ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE CAST(settings.v AS INTEGER) < ${now() - 40} RETURNING v`)).rows[0];
  if (!lock) return blankMessage(j, false);
  let finished = false;
  let rate = false;
  try {
    const c = await cfg(j.chat);
    const { oldItems } = await collect(j.chat, await matcherFor(j.chat, c, j.quick));
    if (!oldItems.length) finished = true;
    for (const x of oldItems) {
      if (Date.now() - t0 > budget) break;
      const res = await blankOne(j.chat, x.id);
      if (res === 'rate') { rate = true; break; }
      await db.run(sql`UPDATE cl_posts SET gone = ${res === 'skip' ? 2 : 1} WHERE chat_id = ${j.chat} AND msg_id = ${x.id}`);
      if (res === 'done') {
        j.done++;
        await db.run(sql`INSERT INTO cl_logs (chat_id, msg_id, reason, snip, src, at) VALUES (${j.chat}, ${x.id}, ${x.reason}, ${snippet(x.body, 80)}, 'blank', ${now()})`);
      } else if (res === 'skip') j.skipped++;
    }
    if (!finished) finished = !(await collect(j.chat, await matcherFor(j.chat, c, j.quick))).oldItems.length;
  } finally {
    const cur = await getBlank();
    if (cur) await setBlank(finished ? null : { ...j, mid: cur.mid }); // a stop meanwhile wins
    await store.setSetting('cl_blank_lock', '0');
  }
  if (finished || (await getBlank())) await blankMessage(j, finished, rate);
}

async function blankMessage(j, finished, rate = false) {
  const left = Math.max(0, j.total - j.done - j.skipped);
  const text = `🧽 <b>خالی کردن پست‌های قدیمی</b>\n${LINE}\n` +
    `${progressBar(j.done + j.skipped, j.total)}  <b>${Math.floor(((j.done + j.skipped) / Math.max(j.total, 1)) * 100)}%</b>\n` +
    `✅ خالی شد: <b>${fmt(j.done)}</b> از ${fmt(j.total)}\n` + (j.skipped ? `⏭ قابل ویرایش نبود (استیکر، نظرسنجی…): ${fmt(j.skipped)}\n` : '') +
    (finished ? '\n✅ <b>تموم شد!</b>' : rate ? '\n⏳ تلگرام سرعت ویرایش رو محدود کرد؛ چند ثانیه دیگه «ادامه» رو بزن (یا خودش با پیام بعدی ادامه میده).' : `\n⏳ باقی‌مونده: ${fmt(left)} — «ادامه» رو بزن (یا خودش کم‌کم ادامه میده).`);
  const kb = finished ? [[B('📊 گزارش', `cf:st:${j.chat}`), B('🔙 پنل', `cf:p:${j.chat}`)]]
    : [[G('▶️ ادامه', `cf:blg:${j.chat}`), R('⏹ توقف', `cf:bls:${j.chat}`)]];
  const r = j.mid && (await call('editMessageText', { chat_id: j.uid, message_id: j.mid, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } }));
  if (!r || (!r.ok && !/not modified/i.test(r.description || ''))) {
    const s = await send(j.uid, text, kb);
    const cur = await getBlank();
    if (s.ok && cur) await setBlank({ ...cur, mid: s.result.message_id });
  }
}

const progressBar = (done, total, width = 12) => {
  const f = total ? Math.max(0, Math.min(width, Math.round((done / total) * width))) : 0;
  return '▰'.repeat(f) + '▱'.repeat(width - f);
};

async function blankAsk(uid, chat, mid, quick) {
  const c = await cfg(chat);
  const { oldItems } = await collect(chat, await matcherFor(chat, c, quick));
  if (!oldItems.length) return panel(uid, chat, mid, '✨ پست قدیمیِ مطابقی نمونده.');
  return edit(uid, mid,
    `🧽 <b>خالی کردن پست‌های قدیمی</b>\n${LINE}\n<b>${fmt(oldItems.length)}</b> پست قدیمی ${quick ? `با «<b>${esc(quick.word)}</b>»` : 'با کلمه‌های فیلتر'} پیدا شد.\n\n` +
    'متن هر کدوم میشه «🗑» و عکس/ویدیوش میشه یه عکس سطل‌زباله. پست توی کانال می‌مونه ولی چیزی ازش باقی نمی‌مونه.\n\n❗️ برگشت‌پذیر نیست.',
    [[R(`🧽 آره، ${fmt(oldItems.length)} پست خالی بشه`, `cf:bly:${chat}${quick ? ':q' : ''}`)], [G('❌ نه', `cf:p:${chat}`)]]);
}

async function stats(uid, chat, mid) {
  const c = await cfg(chat);
  const src = Object.fromEntries((await db.all(sql`SELECT src, count(*) AS n FROM cl_logs WHERE chat_id = ${chat} GROUP BY src`)).map((r) => [r.src, r.n]));
  const top = (await db.all(sql`SELECT word, hits FROM cl_words WHERE chat_id = ${chat} AND kind = 'block' AND hits > 0 ORDER BY hits DESC LIMIT 6`))
    .map((w, i) => `${i + 1}. <b>${esc(snippet(w.word, 20))}</b> — ${fmt(w.hits)}`).join('\n');
  const logs = (await db.all(sql`SELECT * FROM cl_logs WHERE chat_id = ${chat} ORDER BY id DESC LIMIT 8`))
    .map((l) => `${{ purge: '🗑', auto: '🛡', quick: '🧨', blank: '🧽' }[l.src] || '•'} «${esc(snippet(l.reason, 15))}» ${esc(snippet(l.snip, 30))}`).join('\n');
  return edit(uid, mid,
    `📊 <b>گزارش</b>\n${LINE}\n🗑 کل حذف‌ها: <b>${fmt(c.deleted)}</b>\n   🛡 خودکار: ${fmt(src.auto)} · 🗑 پاکسازی: ${fmt(src.purge)} · 🧨 با یه کلمه: ${fmt(src.quick)}\n🧽 پست قدیمی خالی‌شده: <b>${fmt(src.blank)}</b>\n\n` +
    (top ? `🏆 <b>بیشترین حذف:</b>\n${top}\n\n` : '') + (logs ? `🧾 <b>آخرین حذف‌ها:</b>\n${logs}` : '<i>هنوز چیزی حذف نشده.</i>'),
    [[B('🔄 بروزرسانی', `cf:st:${chat}`), B('🔙 پنل', `cf:p:${chat}`)]]);
}

async function backupPanel(uid, chat, mid) {
  const c = await cfg(chat);
  return edit(uid, mid,
    `🗄 <b>پشتیبان قبل از حذف</b>\n${LINE}\nاگه روشن باشه، قبل از حذف یه کپی از پست به مقصد پشتیبان فرستاده میشه.\n\n` +
    `الان: <b>${c.backup ? `روشن → <code>${c.backup}</code>` : 'خاموش'}</b>\n\nبرای کانال آرشیو: ربات رو اونجا ادمین کن و یه پیام ازش برام فوروارد کن.`,
    [
      [G('👤 پیوی خودم', `cf:bp:${chat}`), U('📦 کانال آرشیو', `cf:bc:${chat}`)],
      c.backup ? [R('⛔️ خاموش کردن پشتیبان', `cf:bx:${chat}`)] : [],
      [B('🔙 پنل', `cf:p:${chat}`)],
    ]);
}

const HELP = `❓ <b>پاکسازی کانال چطور کار می‌کنه؟</b>\n${LINE}\n` +
  '1️⃣ کلمه‌ها رو اضافه کن (مثلاً روم، پرایز).\n' +
  '2️⃣ از اون لحظه هر پست جدیدی که اون کلمه‌ها رو داشته باشه، خودکار و فوری از کانال حذف میشه.\n' +
  '3️⃣ «الان پاکسازی کن» پست‌های ۴۸ ساعت اخیر رو هم پاک می‌کنه.\n\n' +
  '🧠 <b>تشخیص پست‌های روم</b>: پست‌هایی که ساعت، مپ، جایزه/یوسی، ID و Pass و… دارن رو حتی بدون کلمه‌ی «روم» تشخیص میده.\n\n' +
  '⛔️ <b>پست‌های قدیمی‌تر از ۴۸ ساعت</b>: قانون خود تلگرامه که هیچ رباتی (حتی ادمین) نمی‌تونه پیام‌های قدیمی‌تر از ۴۸ ساعت رو <b>حذف</b> کنه؛ ' +
  'ولی:\n🔐 «حذف کامل» با اکانت خودت (توی مینی‌اپ، روی گوشی خودت) همه رو واقعاً پاک می‌کنه و آخرش از اکانتت خارج میشه؛\n🧽 «خالی کردن» با ربات متنشون رو «🗑» و عکسشون رو سطل‌زباله می‌کنه.';

// ---------- buttons ----------
export async function action(uid, st, data, mid) {
  const [, act, a, b, c3] = data.split(':');
  st.w = null;
  if (!act || act === 'h') {
    const chs = await myChannels(uid);
    if (chs.length === 1) st.w = `cf:quick:${chs[0].id}`; // one channel: straight to «send the word»
    return home(uid, mid);
  }

  if (act === 'wi' || act === 'wm' || act === 'wd') {
    const w = await one(sql`SELECT * FROM cl_words WHERE id = ${Number(a)}`);
    if (!w) return home(uid, mid);
    if (act === 'wi') {
      const vs = w.mode === 'regex' ? [w.word] : variants(w.word);
      return send(uid, `«${esc(w.word)}» — ${MODE[w.mode]} — ${fmt(w.hits)} حذف\nپیدا میشه: ${vs.map((v) => `<code>${esc(v)}</code>`).join('، ')}`, [[B('🔙 لیست', `cf:w:${w.chat_id}:${w.kind}:0`)]]);
    }
    if (act === 'wm' && w.mode !== 'regex') await db.run(sql`UPDATE cl_words SET mode = ${w.mode === 'contains' ? 'word' : 'contains'} WHERE id = ${w.id}`);
    if (act === 'wd') await db.run(sql`DELETE FROM cl_words WHERE id = ${w.id}`);
    return wordList(uid, w.chat_id, w.kind, Number(b) || 0, mid);
  }

  const chat = Number(a);
  if (!(await myChannels(uid)).some((x) => String(x.id) === String(chat))) return home(uid, mid);

  switch (act) {
    case 'p':
      st.w = `cf:quick:${chat}`;
      return panel(uid, chat, mid);
    case 'qy': // «آره، پاک کن» — the only way a word's posts get deleted
      st.w = `cf:quick:${chat}`;
      if (!st.clq || st.clq.chat !== chat) return panel(uid, chat, mid, '⌛️ دوباره کلمه رو بفرست.');
      return purge(uid, chat, mid, st.clq, true);
    case 'ai': // turning auto-delete on: which words?
      st.w = `cf:auto:${chat}`;
      return edit(uid, mid,
        `🛡 <b>روشن کردن حذف خودکار</b>\n${LINE}\nکلمه‌هایی که می‌خوای <b>پست‌های جدیدِ</b> دارای اون‌ها، همون لحظه‌ی انتشار خودکار پاک بشن رو بفرست (هر خط یکی).\n\nمثلاً: <code>روم</code>\n\n⚠️ پست‌هایی که الان توی کانال هستن دست نمی‌خورن.`,
        [[G('❌ نه، خاموش بمونه', `cf:p:${chat}`)]]);
    case 'ao': // turning auto-delete off
      await patchCfg(chat, { auto: false });
      await db.run(sql`DELETE FROM cl_words WHERE chat_id = ${chat} AND kind = 'block'`);
      st.w = `cf:quick:${chat}`;
      return panel(uid, chat, mid, '⛔️ حذف خودکار خاموش شد.');
    case 'w': return wordList(uid, chat, b === 'allow' ? 'allow' : 'block', Number(c3) || 0, mid);
    case 'wa':
      st.w = `cf:add:${chat}:${b === 'allow' ? 'allow' : 'block'}`;
      return edit(uid, mid, `✍️ <b>${b === 'allow' ? 'افزودن استثنا' : 'افزودن کلمه'}</b>\n${LINE}\n${ADD_HELP}`, [[R('❌ لغو', `cf:p:${chat}`)]]);
    case 'wc':
      return edit(uid, mid, '⚠️ کل لیست پاک بشه؟', [[R('🧹 آره، پاک کن', `cf:wcy:${chat}:${b}`), G('❌ نه', `cf:w:${chat}:${b}:0`)]]);
    case 'wcy':
      await db.run(sql`DELETE FROM cl_words WHERE chat_id = ${chat} AND kind = ${b === 'allow' ? 'allow' : 'block'}`);
      return wordList(uid, chat, b, 0, mid);
    case 'pg': return purge(uid, chat, mid);
    case 'bl': return blankAsk(uid, chat, mid, b === 'q' ? st.clq : null);
    case 'bly': {
      const quick = b === 'q' ? st.clq : null;
      if (b === 'q' && !quick) return panel(uid, chat, mid, '⌛️ وقتش تموم شد؛ دوباره کلمه رو بفرست.');
      const cur = await getBlank();
      if (cur && cur.chat !== chat) return panel(uid, chat, mid, '⏳ یه کار خالی‌کردن دیگه در جریانه.');
      const { oldItems } = await collect(chat, await matcherFor(chat, await cfg(chat), quick));
      await setBlank({ chat, uid, mid, quick: quick ? { word: quick.word, mode: quick.mode, smart: !!quick.smart } : null, done: 0, skipped: 0, total: oldItems.length });
      return blankTick();
    }
    case 'blg': {
      const j = await getBlank();
      if (!j) return panel(uid, chat, mid, '✅ کاری در جریان نیست.');
      await setBlank({ ...j, mid });
      return blankTick();
    }
    case 'bls':
      await setBlank(null);
      return panel(uid, chat, mid, '⏹ متوقف شد.');
    case 'q':
      st.w = `cf:quick:${chat}`;
      return edit(uid, mid, `🧨 <b>حذف با یه کلمه</b>\n${LINE}\nکلمه رو بفرست؛ همون لحظه همه‌ی پست‌هایی که این کلمه رو دارن پاک میشن (فارسی و انگلیسیش با هم).`, [[R('❌ لغو', `cf:p:${chat}`)]]);
    case 'qs': {
      if (!st.clq || st.clq.chat !== chat) return panel(uid, chat, mid);
      const exists = (await words(chat, 'block')).some((w) => normalize(w.word) === normalize(st.clq.word));
      if (!exists) await db.run(sql`INSERT INTO cl_words (chat_id, word, mode, kind, hits) VALUES (${chat}, ${st.clq.word}, ${st.clq.mode}, 'block', 0)`);
      st.clq = null;
      return panel(uid, chat, mid, '✅ اضافه شد؛ از این به بعد خودکار فیلتر میشه.');
    }
    case 't': {
      if (!['auto', 'smart', 'links', 'fwd', 'notify'].includes(b)) return panel(uid, chat, mid);
      const c = await cfg(chat);
      await patchCfg(chat, { [b]: !c[b] });
      return panel(uid, chat, mid);
    }
    case 'bk': return backupPanel(uid, chat, mid);
    case 'bp': await patchCfg(chat, { backup: uid }); return backupPanel(uid, chat, mid);
    case 'bx': await patchCfg(chat, { backup: null }); return backupPanel(uid, chat, mid);
    case 'bc':
      st.w = `cf:bkch:${chat}`;
      return edit(uid, mid, '📦 یه پیام از <b>کانال آرشیو</b> رو برام فوروارد کن (ربات باید اونجا ادمین باشه).', [[R('❌ لغو', `cf:bk:${chat}`)]]);
    case 'ts':
      st.w = `cf:test:${chat}`;
      return edit(uid, mid, '🧪 یه متن (یا یه پست فورواردی) بفرست تا ببینی با تنظیمات الان پاک میشه یا نه.', [[B('🔙 پنل', `cf:p:${chat}`)]]);
    case 'st': return stats(uid, chat, mid);
    case 'hp': return edit(uid, mid, HELP, [[B('🔙 پنل', `cf:p:${chat}`)]]);
    default: return panel(uid, chat, mid);
  }
}

// ---------- typed input (st.w = cf:…) -> true when handled ----------
export async function input(uid, st, m) {
  const [, what, a, kind] = st.w.split(':');
  const chat = Number(a);
  const t = (m.text || m.caption || '').trim();
  if (what === 'add') {
    const items = parseKeywordInput(t);
    const bad = items.find((i) => i.mode === 'regex' && regexError(i.word));
    if (!items.length || bad) {
      await send(uid, bad ? `⚠️ Regex درست نیست: <code>${esc(bad.word)}</code>` : '⚠️ یه کلمه بفرست.', [[R('❌ لغو', `cf:p:${chat}`)]]);
      return true;
    }
    const have = new Set((await words(chat, kind)).map((w) => normalize(w.word)));
    let added = 0;
    for (const it of items) {
      if (have.has(normalize(it.word))) continue;
      have.add(normalize(it.word));
      await db.run(sql`INSERT INTO cl_words (chat_id, word, mode, kind, hits) VALUES (${chat}, ${it.word}, ${it.mode}, ${kind}, 0)`);
      added++;
    }
    st.w = null;
    // «روم» → offer the smart room detection too
    const c = await cfg(chat);
    const roomish = kind === 'block' && !c.smart && items.some((i) => ['روم', 'room'].includes(normalize(i.word)));
    if (kind !== 'block') {
      await send(uid, `✅ <b>${added}</b> استثنا اضافه شد.`, [[B('🔙 پنل', `cf:p:${chat}`)]]);
      return true;
    }
    await purge(uid, chat, null); // added → cleaned right away, no extra step
    if (roomish) {
      await send(uid, '🧠 پست‌های مربوط به روم که خود کلمه‌ی «روم» رو ندارن (ساعت، مپ، جایزه، ID و Pass…) هم تشخیص بدم و حذف کنم؟',
        [[G('✅ آره، روشن کن', `cf:t:${chat}:smart`), B('نه', `cf:p:${chat}`)]]);
    }
    return true;
  }
  if (what === 'auto') {
    const items = parseKeywordInput(t).filter((i) => i.mode !== 'regex' || !regexError(i.word));
    if (!items.length) {
      await send(uid, '✍️ یه کلمه بفرست، مثلاً: <code>روم</code>', [[G('❌ نه، خاموش بمونه', `cf:p:${chat}`)]]);
      return true;
    }
    await db.run(sql`DELETE FROM cl_words WHERE chat_id = ${chat} AND kind = 'block'`);
    for (const it of items) await db.run(sql`INSERT INTO cl_words (chat_id, word, mode, kind, hits) VALUES (${chat}, ${it.word}, ${it.mode}, 'block', 0)`);
    await patchCfg(chat, { auto: true });
    st.w = `cf:quick:${chat}`;
    await panel(uid, chat, null, '✅ حذف خودکار روشن شد.');
    return true;
  }
  if (what === 'quick') {
    const [it] = parseKeywordInput(t);
    if (!it || (it.mode === 'regex' && regexError(it.word))) {
      await send(uid, '✍️ یه کلمه بفرست، مثلاً: <code>روم</code>', [[B('🔙 برگشت به منو', 'menu')]]);
      return true;
    }
    st.w = `cf:quick:${chat}`; // ready for the next word right away
    st.clq = { chat, word: it.word, mode: it.mode };
    await purge(uid, chat, null, st.clq);
    return true;
  }
  if (what === 'test') {
    const ws = await words(chat);
    const c = await cfg(chat);
    const p = extractPost(m);
    const norm = normalize(p.body);
    const hitB = ws.filter((w) => w.kind !== 'allow' && compileKeyword(w)(norm, p.body)).map((w) => `<b>${esc(w.word)}</b>`);
    const hitA = ws.filter((w) => w.kind === 'allow' && compileKeyword(w)(norm, p.body)).map((w) => `<b>${esc(w.word)}</b>`);
    const v = buildMatcher({ ruleLinks: c.links, ruleForward: c.fwd, smartRoom: c.smart }, ws)(p);
    await send(uid, `🧪 <b>نتیجه‌ی تست</b>\n${LINE}\n🚫 کلمه‌های پیدا‌شده: ${hitB.join('، ') || '—'}\n✅ استثناها: ${hitA.join('، ') || '—'}\n\n` +
      (v ? `🔴 <b>این پست پاک میشه</b> (دلیل: ${esc(v.reason)})` : '🟢 <b>این پست پاک نمیشه</b>') + '\n\nیه متن دیگه بفرست یا برگرد.',
    [[B('🔙 پنل', `cf:p:${chat}`)]]);
    return true; // stay in test mode
  }
  if (what === 'bkch') {
    const fc = m.forward_from_chat || m.forward_origin?.chat;
    if (!fc) {
      await send(uid, '↪️ یه پیام از کانال آرشیو رو <b>فوروارد</b> کن.', [[R('❌ لغو', `cf:bk:${chat}`)]]);
      return true;
    }
    const r = await call('sendMessage', { chat_id: fc.id, text: '🗄 این کانال آرشیو پشتیبانِ پاکسازی شد.', disable_notification: true });
    if (!r.ok) {
      await send(uid, '⚠️ ربات نمی‌تونه توی اون کانال پیام بفرسته؛ اول ربات رو اونجا ادمین کن.', [[R('❌ لغو', `cf:bk:${chat}`)]]);
      return true;
    }
    st.w = null;
    await patchCfg(chat, { backup: fc.id });
    await backupPanel(uid, chat, null);
    return true;
  }
  return false; // cf:qr — a typed message just goes on as usual
}



/** A kept Mini App login whose time is up: send its owner a «🔒 log out now» button (once). */
export async function sessionTick() {
  const all = JSON.parse((await store.getSetting('cl_sess')) || 'null');
  if (!all) return;
  let changed = false;
  for (const [uid, x] of Object.entries(all)) {
    if (x.told || x.until > now()) continue;
    x.told = true;
    changed = true;
    await send(Number(uid), '⏰ <b>مهلت ورود به اکانتت تموم شد.</b>\n\nصفحه‌ی «حذف کامل» بسته بود، برای همین هنوز خارج نشدم. این دکمه رو بزن تا همین الان از اکانتت خارج بشم:',
      [[{ text: '🔒 خروج از اکانتم', web_app: { url: `https://app8719466331.tgcloud.ai/clean?c=${x.chat}&logout=1` }, style: 'danger' }]]);
  }
  if (changed) await store.setSetting('cl_sess', JSON.stringify(all));
}

// ---------- 🕒 posts that delete themselves (chosen in a post's preview) ----------
// settings 'cl_timed' = [{ c: chat, m: [message ids], at: unix time }]
const MAX_AFTER = 47 * 3600; // a bot may delete only within 48 hours

/** Plan the deletion of a post the bot just sent, `hours` from now. */
export async function planDelete(chat, ids, hours) {
  const list = JSON.parse((await store.getSetting('cl_timed')) || '[]');
  list.push({ c: Number(chat), m: ids, at: now() + Math.min(Number(hours) * 3600, MAX_AFTER) });
  await store.setSetting('cl_timed', JSON.stringify(list.slice(-500)));
}

/** Delete the planned posts whose time has come (from the heartbeat and the cron). */
export async function timedTick() {
  const list = JSON.parse((await store.getSetting('cl_timed')) || 'null');
  if (!list?.length) return;
  const due = list.filter((x) => x.at <= now());
  if (!due.length) return;
  await store.setSetting('cl_timed', JSON.stringify(list.filter((x) => x.at > now()))); // claim them first
  for (const x of due) {
    const r = await tg('deleteMessages', { chat_id: x.c, message_ids: x.m });
    if (!r.ok) for (const id of x.m) await tg('deleteMessage', { chat_id: x.c, message_id: id });
    for (const id of x.m) await db.run(sql`UPDATE cl_posts SET gone = 1 WHERE chat_id = ${x.c} AND msg_id = ${id}`);
  }
}
