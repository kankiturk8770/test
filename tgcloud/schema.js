import { table, integer, text, boolean, json, index, primaryKey, sql } from 'sdk/db';

// ─────────────────────────────────────────────────────────────
//  Channel Cleaner — database schema
//  (no foreign keys on this platform: integrity is kept in app code)
// ─────────────────────────────────────────────────────────────

// A channel the bot manages.
export const channels = table('channels', {
  id:          integer('id').primaryKey(),               // Telegram chat id (-100…)
  title:       text('title').notNull(),
  username:    text('username'),
  ownerId:     integer('owner_id').notNull(),            // user who registered it
  autoFilter:  boolean('auto_filter').default(true),     // delete new matching posts instantly
  ruleLinks:   boolean('rule_links').default(false),     // treat any link as a match
  ruleForward: boolean('rule_forward').default(false),   // treat forwarded posts as a match
  notify:      boolean('notify').default(true),          // PM the owner on auto-deletes
  backupChat:  integer('backup_chat'),                   // copy posts here before deleting
  lastKnownId: integer('last_known_id').default(0),      // highest message id we have seen
  deletedCount:integer('deleted_count').default(0),
  // archive scan cursor
  scanNext:    integer('scan_next').default(0),
  scanTo:      integer('scan_to').default(0),
  scanFound:   integer('scan_found').default(0),
  scanActive:  boolean('scan_active').default(false),
  created:     integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// Users allowed to manage a channel (any channel admin who adds it).
export const managers = table('managers', {
  channelId: integer('channel_id').notNull(),
  userId:    integer('user_id').notNull(),
}, (t) => ({
  pk:      primaryKey({ columns: [t.channelId, t.userId] }),
  userIdx: index('idx_managers_user').on(t.userId),
}));

// Filter words. kind = 'block' (delete) | 'allow' (exception, never delete)
// mode = 'contains' | 'word' (whole word) | 'regex'
export const keywords = table('keywords', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  channelId: integer('channel_id').notNull(),
  word:      text('word').notNull(),
  mode:      text('mode').default('contains'),
  kind:      text('kind').default('block'),
  hits:      integer('hits').default(0),
  created:   integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
}, (t) => ({
  chanIdx: index('idx_keywords_channel').on(t.channelId, t.kind),
}));

// Index of channel posts (live posts + archive scan) — this is what makes
// "delete every old post containing X" possible: the Bot API cannot search history.
export const posts = table('posts', {
  channelId:  integer('channel_id').notNull(),
  messageId:  integer('message_id').notNull(),
  body:       text('body'),                 // text/caption + link urls
  mediaGroup: text('media_group'),
  isForward:  boolean('is_forward').default(false),
  hasLink:    boolean('has_link').default(false),
  deleted:    boolean('deleted').default(false),
  date:       integer('date').default(0),
}, (t) => ({
  pk:       primaryKey({ columns: [t.channelId, t.messageId] }),
  aliveIdx: index('idx_posts_alive').on(t.channelId, t.deleted),
  groupIdx: index('idx_posts_group').on(t.channelId, t.mediaGroup),
}));

// Deletion log.
export const logs = table('logs', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  channelId: integer('channel_id').notNull(),
  messageId: integer('message_id').notNull(),
  reason:    text('reason'),
  snippet:   text('snippet'),
  source:    text('source'),                // 'purge' | 'auto' | 'quick'
  at:        integer('at').default(sql`(unixepoch())`),
}, (t) => ({
  chanIdx: index('idx_logs_channel').on(t.channelId, t.at),
}));

// Per-user conversation state (what the bot is waiting for).
export const sessions = table('sessions', {
  userId: integer('user_id').primaryKey(),
  state:  text('state'),
  data:   json('data'),
});
