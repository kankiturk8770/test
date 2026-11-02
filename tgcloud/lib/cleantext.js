// Text helpers for the channel cleaner: Persian/Arabic normalization, keyword matching.

const DIACRITICS = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g; // harakat + tatweel
const ZW = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g; // zero-width / bidi marks
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Normalize text so "روم", "رُوم", "روم" with ZWNJ, Arabic ي/ك … all compare equal. */
export function normalize(input) {
  if (!input) return '';
  // NFKC turns fancy letters into plain ones: 𝗥𝗢𝗢𝗠 / 𝚁𝙾𝙾𝙼 / ＲＯＯＭ → room
  let s = String(input).normalize('NFKC').toLowerCase();
  s = s
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[أإٱ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/ة/g, 'ه')
    .replace(/\u200C/g, ' ')   // ZWNJ → space
    .replace(ZW, '')
    .replace(DIACRITICS, '')
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/\s+/g, ' ');
  return s.trim();
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function snippet(s, n = 60) {
  // by whole characters: fancy letters (𝚄𝙵…) and emoji are two UTF-16 units, and cutting one in half
  // makes Telegram reject the whole message
  const t = [...String(s ?? '').replace(/\s+/g, ' ').trim()];
  return t.length > n ? t.slice(0, n - 1).join('') + '…' : t.join('');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Validate a user regex. Returns an error message or null. */
export function regexError(src) {
  try {
    new RegExp(src, 'iu');
    return null;
  } catch (e) {
    return e.message;
  }
}

// The same word in the other language: typing «روم» also finds room / ROOM / R00M, and the other way round.
const ALIASES = [
  ['روم', 'room'], ['پرایز', 'prize'], ['جایزه', 'prize'], ['اسکواد', 'squad'], ['کاستوم', 'custom'],
  ['تورنمنت', 'tournament'], ['یوسی', 'uc'], ['اسپانسر', 'sponsor'], ['قرعه کشی', 'giveaway'], ['پابجی', 'pubg'],
  ['تیم', 'team'], ['مپ', 'map'], ['اسلاید', 'slide'], ['اسلات', 'slot'], ['ریکشن', 'reaction'],
];
const isLatin = (w) => /^[a-z0-9 ]+$/.test(w);
export function variants(word) {
  const w = normalize(word);
  const out = new Set([w]);
  for (const [fa, en] of ALIASES) {
    if (w === fa) out.add(en);
    if (w === en) out.add(fa);
  }
  return [...out].filter(Boolean);
}

// Latin text squeezed: leet digits to letters, everything but a-z dropped: "R 0 0 M", "r.o.o.m", "UF-ROOM" → …room…
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
export function latinSqueeze(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[013457@$]/g, (c) => LEET[c]).replace(/[^a-z]+/g, '');
}

// A Persian word may carry a short suffix (روم‌ها، رومای، رومایه، روماممون) and may be stuck to a few
// common words before it (امشبروم، تاروم، 2روم) — but «پرومیشن», «ترومپ», «بروم» and «نروم» don't count.
const STUCK = '(?:تا|امشب|فردا|یه|این|اون|هر|بعد|قبل|ساعت|دو|سه)';
function wordRe(w) {
  if (isLatin(w)) return new RegExp(`(?<![a-z])${escapeRegex(w)}(?:s|es)?(?![a-z])`, 'u');
  return new RegExp(`(?:(?<!\\p{L})|(?<=(?<!\\p{L})${STUCK}))${escapeRegex(w)}(?:[اهیومتش]\\p{L}{0,4})?(?!\\p{L})`, 'u');
}

/**
 * A tester for one keyword row → (normalizedText, rawText) => boolean
 * mode 'word' (default): the word itself (with suffixes), in Persian and its English form
 * mode 'contains': anywhere, even inside another word · mode 'regex': as written
 */
export function compileKeyword(kw) {
  if (kw.mode === 'regex') {
    let re;
    try { re = new RegExp(kw.word, 'iu'); } catch { return () => false; }
    return (norm, raw) => re.test(raw) || re.test(norm);
  }
  const vs = variants(kw.word);
  if (!vs.length) return () => false;
  const tests = vs.map((w) => {
    if (kw.mode === 'contains') return (norm) => norm.includes(w);
    const re = wordRe(w);
    // English words also hidden as R O O M / R00M / UF-ROOM (4+ letters, so short ones don't hit by chance)
    const sq = isLatin(w) && w.replace(/ /g, '').length >= 4 ? w.replace(/ /g, '') : null;
    return (norm, raw) => re.test(norm) || (sq !== null && latinSqueeze(raw).includes(sq));
  });
  return (norm, raw) => tests.some((t) => t(norm, raw));
}

