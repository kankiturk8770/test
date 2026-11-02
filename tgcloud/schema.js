import { table, integer, text, index, uniqueIndex } from 'sdk/db';

// Admins who use the bot. pin: pin new posts by default; spons: last sponsor list (JSON).
export const users = table('users', {
  id:      integer('id').primaryKey(),
  name:    text('name'),
  pin:     integer('pin').default(1),
  count:   integer('count').default(0),
  spons:   text('spons'),
  created: integer('created'),
});

// Channels / groups an admin connected (the bot is admin there).
export const channels = table('channels', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  userId:  integer('user_id').notNull(),
  chatId:  integer('chat_id').notNull(),
  title:   text('title'),
}, (t) => ({
  uniq: uniqueIndex('uidx_channel').on(t.userId, t.chatId),
}));

// What a user is doing right now: the post being built (JSON), or what the bot waits for.
export const sessions = table('sessions', {
  userId: integer('user_id').primaryKey(),
  v:      text('v'),
});

// Scheduled posts. kind: room | post | gv ; data / targets are JSON.
export const jobs = table('jobs', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  userId:  integer('user_id').notNull(),
  kind:    text('kind').notNull(),
  due:     integer('due').notNull(),
  targets: text('targets').notNull(),
  pin:     integer('pin').default(0),
  data:    text('data').notNull(),
}, (t) => ({
  byDue: index('idx_jobs_due').on(t.due),
}));

// Giveaways posted in a channel. data: prize, winners, cap, sponsors, … (JSON);
// status: open | done | cancel ; winners: JSON list of the drawn participants.
export const giveaways = table('giveaways', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  owner:   integer('owner').notNull(),
  chatId:  integer('chat_id').notNull(),
  msgId:   integer('msg_id'),
  data:    text('data').notNull(),
  status:  text('status').notNull(),
  endsAt:  integer('ends_at'),
  winners: text('winners'),
  created: integer('created'),
}, (t) => ({
  byOwner: index('idx_gv_owner').on(t.owner, t.status),
  byEnd:   index('idx_gv_end').on(t.status, t.endsAt),
}));

// One row per participant; the unique index makes a double tap harmless.
export const entries = table('entries', {
  id:     integer('id').primaryKey({ autoIncrement: true }),
  gid:    integer('gid').notNull(),
  userId: integer('user_id').notNull(),
  name:   text('name'),
  un:     text('un'),
}, (t) => ({
  uniq: uniqueIndex('uidx_entry').on(t.gid, t.userId),
}));

// Bot settings: owner, tz, gemini_key, timer state, …
export const settings = table('settings', {
  k: text('k').primaryKey(),
  v: text('v'),
});

// Automatic posts: news items already used (so nothing repeats), and drafts waiting for the owner's OK.
export const seen = table('seen', {
  k:  text('k').primaryKey(),
  ts: integer('ts'),
});

// kind: news | char ; photo: Telegram file_id once shown to the owner ; status: wait | sent | drop
export const drafts = table('drafts', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  kind:    text('kind').notNull(),
  caption: text('caption').notNull(),
  photo:   text('photo'),
  status:  text('status').notNull(),
  created: integer('created'),
});

// Score predictions for a giveaway's match: one per person, final once sent.
export const predictions = table('predictions', {
  id:     integer('id').primaryKey({ autoIncrement: true }),
  gid:    integer('gid').notNull(),
  userId: integer('user_id').notNull(),
  name:   text('name'),
  un:     text('un'),
  a:      integer('a').notNull(),
  b:      integer('b').notNull(),
  ts:     integer('ts').notNull(),
}, (t) => ({
  uniq: uniqueIndex('uidx_prediction').on(t.gid, t.userId),
}));

// A score someone is setting with ➕/➖ under a channel post, until they press "send".
export const pdrafts = table('pdrafts', {
  id:     integer('id').primaryKey({ autoIncrement: true }),
  gid:    integer('gid').notNull(),
  userId: integer('user_id').notNull(),
  a:      integer('a').notNull(),
  b:      integer('b').notNull(),
}, (t) => ({
  uniq: uniqueIndex('uidx_pdraft').on(t.gid, t.userId),
}));

// ---------- PUBG Mobile tournament (lib/tournament.js) ----------
// Everything about a tournament lives in these tables, never in the AI's memory: a restart loses nothing.

// One row per tournament. status: REG (registration) | ROUND_1 | SEMI_FINAL | FINAL | DONE
export const tournaments = table('tournaments', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  name:    text('name').notNull(),
  status:  text('status').notNull(),
  regOpen: integer('reg_open').default(1),
  format:  text('format').default('big'), // big | medium | small (lib/tournament.js FORMATS)
  sched:   text('sched'), // the schedule's settings (JSON, lib/schedule.js)
  created: integer('created'),
});

