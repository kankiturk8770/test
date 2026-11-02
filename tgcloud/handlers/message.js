// handlers/message.js — private-chat messages: commands and replies to prompts.
import { api } from 'sdk';
import * as store from '../lib/store.js';
import * as ui from '../lib/ui.js';
import * as app from '../lib/app.js';
import { parseKeywordInput, regexError, escapeHtml, fmt } from '../lib/text.js';

export default async function (message) {
  if (message.chat.type !== 'private' || !message.from) return;
  const user = message.from;
  const chatId = message.chat.id;
  const text = (message.text || message.caption || '').trim();

  try {
    // ── commands ────────────────────────────────────────────
    if (text.startsWith('/')) {
      const cmd = text.split(/[\s@]/)[0].toLowerCase();
      if (cmd === '/start' || cmd === '/menu') { await store.clearSession(user.id); return await app.home(user, chatId); }
      if (cmd === '/channels') { await store.clearSession(user.id); return await app.channels(user, chatId); }
      if (cmd === '/help') return await app.render(chatId, null, ui.helpText());
      if (cmd === '/cancel') {
        await store.clearSession(user.id);
        return await app.render(chatId, null, { text: '✖️ لغو شد.', reply_markup: ui.kb([ui.blue('🏠 منوی اصلی', 'menu:home')]) });
      }
    }

    const session = await store.getSession(user.id);
    const state = session?.state;
    const data = session?.data || {};
    const origin = message.forward_origin;
    const fwdChat = origin && (origin.type === 'channel' ? origin.chat : origin.type === 'chat' ? origin.sender_chat : null);

    // ── backup target ───────────────────────────────────────
    if (state === 'backup') {
      if (!fwdChat) return await app.render(chatId, null, { text: '↪️ لطفاً یک پیام را از کانال/گروه آرشیو <b>فوروارد</b> کنید.', reply_markup: ui.kb([ui.red('✖️ لغو', `bk:${data.ch}`)]) });
      try {
        await api.sendMessage({ chat_id: fwdChat.id, text: '🗄 این چت به‌عنوان آرشیو پشتیبان ربات پاکسازی تنظیم شد.', disable_notification: true });
      } catch {
        return await app.render(chatId, null, { text: '❌ ربات نمی‌تواند در آن چت پیام بفرستد. ابتدا ربات را آنجا ادمین کنید.', reply_markup: ui.kb([ui.red('✖️ لغو', `bk:${data.ch}`)]) });
      }
      await store.updateChannel(data.ch, { backupChat: fwdChat.id });
      await store.clearSession(user.id);
      return await app.render(chatId, null, ui.backupPanel(await store.getChannel(data.ch)));
    }

    // ── test mode ───────────────────────────────────────────
    if (state === 'test') {
      const ch = await store.getChannel(data.ch);
      if (ch) return await app.testText(ch, chatId, text);
    }

    // ── add channel (explicit state, or any forwarded channel post) ─
    if (fwdChat && (state === 'add_channel' || !state)) {
      const known = await store.getChannel(fwdChat.id);
      if (known && (await store.isManager(known.id, user.id))) {
        if (origin.message_id) await store.bumpLastKnown(known.id, origin.message_id);
        const ch = await store.getChannel(known.id);
        return await app.render(chatId, null, {
          text: `📢 <b>${escapeHtml(ch.title)}</b>\n🔝 آخرین پیام شناخته‌شده به‌روز شد: <b>#${fmt(ch.lastKnownId)}</b>`,
          reply_markup: ui.kb([ui.blue('📥 اسکن پست‌های قدیمی', `sc:${ch.id}`)], [ui.plain('📢 پنل کانال', `ch:${ch.id}`)]),
        });
      }
      return await app.addChannel(user, chatId, fwdChat.id, origin.message_id || 0);
    }
    if (state === 'add_channel') {
      const ref = text.match(/^-100\d+$/) ? Number(text)
        : text.replace(/^https?:\/\/t\.me\//i, '@').replace(/^(?!@)/, '@').split(/[\s/]/)[0];
      if (!ref || ref === '@') return await app.render(chatId, null, ui.addChannelHelp());
      return await app.addChannel(user, chatId, ref);
    }

    // ── add keywords ────────────────────────────────────────
    if (state === 'add_kw') {
      const ch = await store.getChannel(data.ch);
      if (!ch) return await store.clearSession(user.id);
      const items = parseKeywordInput(text);
      const bad = items.filter((i) => i.mode === 'regex' && regexError(i.word));
      if (!items.length || bad.length) {
        return await app.render(chatId, null, {
          text: bad.length ? `❌ Regex نامعتبر: <code>${escapeHtml(bad[0].word)}</code>\n${escapeHtml(regexError(bad[0].word))}` : '❌ متنی دریافت نشد. کلمه را بفرستید.',
          reply_markup: ui.kb([ui.red('✖️ لغو', `kw:${ch.id}:${data.kind}:0`)]),
        });
      }
      const added = await store.addKeywords(ch.id, data.kind, items);
      await store.clearSession(user.id);
      await app.render(chatId, null, {
        text: `✅ <b>${added}</b> کلمه اضافه شد${added < items.length ? ` (${items.length - added} تکراری بود)` : ''}.`,
        reply_markup: ui.kb(
          data.kind === 'block' ? [ui.blue('🔍 پیش‌نمایش موارد', `pv:${ch.id}`), ui.red('🗑 پاکسازی کامل', `pg:${ch.id}`)] : [],
          [ui.green('➕ کلمهٔ دیگر', `ka:${ch.id}:${data.kind}`), ui.plain('📋 لیست', `kw:${ch.id}:${data.kind}:0`)],
        ),
      });
      return;
    }

    // ── quick one-off purge ─────────────────────────────────
    if (state === 'quick') {
      const ch = await store.getChannel(data.ch);
      if (!ch) return await store.clearSession(user.id);
      const [item] = parseKeywordInput(text);
      if (!item || (item.mode === 'regex' && regexError(item.word))) {
        return await app.render(chatId, null, { text: '❌ کلمهٔ معتبر بفرستید.', reply_markup: ui.kb([ui.red('✖️ لغو', `ch:${ch.id}`)]) });
      }
      await store.setSession(user.id, 'quick_ready', { ch: ch.id, word: item.word, mode: item.mode });
      return await app.confirm(ch, chatId, null, item);
    }

    // ── fallback ────────────────────────────────────────────
    return await app.home(user, chatId);
  } catch (e) {
    console.error(e);
    await api.sendMessage({ chat_id: chatId, text: '❌ خطا: ' + String(e.description || e.message || e).slice(0, 200) });
  }
}
