// Text helpers: Persian/Arabic normalization, keyword matching, HTML escaping.

const DIACRITICS = /[ً-ٰٟۖ-ۭـ]/g; // harakat + tatweel
const ZW = /[​-‏‪-‮⁦-⁩﻿]/g;  // zero-width / bidi marks
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Normalize text so "روم", "رُوم", "روم" with ZWNJ, Arabic ي/ك … all compare equal. */
export function normalize(input) {
  if (!input) return '';
  let s = String(input).toLowerCase();
  s = s
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[أإٱ]/g, 'ا')
    .replace(/ؤ/g, 'و')
    .replace(/ة/g, 'ه')
    .replace(/‌/g, ' ')   // ZWNJ → space
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
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
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

/** Build a tester for one keyword row → (normalizedText, rawText) => boolean */
export function compileKeyword(kw) {
  if (kw.mode === 'regex') {
    let re;
    try { re = new RegExp(kw.word, 'iu'); } catch { return () => false; }
    return (norm, raw) => re.test(raw) || re.test(norm);
  }
  const w = normalize(kw.word);
  if (!w) return () => false;
  if (kw.mode === 'word') {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(w)}(?![\\p{L}\\p{N}_])`, 'u');
    return (norm) => re.test(norm);
  }
  return (norm) => norm.includes(w);
}

/**
 * Build a matcher for a channel.
 * Returns (post) => reason | null, where post = { body, hasLink, isForward }.
 */
export function buildMatcher(channel, keywordRows) {
  const block = keywordRows.filter((k) => k.kind !== 'allow').map((k) => ({ k, t: compileKeyword(k) }));
  const allow = keywordRows.filter((k) => k.kind === 'allow').map((k) => ({ k, t: compileKeyword(k) }));
  const empty = block.length === 0 && !channel.ruleLinks && !channel.ruleForward;

  const fn = (post) => {
    const raw = post.body || '';
    const norm = normalize(raw);
    for (const a of allow) if (a.t(norm, raw)) return null;   // exception wins
    for (const b of block) if (b.t(norm, raw)) return { keywordId: b.k.id, reason: b.k.word };
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
      if (w.startsWith('"') && w.endsWith('"') && w.length > 2) out.push({ word: w.slice(1, -1), mode: 'word' });
      else out.push({ word: w, mode: 'contains' });
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
