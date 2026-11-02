// The Mini App's «delete old posts with your own account» page: what to look for in which channel.
// Only the bot's owner and admins. Nothing about the account login passes through here.
import { EndpointError } from 'sdk';
import { db } from 'sdk';
import { sql } from 'sdk/db';
import * as store from '../lib/store.js';
import { cfg } from '../lib/cleaner.js';

export default async function (input, ctx) {
  const uid = ctx.initData.user.id;
  if (!(await store.isOwner(uid))) throw new EndpointError('این بخش فقط برای مدیر رباته.', { code: 'NOT_OWNER' });
  const channels = (await store.user(uid)).channels;
  const chat = Number(input.chat) || channels[0]?.id;
  if (!channels.some((c) => String(c.id) === String(chat))) throw new EndpointError('کانال پیدا نشد.', { code: 'NO_CHANNEL' });
  const c = await cfg(chat);
  const words = await db.all(sql`SELECT word, mode, kind FROM cl_words WHERE chat_id = ${chat} ORDER BY id`);
  return { chat, channels, words, smart: !!c.smart, links: !!c.links, fwd: !!c.fwd };
}
