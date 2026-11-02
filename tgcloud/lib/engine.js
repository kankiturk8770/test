// Core engine: rights checks, purge (bulk delete), live auto-filter, archive scan.
import { api, db, BotApiError } from 'sdk';
import { sql } from 'sdk/db';
import * as store from './store.js';
import { buildMatcher, extractPost, snippet, escapeHtml, fmt } from './text.js';

const BUDGET_MS = 22000;          // stay well inside the platform's wall-time limit
const sleep = (ms) => (typeof setTimeout === 'function' ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

let BOT_ID = null;
export async function botId() {
  if (!BOT_ID) BOT_ID = (await api.getMe()).id;
  return BOT_ID;
}

/** Call the Bot API, transparently waiting out short 429s. */
async function call(method, params, maxWait = 8) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await api[method](params);
    } catch (e) {
      const ra = e instanceof BotApiError && e.code === 429 ? e.parameters?.retry_after : null;
      if (ra && ra <= maxWait) { await sleep(ra * 1000 + 200); continue; }
      throw e;
    }
  }
  return api[method](params);
}

// ── rights ──────────────────────────────────────────────────
/**
 * Resolve a channel reference and verify both the user and the bot are admins.
 * Returns { ok, chat, error }.
 */
export async function verifyChannel(ref, userId) {
  let chat;
  try {
    chat = await api.getChat({ chat_id: ref });
  } catch {
    return { ok: false, error: '❌ کانال پیدا نشد. مطمئن شوید ربات عضو/ادمین کانال است و آدرس درست است.' };
  }
  if (chat.type !== 'channel' && chat.type !== 'supergroup') {
    return { ok: false, error: '❌ این چت کانال یا سوپرگروه نیست.' };
  }
  const me = await botId();
  let botMember;
  try {
    botMember = await api.getChatMember({ chat_id: chat.id, user_id: me });
  } catch {
    return { ok: false, error: '❌ ربات به این کانال دسترسی ندارد. ابتدا ربات را ادمین کنید.' };
  }
  if (botMember.status !== 'administrator') {
    return { ok: false, error: '❌ ربات در این کانال <b>ادمین نیست</b>. ابتدا ربات را ادمین کنید.' };
  }
  if (!botMember.can_delete_messages) {
    return { ok: false, error: '❌ ربات دسترسی <b>«حذف پیام‌ها»</b> را ندارد. این دسترسی را در تنظیمات ادمین فعال کنید.' };
  }
  try {
    const um = await api.getChatMember({ chat_id: chat.id, user_id: userId });
    if (um.status !== 'creator' && um.status !== 'administrator') {
      return { ok: false, error: '⛔️ شما ادمین این کانال نیستید.' };
    }
  } catch {
    return { ok: false, error: '⛔️ نتوانستم ادمین بودن شما را بررسی کنم.' };
  }
  return { ok: true, chat };
}

// ── matching ────────────────────────────────────────────────
export async function matcherFor(ch, extra) {
  const kws = extra ? extra : await store.listKeywords(ch.id);
  return buildMatcher(ch, kws);
}

/** Scan the index and return every matching live post. */
export async function collectMatches(ch, matcher) {
  const out = [];
  let after = 0;
  for (;;) {
    const page = await store.alivePostsPage(ch.id, after, 500);
    if (!page.length) break;
    for (const p of page) {
      const m = matcher(p);
      if (m) out.push({ messageId: p.messageId, body: p.body, mediaGroup: p.mediaGroup, reason: m.reason, keywordId: m.keywordId });
    }
    after = page[page.length - 1].messageId;
    if (page.length < 500) break;
  }
  return out;
}

// ── deleting ────────────────────────────────────────────────
async function backupIds(ch, ids) {
  if (!ch.backupChat || !ids.length) return;
  const sorted = [...ids].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i += 100) {
    try {
      await call('copyMessages', { chat_id: ch.backupChat, from_chat_id: ch.id, message_ids: sorted.slice(i, i + 100), disable_notification: true });
    } catch (e) {
      // Fall back one by one so a single uncopiable message doesn't block the rest.
      for (const id of sorted.slice(i, i + 100)) {
        try { await call('copyMessage', { chat_id: ch.backupChat, from_chat_id: ch.id, message_id: id, disable_notification: true }); } catch {}
      }
    }
  }
}

