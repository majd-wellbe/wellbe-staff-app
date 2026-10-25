/* Wellbe backend switch: Apps Script (today) or Supabase (after the move). Plain ES5, no build step.
   Load right AFTER core/wb-core.js:  <script src="../core/wb-backend.js?v=1"></script>
   It replaces WB.api with one that sends the same {action, key|token, ...} to the chosen server
   and gives back the same answer shape, so the apps do not change.

   Which server:
     localStorage wb_backend = 'supabase'  -> Supabase on this phone (testing)
     localStorage wb_backend = 'apps'      -> Apps Script on this phone, whatever the settings say
     else settings backend.use = 'supabase' (Operations sheet SETTINGS, sent in boot) -> Supabase for everyone
     else Apps Script
   Side by side week: localStorage wb_shadow = '1' -> every READ action also goes to the other server in the
   background; if the answers differ, a short report is saved in Supabase (app.shadow_log). Writes never go twice.
   For one phone without tools: open the app once with ?wb=supabase, ?wb=apps, ?wb=auto (follow the settings),
   ?wb=shadow or ?wb=noshadow added to its address. It is remembered on that phone.
   The publishable key below is public by design. Never put the service_role key in an app. */
(function (w) {
  'use strict';
  var WB = w.WB; if (!WB || !WB.api) return;
  var appsApi = WB.api;                                   // the Apps Script call from wb-core.js
  WB.SUPA = 'https://lfpdcqtwwxkoxvbrlnep.supabase.co/functions/v1/api';
  WB.SUPA_KEY = 'sb_publishable_DNy9ua9QayYLL4e_asTM7Q_idm7vlBW';

  function netErr(m) { var e = new Error(m); e.net = true; return e; }
  function supaApi(action, data, auth, opt) {
    data = data || {}; data.action = action; opt = opt || {};
    if (auth) for (var k in auth) if (auth[k]) data[k] = auth[k];
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var tm = setTimeout(function () { if (ctl) ctl.abort(); }, opt.timeout || 20000);
    return fetch(WB.SUPA, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: WB.SUPA_KEY }, body: JSON.stringify(data), signal: ctl ? ctl.signal : undefined })
      .then(function (r) { if (!r.ok && r.status !== 400) throw netErr('server'); return r.json(); }, function (e) { throw netErr(e && e.name === 'AbortError' ? 'timeout' : 'offline'); })
      .then(function (j) { clearTimeout(tm); if (!j || !j.ok) throw new Error((j && j.error) || 'Server error'); return j; },
            function (e) { clearTimeout(tm); throw e; });
  }

  WB.backend = function () {
    var v = WB.store('wb_backend');
    if (v === 'supabase' || v === 'apps') return v;
    return WB.get('backend.use', 'apps') === 'supabase' ? 'supabase' : 'apps';
  };
  WB.setBackend = function (v) { WB.store('wb_backend', v === 'supabase' || v === 'apps' ? v : null); };   // null: follow the settings
  WB.shadowOn = function () { return WB.store('wb_shadow') === '1'; };
  try {
    var m = /[?&]wb=(supabase|apps|auto|shadow|noshadow)(?:&|$)/.exec(String((w.location && w.location.search) || ''));
    if (m) { if (m[1] === 'shadow') WB.store('wb_shadow', '1'); else if (m[1] === 'noshadow') WB.store('wb_shadow', null); else WB.setBackend(m[1]); }
  } catch (e) {}

  // read actions: safe to send to both servers. Anything not listed is a write and goes to one server only.
  var READS = /^(app_boot|app_cl_boot|app_settings|app_history|app_cl_history|app_week|app_day|app_search|app_client|app_stats|app_report|app_lb|app_cl_lb|slots|landing_slots)$|_(get|list|view|load|search|stats|report|lb)$/;
  WB.isRead = function (action, data) { return READS.test(action) || (action === 'app_cl_run' && data && data.op === 'get'); };

  // compare two answers; fields that change every call are ignored
  var SKIP = { ts: 1, at: 1, now: 1, cached: 1, took: 1, ms: 1, v: 1, server: 1, token: 1 };
  function norm(x) {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === 'object') { var o = {}; Object.keys(x).sort().forEach(function (k) { if (!SKIP[k]) o[k] = norm(x[k]); }); return o; }
    if (typeof x === 'number') return Math.round(x * 100) / 100;
    return x;
  }
  WB.shadowDiff = function (a, b) {
    var out = [];
    (function walk(p, x, y) {
      if (out.length >= 40) return;
      if (JSON.stringify(x) === JSON.stringify(y)) return;
      if (x && y && typeof x === 'object' && typeof y === 'object' && Array.isArray(x) === Array.isArray(y)) {
        if (Array.isArray(x) && x.length !== y.length) { out.push({ p: p, apps: 'len ' + x.length, supa: 'len ' + y.length }); return; }
        var ks = {}; Object.keys(x).concat(Object.keys(y)).forEach(function (k) { ks[k] = 1; });
        Object.keys(ks).forEach(function (k) { walk(p ? p + '.' + k : k, x[k], y[k]); });
        return;
      }
      var s = function (v) { v = JSON.stringify(v); return v === undefined ? 'missing' : v.length > 120 ? v.slice(0, 120) + '...' : v; };
      out.push({ p: p, apps: s(x), supa: s(y) });
    })('', norm(a), norm(b));
    return out;
  };

  function shadow(action, data, auth, opt, mainIsSupa, mainP) {
    var copy = JSON.parse(JSON.stringify(data || {}));
    var other = (mainIsSupa ? appsApi : supaApi)(action, copy, auth, opt).then(function (j) { return { ok: true, j: j }; }, function (e) { return { ok: false, e: String(e && e.message || e) }; });
    var main = mainP.then(function (j) { return { ok: true, j: j }; }, function (e) { return { ok: false, e: String(e && e.message || e) }; });
    Promise.all([main, other]).then(function (r) {
      var apps = mainIsSupa ? r[1] : r[0], supa = mainIsSupa ? r[0] : r[1];
      if (!apps.ok && /^(offline|timeout|server)$/.test(apps.e)) return;            // no signal: nothing to compare
      var diff = apps.ok && supa.ok ? WB.shadowDiff(apps.j, supa.j) : (apps.ok === supa.ok && apps.e === supa.e ? [] : [{ p: '(error)', apps: apps.ok ? 'ok' : apps.e, supa: supa.ok ? 'ok' : supa.e }]);
      if (w.console && diff.length) console.warn('[wb shadow] ' + action + ' differs', diff);
      supaApi('wb_shadow', { of: action, same: !diff.length, diff: diff.length ? diff : null }, auth, { timeout: 10000 }).catch(function () {});
    });
  }

  WB.api = function (action, data, auth, opt) {
    var supa = WB.backend() === 'supabase';
    var p = (supa ? supaApi : appsApi)(action, data, auth, opt);
    if (WB.shadowOn() && WB.isRead(action, data)) { try { shadow(action, data, auth, opt, supa, p); } catch (e) {} }
    return p;
  };
  WB.api.apps = appsApi; WB.api.supabase = supaApi;
})(window);