// current_stage: ROUND_1 | SEMI_FINAL | FINAL | ELIMINATED | CHAMPION ; group_name / slot_number: the current lobby.
export const teams = table('teams', {
  teamId:       integer('team_id').primaryKey({ autoIncrement: true }),
  tournamentId: integer('tournament_id').notNull(),
  teamName:     text('team_name').notNull(),
  iglName:      text('igl_name').notNull(),
  clanTag:      text('clan_tag'),
  leaderChatId: integer('leader_chat_id'),
  leaderUn:     text('leader_un'), // the leader's @username (kept in the bot only, never shown)
  members:      text('members'), // JSON list of the players' in-game names, the leader first
  status:       text('status').default('ok'), // pending (waiting for its players, invite link) | ok
  invite:       text('invite'), // the teammates' invite code (t.me/<bot>?start=tj_<code>)
  inviteUntil:  integer('invite_until'), // the players' deadline (a day before the first match); a team still pending then is removed
  reminded:     integer('reminded').default(0), // the "your team isn't complete" reminder went out
  currentStage: text('current_stage').notNull(),
  groupName:    text('group_name'),
  slotNumber:   integer('slot_number'),
  created:      integer('created'),
}, (t) => ({
  uniqName: uniqueIndex('uidx_team_name').on(t.tournamentId, t.teamName),
  byGroup:  index('idx_team_group').on(t.tournamentId, t.currentStage, t.groupName),
  byLeader: index('idx_team_leader').on(t.leaderChatId),
}));

// Who played in which group of which stage (kept after the team moves on, so old tables stay right).
// final_rank / qualified: set once when the group's last match is confirmed.
export const groupMembers = table('group_members', {
  id:           integer('id').primaryKey({ autoIncrement: true }),
  tournamentId: integer('tournament_id').notNull(),
  stage:        text('stage').notNull(),
  groupName:    text('group_name').notNull(),
  teamId:       integer('team_id').notNull(),
  slotNumber:   integer('slot_number').notNull(),
  finalRank:    integer('final_rank'),
  qualified:    integer('qualified'),
}, (t) => ({
  uniq:   uniqueIndex('uidx_gm_team').on(t.tournamentId, t.stage, t.teamId),
  bySlot: uniqueIndex('uidx_gm_slot').on(t.tournamentId, t.stage, t.groupName, t.slotNumber),
}));

// A group of a stage; done = 1 once its results are final (the switch happens only once).
export const stageGroups = table('stage_groups', {
  id:           integer('id').primaryKey({ autoIncrement: true }),
  tournamentId: integer('tournament_id').notNull(),
  stage:        text('stage').notNull(),
  groupName:    text('group_name').notNull(),
  done:         integer('done').default(0),
}, (t) => ({
  uniq: uniqueIndex('uidx_stage_group').on(t.tournamentId, t.stage, t.groupName),
}));

// draft: the admin's manual fixes before confirming (JSON { rank: { team_id, kills } | null }).
export const matches = table('matches', {
  matchId:      integer('match_id').primaryKey({ autoIncrement: true }),
  tournamentId: integer('tournament_id').notNull(),
  stage:        text('stage').notNull(),
  groupName:    text('group_name').notNull(),
  matchNumber:  integer('match_number').notNull(),
  mapName:      text('map_name'),
  isConfirmed:  integer('is_confirmed').default(0),
  draft:        text('draft'),
  room:         text('room'),
  startsAt:     integer('starts_at'), // the time the admin set; players get "are you ready?"
  created:      integer('created'),
  confirmedAt:  integer('confirmed_at'),
  startedAt:    integer('started_at'), // "▶️ start" in the Mini App's admin tab: the game really began
  endsAt:       integer('ends_at'), // about when it ends (by the map); the admin gets "send the result" then
  startedBy:    integer('started_by'),
  endPinged:    integer('end_pinged').default(0),
}, (t) => ({
  uniq: uniqueIndex('uidx_match').on(t.tournamentId, t.stage, t.groupName, t.matchNumber),
}));

// One row per team per confirmed match; points are computed in code (PMGC table), never by the AI.
export const matchScores = table('match_scores', {
  id:               integer('id').primaryKey({ autoIncrement: true }),
  matchId:          integer('match_id').notNull(),
  teamId:           integer('team_id').notNull(),
  placementRank:    integer('placement_rank').notNull(),
  kills:            integer('kills').notNull(),
  placementPoints:  integer('placement_points').notNull(),
  totalMatchPoints: integer('total_match_points').notNull(),
}, (t) => ({
  uniqTeam: uniqueIndex('uidx_score_team').on(t.matchId, t.teamId),
  uniqRank: uniqueIndex('uidx_score_rank').on(t.matchId, t.placementRank),
}));

