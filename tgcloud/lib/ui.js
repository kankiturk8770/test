// Inline keyboards. Colored buttons use the Bot API `style` field:
//   'success' = green · 'danger' = red · 'primary' = blue · (none) = default glass
import { escapeHtml, fmt, progressBar, snippet } from './text.js';

export const green = (text, data) => ({ text, callback_data: data, style: 'success' });
export const red = (text, data) => ({ text, callback_data: data, style: 'danger' });
export const blue = (text, data) => ({ text, callback_data: data, style: 'primary' });
export const plain = (text, data) => ({ text, callback_data: data });
export const link = (text, url) => ({ text, url });

export const kb = (...rows) => ({ inline_keyboard: rows.filter((r) => r && r.length) });

const MODE_LABEL = { contains: 'شامل', word: 'کلمهٔ کامل', regex: 'Regex' };
const onOff = (v) => (v ? 'روشن ✅' : 'خاموش ⛔️');
const toggle = (v, text, data) => (v ? green(`${text}: ${onOff(v)}`, data) : red(`${text}: ${onOff(v)}`, data));

export const LINE = '━━━━━━━━━━━━━━━';

// ── main menu ───────────────────────────────────────────────
export function mainMenu(user, count) {
  const text =
    `🧹 <b>ربات پاکسازی هوشمند کانال</b>\n${LINE}\n` +
    `سلام <b>${escapeHtml(user.first_name || '')}</b> 👋\n\n` +
    `با این ربات می‌تونی هر پستی که یک کلمهٔ خاص داره ` +
    `(مثلاً «روم»، «پرایز» یا هر کلمه‌ای که خودت بخوای) رو از کانالت پاک کنی — ` +
    `حتی قدیمی‌ترین پست‌ها.\n\n` +
    `📢 کانال‌های ثبت‌شده: <b>${count}</b>`;
  return {
    text,
    reply_markup: kb(
      [blue('📢 کانال‌های من', 'menu:channels')],
      [green('➕ افزودن کانال جدید', 'menu:add')],
      [plain('📖 راهنما', 'menu:help'), plain('⚙️ دستورات', 'menu:commands')],
    ),
  };
}

export function channelsList(list) {
  const rows = list.map((c) => [
    (c.autoFilter ? green : plain)(`${c.autoFilter ? '🛡' : '📢'} ${snippet(c.title, 28)}`, `ch:${c.id}`),
  ]);
  rows.push([green('➕ افزودن کانال', 'menu:add'), plain('🔙 بازگشت', 'menu:home')]);
  const text = list.length
    ? `📢 <b>کانال‌های شما</b>\n${LINE}\nیک کانال را برای مدیریت انتخاب کنید:\n\n🛡 = فیلتر خودکار فعال`
    : `📢 <b>هنوز کانالی ثبت نکرده‌اید</b>\n${LINE}\nروی «افزودن کانال» بزنید.`;
  return { text, reply_markup: { inline_keyboard: rows } };
}

export function addChannelHelp() {
  return {
    text:
      `➕ <b>افزودن کانال</b>\n${LINE}\n` +
      `1️⃣ ربات را در کانال <b>ادمین</b> کنید و دسترسی‌های زیر را بدهید:\n` +
      `   • 🗑 حذف پیام‌های دیگران\n   • ✍️ ارسال پیام\n   • ✏️ ویرایش پیام‌ها\n\n` +
      `2️⃣ سپس یکی از این کارها را انجام دهید:\n` +
      `   • یک پست از کانال را برای من <b>فوروارد</b> کنید ↪️\n` +
      `   • یا یوزرنیم کانال را بفرستید (مثل <code>@mychannel</code>)\n` +
      `   • یا آیدی عددی کانال (مثل <code>-1001234567890</code>)`,
    reply_markup: kb([red('✖️ لغو', 'menu:channels')]),
  };
}

