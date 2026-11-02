// Telegram Serverless has no timer: the bot only runs when something reaches it. So every update
// (a message, a button, a channel post, a giveaway join…) also does the work that is due — scheduled
// posts and giveaways (tick, already on each update), the daily auto-posts and a slice of a running
// «🧽 blank old posts» job — at most once every 40 s, so busy moments don't repeat it. The cron (endpoints/tick)
// still works too when it's set up; nothing depends on it anymore.
import { db } from 'sdk';
import { sql } from 'sdk/db';
import { now } from './util.js';
import { autoTick } from './autopost.js';
import { blankTick, sessionTick, timedTick } from './cleaner.js';
import { revealTick, membersTick, remindTick } from './pubg.js';
import { build } from './posts.js';

export async function heartbeat() {
  const t = now();
  const won = (await db.run(sql`INSERT INTO settings (k, v) VALUES ('beat_at', ${String(t)})
    ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE CAST(settings.v AS INTEGER) <= ${t - 40} RETURNING v`)).rows[0];
  if (!won) return;
  await autoTick().catch((e) => console.error('auto', e));
  await blankTick(8000).catch((e) => console.error('blank', e)); // a running «🧽 blank old posts» goes on
  await sessionTick().catch((e) => console.error('session', e)); // a kept Mini App login whose time is up
  await timedTick().catch((e) => console.error('timed', e)); // 🕒 posts planned to delete themselves
  await revealTick(build).catch((e) => console.error('reveal', e)); // 🔑 room ID/Pass due
  await remindTick().catch((e) => console.error('remind', e)); // ⏰ «15 minutes to the room!»
  await membersTick().catch((e) => console.error('members', e)); // 📈 the daily member report
}
