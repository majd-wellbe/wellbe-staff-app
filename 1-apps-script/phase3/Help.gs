// =====================================================================
// CLIENT APP STATE (client app): in-app help (welcome tour, page tips) and the
// "Complete your profile" steps, saved per person so a refresh or a new phone
// never restarts a finished guide and a finished step never unticks.
// Add as a NEW FILE called "Help" in the "Wellbe W40 Backend" project.
// Reached through action app_cl_profile (Profile.gs) with op:
//   state                         -> { help, steps }
//   help      { help: patch }     -> { help, steps }   merge rules in helpMerge_
//   help_reset                    -> { help, steps }   every page tip shows again, tips mode on
//   steps     { met: ['photo',..]} -> { help, steps }  first time a step is met: { doneAt } (never removed)
// One row per Client ID in the tab CLIENT APP STATE (made the first time it is needed).
// =====================================================================
var HELPS = {
  TAB: 'CLIENT APP STATE',
  HEAD: ['Client ID', 'Name', 'Help', 'Steps', 'Updated'],
  STEPS: ['photo', 'promise', 'body', 'intake', 'run', 'credit'],   // the profile steps the app shows
  PAGE: /^[a-z][a-z_]{1,23}$/,                                        // page keys: center, wellbe, plan_wo, play, shop, me ...
  FINAL: { done: 1, dismissed: 1 },
  MAX_PAGES: 40
};
function helpOp_(op) { return /^(state|help|help_reset|steps)$/.test(String(op || '')); }
function helpParse_(s) { try { var o = JSON.parse(String(s || '')); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; } }
function helpEmpty_() { return { tips: null, asked: 0, tour: '', toast: 0, pages: {} }; }
function helpClean_(h) {
  h = h && typeof h === 'object' ? h : {};
  var out = helpEmpty_();
  if (h.tips === true || h.tips === false) out.tips = h.tips;
  out.asked = Math.max(0, Math.min(9, Math.floor(Number(h.asked) || 0)));
  out.tour = h.tour === 'done' || h.tour === 'skipped' ? h.tour : '';
  out.toast = h.toast ? 1 : 0;
  var pg = h.pages && typeof h.pages === 'object' ? h.pages : {}, n = 0;
  Object.keys(pg).forEach(function (k) {
    if (n >= HELPS.MAX_PAGES || !HELPS.PAGE.test(k)) return;
    var p = pg[k] || {}, s = String(p.s || '');
    if (s === 'done' || s === 'dismissed') out.pages[k] = { s: s };
    else if (s === 'prog') out.pages[k] = { s: 'prog', n: Math.max(0, Math.min(20, Math.floor(Number(p.n) || 0))) };
    else return;
    n++;
  });
  return out;
}
// patch from a phone onto the saved state. Never goes backwards:
//  - a page that is done or dismissed stays so (only help_reset clears it)
//  - the tour stays done once done; asked only grows; the Skip toast is shown once
//  - tips mode: the last choice wins
function helpMerge_(cur, patch) {
  var c = helpClean_(cur), p = helpClean_(patch), raw = patch && typeof patch === 'object' ? patch : {};
  if (raw.tips === true || raw.tips === false) c.tips = raw.tips;
  c.asked = Math.max(c.asked, p.asked);
  if (p.tour && c.tour !== 'done') c.tour = p.tour;
  c.toast = c.toast || p.toast;
  Object.keys(p.pages).forEach(function (k) {
    var was = c.pages[k];
    if (was && HELPS.FINAL[was.s] && !HELPS.FINAL[p.pages[k].s]) return;
    if (!was && Object.keys(c.pages).length >= HELPS.MAX_PAGES) return;
    c.pages[k] = p.pages[k];
  });
  return c;
}
// profile steps: the first time a step's condition is met it gets { doneAt }; a step is never removed
function stepsMerge_(cur, met, nowIso) {
  var out = {};
  HELPS.STEPS.forEach(function (k) { var s = cur && cur[k]; if (s && s.doneAt) out[k] = { doneAt: String(s.doneAt) }; });
  (Array.isArray(met) ? met : []).forEach(function (k) {
    k = String(k);
    if (HELPS.STEPS.indexOf(k) > -1 && !out[k]) out[k] = { doneAt: nowIso };
  });
  return out;
}
// the saved row of one client: { row (0 = none), help, steps }
function helpRead_(ops, cid) {
  var sh = ops.getSheetByName(HELPS.TAB), n = sh ? sh.getLastRow() : 0, out = { sh: sh, row: 0, help: helpEmpty_(), steps: {} };
  if (n < 2) return out;
  var ids = sh.getRange(2, 1, n - 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]).trim().toUpperCase() !== cid) continue;
    var r = sh.getRange(i + 2, 1, 1, HELPS.HEAD.length).getValues()[0];
    out.row = i + 2; out.help = helpClean_(helpParse_(r[2])); out.steps = stepsMerge_(helpParse_(r[3]), [], '');
    break;
  }
  return out;
}
function helpWrite_(ops, cid, cur, help, steps) {
  var sh = cur.sh || appTab_(ops, HELPS.TAB, HELPS.HEAD);
  var name = '';
  if (cur.row) name = String(sh.getRange(cur.row, 2).getValue() || '');
  if (!name) { try { name = ((typeof appClientInfo_ === 'function' ? appClientInfo_(cid) : null) || {}).name || cid; } catch (e) { name = cid; } }
  var row = [cid, name, JSON.stringify(help), JSON.stringify(steps), Utilities.formatDate(new Date(), CFG.TZ, 'dd/MM/yyyy HH:mm')];
  if (cur.row) sh.getRange(cur.row, 1, 1, row.length).setValues([row]); else sh.appendRow(row);
}
// action app_cl_profile, help ops (the router in Profile.gs sends them here)
function helpClient_(b, cid, who) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), op = String(b.op || ''), cur = helpRead_(ops, cid);
  if (op === 'state') return { help: cur.help, steps: cur.steps };
  var help = cur.help, steps = cur.steps;
  if (op === 'help') help = helpMerge_(cur.help, b.help);
  else if (op === 'help_reset') { help = helpClean_(cur.help); help.pages = {}; help.tips = true; }
  else if (op === 'steps') steps = stepsMerge_(cur.steps, b.met, new Date().toISOString());
  else throw new Error('unknown');
  if (JSON.stringify(help) !== JSON.stringify(cur.help) || JSON.stringify(steps) !== JSON.stringify(cur.steps)) helpWrite_(ops, cid, cur, help, steps);
  return { help: help, steps: steps };
}
// run once from the editor
function helpTest() {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID); appTab_(ops, HELPS.TAB, HELPS.HEAD);
  Logger.log('CLIENT APP STATE tab ready. Merge check: ' + JSON.stringify(helpMerge_({ pages: { me: { s: 'done' } } }, { pages: { me: { s: 'prog', n: 1 } } })));
}
