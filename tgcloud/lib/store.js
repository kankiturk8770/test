// Database access layer.
import { db } from 'sdk';
import { eq, and, desc, asc, inArray, sql } from 'sdk/db';
import { channels, managers, keywords, posts, logs, sessions } from '../schema.js';

// ── sessions ────────────────────────────────────────────────
export async function getSession(userId) {
  return (await db.select().from(sessions).where(eq(sessions.userId, userId)).get()) || null;
}
export async function setSession(userId, state, data = {}) {
  await db.insert(sessions).values({ userId, state, data })
    .onConflictDoUpdate({ target: sessions.userId, set: { state, data } }).run();
}
export async function clearSession(userId) {
  await db.delete(sessions).where(eq(sessions.userId, userId)).run();
}

// ── channels ────────────────────────────────────────────────
export async function getChannel(id) {
  return (await db.select().from(channels).where(eq(channels.id, id)).get()) || null;
}

export async function upsertChannel({ id, title, username, ownerId }) {
  await db.insert(channels).values({ id, title, username: username || null, ownerId })
    .onConflictDoUpdate({ target: channels.id, set: { title, username: username || null } }).run();
  await db.run(sql`INSERT OR IGNORE INTO managers (channel_id, user_id) VALUES (${id}, ${ownerId})`);
}

export async function updateChannel(id, set) {
  await db.update(channels).set(set).where(eq(channels.id, id)).run();
}

export async function bumpLastKnown(id, messageId) {
  await db.run(sql`UPDATE channels SET last_known_id = max(coalesce(last_known_id, 0), ${messageId}) WHERE id = ${id}`);
}

export async function addDeletedCount(id, n) {
  if (n > 0) await db.run(sql`UPDATE channels SET deleted_count = coalesce(deleted_count, 0) + ${n} WHERE id = ${id}`);
}

export async function removeChannel(id) {
  await db.delete(keywords).where(eq(keywords.channelId, id)).run();
  await db.delete(posts).where(eq(posts.channelId, id)).run();
  await db.delete(logs).where(eq(logs.channelId, id)).run();
  await db.delete(managers).where(eq(managers.channelId, id)).run();
  await db.delete(channels).where(eq(channels.id, id)).run();
}

export async function userChannels(userId) {
  return db.all(sql`
    SELECT c.id, c.title, c.username, c.auto_filter AS autoFilter, c.deleted_count AS deletedCount
    FROM channels c JOIN managers m ON m.channel_id = c.id
    WHERE m.user_id = ${userId}
    ORDER BY c.title`);
}

export async function isManager(channelId, userId) {
  const r = await db.get(sql`SELECT 1 AS ok FROM managers WHERE channel_id = ${channelId} AND user_id = ${userId}`);
  return !!r;
}

export async function channelManagers(channelId) {
  const rows = await db.all(sql`SELECT user_id AS userId FROM managers WHERE channel_id = ${channelId}`);
  return rows.map((r) => r.userId);
}

// ── keywords ────────────────────────────────────────────────
export async function listKeywords(channelId, kind) {
  const where = kind ? and(eq(keywords.channelId, channelId), eq(keywords.kind, kind)) : eq(keywords.channelId, channelId);
  return db.select().from(keywords).where(where).orderBy(asc(keywords.id)).all();
}

export async function addKeywords(channelId, kind, items) {
  const existing = new Set((await listKeywords(channelId, kind)).map((k) => k.word.toLowerCase() + '|' + k.mode));
  let added = 0;
  for (const it of items) {
    const key = it.word.toLowerCase() + '|' + it.mode;
    if (existing.has(key)) continue;
    existing.add(key);
    await db.insert(keywords).values({ channelId, word: it.word, mode: it.mode, kind }).run();
    added++;
  }
  return added;
}

