// Called every minute by a cron service (cron-job.org) with the owner's Mini App init data:
// sends the scheduled posts and ends the giveaways that are due. Harmless to call any time.
import { tick } from '../lib/timer.js';
import { autoTick } from '../lib/autopost.js';
import { setSetting } from '../lib/store.js';
import { now } from '../lib/util.js';
import { runJob } from '../lib/cleaner.js';

export default async function () {
  await setSetting('cron_seen', now());
  await tick();
  await autoTick();
  await runJob(12000).catch((e) => console.error('cleaner', e)); // a big channel cleanup goes on in the background
  return { ok: true };
}
