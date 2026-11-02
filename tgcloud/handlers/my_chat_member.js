// handlers/my_chat_member.js — the bot was added to / removed from a channel.
import { api } from 'sdk';
import * as store from '../lib/store.js';
import * as ui from '../lib/ui.js';
import { escapeHtml } from '../lib/text.js';

export default async function (upd) {
  const chat = upd.chat;
  if (chat.type !== 'channel' && chat.type !== 'supergroup') return;
  const status = upd.new_chat_member?.status;
  const by = upd.from;

  try {
    if (status === 'administrator') {
      const rights = upd.new_chat_member;
      // Only the person who promoted the bot gets the channel, and only if they are an admin.
      const um = await api.getChatMember({ chat_id: chat.id, user_id: by.id }).catch(() => null);
      if (!um || (um.status !== 'creator' && um.status !== 'administrator')) return;
      await store.upsertChannel({ id: chat.id, title: chat.title || 'Channel', username: chat.username, ownerId: by.id });
      const warn = rights.can_delete_messages ? '' : '\n\n⚠️ دسترسی <b>«حذف پیام‌ها»</b> را به ربات بدهید، وگرنه پاکسازی کار نمی‌کند.';
      await api.sendMessage({
        chat_id: by.id,
        parse_mode: 'HTML',
        text: `🎉 ربات در کانال <b>${escapeHtml(chat.title)}</b> ادمین شد و کانال به‌صورت خودکار اضافه شد.${warn}`,
        reply_markup: ui.kb(
          [ui.green('🚫 افزودن کلمهٔ فیلتر', `ka:${chat.id}:block`)],
          [ui.blue('📥 اسکن پست‌های قدیمی', `sc:${chat.id}`), ui.plain('📢 پنل کانال', `ch:${chat.id}`)],
        ),
      }).catch(() => {});
    } else if (status === 'left' || status === 'kicked' || status === 'member') {
      const ch = await store.getChannel(chat.id);
      if (!ch) return;
      await api.sendMessage({
        chat_id: ch.ownerId,
        parse_mode: 'HTML',
        text: `⚠️ ربات دیگر ادمین کانال <b>${escapeHtml(ch.title)}</b> نیست؛ فیلتر خودکار و پاکسازی تا ادمین شدن دوباره کار نمی‌کنند.`,
      }).catch(() => {});
    }
  } catch (e) {
    console.error(e);
  }
}