// ── channel panel ───────────────────────────────────────────
export function channelPanel(ch, st) {
  const scan = ch.scanActive
    ? `\n📥 اسکن آرشیو: <b>در حال انجام</b> ${progressBar(ch.scanNext - 1, ch.scanTo)}`
    : '';
  const text =
    `📢 <b>${escapeHtml(ch.title)}</b>${ch.username ? `  (@${escapeHtml(ch.username)})` : ''}\n${LINE}\n` +
    `🗂 پست‌های ایندکس‌شده: <b>${fmt(st.alive)}</b>\n` +
    `🚫 کلمات فیلتر: <b>${st.block}</b>   ✅ استثناها: <b>${st.allow}</b>\n` +
    `🗑 مجموع حذف‌شده: <b>${fmt(ch.deletedCount)}</b>\n` +
    `🛡 فیلتر خودکار: <b>${onOff(ch.autoFilter)}</b>\n` +
    `🗄 پشتیبان قبل از حذف: <b>${ch.backupChat ? 'فعال ✅' : 'غیرفعال'}</b>` + scan;
  const id = ch.id;
  return {
    text,
    reply_markup: kb(
      [blue('🚫 کلمات فیلتر', `kw:${id}:block:0`), green('✅ کلمات استثنا', `kw:${id}:allow:0`)],
      [blue('🔍 پیش‌نمایش موارد', `pv:${id}`), red('🗑 پاکسازی کامل', `pg:${id}`)],
      [blue('📥 اسکن پست‌های قدیمی', `sc:${id}`), red('🧨 حذف فوری با یک کلمه', `qk:${id}`)],
      [toggle(ch.autoFilter, '🛡 فیلتر خودکار پست‌های جدید', `tg:${id}:autoFilter`)],
      [toggle(ch.ruleLinks, '🔗 حذف لینک‌دار', `tg:${id}:ruleLinks`), toggle(ch.ruleForward, '↪️ حذف فورواردی', `tg:${id}:ruleForward`)],
      [plain('🗄 پشتیبان‌گیری', `bk:${id}`), plain('🧪 تست متن', `ts:${id}`), toggle(ch.notify, '🔔', `tg:${id}:notify`)],
      [plain('📊 آمار', `stt:${id}`), plain('🧾 گزارش حذف‌ها', `lg:${id}`)],
      [red('❌ حذف کانال از ربات', `rm:${id}`), plain('🔙 بازگشت', 'menu:channels')],
    ),
  };
}

// ── keywords list ───────────────────────────────────────────
const PAGE = 8;
export function keywordsList(ch, kind, list, page) {
  const isAllow = kind === 'allow';
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = list.slice(page * PAGE, page * PAGE + PAGE);
  const rows = slice.map((k) => [
    (isAllow ? green : blue)(`${isAllow ? '✅' : '🚫'} ${snippet(k.word, 22)}`, `kv:${k.id}`),
    plain(`🔁 ${MODE_LABEL[k.mode] || k.mode}`, `km:${k.id}:${page}`),
    red('✖️', `kd:${k.id}:${page}`),
  ]);
  if (pages > 1) {
    rows.push([
      plain('◀️', `kw:${ch.id}:${kind}:${page - 1}`),
      plain(`${page + 1} / ${pages}`, 'noop'),
      plain('▶️', `kw:${ch.id}:${kind}:${page + 1}`),
    ]);
  }
  rows.push([green(isAllow ? '➕ افزودن استثنا' : '➕ افزودن کلمه', `ka:${ch.id}:${kind}`)]);
  if (list.length) rows.push([red('🧹 پاک کردن همهٔ لیست', `kc:${ch.id}:${kind}`)]);
  rows.push([plain('🔙 پنل کانال', `ch:${ch.id}`)]);

  const title = isAllow ? '✅ <b>کلمات استثنا</b>' : '🚫 <b>کلمات فیلتر</b>';
  const desc = isAllow
    ? 'پستی که یکی از این کلمات را داشته باشد <b>هرگز</b> حذف نمی‌شود، حتی اگر کلمهٔ فیلتر داشته باشد.'
    : 'هر پستی که یکی از این کلمات را داشته باشد حذف می‌شود.';
  const text =
    `${title} — ${escapeHtml(ch.title)}\n${LINE}\n${desc}\n\n` +
    `تعداد: <b>${list.length}</b>\n` +
    `🔁 = تغییر حالت تطبیق (شامل ⇄ کلمهٔ کامل)\n` +
    (list.length ? '' : '\n<i>لیست خالی است.</i>');
  return { text, reply_markup: { inline_keyboard: rows } };
}

