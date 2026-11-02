// Screen rendering + actions shared by the message and callback_query handlers.
import { api, BotApiError } from 'sdk';
import * as store from './store.js';
import * as ui from './ui.js';
import * as engine from './engine.js';
import { escapeHtml, fmt, snippet, buildMatcher, normalize, compileKeyword } from './text.js';

/** Edit the message in place when possible, otherwise send a new one. */
export async function render(chatId, messageId, view) {
  const params = {
    chat_id: chatId,
    text: view.text,
    parse_mode: 'HTML',
    reply_markup: view.reply_markup,
    link_preview_options: { is_disabled: true },
  };
  if (messageId) {
    try {
      return await api.editMessageText({ ...params, message_id: messageId });
    } catch (e) {
      if (e instanceof BotApiError && /not modified/i.test(e.description || '')) return null;
    }
  }
  return api.sendMessage(params);
}

export async function home(user, chatId, messageId) {
  const list = await store.userChannels(user.id);
  return render(chatId, messageId, ui.mainMenu(user, list.length));
}

export async function channels(user, chatId, messageId) {
  const list = await store.userChannels(user.id);
  return render(chatId, messageId, ui.channelsList(list.map((c) => ({ ...c, autoFilter: !!c.autoFilter }))));
}

export async function panelStats(ch) {
  const st = await store.postStats(ch.id);
  const kws = await store.listKeywords(ch.id);
  return {
    ...st,
    block: kws.filter((k) => k.kind !== 'allow').length,
    allow: kws.filter((k) => k.kind === 'allow').length,
  };
}

export async function panel(ch, chatId, messageId) {
  return render(chatId, messageId, ui.channelPanel(ch, await panelStats(ch)));
}

/** Register a channel after verification and show its panel. */
export async function addChannel(user, chatId, ref, lastKnownId = 0) {
  const v = await engine.verifyChannel(ref, user.id);
  if (!v.ok) {
    return render(chatId, null, { text: v.error, reply_markup: ui.kb([ui.blue('🔁 تلاش دوباره', 'menu:add'), ui.plain('🔙 منو', 'menu:home')]) });
  }
  await store.upsertChannel({ id: v.chat.id, title: v.chat.title || 'Channel', username: v.chat.username, ownerId: user.id });
  if (lastKnownId) await store.bumpLastKnown(v.chat.id, lastKnownId);
  await store.clearSession(user.id);
  const ch = await store.getChannel(v.chat.id);
  await render(chatId, null, {
    text: `✅ کانال <b>${escapeHtml(ch.title)}</b> با موفقیت اضافه شد!\n\nقدم بعد: کلمات فیلتر را اضافه کنید و پست‌های قدیمی را اسکن کنید.`,
    reply_markup: ui.kb(
      [ui.green('🚫 افزودن کلمهٔ فیلتر', `ka:${ch.id}:block`)],
      [ui.blue('📥 اسکن پست‌های قدیمی', `sc:${ch.id}`)],
      [ui.plain('📢 پنل کانال', `ch:${ch.id}`)],
    ),
  });
}

export async function keywordList(ch, kind, page, chatId, messageId) {
  const list = await store.listKeywords(ch.id, kind);
  return render(chatId, messageId, ui.keywordsList(ch, kind, list, page));
}

/** Preview: how many posts the current filters would remove. */
export async function preview(ch, chatId, messageId) {
  const matcher = await engine.matcherFor(ch);
  const st = await store.postStats(ch.id);
  if (matcher.empty) {
    return render(chatId, messageId, {
      text: '⚠️ هنوز هیچ کلمهٔ فیلتر یا قانونی تعریف نشده است.',
      reply_markup: ui.kb([ui.green('➕ افزودن کلمه', `ka:${ch.id}:block`)], [ui.plain('🔙 پنل', `ch:${ch.id}`)]),
    });
  }
  const matches = await engine.collectMatches(ch, matcher);
  const byReason = {};
  for (const m of matches) byReason[m.reason] = (byReason[m.reason] || 0) + 1;
  const top = Object.entries(byReason).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([r, n]) => `• <b>${escapeHtml(r)}</b>: ${fmt(n)} پست`).join('\n');
  const samples = matches.slice(-6).reverse().map((m) => {
    const url = linkTo(ch, m.messageId);
    const label = escapeHtml(snippet(m.body, 50)) || '<i>(بدون متن)</i>';
    return `• ${url ? `<a href="${url}">#${m.messageId}</a>` : `#${m.messageId}`} — ${label}`;
  }).join('\n');
  return render(chatId, messageId, {
    text:
      `🔍 <b>پیش‌نمایش پاکسازی</b> — ${escapeHtml(ch.title)}\n${ui.LINE}\n` +
      `🗂 بررسی‌شده: <b>${fmt(st.alive)}</b> پست\n` +
      `🎯 مطابق فیلترها: <b>${fmt(matches.length)}</b> پست\n\n` +
      (top ? `<b>به تفکیک کلمه:</b>\n${top}\n\n` : '') +
      (samples ? `<b>آخرین موارد:</b>\n${samples}\n\n` : '') +
      (st.alive === 0 ? '💡 هنوز پستی ایندکس نشده. اول «اسکن پست‌های قدیمی» را اجرا کنید.' : ''),
    reply_markup: ui.kb(
      matches.length ? [ui.red(`🗑 حذف ${fmt(matches.length)} پست`, `pg:${ch.id}`)] : [],
      [ui.blue('📥 اسکن پست‌های قدیمی', `sc:${ch.id}`), ui.plain('🔙 پنل', `ch:${ch.id}`)],
    ),
  });
}

