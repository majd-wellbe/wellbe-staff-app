// =====================================================================
// CORNICHE RUN (client app game)
// Two currencies:
//  COINS (250 / 500 lira): in-game only. Upgrades, extra lives, revives. Never cashed out.
//  CASH: real money off a renewal. $0.10 per 2 km run in a day, max $0.50 a day, only for
//        clients who trained at the center in the last 7 days. Used at renewal, max $10 per package.
// Everything is saved here (CORNICHE RUN tab) so it cannot be faked on the phone.
// Action app_cl_run with op: get | save | buy | redeem
// =====================================================================
var RUN = {
  HEAD: ['Client ID', 'Name', 'Best score', 'Best m', 'Coins', 'Runs', 'Total m', 'Day', 'Day best', 'Week', 'Week best', 'Upgrades', 'Missions', 'Badges', 'Last run', 'Earned total', 'Updated', 'Cash (cents)', 'Cash earned (cents)'],
  UP_COST: [500, 1000, 2000, 4000, 8000],
  LIFE_COST: 1000, LIFE_MAX: 3,   // extra life: start a run with 2 hearts
  CASH: { PER_M: 2000, CENTS: 10, DAY_MAX: 50, REDEEM_MIN: 100, REDEEM_MAX: 1000, TRAINED_DAYS: 7 },
  MISSIONS: [
    { k: 'coins', t: 'Collect 150 coins in one run', s: 'coins', m: 'max', n: 150, r: 200 },
    { k: 'd1', t: 'Run 1,000 m in one run', s: 'm', m: 'max', n: 1000, r: 200 },
    { k: 'd2', t: 'Run 2,500 m in one run', s: 'm', m: 'max', n: 2500, r: 400 },
    { k: 'jump', t: 'Jump 40 times today', s: 'jumps', m: 'sum', n: 40, r: 150 },
    { k: 'slide', t: 'Slide 30 times today', s: 'slides', m: 'sum', n: 30, r: 150 },
    { k: 'roof', t: 'Run 300 m on kiosk roofs today', s: 'roof', m: 'sum', n: 300, r: 200 },
    { k: 'runs', t: 'Play 5 runs today', s: 'runs', m: 'sum', n: 5, r: 150 },
    { k: 'power', t: 'Grab 4 power ups today', s: 'powers', m: 'sum', n: 4, r: 150 },
    { k: 'score', t: 'Score 5,000 in one run', s: 'score', m: 'max', n: 5000, r: 250 },
    { k: 'clean', t: 'Run 600 m without tripping', s: 'clean', m: 'max', n: 600, r: 250 },
    { k: 'mult', t: 'Reach x3 score in a run', s: 'mult', m: 'max', n: 3, r: 200 }
  ],
  ALL_BONUS: 300,
  BADGES: { first: 'First run', km1: '1 km in one run', km5: '5 km in one run', km10: '10 km in one run', runs10: '10 runs', runs50: '50 runs', runs100: '100 runs',
    day1: '#1 of the day', week1: '#1 of the week', week10: 'Top 10 of the week', all3: 'All time top 3', all1: 'All time #1', rich: '10,000 coins earned', boost: 'Trained and ran the same day' }
};

