/* Presentation layer only. Original tournament endpoints and scoring are unchanged. */
window.Arena = (() => {
  const names={home:'home',mine:'shield',sched:'calendar',results:'swords',teams:'users',table:'chart-bar',admin:'settings'};
  // 3D icons (assets/3d, Fluent Emoji, MIT) for the nav and page titles
  const d3={home:'house',mine:'shield',sched:'spiral_calendar',results:'crossed_swords',teams:'busts_in_silhouette',table:'bar_chart',admin:'gear',
    calendar:'spiral_calendar',swords:'crossed_swords',users:'busts_in_silhouette','chart-bar':'bar_chart',settings:'gear',shield:'shield'};
  const icon=(name)=>{const k=d3[name]||d3[names[name]];return k?`<img class="arena-icon e3d" src="assets/3d/${k}.webp" alt="" aria-hidden="true">`:`<img class="arena-icon" src="assets/icons/${names[name]||name}.svg" alt="" aria-hidden="true">`;};
  const media=matchMedia('(prefers-reduced-motion: reduce)');
  let off=false;try{off=localStorage.getItem('devil-motion')==='off'}catch{}
  const reduced=()=>off||media.matches;
  const labels={mine:['اسکواد من','MY SQUAD','بازیکن‌ها، جایگاه و مسیر رقابت تیم تو'],sched:['برنامه مسابقات','MATCH SCHEDULE','روز و ساعت مچ‌ها، مطابق برنامه تورنمنت'],results:['گزارش میدان نبرد','MATCH RESULTS','نتایج تأییدشده، کیل‌ها و بهترین بازیکن‌ها'],teams:['اسکوادهای تورنمنت','THE SQUADS','تیم‌ها، گروه‌بندی و آمار بازیکن‌ها'],table:['جدول رقابت','LEADERBOARD','امتیازها و جایگاه تیم‌ها در هر مرحله'],admin:['اتاق فرمان','TOURNAMENT ADMIN','ثبت‌نام، برنامه مچ‌ها و مدیریت تیم‌ها']};
  const emoji={'🏆':'trophy','👑':'crown','🗺':'map','🗓':'calendar','⭐':'star','📜':'list-details','🎯':'target','📊':'chart-bar','⚖️':'scale','🛡':'shield','🎮':'device-gamepad-2','👥':'users','📝':'edit','🔥':'flame','🍗':'trophy','🥇':'medal','🥈':'medal','🥉':'medal','📣':'speakerphone'};
  function replaceIcons(root){
    return; // superseded by assets/fx3d.js
    root.querySelectorAll('.ttl,.step .c span,.win .e,.sh,.acc>button,.tr2.head .c').forEach(el=>{
      const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);const texts=[];while(walker.nextNode())texts.push(walker.currentNode);
      texts.forEach(n=>{let txt=n.textContent;const re=/(🏆|👑|🗺️?|🗓️?|⭐|📜|🎯|📊|⚖️?|🛡️?|🎮|👥|📝|🔥|🍗|🥇|🥈|🥉|📣)/gu;
        if(!re.test(txt))return;re.lastIndex=0;const frag=document.createDocumentFragment();let start=0;for(const m of txt.matchAll(re)){frag.append(document.createTextNode(txt.slice(start,m.index)));const key=m[0].replace(/\ufe0f/g,'');const name=emoji[m[0]]||emoji[key]||(key==='⚖'?'scale':key==='🛡'?'shield':key==='🗺'?'map':'calendar');const im=document.createElement('img');im.src=`assets/icons/${name}.svg`;im.className='arena-icon';im.alt='';im.setAttribute('aria-hidden','true');frag.append(im);start=m.index+m[0].length;}frag.append(document.createTextNode(txt.slice(start)));n.replaceWith(frag)});
    });
  }
  function enhance(page,D){
    const app=document.getElementById('app');app.dataset.page=page;
    if(labels[page]){const [title,en,desc]=labels[page],banner=document.createElement('section');banner.className=['mine','teams'].includes(page)?'arena-banner squad-banner':'arena-page-title';
      if(banner.classList.contains('arena-banner')){const im=document.createElement('img');im.src='assets/images/squad.webp';im.alt='اسکواد بتل‌رویال';banner.append(im);const box=document.createElement('div');box.innerHTML=`<small>${en}</small><h2>${title}</h2><p>${desc}</p>`;banner.append(box)}else banner.innerHTML=`${icon(page)}<h2>${title}</h2><small>${en}</small>`;app.prepend(banner)}
    const bottom=document.getElementById('bottom');if(!bottom.querySelector('.arena-logo')){const b=document.createElement('div');b.className='arena-logo';b.innerHTML='<img src="assets/icons/parachute.svg" alt=""><b>DEVIL</b><small>BATTLE ROYALE TOURNAMENT</small>';bottom.prepend(b)}
    if(page==='teams'){const box=document.createElement('div');box.className='arena-search';const inp=document.createElement('input');inp.type='search';inp.placeholder='جست‌وجوی نام تیم…';inp.setAttribute('aria-label','جست‌وجوی نام تیم');box.append(inp);app.querySelector('.arena-banner').after(box);const empty=document.createElement('p');empty.className='arena-empty';empty.hidden=true;empty.textContent='تیمی با این نام پیدا نشد.';app.append(empty);inp.addEventListener('input',()=>{let visible=0;app.querySelectorAll('.tc').forEach(c=>{c.hidden=!c.querySelector('b').textContent.toLowerCase().includes(inp.value.trim().toLowerCase());if(!c.hidden)visible++});empty.hidden=visible>0})}
    replaceIcons(app);replaceIcons(document.getElementById('sheet'));
    app.querySelectorAll('.step,.g,.tc,.tr2[onclick],.mh').forEach(el=>{el.tabIndex=0;el.setAttribute('role','button');el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();el.click()}}});
    document.querySelectorAll('.acc>button').forEach(el=>el.setAttribute('aria-expanded',el.parentElement.classList.contains('open')));
    const sheet=document.querySelector('.sheet');if(sheet){sheet.setAttribute('role','dialog');sheet.setAttribute('aria-modal','true');sheet.setAttribute('aria-label','جزئیات تیم')}
  }
  let frame=0,last=0,particles=[],canvas,ctx,w=0,h=0;
  function resize(){if(!canvas)return;w=innerWidth;h=innerHeight;const dpr=Math.min(devicePixelRatio||1,1.5);canvas.width=w*dpr;canvas.height=h*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);particles=Array.from({length:w<700?13:23},()=>({x:Math.random()*w,y:Math.random()*h,r:.5+Math.random()*1.3,v:5+Math.random()*12,a:.1+Math.random()*.45}))}
  function tick(t){if(reduced()||document.hidden){frame=0;return}const dt=Math.min((t-last)/1000,.06);last=t;ctx.clearRect(0,0,w,h);particles.forEach(p=>{p.y-=p.v*dt;p.x+=Math.sin(t/2100+p.y)*dt*4;if(p.y<0){p.y=h;p.x=Math.random()*w}ctx.fillStyle=`rgba(255,186,67,${p.a})`;ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fill()});frame=requestAnimationFrame(tick)}
  function sync(){document.documentElement.classList.toggle('motion-off',reduced());const b=document.getElementById('motion-toggle');if(b){b.setAttribute('aria-pressed',String(!reduced()));b.title=reduced()?'فعال‌کردن افکت‌ها':'توقف افکت‌ها';b.setAttribute('aria-label',b.title);b.innerHTML=icon(reduced()?'player-play':'player-pause')}if(reduced()){cancelAnimationFrame(frame);frame=0;if(ctx)ctx.clearRect(0,0,w,h)}else if(ctx&&!frame&&!document.hidden){last=performance.now();frame=requestAnimationFrame(tick)}}
  document.addEventListener('DOMContentLoaded',()=>{canvas=document.getElementById('arena-particles');ctx=canvas.getContext('2d');resize();document.getElementById('motion-toggle').onclick=()=>{off=!off;try{localStorage.setItem('devil-motion',off?'off':'on')}catch{}sync()};sync();if(window.__api){const n=document.createElement('div');n.className='preview-notice';n.textContent='پیش‌نمایش با داده‌های نمونه‌ی پروژه · بدون اتصال به ربات';document.getElementById('hdr').prepend(n)}});
  window.addEventListener('resize',resize);document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(frame);frame=0}else sync()});media.addEventListener?.('change',sync);
  return {icon,enhance,reduced};
})();
