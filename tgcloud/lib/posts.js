// The channel posts: room announcement, framed post, and sending them to the chosen channels.
import { esc, call, LINE } from './util.js';
import { STYLES } from './data.js';
import { user, bumpCount } from './store.js';
import { openGiveaway } from './gv.js';
import { planDelete } from './cleaner.js';
import { revealAt, planReveal, planRemind } from './pubg.js';
import { localStr } from './store.js';

export function build(d) {
  const L = ['✨🎮 <b>درود و خسته نباشید به همگی</b> 🎮✨', '',
    LINE, '🃏 <b>مشخصات روم امشب</b> 🃏', LINE, '',
    `🕗 <b>زمان شروع :</b>  ${esc(d.time)}`, '',
    `🎁 <b>جایزه :</b>  ${esc(d.prize)} 💸 به ${esc(d.winner)} 🏆`, '',
    `🗺 <b>مپ :</b>  ${esc(d.map)} 🔥`, '',
    `👥 <b>حالت روم :</b>  ${esc(d.mode)}`, '',
    LINE, '📜 <b>قوانین روم</b>', '', ...(d.rules || []).map(esc)];
  if (d.room) L.push('', LINE, '🔑 <b>اطلاعات روم</b>', '', `<code>${esc(d.room)}</code>`);
  else if (d.roomAt) L.push('', LINE, '🔑 <b>اطلاعات روم</b>', '', `⏳ آیدی و پسورد ساعت <b>${esc(d.roomAt)}</b> همین‌جا اعلام میشه`);
  if (d.desc) L.push('', LINE, '💬 <b>توضیحات</b>', '', esc(d.desc));
  L.push('', LINE, '📢 <b>شرط دریافت جایزه</b>', '', '😦 حتما برنده باید عضو چنل‌های زیر باشه ⬇️', '⭕️ در غیر اینصورت پرایز تعلق نمیگیره', '');
  L.push(...(d.spons || []).map((x) => '🚀 ' + x), '', '🔥 <b>موفق باشید</b> 🔥');
  return L.join('\n');
}

export function buildBeauty(d) {
  const [top, line, em] = STYLES[d.pstyle] || STYLES.gold;
  return [top, '', `${em} <b>${esc(d.ptitle)}</b> ${em}`, '', line, '', esc(d.pbody), '', line, '', top].join('\n');
}

// A photo caption holds 1024 characters: longer posts go as photo + message.
async function sendText(chat, text, photo, markup) {
  const rm = markup ? { reply_markup: { inline_keyboard: markup } } : {};
  if (photo) {
    if (text.length <= 1000) return call('sendPhoto', { chat_id: chat, photo, caption: text, parse_mode: 'HTML', ...rm });
    const ph = await call('sendPhoto', { chat_id: chat, photo });
    const r = await call('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...rm });
    if (r.ok && ph.ok) r.extra = [ph.result.message_id]; // the banner went as its own message
    return r;
  }
  return call('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...rm });
}

export const sendPost = (chat, d) => sendText(chat, build(d), d.photo);
export const sendBeauty = (chat, d) => sendText(chat, buildBeauty(d), d.photo, d.pbtn ? [[{ text: d.pbtn.t, url: d.pbtn.u }]] : null);

/** Send to every target channel -> [report lines, how many succeeded] */
export async function deliver(uid, base, d, targets, pin) {
  const u = await user(uid);
  const titles = Object.fromEntries(u.channels.map((c) => [String(c.id), c.title]));
  const lines = [];
  let ok = 0;
  for (const t of targets) {
    const title = esc(titles[String(t)] || t);
    let good, err;
    if (base === 'gv') [good, err] = await openGiveaway(uid, t, d, pin);
    else {
      // 🔑 the ID/Pass come later: the post goes out without them
      const at = base === 'room' ? await revealAt(d) : null;
      const shown = at ? { ...d, room: null, roomAt: (await localStr(at)).replace(/^\S+ /, '') } : d;
      const r = await (base === 'post' ? sendBeauty : sendPost)(t, shown);
      if (r.ok && at) await planReveal(t, r.result.message_id, d, at, r.result.caption !== undefined, uid);
      if (r.ok && base === 'room') r.remindAt = await planRemind(t, r.result.message_id, d); // ⏰ chosen in the preview
      good = r.ok;
      err = r.description;
      if (good && pin) await call('pinChatMessage', { chat_id: t, message_id: r.result.message_id });
      if (good && d.autodel > 0) await planDelete(t, [...(r.extra || []), r.result.message_id], d.autodel); // 🕒 chosen in the preview
    }
    if (good) {
      ok++;
      lines.push('✅ ' + title + (base !== 'gv' && d.autodel > 0 ? `\n🕒 ${d.autodel} ساعت بعد خودکار از کانال پاک میشه` : ''));
    } else lines.push(`❌ ${title}\n↳ ${esc(err)}`);
  }
  if (ok) await bumpCount(uid);
  return [lines, ok];
}
