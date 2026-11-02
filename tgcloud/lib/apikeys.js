// "🔑 تنظیمات API": the owner sets the Gemini keys and the screenshot model from the chat (never in the code).
// gemini_key: the bot's normal key (posts, AI builder) ; gemini_pro_key: the "pro" key, tried first for
// reading tournament screenshots (the normal key is the fallback) ; vision_model: the model for screenshots.
import { esc, btn, send, call } from './util.js';
import { getSetting, setSetting } from './store.js';
import { testKey, VISION_MODEL } from './ai.js';

export const KEYS = {
  gemini_key: '🔑 کلید Gemini (معمولی)',
  gemini_pro_key: '💎 کلید Gemini Pro',
  vision_model: '🤖 مدل خواندن اسکرین‌شات',
};
const MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'];

const mask = (k) => (k ? `<code>${esc(k.slice(0, 4))}…${esc(k.slice(-4))}</code>` : '❌ ثبت نشده');

export async function apiPanel(uid) {
  const n = await getSetting('gemini_key'), p = await getSetting('gemini_pro_key');
  const model = (await getSetting('vision_model')) || VISION_MODEL;
  const text = '🔑 <b>تنظیمات API</b>\n\n' +
    `${KEYS.gemini_key}: ${mask(n)}\n<i>برای پست‌ها، ساخت با هوش مصنوعی و پست خودکار</i>\n\n` +
    `${KEYS.gemini_pro_key}: ${mask(p)}\n<i>برای خوندن اسکرین‌شات‌های تورنمنت اول این امتحان میشه؛ اگه نبود یا جواب نداد، کلید معمولی</i>\n\n` +
    `${KEYS.vision_model}: <code>${esc(model)}</code>\n\n` +
    '🔒 کلیدی که می‌فرستی بلافاصله از چت پاک میشه و فقط توی دیتابیس ربات می‌مونه.';
  return send(uid, text, [
    [btn(n ? '✏️ تغییر کلید معمولی' : '➕ ثبت کلید معمولی', 'ak:set:gemini_key'), ...(n ? [btn('🗑 حذف', 'ak:del:gemini_key')] : [])],
    [btn(p ? '✏️ تغییر کلید Pro' : '➕ ثبت کلید Pro', 'ak:set:gemini_pro_key'), ...(p ? [btn('🗑 حذف', 'ak:del:gemini_pro_key')] : [])],
    [btn('🤖 تغییر مدل', 'ak:model'), btn('🧪 تست کلیدها', 'ak:test')],
    [btn('🔙 برگشت به منو', 'menu')],
  ]);
}

const BACK = [[btn('🔙 برگشت به تنظیمات API', 'ak')]];

/** ak / ak:set:<k> / ak:del:<k> / ak:model / ak:m:<i> / ak:test */
export async function apiAction(uid, st, data) {
  st.w = null;
  if (data === 'ak') return apiPanel(uid);
  if (data.startsWith('ak:set:') && KEYS[data.slice(7)]) {
    st.w = data;
    return send(uid, `${KEYS[data.slice(7)]}\n\nکلید رو بفرست (از aistudio.google.com/apikey).\nبعد از ذخیره، پیامت از چت پاک میشه.`, BACK);
  }
  if (data.startsWith('ak:del:') && KEYS[data.slice(7)]) {
    await setSetting(data.slice(7), null);
    await send(uid, `🗑 ${KEYS[data.slice(7)]} پاک شد.`, false);
    return apiPanel(uid);
  }
  if (data === 'ak:model') {
    st.w = 'ak:set:vision_model';
    return send(uid, '🤖 <b>مدل خواندن اسکرین‌شات</b>\n\nیکی رو بزن یا اسم مدل رو تایپ کن.\n<i>پیشنهادی: gemini-2.5-flash (سریع و دقیق)</i>',
      [...MODELS.map((m, i) => [btn(m, `ak:m:${i}`)]), ...BACK]);
  }
  if (data.startsWith('ak:m:') && MODELS[Number(data.slice(5))]) {
    await setSetting('vision_model', MODELS[Number(data.slice(5))]);
    return apiPanel(uid);
  }
  if (data === 'ak:test') {
    const lines = [];
    for (const k of ['gemini_key', 'gemini_pro_key']) {
      const v = await getSetting(k);
      lines.push(`${KEYS[k]}: ${v ? await testKey(v).catch((e) => '❌ ' + esc(e.message)) : 'ثبت نشده'}`);
    }
    return send(uid, '🧪 <b>تست کلیدها</b>\n\n' + lines.join('\n'), BACK);
  }
  return apiPanel(uid);
}

/** The typed key / model (st.w = ak:set:<k>). */
export async function apiInput(uid, st, m, text) {
  const k = st.w.slice(7);
  st.w = null;
  const v = text.trim();
  await call('deleteMessage', { chat_id: uid, message_id: m.message_id }); // don't leave the key in the chat
  if (k === 'vision_model' ? !/^[\w.-]{3,60}$/.test(v) : !/^[\w-]{20,200}$/.test(v)) {
    st.w = `ak:set:${k}`;
    return send(uid, '⚠️ درست نیست؛ دوباره بفرست.', BACK);
  }
  await setSetting(k, v);
  await send(uid, `✅ ${KEYS[k]} ذخیره شد.`, false);
  return apiPanel(uid);
}
