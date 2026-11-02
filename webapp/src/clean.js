// The Mini App page «🔐 حذف کامل پست‌های قدیمی»: logs in with the admin's own account (bots can't delete
// posts older than 48 hours, people can), finds the channel's posts with the chosen words and deletes them,
// then logs out. Everything runs on the admin's phone: the code and password go only to Telegram.
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { buildMatcher, normalize } from '../../tgcloud/lib/cleantext.js';

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const $ = (id) => document.getElementById(id);
const show = (id) => {
  for (const s of document.querySelectorAll('section')) s.classList.add('hidden');
  $(id).classList.remove('hidden');
};
const fa = (n) => Number(n || 0).toLocaleString('fa-IR');
const err = (id, e) => { $(id).textContent = e ? explain(e) : ''; };

function explain(e) {
  const m = String(e?.errorMessage || e?.message || e);
  if (/API_ID_INVALID|api_id/i.test(m)) return 'api_id یا api_hash درست نیست. دوباره از my.telegram.org کپی کن.';
  if (/PHONE_NUMBER_INVALID/.test(m)) return 'شماره درست نیست. با کد کشور بنویس: +989123456789';
  if (/PHONE_CODE_INVALID/.test(m)) return 'کد اشتباهه.';
  if (/PHONE_CODE_EXPIRED/.test(m)) return 'کد منقضی شد؛ صفحه رو ببند و دوباره باز کن.';
  if (/PASSWORD_HASH_INVALID/.test(m)) return 'رمز دو مرحله‌ای اشتباهه.';
  if (/FLOOD/.test(m)) return 'تلگرام موقتاً محدود کرده؛ چند دقیقه بعد دوباره امتحان کن.';
  if (/CHAT_ADMIN_REQUIRED|MESSAGE_DELETE_FORBIDDEN/.test(m)) return 'این اکانت توی کانال دسترسی حذف پیام نداره.';
  return m;
}

// ---------- the bot's side (owner check, the saved words, recording the result) ----------
function server(name, input) {
  return new Promise((resolve, reject) => {
    if (!tg?.Serverless) return reject(new Error('این صفحه رو از داخل ربات باز کن.'));
    tg.Serverless.call(name, input, (e, r) => (e ? reject(e) : resolve(r)));
  });
}

const params = new URLSearchParams(location.search);
let info = null;
let client = null;
let channel = null;
let found = [];

// one prompt at a time: the login asks, a button answers
let waiting = null;
const ask = (section, field) => new Promise((resolve) => {
  show(section);
  $(field).value = '';
  $(field).focus();
  waiting = resolve;
});
const answer = (field) => { const v = $(field).value.trim(); if (v && waiting) { const w = waiting; waiting = null; w(v); } };

async function boot() {
  try {
    info = await server('cleanInfo', { chat: params.get('c') });
  } catch (e) {
    $('chan').textContent = '';
    for (const s of document.querySelectorAll('section')) s.classList.add('hidden');
    const box = $('s-err-owner');
    box.hidden = false;
    box.textContent = '⛔️ ' + (e?.message || e);
    return;
  }
  const ch = info.channels.find((c) => String(c.id) === String(info.chat));
  $('chan').textContent = '📢 ' + (ch?.title || info.chat);
  const block = info.words.filter((w) => w.kind !== 'allow').map((w) => w.word);
  $('words').value = (block.length ? block : ['روم']).join('\n');
  $('smart').checked = info.smart;
  try {
    const saved = JSON.parse(localStorage.getItem('uf_api') || 'null');
    if (saved) { $('api-id').value = saved.id; $('api-hash').value = saved.hash; }
  } catch {}
  show('s-keys');
}

$('open-my').onclick = (e) => { e.preventDefault(); tg?.openLink ? tg.openLink('https://my.telegram.org/auth') : open('https://my.telegram.org/auth'); };

