// The Mini App kept the admin logged in for a while (or logged out): the bot remembers until when, so it can
// send a «🔒 log out now» button when the time is up and the page is closed.
import { EndpointError } from 'sdk';
import * as store from '../lib/store.js';

export default async function (input, ctx) {
  const uid = ctx.initData.user.id;
  if (!(await store.isOwner(uid))) throw new EndpointError('این بخش فقط برای مدیر رباته.', { code: 'NOT_OWNER' });
  const until = Math.floor(Number(input.until) || 0);
  const chat = Number(input.chat) || 0;
  const all = JSON.parse((await store.getSetting('cl_sess')) || '{}');
  if (until > 0) all[uid] = { chat, until, told: false };
  else delete all[uid];
  await store.setSetting('cl_sess', Object.keys(all).length ? JSON.stringify(all) : null);
  return { ok: true };
}