function clRun_(b, cid) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), tz = CFG.TZ, now = new Date(), today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var week = runWeek_(today), sh = appTab_(ops, 'CORNICHE RUN', RUN.HEAD), n = sh.getLastRow();
  if (String(sh.getRange(1, 18).getValue()) !== RUN.HEAD[17]) sh.getRange(1, 18, 1, 2).setValues([[RUN.HEAD[17], RUN.HEAD[18]]]).setFontWeight('bold').setBackground('#1f2a2e').setFontColor('#ffffff');
  var v = n > 1 ? sh.getRange(2, 1, n - 1, RUN.HEAD.length).getValues() : [], at = -1;
  for (var i = 0; i < v.length; i++) if (String(v[i][0]).toUpperCase() === cid) { at = i; break; }
  var rec = at < 0 ? [cid, runName_(cid), 0, 0, 0, 0, 0, '', 0, '', 0, '{}', '{}', '[]', '', 0, '', 0, 0] : v[at].slice();
  rec[17] = Number(rec[17]) || 0; rec[18] = Number(rec[18]) || 0;
  var up = runJ_(rec[11], {}), ms = runJ_(rec[12], {}), badges = runJ_(rec[13], []);
  if (ms.d !== today) ms = { d: today, st: {}, done: [], bonus: 0 };
  var dk = 'D' + today, wk = 'W' + week;   // text keys so Sheets never turns them into dates
  if (String(rec[7]) !== dk) { rec[7] = dk; rec[8] = 0; }
  if (String(rec[9]) !== wk) { rec[9] = wk; rec[10] = 0; }
  var op = String(b.op || 'get'), out = { newBadges: [], mdone: [] }, changed = at < 0, boost = runBoost_(ops, cid, today), trained = runTrained_(ops, cid, today);

  if (op === 'save') {
    var r = b.run || {}, secs = Math.max(0, Number(r.secs) || 0), m = Math.max(0, Math.round(Number(r.m) || 0)),
      coins = Math.max(0, Math.round(Number(r.coins) || 0)), score = Math.max(0, Math.round(Number(r.score) || 0)), spent = Math.max(0, Math.round(Number(r.spent) || 0));
    var last = Number(String(rec[14] || '').replace(/^T/, '')) || 0;
    if (secs < 3 || secs > 3600) throw new Error('That run is not possible.');
    if (m > secs * 17.5 + 30 || coins > m * 0.35 + 80 || score > m * 5 + coins * 5 + 50) throw new Error('That run is not possible.');
    if (last && now.getTime() - last < secs * 700) throw new Error('Slow down, one run at a time.');
    var ev = r.ev || {}, cap = function (k, max) { return Math.max(0, Math.min(Math.round(Number(ev[k]) || 0), max)); };
    var got = { coins: coins, m: m, score: score, jumps: cap('jumps', secs * 3), slides: cap('slides', secs * 3), roof: cap('roof', m), runs: 1, powers: cap('powers', Math.floor(m / 40) + 2), clean: cap('clean', m), mult: cap('mult', 5) };
    var earned = coins * (boost ? 2 : 1);
    // daily missions
    runToday_(today).forEach(function (mi) {
      var cur = Number(ms.st[mi.k]) || 0;
      ms.st[mi.k] = mi.m === 'sum' ? cur + got[mi.s] : Math.max(cur, got[mi.s]);
      if (ms.done.indexOf(mi.k) < 0 && ms.st[mi.k] >= mi.n) { ms.done.push(mi.k); earned += mi.r; out.mdone.push({ t: mi.t, r: mi.r }); }
    });
    if (ms.done.length >= 3 && !ms.bonus) { ms.bonus = 1; earned += RUN.ALL_BONUS; out.mdone.push({ t: 'All 3 missions done', r: RUN.ALL_BONUS }); }
    var lt = Math.max(0, Math.min(Math.round(Number(ev.letters) || 0), m >= 800 ? 2 : m >= 350 ? 1 : 0));
    if (lt) { ms.wl = Math.min(7, (Number(ms.wl) || 0) + lt); if (ms.wl >= 7 && !ms.wb) { ms.wb = 1; earned += 1000; out.mdone.push({ t: 'WELLBE complete', r: 1000 }); } }
    // cash: meters add up over the day, $0.10 per 2 km, max $0.50 a day, only after training this week
    out.cashEarned = 0;
    if (trained) {
      ms.mt = (Number(ms.mt) || 0) + m;
      var target = Math.min(RUN.CASH.DAY_MAX, Math.floor(ms.mt / RUN.CASH.PER_M) * RUN.CASH.CENTS), ce = Math.max(0, target - (Number(ms.cash) || 0));
      ms.cash = target; rec[17] += ce; rec[18] += ce; out.cashEarned = ce;
    }
    if (ev.lifeUsed && (Number(up.life) || 0) > 0) up.life = Number(up.life) - 1;
    rec[4] = Math.max(0, (Number(rec[4]) || 0) + earned - spent);
    rec[15] = (Number(rec[15]) || 0) + earned;
    rec[5] = (Number(rec[5]) || 0) + 1; rec[6] = (Number(rec[6]) || 0) + m;
    out.record = score > (Number(rec[2]) || 0);
    if (out.record) rec[2] = score;
    rec[3] = Math.max(Number(rec[3]) || 0, m);
    rec[8] = Math.max(Number(rec[8]) || 0, score); rec[10] = Math.max(Number(rec[10]) || 0, score);
    rec[14] = 'T' + now.getTime(); out.earned = earned; out.boosted = boost;
    var add = function (id) { if (badges.indexOf(id) < 0) { badges.push(id); out.newBadges.push(RUN.BADGES[id]); } };
    add('first'); if (m >= 1000) add('km1'); if (m >= 5000) add('km5'); if (m >= 10000) add('km10');
    if (rec[5] >= 10) add('runs10'); if (rec[5] >= 50) add('runs50'); if (rec[5] >= 100) add('runs100');
    if (rec[15] >= 10000) add('rich'); if (boost) add('boost');
    out._badgeAdd = add; changed = true;
  }
  if (op === 'buy') {
    var item = String(b.item || '');
    if (item === 'life') {
      if ((Number(up.life) || 0) >= RUN.LIFE_MAX) throw new Error('You already have ' + RUN.LIFE_MAX + ' extra lives');
      if ((Number(rec[4]) || 0) < RUN.LIFE_COST) throw new Error('Not enough coins');
      rec[4] = Number(rec[4]) - RUN.LIFE_COST; up.life = (Number(up.life) || 0) + 1; changed = true;
    } else {
      if (['magnet', 'jet', 'shoes'].indexOf(item) < 0) throw new Error('Unknown upgrade');
      var lv = Number(up[item]) || 0; if (lv >= RUN.UP_COST.length) throw new Error('Already maxed');
      var cost = RUN.UP_COST[lv]; if ((Number(rec[4]) || 0) < cost) throw new Error('Not enough coins');
      rec[4] = Number(rec[4]) - cost; up[item] = lv + 1; changed = true;
    }
  }
  var pend = runCashPending_(ops, cid);
  if (op === 'redeem') {
    if (pend) throw new Error('You already have $' + (pend / 100).toFixed(2) + ' waiting for your next renewal.');
    var amt = Math.min(rec[17], RUN.CASH.REDEEM_MAX);
    if (amt < RUN.CASH.REDEEM_MIN) throw new Error('You need at least $' + (RUN.CASH.REDEEM_MIN / 100).toFixed(2) + ' Cash.');
    rec[17] -= amt; pend = amt;
    clLog_(ops, cid, rec[1], 'Game cash', rec[1] + ' used $' + (amt / 100).toFixed(2) + ' Corniche Run Cash: take it off their next package when they renew (max $10 per package).', '', '', 'New', { cents: amt });
    out.redeemed = amt; changed = true;
  }

  rec[11] = JSON.stringify(up); rec[12] = JSON.stringify(ms); rec[16] = Utilities.formatDate(now, tz, 'dd/MM/yyyy HH:mm');
  if (at < 0) v.push(rec); else v[at] = rec;
  var boards = runBoards_(v, cid, dk, wk);
  if (out._badgeAdd) {
    var add2 = out._badgeAdd;
    var T = boards.lists.totals;   // rank badges only count once enough people are playing
    if (boards.rank.day === 1 && T.day >= 3) add2('day1'); if (boards.rank.week === 1 && T.week >= 5) add2('week1'); if (boards.rank.week && boards.rank.week <= 10 && T.week >= 12) add2('week10');
    if (boards.rank.all && boards.rank.all <= 3 && T.all >= 10) add2('all3'); if (boards.rank.all === 1 && T.all >= 10) add2('all1');
    delete out._badgeAdd;
  }
  rec[13] = JSON.stringify(badges);
  if (changed) {
    if (at < 0) sh.appendRow(rec); else sh.getRange(at + 2, 1, 1, rec.length).setValues([rec]);
  }
  out.coins = Number(rec[4]) || 0; out.best = Number(rec[2]) || 0; out.bestM = Number(rec[3]) || 0; out.runs = Number(rec[5]) || 0;
  out.up = { magnet: up.magnet || 0, jet: up.jet || 0, shoes: up.shoes || 0, life: up.life || 0 }; out.upCost = RUN.UP_COST; out.lifeCost = RUN.LIFE_COST; out.lifeMax = RUN.LIFE_MAX;
  out.cash = { bal: rec[17], total: rec[18], today: Number(ms.cash) || 0, mToday: Number(ms.mt) || 0, perM: RUN.CASH.PER_M, cents: RUN.CASH.CENTS, dayMax: RUN.CASH.DAY_MAX,
    min: RUN.CASH.REDEEM_MIN, max: RUN.CASH.REDEEM_MAX, trained: trained, pending: pend || 0 };
  out.missions = runToday_(today).map(function (mi) { return { k: mi.k, t: mi.t, n: mi.n, p: Math.min(mi.n, Number(ms.st[mi.k]) || 0), done: ms.done.indexOf(mi.k) >= 0, r: mi.r, s: mi.s, m: mi.m }; });
  out.allBonus = RUN.ALL_BONUS; out.bonusDone = !!ms.bonus; out.word = Number(ms.wl) || 0; out.wordBonus = 1000;
  out.badges = badges.map(function (id) { return { id: id, t: RUN.BADGES[id] }; });
  out.boost = boost; out.boards = boards.lists; out.rank = boards.rank;
  return out;
}

