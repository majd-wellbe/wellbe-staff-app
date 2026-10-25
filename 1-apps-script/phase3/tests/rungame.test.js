#!/usr/bin/env node
// Corniche Run server tests: RunGame.gs + Levels.gs + Config.gs in node, with in memory sheets.
// Run: node 1-apps-script/phase3/tests/rungame.test.js            (tests the files in phase3)
//      OLD=path/to/RunGame.gs node ...rungame.test.js             (also compares against an older RunGame.gs)
const fs = require('fs'), path = require('path'), vm = require('vm');
const DIR = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(c, msg, extra) { if (c) pass++; else { fail++; console.log('  FAIL: ' + msg + (extra !== undefined ? '\n        ' + JSON.stringify(extra).slice(0, 900) : '')); } }
const J = JSON.stringify;

// ---------- a tiny Apps Script world ----------
function makeWorld(runGamePath, opts) {
  opts = opts || {};
  const books = {}, cache = {};
  function Sheet(name) {
    this.name = name; this.rows = []; this.maxCols = 26;
  }
  Sheet.prototype.getLastRow = function () { return this.rows.length; };
  Sheet.prototype.getMaxColumns = function () { return this.maxCols; };
  Sheet.prototype.insertColumnsAfter = function (c, n) { this.maxCols += n; };
  Sheet.prototype.appendRow = function (r) { this.rows.push(r.slice()); return this; };
  Sheet.prototype.setFrozenRows = function () {};
  Sheet.prototype.getRange = function (r, c, nr, nc) {
    const sh = this; nr = nr || 1; nc = nc || 1;
    const rg = {
      getValues: () => { const out = []; for (let i = 0; i < nr; i++) { const row = sh.rows[r - 1 + i] || []; const o = []; for (let j = 0; j < nc; j++) { const v = row[c - 1 + j]; o.push(v === undefined ? '' : v); } out.push(o); } return out; },
      getValue: () => rg.getValues()[0][0],
      setValues: (vals) => { vals.forEach((vr, i) => { const ri = r - 1 + i; while (sh.rows.length <= ri) sh.rows.push([]); vr.forEach((v, j) => { sh.rows[ri][c - 1 + j] = v; }); }); return rg; },
      setValue: (v) => rg.setValues([[v]]),
      setFontWeight: () => rg, setBackground: () => rg, setFontColor: () => rg
    };
    return rg;
  };
  function Book() { this.tabs = {}; }
  Book.prototype.getSheetByName = function (n) { return this.tabs[n] || null; };
  Book.prototype.insertSheet = function (n) { return (this.tabs[n] = new Sheet(n)); };
  const ctx = {
    console, JSON, Math, Date, String, Number, Array, Object, Error, RegExp,
    Logger: { log: () => {} },
    SpreadsheetApp: { openById: (id) => books[id] || (books[id] = new Book()), flush: () => {} },
    CacheService: { getScriptCache: () => ({
      get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = String(v); }, remove: k => { delete cache[k]; },
      getAll: ks => { const o = {}; ks.forEach(k => { if (k in cache) o[k] = cache[k]; }); return o; }, putAll: o => { Object.assign(cache, o); } }) },
    Utilities: { formatDate: (d, tz, f) => {
      const p = n => String(n).padStart(2, '0'), y = d.getUTCFullYear(), mo = p(d.getUTCMonth() + 1), da = p(d.getUTCDate());
      if (f === 'yyyy-MM-dd') return y + '-' + mo + '-' + da; if (f === 'HH:mm') return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
      return da + '/' + mo + '/' + y + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) }
  };
  vm.createContext(ctx);
  const stubs = `
    var CFG = { OPS_ID: 'OPS', TZ: 'UTC' };
    var RO_ = false; function roGuard_() { if (RO_) { var e = new Error('needs the lock'); e.needLock = true; throw e; } }
    function appTab_(ss, name, head) { var sh = ss.getSheetByName(name); if (sh) return sh; roGuard_(); sh = ss.insertSheet(name); sh.getRange(1, 1, 1, head.length).setValues([head]); return sh; }
    function nutJ_(s, d) { try { var o = JSON.parse(s || ''); return o == null ? d : o; } catch (e) { return d; } }
    var VER = {}; function verGet_(n) { var o = {}; n.forEach(function (k) { o[k] = VER[k] || (VER[k] = '1'); }); return o; }
    function verBump_(n) { n.forEach(function (k) { VER[k] = String(Number(VER[k] || 0) + 1); }); }
    var BIG = {}; function cacheGetBig_(k) { return BIG[k] ? JSON.parse(BIG[k]) : null; } function cachePutBig_(k, o) { BIG[k] = JSON.stringify(o); }
    var CL = { REQ_HEAD: new Array(12) }; var LOGS = [];
    function appRows_() { return []; } function clPkgIds_() { return { P1: 1 }; }
    var TRAINED = ${opts.trained ? 'true' : 'false'};
    function appSessions_() { return TRAINED ? [{ status: 'Done', date: '2026-10-25', start: '08:00', clients: [{ pkg: 'P1', att: 'Present' }] }] : []; }
    function appShift_(ymd, n) { var d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
    function appClientInfo_(cid) { return { name: 'Test ' + cid }; }
    function clLog_() { LOGS.push([].slice.call(arguments)); }
    function cfgCopy_(o) { return JSON.parse(JSON.stringify(o)); } function cfgReadStaff_() { return []; } function cfgReadTypes_() { return []; } function cfgReadSettings_() {}
    function appBump_() {}
  `;
  vm.runInContext(stubs, ctx);
  const cfgSrc = fs.readFileSync(path.join(DIR, 'Config.gs'), 'utf8');
  // only CFG_DEFAULTS and cfg_ are needed from Config.gs
  const cfgDefaults = cfgSrc.slice(cfgSrc.indexOf('var CFG_DEFAULTS'), cfgSrc.indexOf('var CFG_KINDS'));
  vm.runInContext(cfgDefaults + '\nvar CFG_MEMO_ = null, CFG_CACHE_KEY_ = "cfg|v1";\n' + cfgSrc.slice(cfgSrc.indexOf('function cfg_()'), cfgSrc.indexOf('// after editing the STAFF')), ctx);
  vm.runInContext(fs.readFileSync(path.join(DIR, 'Levels.gs'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(runGamePath, 'utf8'), ctx);
  ctx.books = books; ctx.cache = cache;
  ctx.tab = () => books.OPS && books.OPS.tabs['CORNICHE RUN'];
  ctx.call = (b, cid) => { ctx.RO_ = false; try { return vm.runInContext('clRun_', ctx)(b, cid); } catch (e) { return { error: e.message }; } };
  ctx.setTrained = (v) => vm.runInContext('TRAINED = ' + (v ? 'true' : 'false'), ctx);
  return ctx;
}
// freeze time per test; each save needs time to pass (anti spam rule)
let NOW = Date.UTC(2026, 9, 25, 10, 0, 0);
const RealDate = Date;
function tick(ms) { NOW += ms; }
global.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } };

