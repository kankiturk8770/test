// An edited channel post: re-checked against the cleaner's words (an edit can add a filtered word).
import { onChannelPost } from '../lib/cleaner.js';
import { tick } from '../lib/timer.js';
import { heartbeat } from '../lib/heartbeat.js';

export default async function (m) {
  await onChannelPost(m, true).catch((e) => console.error('cleaner edit', e));
  await tick().catch((e) => console.error('tick', e));
  await heartbeat().catch((e) => console.error('beat', e));
}
