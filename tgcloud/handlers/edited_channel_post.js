// handlers/edited_channel_post.js — a post was edited: re-index and re-check filters.
import { handleChannelPost } from '../lib/engine.js';

export default async function (message) {
  try {
    await handleChannelPost(message, true);
  } catch (e) {
    console.error(e);
  }
}
