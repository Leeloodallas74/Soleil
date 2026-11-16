/* Soleil du jour – interface, prévisions, mémorisation. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var KEY = { set: 'sdj-settings', fc: 'sdj-forecast', corr: 'sdj-correction', hist: 'sdj-history', man: 'sdj-manual', view: 'sdj-view' };
  var MODELS = [
    { id: 'meteoswiss_icon_seamless', name: 'MétéoSuisse (ICON-CH)' },
    { id: 'meteofrance_seamless', name: 'Météo-France (AROME)' }
  ];
  var MAX_AGE = 60 * 60 * 1000; /* on redemande la prévision au-delà d'une heure */

  /* ---------- petits outils ---------- */
  function load(k, def) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* stockage indisponible : l'appli marche quand même */ } }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(h) { var m = Math.round(h * 60); return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0'); }
  function f1(v) { return v.toFixed(1).replace('.', ','); }
  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function hm(s) { var p = (s || '05:45').split(':'); return (+p[0] || 0) + (+p[1] || 0) / 60; }
  function get(o, path) { return path.split('.').reduce(function (a, k) { return a[k]; }, o); }
  function put(o, path, v) { var ks = path.split('.'), last = ks.pop(); ks.reduce(function (a, k) { return a[k]; }, o)[last] = v; }
  function hhmm(ts) { var d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

  /* ---------- réglages (sur le téléphone uniquement) ---------- */
  var S = (function () {
    var s = load(KEY.set, null), d = clone(SDJ_DEFAULTS);
    if (!s) return d;
    if (s.version !== d.version) {
      /* nouveau calage : on garde l'adresse, les appareils et l'heure de départ, on prend les nouveaux réglages de panneaux */
      d.site.lat = s.site.lat; d.site.lon = s.site.lon; d.site.label = s.site.label;
      if (s.apps) d.apps = s.apps; if (s.leave) d.leave = s.leave; if (s.base != null) d.base = s.base;
    }
    return s.version === d.version ? s : d;
  })();
  function saveSettings() { save(KEY.set, S); }

  var fc = load(KEY.fc, {});          /* { modelId: {at, lat, lon, t:[], dni:[], ...} } */
  var corr = load(KEY.corr, {});      /* { 'AAAA-MM-JJ': pourcentage } */
  var hist = load(KEY.hist, {});      /* { 'AAAA-MM-JJ': {pred, src, at} } : sert à la future comparaison avec Atmozen */
  var manual = load(KEY.man, [30, 30, 30, 30]);
  var view = load(KEY.view, {});     /* choix d'affichage : courbe 't' (total) ou 'd' (détail), météo 'sym' ou 'col' */
  if (view.curve !== 'd') view.curve = 't';
  if (view.wx !== 'col' && view.wx !== 'bar') view.wx = 'sym';
  var dayOffset = 0, picked = false, busy = false, lastError = '';

  /* ---------- prévisions Open-Meteo ---------- */
  function fcUrl(model) {
    /* Coordonnées arrondies à ~1 km : suffisant pour la météo, et votre adresse exacte ne quitte pas le téléphone. */
    return 'https://api.open-meteo.com/v1/forecast?latitude=' + S.site.lat.toFixed(2) + '&longitude=' + S.site.lon.toFixed(2) +
      '&minutely_15=direct_normal_irradiance,diffuse_radiation,shortwave_radiation,temperature_2m,cloud_cover,sunshine_duration,precipitation' +
      '&models=' + model + '&timeformat=unixtime&timezone=Europe%2FParis&forecast_days=3&past_days=1&hourly=sunshine_duration,cloud_cover_low,precipitation';
  }
  function fetchModel(model) {
    var ctl = 'AbortController' in window ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
    return fetch(fcUrl(model), ctl ? { signal: ctl.signal } : {}).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      var m = j.minutely_15;
      if (!m || !m.time) throw new Error(j.reason || 'réponse vide');
      var d = { at: Date.now(), lat: S.site.lat.toFixed(2), lon: S.site.lon.toFixed(2), t: m.time,
        dni: m.direct_normal_irradiance, dhi: m.diffuse_radiation, ghi: m.shortwave_radiation, temp: m.temperature_2m, cc: m.cloud_cover, sd: m.sunshine_duration, pr: m.precipitation,
        /* ensoleillement horaire : la valeur datée T couvre l'heure qui précède T */
        sdh: j.hourly && j.hourly.sunshine_duration ? { t: j.hourly.time, v: j.hourly.sunshine_duration, low: j.hourly.cloud_cover_low, pr: j.hourly.precipitation } : null };
      fc[model] = d; save(KEY.fc, fc); return d;
    });
  }
  /* Indices des quarts d'heure du jour local voulu, si les données sont complètes. */
  function daySlice(d, dateStr) {
    if (!d || !d.t) return null;
    var idx = [], ok = 0;
    for (var i = 0; i < d.t.length; i++) {
      if (ymd(new Date((d.t[i] - 900) * 1000)) !== dateStr) continue;
      idx.push(i); if (d.ghi[i] != null && d.dni[i] != null) ok++;
    }
    return idx.length >= 88 && ok >= idx.length * 0.95 ? idx : null;
  }
  function sameSite(d) { return d && d.lat === S.site.lat.toFixed(2) && d.lon === S.site.lon.toFixed(2); }
  function pickSource(dateStr) {
    for (var i = 0; i < MODELS.length; i++) {
      var d = fc[MODELS[i].id];
      if (!sameSite(d)) continue;
      var idx = daySlice(d, dateStr);
      if (idx) return { model: MODELS[i], d: d, idx: idx };
    }
    return null;
  }
  function refresh(force) {
    if (busy) return Promise.resolve();
    var today = ymd(new Date()), need = [];
    MODELS.forEach(function (m, i) {
      var d = fc[m.id], fresh = sameSite(d) && Date.now() - d.at < MAX_AGE;
      if (i === 0 && (force || !fresh)) need.push(m.id);
    });
    busy = true; render();
    var chain = Promise.resolve();
    need.forEach(function (id) { chain = chain.then(function () { return fetchModel(id); }); });
    return chain.catch(function (e) { lastError = e.message || String(e); })
      .then(function () {
        /* secours Météo-France si MétéoSuisse ne couvre pas le jour affiché ou aujourd'hui */
        var shown = ymd(addDays(new Date(), dayOffset)), mf = fc[MODELS[1].id];
        var msOk = daySlice(sameSite(fc[MODELS[0].id]) ? fc[MODELS[0].id] : null, shown) && daySlice(sameSite(fc[MODELS[0].id]) ? fc[MODELS[0].id] : null, today);
        if (!msOk && (force || !sameSite(mf) || Date.now() - mf.at >= MAX_AGE)) return fetchModel(MODELS[1].id).catch(function (e) { lastError = e.message || String(e); });
      })
      .then(function () { busy = false; render(); });
  }

  /* ---------- calcul de la journée ---------- */
  function params() {
    var p = clone(S.pv); p.lat = S.site.lat; p.lon = S.site.lon; p.horizon = S.site.horizon; return p;
  }
  function compute(dateStr) {
    var p = params(), src = pickSource(dateStr), wx, cc = null;
    var dayStart = new Date(dateStr + 'T00:00').getTime() / 1000;
    if (src) {
      wx = { t: [], step: 900, dni: [], dhi: [], ghi: [], temp: [] }; cc = [];
      src.idx.forEach(function (i) {
        wx.t.push(src.d.t[i]); wx.dni.push(src.d.dni[i]); wx.dhi.push(src.d.dhi[i]); wx.ghi.push(src.d.ghi[i]); wx.temp.push(src.d.temp[i]);
        var dni = src.d.dni[i], sd = src.d.sd ? src.d.sd[i] : null;
        cc.push({ t: src.d.t[i], v: src.d.cc ? src.d.cc[i] : null, pr: src.d.pr ? src.d.pr[i] : null,
          /* ensoleillement (secondes sur le quart d'heure) ; à défaut, règle OMM : soleil si direct ≥ 120 W/m² */
          sd: sd != null ? sd : (dni == null ? null : dni >= 120 ? 900 : 0) });
      });
    } else {
      wx = SDJ.clearSkySeries(dayStart, p, function (h) {
        if (h <= 8) return manual[0]; if (h >= 20) return manual[3];
        var k = (h - 8) / 4, i = Math.floor(k), x = k - i; return manual[i] * (1 - x) + manual[i + 1] * x;
      }, function (t) { var d = new Date(t * 1000); return d.getHours() + d.getMinutes() / 60; });
    }
    var prod = SDJ.production(wx, p), k = (corr[dateStr] || 100) / 100;
    var grey = greyFactors(src ? src.d.sdh : null, wx.t);
    var E = new Array(96).fill(0), W = new Array(96).fill(0);
    wx.t.forEach(function (t, i) {
      var d = new Date((t - 900) * 1000), slot = d.getHours() * 4 + Math.floor(d.getMinutes() / 15);
      if (slot >= 0 && slot < 96) { E[slot] = prod.E[i] * k * grey.f[i]; W[slot] = prod.W[i] * k * grey.f[i]; }
    });
    var tot = E.map(function (v, i) { return v + W[i]; });
    return { E: E, W: W, tot: tot, src: src, cc: cc, sdh: src ? src.d.sdh : null, fog: grey.fog };
  }

  /* Correction des heures sans soleil, calée sur vos relevés Atmozen d'août à novembre 2026 (voir CALAGE.md).
     Sans soleil prévu dans l'heure : × grey.stratus si nuages bas ≥ 90 % sans pluie (brouillard, stratus), sinon × grey.overcast. */
  function greyFactors(sdh, ts) {
    var g = S.pv.grey || SDJ_DEFAULTS.pv.grey, f = ts.map(function () { return 1; }), fog = {};
    if (!sdh || !sdh.low) return { f: f, fog: fog };
    var idx = {}; sdh.t.forEach(function (t, i) { idx[t] = i; });
    ts.forEach(function (t, i) {
      var k = idx[Math.ceil(t / 3600) * 3600];
      if (k == null || sdh.v[k] == null || sdh.v[k] >= 360) return;
      if (sdh.low[k] >= 90 && (sdh.pr[k] || 0) < 0.1) {
        f[i] = g.stratus;
        if (SDJ.sun(t - 450, S.site.lat, S.site.lon).elev > 0) fog[new Date((t - 900) * 1000).getHours()] = true;
      }
      else f[i] = g.overcast;
    });
    return { f: f, fog: fog };
  }

  /* ---------- affichage ---------- */
  function renderDays() {
    var names = ['Aujourd’hui', 'Demain', 'Après-demain'];
    $('days').innerHTML = names.map(function (n, i) {
      var d = addDays(new Date(), i), lab = i < 2 ? n : d.toLocaleDateString('fr-FR', { weekday: 'long' });
      return '<button role="tab" data-o="' + i + '" aria-selected="' + (i === dayOffset) + '">' + esc(lab.charAt(0).toUpperCase() + lab.slice(1)) + '</button>';
    }).join('');
  }

  function draw(m, plan) {
    var small = ($('chart').clientWidth || 720) < 520;
    var W = small ? 400 : 720, L = small ? 22 : 34, Rm = 8, T = 10, Bm = 22, ok = plan.filter(function (p) { return p.ok; }), H = small ? 170 : 210, full = H + ok.length * 21;
    var peak = Math.max.apply(null, m.tot), ym = Math.max(2, Math.ceil(peak + 0.3));
    var x = function (h) { return L + (h - 5) / 17 * (W - L - Rm); }, y = function (v) { return T + (1 - v / ym) * (H - T - Bm); };
    var s = '<svg viewBox="0 0 ' + W + ' ' + full + '">';
    for (var v = 0; v <= ym; v++) s += '<line class="gl" x1="' + L + '" x2="' + (W - Rm) + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text class="ax" x="' + (L - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + v + '</text>';
    for (var h = 6; h <= 22; h += small ? 4 : 2) s += '<text class="ax" x="' + x(h) + '" y="' + (H - 6) + '" text-anchor="middle">' + h + 'h</text>';
    var area = function (arr) { var p = 'M' + x(5) + ',' + y(0); for (var i = 20; i < 88; i++) p += 'L' + x((i + 0.5) / 4) + ',' + y(arr[i]); return p + 'L' + x(22) + ',' + y(0) + 'Z'; };
    if (view.curve === 't') s += '<path class="tot" d="' + area(m.tot) + '"/>';
    else s += '<path class="w" d="' + area(m.tot) + '"/><path class="e" d="' + area(m.E) + '"/>';
    s += '<line x1="' + L + '" x2="' + (W - Rm) + '" y1="' + y(S.base) + '" y2="' + y(S.base) + '" stroke="var(--ink)" stroke-dasharray="4 4" opacity=".6"/>';
    ok.forEach(function (p, ln) {
      var yy = H + ln * 21;
      var bw = x(p.e) - x(p.s), inside = bw > p.a.n.length * 6.2 + 10, tx = inside ? x(p.s) + 6 : x(p.e) + 5, right = tx + p.a.n.length * 6.2 > W;
      s += '<rect class="bar" x="' + x(p.s) + '" y="' + yy + '" width="' + bw + '" height="18" rx="4"/><text class="bt" ' + (inside ? '' : 'style="fill:var(--ink)" ') +
        (right && !inside ? 'text-anchor="end" x="' + (x(p.s) - 5) : 'x="' + tx) + '" y="' + (yy + 13) + '">' + esc(p.a.n) + '</text>';
    });
    $('chart').innerHTML = s + '</svg>';
  }

  /* ---------- météo heure par heure ---------- */
  var SYM = {
    sun: '<circle class="sy-sun" cx="12" cy="12" r="4.6"/><path class="sy-ray" d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M5.3 18.7L7 17M17 7l1.7-1.7"/>',
    cloud: function (cls, dx, dy, s) { return '<path class="' + cls + '" transform="translate(' + dx + ' ' + dy + ') scale(' + s + ')" d="M6.5 19h11a4.2 4.2 0 0 0 .3-8.4 5.6 5.6 0 0 0-10.8-1A4.7 4.7 0 0 0 6.5 19z"/>'; },
    moon: '<path class="sy-moon" d="M15.5 3.2a8.8 8.8 0 1 0 5.3 13.7A7.2 7.2 0 0 1 15.5 3.2z"/>'
  };
  /* Le symbole suit d'abord l'ensoleillement : un voile de nuages d'altitude peut couvrir 100 % du ciel tout en laissant passer le soleil. */
  function symbol(cc, pr, night, pct) {
    var g, sunny = pct == null ? (cc < 15 ? 100 : cc < 35 ? 80 : cc < 60 ? 50 : cc < 85 ? 20 : 0) : pct;
    if (night) g = SYM.moon;
    else if (sunny >= 75 && cc < 50) g = SYM.sun;
    else if (sunny >= 75) g = '<g transform="translate(-2 -2)">' + SYM.sun + '</g>' + SYM.cloud('sy-c1', 7, 8, 0.65);
    else if (sunny >= 35) g = '<g transform="translate(-3 -4) scale(.85)">' + SYM.sun + '</g>' + SYM.cloud('sy-c1', 1.5, 2, 0.9);
    else if (sunny >= 5 || cc < 85) g = SYM.cloud('sy-c2', 0, 0, 1);
    else g = SYM.cloud('sy-c3', 0, pr >= 0.2 ? -3 : 0, 1);
    if (!night && pr >= 0.2) g += '<path class="sy-rain" d="M8 18.5l-1.2 3M12.5 18.5l-1.2 3M17 18.5l-1.2 3"/>';
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + g + '</svg>';
  }
  /* Dégradé de nébulosité (0 % = ciel bleu, 100 % = couvert). */
  var CC_COL = [[0, [58, 150, 221]], [25, [138, 193, 234]], [50, [214, 223, 228]], [75, [160, 171, 177]], [100, [104, 115, 121]]];
  function ccColor(v) {
    for (var i = 1; i < CC_COL.length; i++) if (v <= CC_COL[i][0]) {
      var a = CC_COL[i - 1], b = CC_COL[i], x = (v - a[0]) / (b[0] - a[0]);
      return 'rgb(' + a[1].map(function (c, k) { return Math.round(c + (b[1][k] - c) * x); }).join(',') + ')';
    }
    return 'rgb(' + CC_COL[CC_COL.length - 1][1].join(',') + ')';
  }
  function drawWx(cc, dateStr, sdh, fog) {
    if (!cc) { $('clouds').innerHTML = ''; $('wxLeg').innerHTML = ''; return; }
    var cells = '', sunH = 0, col = view.wx === 'col', hours = [];
    for (var h = 6; h <= 21; h++) {
      var q = cc.filter(function (c) { return new Date((c.t - 900) * 1000).getHours() === h; });
      var mid = new Date(dateStr + 'T' + String(h).padStart(2, '0') + ':30').getTime() / 1000;
      var night = SDJ.sun(mid, S.site.lat, S.site.lon).elev < 0;
      var vs = q.filter(function (c) { return c.v != null; }), v = vs.length ? Math.round(vs.reduce(function (a, c) { return a + c.v; }, 0) / vs.length) : null;
      /* Ensoleillement de l'heure (secondes) : valeur horaire du modèle si elle existe ;
         sinon les quarts d'heure (MétéoSuisse les donne lissés en secondes par heure, Météo-France en secondes par quart d'heure). */
      var ss = q.filter(function (c) { return c.sd != null; }), sd = null;
      var end = new Date(dateStr + 'T' + String(h).padStart(2, '0') + ':00').getTime() / 1000 + 3600, k = sdh ? sdh.t.indexOf(end) : -1;
      if (k >= 0 && sdh.v[k] != null) sd = sdh.v[k];
      else if (ss.length) {
        var sum = ss.reduce(function (a, c) { return a + c.sd; }, 0), perHour = ss.some(function (c) { return c.sd > 900; });
        sd = perHour ? sum / ss.length : sum * 4 / ss.length;
      }
      var pr = q.reduce(function (a, c) { return a + (c.pr || 0); }, 0);
      var pct = sd == null ? null : Math.min(100, Math.round(sd / 36));
      sunH += (sd || 0) / 3600;
      hours.push({ h: h, night: night, pct: pct });
      var tip = h + 'h : ' + (night ? 'nuit' : (pct == null ? '?' : pct + ' % de soleil') + (v == null ? '' : ', ' + v + ' % de nuages') + (pr >= 0.2 ? ', pluie' : ''));
      var pic = v == null && !night ? '<span class="sy-none">?</span>'
        : col ? '<span class="ccbox' + (night ? ' night' : '') + '"' + (night ? '' : ' style="background:' + ccColor(v) + '"') + '>' + (night ? symbol(0, 0, true) : '') + '</span>'
        : symbol(v, pr, night, pct);
      cells += '<div class="wxh" title="' + tip + '" aria-label="' + tip + '"><span class="hh">' + h + 'h</span>' + pic +
        '<span class="pc">' + (night ? '' : pct == null ? '–' : pct + '%') + '</span></div>';
    }
    var bars = view.wx === 'bar';
    $('clouds').className = 'clouds' + (bars ? ' bars' : '');
    $('clouds').innerHTML = bars ? sunBars(hours) : cells;
    var fogH = Object.keys(fog || {}).map(Number).filter(function (h) { return h >= 6 && h <= 21; }).sort(function (a, b) { return a - b; });
    var fogTxt = fogH.length ? ' <span class="fog">Brouillard ou stratus probable (' + fogH[0] + 'h–' + (fogH[fogH.length - 1] + 1) + 'h) : production revue nettement à la baisse.</span>' : '';
    $('wxLeg').innerHTML = (bars ? 'Hauteur du bâton : part de l’heure avec du soleil. Ensoleillement prévu sur la journée : <b>' + f1(sunH) + ' h</b>.' : (col
      ? '<span class="ccgrad" style="background:linear-gradient(90deg,' + CC_COL.map(function (c) { return ccColor(c[0]) + ' ' + c[0] + '%'; }).join(',') + ')"></span><span class="ccends"><span>Ciel dégagé</span><span>Couvert</span></span>' +
        'La couleur montre la part du ciel couverte par les nuages. '
      : '') + 'Le pourcentage indique la part de l’heure avec du soleil. Ensoleillement prévu sur la journée : <b>' + f1(sunH) + ' h</b>.') + fogTxt;
  }

  /* Bâtons jaunes : ensoleillement heure par heure, dessiné à la largeur réelle de l'écran. */
  function sunBars(hours) {
    var W = Math.max(220, $('clouds').clientWidth || 320), L = 34, n = hours.length, cw = (W - L - 4) / n;
    var T = 10, B = T + 110, y = function (v) { return B - (B - T) * v / 100; };
    var s = '<svg viewBox="0 0 ' + W + ' ' + (B + 22) + '" role="img" aria-label="Ensoleillement prévu heure par heure">';
    [25, 75].forEach(function (v) { s += '<line class="gl" stroke-dasharray="2 4" x1="' + L + '" x2="' + (W - 4) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>'; });
    [0, 50, 100].forEach(function (v) { s += '<line class="gl" x1="' + L + '" x2="' + (W - 4) + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text class="ax" x="' + (L - 5) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + v + '%</text>'; });
    hours.forEach(function (o, i) {
      var x = L + i * cw, cx = x + cw / 2, tip = o.h + 'h : ' + (o.night ? 'nuit' : o.pct == null ? '?' : o.pct + ' % de soleil');
      s += '<g><title>' + tip + '</title>';
      if (o.night) s += '<path class="sy-moon" transform="translate(' + (cx - 8) + ' ' + (B - 20) + ') scale(.68)" d="M15.5 3.2a8.8 8.8 0 1 0 5.3 13.7A7.2 7.2 0 0 1 15.5 3.2z"/>';
      else if (o.pct != null) {
        var top = y(o.pct);
        if (o.pct > 0) s += '<rect class="sunbar" fill="#f2b21c" x="' + (x + 2) + '" y="' + top + '" width="' + Math.max(2, cw - 4) + '" height="' + (B - top) + '" rx="3"/>';
      }
      s += '</g>';
      if (cw >= 24 || o.h % 2 === 0) s += '<text class="ax" x="' + cx + '" y="' + (B + 16) + '" text-anchor="middle">' + o.h + 'h</text>';
    });
    return s + '<line x1="' + L + '" x2="' + (W - 4) + '" y1="' + B + '" y2="' + B + '" stroke="var(--muted)"/></svg>';
  }

  function planText(p, L) {
    if (!p.ok) return { big: '–', sub: 'Aucun créneau possible avec ces horaires.' };
    if (p.sol < 0.05) return { big: 'Pas de soleil utile', sub: 'Aucun créneau solaire ce jour-là : lancez-le quand cela vous arrange' };
    var end = 'fini vers ' + fmt(p.e), dep = p.a.after && S.apps.filter(function (o) { return o.id === p.a.after && o.on; })[0];
    if (dep) end += ' (après ' + dep.n.toLowerCase() + ')';
    if (p.a.mode === 'differe') return p.delay > 0
      ? { big: 'Départ différé ' + p.delay + ' h', sub: 'Démarre vers ' + fmt(p.s) + ', ' + end }
      : { big: 'Lancer à ' + fmt(L), sub: 'Pas de différé : démarre tout de suite, ' + end };
    if (p.a.mode === 'fin') return { big: 'Fin différée ' + p.delay + ' h', sub: 'Démarre vers ' + fmt(p.s) + ', ' + end };
    return { big: 'Vers ' + fmt(p.s), sub: 'À lancer à la main, ' + end };
  }

  function render() {
    renderDays();
    var date = addDays(new Date(), dayOffset), dateStr = ymd(date), now = new Date();
    var m = compute(dateStr), src = m.src;

    /* état de la prévision */
    var st = $('status');
    if (src) {
      var age = Date.now() - src.d.at, offline = !navigator.onLine || (lastError && age > MAX_AGE);
      st.className = 'status' + (offline ? ' warn' : '');
      st.textContent = (busy ? 'Mise à jour… ' : '') + 'Prévision ' + src.model.name + ' du ' + new Date(src.d.at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ' à ' + hhmm(src.d.at) +
        (offline ? ' (hors ligne : dernière prévision enregistrée)' : '') + (src.model.id !== MODELS[0].id ? ' – MétéoSuisse indisponible' : '');
    } else {
      st.className = 'status warn';
      st.textContent = busy ? 'Récupération de la prévision…' : 'Prévision indisponible' + (lastError ? ' (' + lastError + ')' : '') + ' : saisie manuelle ci-dessous.';
    }
    $('wxAuto').hidden = !src; $('wxManual').hidden = !!src;
    drawWx(m.cc, dateStr, m.sdh, m.fog);
    var pressed = { curveT: view.curve === 't', curveD: view.curve === 'd', wxSym: view.wx === 'sym', wxCol: view.wx === 'col', wxBar: view.wx === 'bar' };
    Object.keys(pressed).forEach(function (id) { $(id).setAttribute('aria-pressed', String(pressed[id])); });
    $('legE').hidden = $('legW').hidden = view.curve === 't'; $('legT').hidden = view.curve !== 't';
    var c = corr[dateStr] || 100; $('corr').value = c; $('oCorr').textContent = c + ' %';
    [0, 1, 2, 3].forEach(function (i) { $('c' + i).value = manual[i]; $('o' + i).textContent = manual[i] + ' %'; });

    /* heure de programmation : l'heure de départ, ou maintenant si elle est passée */
    var L = hm(S.leave);
    if (dayOffset === 0) { var n = now.getHours() + now.getMinutes() / 60; if (n > L) L = Math.ceil(n * 4) / 4; }
    $('progAt').textContent = 'Calculé pour une programmation à ' + fmt(L) + (dayOffset ? ' le ' + date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) : '') + '.';

    var sur = m.tot.map(function (v) { return Math.max(0, v - S.base); });
    var active = S.apps.filter(function (a) { return a.on && a.mode !== 'non' && a.kwh > 0 && a.d > 0; });
    var res = SDJ.schedule(sur, active, L), plan = res.plan;
    var order = {}; S.apps.forEach(function (a, i) { order[a.id] = i; });
    plan.sort(function (x, y) { return (x.ok ? x.s : 99) - (y.ok ? y.s : 99) || order[x.a.id] - order[y.a.id]; });

    var kwh = m.tot.reduce(function (a, v) { return a + v; }, 0) / 4, pk = Math.max.apply(null, m.tot), pi = m.tot.indexOf(pk);
    $('sKwh').textContent = f1(kwh) + ' kWh';
    $('sPeak').textContent = f1(pk) + ' kW' + (pk > 0 ? ' à ' + fmt((pi + 0.5) / 4) : '');
    var okp = plan.filter(function (p) { return p.ok; });
    var used = okp.reduce(function (a, p) { return a + p.sol; }, 0), need = okp.reduce(function (a, p) { return a + p.tot; }, 0);
    $('sUse').textContent = need ? Math.round(100 * used / need) + ' %' : '–';
    draw(m, plan);

    var html = plan.map(function (p) {
      var t = planText(p, L), pc = p.ok ? Math.round(100 * p.sol / p.tot) : 0;
      return '<div class="plan"><strong>' + esc(p.a.n) + '</strong><span class="t">' + esc(t.big) + '</span>' +
        '<small>' + esc(t.sub) + (p.ok ? '<br>' + f1(p.sol) + ' kWh solaires sur ' + f1(p.tot) + ' kWh' : '') + '</small>' +
        (p.ok ? '<small style="text-align:right">' + pc + ' % solaire</small><div class="meter"><div style="width:' + pc + '%"></div></div>' : '') + '</div>';
    });
    S.apps.filter(function (a) { return a.on && a.mode === 'non'; }).forEach(function (a) {
      html.push('<div class="plan"><strong>' + esc(a.n) + '</strong><span class="t">–</span><small>Non pilotable : non planifié. Il consomme quand il en a besoin.</small></div>');
    });
    $('plan').innerHTML = html.length ? html.join('') : '<p class="note">Activez au moins un appareil dans « Vos appareils ».</p>';

    /* surplus qui reste (utile pour la future PAC du ballon) */
    var left = res.left, lk = left.reduce(function (a, v) { return a + v; }, 0) / 4, big = [];
    left.forEach(function (v, i) { if (v >= 1) big.push(i); });
    $('left').textContent = lk >= 0.5 ? 'Surplus solaire restant : ' + f1(lk) + ' kWh' + (big.length ? ', surtout entre ' + fmt(big[0] / 4) + ' et ' + fmt((big[big.length - 1] + 1) / 4) : '') + ' (perdu sur le réseau sans autre appareil en marche).' : '';

    /* mémorise la prévision du jour pour la comparer plus tard avec Atmozen */
    if (src) {
      var h = hist[dateStr] || {};
      if (h.first == null) h.first = +kwh.toFixed(2);
      h.last = +kwh.toFixed(2); h.src = src.model.id; h.at = Date.now();
      hist[dateStr] = h; save(KEY.hist, hist);
    }
  }

  /* ---------- appareils ---------- */
  var MODES = { differe: 'Départ différé', fin: 'Fin différée', main: 'À lancer à la main', non: 'Non pilotable' };
  function appSummary(a) { return MODES[a.mode] + ', ' + f1(+a.kwh || 0) + ' kWh, ' + f1(+a.d || 0) + ' h'; }
  function buildApps() {
    $('apps').innerHTML = S.apps.map(function (a, i) {
      var f = function (k, lab, step, extra) { return '<label>' + lab + '<input type="number" step="' + step + '" data-i="' + i + '" data-k="' + k + '" value="' + a[k] + '"' + (extra || '') + '></label>'; };
      return '<details class="app"><summary><input type="checkbox" data-i="' + i + '" data-k="on" ' + (a.on ? 'checked' : '') + ' aria-label="Activer ' + esc(a.n) + '" onclick="event.stopPropagation()"> ' +
        esc(a.n) + ' <small id="as' + i + '">' + esc(appSummary(a)) + '</small></summary><div class="grid">' +
        '<label>Nom<input type="text" data-i="' + i + '" data-k="n" value="' + esc(a.n) + '"></label>' +
        '<label>Programmation<select data-i="' + i + '" data-k="mode">' + Object.keys(MODES).map(function (k) { return '<option value="' + k + '"' + (a.mode === k ? ' selected' : '') + '>' + MODES[k] + '</option>'; }).join('') + '</select></label>' +
        f('kwh', 'Énergie par cycle (kWh)', '0.1', ' min="0"') + f('d', 'Durée du cycle (h)', '0.25', ' min="0.25"') + f('p', 'Puissance max (kW)', '0.1', ' min="0"') +
        f('step', 'Pas du minuteur (h)', '0.5', ' min="0.5"') + f('maxDelay', 'Différé maximum (h)', '1', ' min="0"') +
        f('a', 'Pas avant (h)', '0.5') + f('b', 'Fini avant (h)', '0.5') +
        '<label>Seulement après<select data-i="' + i + '" data-k="after"><option value="">—</option>' + S.apps.filter(function (o) { return o !== a; }).map(function (o) { return '<option value="' + esc(o.id) + '"' + (a.after === o.id ? ' selected' : '') + '>' + esc(o.n) + '</option>'; }).join('') + '</select></label>' +
        '</div><p><button class="x danger" data-del="' + i + '">Supprimer cet appareil</button></p></details>';
    }).join('');
  }
  $('apps').addEventListener('input', function (e) {
    var t = e.target, i = t.dataset.i, k = t.dataset.k; if (i == null || !k) return;
    var a = S.apps[i];
    a[k] = t.type === 'checkbox' ? t.checked : (t.type === 'text' || t.tagName === 'SELECT') ? t.value : (parseFloat(t.value) || 0);
    var sm = $('as' + i); if (sm) sm.textContent = appSummary(a);
    saveSettings(); render();
  });
  $('apps').addEventListener('click', function (e) {
    var d = e.target.dataset.del; if (d == null) return;
    if (!confirm('Supprimer « ' + S.apps[d].n + ' » ?')) return;
    S.apps.splice(+d, 1); saveSettings(); buildApps(); render();
  });
  $('addApp').onclick = function () {
    S.apps.push({ id: 'a' + Date.now(), n: 'Nouvel appareil', p: 2, kwh: 1, d: 1, mode: 'main', step: 1, maxDelay: 24, a: 8, b: 20, on: true });
    saveSettings(); buildApps(); render();
    var all = document.querySelectorAll('#apps details'); all[all.length - 1].open = true;
  };
  $('leave').value = S.leave;
  $('leave').addEventListener('input', function () { S.leave = $('leave').value || '05:45'; saveSettings(); render(); });

  /* ---------- réglages de l'installation ---------- */
  function buildSettings() {
    document.querySelectorAll('[data-set]').forEach(function (el) { el.value = get(S, el.dataset.set); });
    $('siteLabel').textContent = 'Position utilisée : ' + S.site.label + ' (' + S.site.lat.toFixed(4) + ', ' + S.site.lon.toFixed(4) + ')';
    $('obs').innerHTML = S.pv.obstacles.map(function (o, i) {
      var f = function (k, lab) { return '<label>' + lab + '<input type="number" step="1" data-o="' + i + '" data-k="' + k + '" value="' + o[k] + '"></label>'; };
      return '<div class="obs"><label>Nom<input type="text" data-o="' + i + '" data-k="n" value="' + esc(o.n) + '"></label>' + f('az1', 'De (°)') + f('az2', 'À (°)') + f('h', 'Hauteur (°)') +
        '<button class="x danger" data-delo="' + i + '" aria-label="Supprimer">✕</button></div>';
    }).join('');
  }
  document.querySelectorAll('[data-set]').forEach(function (el) {
    el.addEventListener('input', function () {
      var v = parseFloat(el.value); if (isNaN(v)) return;
      put(S, el.dataset.set, v);
      if (el.dataset.set.indexOf('site.') === 0) { S.site.label = 'position saisie à la main'; $('siteLabel').textContent = 'Position utilisée : ' + S.site.label; }
      saveSettings(); render();
    });
    el.addEventListener('change', function () { if (el.dataset.set.indexOf('site.') === 0) refresh(true); });
  });
  $('obs').addEventListener('input', function (e) {
    var t = e.target, i = t.dataset.o; if (i == null) return;
    S.pv.obstacles[i][t.dataset.k] = t.type === 'text' ? t.value : (parseFloat(t.value) || 0); saveSettings(); render();
  });
  $('obs').addEventListener('click', function (e) {
    var d = e.target.dataset.delo; if (d == null) return;
    S.pv.obstacles.splice(+d, 1); saveSettings(); buildSettings(); render();
  });
  $('addObs').onclick = function () { S.pv.obstacles.push({ n: 'Obstacle', az1: -45, az2: 45, h: 10 }); saveSettings(); buildSettings(); render(); };
  $('reset').onclick = function () {
    if (!confirm('Revenir aux réglages d’origine ? Votre adresse et vos appareils personnalisés seront effacés de ce téléphone.')) return;
    S = clone(SDJ_DEFAULTS); saveSettings(); $('leave').value = S.leave; buildApps(); buildSettings(); refresh(true);
  };

  /* Géocodage : Géoplateforme IGN (Base Adresse Nationale), avec l'ancienne adresse de l'API en secours. */
  function geocode(q) {
    var urls = ['https://data.geopf.fr/geocodage/search?limit=5&q=', 'https://api-adresse.data.gouv.fr/search/?limit=5&q='];
    var tryAt = function (k) {
      return fetch(urls[k] + encodeURIComponent(q)).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .catch(function (e) { if (k + 1 < urls.length) return tryAt(k + 1); throw e; });
    };
    return tryAt(0);
  }
  $('addrGo').onclick = function () {
    var q = $('addr').value.trim(); if (q.length < 3) return;
    $('addrRes').innerHTML = '<p class="note">Recherche…</p>';
    geocode(q).then(function (j) {
      var fs = (j.features || []);
      if (!fs.length) { $('addrRes').innerHTML = '<p class="note warn">Adresse introuvable.</p>'; return; }
      $('addrRes').innerHTML = fs.map(function (f, i) { return '<button data-g="' + i + '">' + esc(f.properties.label) + '</button>'; }).join('');
      $('addrRes').onclick = function (e) {
        var g = e.target.dataset.g; if (g == null) return;
        var f = fs[g]; S.site.lon = f.geometry.coordinates[0]; S.site.lat = f.geometry.coordinates[1]; S.site.label = f.properties.label;
        saveSettings(); $('addrRes').innerHTML = ''; $('addr').value = ''; buildSettings(); refresh(true);
      };
    }).catch(function (e) { $('addrRes').innerHTML = '<p class="note warn">Recherche impossible (' + esc(e.message) + ').</p>'; });
  };
  $('addr').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('addrGo').click(); });

  /* ---------- météo ---------- */
  $('corr').addEventListener('input', function () {
    var d = ymd(addDays(new Date(), dayOffset)), v = +$('corr').value;
    if (v === 100) delete corr[d]; else corr[d] = v;
    var lim = ymd(addDays(new Date(), -7)); Object.keys(corr).forEach(function (k) { if (k < lim) delete corr[k]; });
    save(KEY.corr, corr); render();
  });
  [0, 1, 2, 3].forEach(function (i) { $('c' + i).addEventListener('input', function () { manual[i] = +$('c' + i).value; save(KEY.man, manual); render(); }); });
  $('presets').onclick = function (e) { var c = e.target.dataset.c; if (!c) return; manual = c.split(',').map(Number); save(KEY.man, manual); render(); };
  function setView(k, v) { view[k] = v; save(KEY.view, view); render(); }
  $('curveT').onclick = function () { setView('curve', 't'); };
  $('curveD').onclick = function () { setView('curve', 'd'); };
  $('wxSym').onclick = function () { setView('wx', 'sym'); };
  $('wxCol').onclick = function () { setView('wx', 'col'); };
  $('wxBar').onclick = function () { setView('wx', 'bar'); };
  $('refresh').onclick =function () { lastError = ''; refresh(true); };
  $('days').onclick = function (e) { var o = e.target.dataset.o; if (o == null) return; picked = true; dayOffset = +o; render(); refresh(false); };

  /* Sur Android, le lien ouvre l'appli MétéoSuisse si elle est installée, sinon son site. */
  if (/Android/i.test(navigator.userAgent)) {
    var ms = $('msLink');
    ms.href = 'intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=ch.admin.meteoswiss;S.browser_fallback_url=' +
      encodeURIComponent('https://www.meteosuisse.admin.ch/') + ';end';
    ms.removeAttribute('target');
  }
  /* trait sous les jours quand la rangée reste collée en haut */
  window.addEventListener('scroll', function () { $('days').classList.toggle('stuck', window.scrollY > 40); }, { passive: true });
  window.addEventListener('online', function () { refresh(false); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { picked = false; autoDay(); render(); refresh(false).then(function () { if (!picked) { autoDay(); render(); } }); } });

  /* ---------- démarrage ---------- */
  /* Après la fin du soleil utile, on montre directement demain. */
  function autoDay() {
    var now = new Date(), m = compute(ymd(now)), from = now.getHours() * 4 + Math.floor(now.getMinutes() / 15), rest = 0;
    for (var i = from; i < 96; i++) rest += Math.max(0, m.tot[i] - S.base) / 4;
    dayOffset = rest < 0.3 ? 1 : 0;
  }
  buildApps(); buildSettings(); autoDay(); render();
  refresh(false).then(function () { if (!picked) { autoDay(); render(); } });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(function () {});
})();