function runJ_(s, d) { try { var o = JSON.parse(s || ''); return o == null ? d : o; } catch (e) { return d; } }
function runName_(cid) { var c = appClientInfo_(cid); return c ? String(c.name || '').trim() : cid; }
function runShort_(name) { var p = String(name || '').trim().split(/\s+/); return p.length > 1 ? p[0] + ' ' + p[p.length - 1].charAt(0) + '.' : (p[0] || 'Runner'); }
function runWeek_(ymd) { var d = new Date(ymd + 'T12:00:00Z'), k = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - k); return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd'); }
// 3 missions a day, the same for everyone
function runToday_(today) {
  var seed = Number(today.replace(/-/g, '')) % 2147483647, pool = RUN.MISSIONS.slice(), out = [];
  while (out.length < 3 && pool.length) { seed = (seed * 48271) % 2147483647; out.push(pool.splice(seed % pool.length, 1)[0]); }
  return out;
}
// trained today or yesterday = double coins
function runBoost_(ops, cid, today) {
  var cache = CacheService.getScriptCache(), key = 'runboost|' + cid + '|' + today, c = cache.get(key);
  if (c) return c === '1';
  var ids = clPkgIds_(ops, cid), yes = false;
  appSessions_(ops, appShift_(today, -1), today, null).forEach(function (s) {
    s.clients.forEach(function (x) { if (ids[x.pkg] && /present/i.test(x.att || '')) yes = true; });
  });
  cache.put(key, yes ? '1' : '0', 1800);
  return yes;
}
// trained at the center in the last 7 days = can earn Cash
function runTrained_(ops, cid, today) {
  var cache = CacheService.getScriptCache(), key = 'runtrained|' + cid + '|' + today, c = cache.get(key);
  if (c) return c === '1';
  var ids = clPkgIds_(ops, cid), yes = false, hm = Utilities.formatDate(new Date(), CFG.TZ, 'HH:mm');
  appSessions_(ops, appShift_(today, -(RUN.CASH.TRAINED_DAYS - 1)), today, null).forEach(function (s) {
    if (s.status === 'Cancelled') return;
    s.clients.forEach(function (x) {
      if (!ids[x.pkg] || /cancel|no show/i.test(x.att || '')) return;
      if (/present|done/i.test(x.att || '') || (!x.att && (s.date < today || s.start <= hm))) yes = true;   // unmarked sessions become Present at 21:30
    });
  });
  cache.put(key, yes ? '1' : '0', 1800);
  return yes;
}
// Cash already sent to Romy and not handled yet (cents)
function runCashPending_(ops, cid) {
  var p = 0;
  appRows_(ops, 'CLIENT REQUESTS', 2, CL.REQ_HEAD.length).forEach(function (r) {
    if (String(r[2]).toUpperCase() === cid && String(r[4]) === 'Game cash' && String(r[8] || 'New') === 'New') { try { p += Number(JSON.parse(r[11] || '{}').cents) || 0; } catch (e) {} }
  });
  return p;
}
function runBoards_(v, cid, today, week) {
  var mk = function (col, keyCol, key) {
    var rows = v.filter(function (r) { return r[0] && (Number(r[col]) || 0) > 0 && (keyCol < 0 || String(r[keyCol]) === key); })
      .sort(function (a, b) { return (Number(b[col]) || 0) - (Number(a[col]) || 0); });
    var rank = 0; rows.forEach(function (r, i) { if (String(r[0]).toUpperCase() === cid) rank = i + 1; });
    return { list: rows.slice(0, 10).map(function (r, i) { return { n: runShort_(r[1]), s: Number(r[col]) || 0, me: String(r[0]).toUpperCase() === cid, i: i + 1 }; }), rank: rank, total: rows.length };
  };
  var d = mk(8, 7, today), w = mk(10, 9, week), a = mk(2, -1, '');
  return { lists: { day: d.list, week: w.list, all: a.list, totals: { day: d.total, week: w.total, all: a.total } }, rank: { day: d.rank, week: w.rank, all: a.rank } };
}
// run once from the editor to check it is wired
function runTest() {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), g = appRows_(ops, 'CLIENT GOALS', 2, 1).filter(function (r) { return r[0]; })[0];
  var cid = g ? String(g[0]).toUpperCase() : 'C001';
  Logger.log(JSON.stringify(clRun_({ op: 'get' }, cid)).slice(0, 1500));
}
