// Project notes for whoever works on this bot next (an AI assistant or a human). Nothing imports this module;
// it is deployed only so it comes back with every `npx tgcloud pull`. READ THIS FIRST, it saves re-discovering everything.
//
// ===== The bot =====
// @UFDEVILLCNL_bot on Telegram Serverless (app8719466331). Owner (main admin): Telegram id 1689565085 (OWNER in lib/util.js).
// Owner's channel: "UF - TEAM ¦ CHANNEL", chat id -1002864518590 (setting tn_chan = the channel tournament posts go to; '0' = none).
// The owner speaks Persian and wants answers in Persian; wants every admin job inside the Mini App, as little manual work as possible.
// Token: format app8719466331:<secret>. NEVER write it into the project or a repo. The owner pastes it, or it is set as the
// cloud environment secret TGCLOUD_TOKEN. Work: `npm i -D @tgcloud/cli` then `TGCLOUD_TOKEN=… npx tgcloud pull --force`.
// Mini App: https://app8719466331.tgcloud.ai/  — static folder web/ (tgcloud.jsonc: { "static": { "source": "web" } }).
//   web/index.html (old scheduler page, untouched), web/site/ (public promo page), web/tournament/ (the tournament Mini App + assets/).
//   `pull` does NOT bring web/ back: download it first (curl -L https://app8719466331.tgcloud.ai/tournament/ , /site/ , / and
//   every file under tournament/assets/ — list them from .tgcloud/static.json after pull) or a push without it DELETES the site.
//   tgcloud.jsonc is local only too: recreate it as { "static": { "source": "web", "spa": false } } before pushing web/.
// CLI: status · push (code + web/) · migrate --local --dry-run, then --safe (adding columns is safe) · run <module> '{json5}' --ctx '{ initData: { user: { id: 1689565085 } } }'
//   `run` executes the LOCAL file in the cloud against the real DB without deploying: handy for tests and one-off scripts
//   (write tgcloud/endpoints/zzX.js, run it, delete it; never push it).
//
// ===== Tournament system (lib/tournament.js, lib/players.js, lib/schedule.js, endpoints/tournament.js + tadmin.js) =====
// Formats (FORMATS): big 44-80 teams: 4 groups of 20 (A-D, 2 matches, top 10) -> bracket: A+B -> semi-final 1, C+D -> semi-final 2
//   (20 each, 3 matches, top 10; a semi group is drawn as soon as its two feeder groups are done: cfg.feed + drawGroup) -> final 20 (4 matches).
//   18 matches. Play order (fmt.order): A, B, semi 1, C, D, semi 2, final (default plan = 4 nights, 20:30-24:00).
//   fifty 22-50: 2 groups of 25 (open question: the owner may want smaller lobbies here too, ~20). medium 22-40: 2x20 -> final 20. small 8-20: one lobby.
//   Lobbies of 20, not 25: the owner says full rooms lag on Erangel.
// Points PMGC: 1/kill + placement 10,6,5,4,3,2,1,1. Ties: kills, chicken dinners, better rank in the last match.
// Registration: leader via channel post (/start tr_<tid>), team name + tag + own PUBG name/id, invite link for 3 mates; tag must be in every name.
//   Deadline = regDays (1/2/3, default 2, picked in the panel) before the first planned match. Then incomplete teams are removed and the
//   channel gets "N places free, register now" (players.js freePlaces); a team registering after the deadline gets 1 hour (schedule.js LATE).
// Draw: "🎲 start tournament" in the bot -> random groups/slots, every player told group + slot. Group end -> top N advance, others out, all told.
// Per match (admin, all in the Mini App admin tab): 🔑 room id + pass (to EVERY player of the lobby, <code> + copy_text buttons, with slot)
//   -> ▶️ start (map; posts "match started" to tn_chan; ends_at = now + MAP_MIN[map]) -> when time is up the bot asks for the result
//   -> 📸 send result: screenshots, ONE tidy 1..25 image (e.g. made by Google AI), or the list as text; Gemini reads (setting gemini_key),
//   preview, "✍️ rank slot kills" fixes, ✅ confirm -> tables, advance, next draw all automatic.
// Reminders (lib/timer.js tick, every minute if the /timer cron is set, else on every update): players "are you ready?" 1h before a group's
//   matches (callDue), admins 10 min before each match (pingAdmins, plan.pinged), "send the result" after the map time (endReminders, matches.end_pinged).
// Admin tab layout (web/tournament/index.html admin()): ⏭ next match card (steps ① room ② map+start, live timers, result) · 🗓 all matches
//   (folds; tap one to set its day/time = tadmin act 'time') · ⚙️ auto schedule · registration · ready · teams.
//   tadmin acts: get | sched | time | slot | call | reg | drop | room | start | result.
// Stages can overlap (bracket): never gate on t.status === stage; a group is playable when its stage_groups row exists and done = 0.
//
// ===== Test data / history =====
// Tournament 10 "کاپ تست پابجی DEVIL": 80 fake teams (no Telegram ids -> nobody is messaged), round 1 drawn, 18 matches planned from 2026-10-28.
// Tournaments 5 and 6 are old "🧪 نمونه" samples (6 was drawn with the old 4x25 random semi-final layout).
// Tests: never post to the real channel without asking (pick "🔕 no post"/chan '0', then set tn_chan back to -1002864518590).
// The redesigned Mini App came from the owner's zip (Vazirmatn/Teko fonts, Tabler icons, battleground/squad WebP art, arena.css/arena.js).
// PUBG look (assets/pubg.css, after arena.css; the owner's reference: a brushed-metal plate with orange/blue rim light on a dark
//   circuit backdrop): player rows = steel plate (images/plate-steel.webp), team cards = circuit plate (images/plate-circuit.webp),
//   team names in chrome text on steel nameplates (h3.plate: team sheet + my team), page = circuit tile. Textures are generated
//   (no text, no official PUBG logos: trademarked); own filled icons in the game's item style icons/pubg-{helmet,vest,crate,pan,chicken,rifle,medkit,drink,grenade}.svg
//   for empty spots / decor (the owner wants them as close to PUBG's look as possible) and text kept fully readable.
// Each section its own on-theme look: standings/rank rows = olive army camo (images/camo-olive.webp, .board, hexagon ranks,
//   gold/silver/bronze top 3, hazard-stripe qualifying line, steel header) · match result cards = dark game map with a grid
//   (images/map-grid.webp) · schedule = boarding-pass tickets (plane icon, dashed flight path, steel time stub) · rules folds =
//   steel header + olive camo body · top players in results = steel plates like player rows. The standings table is Miramar
//   desert camo (images/camo-sand.webp; the owner asked for it).
// 3D icons everywhere: assets/fx3d.js turns every emoji on the page into a Fluent Emoji 3D icon (assets/3d/*.webp, big/ for art;
//   Microsoft, MIT, licenses/FluentEmoji.txt) and every Persian digit into 0-9 (the owner wants English digits everywhere); fa() is
//   now plain String. Add an emoji: download Fluent's "<Name>/3D/<name>_3d.png", save 96px webp in assets/3d, add it to MAP.
//   Careful: fx3d must never touch <script> text (it once ate the app's own emoji while the page was parsing).
// First-visit intro: assets/intro.js + intro.css, 7 swipe-up chapters built from live data (registration, the bracket via
//   stages[].feed = [{ g, from }] (a list: the platform can't send number-like object keys), a match, points, rules, go).
//   Shown once per device (localStorage devil-intro-v8; bump the version to show it to everyone again), never with ?admin=1;
//   home has "🎬 تماشای راهنمای تورنمنت". Copy is for players (what to do, how a match goes, rules), not how the bot works.
//   Start button plays a sound made with Web Audio; assets/audio/lobby.mp3, if added, plays as music (with a 🔊 toggle).
// The owner's own 3D art (they sent the pictures; backgrounds cut out with rembg): 3d/big/para1-4 = chibi paratroopers drifting in the
//   intro and the header; military_helmet = inferno helmet, skull = skull badge (kills), poultry_leg = golden chicken-dinner trophy,
//   bullseye = target, bar_chart = "1st" crates (stats/table), balance_scale = rusty scale, shield = blue riot shield, parachute = a
//   paratrooper. Every other Fluent icon is re-coloured to their palette (charcoal/rust/olive/khaki/steel + grit) by a gradient map.
//   Intro welcome page (owner's direction): no stats/badges/big tournament name; a "DEVIL ESPORTS" wordmark (DEVIL gold, ESPORTS
//   steel) + one normal-size paragraph. The photo is in depth layers: images/hero-back.webp (soldier painted out, dark fill) and
//   hero-front.webp (the soldier cut out with rembg, faded at the waist); both drift (camera) and follow the phone's tilt, the near
//   one more. The plane (3d/big/plane-rear.webp, their in-game C-130 shot) is big top right in the sky, heading into the scene;
//   it eases ahead/back, bobs and banks (CSS cruise/bob) so it's plainly flying while holding its place. Paratroopers leave its
//   ramp every ~2.3 s, each on its own straight line (toward the soldier, straight, left, right: LINES in intro.js) with a fixed
//   tilt that way, NO swinging, fading out low. The owner rejected: planes crossing the screen, tiny far planes, swinging chutes.
// A gate ("ورود به میدان") opens the intro: that tap is what lets Telegram's browser play the music (it can't autoplay).
// The path chapter's trophy is real 3D (assets/trophy.js, three.js r160 in assets/vendor, MIT): faceted golden glass cup, gold
//   trims, square smoked base engraved "DEVIL ESPORTS" on all sides, turning and floating; picture fallback without WebGL.
//   The same side-view plane is the timeline plane. The start button plays assets/audio/start.mp3 (cut from the owner's video). Buttons: steel sound disc (gold speaker + equaliser,
//   red cross when muted; on by default every time, muting lasts one visit) and a gold-edged "رد کردن" pill (no emoji).
//   assets/audio/lobby.mp3: the owner's file (PUBG main theme, they supplied it): first 60 s, fade in 2 s / out 6 s, level lowered,
//   played quietly (volume .3) in a loop as soon as the intro opens (first touch if the browser blocks it), paused while the app is
//   hidden (visibilitychange + Telegram deactivated/activated) and resumed when back, faded out on "start". Copyrighted: the owner chose to use it.
//   Always "چیکن دینر", never just "چیکن".
export const NOTES = true;
