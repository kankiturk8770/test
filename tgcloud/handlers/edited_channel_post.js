// An edited channel post: re-checked against the cleaner's words (an edit can add a filtered word).
import { onChannelPost } from '../lib/cleaner.js';

export default async function (m) {
  await onChannelPost(m, true).catch((e) => console.error('cleaner edit', e));
}