async function deleteChunk(chatId, ids) {
  try {
    await call('deleteMessages', { chat_id: chatId, message_ids: ids });
    return ids;
  } catch (e) {
    if (e instanceof BotApiError && e.code === 429) throw e;
    const ok = [];
    for (const id of ids) {
      try { await call('deleteMessage', { chat_id: chatId, message_id: id }); ok.push(id); }
      catch (err) {
        if (err instanceof BotApiError && err.code === 429) throw err;
        if (err instanceof BotApiError && err.code === 400) ok.push(id); // already gone
      }
    }
    return ok;
  }
}

/**
 * Delete matched posts (+ their album siblings), with optional backup.
 * Returns { deleted, remaining, rateLimited }.
 */
export async function deleteMatches(ch, matches, source) {
  const started = Date.now();
  const byId = new Map(matches.map((m) => [m.messageId, m]));
  const siblings = await store.groupSiblings(ch.id, matches.map((m) => m.mediaGroup));
  for (const sid of siblings) {
    if (!byId.has(sid)) byId.set(sid, { messageId: sid, body: '', reason: 'آلبوم', keywordId: null });
  }
  const all = [...byId.keys()].sort((a, b) => a - b);
  let deleted = 0;
  let rateLimited = 0;
  const hits = {};
  let i = 0;
  for (; i < all.length; i += 100) {
    if (Date.now() - started > BUDGET_MS) break;
    const chunk = all.slice(i, i + 100);
    try {
      await backupIds(ch, chunk);
      const done = await deleteChunk(ch.id, chunk);
      await store.markDeleted(ch.id, done);
      deleted += done.length;
      const entries = done.map((id) => byId.get(id));
      for (const e of entries) hits[e.keywordId] = (hits[e.keywordId] || 0) + 1;
      await store.addLogs(ch.id, entries.map((e) => ({ messageId: e.messageId, reason: e.reason, snippet: snippet(e.body, 80) })), source);
    } catch (e) {
      if (e instanceof BotApiError && e.code === 429) { rateLimited = e.parameters?.retry_after || 30; break; }
      throw e;
    }
  }
  await store.addHits(hits);
  await store.addDeletedCount(ch.id, deleted);
  return { deleted, remaining: Math.max(0, all.length - i), rateLimited };
}

// ── live posts ──────────────────────────────────────────────
/** Called for channel_post / edited_channel_post. */
export async function handleChannelPost(message, edited) {
  const ch = await store.getChannel(message.chat.id);
  if (!ch) return;
  const p = extractPost(message);
  await store.savePost(ch.id, message.message_id, p);
  await store.bumpLastKnown(ch.id, message.message_id);

  if (!ch.autoFilter) return;

  // An album item whose sibling was already removed → remove it too.
  let match = null;
  if (p.mediaGroup) {
    const r = await db.get(sql`SELECT 1 AS x FROM posts WHERE channel_id = ${ch.id} AND media_group = ${p.mediaGroup} AND deleted = 1 LIMIT 1`);
    if (r) match = { reason: 'آلبوم', keywordId: null };
  }
  if (!match) {
    const matcher = await matcherFor(ch);
    if (matcher.empty) return;
    match = matcher({ body: p.body, hasLink: p.hasLink, isForward: p.isForward });
  }
  if (!match) return;

  const res = await deleteMatches(ch, [{ messageId: message.message_id, body: p.body, mediaGroup: p.mediaGroup, ...match }], 'auto');
  if (res.deleted && ch.notify) {
    try {
      await api.sendMessage({
        chat_id: ch.ownerId,
        parse_mode: 'HTML',
        disable_notification: true,
        text:
          `🛡 <b>حذف خودکار</b> ${edited ? '(پست ویرایش‌شده)' : ''}\n` +
          `📢 ${escapeHtml(ch.title)}\n🔎 دلیل: <b>${escapeHtml(match.reason)}</b>\n` +
          `📝 ${escapeHtml(snippet(p.body, 120)) || '<i>(بدون متن)</i>'}`,
      });
    } catch {}
  }
}