export async function getKeyword(id) {
  return (await db.select().from(keywords).where(eq(keywords.id, id)).get()) || null;
}
export async function deleteKeyword(id) {
  await db.delete(keywords).where(eq(keywords.id, id)).run();
}
export async function clearKeywords(channelId, kind) {
  await db.delete(keywords).where(and(eq(keywords.channelId, channelId), eq(keywords.kind, kind))).run();
}
export async function setKeywordMode(id, mode) {
  await db.update(keywords).set({ mode }).where(eq(keywords.id, id)).run();
}
export async function addHits(hitMap) {
  for (const [id, n] of Object.entries(hitMap)) {
    if (id !== 'null' && n > 0) await db.run(sql`UPDATE keywords SET hits = coalesce(hits, 0) + ${n} WHERE id = ${Number(id)}`);
  }
}

// ── posts index ─────────────────────────────────────────────
export async function savePost(channelId, messageId, p) {
  await db.run(sql`
    INSERT INTO posts (channel_id, message_id, body, media_group, is_forward, has_link, deleted, date)
    VALUES (${channelId}, ${messageId}, ${p.body || ''}, ${p.mediaGroup || null},
            ${p.isForward ? 1 : 0}, ${p.hasLink ? 1 : 0}, 0, ${p.date || 0})
    ON CONFLICT(channel_id, message_id) DO UPDATE SET
      body = excluded.body,
      media_group = coalesce(excluded.media_group, posts.media_group),
      is_forward = excluded.is_forward,
      has_link = excluded.has_link`);
}

export async function markDeleted(channelId, ids) {
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    await db.update(posts).set({ deleted: true })
      .where(and(eq(posts.channelId, channelId), inArray(posts.messageId, chunk))).run();
  }
}

/** Page through live (not deleted) indexed posts, by message id. */
export async function alivePostsPage(channelId, afterId, limit = 500) {
  const rows = await db.all(sql`
    SELECT message_id AS messageId, body, media_group AS mediaGroup,
           is_forward AS isForward, has_link AS hasLink
    FROM posts
    WHERE channel_id = ${channelId} AND deleted = 0 AND message_id > ${afterId}
    ORDER BY message_id LIMIT ${limit}`);
  return rows.map((r) => ({ ...r, isForward: !!r.isForward, hasLink: !!r.hasLink }));
}

export async function groupSiblings(channelId, mediaGroups) {
  const groups = [...new Set(mediaGroups.filter(Boolean))];
  if (!groups.length) return [];
  const rows = await db.select({ messageId: posts.messageId }).from(posts)
    .where(and(eq(posts.channelId, channelId), eq(posts.deleted, false), inArray(posts.mediaGroup, groups))).all();
  return rows.map((r) => r.messageId);
}

export async function postStats(channelId) {
  const r = await db.get(sql`
    SELECT count(*) AS total,
           sum(CASE WHEN deleted = 0 THEN 1 ELSE 0 END) AS alive,
           max(message_id) AS maxId,
           min(message_id) AS minId
    FROM posts WHERE channel_id = ${channelId}`);
  return { total: r?.total || 0, alive: r?.alive || 0, maxId: r?.maxId || 0, minId: r?.minId || 0 };
}

// ── logs ────────────────────────────────────────────────────
export async function addLogs(channelId, entries, source) {
  for (const e of entries.slice(0, 300)) {
    await db.insert(logs).values({ channelId, messageId: e.messageId, reason: e.reason, snippet: e.snippet, source }).run();
  }
  // keep the log table bounded per channel
  await db.run(sql`DELETE FROM logs WHERE channel_id = ${channelId} AND id NOT IN
    (SELECT id FROM logs WHERE channel_id = ${channelId} ORDER BY id DESC LIMIT 500)`);
}

export async function recentLogs(channelId, limit = 15) {
  return db.select().from(logs).where(eq(logs.channelId, channelId)).orderBy(desc(logs.id)).limit(limit).all();
}

export async function logStats(channelId) {
  return db.all(sql`SELECT source, count(*) AS n FROM logs WHERE channel_id = ${channelId} GROUP BY source`);
}
