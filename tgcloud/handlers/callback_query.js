// handlers/callback_query.js — every inline-button press lands here.
import { api } from 'sdk';
import * as store from '../lib/store.js';
import * as ui from '../lib/ui.js';
import * as app from '../lib/app.js';
import * as engine from '../lib/engine.js';
import { escapeHtml, fmt } from '../lib/text.js';

const TOGGLES = new Set(['autoFilter', 'ruleLinks', 'ruleForward', 'notify']);
const LONG = new Set(['pv', 'pg', 'py', 'qy', 'sb', 'sr', 'sd', 'stt']);

export default async function (q) {
  const user = q.from;
  const msg = q.message;
  const data = q.data || '';
  if (!msg) return toast(q, '');
  const chatId = msg.chat.id;
  const mid = msg.message_id;
  const [act, a1, a2, a3] = data.split(':');

  let answered = false;
  const answer = async (text = '', alert = false) => {
    if (answered) return;
    answered = true;
    await toast(q, text, alert);
  };
  if (LONG.has(act)) await answer('⏳ لطفاً صبر کنید…');

  try {
    // ── menus without a channel ─────────────────────────────
    if (act === 'noop') return await answer();
    if (act === 'menu') {
      await store.clearSession(user.id);
      if (a1 === 'home') await app.home(user, chatId, mid);
      else if (a1 === 'channels') await app.channels(user, chatId, mid);
      else if (a1 === 'add') {
        await store.setSession(user.id, 'add_channel');
        await app.render(chatId, mid, ui.addChannelHelp());
      } else if (a1 === 'help') await app.render(chatId, mid, ui.helpText());
      else if (a1 === 'commands') await app.render(chatId, mid, ui.commandsText());
      return await answer();
    }

    // ── keyword-level actions ───────────────────────────────
    if (act === 'kv' || act === 'km' || act === 'kd') {
      const kw = await store.getKeyword(Number(a1));
      if (!kw) return await answer('این کلمه دیگر وجود ندارد.');
      if (!(await store.isManager(kw.channelId, user.id))) return await answer('⛔️ دسترسی ندارید.', true);
      const ch = await store.getChannel(kw.channelId);
      if (act === 'kv') {
        return await answer(`«${kw.word}» — حالت: ${kw.mode} — ${fmt(kw.hits)} حذف`, true);
      }
      if (act === 'km') {
        if (kw.mode === 'regex') return await answer('حالت Regex قابل تغییر نیست.');
        const mode = kw.mode === 'word' ? 'contains' : 'word';
        await store.setKeywordMode(kw.id, mode);
        await app.keywordList(ch, kw.kind, Number(a2) || 0, chatId, mid);
        return await answer(mode === 'word' ? '🔁 کلمهٔ کامل' : '🔁 شامل');
      }
      await store.deleteKeyword(kw.id);
      await app.keywordList(ch, kw.kind, Number(a2) || 0, chatId, mid);
      return await answer('🗑 حذف شد');
    }

    // ── channel-level actions ───────────────────────────────
    const chId = Number(a1);
    if (!chId) return await answer();
    if (!(await store.isManager(chId, user.id))) return await answer('⛔️ شما مدیر این کانال نیستید.', true);
    let ch = await store.getChannel(chId);
    if (!ch) return await answer('کانال پیدا نشد.', true);

    switch (act) {
      case 'ch':
        await store.clearSession(user.id);
        await app.panel(ch, chatId, mid);
        break;

      case 'kw':
        await store.clearSession(user.id);
        await app.keywordList(ch, a2 === 'allow' ? 'allow' : 'block', Number(a3) || 0, chatId, mid);
        break;

      case 'ka': {
        const kind = a2 === 'allow' ? 'allow' : 'block';
        await store.setSession(user.id, 'add_kw', { ch: chId, kind });
        await app.render(chatId, mid, ui.addKeywordPrompt(ch, kind));
        break;
      }

      case 'kc':
        await app.render(chatId, mid, {
          text: `⚠️ همهٔ ${a2 === 'allow' ? 'استثناها' : 'کلمات فیلتر'} این کانال پاک شوند؟`,
          reply_markup: ui.kb([ui.red('🧹 بله، پاک کن', `kcy:${chId}:${a2}`), ui.green('✖️ خیر', `kw:${chId}:${a2}:0`)]),
        });
        break;

      case 'kcy':
        await store.clearKeywords(chId, a2 === 'allow' ? 'allow' : 'block');
        await app.keywordList(ch, a2 === 'allow' ? 'allow' : 'block', 0, chatId, mid);
        await answer('🧹 لیست پاک شد');
        break;

      case 'pv':
        await app.preview(ch, chatId, mid);
        break;

      case 'pg':
        await app.confirm(ch, chatId, mid);
        break;

      case 'py':
        await app.purge(ch, user, chatId, mid);
        break;

      case 'qk':
        await store.setSession(user.id, 'quick', { ch: chId });
        await app.render(chatId, mid, {
          text:
            `🧨 <b>حذف فوری با یک کلمه</b> — ${escapeHtml(ch.title)}\n${ui.LINE}\n` +
            `کلمه را بفرستید؛ همهٔ پست‌هایی که این کلمه را دارند (حتی قدیمی‌ترین‌ها) پیدا می‌شوند و بعد از تأیید شما حذف می‌شوند.\n\n` +
            `این کلمه در لیست فیلتر ذخیره <b>نمی‌شود</b>.\n` +
            `<code>"کلمه"</code> = کلمهٔ کامل · <code>/regex/</code> = عبارت منظم`,
          reply_markup: ui.kb([ui.red('✖️ لغو', `ch:${chId}`)]),
        });
        break;

      case 'qy': {
        const s = await store.getSession(user.id);
        if (s?.state !== 'quick_ready' || s.data?.ch !== chId) {
          await answer('⏱ منقضی شد؛ دوباره کلمه را وارد کنید.', true);
          break;
        }
        await app.purge(ch, user, chatId, mid, { word: s.data.word, mode: s.data.mode });
        break;
      }

      case 'sc':
        await app.scanView(ch, chatId, mid);
        break;

      case 'sd': {
        try {
          const last = await engine.detectLastId(ch);
          ch = await store.getChannel(chId);
          await app.scanView(ch, chatId, mid, `🎯 آخرین پیام کانال: <b>#${fmt(last)}</b>`);
        } catch (e) {
          await app.scanView(ch, chatId, mid, '❌ ربات نتوانست در کانال پیام بفرستد. دسترسی «ارسال پیام» را به ربات بدهید یا آخرین پست را فوروارد کنید.');
        }
        break;
      }

      case 'sb': {
        const st = await store.postStats(chId);
        const to = Math.max(ch.lastKnownId || 0, st.maxId || 0);
        if (!to) {
          await app.scanView(ch, chatId, mid, '⚠️ تعداد پیام‌های کانال معلوم نیست. آخرین پست کانال را فوروارد کنید یا «تشخیص خودکار» را بزنید.');
          break;
        }
        await store.updateChannel(chId, { scanNext: 1, scanTo: to, scanFound: 0, scanActive: true });
        ch = await store.getChannel(chId);
        const res = await engine.scanBatch(ch, user.id, 100);
        ch = await store.getChannel(chId);
        await app.scanView(ch, chatId, mid, engine.scanNote(res));
        break;
      }

      case 'sr': {
        if (!ch.scanActive) { await app.scanView(ch, chatId, mid); break; }
        const n = Math.min(Math.max(Number(a2) || 100, 10), 500);
        const res = await engine.scanBatch(ch, user.id, n);
        ch = await store.getChannel(chId);
        await app.scanView(ch, chatId, mid, engine.scanNote(res));
        break;
      }

      case 'ss':
        await store.updateChannel(chId, { scanActive: false });
        ch = await store.getChannel(chId);
        await app.scanView(ch, chatId, mid, '⏹ اسکن متوقف شد. پست‌هایی که تا الان خوانده شده‌اند ذخیره هستند.');
        break;

      case 'tg': {
        if (!TOGGLES.has(a2)) break;
        await store.updateChannel(chId, { [a2]: !ch[a2] });
        ch = await store.getChannel(chId);
        await app.panel(ch, chatId, mid);
        await answer(ch[a2] ? '✅ روشن شد' : '⛔️ خاموش شد');
        break;
      }

      case 'bk':
        await store.clearSession(user.id);
        await app.render(chatId, mid, ui.backupPanel(ch));
        break;

      case 'bp':
        await store.updateChannel(chId, { backupChat: user.id });
        ch = await store.getChannel(chId);
        await app.render(chatId, mid, ui.backupPanel(ch));
        await answer('✅ پشتیبان‌ها به پیوی شما ارسال می‌شوند');
        break;

      case 'bc':
        await store.setSession(user.id, 'backup', { ch: chId });
        await app.render(chatId, mid, {
          text: '📦 یک پیام از <b>کانال/گروه آرشیو</b> را برای من فوروارد کنید (ربات باید آنجا ادمین باشد).',
          reply_markup: ui.kb([ui.red('✖️ لغو', `bk:${chId}`)]),
        });
        break;

      case 'bx':
        await store.updateChannel(chId, { backupChat: null });
        ch = await store.getChannel(chId);
        await app.render(chatId, mid, ui.backupPanel(ch));
        break;

      case 'ts':
        await store.setSession(user.id, 'test', { ch: chId });
        await app.render(chatId, mid, {
          text: '🧪 یک متن (یا پست فورواردی) بفرستید تا ببینید آیا با فیلترهای فعلی حذف می‌شود یا نه.',
          reply_markup: ui.kb([ui.plain('🔙 پنل', `ch:${chId}`)]),
        });
        break;

      case 'stt':
        await app.stats(ch, chatId, mid);
        break;

      case 'lg':
        await app.logsView(ch, chatId, mid);
        break;

      case 'rm':
        await app.render(chatId, mid, {
          text: `⚠️ کانال <b>${escapeHtml(ch.title)}</b> و همهٔ تنظیمات، کلمات و ایندکس آن از ربات حذف شود؟\n\n(پست‌های کانال دست نمی‌خورند.)`,
          reply_markup: ui.kb([ui.red('❌ بله، حذف کن', `rmy:${chId}`)], [ui.green('✖️ خیر', `ch:${chId}`)]),
        });
        break;

      case 'rmy':
        await store.removeChannel(chId);
        await app.channels(user, chatId, mid);
        await answer('کانال حذف شد');
        break;
    }
  } catch (e) {
    console.error(e);
    const err = '❌ خطا: ' + String(e.description || e.message || e).slice(0, 150);
    if (answered) {
      try { await app.render(chatId, null, { text: escapeHtml(err), reply_markup: ui.kb([ui.plain('🔙 منوی اصلی', 'menu:home')]) }); } catch {}
    } else {
      await answer(err, true);
    }
    return;
  }
  await answer();
}

async function toast(q, text, alert = false) {
  try {
    await api.answerCallbackQuery({ callback_query_id: q.id, text: text || undefined, show_alert: alert });
  } catch {}
}
