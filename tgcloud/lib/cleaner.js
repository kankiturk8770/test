// 🧹 Channel cleaner: delete every post (old and new) that contains a word the admin chooses.
//
// The Bot API can't search a channel's history, so the bot reads the archive itself: it forwards each
// message id to the admin's chat for a moment (silently), reads the text, deletes the copy, and deletes
// the original if it matches. Every post it reads is kept in cl_posts, so later words are instant.
// Long jobs run a slice per call: right away from the button, then from the every-minute cron
// (endpoints/tick), with a "continue" button as a fallback.
//
// Callback data: cf:<act>:<chat>[:arg]   ·   waiting states: st.w = cf:<what>:<chat>
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { esc, call, send, now, LINE } from './util.js';
import * as store from './store.js';
import { buildMatcher, extractPost, normalize, compileKeyword, parseKeywordInput, regexError, snippet, progressBar } from './cleantext.js';

const BUDGET = 20000; // ms of work per slice (a run has ~30 s)
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
const MODE = { contains: 'شامل', word: 'کلمه کامل', regex: 'Regex' };

// ---------- per-channel settings (in the settings table) ----------
const DEF = { auto: true, links: false, fwd: false, notify: true, backup: null, last: 0, deleted: 0, scanned: 0 };
export async function cfg(chat) {
  return { ...DEF, ...JSON.parse((await store.getSetting(`cl:${chat}`)) || '{}') };
}
async function saveCfg(chat, c) {
  await store.setSetting(`cl:${chat}`, JSON.stringify(c));
}
async function patchCfg(chat, patch) {
  const c = { ...(await cfg(chat)), ...patch };
  await saveCfg(chat, c);
  return c;
}
async function bumpLast(chat, id) {
  const c = await cfg(chat);
  if (id > (c.last || 0)) await saveCfg(chat, { ...c, last: id });
}

// ---------- data ----------
const words = (chat, kind) => kind
  ? db.all(sql`SELECT * FROM cl_words WHERE chat_id = ${chat} AND kind = ${kind} ORDER BY id`)
  : db.all(sql`SELECT * FROM cl_words WHERE chat_id = ${chat} ORDER BY id`);

async function savePost(chat, msgId, p) {
  await db.run(sql`INSERT INTO cl_posts (chat_id, msg_id, body, mgroup, fwd, link, gone)
    VALUES (${chat}, ${msgId}, ${p.body || ''}, ${p.mediaGroup || null}, ${p.isForward ? 1 : 0}, ${p.hasLink ? 1 : 0}, 0)
    ON CONFLICT(chat_id, msg_id) DO UPDATE SET body = excluded.body, fwd = excluded.fwd, link = excluded.link,
      mgroup = coalesce(excluded.mgroup, cl_posts.mgroup)`);
}

async function postStats(chat) {
  const r = await one(sql`SELECT count(*) AS total, sum(CASE WHEN gone = 0 THEN 1 ELSE 0 END) AS alive, max(msg_id) AS maxId
    FROM cl_posts WHERE chat_id = ${chat}`);
  return { total: r?.total || 0, alive: r?.alive || 0, maxId: r?.maxId || 0 };
}

async function matcherFor(chat, c, quick) {
  if (quick) return buildMatcher({}, [{ id: null, word: quick.word, mode: quick.mode, kind: 'block' }]);
  return buildMatcher({ ruleLinks: c.links, ruleForward: c.fwd }, await words(chat));
}