const NEW = path.join(DIR, 'RunGame.gs'), OLD = process.env.OLD;
function save(w, cid, run) { tick(3600 * 1000); return w.call({ op: 'save', run: run }, cid); }
const run1 = { secs: 160, m: 2600, coins: 300, score: 9000, spent: 0, ev: { jumps: 40, slides: 31, roof: 320, powers: 5, clean: 700, mult: 3, letters: 2 } };

// ---------- 1. a normal run: shape, breakdown, compatibility ----------
console.log('1. save: breakdown and compatible fields');
{
  const w = makeWorld(NEW), r = save(w, 'C001', run1);
  ok(!r.error, 'saved', r);
  const b = r.breakdown;
  ok(b && b.picked + b.boost + b.missions + b.allBonus + b.wellbe === r.earned, 'breakdown parts sum to earned', b);
  ok(b && b.total === r.earned, 'breakdown.total equals earned', [b, r.earned]);
  ok(typeof r.earned === 'number' && Array.isArray(r.mdone) && Array.isArray(r.newBadges) && Array.isArray(r.badges), 'old fields still there');
  ok(r.badges.some(x => x.id === 'first' && x.t === 'First run'), 'old badges list still has old ids for older phones', r.badges);
  ok(Array.isArray(r.ladders) && r.ladders.length === 12, '12 ladders returned', r.ladders && r.ladders.length);
  ok(r.badgeCount && r.badgeCount.all === 60, '60 badges in all', r.badgeCount);
  const row = w.tab().rows[1];
  ok(row.length === 22, 'row has 22 columns (Stats added at the end)', row.length);
  ok(w.tab().rows[0][21] === 'Stats' && w.tab().rows[0][20] === 'Owned', 'header V is Stats, U still Owned', w.tab().rows[0]);
  const st = JSON.parse(row[21]);
  ok(st.j === 40 && st.s === 31 && st.cb === 700, 'stats: jumps, slides, clean saved', st);
  ok(r.newBadges.indexOf('Runs played Bronze: 1 run') > -1, 'new badge line for the first run', r.newBadges);
  ok(r.newBadges.some(x => /^Distance Gold/.test(x)), 'Distance Gold (2,500 m) earned on a 2,600 m run', r.newBadges);
  ok(r.newBadges.some(x => /^Cities Bronze/.test(x)), 'Cities Bronze: 2,600 m reaches the 2nd city', r.newBadges);
}
// with boost (trained) and WELLBE complete
{
  const w = makeWorld(NEW, { trained: true });
  // fill the WELLBE word: 5 letters before, 2 now
  w.tab && 0;
  let r = save(w, 'C002', Object.assign({}, run1, { ev: Object.assign({}, run1.ev, { letters: 2 }) }));
  for (let i = 0; i < 2; i++) r = save(w, 'C002', Object.assign({}, run1, { ev: Object.assign({}, run1.ev, { letters: 2 }) }));
  for (let i = 0; i < 1; i++) r = save(w, 'C002', Object.assign({}, run1, { ev: Object.assign({}, run1.ev, { letters: 2 }) }));
  const b = r.breakdown;
  ok(r.boosted && b.boost === b.picked, 'boost part equals picked coins when boosted', b);
  ok(b.picked + b.boost + b.missions + b.allBonus + b.wellbe === r.earned && b.total === r.earned, 'boosted run: breakdown sums to earned', [b, r.earned]);
  const st = JSON.parse(w.tab().rows[1][21]);
  ok(st.w === 1, 'WELLBE word counted once', st);
  ok(st.td === 1, 'training day counted once a day', st);
  // every run of the day: sums still right
  ok(r.ladders.filter(l => l.ladder === 'train')[0].tier >= 1, 'Training days Bronze', r.ladders.filter(l => l.ladder === 'train')[0]);
}
// all runs through a day: every save's breakdown sums
{
  const w = makeWorld(NEW, { trained: true }); let all = true, seen = { missions: 0, allBonus: 0, wellbe: 0 };
  for (let i = 0; i < 6; i++) { const r = save(w, 'C003', Object.assign({}, run1, { ev: Object.assign({}, run1.ev, { letters: 2 }) })); const b = r.breakdown;
    if (!(b && b.picked + b.boost + b.missions + b.allBonus + b.wellbe === r.earned && b.total === r.earned)) all = false; Object.keys(seen).forEach(k => { seen[k] += b[k]; }); }
  ok(all, 'six runs: every breakdown sums to earned');
  ok(seen.wellbe === 1000, 'WELLBE 1,000 once a day', seen);
}

