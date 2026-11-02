// "👮 ادمین‌ها": the main owner adds admins with a one-time invite link (valid 1 hour) and removes them.
// An admin manages everything the owner does, except this list.
import { esc, btn, send, call, now } from './util.js';
import * as store from './store.js';

const LIFE = 3600;
const code = () => [...crypto.getRandomValues(new Uint8Array(9))].map((x) => 'abcdefghijkmnpqrstuvwxyz23456789'[x % 32]).join('');

async function botName() {
  return (await store.getSetting('bot_username')) || (await call('getMe', {})).result?.username;
}

export async function adminPanel(uid) {
  if (!store.isMainOwner(uid)) return send(uid, '⛔️ فقط ادمین اصلی ادمین‌ها رو مدیریت می‌کنه.');
  const list = await store.admins();
  const text = '👮 <b>ادمین‌ها</b>\n\n' +
    (list.length ? list.map((a, i) => `${i + 1}. ${esc(a.name || 'ادمین')} · <code>${a.id}</code>`).join('\n') : 'هنوز ادمینی اضافه نکردی.') +
    '\n\nادمین‌ها همه‌ی بخش‌های ربات رو مدیریت می‌کنن (تورنمنت، قرعه‌کشی، پست‌ها، کانال‌ها)؛ فقط این لیست دست خودته.';
  return send(uid, text, [
    [btn('➕ افزودن ادمین', 'adm:new')],
    ...list.map((a) => [btn(`🗑 حذف ${a.name || a.id}`, `adm:del:${a.id}`)]),
    [btn('🔙 برگشت به منو', 'menu')],
  ]);
}

/** adm:new / adm:del:<id> / adm:del!:<id> (main owner only) */
export async function adminAction(uid, data) {
  if (!store.isMainOwner(uid)) return send(uid, '⛔️ فقط ادمین اصلی ادمین‌ها رو مدیریت می‌کنه.');
  if (data === 'adm:new') {
    const c = code();
    await store.setSetting('admin_invite', JSON.stringify({ c, until: now() + LIFE }));
    return send(uid, '➕ <b>لینک ادمین شدن</b>\n\nاین لینک رو برای دوستت بفرست. با زدنش ادمین ربات میشه.\n\n' +
      `<code>https://t.me/${await botName()}?start=adm_${c}</code>\n\n⏳ فقط ۱ ساعت و فقط برای یه نفر کار می‌کنه. لینک جدید بسازی، قبلی باطل میشه.`,
    [[btn('🔙 برگشت به ادمین‌ها', 'adm')]]);
  }
  const m = data.match(/^adm:del(!?):(\d+)$/);
  if (m) {
    const list = await store.admins();
    const a = list.find((x) => String(x.id) === m[2]);
    if (!a) return adminPanel(uid);
    if (!m[1]) return send(uid, `❓ «${esc(a.name || a.id)}» از ادمین‌ها حذف بشه؟`, [[btn('✅ آره، حذف کن', `adm:del!:${a.id}`), btn('❌ نه', 'adm')]]);
    await store.setAdmins(list.filter((x) => String(x.id) !== m[2]));
    await store.admins();
    await send(a.id, 'ℹ️ دسترسی ادمینی تو از ربات برداشته شد.', false);
    return adminPanel(uid);
  }
  return adminPanel(uid);
}

/** /start adm_<code> */
export async function adminJoin(uid, from, c) {
  const inv = JSON.parse((await store.getSetting('admin_invite')) || 'null');
  if (!inv || inv.c !== c || inv.until < now()) return send(uid, '⛔️ این لینک ادمین باطل شده یا وقتش تموم شده.', false);
  await store.setSetting('admin_invite', null); // one person only
  if (await store.isOwner(uid)) return send(uid, 'ℹ️ تو از قبل ادمینی.', [[btn('🏠 منو', 'menu')]]);
  const name = [from?.first_name, from?.last_name].filter(Boolean).join(' ').slice(0, 40) || String(uid);
  await store.setAdmins([...(await store.admins()), { id: uid, name }]);
  await store.admins();
  await send(store.OWNER_ID, `👮 <b>${esc(name)}</b> ادمین ربات شد.`, [[btn('👮 ادمین‌ها', 'adm')]]);
  return send(uid, '✅ <b>تو ادمین ربات شدی!</b>\n\nحالا همه‌ی بخش‌های مدیریت ربات رو داری.', [[btn('🏠 منو', 'menu')]]);
}
