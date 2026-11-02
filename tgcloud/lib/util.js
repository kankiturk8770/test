// Small helpers shared by every module.
import { api, BotApiError } from 'sdk';

export const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/** A button; style colors it: 'success' green · 'danger' red · 'primary' blue (none = the plain glass look). */
export const btn = (text, data, style) => ({ text, callback_data: data, ...(style ? { style } : {}) });

// Every keyboard in the bot's own chats gets colors by what the button does, unless it already has a style:
// red = delete / cancel, green = confirm / add / send, blue = the main sections; back / menu stay plain.
const NAV_PLAIN = /برگشت|بازگشت|🔙|🏠|◀️|▶️|^\d+\s*\/\s*\d+$/;
const RED = /❌|🗑|⛔|✖️|⏹|لغو|حذف|توقف|منصرف|پاک کن/;
const GREEN = /✅|🚀|➕|☑️|تایید|تأیید|آره|ثبت|ارسال الان|شروع|ادامه|ذخیره|بله/;
const BLUE = /🆕|🎁|🏆|✨|🪄|📰|🧹|⏰|📢|📊|🔑|👮|🎮|📋|🔍|🔎|✏️|📌|🎯|👥|📅/;
export function paint(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => (Array.isArray(r) ? r.map((b) => {
    if (!b || b.style || !b.text || b.web_app) return b;
    const t = String(b.text);
    if (NAV_PLAIN.test(t)) return b;
    const style = RED.test(t) ? 'danger' : GREEN.test(t) ? 'success' : BLUE.test(t) ? 'primary' : null;
    return style ? { ...b, style } : b;
  }) : r));
}
const privateChat = (id) => Number(id) > 0;
export const grid = (items, cols) => Array.from({ length: Math.ceil(items.length / cols) }, (_, i) => items.slice(i * cols, i * cols + cols));
export const now = () => Math.floor(Date.now() / 1000);
export const LINE = '━━━━━━━━━━━━━━━';
// Jalali (Persian) date of a Gregorian one -> [year, month, day]
export function jalali(gy, gm, gd) {
  const gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 355666 + 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) + gd + gdm[gm - 1];
  let jy = -1595 + 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  return days < 186 ? [jy, 1 + Math.floor(days / 31), 1 + (days % 31)] : [jy, 7 + Math.floor((days - 186) / 30), 1 + ((days - 186) % 30)];
}
export const JMONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
export const WEEKDAYS = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];

// Persian / Arabic digits -> ASCII
export const digits = (s) => String(s).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));

/** Bot API call that never throws for Telegram errors: -> { ok, result } | { ok: false, description } */
export async function call(method, params) {
  const kb = params?.reply_markup?.inline_keyboard;
  if (kb && privateChat(params.chat_id)) params = { ...params, reply_markup: { ...params.reply_markup, inline_keyboard: paint(kb) } };
  try {
    return { ok: true, result: await api[method](params) };
  } catch (e) {
    if (e instanceof BotApiError) return { ok: false, code: e.code, description: e.description };
    throw e;
  }
}

// Every message has a way back: without its own buttons it gets "back to menu" (kb = false: none,
// for "please wait…" notes that are deleted right after).
export const MENU_BACK = [[{ text: '🔙 برگشت به منو', callback_data: 'menu' }]];
/** The bot's owner (lib/store.js re-exports it). */
export const OWNER = '1689565085';
// a keyboard the owner gets always has a way out: without a back / menu / cancel button it gets "back to menu"
const NAV = /برگشت|منو|لغو|بازگشت/;
/** Admins the owner added (lib/store.js keeps this in step); they get the owner's keyboards too. */
export const STAFF = new Set();
export function withBack(chat, rows) {
  if (!rows || (String(chat) !== OWNER && !STAFF.has(String(chat)))) return rows;
  return rows.some((r) => (r || []).some((b) => NAV.test(b.text || ''))) ? rows : [...rows, ...MENU_BACK];
}
export function send(chat, text, kb = null, extra = {}) {
  const rows = kb === null ? MENU_BACK : withBack(chat, kb);
  return call('sendMessage', {
    chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    ...(rows ? { reply_markup: { inline_keyboard: rows } } : {}), ...extra,
  });
}

export const markup = (chat, mid, kb) => call('editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: { inline_keyboard: kb } });
