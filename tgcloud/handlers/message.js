import * as store from '../lib/store.js';
import { send, btn, call, now } from '../lib/util.js';
import { tick } from '../lib/timer.js';
import { aiEnabled } from '../lib/ai.js';
import { aiCreate, AI_PROMPT } from '../lib/aiflow.js';
import {
  active, welcome, HELP, startSession, showJobs, showChannels, showStats, addHelp, tryAdd, storeAnswer,
  makeJob, parseWhen, menuKb, ask, STEP_BACK,
} from '../lib/flow.js';
import { gvMenu } from '../lib/gv.js';
import { predictStart, setResult } from '../lib/predict.js';
import { claimStart } from '../lib/claim.js';
import { autoPanel, setTimes, setSources, setCreators } from '../lib/autopost.js';
import * as T from '../lib/tournament.js';
import { apiPanel, apiInput } from '../lib/apikeys.js';
import * as P from '../lib/players.js';
import { adminPanel, adminJoin } from '../lib/admins.js';
import * as C from '../lib/cleaner.js';
import * as MC from '../lib/minicup.js';
import { heartbeat } from '../lib/heartbeat.js';

// Settings the owner can set from the chat (keys never go in the code).
const SETTABLE = { gemini_key: 'کلید Gemini', gemini_pro_key: 'کلید Gemini Pro', results_footer: 'متن زیر پست نتیجه‌ها', vpn_bot: 'آیدی ربات VPN' };
const WEBAPP = 'https://app8719466331.tgcloud.ai/';

const fwdChat = (m) => m.forward_from_chat || m.forward_origin?.chat || null;

