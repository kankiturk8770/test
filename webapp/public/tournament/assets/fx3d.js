/* 3D icons + English digits for the whole Mini App.
   Every emoji shown on the page becomes a Fluent 3D icon (Microsoft, MIT: assets/licenses/FluentEmoji.txt, files in assets/3d/),
   and every Persian/Arabic digit becomes 0-9. A MutationObserver covers whatever the app renders later (pages, sheet, toasts). */
window.FX3D = (() => {
  const MAP = {"🎬": "clapper_board", "⭐": "star", "🎮": "video_game", "✅": "check_mark_button", "💀": "skull", "🗓": "spiral_calendar", "👑": "crown", "🍗": "poultry_leg", "🏆": "trophy", "📊": "bar_chart", "📝": "memo", "🔴": "red_circle", "⏳": "hourglass_not_done", "👥": "busts_in_silhouette", "🔑": "key", "🗺": "world_map", "🚨": "police_car_light", "🥇": "1st_place_medal", "🥈": "2nd_place_medal", "🥉": "3rd_place_medal", "📸": "camera_with_flash", "⏰": "alarm_clock", "📣": "megaphone", "🔥": "fire", "📜": "scroll", "⚖": "balance_scale", "🛡": "shield", "⏭": "next_track_button", "📢": "loudspeaker", "🏠": "house", "🟢": "green_circle", "🛠": "hammer_and_wrench", "🏁": "chequered_flag", "💾": "floppy_disk", "❌": "cross_mark", "📅": "calendar", "📋": "clipboard", "⛔": "no_entry", "🔕": "bell_with_slash", "👁": "eye", "⚙": "gear", "⚠": "warning", "🔒": "locked", "🗑": "wastebasket", "🪂": "parachute", "📦": "package", "🎲": "game_die", "🪖": "military_helmet", "🍳": "cooking", "💣": "bomb", "▶": "play_button", "🔄": "counterclockwise_arrows_button", "📱": "mobile_phone", "🔗": "link", "🎟": "admission_tickets", "✈": "airplane", "🎖": "military_medal", "⚔": "crossed_swords", "🌟": "glowing_star", "✨": "sparkles", "🎉": "party_popper", "🚀": "rocket", "⬆": "up_arrow", "⏱": "stopwatch", "🕹": "joystick", "💥": "collision", "🔫": "water_pistol", "🧪": "test_tube", "🔔": "bell", "🎁": "wrapped_gift", "📍": "round_pushpin", "🗡": "dagger", "🚁": "helicopter", "🛬": "airplane_arrival", "👊": "oncoming_fist", "🤝": "handshake", "🙏": "folded_hands", "💪": "flexed_biceps", "👆": "backhand_index_pointing_up", "✍": "writing_hand", "ℹ": "information", "♻": "recycling_symbol", "🎊": "confetti_ball", "🍽": "fork_and_knife_with_plate", "🎯": "bullseye", "🆔": "id_button", "⭐️": "star", "✔": "check_mark_button", "☑": "check_mark_button"};
  const keys = Object.keys(MAP).sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const RE = new RegExp('(' + keys.join('|') + ')\ufe0f?', 'gu');
  const DIG = /[\u06F0-\u06F9\u0660-\u0669]/g;
  const en = (s) => s.replace(DIG, (d) => String((d.charCodeAt(0) & 15) % 10));
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'NOSCRIPT']);
  const img = (k) => { const n = MAP[k] || MAP[k.replace(/\ufe0f/g, '')]; const i = document.createElement('img'); i.className = 'e3d'; i.src = `assets/3d/${n}.webp`; i.alt = k; i.draggable = false; return i; };
  function fixText(node) {
    let t = node.nodeValue;
    if (DIG.test(t)) { DIG.lastIndex = 0; t = en(t); node.nodeValue = t; }
    DIG.lastIndex = 0;
    if (!RE.test(t)) return;
    RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const m of t.matchAll(RE)) {
      if (m.index > at) frag.append(t.slice(at, m.index));
      frag.append(img(m[1]));
      at = m.index + m[0].length;
    }
    if (at < t.length) frag.append(t.slice(at));
    node.replaceWith(frag);
  }
  function walk(root) {
    if (!root) return;
    // never inside code: the page's own <script> text arrives here while it is being parsed
    if (root.nodeType === 3) return SKIP.has(root.parentNode?.tagName) || root.parentNode?.closest?.('[data-no3d]') ? undefined : fixText(root);
    if (root.nodeType !== 1 || SKIP.has(root.tagName) || root.closest?.('[data-no3d]')) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (SKIP.has(n.parentNode?.tagName) ? 2 : 1) });
    const list = [];
    while (w.nextNode()) list.push(w.currentNode);
    list.forEach(fixText);
    // option labels (selects) keep text, but their digits go English too
    root.querySelectorAll?.('option').forEach((o) => { if (DIG.test(o.text)) { DIG.lastIndex = 0; o.text = en(o.text); } DIG.lastIndex = 0; });
  }
  let queued = new Set(), busy = false;
  const flush = () => { busy = false; const q = [...queued]; queued = new Set(); q.forEach(walk); };
  new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === 'characterData') queued.add(m.target);
      else m.addedNodes.forEach((n) => queued.add(n));
    }
    if (!busy) { busy = true; queueMicrotask(flush); }
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  document.addEventListener('DOMContentLoaded', () => walk(document.body));
  const src = (k) => `assets/3d/${MAP[k] || k}.webp`;
  return { walk, en, src, big: (name) => `assets/3d/big/${name}.webp` };
})();