// ---------- 2. compare with the older RunGame.gs (same coins, record, XP, missions) ----------
if (OLD) {
  console.log('2. same numbers as the older server');
  ['C010', 'C011'].forEach((cid, k) => {
    const a = makeWorld(OLD, { trained: !!k }), b = makeWorld(NEW, { trained: !!k }); const n0 = NOW;
    let same = true, diffs = [];
    for (let i = 0; i < 5; i++) {
      NOW = n0 + i * 7200 * 1000; const ra = save(a, cid, run1); NOW = n0 + i * 7200 * 1000; const rb = save(b, cid, run1);
      ['earned', 'coins', 'best', 'bestM', 'runs', 'record', 'xpGain', 'cashEarned', 'boosted', 'mdone', 'levelUps', 'missions', 'cash', 'lv', 'up', 'rank'].forEach(f => { if (J(ra[f]) !== J(rb[f])) { same = false; diffs.push([f, ra[f], rb[f]]); } });
      const rowA = a.tab().rows[1], rowB = b.tab().rows[1];
      for (let c = 0; c < 21; c++) if (c !== 13 && c !== 14 && J(rowA[c]) !== J(rowB[c])) { same = false; diffs.push(['col' + c, rowA[c], rowB[c]]); }
    }
    ok(same, 'player ' + cid + ': coins, XP, missions, columns A:U (but badges and last run) match the old server', diffs.slice(0, 3));
  });
  // old rows (21 columns) work with the new server
  const a = makeWorld(OLD); save(a, 'C020', run1);
  const rows = a.tab().rows.map(r => r.slice());
  const b = makeWorld(NEW); b.SpreadsheetApp.openById('OPS'); const sh = b.books.OPS.insertSheet('CORNICHE RUN'); rows.forEach(r => sh.appendRow(r));
  const g = b.call({ op: 'get' }, 'C020');
  ok(!g.error && g.runs === 1 && g.ladders.length === 12, 'get on a 21 column row from the old server works', g.error);
}

