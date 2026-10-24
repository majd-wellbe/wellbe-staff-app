/* Wellbe shared core (staff app, client app, game). Plain ES5, no build step.
   Loaded with <script src="../core/wb-core.js?v=1"> before each app's own script.
   Everything lives on window.WB. Apps keep their short local names (esc, ymd, ...) as aliases.
   Business settings (staff, prices, hours, offers, game rules) are NOT here: they come from the
   server in boot as d.cfg and are read with WB.cfg / WB.get(path, fallback). */
(function (w) {
  'use strict';
  var WB = w.WB || {};

  /* ---------- DOM ---------- */
  WB.$ = function (s, r) { return (r || document).querySelector(s); };
  WB.$$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ---------- text ---------- */
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  // every user or server text that goes into innerHTML passes through esc()
  WB.esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return ESC[c]; }); };
  // ids and codes used inside attributes: strips anything that could break out
  WB.code = function (v) { return String(v == null ? '' : v).replace(/[<>"'`&]/g, ''); };
  WB.first = function (n) { return String(n == null ? '' : n).split(' ')[0]; };
  WB.pad = function (n) { return (n < 10 ? '0' : '') + n; };

  /* ---------- dates (all days are local calendar days, noon to dodge DST) ---------- */
  WB.ymd = function (d) { return d.getFullYear() + '-' + WB.pad(d.getMonth() + 1) + '-' + WB.pad(d.getDate()); };
  WB.dOf = function (s) { return new Date(s + 'T12:00:00'); };                    // 'yyyy-mm-dd' -> Date
  WB.addDaysDate = function (d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; };   // Date -> Date
  WB.addDaysYmd = function (s, n) { var d = WB.dOf(s); d.setDate(d.getDate() + n); return WB.ymd(d); }; // ymd -> ymd
  WB.fmtDay = function (s, opt) { return WB.dOf(s).toLocaleDateString('en-GB', opt); };
  WB.dayShort = function (s) { return WB.fmtDay(s, { weekday: 'short', day: 'numeric', month: 'short' }); };
  WB.dayLong = function (s) { return WB.fmtDay(s, { weekday: 'long', day: 'numeric', month: 'long' }); };
  WB.dmy = function (s) { return s ? WB.fmtDay(s, { day: 'numeric', month: 'short', year: 'numeric' }) : ''; };
  // '07:30' -> '7:30 AM'; with short: '07:00' -> '7 AM'
  WB.hourLabel = function (t, short) {
    var p = String(t || '').split(':'), h = +p[0], m = p[1] || '00';
    return (h % 12 || 12) + (short && m === '00' ? '' : ':' + m) + (h < 12 ? ' AM' : ' PM');
  };

  /* ---------- money ---------- */
  // dec: 0 rounds to the dollar (staff), 2 keeps cents (client)
  WB.money = function (n, dec) {
    var v = dec ? Math.round(n * 100) / 100 : Math.round(n);
    return '$' + v.toLocaleString('en-US');
  };

  /* ---------- storage ---------- */
  // store(k) reads, store(k, v) writes, store(k, null) removes. Never throws (private mode, blocked storage).
  WB.store = function (k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    } catch (e) { return null; }
  };
  WB.storeJSON = function (k, fallback) { try { var v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? fallback : v; } catch (e) { return fallback; } };
  // remove every key that starts with one of the prefixes (sign out)
  WB.storeClear = function (prefixes) {
    try {
      var del = [];
      for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (prefixes.some(function (p) { return k.indexOf(p) === 0; })) del.push(k); }
      del.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) {}
  };

  /* ---------- server ---------- */
  WB.API = 'https://script.google.com/macros/s/AKfycbxrCVPkY-h2xqTqeHhhaChdaSAf1KbEsJ_HbRSP-oyg4r-qgF-sgSJtFZ0D0uyhDiOS/exec';
  function netErr(m) { var e = new Error(m); e.net = true; return e; }
  // POST one action. auth: {key} (staff) or {token} (client). Times out (default 20 s).
  // Rejects with Error(message); e.net = true for network problems, message 'auth' / 'signin' for a bad login.
  WB.api = function (action, data, auth, opt) {
    data = data || {}; data.action = action; opt = opt || {};
    if (auth) for (var k in auth) if (auth[k]) data[k] = auth[k];
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var tm = setTimeout(function () { if (ctl) ctl.abort(); }, opt.timeout || 20000);
    return fetch(opt.url || WB.API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(data), signal: ctl ? ctl.signal : undefined })
      .then(function (r) { if (!r.ok) throw netErr('server'); return r.json(); }, function (e) { throw netErr(e && e.name === 'AbortError' ? 'timeout' : 'offline'); })
      .then(function (j) { clearTimeout(tm); if (!j || !j.ok) throw new Error((j && j.error) || 'Server error'); return j; },
            function (e) { clearTimeout(tm); throw e; });
  };

  /* ---------- settings from the server (boot d.cfg) ---------- */
  WB.cfg = null;
  WB.setCfg = function (c) { if (c && typeof c === 'object') WB.cfg = c; return WB.cfg; };
  // WB.get('offers.m3', 7): a path into the settings, with a fallback while settings are missing
  WB.get = function (path, fb) {
    var o = WB.cfg; if (!o) return fb;
    var p = String(path).split('.');
    for (var i = 0; i < p.length; i++) { if (o == null || typeof o !== 'object' || !(p[i] in o)) return fb; o = o[p[i]]; }
    return o == null ? fb : o;
  };
  // staff helpers: by id ('romy'), by trainer name ('Joe'), by role ('assistant')
  WB.staff = function () { return WB.get('staff', []); };
  WB.staffById = function (id) { return WB.staff().filter(function (s) { return s.id === id; })[0] || null; };
  WB.staffByTrainer = function (t) { t = String(t || '').toLowerCase(); return WB.staff().filter(function (s) { return s.trainer && s.trainer.toLowerCase() === t; })[0] || null; };
  WB.staffByRole = function (r) { return WB.staff().filter(function (s) { return s.role === r; }); };
  // the person at the front desk (requests, bookings, WhatsApp): first name, e.g. 'Romy'
  WB.deskName = function () { var d = WB.staffById(WB.get('center.desk', '')) || WB.staffByRole('assistant')[0]; return d ? WB.first(d.name) : 'the front desk'; };
  WB.ownerName = function () { var o = WB.staffByRole('owner')[0]; return o ? WB.first(o.name) : ''; };

  /* ---------- WhatsApp ---------- */
  // local numbers starting with 0 get the center's country code
  WB.wa = function (phone, msg) {
    var cc = String(WB.get('center.country', '961'));
    return 'https://wa.me/' + String(phone || '').replace(/\D/g, '').replace(/^0/, cc) + '?text=' + encodeURIComponent(msg || '');
  };

  w.WB = WB;
})(window);
