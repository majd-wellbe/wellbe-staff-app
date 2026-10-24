// =====================================================================
// PROMISE STREAK: settings streak.days (28) days in a row of all 3 keys = 1 free session
// The streak lives here (CLIENT STREAKS tab), not on the phone, so it
// survives a new phone and cannot be backdated. Only today can be ticked.
// =====================================================================
var STREAK = {
  get DAYS() { return cfg_().streak.days; },             // days in a row to unlock the free session (settings: streak.days)
  get VALID_DAYS() { return cfg_().streak.validDays; },   // the free session package stays valid this long
  HEAD: ['Client ID', 'Name', 'Done Days', 'Keys Date', 'Keys', 'Last Reward', 'Reward Package', 'Rewards']
};

// action app_cl_streak: { cid } reads, { cid, keys:[b,b,b] } saves today's ticks
function clStreak_(b, cid) {
  // the client router already holds the script lock
  try {
    var ops = SpreadsheetApp.openById(CFG.OPS_ID), today = Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
    var sh = appTab_(ops, 'CLIENT STREAKS', STREAK.HEAD), n = sh.getLastRow(), at = -1;
    var v = n > 1 ? sh.getRange(2, 1, n - 1, STREAK.HEAD.length).getDisplayValues() : [];
    for (var i = 0; i < v.length; i++) if (String(v[i][0]).toUpperCase() === cid) { at = i; break; }
    var rec = at < 0 ? [cid, appClientInfo_(cid).name, '', '', '', '', '', 0] : v[at].slice();
    var days = String(rec[2] || '').split(',').filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); });
    var keys = String(rec[3]) === today ? String(rec[4] || '000').split('').slice(0, 3).map(function (c) { return c === '1'; }) : [false, false, false];
    while (keys.length < 3) keys.push(false);
    var unlocked = false, changed = false;

    if (b.keys) {
      keys = [0, 1, 2].map(function (k) { return !!b.keys[k]; });
      var all = keys.every(Boolean), has = days.indexOf(today) >= 0;
      if (all && !has) days.push(today);
      if (!all && has) days = days.filter(function (d) { return d !== today; });
      days = days.sort().slice(-120);
      rec[2] = days.join(','); rec[3] = today; rec[4] = keys.map(function (x) { return x ? '1' : '0'; }).join('');
      changed = true;
    }

    var last = String(rec[5] || ''), count = clStreakCount_(days, today, last);
    if (count >= STREAK.DAYS) {
      var cur = clPkgsOf_(ops, cid, today).filter(function (p) { return p.phase === 'current'; })[0];
      if (cur) {   // reward only while they have an active package
        roGuard_();
        var kind = (cur.kind || cfgKind_(cur.type)) === '1:1' ? '1:1' : '1:3';   // clPkgsOf_ has no kind: take it from the package type
        var type = 'Streak Reward - ' + kind + ' (Free)';
        var id = clAddPkg_(ops, cid, rec[1], type, 0, today, 0, STREAK.DAYS + ' day promise streak reward (client app). Free, 1 session.');
        var ps = ops.getSheetByName('PACKAGES'), pr = appPkgRow_(ps, id);
        var exp = beirutDate_(clDayShift_(today, STREAK.VALID_DAYS), 0);
        ps.getRange(pr, 5, 1, 4).setValues([[1, 0, 1, 0]]);          // 1 pass, 0 used, 1 left, $0 per pass
        ps.getRange(pr, 11).setValue(exp); ps.getRange(pr, 13).setValue(exp);
        ps.getRange(pr, 11, 1, 3).setNumberFormat('dd/MM/yyyy');
        clLog_(ops, cid, rec[1], 'Streak reward', rec[1] + ' kept their promise ' + STREAK.DAYS + ' days in a row! Free ' + kind + ' session added (' + id + '). Message them to book it.', '', id, 'New', { pkg: id });
        rec[5] = today; rec[6] = id; rec[7] = (Number(rec[7]) || 0) + 1;
        last = today; count = 0; unlocked = true; changed = true;
      }
    }

    if (changed) {
      roGuard_();
      if (at < 0) sh.appendRow(rec); else sh.getRange(at + 2, 1, 1, rec.length).setValues([rec]);
    }
    return {
      keys: keys,
      streak: clStreakCount_(days, today, ''),
      count: count,
      goal: STREAK.DAYS,
      reward: rec[5] ? { date: String(rec[5]), pkg: String(rec[6]) } : null,
      unlocked: unlocked,
      _bump: unlocked          // a reward adds a package: the staff app must reload
    };
  } finally { }
}

// days in a row ending today (or yesterday if today is not done yet), only after the last reward
function clStreakCount_(days, today, after) {
  var set = {}; days.forEach(function (d) { set[d] = 1; });
  var d = set[today] ? today : clDayShift_(today, -1), n = 0;
  while (set[d] && (!after || d > after)) { n++; d = clDayShift_(d, -1); }
  return n;
}
function clDayShift_(ymd, k) { return appShift_(ymd, k); }

// run once from the editor to check it is wired (uses the first client in CLIENT GOALS)
function streakTest() {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID);
  var g = appRows_(ops, 'CLIENT GOALS', 2, 2).filter(function (r) { return r[0]; })[0];
  if (!g) { Logger.log('No client has written a promise yet.'); return; }
  Logger.log('Streak for ' + g[0] + ': ' + JSON.stringify(clStreak_({}, String(g[0]).toUpperCase())));
}