/** Every live indexed post that matches. */
async function collect(chat, matcher, limit = 100000) {
  const out = [];
  let after = 0;
  for (;;) {
    const page = await db.all(sql`SELECT msg_id AS id, body, mgroup, fwd, link FROM cl_posts
      WHERE chat_id = ${chat} AND gone = 0 AND msg_id > ${after} ORDER BY msg_id LIMIT 500`);
    for (const p of page) {
      const m = matcher({ body: p.body, hasLink: !!p.link, isForward: !!p.fwd });
      if (m) out.push({ id: p.id, body: p.body, mgroup: p.mgroup, reason: m.reason, kw: m.keywordId });
      if (out.length >= limit) return out;
    }
    if (page.length < 500) return out;
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

/** Back up (optional) and delete posts, their album siblings too. -> { deleted, rate } */
async function removePosts(chat, c, items, src) {
  const byId = new Map(items.map((x) => [x.id, x]));
  const groups = [...new Set(items.map((x) => x.mgroup).filter(Boolean))];
  for (const g of groups) {
    for (const s of await db.all(sql`SELECT msg_id AS id FROM cl_posts WHERE chat_id = ${chat} AND mgroup = ${g} AND gone = 0`)) {
      if (!byId.has(s.id)) byId.set(s.id, { id: s.id, body: '', reason: 'آلبوم', kw: null });
    }
  }
  const ids = [...byId.keys()].sort((a, b) => a - b);
  let deleted = 0;
  const hits = {};
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    if (c.backup) {
      const b = await tg('copyMessages', { chat_id: c.backup, from_chat_id: chat, message_ids: chunk, disable_notification: true });
      if (!b.ok) for (const id of chunk) await tg('copyMessage', { chat_id: c.backup, from_chat_id: chat, message_id: id, disable_notification: true });
    }
    let r = await tg('deleteMessages', { chat_id: chat, message_ids: chunk });
    let done = chunk;
    if (!r.ok) {
      if (r.code === 429) return { deleted, rate: true, hits };
      if (/rights|not enough|admin/i.test(r.description || '')) throw new Error('NO_RIGHTS');
      done = [];
      for (const id of chunk) {
        r = await tg('deleteMessage', { chat_id: chat, message_id: id });
        if (r.ok || r.code === 400) done.push(id); // 400 = already gone
        else if (r.code === 429) break;
      }
    }
    for (const id of done) {
      await db.run(sql`UPDATE cl_posts SET gone = 1 WHERE chat_id = ${chat} AND msg_id = ${id}`);
      const x = byId.get(id);
      hits[x.kw] = (hits[x.kw] || 0) + 1;
      await db.run(sql`INSERT INTO cl_logs (chat_id, msg_id, reason, snip, src, at)
        VALUES (${chat}, ${id}, ${x.reason}, ${snippet(x.body, 80)}, ${src}, ${now()})`);
    }
    deleted += done.length;
  }
  for (const [kw, n] of Object.entries(hits)) {
    if (kw !== 'null' && kw !== 'undefined') await db.run(sql`UPDATE cl_words SET hits = hits + ${n} WHERE id = ${Number(kw)}`);
  }
  if (deleted) {
    const fresh = await cfg(chat);
    await saveCfg(chat, { ...fresh, deleted: (fresh.deleted || 0) + deleted });
    await db.run(sql`DELETE FROM cl_logs WHERE chat_id = ${chat} AND id NOT IN
      (SELECT id FROM cl_logs WHERE chat_id = ${chat} ORDER BY id DESC LIMIT 500)`);
  }
  return { deleted, rate: false, hits };
}

// ---------- live posts (handlers/channel_post, edited_channel_post) ----------
export async function onChannelPost(m, edited = false) {
  const chat = m.chat.id;
  const known = await one(sql`SELECT 1 AS x FROM channels WHERE chat_id = ${chat} LIMIT 1`);
  if (!known) return;
  const p = extractPost(m);
  await savePost(chat, m.message_id, p);
  await bumpLast(chat, m.message_id);
  const c = await cfg(chat);
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
    const title = (await one(sql`SELECT title FROM channels WHERE chat_id = ${chat} LIMIT 1`))?.title || chat;
    await call('sendMessage', {
      chat_id: store.OWNER_ID, parse_mode: 'HTML', disable_notification: true,
      text: `🛡 <b>حذف خودکار</b>${edited ? ' (پست ویرایش‌شده)' : ''}\n📢 ${esc(title)}\n🔎 دلیل: <b>${esc(hit.reason)}</b>\n📝 ${esc(snippet(p.body, 120)) || '<i>(بدون متن)</i>'}`,
    });
  }
}

// ---------- background job: scan the archive (and delete matches) / purge from the index ----------
// settings 'cl_job' = { type: 'scan'|'purge', chat, uid, mid, next, to, read, deleted, del: bool, quick: {word, mode}|null, done }
const getJob = async () => JSON.parse((await store.getSetting('cl_job')) || 'null');
const setJob = (j) => store.setSetting('cl_job', j ? JSON.stringify(j) : null);

async function lock() {
  const t = now();
  const won = (await db.run(sql`INSERT INTO settings (k, v) VALUES ('cl_lock', ${String(t)})
    ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE CAST(settings.v AS INTEGER) < ${t - 45} RETURNING v`)).rows[0];
  return !!won;
}
const unlock = () => store.setSetting('cl_lock', '0');

