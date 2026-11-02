/* The first-visit intro: seven full-screen chapters the player swipes up through, built from the live tournament data
   (D: format, stages and bracket, points, deadline). Written for players: what to do, how a match goes, the rules.
   Shown once per device (localStorage; bump KEY to show it to everyone again), never on the admin link;
   "🎬 راهنمای تورنمنت" on the home page opens it again. Styles: assets/intro.css.
   Art: the owner's paratroopers (3d/big/para1-4) and planes (3d/big/plane-rear = from their game screenshot, plane-side),
   the hero photo split into depth layers (images/hero-back = the photo with the soldier painted out, hero-front = the soldier),
   3d/ (Fluent 3D, re-coloured to the owner's palette).
   Sound: music (assets/audio/lobby.mp3, the owner's file) starts as the intro opens (or on the first touch if the browser
   blocks it), pauses while the app is hidden and comes back with it; the start button plays a short sound made here. */
window.Intro = (() => {
  const KEY = 'devil-intro-v8';
  const MUSIC = 'assets/audio/lobby.mp3', START = 'assets/audio/start.mp3'; // start.mp3: the owner's clip from their video
  let startSfx = null;
  const A3 = (n) => `assets/3d/${n}.webp`, B3 = (n) => `assets/3d/big/${n}.webp`;
  const ic = (n, cls = '') => `<img class="${cls}" src="${A3(n)}" alt="" draggable="false">`;
  const rv = (i, cls = '') => `class="rv ${cls}" style="--d:${(i * 0.12).toFixed(2)}s"`;
  const PLANE_SIDE = B3('plane-side');

  // 1 · the welcome: a photo in depth layers (back plate, the sky with the plane and the jumpers, haze, the soldier in front)
  function hero() {
    const path = D.stages.map((s) => s.label.replace(/\s*\(.*\)/, '')).join(' ← ');
    return `<section class="is hero">
      <div class="scene">
        <div class="far"><img class="layer" src="assets/images/hero-back.webp" alt=""><div class="sun"></div>
          <div class="air"><img class="plane3" src="${B3('plane-rear')}" alt=""></div><div class="haze"></div></div>
        <div class="near"><img class="layer" src="assets/images/hero-front.webp" alt=""></div>
        <div class="embers">${Array.from({ length: 14 }, (_, i) => `<i style="left:${(i * 37) % 100}%;animation-delay:${(i * 0.7) % 6}s;animation-duration:${5 + (i % 4)}s"></i>`).join('')}</div>
        <div class="shade"></div>
      </div>
      <div class="hero-copy">
        <div class="brand rv z"><span class="dv">DEVIL</span><span class="es"><i></i>ESPORTS<i></i></span></div>
        <div class="tag rv" style="--d:.25s">PUBG MOBILE · SQUAD TOURNAMENT</div>
        <p ${rv(3, 'center')}>تورنمنت پابجی موبایل برای اسکوادهای ۴ نفره. مسیرت: <b class="gold">${esc(path)}</b> و در آخر، <b class="gold">چیکن دینر</b>.
          این‌جا یاد می‌گیری چطوری ثبت‌نام کنی، مچ‌ها چطوری برگزار میشن و امتیاز چطوری حساب میشه.</p>
      </div></section>`;
  }

  function register() {
    const dl = D.deadline ? when(D.deadline) : 'چند روز قبل از اولین مچ؛ ساعت دقیقش اعلام میشه';
    const steps = [
      ['memo', 'لیدر اسکواد رو ثبت می‌کنه', 'از دکمه‌ی «ثبت‌نام» توی کانال، یه اسم برای تیم و یه تگ کوتاه (مثلا MK) انتخاب کن.'],
      ['link', 'هم‌تیمی‌هات رو دعوت کن', 'لیدر یه لینک دعوت می‌گیره؛ هر ۳ هم‌تیمی با همون لینک، اسم و آیدی پابجی خودشون رو ثبت می‌کنن.'],
      ['military_helmet', 'تگ تیم توی اسم بازی', 'اسم داخل بازی هر ۴ نفر باید تگ تیم رو داشته باشه؛ کیل‌ها با همین اسم به تیمت می‌رسه.'],
      ['alarm_clock', 'مهلت تکمیل اسکواد', `${dl}. اسکوادی که تا اون موقع ۴ نفر نشه حذف میشه و جاش به تیم دیگه‌ای میرسه.`],
    ];
    return `<section class="is"><div class="art" style="background-image:url('assets/images/squad.webp')"></div>
      <div style="margin-top:26vh">
        <div ${rv(0)}><div class="kick">STEP 01 · SQUAD UP</div><h2>اسکوادت رو بساز</h2></div>
        <div class="squad">${[0, 1, 2, 3].map(() => `<i>${ic('military_helmet')}</i>`).join('')}</div>
        <div class="full rv" style="--d:2s">✅ اسکواد ۴ نفره آماده‌ست!</div>
        <div class="steps">${steps.map(([n, b, s], i) => `<div class="st rv l" style="--d:${(0.3 + i * 0.15).toFixed(2)}s">${ic(n)}<div><b>${esc(b)}</b><span>${esc(s)}</span></div></div>`).join('')}</div>
      </div></section>`;
  }

  // the path, from the stages: a bracket (stages[].feed) or one stage after another
  function path() {
    const S = D.stages, fin = S[S.length - 1];
    const pg = (s, g, i, cls = '') => `<div class="pg ${cls} rv z" style="--d:${(0.2 + i * 0.1).toFixed(2)}s"><b>${esc(g)}</b>${s.lobby} تیم · ${s.matches} مچ</div>`;
    const link = (txt, d) => `<div class="link" style="--d:${d}s">${txt ? `<span>${esc(txt)}</span>` : ''}</div>`;
    let body = '', lead = '';
    const semi = S.find((s) => s.feed);
    if (semi && S[0] !== semi) {
      const first = S[0];
      lead = `${first.groups.length} گروه ${first.lobby} تیمی شروع می‌کنن. از هر گروه ${first.adv} تیم بالا میره و دو گروه کنار هم یه نیمه‌نهایی می‌سازن. از هر نیمه‌نهایی ${semi.adv} تیم به فینال می‌رسه.`;
      body = `<div class="bracket">${semi.feed.map(({ g, from }, k) => `<div class="side">
          <div class="pair">${from.map((f, j) => pg(first, f, k * 2 + j)).join('')}</div>
          ${link(`${first.adv} تیم اول`, 0.8)}
          ${pg(semi, `نیمه ${g}`, 5 + k, 'semi')}
        </div>`).join('')}</div>
        ${link(`${semi.adv} تیم اول هر نیمه`, 1.3)}`;
    } else {
      lead = 'از هر گروه فقط بهترین‌ها به مرحله‌ی بعد میرن؛ امتیاز همه‌ی مچ‌های یه مرحله جمع میشه.';
      body = S.slice(0, -1).map((s, k) => `<div class="row" style="grid-template-columns:repeat(${Math.min(s.groups.length, 4)},1fr)">
          ${s.groups.map((g, j) => pg(s, g.name, k * 3 + j, k ? 'semi' : '')).join('')}</div>${link(s.adv ? `${s.adv} تیم اول هر گروه` : '', 0.6 + k * 0.4)}`).join('');
    }
    return `<section class="is"><div class="tile"></div>
      <div ${rv(0)}><div class="kick">STEP 02 · ROAD TO CHICKEN DINNER</div><h2>مسیر تا فینال</h2></div>
      <p ${rv(1)}>${esc(lead)}</p>
      <div class="path">${body}
        <div class="pg fin rv z" style="--d:1.5s"><b>FINAL</b>${esc(fin.label)} · ${fin.lobby} تیم · ${fin.matches} مچ</div>
        ${link('', 1.8)}
        <div class="cup3d rv z" style="--d:2s"><img class="cup" src="${B3('poultry_leg')}" alt=""></div>
        <div class="center rv" style="--d:2.2s"><b class="gold">🏆 قهرمان، نایب‌قهرمان و سوم با جمع امتیاز مچ‌های فینال</b></div>
      </div></section>`;
  }

  function match() {
    const ev = [
      ['alarm_clock', 'روز و ساعت مچ', 'برنامه‌ی مچ‌ها و اسلات تیمت توی ربات و همین مینی‌اپ میاد. سر وقت آنلاین باش.'],
      ['key', 'ورود به روم', 'کمی قبل از شروع، آیدی و رمز روم برات میاد. وارد شو و فقط توی اسلات تیم خودت بشین.'],
      ['parachute', 'پرش!', 'وقتی همه آماده شدن، مچ شروع میشه. بپر، لوت کن و تا آخر زنده بمون.'],
      ['bar_chart', 'نتیجه و جدول', 'بعد از مچ، رتبه و کیل‌های تیمت ثبت میشه و جدول همین‌جا به‌روز میشه.'],
    ];
    return `<section class="is"><div class="bg" style="background-image:url('assets/images/map-grid.webp')"></div>
      <div ${rv(0)}><div class="kick">STEP 03 · DROP IN</div><h2>یه مچ چطوری پیش میره؟</h2></div>
      <div class="tl"><img class="pl" src="${PLANE_SIDE}" alt="">
        ${ev.map(([n, b, s], i) => `<div class="ev rv l" style="--d:${(0.2 + i * 0.2).toFixed(2)}s">${ic(n)}<div class="tx"><b>${esc(b)}</b><br><span style="font-size:12px">${esc(s)}</span></div></div>`).join('')}
      </div>
      <div class="rv" style="--d:1.1s"><div class="tx">🗺 نقشه‌های مسابقه:</div><div class="maps">${['ERANGEL', 'MIRAMAR', 'SANHOK', 'VIKENDI', 'RONDO', 'LIVIK'].map((m) => `<span>${m}</span>`).join('')}</div></div>
    </section>`;
  }

  function points() {
    const P = D.points || [10, 6, 5, 4, 3, 2, 1, 1, 0], max = Math.max(...P, 1);
    return `<section class="is"><div class="tile"></div>
      <div ${rv(0)}><div class="kick">STEP 04 · SCORING</div><h2>چطوری امتیاز بگیری؟</h2></div>
      <div class="kill rv z" style="--d:.2s"><img src="${B3('skull')}" alt=""><b>1 KILL = 1 PT</b></div>
      <p ${rv(2, 'center')}>هر کیل یه امتیاز. به‌علاوه‌ی امتیاز رتبه‌ی تیمت توی همون مچ:</p>
      <div class="bars">${P.slice(0, 8).map((p, i) => `<div style="--h:${Math.max(6, (p / max) * 100)}%;--d:${(0.3 + i * 0.1).toFixed(2)}s"><b>${p}</b><span>#${i + 1}</span></div>`).join('')}</div>
      <div class="wwcd rv" style="--d:1.2s"><img src="${B3('poultry_leg')}" alt=""><div><span class="wl">WINNER WINNER CHICKEN DINNER</span><span class="tx">چیکن دینر (رتبه‌ی ۱) = ${P[0]} امتیاز + کیل‌های تیمت</span></div></div>
      <p ${rv(10)} style="font-size:12px;margin-top:12px">⚖️ امتیاز همه‌ی مچ‌های یه مرحله جمع میشه. اگه دو تیم مساوی شدن: اول کیل بیشتر، بعد چیکن دینر بیشتر، بعد رتبه‌ی بهتر توی آخرین مچ.</p>
    </section>`;
  }

  function rules() {
    const R = [
      ['military_helmet', 'تگ تیم', 'اسم داخل بازی هر ۴ نفر باید تگ تیمت رو داشته باشه.'],
      ['locked', 'رمز روم محرمانه‌ست', 'آیدی و رمز روم رو به هیچ‌کس خارج از تیمت نده.'],
      ['bullseye', 'فقط اسلات خودت', 'هر تیم فقط توی اسلات خودش وارد روم میشه.'],
      ['no_entry', 'تقلب ممنوع', 'هک، تیم‌کشی یا همکاری با تیم دیگه یعنی حذف کامل از تورنمنت.'],
      ['balance_scale', 'حرف آخر', 'تصمیم نهایی با ادمین‌های تورنمنته. جوانمردانه بازی کن.'],
    ];
    return `<section class="is"><div class="bg" style="background-image:url('assets/images/camo-olive.webp');background-size:900px auto"></div>
      <img class="shield rv z" src="${B3('shield')}" alt="">
      <div ${rv(1, 'center')}><div class="kick" style="text-align:center">STEP 05 · RULES OF ENGAGEMENT</div><h2>قوانین میدان</h2></div>
      <div class="rules">${R.map(([n, b, s], i) => `<div class="rv l" style="--d:${(0.3 + i * 0.12).toFixed(2)}s">${ic(n)}<span><b>${esc(b)}:</b> ${esc(s)}</span></div>`).join('')}</div>
    </section>`;
  }

  function ready() {
    const sp = [[14, 18, 0], [80, 26, .7], [24, 52, 1.2], [76, 58, .4]].map(([x, y, d]) => `<img class="spark" src="${A3('sparkles')}" style="left:${x}%;top:${y}%;animation-delay:${d}s" alt="">`).join('');
    return `<section class="is go"><div class="bg" style="background-image:url('assets/images/squad.webp');background-position:50% 20%"></div><div class="rays"></div>${sp}
      <div style="margin-top:8vh">
        <img class="big rv z" src="${B3('poultry_leg')}" alt="">
        <div ${rv(1, 'center')}><div class="kick" style="text-align:center">ARE YOU READY, SOLDIER?</div><h2 style="font-size:28px">آماده‌ای سرباز؟</h2></div>
        <p ${rv(2, 'center')}>جدول زنده، برنامه‌ی مچ‌ها، نتیجه‌ها و آمار اسکوادت توی منوی پایین منتظرته. چیکن دینر مال تو! 🍗</p>
        <button class="start rv" style="--d:.5s" onclick="Intro.done()"><img src="${B3('parachute')}" alt="">شروع · ورود به میدان</button>
      </div></section>`;
  }

  // ---- sound: a short "ready" sound for the start button (made here, no file), and optional lobby music
  let ac = null, music = null;
  function startSound() {
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const t = ac.currentTime, out = ac.createGain();
      out.gain.value = .55; out.connect(ac.destination);
      // a metal latch click
      const click = ac.createOscillator(), cg = ac.createGain();
      click.type = 'square'; click.frequency.setValueAtTime(1800, t); click.frequency.exponentialRampToValueAtTime(300, t + .05);
      cg.gain.setValueAtTime(.35, t); cg.gain.exponentialRampToValueAtTime(.001, t + .07);
      click.connect(cg).connect(out); click.start(t); click.stop(t + .08);
      // a deep boom
      const boom = ac.createOscillator(), bg = ac.createGain();
      boom.type = 'sine'; boom.frequency.setValueAtTime(120, t + .04); boom.frequency.exponentialRampToValueAtTime(38, t + .7);
      bg.gain.setValueAtTime(.001, t); bg.gain.exponentialRampToValueAtTime(.9, t + .06); bg.gain.exponentialRampToValueAtTime(.001, t + .9);
      boom.connect(bg).connect(out); boom.start(t + .02); boom.stop(t + 1);
      // the air rushing by (filtered noise, rising)
      const len = ac.sampleRate * 1.1, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const n = ac.createBufferSource(), f = ac.createBiquadFilter(), ng = ac.createGain();
      n.buffer = buf; f.type = 'bandpass'; f.Q.value = .8; f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(2400, t + .9);
      ng.gain.setValueAtTime(.001, t); ng.gain.exponentialRampToValueAtTime(.5, t + .35); ng.gain.exponentialRampToValueAtTime(.001, t + 1.1);
      n.connect(f).connect(ng).connect(out); n.start(t); n.stop(t + 1.1);
    } catch {}
  }
  const SPK = '<svg viewBox="0 0 24 24" class="spk"><path d="M4 9.5h3.2L12 5.2v13.6L7.2 14.5H4z" fill="currentColor"/><path class="x" d="M16 9l5 6M21 9l-5 6" stroke="#ff5a4f" stroke-width="2.2" stroke-linecap="round"/></svg><span class="eq"><i></i><i></i><i></i></span>';
  let sndBtn = null, wanted = true, hiddenPaused = false;
  // the music is on every time the intro opens (the owner's choice); muting lasts only for this visit
  function paint() { if (sndBtn) { sndBtn.classList.toggle('off', !wanted || !music || music.paused); sndBtn.classList.toggle('ask', wanted && music && music.paused); } }
  function play() { if (music && wanted && el) music.play().then(paint, paint); }
  function startMusic() {
    if (music || !el) return;
    music = new Audio(MUSIC); music.loop = true; music.volume = .3; music.preload = 'auto'; // quiet; the clip fades at its end and starts again
    music.addEventListener('error', () => { if (sndBtn) sndBtn.remove(); });
    music.addEventListener('play', paint); music.addEventListener('pause', paint);
    sndBtn = document.createElement('button'); sndBtn.className = 'snd off'; sndBtn.innerHTML = SPK; sndBtn.setAttribute('aria-label', 'صدا');
    sndBtn.onclick = (e) => {
      e.stopPropagation();
      if (music.paused) { wanted = true; music.play().then(paint, paint); } else { wanted = false; music.pause(); }
    };
    el.append(sndBtn);
    setTimeout(play, 400); // right as the page opens; if the browser blocks it, the first touch starts it (open())
  }
  // leaving the app (another tab, Telegram minimised) pauses it; coming back resumes it
  function onVis() {
    if (!music || !el) return;
    if (document.hidden) { if (!music.paused) { hiddenPaused = true; music.pause(); } }
    else if (hiddenPaused) { hiddenPaused = false; play(); }
  }
  document.addEventListener('visibilitychange', onVis);
  if (typeof tg !== 'undefined' && tg && tg.onEvent) {
    tg.onEvent('deactivated', () => { if (music && !music.paused) { hiddenPaused = true; music.pause(); } });
    tg.onEvent('activated', () => { if (hiddenPaused) { hiddenPaused = false; play(); } });
  }
  function stopMusic() {
    if (!music) return;
    const m = music; music = null; sndBtn = null;
    const fade = setInterval(() => { m.volume = Math.max(0, m.volume - .05); if (!m.volume) { clearInterval(fade); m.pause(); } }, 60);
  }

  // The plane is part of the photo: big in the sky top right, heading right to left into the scene, easing forward and back,
  // bobbing and banking a little (CSS) so it's plainly flying. Soldiers leave its rear ramp one by one; each takes its own line
  // (toward the soldier, straight down, left, right) and glides down it, tilted the way it's going, no swinging.
  const LINES = [-150, 0, 90, -70, 40, -30, 130, -110];
  function flights(sec) {
    const air = sec.querySelector('.air'), plane = air && air.querySelector('.plane3');
    if (!plane || sec._fly) return;
    sec._fly = true;
    let k = Math.floor(Math.random() * LINES.length);
    const tick = () => {
      if (!el || !sec.isConnected) return clearInterval(id);
      const r = sec.getBoundingClientRect();
      if (r.top > innerHeight * 0.5 || r.bottom < innerHeight * 0.5 || document.hidden || document.documentElement.classList.contains('motion-off')) return;
      if (air.querySelectorAll('.jmp').length >= 4) return;
      const a = air.getBoundingClientRect(), p = plane.getBoundingClientRect();
      jump(air, p.left - a.left + p.width * 0.66, p.top - a.top + p.height * 0.62, k++);
    };
    const id = setInterval(tick, 2300);
    setTimeout(tick, 900);
  }
  function jump(air, x, y, k) {
    const dx = LINES[k % LINES.length], w = 34 + (k % 3) * 5, j = document.createElement('div');
    j.className = 'jmp';
    j.style.cssText = `left:${x}px;top:${y}px;width:${w}px;--dx:${dx}px;--fall:${250 + (k % 3) * 25}px;--tilt:${(dx * 0.07).toFixed(1)}deg`;
    j.innerHTML = `<img src="${B3('para' + ((k % 4) + 1))}" alt="">`;
    j.addEventListener('animationend', (e) => { if (e.target === j && e.animationName === 'jfade') j.remove(); });
    air.append(j);
  }
  // the 3D trophy (assets/trophy.js, loaded only when its chapter shows)
  function trophy3d(sec) {
    const host = sec.querySelector('.cup3d');
    if (!host || host._on) return;
    host._on = true;
    import('./trophy.js').then(({ mountTrophy }) => {
      const pic = host.querySelector('img');
      return mountTrophy(host).then((stop) => { if (pic) pic.remove(); stops.push(stop); });
    }).catch(() => {});
  }
  const stops = [];

  // the photo moves a little with the phone (tilt) for depth; the near layer more than the far one
  function tilt(sec) {
    const far = sec.querySelector('.far'), near = sec.querySelector('.near');
    if (!far || sec._tilt) return;
    sec._tilt = true;
    const on = (gx, gy) => { far.style.translate = `${gx * 6}px ${gy * 4}px`; near.style.translate = `${gx * 14}px ${gy * 8}px`; };
    addEventListener('deviceorientation', (e) => { if (e.gamma != null) on(Math.max(-1, Math.min(1, e.gamma / 30)), Math.max(-1, Math.min(1, (e.beta - 45) / 40))); });
    sec.addEventListener('pointermove', (e) => on((e.clientX / innerWidth - .5) * 2, (e.clientY / innerHeight - .5) * 2));
  }

  let el = null;
  function open() {
    if (el || typeof D === 'undefined' || !D) return;
    const parts = [hero(), register(), path(), match(), points(), rules(), ready()];
    el = document.createElement('div');
    el.id = 'intro';
    el.innerHTML = `<div class="gate"><div class="brand"><span class="dv">DEVIL</span><span class="es"><i></i>ESPORTS<i></i></span></div>
      <button class="enter"><i class="ring"></i><img src="${B3('para1')}" alt=""><span><b>ورود به میدان</b><small>TAP TO DEPLOY</small></span></button></div><button class="skip" onclick="Intro.done(true)">رد کردن<svg viewBox="0 0 24 24"><path d="M13 6l-6 6 6 6M19 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button><div class="dots">${parts.map(() => '<i></i>').join('')}</div>
      <div class="hint"><img src="${A3('backhand_index_pointing_up')}" alt=""><div class="chev"><span></span><span></span><span></span></div>بکش بالا</div>${parts.join('')}`;
    document.body.append(el);
    document.body.style.overflow = 'hidden';
    startMusic();
    const gate = el.querySelector('.gate');
    gate.querySelector('.enter').onclick = (e) => {
      e.stopPropagation(); wanted = true; play();
      gate.classList.add('go'); setTimeout(() => gate.remove(), 700);
      if (typeof tg !== 'undefined' && tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('medium');
    };
    startSfx = new Audio(START); startSfx.preload = 'auto'; startSfx.volume = .9;
    // if the browser blocked the music, the first touch starts it
    const EV = ['pointerdown', 'touchstart', 'touchend', 'click'];
    const first = () => { if (music && music.paused && wanted) play(); if (music && !music.paused) EV.forEach((n) => el && el.removeEventListener(n, first, true)); };
    EV.forEach((n) => el.addEventListener(n, first, { capture: true, passive: true }));
    const secs = [...el.querySelectorAll('.is')], dots = [...el.querySelectorAll('.dots i')], hint = el.querySelector('.hint');
    const io = new IntersectionObserver((list) => list.forEach((e) => {
      if (!e.isIntersecting) return;
      const i = secs.indexOf(e.target);
      e.target.classList.add('on');
      flights(e.target); tilt(e.target); trophy3d(e.target);
      dots.forEach((d, k) => d.classList.toggle('on', k === i));
      if (i > 0) hint.classList.add('off'); // shown on the first chapter only: after one swipe they know
      if (typeof tg !== 'undefined' && tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged();
    }), { root: el, threshold: 0.5 });
    secs.forEach((s) => io.observe(s));
  }
  function done(skipped) {
    try { localStorage.setItem(KEY, '1'); } catch {}
    if (!el) return;
    if (!skipped) { if (startSfx) { startSfx.currentTime = 0; startSfx.play().catch(startSound); } else startSound(); }
    stopMusic();
    stops.splice(0).forEach((f) => { try { f(); } catch {} });
    el.classList.add('bye');
    if (typeof tg !== 'undefined' && tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('heavy');
    const x = el; el = null;
    setTimeout(() => { x.remove(); document.body.style.overflow = ''; }, 560);
    if (page !== 'admin') go('home');
  }
  function maybe() {
    if (Q.get('admin')) return;
    let seen = false;
    try { seen = localStorage.getItem(KEY) === '1'; } catch {}
    if (!seen) open();
  }
  return { open, done, maybe };
})();
