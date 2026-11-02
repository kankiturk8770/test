// The Mini App deleted old posts with the admin's own account: record it like the bot's own deletions.
import { EndpointError } from 'sdk';
import { db } from 'sdk';
import { sql } from 'sdk/db';
import * as store from '../lib/store.js';
import { cfg } from '../lib/cleaner.js';
import { esc, send, now } from '../lib/util.js';

export default async function (input, ctx) {
  const uid = ctx.initData.user.id;
  if (!(await store.isOwner(uid))) throw new EndpointError('این بخش فقط برای مدیر رباته.', { code: 'NOT_OWNER' });
  const chat = Number(input.chat);
  if (!(await store.user(uid)).channels.some((c) => String(c.id) === String(chat))) throw new EndpointError('کانال پیدا نشد.', { code: 'NO_CHANNEL' });
  const items = (Array.isArray(input.items) ? input.items : []).slice(0, 20000)
    .filter((x) => Number.isInteger(x?.id) && x.id > 0);
  for (const x of items) {
    await db.run(sql`UPDATE cl_posts SET gone = 1 WHERE chat_id = ${chat} AND msg_id = ${x.id}`);
    await db.run(sql`INSERT INTO cl_logs (chat_id, msg_id, reason, snip, src, at) VALUES (${chat}, ${x.id}, ${String(x.reason || '').slice(0, 40)}, ${String(x.snip || '').slice(0, 80)}, 'user', ${now()})`);
  }
  await db.run(sql`DELETE FROM cl_logs WHERE chat_id = ${chat} AND id NOT IN (SELECT id FROM cl_logs WHERE chat_id = ${chat} ORDER BY id DESC LIMIT 500)`);
  const c = await cfg(chat);
  await store.setSetting(`cl:${chat}`, JSON.stringify({ ...c, deleted: (c.deleted || 0) + items.length }));
  const title = (await db.get(sql`SELECT title FROM channels WHERE chat_id = ${chat} LIMIT 1`))?.title || '';
  await send(uid, `🔐 <b>حذف کامل پست‌های قدیمی</b>\n📢 ${esc(title)}\n\n✅ <b>${items.length.toLocaleString('en-US')}</b> پست با اکانت خودت از کانال حذف شد.\n` +
    (input.loggedOut ? '🔒 اکانتت از برنامه خارج شد و تحویلت داده شد.' : '⚠️ خروج از اکانت انجام نشد؛ از تنظیمات تلگرام ← Devices اون نشست رو ببند.'),
  [[{ text: '🧹 پنل پاکسازی', callback_data: `cf:p:${chat}` }]]);
  return { ok: true, recorded: items.length };
}