/** Read one archive message by forwarding it to the admin's chat. -> post | null | throws 'STOP:<why>' */
async function readArchive(chat, id, uid, copies) {
  const r = await tg('forwardMessage', { chat_id: uid, from_chat_id: chat, message_id: id, disable_notification: true });
  if (!r.ok) {
    const d = (r.description || '').toLowerCase();
    if (r.code === 429) throw new Error('STOP:rate');
    if (/protected|restricted|can't be forwarded from/.test(d) && !/not found/.test(d)) throw new Error('STOP:protected');
    if (r.code === 403) throw new Error('STOP:blocked');
    return null; // missing / service message
  }
  copies.push(r.result.message_id);
  const p = extractPost(r.result);
  const o = r.result.forward_origin;
  p.isForward = !!o && !(o.type === 'channel' && o.chat?.id === chat && o.message_id === id);
  return p;
}

async function scanSlice(j, started) {
  const c = await cfg(j.chat);
  const matcher = await matcherFor(j.chat, c, j.quick);
  const copies = [];
  let stop = null;
  try {
    while (j.next <= j.to && Date.now() - started < BUDGET) {
      const ids = [];
      for (let k = 0; k < 4 && j.next <= j.to; k++) ids.push(j.next++);
      let res;
      try {
        res = await Promise.all(ids.map((id) => readArchive(j.chat, id, j.uid, copies).then((p) => [id, p])));
      } catch (e) {
        stop = String(e.message).startsWith('STOP:') ? e.message.slice(5) : 'error';
        j.next = ids[0];
        if (!String(e.message).startsWith('STOP:')) console.error('cl scan', e);
        break;
      }
      const hits = [];
      for (const [id, p] of res) {
        if (!p) continue;
        j.read++;
        await savePost(j.chat, id, p);
        if (j.del) {
          const m = matcher(p);
          if (m) hits.push({ id, body: p.body, mgroup: p.mediaGroup, reason: m.reason, kw: m.keywordId });
        }
      }
      if (hits.length) {
        const r = await removePosts(j.chat, c, hits, j.quick ? 'quick' : 'scan');
        j.deleted += r.deleted;
        if (r.rate) { stop = 'rate'; break; }
      }
    }
  } finally {
    for (let i = 0; i < copies.length; i += 100) await call('deleteMessages', { chat_id: j.uid, message_ids: copies.slice(i, i + 100) });
  }
  if (j.next > j.to) {
    j.done = true;
    const fresh = await cfg(j.chat);
    await saveCfg(j.chat, { ...fresh, scanned: Math.max(fresh.scanned || 0, j.to) });
  }
  if (stop === 'protected' || stop === 'blocked') { j.done = true; j.fail = stop; }
  j.note = stop;
}

async function purgeSlice(j, started) {
  const c = await cfg(j.chat);
  const matcher = await matcherFor(j.chat, c, j.quick);
  while (Date.now() - started < BUDGET) {
    const items = await collect(j.chat, matcher, 300);
    if (!items.length) { j.done = true; break; }
    const r = await removePosts(j.chat, c, items, j.quick ? 'quick' : 'purge');
    j.deleted += r.deleted;
    if (r.rate) { j.note = 'rate'; break; }
    if (!r.deleted) { j.done = true; break; }
  }
}

/** Do one slice of the current job and update its progress message. Called by the buttons and by the cron. */
export async function runJob(budget = BUDGET) {
  const j = await getJob();
  if (!j || j.done) return;
  if (!(await lock())) return jobMessage(j); // another slice is running: just show the progress
  const started = Date.now() - (BUDGET - budget);
  try {
    j.note = null;
    if (j.type === 'scan') await scanSlice(j, started);
    else await purgeSlice(j, started);
  } catch (e) {
    j.done = true;
    j.fail = String(e.message) === 'NO_RIGHTS' ? 'rights' : 'error';
    console.error('cl job', e);
  } finally {
    const cur = await getJob();
    if (cur && cur.chat === j.chat) await setJob(j.done ? null : { ...j, mid: cur.mid }); // a stop meanwhile wins
    await unlock();
  }
  if (await getJob() || j.done) await jobMessage(j);
}

const FAIL = {
  protected: '🔒 کانال «محدودیت فوروارد/ذخیره محتوا» داره. موقتاً از تنظیمات کانال خاموشش کن و دوباره شروع کن.',
  blocked: '🚫 ربات نمی‌تونه بهت پیام بده؛ ربات رو از بلاک دربیار.',
  rights: '⛔️ ربات توی کانال دسترسی «حذف پیام‌ها» نداره.',
  error: '⚠️ یه خطا پیش اومد؛ دوباره امتحان کن.',
};

async function jobMessage(j) {
  const title = (await one(sql`SELECT title FROM channels WHERE chat_id = ${j.chat} LIMIT 1`))?.title || '';
  const what = j.quick ? `کلمه‌ی «${esc(j.quick.word)}»` : 'کلمه‌های فیلتر';
  let text;
  if (j.type === 'scan') {
    const total = j.to - j.from + 1;
    const doneN = Math.min(total, j.next - j.from);
    text = `🔎 <b>جستجو در کل کانال${j.del ? ' و حذف' : ''}</b>\n📢 ${esc(title)}\n${LINE}\n` +
      `${progressBar(doneN, total)}  <b>${Math.floor((doneN / Math.max(total, 1)) * 100)}%</b>\n` +
      `🔢 پیام ${fmt(doneN)} از ${fmt(total)}\n📖 پست خونده‌شده: <b>${fmt(j.read)}</b>\n` +
      (j.del ? `🗑 حذف‌شده (${what}): <b>${fmt(j.deleted)}</b>\n` : '');
  } else {
    text = `🗑 <b>پاکسازی</b> — ${esc(title)}\n${LINE}\n🎯 ${what}\n🗑 حذف‌شده: <b>${fmt(j.deleted)}</b>\n`;
  }
  let kb;
  if (j.fail) {
    text += `\n${FAIL[j.fail]}`;
    kb = [[U('📢 پنل کانال', `cf:p:${j.chat}`)]];
  } else if (j.done) {
    text += `\n✅ <b>تموم شد!</b>`;
    kb = [[U('📊 آمار و گزارش', `cf:st:${j.chat}`), B('📢 پنل کانال', `cf:p:${j.chat}`)]];
  } else {
    text += j.note === 'rate' ? '\n⏳ تلگرام سرعت رو محدود کرد؛ چند ثانیه دیگه ادامه میده.' : '\n⏳ در حال انجام… (خودکار ادامه پیدا می‌کنه)';
    kb = [[G('▶️ ادامه (سریع‌تر)', `cf:go:${j.chat}`), R('⏹ توقف', `cf:stop:${j.chat}`)]];
  }
  const edit = j.mid && (await call('editMessageText', {
    chat_id: j.uid, message_id: j.mid, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb },
  }));
  if (!edit || (!edit.ok && !/not modified/i.test(edit.description || ''))) {
    const r = await send(j.uid, text, kb);
    if (r.ok && !j.done) {
      const cur = await getJob();
      if (cur) await setJob({ ...cur, mid: r.result.message_id });
    }
  }
}

