// handlers/channel_post.js — every new channel post: index it, auto-filter it.
import { handleChannelPost } from '../lib/engine.js';

export default async function (message) {
  try {
    await handleChannelPost(message, false);
  } catch (e) {
    console.error(e);
  }
}
