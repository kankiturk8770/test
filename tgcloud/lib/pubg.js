// 🎮 PUBG channel helpers:
//   🔑 room ID/Pass revealed at the start time: the announcement goes out without them, and the bot adds
//      them to the same post when it's time (plus a short note so members get a notification);
//   📈 a daily report of the channel's member count (up / down since yesterday).
// Telegram Serverless has no timer: both run from the heartbeat (every update) and the cron, so a reveal
// happens with the first activity after its time; the owner also gets a «reveal now» button as a fallback.
import { esc, call, send, now, digits, LINE } from './util.js';
import * as store from './store.js';

const B = (text, data, style) => ({ text, callback_data: data, ...(style ? { style } : {}) });
const fa = (n) => Number(n || 0).toLocaleString('fa-IR');

// ---------- 🔑 reveal ----------
export const REVEAL_STEPS = [undefined, '10', '5', 'start'];
export const revealLabel = (v) => ({ 10: '۱۰ دقیقه قبل از شروع', 5: '۵ دقیقه قبل از شروع', start: 'سر ساعت شروع' }[v] || 'همین الان توی پست');

/** The room's start time ("21:30", "۲۱:۳۰", "ساعت 9:30") as unix time today/tonight, or null. */
export async function startTime(text) {
  const m = digits(String(text || '')).match(/(\d{1,2})\s*[:.٫]\s*(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  const off = (await store.tz()) * 60;
  const day = Math.floor((now() + off) / 86400) * 86400;
  let ts = day + h * 3600 + mi * 60 - off;
  if (ts < now() - 6 * 3600) ts += 86400; // e.g. 00:30 posted at 22:00 = tonight, after midnight
  return ts;
}

/** When to reveal (unix time) for a room post, or null to show the ID/Pass right away. */
export async function revealAt(d) {
  if (!d.reveal || !d.room) return null;
  const start = await startTime(d.time);
  if (!start) return null;
  const at = start - (d.reveal === 'start' ? 0 : Number(d.reveal) * 60);
  if (at <= now() + 60 || at > now() + 12 * 3600) return null; // already time (or not today): show it now
  return at;
}

/** Plan a reveal for a post the bot just sent. */
export async function planReveal(chat, msgId, d, at, caption, uid) {
  const list = JSON.parse((await store.getSetting('pg_reveal')) || '[]');
  const id = Math.max(0, ...list.map((x) => x.id || 0)) + 1;
  list.push({ id, c: Number(chat), m: msgId, d, at, cap: !!caption });
  await store.setSetting('pg_reveal', JSON.stringify(list.slice(-50)));
  await send(uid, `🔑 <b>آیدی و پسورد روم</b> ساعت <b>${await store.localStr(at)}</b> خودکار به پست اضافه میشه.\n\n` +
    'اگه سر وقت اضافه نشد (ربات وقتی کسی بهش پیام نده بیدار نیست)، این دکمه رو بزن:', [[B('🔑 همین الان منتشر کن', `px:rv:${id}`, 'success')], [B('🔙 برگشت به منو', 'menu')]]);
}

/** Put the ID/Pass into the post and tell the channel. -> true if done */
async function reveal(x, revealText) {
  const text = revealText(x.d);
  const fits = !x.cap || text.length <= 1024; // a photo caption holds 1024 characters
  const r = !fits ? { ok: false }
    : x.cap ? await call('editMessageCaption', { chat_id: x.c, message_id: x.m, caption: text, parse_mode: 'HTML' })
      : await call('editMessageText', { chat_id: x.c, message_id: x.m, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  const edited = r.ok || /not modified/i.test(r.description || '');
  // the note under the post notifies the members; if the post couldn't take the ID/Pass, the note carries them
  const note = edited ? '🔑 <b>آیدی و پسورد روم اومد!</b> 👆'
    : `🔑 <b>اطلاعات روم</b>\n\n<code>${esc(x.d.room)}</code>\n\n🔥 موفق باشید`;
  const n = await call('sendMessage', { chat_id: x.c, text: note, parse_mode: 'HTML', reply_parameters: { message_id: x.m, allow_sending_without_reply: true } });
  return edited || n.ok;
}

/** Reveal the due posts (heartbeat / cron). `revealText(d)` builds the full post (from posts.js). */
export async function revealTick(revealText) {
  const list = JSON.parse((await store.getSetting('pg_reveal')) || 'null');
  if (!list?.length) return;
  const due = list.filter((x) => x.at <= now());
  if (!due.length) return;
  await store.setSetting('pg_reveal', JSON.stringify(list.filter((x) => x.at > now()))); // claim them first
  for (const x of due) {
    const ok = await reveal(x, revealText);
    await send(store.OWNER_ID, ok ? '🔑 آیدی و پسورد روم به پست اضافه شد ✅' : '⚠️ نتونستم آیدی و پسورد رو به پست اضافه کنم (پست پاک شده؟).', false);
  }
}

// ---------- 📈 daily members report ----------
/** Once a day (after 10:00 Iran time), the member count of each channel vs. yesterday. */
export async function membersTick() {
  if ((await store.getSetting('pg_members_off')) === '1') return;
  const off = (await store.tz()) * 60;
  const local = now() + off;
  if (Math.floor((local % 86400) / 3600) < 10) return;
  const day = new Date(local * 1000).toISOString().slice(0, 10);
  if ((await store.getSetting('pg_members_day')) === day) return;
  await store.setSetting('pg_members_day', day); // claim the day first
  const u = await store.user(store.OWNER_ID);
  const hist = JSON.parse((await store.getSetting('pg_members')) || '{}');
  const lines = [];
  for (const ch of u.channels) {
    const r = await call('getChatMemberCount', { chat_id: ch.id });
    if (!r.ok) continue;
    const n = r.result;
    const h = hist[ch.id] || [];
    const prev = h.length ? h[h.length - 1].n : null;
    const week = h.length >= 7 ? h[h.length - 7].n : null;
    h.push({ day, n });
    hist[ch.id] = h.slice(-60);
    const diff = prev === null ? '' : n > prev ? ` 🟢 <b>+${fa(n - prev)}</b>` : n < prev ? ` 🔴 <b>−${fa(prev - n)}</b>` : ' ⚪️ بدون تغییر';
    const wk = week === null ? '' : `\n   هفته‌ی گذشته: ${n >= week ? '+' : '−'}${fa(Math.abs(n - week))}`;
    lines.push(`📢 ${esc(ch.title)}\n   👥 <b>${fa(n)}</b> عضو${diff}${wk}`);
  }
  await store.setSetting('pg_members', JSON.stringify(hist));
  if (lines.length) {
    await send(store.OWNER_ID, `📈 <b>گزارش روزانه‌ی کانال</b>\n${LINE}\n${lines.join('\n\n')}`,
      [[B('🔕 گزارش روزانه رو نفرست', 'px:mb:off')], [B('🔙 برگشت به منو', 'menu')]]);
  }
}

// ---------- buttons: px:… ----------
export async function action(uid, data, revealText) {
  const [, act, a] = data.split(':');
  if (act === 'rv') {
    const list = JSON.parse((await store.getSetting('pg_reveal')) || '[]');
    const x = list.find((y) => y.id === Number(a));
    if (!x) return send(uid, 'ℹ️ این پست قبلاً منتشر شده.');
    await store.setSetting('pg_reveal', JSON.stringify(list.filter((y) => y.id !== x.id)));
    return send(uid, (await reveal(x, revealText)) ? '🔑 آیدی و پسورد به پست اضافه شد ✅' : '⚠️ نتونستم به پست اضافه کنم (پست پاک شده؟).');
  }
  if (act === 'mb') {
    await store.setSetting('pg_members_off', a === 'off' ? '1' : null);
    return send(uid, a === 'off' ? '🔕 گزارش روزانه خاموش شد. برای روشن کردن دوباره:' : '🔔 گزارش روزانه روشن شد؛ هر روز بعد از ساعت ۱۰ صبح میاد.',
      a === 'off' ? [[B('🔔 روشن کردن گزارش روزانه', 'px:mb:on', 'success')], [B('🔙 برگشت به منو', 'menu')]] : null);
  }
}