export function linkTo(ch, messageId) {
  if (ch.username) return `https://t.me/${ch.username}/${messageId}`;
  const s = String(ch.id);
  if (s.startsWith('-100')) return `https://t.me/c/${s.slice(4)}/${messageId}`;
  return null;
}

/** Ask for confirmation before a purge (saved filters or one-off word). */
export async function confirm(ch, chatId, messageId, quickWord) {
  const matcher = quickWord
    ? buildMatcher({}, [{ id: null, word: quickWord.word, mode: quickWord.mode, kind: 'block' }])
    : await engine.matcherFor(ch);
  if (!quickWord && matcher.empty) return preview(ch, chatId, messageId);
  const matches = await engine.collectMatches(ch, matcher);
  if (!matches.length) {
    return render(chatId, messageId, {
      text:
        `✨ <b>هیچ پستی مطابق پیدا نشد.</b>\n\n` +
        `اگر پست‌های قدیمی هنوز اسکن نشده‌اند، اول «اسکن پست‌های قدیمی» را اجرا کنید.`,
      reply_markup: ui.kb([ui.blue('📥 اسکن پست‌های قدیمی', `sc:${ch.id}`)], [ui.plain('🔙 پنل', `ch:${ch.id}`)]),
    });
  }
  const samples = matches.slice(0, 5);
  return render(chatId, messageId,
    ui.confirmPurge(ch, matches.length, samples, quickWord ? `qy:${ch.id}` : `py:${ch.id}`, `ch:${ch.id}`));
}

/** Execute a purge and report. */
export async function purge(ch, user, chatId, messageId, quickWord) {
  const matcher = quickWord
    ? buildMatcher({}, [{ id: null, word: quickWord.word, mode: quickWord.mode, kind: 'block' }])
    : await engine.matcherFor(ch);
  const matches = await engine.collectMatches(ch, matcher);
  await render(chatId, messageId, { text: `⏳ در حال حذف <b>${fmt(matches.length)}</b> پست…`, reply_markup: ui.kb() });
  const res = await engine.deleteMatches(ch, matches, quickWord ? 'quick' : 'purge');
  const fresh = await store.getChannel(ch.id);
  const more = res.remaining > 0;
  const cont = quickWord ? `qy:${ch.id}` : `py:${ch.id}`;
  if (!more && quickWord) await store.clearSession(user.id);
  return render(chatId, messageId, {
    text:
      `${more ? '⏸' : '✅'} <b>${more ? 'مرحلهٔ پاکسازی انجام شد' : 'پاکسازی کامل شد'}</b>\n${ui.LINE}\n` +
      `🗑 حذف‌شده در این مرحله: <b>${fmt(res.deleted)}</b>\n` +
      (more ? `⏳ باقی‌مانده: <b>${fmt(res.remaining)}</b>\n` : '') +
      (res.rateLimited ? `\n⚠️ محدودیت سرعت تلگرام — ${res.rateLimited} ثانیه صبر کنید و ادامه دهید.\n` : '') +
      `📊 مجموع حذف‌ها در این کانال: <b>${fmt(fresh.deletedCount)}</b>`,
    reply_markup: ui.kb(
      more ? [ui.red('▶️ ادامهٔ حذف', cont)] : [],
      [ui.plain('🧾 گزارش', `lg:${ch.id}`), ui.plain('🔙 پنل', `ch:${ch.id}`)],
    ),
  });
}

