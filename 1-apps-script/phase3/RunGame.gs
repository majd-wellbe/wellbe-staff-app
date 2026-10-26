// =====================================================================
// CORNICHE RUN (client app game)
// Two currencies:
//  COINS (250 / 500 lira): in-game only. Upgrades, extra lives, revives. Never cashed out.
//  WELLBE CREDIT (the 'cash' fields in the code and the sheet): $0.10 for every run that passes 2,000 m (once per run),
//        max $0.50 a day. Every player earns Wellbe Credit (clients and guests). It is used on the first or next package,
//        or on an online workout, max $20 at a time.
// Everything is saved here (CORNICHE RUN tab) so it cannot be faked on the phone.
// Action app_cl_run with op: get | save | buy | redeem | shop
//   buy with item = an outfit id (coach, ramadan, ...) buys a runner outfit; every reply has outfits: [{ id, n, own, rule, coins, lv, have, need, can }]
//   save returns earned (total coins) and breakdown { picked, boost, missions, allBonus, wellbe, total }
//   badges: 12 ladders x 5 tiers (RUN.LADDERS), returned as ladders; the old badges list stays for older phones
//   lbHide (on get and save): true hides this player from the leaderboards (they still see their own rank)
//   name (on get, or op name): the runner name shown on the leaderboards (2 to 14 letters, numbers, spaces). Saved in Stats (nm). Every reply has runName.
//   buy with item = a studio id (g_ gear, tt_ tattoo, tn_ taunt; Config.gs game.studio) buys it; every reply has studio: { id: { n, k, coins, lv, own, can } }
// =====================================================================
var RUN = {
  HEAD: ['Client ID', 'Name', 'Best score', 'Best m', 'Coins', 'Runs', 'Total m', 'Day', 'Day best', 'Week', 'Week best', 'Upgrades', 'Missions', 'Badges', 'Last run', 'Earned total', 'Updated', 'Cash (cents)', 'Cash earned (cents)', 'XP', 'Owned', 'Stats'],   // V = Stats (Oct 25): totals for the badge ladders, JSON
  // costs and Wellbe Credit rules come from the settings (Config.gs: game)
  get UP_COST() { return cfg_().game.upCost; },
  get LIFE_COST() { return cfg_().game.lifeCost; }, get LIFE_MAX() { return cfg_().game.lifeMax; },   // extra life: start a run with 2 lives
  get CASH() { return cfg_().game.cash; },
  get OUTFITS() { return cfg_().game.outfits || {}; }, get STUDIO() { return cfg_().game.studio || {}; }, get EARLY_HOUR() { return cfg_().game.earlyHour; }, get EARLY_MIN_M() { return cfg_().game.earlyMinM; },
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
  CITY_M: 1750,   // metres per city (GAME.cityM in run.html)
  // the badges before Oct 25. Old ids stay in the Badges cell and each one maps to a tier of a ladder, so nobody loses a badge.
  OLD: { first: 'First run', km1: '1 km in one run', km5: '5 km in one run', km10: '10 km in one run', runs10: '10 runs', runs50: '50 runs', runs100: '100 runs',
    day1: '#1 of the day', week1: '#1 of the week', week10: 'Top 10 of the week', all3: 'All time top 3', all1: 'All time #1', rich: '10,000 coins earned', boost: 'Trained and ran the same day' },
  OLD_MAP: { first: 'play1', km1: 'dist2', km5: 'dist4', km10: 'dist5', runs10: 'play2', runs50: 'play3', runs100: 'play4', rich: 'coin2', boost: 'train1',
    week10: 'lb1', day1: 'lb2', week1: 'lb3', all3: 'lb4', all1: 'lb5' },
  TIERS: ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'],
  // 12 ladders x 5 tiers = 60 badges. Badge id = ladder key + tier number (dist1 ... dist5).
  // u: how the numbers show ('km' is stored in m). The lb tiers are leaderboard moments, not numbers.
  // Stats column keys: j jumps, s slides, cb best clean m, mi missions done, w WELLBE words, td training days
  LADDERS: [
    { k: 'dist', t: 'Distance', d: 'in one run', u: 'm', need: [500, 1000, 2500, 5000, 10000] },
    { k: 'tkm', t: 'Total distance', d: 'in all your runs', u: 'km', need: [5000, 25000, 100000, 250000, 500000] },
    { k: 'play', t: 'Runs played', u: 'runs', need: [1, 10, 50, 100, 250] },
    { k: 'coin', t: 'Coins earned', d: 'in total', u: 'coins', need: [2000, 10000, 50000, 150000, 500000] },
    { k: 'jump', t: 'Jumps', d: 'in total', u: 'jumps', need: [100, 500, 2000, 5000, 15000] },
    { k: 'slide', t: 'Slides', d: 'in total', u: 'slides', need: [100, 500, 2000, 5000, 15000] },
    { k: 'clean', t: 'Clean run', d: 'without tripping', u: 'm', need: [300, 600, 1200, 2500, 5000] },
    { k: 'miss', t: 'Missions', d: 'done in total', u: 'missions', need: [3, 15, 50, 150, 400] },
    { k: 'word', t: 'WELLBE words', d: 'completed', u: 'words', need: [1, 3, 10, 25, 50] },
    { k: 'city', t: 'Cities', d: 'in one run', u: 'cities', need: [2, 3, 4, 6, 8] },
    { k: 'train', t: 'Training days', d: 'trained at Wellbe and ran', u: 'days', need: [1, 5, 15, 40, 100] },
    { k: 'lb', t: 'Leaderboard', u: '', ev: ['Top 10 of the week', '#1 of the day', '#1 of the week', 'All time top 3', 'All time #1'] }
  ]
};

