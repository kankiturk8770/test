// A new channel post: the cleaner keeps it in its index and deletes it at once if it has a filtered word.
import { onChannelPost } from '../lib/cleaner.js';
import { tick } from '../lib/timer.js';
import { heartbeat } from '../lib/heartbeat.js';

export default async function (m) {
  await onChannelPost(m, false).catch((e) => console.error('cleaner post', e));
  await tick().catch((e) => console.error('tick', e));
  await heartbeat().catch((e) => console.error('beat', e));
}