export function addKeywordPrompt(ch, kind) {
  return {
    text:
      `✍️ <b>${kind === 'allow' ? 'افزودن کلمهٔ استثنا' : 'افزودن کلمهٔ فیلتر'}</b>\n${LINE}\n` +
      `کلمه یا کلمات را بفرستید. می‌توانید چند کلمه را در خطوط جدا یا با کاما بفرستید:\n\n` +
      `<code>روم\nپرایز, خیار</code>\n\n` +
      `🔹 <b>شامل</b> (پیش‌فرض): هر جای متن باشد — «روم» در «رومی» هم پیدا می‌شود.\n` +
      `🔹 <b>کلمهٔ کامل</b>: داخل گیومه بنویسید → <code>"روم"</code>\n` +
      `🔹 <b>Regex</b>: بین دو اسلش → <code>/prize|جایزه/</code>\n\n` +
      `حروف عربی/فارسی (ي/ی، ك/ک)، اعراب و نیم‌فاصله خودکار یکسان‌سازی می‌شوند.`,
    reply_markup: kb([red('✖️ لغو', `kw:${ch.id}:${kind}:0`)]),
  };
}

// ── confirm / results ───────────────────────────────────────
export function confirmPurge(ch, count, samples, cbYes, cbBack) {
  const lines = samples.map((s) => `• <code>#${s.messageId}</code> — ${escapeHtml(snippet(s.body, 45))}  <i>(${escapeHtml(s.reason)})</i>`);
  return {
    text:
      `⚠️ <b>تأیید پاکسازی</b> — ${escapeHtml(ch.title)}\n${LINE}\n` +
      `<b>${fmt(count)}</b> پست مطابق فیلترها پیدا شد و حذف خواهد شد.\n` +
      (ch.backupChat ? '🗄 قبل از حذف، از پست‌ها نسخهٔ پشتیبان گرفته می‌شود.\n' : '❗️ پشتیبان‌گیری غیرفعال است — حذف قابل بازگشت نیست.\n') +
      (lines.length ? `\n<b>نمونه‌ها:</b>\n${lines.join('\n')}` : ''),
    reply_markup: kb(
      [red(`🗑 بله، ${fmt(count)} پست حذف شود`, cbYes)],
      [green('✖️ نه، منصرف شدم', cbBack)],
    ),
  };
}

export function scanPanel(ch, st, note = '') {
  const total = Math.max(0, (ch.scanTo || 0));
  const done = Math.max(0, (ch.scanNext || 1) - 1);
  const id = ch.id;
  const head =
    `📥 <b>اسکن پست‌های قدیمی</b> — ${escapeHtml(ch.title)}\n${LINE}\n` +
    `ربات API تلگرام اجازهٔ جست‌وجو در تاریخچهٔ کانال را نمی‌دهد؛ برای همین ربات ` +
    `پست‌ها را یکی‌یکی (با فوروارد موقت به پیوی شما و حذف فوری آن) می‌خواند و ` +
    `<b>یک‌بار برای همیشه</b> ایندکس می‌کند. بعد از آن، پاکسازی با هر کلمه‌ای فوری است.\n\n`;
  let body;
  let rows;
  if (ch.scanActive) {
    body =
      `${progressBar(done, total)}  <b>${total ? Math.floor((done / total) * 100) : 0}%</b>\n` +
      `🔢 پیام ${fmt(done)} از ${fmt(total)}\n` +
      `🗂 پست‌های پیدا‌شده: <b>${fmt(ch.scanFound)}</b>\n`;
    rows = [
      [green('▶️ ادامهٔ اسکن (۱۰۰ پیام)', `sr:${id}:100`), blue('⏩ ادامه (۳۰۰ پیام)', `sr:${id}:300`)],
      [red('⏹ توقف اسکن', `ss:${id}`), plain('🔙 پنل', `ch:${id}`)],
    ];
  } else {
    body =
      `🗂 پست‌های ایندکس‌شده تا الان: <b>${fmt(st.alive)}</b>\n` +
      `🔝 بالاترین شمارهٔ پیام شناخته‌شده: <b>${fmt(ch.lastKnownId)}</b>\n\n` +
      `برای اینکه ربات بداند کانال چند پیام دارد، <b>آخرین پست کانال را فوروارد کنید</b> ` +
      `یا «تشخیص خودکار» را بزنید (یک پیام بی‌صدا ارسال و فوراً حذف می‌شود).`;
    rows = [
      [green('🚀 شروع اسکن کامل', `sb:${id}`)],
      [blue('🎯 تشخیص خودکار آخرین پیام', `sd:${id}`)],
      [plain('🔙 پنل', `ch:${id}`)],
    ];
  }
  return { text: head + body + (note ? `\n\n${note}` : ''), reply_markup: { inline_keyboard: rows } };
}

