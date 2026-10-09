/* ReelScribe mascot. One shared file, no dependencies.
   Plays the 23 animations from cloudee_avatar.json on a green mascot with a speech bubble.
   Loaded by: index, transcript, clips-dashboard, dashboard, history, pricing, login, referral.
   API: ReelMascot.say(animation, text, ms) / setBusy(animation, text) / clearBusy() / hide() */
(function () {
  'use strict';
  if (window.ReelMascot) return;
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }

  var D = {"e":{"neutral":[13.9,45.4,-1.1,0,13.9,45.4,-1.1,0,12.8,0,0,0,"none","none"],"upward-side-glance":[16.4,37.8,-14.6,0,16.4,37.8,-14.6,0,32.1,7.3,27.8,-16.1,"none","none"],"downward-gaze":[16.3,50.0,5.9,0,16.3,50.0,5.9,0,35.5,-15.1,0.1,-14.5,"none","none"],"skeptical-right":[17.0,53.1,5.9,0,43.9,10,5.9,0,34.1,-16.5,-3.8,-13.7,"none","none"],"small-attentive":[16.0,35.0,5.9,0,16.0,35.0,5.9,0,28.7,-4.2,14.4,11.2,"none","none"],"wide-downward-gaze":[46.0,46.9,5.9,0,47.1,47.6,5.9,0,47.3,-19.2,15.2,11.8,"none","none"],"surprised-left":[45.6,47.2,5.9,0,45.6,47.2,5.9,0,48.7,2.9,-16.1,-20.9,"none","none"],"sleepy-squint":[45.7,10,5.9,0,45.7,10,5.9,0,41.6,3.4,13.2,9.0,"none","none"],"angry-right":[14.9,35.8,5.9,-30.9,14.9,35.8,5.9,28.8,29.8,8.1,17.6,-11.1,"none","none"],"curious-left":[14.5,43.2,5.9,23.5,14.5,43.2,5.9,-24.0,32.7,-12.3,-17.6,5.9,"none","none"],"asymmetric-down-right":[36.4,37.2,5.9,0,16.0,17.6,5.9,0,39.5,-20.1,12.6,-12.7,"none","none"],"attentive-left":[17.8,53.6,5.9,0,17.8,53.6,5.9,0,34.6,1.4,6.2,10.6,"none","none"],"joyful-wide":[28.1,80.8,5.9,0,28.1,78.6,5.9,0,37.2,-2.1,-15.9,-14.5,"none","none"],"eyes-closed":[50.1,10.9,5.9,0,50.1,10.6,5.9,0,47.0,-8.8,-8.7,-10.8,"none","none"],"joyful-down-right":[25.2,72.1,5.9,0,25.2,72.1,5.9,0,46.5,-15.3,15.0,12.8,"none","none"],"skeptical-left":[18.2,54.7,5.9,0,42.9,10,5.9,0,40.0,3.5,-7.1,9.8,"none","none"],"far-right-glance":[16.4,35.2,5.9,0,16.4,35.2,5.9,0,31.7,0.3,35.3,-10.9,"none","none"],"angry-left":[13.5,44.1,5.9,-27.6,13.5,44.1,5.9,26.1,32.9,-14.8,-19.4,5.6,"none","none"],"playful-right":[13.0,38.8,5.9,26.3,13.0,38.8,5.9,-20.2,29.5,-4.4,14.1,-16.1,"none","none"],"asymmetric-up-left":[36.0,37.1,5.9,0,16.1,17.5,5.9,0,38.2,6.6,4.7,12.8,"none","none"],"gentle-downward-gaze":[17.0,54.1,5.9,0,17.0,54.1,5.9,0,34.0,-6.1,-11.0,-14.0,"none","none"],"wide-down-left":[29.4,74.5,5.9,0,29.4,74.5,5.9,0,48.6,-17.1,18.1,13.9,"none","none"],"surprised-wide-left":[45.3,45.5,5.9,0,44.4,44.8,5.9,0,46.8,-5.4,-11.7,-13.5,"none","none"],"drowsy-closed":[49.6,10.0,5.9,0,49.6,10.0,5.9,0,46.2,10.3,3.4,7.6,"none","none"],"suspicious-right":[17.9,51.3,-3.9,0,47.5,10,-3.9,0,37.7,-17.8,10,-10.9,"none","none"],"shy-downward":[15.4,27.4,45.9,0,17.1,28.9,45.9,0,29.0,7.1,7.8,3.9,"none","none"],"angry-brows":[21.1,58.4,5.9,-36.2,21.1,58.4,5.9,27.7,46.5,10.5,5.1,4.7,"none","shake"],"uneasy-left":[14.5,43.2,5.9,23.5,14.5,43.2,5.9,-24.0,32.7,-12.3,-17.6,5.9,"shake","slowDrift"]},"a":{"sleeping":{"s":[["eyes-closed",3600,500],["drowsy-closed",3600,500],["sleepy-squint",3600,500]],"b":[4800,6500,9500,420]},"waking":{"s":[["eyes-closed",2300,500]],"b":[1200,1800,3600,220]},"idle":{"s":[["upward-side-glance",5200,500],["curious-left",5200,500]],"b":[2600,3400,6200,280]},"listening":{"s":[["attentive-left",2300,500],["downward-gaze",2300,500],["gentle-downward-gaze",2300,500]],"b":[3200,4800,7200,240]},"thinking":{"s":[["curious-left",2300,500],["angry-left",2300,500],["skeptical-left",2300,500],["playful-right",2300,500],["skeptical-right",2300,500]],"b":[2100,2800,5000,260]},"searching":{"s":[["far-right-glance",2300,500],["asymmetric-down-right",2300,500],["surprised-left",2300,500],["wide-down-left",2300,500],["wide-downward-gaze",2300,500],["asymmetric-up-left",2300,500]],"b":[2100,2800,5000,260]},"working":{"s":[["angry-right",2300,500],["angry-left",2300,500],["joyful-wide",2300,500],["attentive-left",2300,500]],"b":[2100,2800,5000,260]},"excited":{"s":[["joyful-down-right",2300,500],["playful-right",2300,500],["surprised-wide-left",2300,500],["surprised-left",2300,500],["joyful-wide",2300,500]],"b":[1200,1800,3600,220]},"bored":{"s":[["sleepy-squint",3600,500],["drowsy-closed",3600,500],["upward-side-glance",3600,500]],"b":[4800,6500,9500,420]},"suspicious":{"s":[["skeptical-left",2300,500],["skeptical-right",2300,500],["suspicious-right",2300,500]],"b":[2100,2800,5000,260]},"angry":{"s":[["angry-right",2300,500],["angry-left",2300,500]],"b":[2100,2800,5000,260]},"drowsy":{"s":[["sleepy-squint",3600,500],["drowsy-closed",3600,500],["eyes-closed",3600,500]],"b":[4800,6500,9500,420]},"happy":{"s":[["joyful-down-right",2300,500],["joyful-wide",2300,500],["playful-right",2300,500],["gentle-downward-gaze",2300,500]],"b":[2100,2800,5000,260]},"curious":{"s":[["surprised-left",2300,500],["surprised-wide-left",2300,500],["upward-side-glance",2300,500],["far-right-glance",2300,500]],"b":[2100,2800,5000,260]},"confused":{"s":[["skeptical-left",2300,500],["skeptical-right",2300,500],["curious-left",2300,500]],"b":[2100,2800,5000,260]},"surprised":{"s":[["surprised-left",2300,500],["surprised-wide-left",2300,500]],"b":[1200,1800,3600,220]},"proud":{"s":[["far-right-glance",2300,500],["curious-left",2300,500],["joyful-down-right",2300,500]],"b":[2100,2800,5000,260]},"shy":{"s":[["upward-side-glance",2300,500],["shy-downward",2300,500],["eyes-closed",2300,500]],"b":[2100,2800,5000,260]},"sad":{"s":[["sleepy-squint",3600,500],["eyes-closed",3600,500],["drowsy-closed",3600,500]],"b":[4800,6500,9500,420]},"laughing":{"s":[["joyful-down-right",2300,500],["joyful-wide",2300,500],["playful-right",2300,500]],"b":[1200,1800,3600,220]},"scared":{"s":[["surprised-left",2300,500],["surprised-wide-left",2300,500]],"b":[1200,1800,3600,220]},"playful":{"s":[["joyful-down-right",2300,500],["playful-right",2300,500],["joyful-wide",2300,500],["curious-left",2300,500]],"b":[2100,2800,5000,260]},"celebrate":{"s":[["joyful-down-right",2300,500],["curious-left",2300,500],["playful-right",2300,500]],"b":[1200,1800,3600,220]}},"x":{"sleeping":["flat","rest","slow",0],"waking":["smile","wave","float",0],"idle":["o","rest","float",0],"listening":["o","rest","float",0],"thinking":["flat","rest","float",0],"searching":["o","rest","tilt",0],"working":["o","rest","fast",0],"excited":["big","cheer","bounce",0],"bored":["flat","rest","slow",0],"suspicious":["flat","rest","tilt",0],"angry":["frown","rest","float",0],"drowsy":["o","rest","slow",0],"happy":["smile","rest","float",0],"curious":["o","rest","tilt",0],"confused":["wavy","rest","tilt",0],"surprised":["bigo","cheer","bounce",0],"proud":["smile","rest","float",0],"shy":["smile","rest","float",0],"sad":["frown","rest","slow",0],"laughing":["big","cheer","bounce",0],"scared":["bigo","rest","fast",0],"playful":["big","wave","tilt",0],"celebrate":["big","cheer","jump",1]}}, E = D.e, A = D.a, X = D.x, K = .55;
  var reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  var CSS = '#rsm-wrap{position:fixed;right:14px;bottom:14px;z-index:9990;pointer-events:none;font-family:"Instrument Sans",system-ui,sans-serif}' +
    '#rsm-bub{position:absolute;bottom:100%;right:0;margin-bottom:6px;width:max-content;max-width:210px;background:#EEE9C6;color:#1B2412;border:1px solid #d9d3a4;border-radius:14px;padding:8px 12px;font-size:13px;line-height:1.35;font-weight:500;opacity:0;transform:translateY(6px) scale(.96);transition:opacity .2s,transform .2s;box-shadow:0 4px 14px rgba(0,0,0,.12)}' +
    '#rsm-bub.on{opacity:1;transform:none}' +
    '#rsm-wrap.rsm-left #rsm-bub{right:auto;left:0}#rsm-wrap.rsm-below #rsm-bub{bottom:auto;top:100%;margin:6px 0 0}' +
    '#rsm-box{position:relative;width:112px;pointer-events:auto;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent}' +
    '#rsm-box.rsm-grab{cursor:grabbing}#rsm-box:focus-visible{outline:2px solid #6FD62A;outline-offset:2px;border-radius:12px}' +
    '#rsm-box svg{display:block;width:100%;height:auto;overflow:visible}' +
    '#rsm-x,#rsm-s{position:absolute;top:0;width:22px;height:22px;border-radius:50%;border:0;background:rgba(14,14,16,.7);color:#fff;padding:0;cursor:pointer;opacity:0;transition:opacity .2s;display:flex;align-items:center;justify-content:center}' +
    '#rsm-x{right:0;font:600 14px/1 system-ui,sans-serif}#rsm-s{left:0}#rsm-s.on{background:#6FD62A;color:#17220F;opacity:.9}' +
    '#rsm-box:hover #rsm-x,#rsm-box:hover #rsm-s,#rsm-x:focus-visible,#rsm-s:focus-visible{opacity:1}' +
    '@media (hover:none){#rsm-x,#rsm-s{opacity:.75}}' +
    '#rsm-back{position:fixed;right:14px;bottom:14px;z-index:9990;width:40px;height:40px;border-radius:50%;border:0;padding:0;background:transparent;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.2)}#rsm-back svg{display:block}' +
    '@media (max-width:480px){#rsm-back{right:8px;bottom:8px}}@media print{#rsm-back{display:none}}' +
    '@media (max-width:480px){#rsm-wrap{right:8px;bottom:8px}#rsm-box{width:76px}#rsm-bub{max-width:170px;font-size:12px}}' +
    '@media print{#rsm-wrap{display:none}}' +
    '.rsm-m{transform-origin:110px 249px}.rsm-an{transform-origin:112px 166px;animation:rsm-sway 2s ease-in-out infinite alternate}' +
    '.rsm-ra{transform-origin:148px 208px}.rsm-la{transform-origin:72px 208px}' +
    '.rsm-b-float .rsm-m{animation:rsm-float 2.4s ease-in-out infinite alternate}' +
    '.rsm-b-slow .rsm-m{animation:rsm-float 4s ease-in-out infinite alternate}' +
    '.rsm-b-fast .rsm-m{animation:rsm-float .9s ease-in-out infinite alternate}' +
    '.rsm-b-bounce .rsm-m{animation:rsm-bounce .5s ease-in-out infinite}' +
    '.rsm-b-jump .rsm-m{animation:rsm-jump .9s ease-in-out infinite}' +
    '.rsm-b-tilt .rsm-m{animation:rsm-tilt 1.8s ease-in-out infinite}' +
    '.rsm-a-wave .rsm-ra{animation:rsm-waveR .5s ease-in-out infinite alternate}' +
    '.rsm-a-cheer .rsm-ra{animation:rsm-cheerR .28s ease-in-out infinite alternate}' +
    '.rsm-a-cheer .rsm-la{animation:rsm-cheerL .28s ease-in-out infinite alternate}' +
    '.rsm-conf{opacity:0}.rsm-conf-on .rsm-conf{opacity:1}' +
    '.rsm-conf circle,.rsm-conf rect{animation:rsm-fall 1s linear infinite}.rsm-conf *:nth-child(2n){animation-delay:.3s}.rsm-conf *:nth-child(3n){animation-delay:.6s}' +
    '@keyframes rsm-float{0%{transform:translateY(0)}100%{transform:translateY(-5px)}}' +
    '@keyframes rsm-bounce{0%,100%{transform:translateY(0) scale(1.05,.95)}50%{transform:translateY(-22px) scale(.97,1.03)}}' +
    '@keyframes rsm-jump{0%,100%{transform:translateY(0) rotate(0)}30%{transform:translateY(-34px) rotate(-6deg)}65%{transform:translateY(-34px) rotate(6deg)}}' +
    '@keyframes rsm-tilt{0%,100%{transform:rotate(-6deg)}50%{transform:rotate(6deg)}}' +
    '@keyframes rsm-waveR{0%{transform:rotate(-95deg)}100%{transform:rotate(-130deg)}}' +
    '@keyframes rsm-cheerR{0%{transform:rotate(-105deg)}100%{transform:rotate(-135deg)}}' +
    '@keyframes rsm-cheerL{0%{transform:rotate(105deg)}100%{transform:rotate(135deg)}}' +
    '@keyframes rsm-sway{0%{transform:rotate(-6deg)}100%{transform:rotate(8deg)}}' +
    '@keyframes rsm-fall{0%{transform:translateY(-8px);opacity:1}100%{transform:translateY(28px);opacity:0}}' +
    '@media (prefers-reduced-motion:reduce){.rsm-m,.rsm-an,.rsm-ra,.rsm-la,.rsm-conf *{animation:none!important}#rsm-bub{transition:none}}';

  var SVG = '<svg id="rsm" viewBox="10 95 200 180" aria-hidden="true" focusable="false">' +
    '<ellipse cx="110" cy="262" rx="36" ry="5" fill="#1B2412" opacity=".12"/>' +
    '<g class="rsm-m"><g id="rsm-roll">' +
    '<g class="rsm-an"><path d="M112 168 Q114 150 128 146" fill="none" stroke="#6FD62A" stroke-width="4" stroke-linecap="round"/><circle cx="131" cy="143" r="5.5" fill="#B6F56E"/></g>' +
    '<g class="rsm-la"><line x1="72" y1="208" x2="54" y2="228" stroke="#6FD62A" stroke-width="9" stroke-linecap="round"/><circle cx="52" cy="231" r="7" fill="#8CE84A"/></g>' +
    '<g class="rsm-ra"><line x1="148" y1="208" x2="166" y2="228" stroke="#6FD62A" stroke-width="9" stroke-linecap="round"/><circle cx="168" cy="231" r="7" fill="#8CE84A"/></g>' +
    '<circle cx="110" cy="205" r="44" fill="#6FD62A"/>' +
    '<ellipse cx="92" cy="182" rx="14" ry="8" fill="#B6F56E" opacity=".7" transform="rotate(-30 92 182)"/>' +
    '<g id="rsm-face"><g id="rsm-eyes"><g id="rsm-eL"><rect fill="#17220F"/></g><g id="rsm-eR"><rect fill="#17220F"/></g></g>' +
    '<path id="rsm-mo" transform="translate(0 11)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></g>' +
    '</g></g>' +
    '<g class="rsm-conf"><circle cx="40" cy="170" r="4" fill="#B6F56E"/><rect x="60" y="140" width="7" height="7" fill="#FF6A3D"/><circle cx="180" cy="165" r="4" fill="#FFD166"/><rect x="170" y="195" width="7" height="7" fill="#B6F56E"/><circle cx="30" cy="225" r="3.5" fill="#FFD166"/><rect x="190" y="145" width="7" height="7" fill="#FF6A3D"/></g>' +
    '</svg>';

  var BELL = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M12 3a6 6 0 0 0-6 6v4l-2 3h16l-2-3V9a6 6 0 0 0-6-6zm-2 15a2 2 0 0 0 4 0z" fill="currentColor"/></svg>';
  var CHIP = '<svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true"><circle cx="20" cy="20" r="20" fill="#6FD62A"/><ellipse cx="14" cy="12" rx="6" ry="3" fill="#B6F56E" opacity=".7" transform="rotate(-30 14 12)"/><rect x="12" y="15" width="5" height="12" rx="2.5" fill="#17220F"/><rect x="23" y="15" width="5" height="12" rx="2.5" fill="#17220F"/></svg>';
  var M = { o: ['M107 218a3 4 0 1 0 6 0a3 4 0 1 0-6 0', 1], bigo: ['M105 217a5 6 0 1 0 10 0a5 6 0 1 0-10 0', 1], smile: ['M101 215Q110 224 119 215', 0], big: ['M100 213Q110 232 120 213Z', 1], flat: ['M102 218L118 218', 0], wavy: ['M100 219Q105 213 110 219T120 219', 0], frown: ['M101 222Q110 214 119 222', 0] };

  var wrap, box, bub, svg, roll, face, eyes, mo, eL, eR, rL, rR;
  var cur = E.neutral.slice(0, 12), startV = cur, name = '', steps = [], vec = [], cyc = 1, t0 = 0, blink = [0, 1, 2, 1], nb = 0, si = 0;
  var running = false, busy = null, hideT = 0, backT = 0, lastAct = Date.now(), hoverOn = false;
  var lookX = 0, lookY = 0, tgtX = 0, tgtY = 0, focusEl = null, origTitle = null, titleT = 0, audioCtx = null, alertsOn = lsGet('rsmAlerts') === '1', wired = false;

  function ease(t) { return t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function lerp(a, b, t) { var r = [], i; for (i = 0; i < 12; i++) r.push(a[i] + (b[i] - a[i]) * t); return r; }
  function sample(t) {
    var n = steps.length, first = t < cyc, tt = first ? t : (t - cyc) % cyc, prev = first ? startV : vec[n - 1], i, s;
    for (i = 0; i < n; i++) {
      s = steps[i]; si = i;
      if (tt < s[2]) return lerp(prev, vec[i], ease(s[2] ? tt / s[2] : 1));
      tt -= s[2]; if (tt < s[1]) return vec[i]; tt -= s[1]; prev = vec[i];
    }
    si = n - 1; return vec[n - 1];
  }
  function setEye(g, r, w, h, y, a, sd, sp, j) {
    var d = (sp / 2 + w / 2) * K;
    g.setAttribute('transform', 'translate(' + (110 + sd * d) + ',' + (201 + y * K + j) + ') rotate(' + (-a) + ')');
    r.setAttribute('width', w * K); r.setAttribute('height', h * K); r.setAttribute('x', -w * K / 2); r.setAttribute('y', -h * K / 2); r.setAttribute('rx', Math.min(w, h) * K / 2);
  }
  function render(v, now) {
    var ex = E[steps[si][0]], j = ex[12] === 'shake' ? Math.sin(now / 20) * 1.5 : 0, dx = 0, dy = 0;
    if (ex[13] === 'shake') dx = Math.sin(now / 22) * 2.2;
    if (ex[13] === 'slowDrift') { dx = Math.sin(now / 900) * 2.5; dy = Math.cos(now / 1100) * 2; }
    setEye(eL, rL, v[0], v[1], v[2], v[3], -1, v[8], j); setEye(eR, rR, v[4], v[5], v[6], v[7], 1, v[8], -j);
    face.setAttribute('transform', 'translate(' + (Math.max(-15, Math.min(15, v[10] * .4)) + lookX) + ' ' + (-v[9] * .4 + lookY) + ')');
    roll.setAttribute('transform', 'translate(' + dx + ' ' + dy + ') rotate(' + (v[11] * .35) + ' 110 205)');
    var s = 1;
    if (now >= nb) { var p = (now - nb) / blink[3]; if (p >= 1) nb = now + blink[1] + Math.random() * (blink[2] - blink[1]); else s = 1 - .92 * Math.sin(Math.PI * p); }
    eyes.setAttribute('transform', 'translate(0 201) scale(1 ' + s + ') translate(0 -201)');
  }
  function loop(now) {
    if (document.hidden || !wrap || !wrap.isConnected) { running = false; return; }
    var f = (name === 'sleeping' || name === 'drowsy') ? 0 : 1;
    lookX += (tgtX * f - lookX) * .12; lookY += (tgtY * f - lookY) * .12;
    cur = sample(now - t0); render(cur, now); requestAnimationFrame(loop);
  }
  function kick() { if (reduce || running) return; running = true; requestAnimationFrame(loop); }

  function play(n) {
    var a = A[n], x = X[n]; if (!a) return;
    name = n; steps = a.s; vec = steps.map(function (s) { return E[s[0]]; });
    cyc = steps.reduce(function (p, s) { return p + s[1] + s[2]; }, 0);
    startV = cur; t0 = performance.now(); blink = a.b; nb = reduce ? Infinity : t0 + blink[0];
    svg.setAttribute('class', 'rsm-a-' + x[1] + ' rsm-b-' + x[2] + (x[3] ? ' rsm-conf-on' : ''));
    var m = M[x[0]]; mo.setAttribute('d', m[0]); mo.setAttribute('fill', m[1] ? '#17220F' : 'none'); mo.setAttribute('stroke', m[1] ? 'none' : '#17220F');
    if (reduce) { si = 0; cur = vec[0].slice(0, 12); render(cur, 0); } else kick();
  }

  function bubble(text, ms) {
    clearTimeout(hideT);
    if (!text) { bub.classList.remove('on'); return; }
    bub.textContent = text; bub.classList.add('on');
    if (ms) hideT = setTimeout(function () { bub.classList.remove('on'); }, ms);
  }
  function restore() { if (busy) { play(busy.name); bubble(busy.text, 0); } else play('idle'); }
  function say(n, text, ms) {
    if (!wrap) return; ms = ms == null ? 3800 : ms;
    play(n); bubble(text || '', text ? ms : 0);
    clearTimeout(backT); backT = setTimeout(restore, ms);
  }
  function setBusy(n, text) { if (!wrap) return; busy = { name: n, text: text }; clearTimeout(backT); play(n); bubble(text, 0); }
  function clearBusy() { busy = null; }
  function hide() { try { localStorage.setItem('rsmOff', '1'); } catch (e) {} if (wrap) { wrap.remove(); wrap = null; } showChip(); }

  var BTN = '.btn,.cta,.cta-outline,button[type="submit"],.frame-dl,#genBtn';
  var YT = /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/|live\/)|youtu\.be\/)[\w-]{6,}/i;

  function reactAlert(m) {
    if (/success|activated/i.test(m)) say('celebrate', 'All set! Enjoy.', 5000);
    else if (/cancel/i.test(m)) say('sad', 'No worries. Try again anytime.', 5000);
    else if (/log in|login/i.test(m)) say('shy', 'Log in first. It is free.', 5000);
    else if (/error|wrong|fail|could not|contact support/i.test(m)) say('sad', 'Oops, something went wrong.', 5000);
    else say('confused', m.length < 70 ? m : 'Check that and try again.', 5000);
  }

  function aim(x, y) {
    if (!box) return;
    var r = box.getBoundingClientRect(), dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2), d = Math.sqrt(dx * dx + dy * dy) || 1, s = Math.min(1, d / 180);
    tgtX = dx / d * 5 * s; tgtY = dy / d * 4 * s;
  }
  function aimEl(el) { var r = el.getBoundingClientRect(); aim(r.left + Math.min(r.width - 10, 14 + (el.value || '').length * 8), r.top + r.height / 2); }

  function setTitle(t) { if (origTitle === null) origTitle = document.title; document.title = t; clearTimeout(titleT); }
  function resetTitleSoon(ms) { clearTimeout(titleT); titleT = setTimeout(function () { if (origTitle !== null && !busy) { document.title = origTitle; origTitle = null; } }, ms); }
  function ding() {
    try {
      var C = window.AudioContext || window.webkitAudioContext; if (!C) return;
      audioCtx = audioCtx || new C(); if (audioCtx.state === 'suspended') audioCtx.resume();
      var t = audioCtx.currentTime;
      [[880, 0], [1320, .14]].forEach(function (n) {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.type = 'sine'; o.frequency.value = n[0];
        g.gain.setValueAtTime(0, t + n[1]); g.gain.linearRampToValueAtTime(.12, t + n[1] + .02); g.gain.exponentialRampToValueAtTime(.0001, t + n[1] + .35);
        o.connect(g); g.connect(audioCtx.destination); o.start(t + n[1]); o.stop(t + n[1] + .4);
      });
    } catch (e) {}
  }
  function notify(title, ok) {
    setTitle((ok ? '\u2705 ' : '\u26A0\uFE0F ') + title);
    if (alertsOn) {
      if (ok) ding();
      try { if (navigator.vibrate) navigator.vibrate(ok ? [120, 60, 120] : [200]); } catch (e) {}
      try { if (document.hidden && 'Notification' in window && Notification.permission === 'granted') { var n = new Notification('ReelScribe', { body: title, icon: '/assets/favicon.png' }); n.onclick = function () { window.focus(); n.close(); }; } } catch (e) {}
    }
    if (!document.hidden) resetTitleSoon(6000);
  }
  function toggleAlerts(e) {
    e.stopPropagation(); alertsOn = !alertsOn;
    try { localStorage.setItem('rsmAlerts', alertsOn ? '1' : '0'); } catch (err) {}
    syncBell();
    if (!alertsOn) { say('happy', 'Alerts off. I will stay quiet.', 3500); return; }
    ding();
    var msg = 'Alerts on! I will ding when your clips are ready.';
    if ('Notification' in window) {
      if (Notification.permission === 'default') { try { var pr = Notification.requestPermission(); if (pr && pr.then) pr.then(function (p) { if (p !== 'granted') say('shy', 'Notifications are blocked, but sound still works.', 4500); }); } catch (err) {} }
      else if (Notification.permission === 'denied') msg = 'Alerts on (sound and vibration). Notifications are blocked in this browser.';
    } else msg = 'Alerts on (sound and vibration).';
    say('happy', msg, 4500);
  }

  function nameFrom(email) {
    var s = (email || '').split('@')[0].split(/[^A-Za-z]+/).filter(function (x) { return x.length >= 2; })[0];
    return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '';
  }
  function quotaNote(d) {
    var u = d && d.usage; if (!u || !u.clipDayLimit) return '';
    var left = Math.max(0, u.clipDayLimit - (u.clipDay || 0));
    if (left === 0) return "You've used all your clips for today.";
    return left === 1 ? 'Only 1 clip left today.' : '';
  }
  function getJson(url) { return fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.json(); }); }
  function loadInfo() {
    var c; try { c = JSON.parse(ssGet('rsmInfo')); } catch (e) { c = null; }
    if (c) return Promise.resolve(c);
    return getJson('/me').then(function (me) {
      if (!me || !me.loggedIn) return null;
      var info = { name: nameFrom(me.email), note: '' };
      return getJson('/user-plan').then(function (d) { info.note = quotaNote(d); return info; }, function () { return info; });
    }).then(function (info) { if (info) ssSet('rsmInfo', JSON.stringify(info)); return info; }).catch(function () { return null; });
  }

  function watchUrl(id, hint, strict) {
    var inp = document.getElementById(id), tt; if (!inp) return;
    inp.addEventListener('focus', function () { focusEl = inp; aimEl(inp); if (!busy) say('listening', hint, 3000); });
    inp.addEventListener('blur', function () { focusEl = null; });
    inp.addEventListener('input', function () {
      aimEl(inp); clearTimeout(tt);
      tt = setTimeout(function () { var v = inp.value.trim(); if (v && !busy && (!strict || YT.test(v))) say('happy', 'Nice link! Looks good.', 3000); }, 600);
    });
  }

  function watchClips() {
    var pc = document.getElementById('procCard'), ps = document.getElementById('procStatus'), sub = document.getElementById('procSub'), rs = document.getElementById('resultsSection'), on = document.getElementById('outName');
    if (!pc || !rs) return;
    var last = 'idle', MAP = { 1: ['searching', 'Reading your video...'], 2: ['thinking', 'Finding the strongest hooks...'], 3: ['working', 'Cutting your clips...'], 4: ['working', 'Adding captions...'] };
    function shown(el) { return getComputedStyle(el).display !== 'none'; }
    function check() {
      var key = last, i, t;
      if (shown(rs)) key = 'done';
      else if (shown(pc)) {
        if (ps && /error/i.test(ps.textContent)) key = 'err';
        else for (i = 1; i <= 4; i++) { t = document.getElementById('step' + i); if (t && t.classList.contains('active')) key = 'w' + i; }
        if (key === 'done' || key === 'idle') key = 'w1';
      } else if (last !== 'done' && last !== 'err') key = 'idle';
      if (key === last) return;
      last = key;
      if (key === 'done') {
        clearBusy(); var txt = (on && on.textContent || '').trim();
        if (/^0 /.test(txt)) { say('sad', 'No clips came back. Try another video.', 6000); notify('No clips came back', false); }
        else { say('celebrate', (txt || 'Your clips') + '! Ready to download.', 7000); notify('Your clips are ready!', true); }
        getJson('/user-plan').then(function (d) { var n = quotaNote(d); if (n) setTimeout(function () { say('shy', n, 6000); }, 7600); }).catch(function () {});
      } else if (key === 'err') {
        clearBusy(); say('sad', ((sub && sub.textContent) || 'Something went wrong.').slice(0, 80), 7000); notify('Something went wrong', false);
      } else if (MAP[key.slice(1)]) { setBusy(MAP[key.slice(1)][0], MAP[key.slice(1)][1]); setTitle('\u23F3 ' + MAP[key.slice(1)][1]); }
    }
    var mo2 = new MutationObserver(check), o = { attributes: true, childList: true, characterData: true, subtree: true };
    mo2.observe(pc, o); mo2.observe(rs, { attributes: true, attributeFilter: ['style', 'class'] });
    if (on) mo2.observe(on, o);
    ['step1', 'step2', 'step3', 'step4'].forEach(function (id) { var e = document.getElementById(id); if (e) mo2.observe(e, { attributes: true, attributeFilter: ['class'] }); });
  }

  function watchTranscript() {
    var pt = document.getElementById('previewText'); if (!pt) return;
    new MutationObserver(function () {
      var t = pt.textContent.trim(); if (!t) return;
      if (/^(Generating|Uploading)/i.test(t)) { setBusy('working', 'Transcribing... one moment.'); setTitle('\u23F3 Transcribing...'); }
      else if (/error|wrong|fail|invalid|please|too large|try again/i.test(t)) { clearBusy(); say('confused', t.slice(0, 80), 6000); notify('Transcript failed', false); }
      else { clearBusy(); say('happy', 'Transcript ready!', 5000); notify('Your transcript is ready!', true); }
    }).observe(pt, { childList: true, characterData: true, subtree: true });
  }

  function wirePage() {
    var page = (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '') || 'index';
    var hello = { index: "Hey there! Paste a link and I'll cut your clips.", 'clips-dashboard': "Paste a link, pick a style, and let's cut.", transcript: 'Paste a video link or upload a file.', dashboard: 'Welcome back! Ready to cut some clips?', history: 'Your past transcripts live here.', pricing: 'Pick the plan that fits you.', login: 'Hi! Log in and I will get you started.', referral: 'Invite friends and earn free clips.' }[page];
    var tip = { index: 'Paste a link to start.', 'clips-dashboard': 'Ready to cut some clips?', transcript: 'Need a transcript?', dashboard: 'Here is your overview.', history: 'Your transcripts are here.', pricing: 'Pick a plan that fits you.', referral: 'Share your link and earn clips.' }[page] || '';
    if (ssGet('rsmGreeted')) say('waking', '', 2500);
    else {
      ssSet('rsmGreeted', '1');
      var done = false, fb = setTimeout(function () { if (!done) { done = true; say('waking', hello || 'Hi there!', 4500); } }, 1800);
      loadInfo().then(function (info) {
        if (done) return; done = true; clearTimeout(fb);
        var msg = hello || 'Hi there!';
        if (info && info.name) msg = ('Welcome back, ' + info.name + '! ' + tip).trim();
        say('waking', msg, 5000);
        if (info && info.note) setTimeout(function () { say('curious', info.note, 6000); }, 5400);
      });
    }

    if (page === 'index') {
      watchUrl('clipUrl', 'Paste your YouTube link here.', true);
      var og = window.generateClips;
      if (typeof og === 'function') window.generateClips = async function () {
        var inp = document.getElementById('clipUrl'), u = inp ? inp.value.trim() : '';
        if (YT.test(u)) say('excited', "On it! Let's cut some clips.", 3000);
        var r = await og.apply(this, arguments);
        var w = document.getElementById('clipLoginWall');
        if (w && w.style.display === 'block') say('shy', 'Log in (it is free) and I will start.', 5000);
        return r;
      };
    }
    if (page === 'clips-dashboard') { watchUrl('clipUrl', 'Paste your YouTube link here.', false); watchClips(); }
    if (page === 'transcript') { watchUrl('videoUrl', 'Paste a video link, or upload a file.', false); watchTranscript(); }
    if (page === 'login') {
      var os = window.showStatus;
      if (typeof os === 'function') window.showStatus = function (id, msg, type) {
        try { var m = String(msg || '').slice(0, 80); if (type === 'error') say('confused', m, 5000); else say('happy', m, 4000); } catch (e) {}
        return os.apply(this, arguments);
      };
      ['loginEmail', 'signupEmail'].forEach(function (id) { var e = document.getElementById(id); if (e) e.addEventListener('focus', function () { say('listening', 'Enter your email and I will send a code.', 3500); }); });
      ['loginOtp', 'signupOtp'].forEach(function (id) { var e = document.getElementById(id); if (e) e.addEventListener('focus', function () { say('curious', 'Type the 6-digit code.', 3500); }); });
    }
    if (page === 'referral') {
      var c = document.getElementById('copy'); if (c) c.addEventListener('click', function () { say('happy', 'Link copied! Go share it.', 3500); });
      ['wa', 'tg'].forEach(function (id) { var e = document.getElementById(id); if (e) e.addEventListener('click', function () { say('excited', 'Thanks for sharing!', 3500); }); });
    }
  }

  var dragged = false;
  function vp() { return [document.documentElement.clientWidth, window.innerHeight]; }
  function setLT(l, t) {
    var r = wrap.getBoundingClientRect(), v = vp();
    l = Math.max(4, Math.min(v[0] - r.width - 4, l)); t = Math.max(4, Math.min(v[1] - r.height - 4, t));
    wrap.style.right = 'auto'; wrap.style.bottom = 'auto'; wrap.style.left = l + 'px'; wrap.style.top = t + 'px';
    wrap.classList.toggle('rsm-left', l + r.width / 2 < v[0] / 2); wrap.classList.toggle('rsm-below', t + r.height / 2 < v[1] / 2);
  }
  function savePos() {
    var r = wrap.getBoundingClientRect(), v = vp(), fx = v[0] - r.width > 0 ? r.left / (v[0] - r.width) : 1, fy = v[1] - r.height > 0 ? r.top / (v[1] - r.height) : 1;
    try { localStorage.setItem('rsmPos', JSON.stringify([fx, fy])); } catch (e) {}
  }
  function applyPos() {
    var p; try { p = JSON.parse(lsGet('rsmPos')); } catch (e) { p = null; }
    if (!p || p.length !== 2 || !wrap) return;
    var r = wrap.getBoundingClientRect(), v = vp();
    setLT(p[0] * (v[0] - r.width), p[1] * (v[1] - r.height));
  }
  function resetPos() {
    try { localStorage.removeItem('rsmPos'); } catch (e) {}
    wrap.style.left = wrap.style.top = wrap.style.right = wrap.style.bottom = ''; wrap.classList.remove('rsm-left', 'rsm-below');
  }
  function setupDrag() {
    var drag = null;
    box.addEventListener('pointerdown', function (e) {
      if ((e.target.closest && e.target.closest('#rsm-x,#rsm-s')) || (e.pointerType === 'mouse' && e.button !== 0)) return;
      var r = wrap.getBoundingClientRect(); drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, l: r.left, t: r.top, on: false };
      try { box.setPointerCapture(e.pointerId); } catch (err) {}
    });
    box.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.on) {
        if (Math.abs(dx) + Math.abs(dy) < 8) return;
        drag.on = true; dragged = true;
        box.classList.add('rsm-grab'); clearTimeout(backT); play('surprised'); bubble('', 0);
      }
      setLT(drag.l + dx, drag.t + dy);
    });
    function end(e) {
      if (!drag || e.pointerId !== drag.id) return;
      var was = drag.on; drag = null; box.classList.remove('rsm-grab');
      if (was) { savePos(); say('happy', '', 1200); setTimeout(function () { dragged = false; }, 60); }
    }
    box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
    box.addEventListener('dblclick', function () { resetPos(); say('happy', 'Back in my corner!', 2500); });
    box.addEventListener('keydown', function (e) {
      var k = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] }[e.key];
      if (k) { e.preventDefault(); var r = wrap.getBoundingClientRect(); setLT(r.left + k[0], r.top + k[1]); savePos(); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); box.click(); }
    });
    window.addEventListener('resize', function () { applyPos(); if (focusEl) aimEl(focusEl); });
    applyPos();
  }

  function ensureCss() {
    if (document.getElementById('rsm-css')) return;
    var st = document.createElement('style'); st.id = 'rsm-css'; st.textContent = CSS; document.head.appendChild(st);
  }
  function showChip() {
    if (document.getElementById('rsm-back')) return;
    ensureCss();
    var b = document.createElement('button'); b.id = 'rsm-back'; b.type = 'button'; b.title = 'Show mascot'; b.setAttribute('aria-label', 'Show mascot'); b.innerHTML = CHIP;
    b.addEventListener('click', function () { try { localStorage.removeItem('rsmOff'); } catch (e) {} b.remove(); build(); wireGlobal(); });
    document.body.appendChild(b);
  }
  function syncBell() {
    var b = wrap && wrap.querySelector('#rsm-s');
    if (b) { b.classList.toggle('on', alertsOn); b.setAttribute('aria-pressed', alertsOn ? 'true' : 'false'); }
  }

  function build() {
    ensureCss();
    wrap = document.createElement('div'); wrap.id = 'rsm-wrap';
    wrap.innerHTML = '<div id="rsm-bub" aria-hidden="true"></div><div id="rsm-box" tabindex="0" role="button" aria-label="Mascot. Drag to move it, or use the arrow keys.">' + SVG +
      '<button id="rsm-s" type="button" aria-pressed="false" aria-label="Sound and notifications" title="Sound and notifications">' + BELL + '</button>' +
      '<button id="rsm-x" type="button" aria-label="Hide mascot" title="Hide mascot">\u00d7</button></div>';
    document.body.appendChild(wrap);
    box = wrap.querySelector('#rsm-box'); bub = wrap.querySelector('#rsm-bub'); svg = wrap.querySelector('#rsm');
    roll = svg.querySelector('#rsm-roll'); face = svg.querySelector('#rsm-face'); eyes = svg.querySelector('#rsm-eyes'); mo = svg.querySelector('#rsm-mo');
    eL = svg.querySelector('#rsm-eL'); eR = svg.querySelector('#rsm-eR'); rL = eL.firstChild; rR = eR.firstChild;

    wrap.querySelector('#rsm-x').addEventListener('click', function (e) { e.stopPropagation(); hide(); });
    wrap.querySelector('#rsm-s').addEventListener('click', toggleAlerts);
    var clicks = [['laughing', 'Hehe, that tickles!'], ['playful', 'Drag me anywhere you like!'], ['happy', "Hi! I'm here if you need me."]], ci = 0;
    box.addEventListener('click', function () { if (dragged) return; var c = clicks[ci++ % clicks.length]; say(c[0], c[1], 3000); });
    setupDrag(); syncBell(); play('waking');
  }

  function wireGlobal() {
    if (wired) { say('happy', "I'm back!", 3000); return; }
    wired = true;
    ['pointermove', 'pointerdown', 'keydown', 'scroll', 'touchstart'].forEach(function (ev) {
      window.addEventListener(ev, function () { lastAct = Date.now(); if (name === 'drowsy' || name === 'sleeping') say('waking', '', 2600); }, { passive: true });
    });
    window.addEventListener('pointermove', function (e) { if (focusEl) aimEl(focusEl); else aim(e.clientX, e.clientY); }, { passive: true });
    window.addEventListener('scroll', function () { if (focusEl) aimEl(focusEl); }, { passive: true });
    document.addEventListener('pointerover', function (e) {
      if (e.pointerType !== 'mouse' || busy || !wrap) return;
      var t = e.target.closest && e.target.closest(BTN);
      if (t && !t.disabled && !wrap.contains(t)) { hoverOn = true; clearTimeout(backT); play('excited'); }
    }, true);
    document.addEventListener('pointerout', function (e) {
      if (!hoverOn || e.pointerType !== 'mouse') return;
      var t = e.target.closest && e.target.closest(BTN);
      if (t && !(e.relatedTarget && t.contains(e.relatedTarget))) { hoverOn = false; if (!busy && name === 'excited') play('idle'); }
    }, true);
    document.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' || busy || !wrap) return;
      var t = e.target.closest && e.target.closest(BTN);
      if (t && !wrap.contains(t)) say('excited', '', 1300);
    }, true);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { kick(); if (origTitle !== null && !busy) resetTitleSoon(3000); } });
    setInterval(function () {
      if (document.hidden || busy || !wrap) return;
      var idle = Date.now() - lastAct;
      if (idle > 70000 && name !== 'sleeping') play('sleeping'); else if (idle > 30000 && name === 'idle') play('drowsy');
    }, 4000);
    var oa = window.alert;
    window.alert = function (m) { try { reactAlert(String(m)); } catch (e) {} return oa.apply(this, arguments); };
    wirePage();
  }

  function init() {
    if (lsGet('rsmOff') === '1') { showChip(); return; }
    build(); wireGlobal();
  }

  window.ReelMascot = { say: say, setBusy: setBusy, clearBusy: clearBusy, play: function (n) { if (wrap) play(n); }, hide: hide };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