// ── archive scan ────────────────────────────────────────────
/** Find the newest message id by posting a silent temp message and deleting it. */
export async function detectLastId(ch) {
  const m = await api.sendMessage({ chat_id: ch.id, text: '⏳', disable_notification: true });
  try { await api.deleteMessage({ chat_id: ch.id, message_id: m.message_id }); } catch {}
  const last = m.message_id - 1;
  await store.bumpLastKnown(ch.id, last);
  return last;
}

/**
 * Read up to `count` messages of the archive by forwarding each one into the
 * scanner's private chat, indexing its content, then deleting the forwarded copy.
 * Returns { scanned, found, finished, stopReason }.
 */
export async function scanBatch(ch, userId, count) {
  const started = Date.now();
  let next = ch.scanNext || 1;
  const to = ch.scanTo || 0;
  const end = Math.min(to, next + count - 1);
  let found = 0;
  let stopReason = null;
  const copies = [];

  const readOne = async (id) => {
    try {
      const fm = await call('forwardMessage', { chat_id: userId, from_chat_id: ch.id, message_id: id, disable_notification: true }, 10);
      copies.push(fm.message_id);
      const p = extractPost(fm);
      const o = fm.forward_origin;
      p.isForward = !!o && !(o.type === 'channel' && o.chat?.id === ch.id && o.message_id === id);
      p.date = o?.date || fm.forward_date || 0;
      await store.savePost(ch.id, id, p);
      found++;
    } catch (e) {
      if (!(e instanceof BotApiError)) throw e;
      const d = (e.description || '').toUpperCase();
      if (e.code === 429) throw e;
      if (d.includes('FORWARDS_RESTRICTED') || d.includes('PROTECTED') || d.includes('HAS PROTECTED CONTENT')) {
        stopReason = 'protected';
        throw e;
      }
      if (e.code === 403) { stopReason = 'blocked'; throw e; }
      // 400: message missing / service message / can't be forwarded → skip
    }
  };

  try {
    const POOL = 3;
    while (next <= end) {
      if (Date.now() - started > BUDGET_MS) { stopReason = stopReason || 'time'; break; }
      const ids = [];
      for (let k = 0; k < POOL && next <= end; k++) ids.push(next++);
      try {
        await Promise.all(ids.map(readOne));
      } catch (e) {
        if (e instanceof BotApiError && e.code === 429) {
          stopReason = 'rate';
          next = Math.min(...ids); // retry this group next time
        }
        if (stopReason === 'protected' || stopReason === 'blocked') next = Math.min(...ids);
        break;
      }
    }
  } finally {
    // remove the temporary forwarded copies from the user's chat
    for (let i = 0; i < copies.length; i += 100) {
      try { await api.deleteMessages({ chat_id: userId, message_ids: copies.slice(i, i + 100) }); } catch {}
    }
  }

  const finished = next > to && !['protected', 'blocked'].includes(stopReason);
  await store.updateChannel(ch.id, {
    scanNext: next,
    scanFound: (ch.scanFound || 0) + found,
    scanActive: !finished && stopReason !== 'protected',
  });
  return { found, finished, stopReason };
}

export function scanNote(res) {
  if (res.finished) return '✅ <b>اسکن کامل شد!</b> حالا می‌توانید «پیش‌نمایش» یا «پاکسازی کامل» را بزنید.';
  switch (res.stopReason) {
    case 'rate': return '⏳ تلگرام موقتاً سرعت را محدود کرد. چند ثانیه بعد «ادامه» را بزنید.';
    case 'protected': return '🔒 کانال «محدودیت ذخیره/فوروارد محتوا» دارد. این گزینه را موقتاً در تنظیمات کانال خاموش کنید و دوباره اسکن کنید.';
    case 'blocked': return '🚫 ربات نمی‌تواند به پیوی شما پیام بدهد. ربات را از بلاک خارج کنید.';
    case 'time': return `⏸ این مرحله ${fmt(res.found)} پست خواند. برای ادامه دکمه را بزنید.`;
    default: return `🗂 ${fmt(res.found)} پست جدید ایندکس شد.`;
  }
}