// Scoreboard screenshots of a match and what the AI read from each (rows: JSON list). status: ok | err
export const shots = table('shots', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  matchId: integer('match_id').notNull(),
  fileId:  text('file_id').notNull(),
  rows:    text('rows'),
  status:  text('status').notNull(),
  error:   text('error'),
  created: integer('created'),
}, (t) => ({
  byMatch: index('idx_shots_match').on(t.matchId),
}));

// Kills of each player in a confirmed match (from the scoreboard), for the players' stats in the Mini App.
export const playerScores = table('player_scores', {
  id:         integer('id').primaryKey({ autoIncrement: true }),
  matchId:    integer('match_id').notNull(),
  teamId:     integer('team_id').notNull(),
  playerName: text('player_name').notNull(),
  kills:      integer('kills').notNull(),
}, (t) => ({
  byTeam: index('idx_ps_team').on(t.teamId),
  byMatch: index('idx_ps_match').on(t.matchId),
}));

// The players of a team (registration with an invite link): Telegram id kept in the bot only, never shown.
// role: leader | member
export const teamPlayers = table('team_players', {
  id:           integer('id').primaryKey({ autoIncrement: true }),
  tournamentId: integer('tournament_id').notNull(),
  teamId:       integer('team_id').notNull(),
  userId:       integer('user_id').notNull(),
  pubgName:     text('pubg_name').notNull(),
  pubgId:       text('pubg_id').notNull(),
  role:         text('role').notNull(),
  created:      integer('created'),
}, (t) => ({
  uniqUser: uniqueIndex('uidx_tp_user').on(t.tournamentId, t.userId),
  uniqPubg: uniqueIndex('uidx_tp_pubg').on(t.tournamentId, t.pubgId),
  byTeam:   index('idx_tp_team').on(t.teamId),
}));

// "✅ we're ready" for a match, one row per team
export const matchReady = table('match_ready', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  matchId: integer('match_id').notNull(),
  teamId:  integer('team_id').notNull(),
  ts:      integer('ts'),
}, (t) => ({
  uniq: uniqueIndex('uidx_ready').on(t.matchId, t.teamId),
}));

// The match schedule (lib/schedule.js): each group plays its matches back to back, then the next group.
// called = 1 once the leaders got "are you ready?" for it.
export const plan = table('plan', {
  id:           integer('id').primaryKey({ autoIncrement: true }),
  tournamentId: integer('tournament_id').notNull(),
  stage:        text('stage').notNull(),
  groupName:    text('group_name').notNull(),
  matchNumber:  integer('match_number').notNull(),
  startsAt:     integer('starts_at').notNull(),
  called:       integer('called').default(0),
  pinged:       integer('pinged').default(0), // the admins got "10 minutes to this match"

}, (t) => ({
  uniq:  uniqueIndex('uidx_plan').on(t.tournamentId, t.stage, t.groupName, t.matchNumber),
  byDue: index('idx_plan_due').on(t.called, t.startsAt),
}));

// ---------- 🧹 channel cleaner (lib/cleaner.js) ----------
// Filter words per channel. kind: block (delete posts with it) | allow (never delete); mode: contains | word | regex
export const clWords = table('cl_words', {
  id:     integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  word:   text('word').notNull(),
  mode:   text('mode').default('contains'),
  kind:   text('kind').default('block'),
  hits:   integer('hits').default(0),
}, (t) => ({
  byChat: index('idx_cl_words_chat').on(t.chatId, t.kind),
}));

// Index of channel posts (live posts + the archive scan): the Bot API can't search a channel's history.
export const clPosts = table('cl_posts', {
  id:     integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  msgId:  integer('msg_id').notNull(),
  body:   text('body'),
  mgroup: text('mgroup'),
  fwd:    integer('fwd').default(0),
  link:   integer('link').default(0),
  gone:   integer('gone').default(0),
  date:   integer('date'), // when it was posted (Telegram lets a bot delete only the last 48 hours)
}, (t) => ({
  uniq:   uniqueIndex('uidx_cl_post').on(t.chatId, t.msgId),
  alive:  index('idx_cl_posts_alive').on(t.chatId, t.gone, t.msgId),
  byGrp:  index('idx_cl_posts_group').on(t.chatId, t.mgroup),
}));

// What was deleted. src: purge | auto | quick | scan
export const clLogs = table('cl_logs', {
  id:     integer('id').primaryKey({ autoIncrement: true }),
  chatId: integer('chat_id').notNull(),
  msgId:  integer('msg_id').notNull(),
  reason: text('reason'),
  snip:   text('snip'),
  src:    text('src'),
  at:     integer('at'),
}, (t) => ({
  byChat: index('idx_cl_logs_chat').on(t.chatId, t.id),
}));