/** The newest message id: a silent temp message in the channel, deleted right away. */
async function lastId(chat, c) {
  const r = await call('sendMessage', { chat_id: chat, text: '⏳', disable_notification: true });
  if (r.ok) {
    await call('deleteMessage', { chat_id: chat, message_id: r.result.message_id });
    return Math.max(r.result.message_id - 1, c.last || 0);
  }
  return c.last || 0;
}

async function startJob(uid, chat, mid, job) {
  const cur = await getJob();
  if (cur && !cur.done && cur.chat !== chat) {
    return send(uid, '⏳ یه پاکسازی دیگه در حال انجامه؛ صبر کن تموم بشه یا متوقفش کن.', [[R('⏹ توقف کار قبلی', `cf:stop:${cur.chat}`)]]);
  }
  await setJob({ chat, uid, mid, read: 0, deleted: 0, done: false, ...job });
  return runJob();
}

// ---------- screens ----------
async function edit(uid, mid, text, kb) {
  if (mid) {
    const r = await call('editMessageText', { chat_id: uid, message_id: mid, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: kb } });
    if (r.ok || /not modified/i.test(r.description || '')) return r;
  }
  return send(uid, text, kb);
}

async function myChannels(uid) {
  return (await store.user(uid)).channels;
}

export async function home(uid, mid = null) {
  const chs = await myChannels(uid);
  const rows = [];
  for (const ch of chs) {
    const c = await cfg(ch.id);
    rows.push([(c.auto ? G : U)(`${c.auto ? '🛡' : '📢'} ${snippet(ch.title || ch.id, 30)}`, `cf:p:${ch.id}`)]);
  }
  rows.push([B('➕ وصل کردن کانال', 'addch'), B('🔙 برگشت به منو', 'menu')]);
  return edit(uid, mid,
    `🧹 <b>پاکسازی هوشمند کانال</b>\n${LINE}\n` +
    'هر پستی که یه کلمه‌ی خاص داره (مثلاً <b>روم</b>، <b>پرایز</b> یا هر کلمه‌ای که بخوای) رو از کانال پاک می‌کنم — ' +
    '<b>حتی قدیمی‌ترین پست‌ها</b>. پست‌های جدید هم خودکار فیلتر میشن.\n\n' +
    (chs.length ? 'یه کانال انتخاب کن 👇\n🛡 = فیلتر خودکار روشن' : '⚠️ اول یه کانال به ربات وصل کن.'),
    rows);
}

async function rights(chat) {
  const me = (await call('getMe', {})).result?.id;
  const r = await call('getChatMember', { chat_id: chat, user_id: me });
  if (!r.ok) return '⚠️ ربات به این کانال دسترسی نداره.';
  if (r.result.status !== 'administrator') return '⚠️ ربات توی این کانال ادمین نیست.';
  if (r.result.can_delete_messages === false) return '⚠️ ربات دسترسی <b>«حذف پیام‌ها»</b> نداره؛ از تنظیمات ادمین کانال روشنش کن.';
  return null;
}