export async function stats(ch, chatId, messageId) {
  const st = await store.postStats(ch.id);
  const kws = await store.listKeywords(ch.id, 'block');
  const bySource = Object.fromEntries((await store.logStats(ch.id)).map((r) => [r.source, r.n]));
  const top = [...kws].sort((a, b) => (b.hits || 0) - (a.hits || 0)).slice(0, 8)
    .map((k, i) => `${i + 1}. <b>${escapeHtml(snippet(k.word, 25))}</b> — ${fmt(k.hits)} حذف`).join('\n');
  return render(chatId, messageId, {
    text:
      `📊 <b>آمار</b> — ${escapeHtml(ch.title)}\n${ui.LINE}\n` +
      `🗂 کل پست‌های ایندکس‌شده: <b>${fmt(st.total)}</b>\n` +
      `🟢 پست‌های فعال: <b>${fmt(st.alive)}</b>\n` +
      `🔢 بازهٔ پیام‌ها: <b>${fmt(st.minId)}</b> تا <b>${fmt(Math.max(st.maxId, ch.lastKnownId || 0))}</b>\n\n` +
      `🗑 مجموع حذف‌ها: <b>${fmt(ch.deletedCount)}</b>\n` +
      `   • پاکسازی کامل: ${fmt(bySource.purge)}\n` +
      `   • فیلتر خودکار: ${fmt(bySource.auto)}\n` +
      `   • حذف فوری: ${fmt(bySource.quick)}\n\n` +
      (top ? `🏆 <b>پرکاربردترین کلمات:</b>\n${top}` : ''),
    reply_markup: ui.kb([ui.plain('🔙 پنل', `ch:${ch.id}`)]),
  });
}

export async function logsView(ch, chatId, messageId) {
  const rows = await store.recentLogs(ch.id, 15);
  const src = { purge: '🗑', auto: '🛡', quick: '🧨' };
  const lines = rows.map((r) => `${src[r.source] || '•'} <code>#${r.messageId}</code> «${escapeHtml(snippet(r.reason, 18))}» — ${escapeHtml(snippet(r.snippet, 40)) || '<i>بدون متن</i>'}`);
  return render(chatId, messageId, {
    text: `🧾 <b>آخرین حذف‌ها</b> — ${escapeHtml(ch.title)}\n${ui.LINE}\n` + (lines.length ? lines.join('\n') : '<i>هنوز چیزی حذف نشده.</i>') +
      `\n\n🗑 پاکسازی · 🛡 خودکار · 🧨 فوری`,
    reply_markup: ui.kb([ui.plain('🔄 بروزرسانی', `lg:${ch.id}`), ui.plain('🔙 پنل', `ch:${ch.id}`)]),
  });
}

export async function scanView(ch, chatId, messageId, note) {
  return render(chatId, messageId, ui.scanPanel(ch, await store.postStats(ch.id), note));
}

/** Test which filters a piece of text would trigger. */
export async function testText(ch, chatId, text) {
  const kws = await store.listKeywords(ch.id);
  const norm = normalize(text);
  const hitsBlock = kws.filter((k) => k.kind !== 'allow' && compileKeyword(k)(norm, text)).map((k) => k.word);
  const hitsAllow = kws.filter((k) => k.kind === 'allow' && compileKeyword(k)(norm, text)).map((k) => k.word);
  const verdict = buildMatcher(ch, kws)({ body: text, hasLink: /(https?:\/\/|t\.me\/|www\.)/i.test(text), isForward: false });
  return render(chatId, null, {
    text:
      `🧪 <b>نتیجهٔ تست</b>\n${ui.LINE}\n` +
      `🚫 کلمات فیلتر پیدا‌شده: ${hitsBlock.length ? hitsBlock.map((w) => `<b>${escapeHtml(w)}</b>`).join('، ') : '—'}\n` +
      `✅ استثناهای پیدا‌شده: ${hitsAllow.length ? hitsAllow.map((w) => `<b>${escapeHtml(w)}</b>`).join('، ') : '—'}\n\n` +
      (verdict ? `🔴 <b>این پست حذف می‌شود</b> (دلیل: ${escapeHtml(verdict.reason)})` : '🟢 <b>این پست حذف نمی‌شود</b>') +
      `\n\nمتن دیگری بفرستید یا برگردید.`,
    reply_markup: ui.kb([ui.plain('🔙 پنل', `ch:${ch.id}`)]),
  });
}
