/* Soleil du jour – modèle de production solaire.
   Fonctions pures, sans accès à la page : utilisables dans l'appli et dans les scripts de calage.
   Conventions : azimut 0 = sud, -90 = est, +90 = ouest (comme PVGIS). Temps en secondes UTC. */
var SDJ = (function () {
  'use strict';
  var R = Math.PI / 180;

  /* Position du soleil (formules NOAA) à l'instant t (secondes UTC). */
  function sun(t, lat, lon) {
    var d = new Date(t * 1000);
    var start = Date.UTC(d.getUTCFullYear(), 0, 1);
    var hUTC = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
    var doy = Math.floor((t * 1000 - start) / 864e5) + 1;
    var g = 2 * Math.PI / 365 * (doy - 1 + (hUTC - 12) / 24);
    var eot = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    var dec = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    var ha = ((hUTC * 60 + eot + 4 * lon) / 4 - 180) * R;
    var phi = lat * R;
    var cz = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha);
    var az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
    return { cz: cz, elev: Math.asin(Math.max(-1, Math.min(1, cz))) / R, az: az / R, i0: 1367 * (1 + 0.033 * Math.cos(2 * Math.PI * doy / 365)) };
  }

  /* Hauteur de l'horizon (°) dans la direction az : relief (profil tous les 7,5° de -180 à 180) + obstacles proches. */
  function horizonAt(az, p) {
    var h = 0, prof = p.horizon || [];
    if (prof.length > 1) {
      var step = 360 / (prof.length - 1), x = (az + 180) / step, i = Math.max(0, Math.min(prof.length - 2, Math.floor(x))), f = x - i;
      h = prof[i] * (1 - f) + prof[i + 1] * f;
    }
    (p.obstacles || []).forEach(function (o) { if (az >= o.az1 && az <= o.az2) h = Math.max(h, o.h); });
    return h;
  }

  /* Irradiance reçue par un pan (W/m²), modèle de Hay-Davies (le diffus proche du soleil est masqué comme le direct). */
  function planeIrr(s, dni, dhi, ghi, tilt, paz, visible, albedo) {
    var b = tilt * R, sz = Math.sqrt(Math.max(0, 1 - s.cz * s.cz));
    var ct = Math.max(0, s.cz * Math.cos(b) + sz * Math.sin(b) * Math.cos((s.az - paz) * R));
    var ai = Math.min(1, dni / s.i0), rb = ct / Math.max(s.cz, 0.087);
    var v = visible ? 1 : 0;
    return dni * ct * v + dhi * ((1 - ai) * (1 + Math.cos(b)) / 2 + ai * rb * v) + ghi * albedo * (1 - Math.cos(b)) / 2;
  }

  /* Production (kW moyens) de chaque pas de temps.
     wx = {t:[...], step:secondes, dni:[], dhi:[], ghi:[], temp:[]} ; chaque valeur est la moyenne du pas qui se termine à t.
     p  = réglages de l'installation (voir config.js). */
  function production(wx, p) {
    var E = [], W = [], n = wx.t.length;
    for (var i = 0; i < n; i++) {
      var dni = +wx.dni[i] || 0, dhi = +wx.dhi[i] || 0, ghi = +wx.ghi[i] || 0;
      var s = sun(wx.t[i] - wx.step / 2, p.lat, p.lon);
      if (s.elev < 0.5 || (dni + dhi + ghi) <= 0) { E.push(0); W.push(0); continue; }
      var vis = s.elev > horizonAt(s.az, p);
      var gE = planeIrr(s, dni, dhi, ghi, p.tilt, p.azE, vis, p.albedo);
      var gW = planeIrr(s, dni, dhi, ghi, p.tilt, p.azW, vis, p.albedo);
      var ta = wx.temp && wx.temp[i] != null ? +wx.temp[i] : 15;
      var fE = 1 + p.gamma * (ta + p.kTemp * gE - 25), fW = 1 + p.gamma * (ta + p.kTemp * gW - 25);
      var e = p.kwE * gE / 1000 * p.pr * fE, w = p.kwW * gW / 1000 * p.pr * fW;
      var sum = e + w;
      if (sum > p.cap) { e *= p.cap / sum; w *= p.cap / sum; }
      E.push(e); W.push(w);
    }
    return { E: E, W: W };
  }

  /* Ciel clair simplifié (repris du prototype) : sert de secours quand aucune prévision n'est disponible.
     clouds(h) renvoie la nébulosité (%) à l'heure locale h. */
  function clearSkySeries(dayStartUTC, p, clouds, localHour) {
    var wx = { t: [], step: 900, dni: [], dhi: [], ghi: [], temp: [] };
    for (var i = 1; i <= 96; i++) {
      var t = dayStartUTC + i * 900, s = sun(t - 450, p.lat, p.lon), sh = s.cz;
      var dni = 0, dhi = 0;
      if (sh > 0.03) { var am = Math.min(1 / sh, 38); dni = 1353 * Math.pow(0.7, Math.pow(am, 0.678)); dhi = 0.11 * dni * sh; }
      var kt = 1 - 0.75 * Math.pow(clouds(localHour(t - 450)) / 100, 3.4);
      wx.t.push(t); wx.dni.push(dni * kt); wx.dhi.push(dhi * kt); wx.ghi.push((dni * sh + dhi) * kt); wx.temp.push(15);
    }
    return wx;
  }

  /* Meilleur créneau pour chaque appareil.
     sur[96] : surplus solaire (kW) par quart d'heure ; apps : appareils actifs ; leave : heure de départ (h décimales).
     Un appareil « différé » ne peut démarrer qu'à leave + k × pas (ce que le minuteur permet vraiment). */
  function schedule(sur, apps, leave) {
    sur = sur.slice(); var out = [], done = {};
    /* du plus gourmand au plus sobre, mais un appareil « après X » passe toujours après X */
    var list = apps.slice().sort(function (x, y) { return y.kwh - x.kwh; }), ordered = [];
    var ids = {}; list.forEach(function (a) { ids[a.id] = 1; });
    (function place(guard) {
      list.forEach(function (a) {
        if (ordered.indexOf(a) >= 0) return;
        if (!a.after || !ids[a.after] || ordered.some(function (o) { return o.id === a.after; }) || guard > list.length) ordered.push(a);
      });
      if (ordered.length < list.length) place(guard + 1);
    })(0);
    ordered.forEach(function (a) {
      var len = Math.max(1, Math.round(a.d * 4)), pw = a.kwh / a.d, cands = [];
      var dep = a.after && done[a.after], minS = dep ? (dep.ok ? Math.round(dep.e * 4) : 999) : 0;
      if (a.mode === 'differe' || a.mode === 'fin') {
        var st = Math.max(0.25, a.step || 1);
        for (var k = 0; k <= Math.floor(24 / st); k++) {
          var h = leave + k * st, start = a.mode === 'fin' ? h - a.d : h;
          if (a.mode === 'fin' && k === 0) continue;
          if (a.maxDelay && k * st > a.maxDelay + 1e-9) break;
          cands.push({ s: Math.round(start * 4), k: k * st });
        }
      } else {
        for (var s0 = Math.round(a.a * 4); s0 <= Math.round(a.b * 4) - len; s0++) cands.push({ s: s0, k: null });
      }
      var best = null, bs = -1;
      cands.forEach(function (c) {
        if (c.s < Math.max(0, minS) || c.s + len > 96) return;
        if (a.mode !== 'main' && (c.s < Math.round(a.a * 4) || c.s + len > Math.round(a.b * 4))) return;
        var sc = 0; for (var j = 0; j < len; j++) sc += Math.min(pw, sur[c.s + j]);
        if (sc > bs + 1e-9) { bs = sc; best = c; }
      });
      if (!best) { done[a.id] = { ok: false }; out.push({ a: a, ok: false }); return; }
      for (var j = 0; j < len; j++) sur[best.s + j] = Math.max(0, sur[best.s + j] - pw);
      var r = { a: a, ok: true, s: best.s / 4, e: (best.s + len) / 4, delay: best.k, sol: bs / 4, tot: a.kwh };
      done[a.id] = r; out.push(r);
    });
    return { plan: out, left: sur };
  }

  return { sun: sun, horizonAt: horizonAt, planeIrr: planeIrr, production: production, clearSkySeries: clearSkySeries, schedule: schedule };
})();
if (typeof module !== 'undefined') module.exports = SDJ;