async function command(m, uid, st, cmd, arg, rest) {
  st.w = null;
  if (cmd === '/start' && /^pr_\d+$/.test(arg)) return predictStart(uid, Number(arg.slice(3))); // from a channel post
  if (cmd === '/start' && /^cl_\d+$/.test(arg)) return claimStart(uid, Number(arg.slice(3))); // a winner's prize
  if (cmd === '/start' && /^tr_\d+$/.test(arg)) return P.regIntro(uid, Number(arg.slice(3))); // tournament registration
  if (cmd === '/start' && /^tj_\w+$/.test(arg)) return P.joinIntro(uid, st, arg.slice(3)); // a teammate's invite link
  if (cmd === '/start' && /^adm_\w+$/.test(arg)) return adminJoin(uid, m.from, arg.slice(4));
  if (cmd === '/start' && /^mc_\d+$/.test(arg)) return MC.regStart(uid, st, Number(arg.slice(3))); // ⚡️ mini-cup registration
  if (cmd === '/minicup') return MC.home(uid, st);
  if (cmd === '/team' || cmd === '/dashboard') return P.dashboard(uid);
  if (cmd === '/admins') return adminPanel(uid);
  if (cmd === '/clean') return C.action(uid, st, 'cf', null);
  if (cmd === '/start' && /^tv_\d+$/.test(arg)) return T.viewStart(uid, Number(arg.slice(3))); // the Mini App
  if (cmd === '/start' || cmd === '/menu') return welcome(uid, m.from?.first_name || '');
  if (cmd === '/tournament' || cmd === '/tn') return T.home(uid);
  if (cmd === '/api') return apiPanel(uid);
  if (cmd === '/help') return send(uid, HELP, [[btn('🏠 منو', 'menu')]]);
  if (cmd === '/new') return startSession(uid, st, 'room');
  if (cmd === '/giveaway' || cmd === '/gv') return gvMenu(uid);
  if (cmd === '/post') return startSession(uid, st, 'post');
  if (cmd === '/ai') {
    if (!(await aiEnabled())) return send(uid, '🪄 هوش مصنوعی هنوز فعال نشده.');
    if (rest) return aiCreate(uid, st, rest);
    st.w = 'ai';
    return send(uid, AI_PROMPT, [[btn('🏠 منو', 'menu')]]);
  }
  if (cmd === '/jobs') return showJobs(uid);
  if (cmd === '/channels') return showChannels(uid);
  if (cmd === '/addchannel') {
    if (arg) return tryAdd(uid, st, arg);
    st.w = 'addch';
    return send(uid, addHelp(), [[btn('🏠 منو', 'menu')]]);
  }
  if (cmd === '/stats') return showStats(uid);
  if (cmd === '/cancel') {
    st.s = null;
    return send(uid, '❎ لغو شد.', await menuKb());
  }
  const owner = await store.isOwner(uid);
  if (cmd === '/tz' && owner) {
    const mm = arg.match(/^([+-]?)(\d{1,2})(?::(\d{2}))?$/);
    if (mm) {
      await store.setSetting('tz', (mm[1] === '-' ? -1 : 1) * (Number(mm[2]) * 60 + Number(mm[3] || 0)));
      return send(uid, `🕓 ساعت ربات تنظیم شد. الان: <b>${await store.localStr(now())}</b>`);
    }
    return send(uid, `مثال: /tz +3:30\nالان: <b>${await store.localStr(now())}</b>`);
  }
  if (cmd === '/auto' && owner) return autoPanel(uid);
  if (cmd === '/timer' && owner) {
    return send(uid, '⏰ <b>زمان‌بندی دقیق</b>\n\nبرای اینکه پست‌های زمان‌بندی‌شده و قرعه‌کشی‌ها دقیق سر ساعت انجام بشن، این صفحه رو باز کن و مراحلش رو انجام بده (یه بار، ۲ دقیقه):',
      [[{ text: '⏰ تنظیم زمان‌بندی دقیق', web_app: { url: WEBAPP } }], [btn('🔙 برگشت به منو', 'menu')]]);
  }
  if ((cmd === '/set' || cmd === '/unset') && owner) {
    if (!SETTABLE[arg]) return send(uid, '⚙️ تنظیمات:\n<code>/set gemini_key کلید</code> — هوش مصنوعی\n<code>/unset gemini_key</code> — خاموش کردنش');
    if (cmd === '/unset') {
      await store.setSetting(arg, null);
      return send(uid, `✅ ${SETTABLE[arg]} پاک شد.`);
    }
    const val = rest.split(/\s+/).slice(1).join(' ').trim();
    if (!val) return send(uid, `مثال: <code>/set ${arg} …</code>`);
    await store.setSetting(arg, val);
    await call('deleteMessage', { chat_id: uid, message_id: m.message_id }); // don't leave the key in the chat
    return send(uid, `✅ ${SETTABLE[arg]} ذخیره شد.`, await menuKb());
  }
  return welcome(uid, m.from?.first_name || '');
}

export default async function (m) {
  if (m.chat.type !== 'private') return;
  const uid = m.chat.id;
  await store.user(m.from || { id: uid });
  // only the owner uses the bot; others come only for a score (pr_) or a prize (cl_) from a channel post,
  // or as a tournament team leader (tr_)
  if (!(await store.isOwner(uid))) {
    const [cmd, arg = ''] = (m.text || '').trim().split(/\s+/);
    const st = await store.getSession(uid);
    try {
      if (cmd?.split('@')[0].toLowerCase() === '/start') {
        if (/^pr_\d+$/.test(arg)) return await predictStart(uid, Number(arg.slice(3)));
        if (/^cl_\d+$/.test(arg)) return await claimStart(uid, Number(arg.slice(3)));
        if (/^tv_\d+$/.test(arg)) return await T.viewStart(uid, Number(arg.slice(3)));
        if (/^tr_\d+$/.test(arg)) return await P.regIntro(uid, Number(arg.slice(3)));
        if (/^tj_\w+$/.test(arg)) return await P.joinIntro(uid, st, arg.slice(3));
        if (/^adm_\w+$/.test(arg)) return await adminJoin(uid, m.from, arg.slice(4));
        if (/^mc_\d+$/.test(arg)) return await MC.regStart(uid, st, Number(arg.slice(3)));
      }
      const low = cmd?.split('@')[0].toLowerCase();
      if (low === '/team' || low === '/dashboard') return await P.dashboard(uid);
      if (st.w?.startsWith('tp:') && m.text && !m.text.startsWith('/') && (await P.input(uid, st, m.text.trim(), m.from))) return;
      if (st.w?.startsWith('mc:team:') && (await MC.teamInput(uid, st, m))) return; // ⚡️ a leader's team name
      return await P.userMenu(uid);
    } finally {
      await store.saveSession(uid, st);
      await tick().catch((e) => console.error('tick', e));
      await heartbeat().catch((e) => console.error('beat', e));
    }
  }
  const st = await store.getSession(uid);
  try {
    await handle(m, uid, st);
  } finally {
    await store.saveSession(uid, st);
  }
  await tick().catch((e) => console.error('tick', e));
  await heartbeat().catch((e) => console.error('beat', e));
}