function clRun_(b, cid) {
  var ops = SpreadsheetApp.openById(CFG.OPS_ID), tz = CFG.TZ, now = new Date(), today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var week = runWeek_(today), sh = appTab_(ops, 'CORNICHE RUN', RUN.HEAD), n = sh.getLastRow();
  if (String(sh.getRange(1, 18).getValue()) !== RUN.HEAD[17] || String(sh.getRange(1, 20).getValue()) !== 'XP') roGuard_();
  if (String(sh.getRange(1, 18).getValue()) !== RUN.HEAD[17]) sh.getRange(1, 18, 1, 2).setValues([[RUN.HEAD[17], RUN.HEAD[18]]]).setFontWeight('bold').setBackground('#1f2a2e').setFontColor('#ffffff');
  if (String(sh.getRange(1, 20).getValue()) !== 'XP') sh.getRange(1, 20, 1, 2).setValues([['XP', 'Owned']]).setFontWeight('bold').setBackground('#1f2a2e').setFontColor('#ffffff');
  if (sh.getMaxColumns() < RUN.HEAD.length || String(sh.getRange(1, 22).getValue()) !== RUN.HEAD[21]) {   // the Stats column (V), added once
    roGuard_(); if (sh.getMaxColumns() < RUN.HEAD.length) sh.insertColumnsAfter(sh.getMaxColumns(), RUN.HEAD.length - sh.getMaxColumns());
    sh.getRange(1, 22).setValue(RUN.HEAD[21]).setFontWeight('bold').setBackground('#1f2a2e').setFontColor('#ffffff');
  }
  var opIn = String(b.op || 'get'), v, at = -1, src = null;
  if (opIn === 'get' && n > 1) src = runLbSrc_();
  if (src) {
    // opening the game screen: read the player's own row, take everybody else from the cached leaderboard rows
    var idc = sh.getRange(2, 1, n - 1, 1).getValues();
    for (var i0 = 0; i0 < idc.length; i0++) if (String(idc[i0][0]).toUpperCase() === cid) { at = i0; break; }
    v = src.map(runLbRow_);
    var mine = at < 0 ? null : sh.getRange(at + 2, 1, 1, RUN.HEAD.length).getValues()[0];
    var vi = -1; for (var i1 = 0; i1 < v.length; i1++) if (String(v[i1][0]).toUpperCase() === cid) { vi = i1; break; }
    if (mine) { if (vi < 0) { vi = v.length; v.push(mine); } else v[vi] = mine; } else if (vi > -1) { v.splice(vi, 1); vi = -1; }
    var atRow = at; at = vi;   // from here on, at is the index in v (same as before); atRow is the sheet row index
  } else {
    v = n > 1 ? sh.getRange(2, 1, n - 1, RUN.HEAD.length).getValues() : [];
    for (var i = 0; i < v.length; i++) if (String(v[i][0]).toUpperCase() === cid) { at = i; break; }
    var atRow = at;
    if (opIn === 'get') runLbPut_(v);
  }
  var rec = at < 0 ? [cid, runName_(cid), 0, 0, 0, 0, 0, '', 0, '', 0, '{}', '{}', '[]', '', 0, '', 0, 0, 0, '{}', '{}'] : v[at].slice();
  while (rec.length < RUN.HEAD.length) rec.push('');   // rows from before the Stats column
  rec[17] = Number(rec[17]) || 0; rec[18] = Number(rec[18]) || 0; rec[19] = Number(rec[19]) || 0; var owned = lvMigrate_(runJ_(rec[20], {}), runJ_(rec[11], {}));
  var up = runJ_(rec[11], {}), ms = runJ_(rec[12], {}), badges = runJ_(rec[13], []), st = runJ_(rec[21], {});
  if (!Array.isArray(badges)) badges = [];
  if (!st || typeof st !== 'object' || Array.isArray(st)) st = {};
  if (ms.d !== today) ms = { d: today, st: {}, done: [], bonus: 0 };
  var dk = 'D' + today, wk = 'W' + week;   // text keys so Sheets never turns them into dates
  if (String(rec[7]) !== dk) { rec[7] = dk; rec[8] = 0; }
  if (String(rec[9]) !== wk) { rec[9] = wk; rec[10] = 0; }
  if (at < 0) roGuard_();   // first game for this player: a new row, so straight to the locked path
  var op = String(b.op || 'get'), out = { newBadges: [], mdone: [] }, changed = at < 0, boost = runBoost_(ops, cid, today);

  if (op === 'save') {
    var r = b.run || {}, secs = Math.max(0, Number(r.secs) || 0), m = Math.max(0, Math.round(Number(r.m) || 0)),
      coins = Math.max(0, Math.round(Number(r.coins) || 0)), score = Math.max(0, Math.round(Number(r.score) || 0)), spent = Math.max(0, Math.round(Number(r.spent) || 0));
    var tk = r.ev || {}, head = tk.t1500 ? 1500 : 0, ran = Math.max(0, m - head);   // meters actually run: a head start never counts for Cash or XP
    if (tk.t1500 && !(Number(owned.t1500) > 0)) throw new Error('No start at 1,500 m ticket left.');
    if (tk.t500 && !(Number(owned.t500) > 0)) throw new Error('No 500 coin run ticket left.');
    var last = runLastT_(rec[14]);
    if (secs < 3 || secs > 3600) throw new Error('That run is not possible.');
    if (ran > secs * 19.5 + 30 || coins > ran * 0.6 * (tk.t500 ? 2 : 1) + 80 || score > m * 5 + coins * 5 + 50) throw new Error('That run is not possible.');
    if (last && now.getTime() - last < secs * 700) throw new Error('Slow down, one run at a time.');
    var ev = r.ev || {}, cap = function (k, max) { return Math.max(0, Math.min(Math.round(Number(ev[k]) || 0), max)); };
    var got = { coins: coins, m: m, score: score, jumps: cap('jumps', secs * 3), slides: cap('slides', secs * 3), roof: cap('roof', m), runs: 1, powers: cap('powers', Math.floor(m / 40) + 2), clean: cap('clean', m), mult: cap('mult', 5) };
    var earned = coins * (boost ? 2 : 1), bd = { picked: coins, boost: boost ? coins : 0, missions: 0, allBonus: 0, wellbe: 0, total: 0 };
    var had = runBadgeSet_(badges, rec, st);   // badges already earned before this run (old ids, and totals from before): no "New badge" line for them
    st.j = (Number(st.j) || 0) + got.jumps; st.s = (Number(st.s) || 0) + got.slides; st.cb = Math.max(Number(st.cb) || 0, got.clean);
    // daily missions
    runToday_(today).forEach(function (mi) {
      var cur = Number(ms.st[mi.k]) || 0;
      ms.st[mi.k] = mi.m === 'sum' ? cur + got[mi.s] : Math.max(cur, got[mi.s]);
      if (ms.done.indexOf(mi.k) < 0 && ms.st[mi.k] >= mi.n) { ms.done.push(mi.k); earned += mi.r; bd.missions += mi.r; st.mi = (Number(st.mi) || 0) + 1; out.mdone.push({ t: mi.t, r: mi.r }); }
    });
    if (ms.done.length >= 3 && !ms.bonus) { ms.bonus = 1; earned += RUN.ALL_BONUS; bd.allBonus = RUN.ALL_BONUS; out.mdone.push({ t: 'All 3 missions done', r: RUN.ALL_BONUS }); }
    var lt = Math.max(0, Math.min(Math.round(Number(ev.letters) || 0), m >= 800 ? 2 : m >= 350 ? 1 : 0));
    if (lt) { ms.wl = Math.min(7, (Number(ms.wl) || 0) + lt); if (ms.wl >= 7 && !ms.wb) { ms.wb = 1; earned += 1000; bd.wellbe = 1000; st.w = (Number(st.w) || 0) + 1; out.mdone.push({ t: 'WELLBE complete', r: 1000 }); } }
    // Wellbe Credit: $0.10 for a run that passes 2,000 m (once per run), max $0.50 a day
    out.cashEarned = 0;
    if (ran >= RUN.CASH.MIN_M) {   // every player earns Wellbe Credit (clients and guests)
      var ce = Math.max(0, Math.min(RUN.CASH.CENTS, RUN.CASH.DAY_MAX - (Number(ms.cash) || 0)));
      ms.cash = (Number(ms.cash) || 0) + ce; rec[17] += ce; rec[18] += ce; out.cashEarned = ce;
    }
    // levels: XP for meters run, missions, and training at the center today (once a day)
    var xpg = Math.floor(ran * LV.XP.PER_M) + out.mdone.length * LV.XP.MISSION;
    if (!ms.trx && lvTrainedToday_(ops, cid, today)) { ms.trx = 1; xpg += LV.XP.TRAINED; out.trainedXp = LV.XP.TRAINED; st.td = (Number(st.td) || 0) + 1; }   // a training day: trained at the center today and ran
    if (tk.t1500) owned.t1500 = Number(owned.t1500) - 1;
    if (tk.t500) owned.t500 = Number(owned.t500) - 1;
    out.xpGain = xpg; out.levelUps = lvAdd_(rec, owned, xpg);
    if (ev.lifeUsed && (Number(up.life) || 0) > 0) up.life = Math.max(0, Number(up.life) - Math.min(Math.round(Number(ev.lifeUsed) || 1), lvHas_(owned, lvOf_(rec[19]).level, 'life2') ? 2 : 1));   // 2nd life slot: up to 2 extra lives in one run
    rec[4] = Math.max(0, (Number(rec[4]) || 0) + earned - spent);
    rec[15] = (Number(rec[15]) || 0) + earned;
    rec[5] = (Number(rec[5]) || 0) + 1; rec[6] = (Number(rec[6]) || 0) + m;
    out.record = score > (Number(rec[2]) || 0);
    if (out.record) rec[2] = score;
    rec[3] = Math.max(Number(rec[3]) || 0, m);
    rec[8] = Math.max(Number(rec[8]) || 0, score); rec[10] = Math.max(Number(rec[10]) || 0, score);
    rec[14] = 'T' + now.getTime() + runCause_(ev, m); out.earned = earned; out.boosted = boost;   // Last run: time, then what ended the run (JSON) to check reports
    bd.total = earned; out.breakdown = bd;   // picked + boost + missions + allBonus + wellbe = earned
    out._had = had;
    // 5:30 AM Club: runs of at least earlyMinM that started before earlyHour (Beirut time)
    if (ran >= RUN.EARLY_MIN_M) { var hm0 = Utilities.formatDate(new Date(now.getTime() - secs * 1000), tz, 'HH:mm'); if (Number(hm0.slice(0, 2)) < RUN.EARLY_HOUR) st.am = (Number(st.am) || 0) + 1; }
    out._badgeAdd = true; changed = true;
  }
  if (op === 'shop') { out.bought = lvBuy_(rec, owned, String(b.item || '')); changed = true; }
  if (op === 'buy') {
    var item = String(b.item || '');
    if (Object.prototype.hasOwnProperty.call(RUN.OUTFITS, item)) { out.bought = runBuyOutfit_(item, rec, owned, st, cid); changed = true; }
    else if (Object.prototype.hasOwnProperty.call(RUN.STUDIO, item)) { out.bought = runBuyStudio_(item, rec, owned); changed = true; }
    else if (item === 'life') {
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
  // runner name: the phone sends name on get (the app only passes get, save and buy) or op name
  if ((op === 'get' || op === 'name') && b.name !== undefined && b.name !== null) {
    var nm = runNameCheck_(b.name);
    if (nm !== (st.nm || '')) { if (nm) st.nm = nm; else delete st.nm; changed = true; }
  }
  // leaderboard privacy: the phone sends lbHide on get or save
  if ((op === 'get' || op === 'save') && b.lbHide !== undefined && b.lbHide !== null) {
    var hide = b.lbHide === true || b.lbHide === 1 || b.lbHide === '1' || b.lbHide === 'true';
    if (!!owned.lbHide !== hide) { owned.lbHide = hide; changed = true; }
  }
  var pend = runCashPending_(ops, cid);
  if (op === 'redeem') {
    if (pend) throw new Error('You already have $' + (pend / 100).toFixed(2) + ' waiting for your next renewal.');
    var amt = Math.min(rec[17], RUN.CASH.REDEEM_MAX);
    if (amt < RUN.CASH.REDEEM_MIN) throw new Error('You need at least $' + (RUN.CASH.REDEEM_MIN / 100).toFixed(2) + ' Wellbe Credit.');
    rec[17] -= amt; pend = amt;
    clLog_(ops, cid, rec[1], 'Game cash', rec[1] + ' used $' + (amt / 100).toFixed(2) + ' Wellbe Credit (Corniche Run): take it off their first or next package, or an online workout (max $20 at a time).', '', '', 'New', { cents: amt });
    out.redeemed = amt; changed = true;
  }

  rec[11] = JSON.stringify(up); rec[12] = JSON.stringify(ms); rec[20] = JSON.stringify(owned); rec[21] = JSON.stringify(st); rec[16] = Utilities.formatDate(now, tz, 'dd/MM/yyyy HH:mm');
  if (at < 0) v.push(rec); else v[at] = rec;
  var boards = runBoards_(v, cid, dk, wk);
  var bset = runBadgeSet_(badges, rec, st);
  if (out._badgeAdd) {
    var T = boards.lists.totals, lb = function (n) { bset['lb' + n] = 1; };   // rank badges only count once enough people are playing
    if (boards.rank.week && boards.rank.week <= 10 && T.week >= 12) lb(1); if (boards.rank.day === 1 && T.day >= 3) lb(2); if (boards.rank.week === 1 && T.week >= 5) lb(3);
    if (boards.rank.all && boards.rank.all <= 3 && T.all >= 10) lb(4); if (boards.rank.all === 1 && T.all >= 10) lb(5);
    runLadderOrder_().forEach(function (id) { if (bset[id] && !out._had[id]) out.newBadges.push(runBadgeName_(id)); });
    badges = badges.filter(function (id) { return RUN.OLD[id]; }).concat(runLadderOrder_().filter(function (id) { return bset[id]; }));   // old ids stay, so an older phone still shows them
    delete out._badgeAdd; delete out._had;
  }
  rec[13] = JSON.stringify(badges);
  if (changed) {
    roGuard_();
    if (atRow < 0) sh.appendRow(rec); else sh.getRange(atRow + 2, 1, 1, rec.length).setValues([rec]);
    SpreadsheetApp.flush(); runLbBump_();   // leaderboards changed (flush first so the next reader sees the saved run)
  }
  out.coins = Number(rec[4]) || 0; out.best = Number(rec[2]) || 0; out.bestM = Number(rec[3]) || 0; out.runs = Number(rec[5]) || 0;
  out.up = { magnet: up.magnet || 0, jet: up.jet || 0, shoes: up.shoes || 0, life: up.life || 0 }; out.upCost = RUN.UP_COST; out.lifeCost = RUN.LIFE_COST; out.lifeMax = RUN.LIFE_MAX;
  out.cash = { bal: rec[17], total: rec[18], today: Number(ms.cash) || 0, minM: RUN.CASH.MIN_M, cents: RUN.CASH.CENTS, dayMax: RUN.CASH.DAY_MAX,
    min: RUN.CASH.REDEEM_MIN, max: RUN.CASH.REDEEM_MAX, trained: true, pending: pend || 0 };
  out.missions = runToday_(today).map(function (mi) { return { k: mi.k, t: mi.t, n: mi.n, p: Math.min(mi.n, Number(ms.st[mi.k]) || 0), done: ms.done.indexOf(mi.k) >= 0, r: mi.r, s: mi.s, m: mi.m }; });
  out.allBonus = RUN.ALL_BONUS; out.bonusDone = !!ms.bonus; out.word = Number(ms.wl) || 0; out.wordBonus = 1000;
  // badges: the old list with old ids (for phones that still have the older app) · ladders: the 12 ladders with progress (new app)
  out.badges = Object.keys(RUN.OLD).filter(function (id) { return badges.indexOf(id) > -1 || bset[RUN.OLD_MAP[id]]; }).map(function (id) { return { id: id, t: RUN.OLD[id] }; });
  out.ladders = runLadders_(bset, rec, st); out.badgeCount = { have: Object.keys(bset).length, all: RUN.LADDERS.length * 5 };
  out.boost = boost; out.boards = boards.lists; out.rank = boards.rank; out.lv = lvOut_(rec, owned); out.lbHide = !!owned.lbHide;
  out.outfits = runOutfits_(rec, owned, st, cid);
  out.studio = runStudio_(rec, owned); out.runName = st.nm || runFirst_(rec[1]); out.runNameSet = !!st.nm;
  return out;
}

function runJ_(s, d) { return nutJ_(s, d); }   // safe JSON read (Nutrition.gs)

// ---------- RUNNER OUTFITS ----------
// Bought outfits are saved in Owned as of_<id> (prestige ones as their shop item o1/o2/o3). Earned ones are worked out every time.
// rule: free | coins | staff (coins, or free for staff) | physio (coins, or free after a physio booking) | early (runs before earlyHour) | km (total km) | level (prestige: level, then coins)
function runOutfit_(id, rec, owned, st, cid, who) {
  var o = RUN.OUTFITS[id] || {}, lv = lvOf_(rec[19]).level, r = { id: id, n: o.n, own: false, rule: 'coins', coins: Number(o.coins) || 0, lv: 0, can: false };
  if (o.shop) {
    var s = LV.SHOP[o.shop] || {}; r.rule = 'level'; r.coins = Number(s.coins) || 0; r.lv = Number(s.lv) || 0;
    r.own = Number(owned[o.shop] || 0) > 0; r.can = !r.own && lv >= r.lv; return r;
  }
  if (o.free) { r.rule = 'free'; r.coins = 0; r.own = true; return r; }
  if (o.early) { r.rule = 'early'; r.coins = 0; r.need = Number(o.early); r.have = Number(st.am) || 0; r.hour = RUN.EARLY_HOUR; r.own = r.have >= r.need; return r; }
  if (o.km) { r.rule = 'km'; r.coins = 0; r.need = Number(o.km) * 1000; r.have = Number(rec[6]) || 0; r.own = r.have >= r.need; return r; }
  if (Number(owned['of_' + id] || 0) > 0) { r.own = true; r.got = 'Bought'; }
  if (o.staff) { r.rule = 'staff'; if (!r.own && who().staff) { r.own = true; r.got = 'Free for staff'; } }
  if (o.physio) { r.rule = 'physio'; if (!r.own && who().physio) { r.own = true; r.got = 'Free with your physio booking'; } }
  r.can = !r.own && r.coins > 0;
  return r;
}
function runOutfits_(rec, owned, st, cid) {
  var w = null, who = function () { return w || (w = runWho_(cid)); };
  return Object.keys(RUN.OUTFITS).map(function (id) { return runOutfit_(id, rec, owned, st, cid, who); });
}
function runBuyOutfit_(id, rec, owned, st, cid) {
  var r = runOutfit_(id, rec, owned, st, cid, function () { return runWho_(cid); });
  if (r.own) throw new Error('You already have ' + r.n);
  if (r.rule === 'early') throw new Error(r.n + ' unlocks after ' + r.need + ' runs started before ' + RUN.EARLY_HOUR + ' am');
  if (r.rule === 'km') throw new Error(r.n + ' unlocks when you have run ' + (r.need / 1000) + ' km in total');
  if (r.rule === 'level' && lvOf_(rec[19]).level < r.lv) throw new Error('Reach level ' + r.lv + ' to buy ' + r.n);
  if (!(r.coins > 0)) throw new Error(r.n + ' is not for sale');
  if ((Number(rec[4]) || 0) < r.coins) throw new Error('Not enough coins');
  rec[4] = Number(rec[4]) - r.coins;
  if (r.rule === 'level') owned[RUN.OUTFITS[id].shop] = 1; else owned['of_' + id] = 1;
  return r.n;
}
// is this player Wellbe staff (Coach Kit free) and did they book physio (Rehab Hero free). Cached 3 hours.
function runWho_(cid) {
  var cache = CacheService.getScriptCache(), key = 'runwho|' + cid, c = cache.get(key);
  if (c) { try { return JSON.parse(c); } catch (e) {} }
  var out = { staff: false, physio: false };
  try {
    var g = cfg_().game; if ((g.staffClients || []).map(function (x) { return String(x).trim().toUpperCase(); }).indexOf(cid) > -1) out.staff = true;
    if (!out.staff && !/^G\d+$/.test(cid) && typeof cfgStaff_ === 'function') {
      // phone: digits without the 961 country code and the leading 0, so +961 3 123 456 and 03 123 456 are the same number
      var pn = function (x) { return String(x || '').replace(/\D/g, '').replace(/^00/, '').replace(/^961/, '').replace(/^0+/, ''); };
      var me = appClientInfo_(cid) || {}, em = String(me.email || '').trim().toLowerCase(), ph = pn(me.phone);
      cfgStaff_().forEach(function (s) {
        if ((em && String(s.email || '').trim().toLowerCase() === em) || (ph.length >= 7 && pn(s.phone) === ph)) out.staff = true;
      });
    }
    if (!/^G\d+$/.test(cid) && typeof pkgsAll_ === 'function') {
      var ops = SpreadsheetApp.openById(CFG.OPS_ID);
      pkgsAll_(ops).forEach(function (x) { if (x.cid === cid && /physio|prehab|assessment/i.test(x.type)) out.physio = true; });
    }
  } catch (e) { Logger.log('runWho_ ' + cid + ': ' + e); }
  cache.put(key, JSON.stringify(out), 10800);
  return out;
}
// ---------- BADGE LADDERS ----------
// the number a ladder counts, from the row and the Stats column
function runLadderVal_(L, rec, st) {
  var bm = Number(rec[3]) || 0;
  return { dist: bm, tkm: Number(rec[6]) || 0, play: Number(rec[5]) || 0, coin: Number(rec[15]) || 0, jump: Number(st.j) || 0, slide: Number(st.s) || 0,
    clean: Number(st.cb) || 0, miss: Number(st.mi) || 0, word: Number(st.w) || 0, city: bm > 0 ? Math.floor(bm / RUN.CITY_M) + 1 : 0, train: Number(st.td) || 0 }[L.k] || 0;
}
// every badge id earned: saved ids, old ids mapped to their tier, and tiers the totals already reach (a higher tier fills the lower ones)
function runBadgeSet_(badges, rec, st) {
  var set = {};
  (badges || []).forEach(function (id) { id = String(id); if (RUN.OLD_MAP[id]) set[RUN.OLD_MAP[id]] = 1; else if (/^[a-z]+[1-5]$/.test(id)) set[id] = 1; });
  RUN.LADDERS.forEach(function (L) {
    if (!L.need) return;
    var v = runLadderVal_(L, rec, st), top = 0;
    for (var i = 0; i < 5; i++) if (v >= L.need[i] || set[L.k + (i + 1)]) top = i + 1;
    for (var j = 1; j <= top; j++) set[L.k + j] = 1;
  });
  return set;
}
function runLadderOrder_() { var o = []; RUN.LADDERS.forEach(function (L) { for (var i = 1; i <= 5; i++) o.push(L.k + i); }); return o; }
function runNum_(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function runKm_(n) { var k = n / 1000; return k >= 100 || k === Math.floor(k) ? runNum_(Math.floor(k)) : (Math.floor(k * 10) / 10).toFixed(1); }
function runAmt_(L, n) { return L.u === 'km' ? runKm_(n) + ' km' : runNum_(n) + ' ' + (n === 1 ? L.u.replace(/s$/, '') : L.u); }   // 2,500 m · 5 km · 40 jumps
function runTierText_(L, i) { return L.ev ? L.ev[i] : runAmt_(L, L.need[i]) + (L.d ? ' ' + L.d : ''); }
function runBadgeName_(id) {
  var k = id.slice(0, -1), i = Number(id.slice(-1)) - 1, L = RUN.LADDERS.filter(function (x) { return x.k === k; })[0];
  return L ? L.t + ' ' + RUN.TIERS[i] + ': ' + runTierText_(L, i) : id;
}
// [{ ladder, title, tier (how many of 5), have (the number now), tiers: [{ n, t, on }], next: { need, label } or null at the top }]
function runLadders_(set, rec, st) {
  return RUN.LADDERS.map(function (L) {
    var tiers = [], n = 0, nx = -1;
    for (var i = 0; i < 5; i++) { var on = !!set[L.k + (i + 1)]; if (on) n++; else if (nx < 0) nx = i; tiers.push({ n: RUN.TIERS[i], t: runTierText_(L, i), on: on }); }
    var have = L.ev ? n : runLadderVal_(L, rec, st), next = null;
    if (nx > -1) {
      if (L.ev) next = { need: 1, label: 'Next: ' + L.ev[nx] };
      else { var h = Math.min(have, L.need[nx]); next = { need: L.need[nx], label: (L.u === 'km' ? runKm_(h) : runNum_(h)) + ' of ' + runAmt_(L, L.need[nx]) }; }
    }
    return { ladder: L.k, title: L.t, tier: n, have: have, tiers: tiers, next: next };
  });
}
// the Last run cell: 'T' + time, then a space and what ended the run as JSON (older cells are just 'T' + time)
function runLastT_(cell) { var m = /^T(\d+)/.exec(String(cell || '')); return m ? Number(m[1]) : 0; }
function runCause_(ev, m) {
  if (!ev || !ev.cause) return '';
  var w = function (x, n) { return String(x == null ? '' : x).replace(/[\u0000-\u001f]/g, '').slice(0, n); }, id = function (x) { return w(x, 24).replace(/[^A-Za-z0-9_]/g, ''); };
  var o = { cause: id(ev.cause), text: w(ev.causeText, 90), lane: Math.max(0, Math.min(3, Math.round(Number(ev.lane) || 0))), m: Math.max(0, Math.round(Number(ev.atM) || m || 0)), hits: [] };
  if (Array.isArray(ev.hits)) ev.hits.slice(-5).forEach(function (h) { if (h) o.hits.push({ k: id(h.k), m: Math.max(0, Math.round(Number(h.m) || 0)) }); });
  return ' ' + JSON.stringify(o);
}

// LEADERBOARD ROWS in the cache (1 minute): opening the game screen no longer reads every player's full row.
// Any write to CORNICHE RUN changes the version, so the next screen reads fresh rows.
function runLbVer_() { return verGet_(['run']).run; }
function runLbBump_() { verBump_(['run']); }
function runLbSrc_() { return cacheGetBig_('runlb|' + runLbVer_()); }
function runLbPut_(v) {   // only what runBoards_ uses: ID, name, best score, day key + best, week key + best, hidden
  cachePutBig_('runlb|' + runLbVer_(), v.filter(function (r) { return r[0]; }).map(function (r) {
    return [String(r[0]), r[1], r[2], r[7], r[8], r[9], r[10], runJ_(r[20], {}).lbHide ? 1 : 0, runJ_(r[21], {}).nm || ''];
  }), 60);
}
function runLbRow_(x) {
  var r = new Array(RUN.HEAD.length); for (var i = 0; i < r.length; i++) r[i] = '';
  r[0] = x[0]; r[1] = x[1]; r[2] = x[2]; r[7] = x[3]; r[8] = x[4]; r[9] = x[5]; r[10] = x[6]; r[20] = x[7] ? '{"lbHide":true}' : '{}'; r[21] = x[8] ? JSON.stringify({ nm: x[8] }) : '{}';
  return r;
}
// ---------- RUNNER NAME and STUDIO ITEMS ----------
// the name on the leaderboards: the chosen runner name, else "First L."
function runLbName_(r) { var st = runJ_(r[21], {}); return st && typeof st === 'object' && st.nm ? String(st.nm) : runShort_(r[1]); }
function runFirst_(name) { var p = String(name || '').trim().split(/\s+/)[0] || 'Runner'; return p.length > 14 ? p.slice(0, 14) : p; }
// words a runner name cannot hold (English, Lebanese Arabic in Latin letters and Arabic script). Whole words for short ones, anywhere for long ones.
// (short ones that sit inside real names, like nazi in Nazih, ahbe in Wahbe, نيك in نيكول, خول in خولة, زب in زبيدة, are whole words only)
RUN.BAD_ANY = ['fuck', 'shit', 'bitch', 'cunt', 'nigg', 'whore', 'slut', 'porn', 'hitler', 'pussy', 'penis', 'vagina', 'dildo', 'wank', 'bastard', 'asshole',
  'sharmo', 'sharmu', 'charmo', 'charmu', 'manyak', 'manyouk', 'mnayak', 'metnak', 'mitnak', 'qahba', 'a7be', 'a7ba', 'kahba', 'khawal', 'ayreh', '3ayr', 'zebbak', 'kesak', 'kossak', 'kosomak', 'kosom', 'teezak', 'tizak',
  'شرموط', 'منيك', 'متناك', 'قحب', 'كسمك', 'كسختك'];
RUN.BAD_WORD = ['ass', 'dick', 'cock', 'sex', 'fag', 'kos', 'kus', 'koss', 'kuss', 'kes', 'zeb', 'zib', 'zebb', 'ayr', 'ayre', 'ayri', 'air', 'teez', 'tiz', 'khara', '5ara', 'a7a', 'ahh', 'kalb', 'hmar', 'fuk', 'rape', 'nazi', 'ahbe', 'كس', 'زب', 'زبي', 'عير', 'طيز', 'خول', 'خرا', 'نيك', 'كلب', 'حمار'];
// a clean runner name, '' to go back to the first name, or an error the phone shows
function runNameCheck_(raw) {
  var s = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u200b-\u200f\u202a-\u202e]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length < 2 || s.length > 14) throw new Error('Pick a name of 2 to 14 characters.');
  if (!/^[A-Za-z0-9\u00C0-\u024F\u0621-\u064A\u0660-\u0669 ]+$/.test(s)) throw new Error('Use letters, numbers and spaces only.');
  if (runNameBad_(s)) throw new Error('Pick another name, that one is not allowed.');
  return s;
}
function runNameBad_(s) {
  var low = String(s).toLowerCase(), flat = low.replace(/[^a-z0-9\u0621-\u064a]/g, '').replace(/0/g, 'o').replace(/1/g, 'i').replace(/4/g, 'a').replace(/\$/g, 's');
  var words = low.split(/[^a-z0-9\u0621-\u064a]+/).filter(function (w) { return w; });
  for (var i = 0; i < RUN.BAD_ANY.length; i++) { var w = RUN.BAD_ANY[i].trim(); if (flat.indexOf(w) > -1 || low.indexOf(w) > -1) return true; }
  for (var j = 0; j < words.length; j++) if (RUN.BAD_WORD.indexOf(words[j]) > -1 || RUN.BAD_WORD.indexOf(words[j].replace(/0/g, 'o').replace(/1/g, 'i')) > -1) return true;
  return false;
}
// gear, tattoos and taunts: all bought with coins (some open at a level first). Owned is the only record of what a player has.
function runStudio_(rec, owned) {
  var lv = lvOf_(rec[19]).level, S = RUN.STUDIO, out = {};
  Object.keys(S).forEach(function (id) {
    var o = S[id], coins = Number(o.coins) || 0, need = Number(o.lv) || 0, own = Number(owned[id] || 0) > 0;   // no free items, no grandfathering: only what Owned records
    out[id] = { n: o.n, k: o.k, coins: coins, lv: need, own: own, can: !own && coins > 0 && lv >= need };
  });
  return out;
}
function runBuyStudio_(id, rec, owned) {
  var r = runStudio_(rec, owned)[id];
  if (r.own) throw new Error('You already have ' + r.n);
  if (r.lv && lvOf_(rec[19]).level < r.lv) throw new Error('Reach level ' + r.lv + ' to buy ' + r.n);
  if (!(r.coins > 0)) throw new Error(r.n + ' is not for sale');
  if ((Number(rec[4]) || 0) < r.coins) throw new Error('Not enough coins');
  rec[4] = Number(rec[4]) - r.coins; owned[id] = 1;
  return r.n;
}
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
// trained at the center in the last 7 days. NOT called today: every player earns Wellbe Credit. Kept for if Credit becomes clients only.
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
// Wellbe Credit already sent to Romy and not handled yet (cents)
function runCashPending_(ops, cid) {
  var p = 0;
  appRows_(ops, 'CLIENT REQUESTS', 2, CL.REQ_HEAD.length).forEach(function (r) {
    if (String(r[2]).toUpperCase() === cid && String(r[4]) === 'Game cash' && String(r[8] || 'New') === 'New') { try { p += Number(JSON.parse(r[11] || '{}').cents) || 0; } catch (e) {} }
  });
  return p;
}
function runBoards_(v, cid, today, week) {
  var mk = function (col, keyCol, key) {
    // hidden players (Owned.lbHide) are left out, except the player themselves: they still see their own rank
    var rows = v.filter(function (r) { return r[0] && (Number(r[col]) || 0) > 0 && (keyCol < 0 || String(r[keyCol]) === key) && (String(r[0]).toUpperCase() === cid || !runJ_(r[20], {}).lbHide); })
      .sort(function (a, b) { return (Number(b[col]) || 0) - (Number(a[col]) || 0); });
    var rank = 0; rows.forEach(function (r, i) { if (String(r[0]).toUpperCase() === cid) rank = i + 1; });
    return { list: rows.slice(0, 10).map(function (r, i) { return { n: runLbName_(r), s: Number(r[col]) || 0, me: String(r[0]).toUpperCase() === cid, i: i + 1 }; }), rank: rank, total: rows.length };
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