// ---------- 3. badge migration ----------
console.log('3. old badges map into the ladders');
{
  const w = makeWorld(NEW); w.SpreadsheetApp.openById('OPS'); const sh = w.books.OPS.insertSheet('CORNICHE RUN');
  sh.appendRow(['Client ID', 'Name', 'Best score', 'Best m', 'Coins', 'Runs', 'Total m', 'Day', 'Day best', 'Week', 'Week best', 'Upgrades', 'Missions', 'Badges', 'Last run', 'Earned total', 'Updated', 'Cash (cents)', 'Cash earned (cents)', 'XP', 'Owned']);
  // a player from before: 21 columns, old badges, all1 and boost earned, Last run in the old format
  sh.appendRow(['C030', 'Old Player', 12000, 5200, 900, 12, 30000, 'D2026-10-20', 100, 'W2026-10-19', 100, '{"life":1}', '{}', '["first","km1","km5","runs10","rich","boost","all1","week10"]', 'T' + (NOW - 86400000), 11000, '', 0, 0, 500, '{}']);
  const g = w.call({ op: 'get' }, 'C030');
  ok(!g.error, 'get works on an old row', g.error);
  const L = {}; (g.ladders || []).forEach(l => { L[l.ladder] = l; });
  ok(L.play.tier === 2, 'first + runs10 -> Runs played Silver', L.play);
  ok(L.dist.tier === 4, 'km5 (and best 5,200 m) -> Distance Platinum', L.dist);
  ok(L.coin.tier === 2, 'rich (10,000 coins) -> Coins Silver', L.coin);
  ok(L.train.tier === 1, 'boost -> Training days Bronze', L.train);
  ok(L.lb.tier === 2 && L.lb.tiers[0].on && L.lb.tiers[4].on && !L.lb.tiers[1].on, 'all1 -> Leaderboard Diamond, week10 -> Bronze (leaderboard tiers are separate moments)', L.lb);
  ok(L.tkm.tier === 2, '30 km total -> Total distance Silver (from the row, no badge needed)', L.tkm);
  ok(g.badges.length === 8 && g.badges.every(b => b.t), 'old badges list unchanged for older phones', g.badges);
  // saving: no "New badge" lines for badges they already had; old ids kept in the cell
  tick(3600 * 1000);
  const r = w.call({ op: 'save', run: { secs: 60, m: 400, coins: 50, score: 600, spent: 0, ev: { jumps: 5, slides: 3 } } }, 'C030');
  ok(!r.error, 'save on an old row', r.error);
  ok(r.newBadges.length === 0, 'no "New badge" for tiers they already had', r.newBadges);
  const cell = JSON.parse(sh.rows[1][13]);
  ok(['first', 'km1', 'km5', 'runs10', 'rich', 'boost', 'all1', 'week10'].every(id => cell.indexOf(id) > -1), 'old ids kept in the Badges cell', cell);
  ok(cell.indexOf('lb5') > -1 && cell.indexOf('dist4') > -1, 'new ids saved too', cell);
  ok(sh.rows[1].length === 22 && sh.rows[0][21] === 'Stats', 'Stats column added at the end, A:U unchanged', sh.rows[0]);
  ok(sh.rows[1][20] === '{"_m":1}' || /_m/.test(sh.rows[1][20]), 'Owned (U) still in U', sh.rows[1][20]);
  ok(r.coins === 900 + 50 && r.up.life === 1, 'coins and lives unchanged by the migration', [r.coins, r.up]);
}