async function handle(m, uid, st) {
  const t = (m.text || '').trim();
  if (t.startsWith('/')) {
    const parts = t.split(/\s+/);
    const cmd = parts[0].split('@')[0].toLowerCase();
    return command(m, uid, st, cmd, parts[1] || '', t.slice(parts[0].length).trim());
  }
  // ⚡️ mini-cup: a team name (anyone can lead a team) and the admin's answers
  if (st.w?.startsWith('mc:team:') && (await MC.teamInput(uid, st, m))) return;
  if (st.w?.startsWith('mc:') && (await MC.adminInput(uid, st, m))) return;
  // the channel cleaner's prompts (words, quick purge, test, backup channel)
  if (st.w?.startsWith('cf:') && (await C.input(uid, st, m))) return;
  // tournament (screenshots, results, teams, room) and API keys come before the post builder
  if (st.w?.startsWith('tn:') && (await T.input(uid, st, m))) return;
  if (st.w?.startsWith('ak:set:') && t) return apiInput(uid, st, m, t);
  if (st.w?.startsWith('tp:') && t && (await P.input(uid, st, t, m.from))) return;
  const fc = fwdChat(m);
  if (st.w === 'addch') {
    if (fc) return tryAdd(uid, st, fc.id);
    if (t) return tryAdd(uid, st, '@' + t.replace(/^@/, '').split(/\s+/)[0]);
    return;
  }
  if (st.w === 'ai' && t) return aiCreate(uid, st, t);
  if (st.w?.startsWith('res:') && t) {
    const gid = Number(st.w.slice(4));
    st.w = null;
    return setResult(uid, gid, t);
  }
  if (st.w === 'autotimes' && t) return setTimes(uid, st, t);
  if (st.w === 'autosrc' && t) return setSources(uid, st, t);
  if (st.w === 'autoyt' && t) return setCreators(uid, st, t);
  if (st.s?.mode === 'sched' && t) {
    const ts = await parseWhen(t);
    if (!ts) return send(uid, '⚠️ ساعت رو اینجوری بفرست: 23:30 یا +45', [[btn('🔙 برگشت به پیش‌نمایش', 'pv')]]);
    return makeJob(uid, st, ts);
  }
  if (active(st)) {
    const s = st.s;
    const key = s.edit || s.keys[s.i];
    if (key === 'photo') {
      if (m.photo) return storeAnswer(uid, st, 'photo', m.photo[m.photo.length - 1].file_id);
      return send(uid, '🖼 عکس بفرست یا «بدون بنر» رو بزن.', STEP_BACK);
    }
    if (key === 'rules') {
      if (t) {
        s.rcustom.push('✍️ ' + t);
        return ask(uid, st);
      }
      return;
    }
    if (t) return storeAnswer(uid, st, key, t);
    return;
  }
  if (fc || /^@\w{4,}$/.test(t)) return tryAdd(uid, st, fc ? fc.id : t);
  // a sentence outside any menu: the AI builds the post it describes
  if (t.length >= 12 && (await aiEnabled())) return aiCreate(uid, st, t);
  return welcome(uid, m.from?.first_name || '');
}