$('b-keys').onclick = async () => {
  err('e-keys');
  const id = Number($('api-id').value.trim());
  const hash = $('api-hash').value.trim();
  if (!Number.isInteger(id) || id <= 0 || !/^[0-9a-f]{32}$/i.test(hash)) return err('e-keys', 'api_id یه عدده و api_hash یه رشته‌ی ۳۲ حرفی؛ از my.telegram.org کپی کن.');
  try {
    if ($('remember').checked) localStorage.setItem('uf_api', JSON.stringify({ id, hash }));
    else localStorage.removeItem('uf_api');
  } catch {}
  $('b-keys').disabled = true;
  client = new TelegramClient(new StringSession(''), id, hash, {
    connectionRetries: 5, useWSS: true, deviceModel: 'UF Channel Cleaner', appVersion: '1.0', systemVersion: 'Mini App',
  });
  client.setLogLevel('error');
  try {
    await client.start({
      phoneNumber: () => ask('s-phone', 'phone'),
      phoneCode: () => ask('s-code', 'code'),
      password: () => ask('s-pass', 'pass'),
      onError: async (e) => {
        const box = { 's-phone': 'e-phone', 's-code': 'e-code', 's-pass': 'e-pass' }[[...document.querySelectorAll('section')].find((s) => !s.classList.contains('hidden'))?.id] || 'e-keys';
        err(box, e);
        if (/API_ID_INVALID|FLOOD|EXPIRED/.test(String(e?.errorMessage || e?.message))) {
          show('s-keys');
          err('e-keys', e);
          $('b-keys').disabled = false;
          return true; // stop: start over from the keys
        }
        return false; // let the user try again
      },
    });
  } catch (e) {
    show('s-keys');
    $('b-keys').disabled = false;
    if (!/AUTH_USER_CANCEL/.test(String(e?.errorMessage || e?.message))) err('e-keys', e); // else onError already said why
    return;
  }
  await findChannel();
};
$('b-phone').onclick = () => { err('e-phone'); answer('phone'); };
$('b-code').onclick = () => { err('e-code'); answer('code'); };
$('b-pass').onclick = () => { err('e-pass'); answer('pass'); };
for (const [f, b] of [['phone', 'b-phone'], ['code', 'b-code'], ['pass', 'b-pass']]) {
  $(f).addEventListener('keydown', (e) => { if (e.key === 'Enter') $(b).click(); });
}

async function findChannel() {
  const want = String(info.chat).replace(/^-100/, '');
  for await (const d of client.iterDialogs({})) {
    if (d.isChannel && String(d.entity.id) === want) { channel = d.entity; break; }
  }
  if (!channel) {
    show('s-words');
    return err('e-scan', 'این اکانت عضو این کانال نیست. با اکانت ادمین کانال وارد شو.');
  }
  show('s-words');
}

// ---------- search: every post of the channel, matched like the bot does ----------
function bodyOf(m) {
  const parts = [m.message || ''];
  let link = false;
  for (const e of m.entities || []) {
    if (e.url) { parts.push(e.url); link = true; }
    if (e.className === 'MessageEntityUrl') link = true;
  }
  for (const r of m.replyMarkup?.rows || []) {
    for (const b of r.buttons || []) {
      if (b.text) parts.push(b.text);
      if (b.url) { parts.push(b.url); link = true; }
    }
  }
  const poll = m.media?.poll;
  if (poll) parts.push(poll.question?.text || poll.question || '', ...(poll.answers || []).map((a) => a.text?.text || a.text || ''));
  const body = parts.filter(Boolean).join('\n');
  return { body, hasLink: link || /(https?:\/\/|t\.me\/|www\.)/i.test(body), isForward: !!m.fwdFrom };
}