// ---------- 4. ladder awards and progress text ----------
console.log('4. ladder awards');
{
  const w = makeWorld(NEW);
  let r = save(w, 'C040', { secs: 40, m: 450, coins: 40, score: 600, spent: 0, ev: { jumps: 60, slides: 50, clean: 250 } });
  let L = {}; r.ladders.forEach(l => { L[l.ladder] = l; });
  ok(L.dist.tier === 0 && L.dist.next.label === '450 of 500 m', 'Distance progress text "450 of 500 m"', L.dist.next);
  ok(L.tkm.next.label === '0.4 of 5 km', 'Total distance "0.4 of 5 km"', L.tkm.next);
  ok(L.jump.tier === 0 && L.jump.next.label === '60 of 100 jumps', 'Jumps progress', L.jump.next);
  ok(L.lb.next && L.lb.next.label === 'Next: Top 10 of the week', 'Leaderboard next text', L.lb.next);
  ok(L.city.tier === 0 && L.city.next.label === '1 of 2 cities', 'Cities: still in the 1st city', L.city.next);
  r = save(w, 'C040', { secs: 40, m: 520, coins: 40, score: 600, spent: 0, ev: { jumps: 60, slides: 10, clean: 310 } });
  L = {}; r.ladders.forEach(l => { L[l.ladder] = l; });
  ok(L.dist.tier === 1 && r.newBadges.indexOf('Distance Bronze: 500 m in one run') > -1, 'Distance Bronze awarded once', r.newBadges);
  ok(L.jump.tier === 1 && r.newBadges.some(x => /^Jumps Bronze/.test(x)), 'Jumps Bronze from the running total (120)', L.jump);
  ok(L.clean.tier === 1, 'Clean run Bronze (310 m)', L.clean);
  ok(L.slide.tier === 0 && L.slide.have === 60, 'Slides total 60 (not yet)', L.slide);
  r = save(w, 'C040', { secs: 40, m: 300, coins: 10, score: 300, spent: 0, ev: {} });
  ok(r.newBadges.indexOf('Distance Bronze: 500 m in one run') < 0, 'no repeat "New badge"', r.newBadges);
  // missions total
  const w2 = makeWorld(NEW); let mi = 0;
  for (let i = 0; i < 3; i++) { const x = save(w2, 'C041', { secs: 300, m: 3000, coins: 400, score: 12000, spent: 0, ev: { jumps: 50, slides: 40, roof: 400, powers: 6, clean: 900, mult: 4 } }); mi += x.mdone.filter(m => m.t !== 'All 3 missions done' && m.t !== 'WELLBE complete').length; r = x; }
  const st = JSON.parse(w2.tab().rows[1][21]);
  ok(st.mi === mi && mi >= 1, 'missions total counts every mission done', [st.mi, mi]);
  // leaderboard: #1 of the day needs 3 players
  const w3 = makeWorld(NEW);
  save(w3, 'C051', { secs: 40, m: 300, coins: 10, score: 300, ev: {} }); save(w3, 'C052', { secs: 40, m: 300, coins: 10, score: 200, ev: {} });
  const top = save(w3, 'C053', { secs: 100, m: 1200, coins: 10, score: 5000, ev: {} });
  ok(top.newBadges.indexOf('Leaderboard Silver: #1 of the day') > -1, '#1 of the day with 3 players -> Leaderboard Silver', top.newBadges);
  ok(top.ladders.filter(l => l.ladder === 'lb')[0].tiers[0].on === false, 'Top 10 of the week needs 12 players: not given', top.ladders.filter(l => l.ladder === 'lb')[0]);
  ok(top.badges.some(b => b.id === 'day1'), 'old list shows day1 to older phones', top.badges);
}