export function backupPanel(ch) {
  const id = ch.id;
  return {
    text:
      `🗄 <b>پشتیبان‌گیری قبل از حذف</b>\n${LINE}\n` +
      `اگر فعال باشد، ربات قبل از حذف هر پست یک کپی از آن را به مقصد پشتیبان می‌فرستد؛ ` +
      `پس اگر اشتباهی پاک شد، چیزی از دست نمی‌رود.\n\n` +
      `وضعیت فعلی: <b>${ch.backupChat ? `فعال → <code>${ch.backupChat}</code>` : 'غیرفعال'}</b>\n\n` +
      `برای استفاده از یک <b>کانال/گروه خصوصی</b> به‌عنوان آرشیو، ربات را آنجا ادمین کنید و ` +
      `یک پیام از آن را فوروارد کنید.`,
    reply_markup: kb(
      [green('👤 ارسال به پیوی من', `bp:${id}`), blue('📦 انتخاب کانال آرشیو', `bc:${id}`)],
      ch.backupChat ? [red('⛔️ غیرفعال کردن پشتیبان', `bx:${id}`)] : [],
      [plain('🔙 پنل', `ch:${id}`)],
    ),
  };
}

export function helpText() {
  return {
    text:
      `📖 <b>راهنمای ربات</b>\n${LINE}\n` +
      `🔹 <b>کلمات فیلتر</b>: هر پستی که این کلمات را داشته باشد حذف می‌شود (متن، کپشن، لینک‌های مخفی و دکمه‌های پست).\n\n` +
      `🔹 <b>کلمات استثنا</b>: پستی که این کلمات را داشته باشد هیچ‌وقت حذف نمی‌شود.\n\n` +
      `🔹 <b>اسکن پست‌های قدیمی</b>: پست‌هایی که قبل از ورود ربات منتشر شده‌اند را یک‌بار می‌خواند و ایندکس می‌کند.\n\n` +
      `🔹 <b>پیش‌نمایش</b>: قبل از حذف ببینید چند پست و کدام‌ها حذف می‌شوند.\n\n` +
      `🔹 <b>پاکسازی کامل</b>: همهٔ پست‌های مطابق (حتی هزاران پست) را با دسته‌های ۱۰۰تایی حذف می‌کند.\n\n` +
      `🔹 <b>حذف فوری با یک کلمه</b>: بدون ذخیرهٔ کلمه، فقط یک‌بار همهٔ پست‌های شامل آن را پاک می‌کند.\n\n` +
      `🔹 <b>فیلتر خودکار</b>: پست‌های جدیدی که کلمهٔ فیلتر دارند (یا بعداً ویرایش شوند) فوراً حذف می‌شوند.\n\n` +
      `🔹 <b>آلبوم‌ها</b>: اگر کپشن یک آلبوم مطابق باشد، همهٔ عکس‌های آن آلبوم حذف می‌شوند.\n\n` +
      `🔹 <b>پشتیبان</b>: قبل از حذف، کپی پست‌ها به پیوی شما یا یک کانال آرشیو ارسال می‌شود.\n\n` +
      `⚠️ ربات باید در کانال ادمین با دسترسی «حذف پیام‌ها» باشد.`,
    reply_markup: kb([plain('🔙 منوی اصلی', 'menu:home')]),
  };
}

export function commandsText() {
  return {
    text:
      `⚙️ <b>دستورات</b>\n${LINE}\n` +
      `/start — منوی اصلی\n` +
      `/channels — کانال‌های من\n` +
      `/help — راهنما\n` +
      `/cancel — لغو عملیات جاری`,
    reply_markup: kb([plain('🔙 منوی اصلی', 'menu:home')]),
  };
}
