// A new channel post: the cleaner keeps it in its index and deletes it at once if it has a filtered word.
import { onChannelPost } from '../lib/cleaner.js';

export default async function (m) {
  await onChannelPost(m, false).catch((e) => console.error('cleaner post', e));
}