// ---------- 5. last run cause ----------
console.log('5. Last run column keeps the cause');
{
  const w = makeWorld(NEW);
  const ev = Object.assign({}, run1.ev, { cause: 'puddle', causeText: 'Stepped in a puddle, coach caught you', lane: 2, atM: 2600, hits: [{ k: 'cones', m: 900 }, { k: 'puddle', m: 2598 }] });
  let r = save(w, 'C060', Object.assign({}, run1, { ev: ev }));
  const cell = w.tab().rows[1][14], m = /^T(\d+) (.*)$/.exec(cell);
  ok(m && Number(m[1]) === NOW, 'Last run starts with T + time', cell);
  const o = m && JSON.parse(m[2]);
  ok(o && o.cause === 'puddle' && o.text === 'Stepped in a puddle, coach caught you' && o.lane === 2 && o.m === 2600 && o.hits.length === 2, 'cause JSON saved', o);
  r = w.call({ op: 'save', run: run1 }, 'C060');
  ok(r.error === 'Slow down, one run at a time.', 'anti spam still reads the time from the new cell format', r.error);
  tick(3600 * 1000); r = w.call({ op: 'save', run: run1 }, 'C060');
  ok(!r.error && /^T\d+$/.test(w.tab().rows[1][14]), 'a run from an older phone (no cause) saves the old format', w.tab().rows[1][14]);
  tick(3600 * 1000); r = w.call({ op: 'save', run: Object.assign({}, run1, { ev: { cause: 'x"}<script>', causeText: 'a\nb', hits: [1, null, { k: 'dog' }] } }) }, 'C060');
  const o2 = JSON.parse(w.tab().rows[1][14].replace(/^T\d+ /, ''));
  ok(o2.cause === 'xscript' && o2.text === 'ab' && o2.hits.length === 2, 'cause text cleaned', o2);
}

// ---------- 6. buy life still works ----------
console.log('6. buy and get');
{
  const w = makeWorld(NEW); for (let i = 0; i < 6; i++) save(w, 'C070', run1);
  const r = w.call({ op: 'buy', item: 'life' }, 'C070');
  ok(!r.error && r.up.life === 1, 'buy extra life', r.error || r.up);
  const g = w.call({ op: 'get' }, 'C070');
  ok(!g.error && g.ladders.length === 12, 'get returns ladders', g.error);
  // the read path (lock free) must not write
  w.RO_ = true; let threw = null; try { vm.runInContext('RO_ = true', w); vm.runInContext('clRun_', w)({ op: 'get' }, 'C070'); } catch (e) { threw = e.message; } vm.runInContext('RO_ = false', w);
  ok(threw === null, 'get on an existing row with the Stats column does not need the lock', threw);
}

// ---------- 7. lives text in the Super powers window (client/index.html functions) ----------
console.log('7. lives text');
{
  const html = fs.readFileSync(path.join(DIR, '..', '..', 'client', 'index.html'), 'utf8');
  const pick = name => { const a = html.indexOf('function ' + name + '('); let d = 0, i = html.indexOf('{', a); for (; i < html.length; i++) { if (html[i] === '{') d++; else if (html[i] === '}') { d--; if (!d) break; } } return html.slice(a, i + 1); };
  const c = { cfg: k => ({ 'game.lifeMax': 3 })[k] }; vm.createContext(c); vm.runInContext(pick('runLives') + pick('lifeText'), c);
  const T = (life, slot, lm) => c.lifeText({ up: { life: life }, lifeMax: lm || 3, lv: { have: { life2: slot } } });
  ok(T(0, false) === 'Start your next run with 2 lives', '0 extra lives', T(0, false));
  ok(T(0, true) === 'Start your next run with 2 lives', '0 extra lives, slot open', T(0, true));
  ok(T(1, true) === 'Start your next run with 3 lives', '1 owned, 2nd life slot: next buy gives 3', T(1, true));
  ok(T(1, false) === 'Your next run starts with 2 lives. More are saved for later runs', '1 owned, no slot: buying more does not add a life to the next run', T(1, false));
  ok(T(3, true) === 'Your next run starts with 3 lives', 'at the max with the slot', T(3, true));
  ok(T(3, false) === 'Your next run starts with 2 lives', 'at the max without the slot', T(3, false));
  ok(T(2, true, 2) === 'Your next run starts with 3 lives', 'lifeMax 2', T(2, true, 2));
  ok(!/ - |—|heart/i.test([T(0), T(1, true), T(3, true)].join(' ')), 'no dashes, no hearts');
  ok(c.runLives({ up: { life: 2 }, lv: { have: { life2: true } } }, 2) === 3, 'runLives 2 owned + slot = 3');
  // same rule as run.html
  const run = fs.readFileSync(path.join(DIR, '..', '..', 'client', 'run.html'), 'utf8');
  ok(run.indexOf("var l2=PROF&&PROF.lv&&PROF.lv.have&&PROF.lv.have.life2&&UPL('life')>1;lives=l2?3:2") > -1, 'run.html start lives rule is the one the text uses');
  ok(!/hearts?\b/i.test(run.replace(/sfx\('heart'\)|k==='heart'/g, '')), 'run.html has no "heart" text');
  ok(!/\bhearts?\b/i.test(html.replace(/i-heart/g, '')), 'index.html has no "heart" text');
}

