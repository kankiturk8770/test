// Called every minute by a cron service (cron-job.org) with the owner's Mini App init data:
// sends the scheduled posts and ends the giveaways that are due. Harmless to call any time.
import { tick } from '../lib/timer.js';
import { autoTick } from '../lib/autopost.js';
import { setSetting } from '../lib/store.js';
import { now } from '../lib/util.js';
import { sessionTick } from '../lib/cleaner.js';

export default async function () {
  await setSetting('cron_seen', now());
  await tick();
  await autoTick();
  await sessionTick().catch((e) => console.error('session', e));
  return { ok: true };
}
