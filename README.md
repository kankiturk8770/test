# UFDEVILLCNL_bot (Telegram Serverless)

Source of the bot running on Telegram's serverless platform (pulled with `npx tgcloud pull`).

## 🧹 Channel cleaner (`lib/cleaner.js`)
Main menu → «🧹 پاکسازی کانال» or `/clean`:
- filter words (contains / "whole word" / /regex/) with Persian/Arabic normalization, exception words
- full-history search & delete: reads every old post (forward → read → delete copy), deletes matches, indexes the rest
- instant purge from the index, one-off quick word, preview, auto-filter of new & edited posts, album handling
- link / forward rules, backup before delete (PM or archive channel), stats and deletion log
- long jobs continue from the cron (`endpoints/tick`, set up with /timer) or the «▶️ ادامه» button

Buttons are colored centrally in `lib/util.js` (`paint`): red = delete/cancel, green = confirm/add, blue = sections.