// ---------- 8. graphics tier (client/run.html) ----------
console.log('8. graphics tier');
{
  const src = fs.readFileSync(path.join(DIR, '..', '..', 'client', 'run.html'), 'utf8'), code = src.slice(src.indexOf('var IOS='), src.indexOf('function qApply()'));
  const Q = (ua, dm, gpu, force) => { const c = { navigator: { userAgent: ua, deviceMemory: dm, platform: 'Linux', maxTouchPoints: 5 }, localStorage: { getItem: () => force || null }, devicePixelRatio: 3,
    document: { createElement: () => ({ getContext: () => ({ getExtension: k => k === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 1 } : null, getParameter: () => gpu }) }) } };
    vm.createContext(c); vm.runInContext(code, c); return { q: c.Q, pr: c.qPR(), ios: c.IOS }; };
  const I = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', A = 'Mozilla/5.0 (Linux; Android 13)';
  ok(Q(I, undefined, 'Apple GPU').q === 2 && Q(I, undefined, 'Apple GPU').pr === 2, 'iPhone starts at 2, pixel ratio 2');
  ok(Q(A, 8, 'Adreno (TM) 740').q === 2, 'Android 8 GB starts at 2');
  ok(Q(A, 4, 'Mali-G52').q === 2, 'Android 4 GB starts at 2 (even a mid GPU)');
  ok(Q(A, undefined, 'Mali-G57').q === 2, 'unknown memory starts at 2');
  ok(Q(A, 3, 'Mali-G52').q === 1 && Q(A, 3, 'Mali-G52').pr === 1.75, '3 GB starts at 1 with pixel ratio 1.75');
  ok(Q(A, 2, 'Adreno (TM) 506').q === 0, '2 GB starts at 0');
  ok(Q(A, 3, 'Mali-T720').q === 0 && Q(A, 4, 'Mali-T720').q === 2, 'old GPU only drops a phone under 4 GB');
  ok(Q(A, 8, 'Adreno', '1').q === 1, 'cr_q override still works');
  ok(/antialias:Q>0/.test(src), 'antialias on at tier 1 and 2');
  ok(src.indexOf('if(av>.05&&Q>(IOS?1:0)){Q--;') > -1, 'probe: one step, only over 50 ms, never to 0 on iPhone');
}

// DUMP=file writes a sample reply (mid level player) for the client preview
if (process.env.DUMP) {
  const w = makeWorld(NEW, { trained: true }); w.SpreadsheetApp.openById('OPS'); const sh = w.books.OPS.insertSheet('CORNICHE RUN');
  sh.appendRow(['Client ID', 'Name', 'Best score', 'Best m', 'Coins', 'Runs', 'Total m', 'Day', 'Day best', 'Week', 'Week best', 'Upgrades', 'Missions', 'Badges', 'Last run', 'Earned total', 'Updated', 'Cash (cents)', 'Cash earned (cents)', 'XP', 'Owned']);
  sh.appendRow(['C030', 'Old Player', 12000, 2900, 4200, 14, 23000, '', 0, '', 0, '{"life":1}', '{}', '["first","km1","runs10","rich","boost","week10"]', '', 11000, '', 0, 0, 3500, '{}']);
  let r; for (let i = 0; i < 3; i++) r = save(w, 'C030', { secs: 200, m: 2300, coins: 250, score: 8000, ev: { jumps: 45, slides: 30, clean: 640, letters: 2 } });
  fs.writeFileSync(process.env.DUMP, JSON.stringify(r));
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