// ---------- 🧠 smart detection: is this post about a room (custom match)? ----------
// Each clue adds points; 5+ points = a room post, even without the word «روم».
const CLUES = [
  [4, /(?<![\p{L}])(روم|room|کاستوم)|custom(?!\s*dns)/u],
  [3, /(آیدی|ایدی|id)\s*[:：=]?\s*\d{5,}/u],
  [3, /(پسورد|پس ورد|رمز|pass|password)\s*[:：=]/u],
  [2, /(ارنگل|erangel|میرامار|miramar|سانهوک|sanhok|ویکندی|vikendi|لیویک|livik|کاراکین|karakin|نوستا|nusa|رندو|rondo|دستون|deston|tdm|وارهد|warehouse)/u],
  [2, /(یوسی|(?<![a-z])uc(?![a-z])|پرایز|prize|جایزه|mvp)/u],
  [2, /(اسکواد|squad|دو نفره|duo|سولو|solo|اسلاید|slide|اسلات|slot)/u],
  [2, /(ساعت\s*\d|(?<![\d.:])\d{1,2}\s*:\s*\d{2}(?![\d.:])|امشب|فردا شب)/u],
  [1, /(مپ|map|حالت|mode|قوانین|شرکت|ثبت نام|برنده|winner)/u],
];
export function roomScore(norm) {
  let s = 0;
  for (const [w, re] of CLUES) if (re.test(norm)) s += w;
  return s;
}

/**
 * Build a matcher for a channel.
 * Returns (post) => reason | null, where post = { body, hasLink, isForward }.
 */
export function buildMatcher(channel, keywordRows) {
  const block = keywordRows.filter((k) => k.kind !== 'allow').map((k) => ({ k, t: compileKeyword(k) }));
  const allow = keywordRows.filter((k) => k.kind === 'allow').map((k) => ({ k, t: compileKeyword(k) }));
  const empty = block.length === 0 && !channel.ruleLinks && !channel.ruleForward && !channel.smartRoom;

  const fn = (post) => {
    const raw = post.body || '';
    const norm = normalize(raw);
    for (const a of allow) if (a.t(norm, raw)) return null;   // exception wins
    for (const b of block) if (b.t(norm, raw)) return { keywordId: b.k.id, reason: b.k.word };
    if (channel.smartRoom && roomScore(norm) >= 5) return { keywordId: null, reason: '🧠 پست روم' };
    if (channel.ruleLinks && post.hasLink) return { keywordId: null, reason: '🔗 لینک' };
    if (channel.ruleForward && post.isForward) return { keywordId: null, reason: '↪️ فورواردی' };
    return null;
  };
  fn.empty = empty;
  return fn;
}

/** Extract the searchable content of a Message: text/caption + hidden link urls + button urls. */
export function extractPost(m) {
  const parts = [];
  if (m.text) parts.push(m.text);
  if (m.caption) parts.push(m.caption);
  const ents = [...(m.entities || []), ...(m.caption_entities || [])];
  let hasLink = false;
  for (const e of ents) {
    if (e.type === 'text_link' && e.url) { parts.push(e.url); hasLink = true; }
    if (e.type === 'url') hasLink = true;
  }
  const rows = m.reply_markup?.inline_keyboard || [];
  for (const row of rows) for (const b of row) {
    if (b.text) parts.push(b.text);
    if (b.url) { parts.push(b.url); hasLink = true; }
  }
  if (m.poll?.question) parts.push(m.poll.question, ...(m.poll.options || []).map((o) => o.text));
  if (m.document?.file_name) parts.push(m.document.file_name);
  if (m.audio) parts.push(m.audio.title || '', m.audio.performer || '');
  if (!hasLink && /(https?:\/\/|t\.me\/|www\.)/i.test(parts.join(' '))) hasLink = true;
  return {
    body: parts.filter(Boolean).join('\n'),
    hasLink,
    isForward: !!(m.forward_origin || m.forward_from_chat || m.forward_date),
    mediaGroup: m.media_group_id || null,
    date: m.date || 0,
  };
}

/** Parse "keywords" input: one per line or comma-separated. /re/ → regex. */
export function parseKeywordInput(input) {
  const out = [];
  for (const line of String(input).split(/\n/)) {
    const l = line.trim();
    if (!l) continue;
    const m = l.match(/^\/(.+)\/$/);
    if (m) { out.push({ word: m[1], mode: 'regex' }); continue; }
    for (const piece of l.split(/[,،]/)) {
      const w = piece.trim();
      if (!w) continue;
      // default: the word itself (+ suffixes and its English form); *word* = anywhere, even inside other words
      if (w.startsWith('*') && w.endsWith('*') && w.length > 2) out.push({ word: w.slice(1, -1), mode: 'contains' });
      else out.push({ word: w.replace(/^"(.+)"$/, '$1'), mode: 'word' });
    }
  }
  return out.slice(0, 100);
}

export function progressBar(done, total, width = 12) {
  if (!total || total <= 0) return '▱'.repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

export function fmt(n) {
  return Number(n || 0).toLocaleString('en-US');
}