$('b-scan').onclick = async () => {
  err('e-scan');
  if (!channel) return err('e-scan', 'کانال پیدا نشد.');
  const lines = $('words').value.split(/\n|,|،/).map((x) => x.trim()).filter(Boolean);
  const words = lines.map((w, i) => {
    const re = w.match(/^\/(.+)\/$/);
    if (re) return { id: i, word: re[1], mode: 'regex', kind: 'block' };
    if (/^\*.+\*$/.test(w)) return { id: i, word: w.slice(1, -1), mode: 'contains', kind: 'block' };
    return { id: i, word: w.replace(/^"(.+)"$/, '$1'), mode: 'word', kind: 'block' };
  });
  const allow = info.words.filter((w) => w.kind === 'allow').map((w, i) => ({ id: 1000 + i, ...w }));
  const smart = $('smart').checked;
  const blanked = $('blanked').checked;
  if (!words.length && !smart && !blanked) return err('e-scan', 'حداقل یه کلمه بنویس.');
  const match = buildMatcher({ smartRoom: smart }, [...words, ...allow]);

  show('s-scan');
  found = [];
  const reasons = {};
  let seen = 0;
  let total = 0;
  try {
    const top = await client.getMessages(channel, { limit: 1 });
    total = top[0]?.id || 0;
    for await (const m of client.iterMessages(channel, {})) {
      seen++;
      if (seen % 50 === 0 || seen === 1) {
        $('scan-bar').style.width = total ? Math.min(100, ((total - m.id) / total) * 100) + '%' : '50%';
        $('scan-txt').textContent = `${fa(seen)} پست خونده شد · ${fa(found.length)} مورد پیدا شد`;
      }
      if (m.className === 'MessageService') continue;
      const p = bodyOf(m);
      let reason = null;
      if (blanked && normalize(p.body) === '🗑') reason = '🗑 خالی‌شده';
      else {
        const hit = match(p);
        if (hit) reason = hit.reason;
      }
      if (reason) {
        found.push({ id: m.id, reason, snip: p.body.replace(/\s+/g, ' ').slice(0, 60) });
        reasons[reason] = (reasons[reason] || 0) + 1;
      }
    }
  } catch (e) {
    show('s-words');
    return err('e-scan', e);
  }
  $('scan-bar').style.width = '100%';
  $('found').textContent = fa(found.length);
  $('reasons').innerHTML = Object.entries(reasons).sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `• ${r.replace(/[<>&]/g, '')}: ${fa(n)}`).join('<br>') + `<br><br>از ${fa(seen)} پست کانال.`;
  $('b-del').disabled = !found.length;
  $('b-del').textContent = found.length ? `🗑 حذف ${fa(found.length)} پست` : 'پستی پیدا نشد';
  show('s-confirm');
};

// ---------- delete, report to the bot, log out ----------
$('b-del').onclick = async () => {
  if (!found.length) return;
  show('s-del');
  const ids = found.map((x) => x.id);
  const done = [];
  try {
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      await client.deleteMessages(channel, chunk, { revoke: true });
      done.push(...chunk);
      $('del-bar').style.width = (done.length / ids.length) * 100 + '%';
      $('del-txt').textContent = `${fa(done.length)} از ${fa(ids.length)} حذف شد`;
    }
  } catch (e) {
    $('del-txt').textContent = '⚠️ ' + explain(e);
  }
  const ok = new Set(done);
  await finish(found.filter((x) => ok.has(x.id)));
};

$('b-cancel').onclick = () => finish([]);

async function finish(deleted) {
  let loggedOut = false;
  try {
    await client.invoke(new Api.auth.LogOut());
    loggedOut = true;
  } catch {}
  try { await client.disconnect(); } catch {}
  try { await server('cleanReport', { chat: info.chat, items: deleted, loggedOut }); } catch {}
  $('done-n').textContent = fa(deleted.length);
  $('done-lock').textContent = loggedOut
    ? '🔒 از اکانتت خارج شدم و تحویلت دادم؛ هیچ نشستی باز نمونده.'
    : '⚠️ خروج انجام نشد؛ از تنظیمات تلگرام ← Devices نشست «UF Channel Cleaner» رو ببند.';
  show('s-done');
}

$('b-close').onclick = () => tg?.close();

// leaving halfway: still try to log out
window.addEventListener('pagehide', () => { try { client?.invoke(new Api.auth.LogOut()); } catch {} });

boot();