export async function panel(uid, chat, mid = null, note = '') {
  const ch = (await myChannels(uid)).find((x) => String(x.id) === String(chat));
  if (!ch) return home(uid, mid);
  const c = await cfg(chat);
  const st = await postStats(chat);
  const ws = await words(chat);
  const nb = ws.filter((w) => w.kind !== 'allow').length;
  const warn = await rights(chat);
  const job = await getJob();
  const text =
    `📢 <b>${esc(ch.title)}</b>\n${LINE}\n` +
    `🚫 کلمه‌های فیلتر: <b>${nb}</b>   ✅ استثناها: <b>${ws.length - nb}</b>\n` +
    `🗂 پست‌های خونده‌شده: <b>${fmt(st.alive)}</b>${c.scanned ? '' : '  <i>(کانال هنوز کامل گشته نشده)</i>'}\n` +
    `🗑 کل حذف‌ها: <b>${fmt(c.deleted)}</b>\n` +
    `🗄 پشتیبان قبل از حذف: <b>${c.backup ? 'روشن ✅' : 'خاموش'}</b>` +
    (job && !job.done && String(job.chat) === String(chat) ? '\n\n⏳ <b>یه پاکسازی در حال انجامه…</b>' : '') +
    (warn ? `\n\n${warn}` : '') + (note ? `\n\n${note}` : '');
  const id = chat;
  return edit(uid, mid, text, [
    [U('🚫 کلمه‌های فیلتر', `cf:w:${id}:block:0`), G('✅ کلمه‌های استثنا', `cf:w:${id}:allow:0`)],
    [R('🗑 جستجو و حذف همه‌ی پست‌ها', `cf:pg:${id}`)],
    [R('🧨 حذف فوری با یه کلمه', `cf:q:${id}`), U('🔍 پیش‌نمایش', `cf:pv:${id}`)],
    [tog(c.auto, '🛡 فیلتر خودکار پست‌های جدید', `cf:t:${id}:auto`)],
    [tog(c.links, '🔗 لینک‌دار', `cf:t:${id}:links`), tog(c.fwd, '↪️ فورواردی', `cf:t:${id}:fwd`)],
    [B('🗄 پشتیبان', `cf:bk:${id}`), B('🧪 تست متن', `cf:ts:${id}`), tog(c.notify, '🔔', `cf:t:${id}:notify`)],
    [B('📊 آمار و گزارش', `cf:st:${id}`), B('🔙 کانال‌ها', 'cf:h')],
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
  rows.push([B('🔙 پنل کانال', `cf:p:${chat}`)]);
  return edit(uid, mid,
    `${allow ? '✅ <b>کلمه‌های استثنا</b>' : '🚫 <b>کلمه‌های فیلتر</b>'}\n${LINE}\n` +
    (allow ? 'پستی که یکی از این‌ها رو داشته باشه <b>هیچ‌وقت</b> پاک نمیشه.' : 'هر پستی که یکی از این کلمه‌ها رو داشته باشه پاک میشه.') +
    `\n\nتعداد: <b>${list.length}</b>\n🔁 = عوض کردن حالت (شامل ⇄ کلمه کامل)`, rows);
}

const ADD_HELP = 'کلمه یا کلمه‌ها رو بفرست؛ چندتا رو خط به خط یا با کاما:\n<code>روم\nپرایز, خیار</code>\n\n' +
  '🔹 <b>شامل</b> (پیش‌فرض): هر جای متن باشه — «روم» توی «رومی» هم پیدا میشه\n' +
  '🔹 <b>کلمه کامل</b>: توی گیومه → <code>"روم"</code>\n🔹 <b>Regex</b>: بین دو اسلش → <code>/prize|جایزه/</code>\n\n' +
  'ی/ي، ک/ك، اعراب و نیم‌فاصله خودکار یکی حساب میشن.';

async function preview(uid, chat, mid) {
  const c = await cfg(chat);
  const matcher = await matcherFor(chat, c);
  if (matcher.empty) return panel(uid, chat, mid, '⚠️ هنوز هیچ کلمه‌ی فیلتری اضافه نکردی.');
  const st = await postStats(chat);
  const items = await collect(chat, matcher);
  const by = {};
  for (const x of items) by[x.reason] = (by[x.reason] || 0) + 1;
  const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([r, n]) => `• <b>${esc(r)}</b>: ${fmt(n)} پست`).join('\n');
  const link = (id) => `https://t.me/c/${String(chat).replace(/^-100/, '')}/${id}`;
  const samples = items.slice(-6).reverse().map((x) => `• <a href="${link(x.id)}">#${x.id}</a> — ${esc(snippet(x.body, 45)) || '<i>(بدون متن)</i>'}`).join('\n');
  return edit(uid, mid,
    `🔍 <b>پیش‌نمایش</b>\n${LINE}\n🗂 پست‌های خونده‌شده: <b>${fmt(st.alive)}</b>\n🎯 مطابق فیلترها: <b>${fmt(items.length)}</b>\n\n` +
    (top ? `${top}\n\n` : '') + (samples ? `<b>آخرین‌ها:</b>\n${samples}\n\n` : '') +
    (c.scanned ? '' : '💡 هنوز کل کانال گشته نشده؛ «جستجو و حذف» کل تاریخچه رو هم می‌گرده.'),
    [[R('🗑 جستجو و حذف همه‌ی پست‌ها', `cf:pg:${chat}`)], [B('🔙 پنل کانال', `cf:p:${chat}`)]]);
}

async function purgeMenu(uid, chat, mid, quick = null) {
  const c = await cfg(chat);
  const matcher = await matcherFor(chat, c, quick);
  if (matcher.empty) return panel(uid, chat, mid, '⚠️ اول یه کلمه‌ی فیلتر اضافه کن.');
  const known = (await collect(chat, matcher)).length;
  const st = await postStats(chat);
  const q = quick ? ':q' : '';
  const what = quick ? `کلمه‌ی «<b>${esc(quick.word)}</b>»` : 'کلمه‌های فیلتر';
  return edit(uid, mid,
    `🗑 <b>جستجو و حذف</b>\n${LINE}\n🎯 ${what}\n\n` +
    `📖 بین ${fmt(st.alive)} پستی که تا الان خوندم: <b>${fmt(known)}</b> پست مطابقه.\n\n` +
    '🔎 <b>جستجوی کامل</b>: کل کانال رو از اولین پست تا آخرین پست می‌گردم و هر پستی که مطابق باشه رو پاک می‌کنم ' +
    '(برای چند هزار پست چند دقیقه طول می‌کشه و خودکار ادامه پیدا می‌کنه).\n\n' +
    (c.backup ? '🗄 از هر پست قبل از حذف پشتیبان گرفته میشه.' : '❗️ پشتیبان خاموشه؛ پست‌های حذف‌شده برنمی‌گردن.'),
    [
      [R('🔎 جستجوی کامل کانال + حذف', `cf:fs:${chat}${q}`)],
      known ? [R(`⚡️ فقط حذف ${fmt(known)} پست پیدا‌شده`, `cf:fp:${chat}${q}`)] : [],
      [G('✖️ نه، منصرف شدم', `cf:p:${chat}`)],
    ].filter((r) => r.length));
}

async function stats(uid, chat, mid) {
  const c = await cfg(chat);
  const st = await postStats(chat);
  const src = Object.fromEntries((await db.all(sql`SELECT src, count(*) AS n FROM cl_logs WHERE chat_id = ${chat} GROUP BY src`)).map((r) => [r.src, r.n]));
  const top = (await db.all(sql`SELECT word, hits FROM cl_words WHERE chat_id = ${chat} AND kind = 'block' AND hits > 0 ORDER BY hits DESC LIMIT 6`))
    .map((w, i) => `${i + 1}. <b>${esc(snippet(w.word, 20))}</b> — ${fmt(w.hits)}`).join('\n');
  const logs = (await db.all(sql`SELECT * FROM cl_logs WHERE chat_id = ${chat} ORDER BY id DESC LIMIT 8`))
    .map((l) => `${{ purge: '🗑', auto: '🛡', quick: '🧨', scan: '🔎' }[l.src] || '•'} <code>#${l.msg_id}</code> «${esc(snippet(l.reason, 15))}» ${esc(snippet(l.snip, 30))}`).join('\n');
  return edit(uid, mid,
    `📊 <b>آمار و گزارش</b>\n${LINE}\n🗂 پست‌های خونده‌شده: <b>${fmt(st.total)}</b> (فعال: ${fmt(st.alive)})\n` +
    `🔢 آخرین پیام شناخته‌شده: <b>#${fmt(Math.max(c.last, st.maxId))}</b>\n` +
    `🗑 کل حذف‌ها: <b>${fmt(c.deleted)}</b>\n   🔎 جستجو: ${fmt(src.scan)} · 🗑 پاکسازی: ${fmt(src.purge)} · 🛡 خودکار: ${fmt(src.auto)} · 🧨 فوری: ${fmt(src.quick)}\n\n` +
    (top ? `🏆 <b>بیشترین حذف:</b>\n${top}\n\n` : '') + (logs ? `🧾 <b>آخرین حذف‌ها:</b>\n${logs}` : '<i>هنوز چیزی حذف نشده.</i>'),
    [[B('🔄 بروزرسانی', `cf:st:${chat}`), B('🔙 پنل کانال', `cf:p:${chat}`)]]);
}

async function backupPanel(uid, chat, mid) {
  const c = await cfg(chat);
  return edit(uid, mid,
    `🗄 <b>پشتیبان قبل از حذف</b>\n${LINE}\nاگه روشن باشه، قبل از حذف هر پست یه کپی ازش می‌فرستم به مقصد پشتیبان؛ ` +
    `اگه اشتباهی پاک شد، چیزی از دست نمیره.\n\nالان: <b>${c.backup ? `روشن → <code>${c.backup}</code>` : 'خاموش'}</b>\n\n` +
    'برای کانال آرشیو: ربات رو اونجا ادمین کن و یه پیام از اون کانال رو برام فوروارد کن.',
    [
      [G('👤 بفرست پیوی خودم', `cf:bp:${chat}`), U('📦 کانال آرشیو', `cf:bc:${chat}`)],
      c.backup ? [R('⛔️ خاموش کردن پشتیبان', `cf:bx:${chat}`)] : [],
      [B('🔙 پنل کانال', `cf:p:${chat}`)],
    ].filter((r) => r.length));
}

// ---------- buttons ----------
export async function action(uid, st, data, mid) {
  const [, act, a, b, c3] = data.split(':');
  st.w = null;
  if (!act || act === 'h') return home(uid, mid);

  // word-level
  if (act === 'wi' || act === 'wm' || act === 'wd') {
    const w = await one(sql`SELECT * FROM cl_words WHERE id = ${Number(a)}`);
    if (!w) return home(uid, mid);
    if (act === 'wi') return send(uid, `«${esc(w.word)}» — حالت: ${MODE[w.mode]} — ${fmt(w.hits)} حذف`, [[B('🔙 لیست', `cf:w:${w.chat_id}:${w.kind}:0`)]]);
    if (act === 'wm' && w.mode !== 'regex') await db.run(sql`UPDATE cl_words SET mode = ${w.mode === 'word' ? 'contains' : 'word'} WHERE id = ${w.id}`);
    if (act === 'wd') await db.run(sql`DELETE FROM cl_words WHERE id = ${w.id}`);
    return wordList(uid, w.chat_id, w.kind, Number(b) || 0, mid);
  }

  const chat = Number(a);
  if (!(await myChannels(uid)).some((x) => String(x.id) === String(chat))) return home(uid, mid);
  const quick = c3 === 'q' || b === 'q' ? (st.clq?.chat === chat ? st.clq : null) : null;

  switch (act) {
    case 'p': return panel(uid, chat, mid);
    case 'w': return wordList(uid, chat, b === 'allow' ? 'allow' : 'block', Number(c3) || 0, mid);
    case 'wa':
      st.w = `cf:add:${chat}:${b === 'allow' ? 'allow' : 'block'}`;
      return edit(uid, mid, `✍️ <b>${b === 'allow' ? 'افزودن استثنا' : 'افزودن کلمه‌ی فیلتر'}</b>\n${LINE}\n${ADD_HELP}`, [[R('❌ لغو', `cf:w:${chat}:${b}:0`)]]);
    case 'wc':
      return edit(uid, mid, `⚠️ کل لیست ${b === 'allow' ? 'استثناها' : 'کلمه‌های فیلتر'} پاک بشه؟`,
        [[R('🧹 آره، پاک کن', `cf:wcy:${chat}:${b}`), G('❌ نه', `cf:w:${chat}:${b}:0`)]]);
    case 'wcy':
      await db.run(sql`DELETE FROM cl_words WHERE chat_id = ${chat} AND kind = ${b === 'allow' ? 'allow' : 'block'}`);
      return wordList(uid, chat, b, 0, mid);
    case 'pv': return preview(uid, chat, mid);
    case 'pg': return purgeMenu(uid, chat, mid);
    case 'q':
      st.w = `cf:quick:${chat}`;
      return edit(uid, mid, `🧨 <b>حذف فوری با یه کلمه</b>\n${LINE}\nکلمه رو بفرست؛ همه‌ی پست‌هایی که این کلمه رو دارن (حتی قدیمی‌ترین‌ها) پیدا و بعد از تأیید تو پاک میشن.\n\n` +
        'این کلمه توی لیست فیلتر ذخیره <b>نمیشه</b>.\n<code>"کلمه"</code> = کلمه کامل · <code>/regex/</code>', [[R('❌ لغو', `cf:p:${chat}`)]]);
    case 'fs': {
      if (b === 'q' && !quick) return panel(uid, chat, mid, '⌛️ وقتش تموم شد؛ دوباره کلمه رو بفرست.');
      const warn = await rights(chat);
      if (warn) return panel(uid, chat, mid, warn);
      const c = await cfg(chat);
      const to = Math.max(await lastId(chat, c), (await postStats(chat)).maxId);
      if (!to) return panel(uid, chat, mid, '⚠️ نتونستم آخرین پیام کانال رو پیدا کنم؛ آخرین پست کانال رو برام فوروارد کن و دوباره بزن.');
      await bumpLast(chat, to);
      return startJob(uid, chat, mid, { type: 'scan', del: true, from: 1, next: 1, to, quick: quick ? { word: quick.word, mode: quick.mode } : null });
    }
    case 'fp':
      if (b === 'q' && !quick) return panel(uid, chat, mid, '⌛️ وقتش تموم شد؛ دوباره کلمه رو بفرست.');
      return startJob(uid, chat, mid, { type: 'purge', quick: quick ? { word: quick.word, mode: quick.mode } : null });
    case 'go': {
      const j = await getJob();
      if (j && !j.done) {
        j.mid = mid;
        await setJob(j);
        return runJob();
      }
      return panel(uid, chat, mid, '✅ کاری در حال انجام نیست.');
    }
    case 'stop':
      await setJob(null);
      await unlock();
      return panel(uid, chat, mid, '⏹ متوقف شد. پست‌هایی که تا الان خونده شدن ذخیره هستن.');
    case 't': {
      if (!['auto', 'links', 'fwd', 'notify'].includes(b)) return panel(uid, chat, mid);
      const c = await cfg(chat);
      await patchCfg(chat, { [b]: !c[b] });
      return panel(uid, chat, mid);
    }
    case 'bk': return backupPanel(uid, chat, mid);
    case 'bp':
      await patchCfg(chat, { backup: uid });
      return backupPanel(uid, chat, mid);
    case 'bx':
      await patchCfg(chat, { backup: null });
      return backupPanel(uid, chat, mid);
    case 'bc':
      st.w = `cf:bkch:${chat}`;
      return edit(uid, mid, '📦 یه پیام از <b>کانال آرشیو</b> رو برام فوروارد کن (ربات باید اونجا ادمین باشه).', [[R('❌ لغو', `cf:bk:${chat}`)]]);
    case 'ts':
      st.w = `cf:test:${chat}`;
      return edit(uid, mid, '🧪 یه متن (یا یه پست فورواردی) بفرست تا ببینی با فیلترهای الان پاک میشه یا نه.', [[B('🔙 پنل کانال', `cf:p:${chat}`)]]);
    case 'st': return stats(uid, chat, mid);
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
      await send(uid, bad ? `⚠️ Regex درست نیست: <code>${esc(bad.word)}</code>` : '⚠️ یه کلمه بفرست.', [[R('❌ لغو', `cf:w:${chat}:${kind}:0`)]]);
      return true;
    }
    const have = new Set((await words(chat, kind)).map((w) => `${w.word.toLowerCase()}|${w.mode}`));
    let added = 0;
    for (const it of items) {
      if (have.has(`${it.word.toLowerCase()}|${it.mode}`)) continue;
      have.add(`${it.word.toLowerCase()}|${it.mode}`);
      await db.run(sql`INSERT INTO cl_words (chat_id, word, mode, kind, hits) VALUES (${chat}, ${it.word}, ${it.mode}, ${kind}, 0)`);
      added++;
    }
    st.w = null;
    await send(uid, `✅ <b>${added}</b> کلمه اضافه شد${added < items.length ? ` (${items.length - added} تا تکراری بود)` : ''}.`, [
      kind === 'block' ? [R('🗑 جستجو و حذف همه‌ی پست‌ها', `cf:pg:${chat}`)] : [],
      [G('➕ کلمه‌ی دیگه', `cf:wa:${chat}:${kind}`), U('📋 لیست', `cf:w:${chat}:${kind}:0`)],
      [B('🔙 پنل کانال', `cf:p:${chat}`)],
    ].filter((r) => r.length));
    return true;
  }
  if (what === 'quick') {
    const [it] = parseKeywordInput(t);
    if (!it || (it.mode === 'regex' && regexError(it.word))) {
      await send(uid, '⚠️ یه کلمه‌ی درست بفرست.', [[R('❌ لغو', `cf:p:${chat}`)]]);
      return true;
    }
    st.w = `cf:qr:${chat}`; // keeps the session (and the word) alive until a button is pressed
    st.clq = { chat, word: it.word, mode: it.mode };
    await purgeMenu(uid, chat, null, st.clq);
    return true;
  }
  if (what === 'test') {
    const ws = await words(chat);
    const c = await cfg(chat);
    const p = extractPost(m);
    const norm = normalize(p.body);
    const hitB = ws.filter((w) => w.kind !== 'allow' && compileKeyword(w)(norm, p.body)).map((w) => `<b>${esc(w.word)}</b>`);
    const hitA = ws.filter((w) => w.kind === 'allow' && compileKeyword(w)(norm, p.body)).map((w) => `<b>${esc(w.word)}</b>`);
    const v = buildMatcher({ ruleLinks: c.links, ruleForward: c.fwd }, ws)(p);
    await send(uid, `🧪 <b>نتیجه‌ی تست</b>\n${LINE}\n🚫 فیلترهای پیدا‌شده: ${hitB.join('، ') || '—'}\n✅ استثناهای پیدا‌شده: ${hitA.join('، ') || '—'}\n\n` +
      (v ? `🔴 <b>این پست پاک میشه</b> (دلیل: ${esc(v.reason)})` : '🟢 <b>این پست پاک نمیشه</b>') + '\n\nیه متن دیگه بفرست یا برگرد.',
    [[B('🔙 پنل کانال', `cf:p:${chat}`)]]);
    return true; // stay in test mode
  }
  if (what === 'bkch') {
    const fc = m.forward_from_chat || m.forward_origin?.chat;
    if (!fc) {
      await send(uid, '↪️ یه پیام از کانال آرشیو رو <b>فوروارد</b> کن.', [[R('❌ لغو', `cf:bk:${chat}`)]]);
      return true;
    }
    const r = await call('sendMessage', { chat_id: fc.id, text: '🗄 این کانال به‌عنوان آرشیو پشتیبانِ پاکسازی تنظیم شد.', disable_notification: true });
    if (!r.ok) {
      await send(uid, '⚠️ ربات نمی‌تونه توی اون کانال پیام بفرسته؛ اول ربات رو اونجا ادمین کن.', [[R('❌ لغو', `cf:bk:${chat}`)]]);
      return true;
    }
    st.w = null;
    await patchCfg(chat, { backup: fc.id });
    await backupPanel(uid, chat, null);
    return true;
  }
  return false;
}

/** Forwarding a channel's post to the bot teaches it the channel's newest message id. */
export async function learnForward(fc, m) {
  const id = m.forward_origin?.message_id || m.forward_from_message_id;
  if (fc && id) await bumpLast(fc.id, id);
}
