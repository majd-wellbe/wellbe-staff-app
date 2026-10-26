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
    function appClientInfo_(cid) { return { name: 'Test ' + cid, email: cid === 'C900' ? ' Joe@Wellbe.com ' : '', phone: cid === 'C901' ? '70 123 456' : cid === 'C902' ? '03 555 777' : cid === 'C903' ? '81 123 456' : '' }; }
    function cfgStaff_() { return [{ id: 'joe', email: 'joe@wellbe.com', phone: '+961 70 123 456', role: 'trainer' }, { id: 'romy', email: '', phone: '+961 3 555 777', role: 'assistant' }]; }
    var PKGS = [{ cid: 'C801', type: 'Physio - Single Session ($50)' }, { cid: 'C802', type: '1:3 - 12x/month ($200pp)' }];
    function pkgsAll_() { return PKGS; }
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

// ---------- 9. long runs with 45 s sprints still pass the server's speed check (client/run.html GAME.speed, GAME.sprint) ----------
console.log('9. long sprint runs and the server check');
{
  const html = fs.readFileSync(path.join(DIR, '..', '..', 'client', 'run.html'), 'utf8');
  const G = vm.runInContext('(' + html.slice(html.indexOf('var GAME={') + 9, html.indexOf('\n};', html.indexOf('var GAME={')) + 2) + ')', vm.createContext({}));
  // a perfect run frame by frame, like run.html: every sprint, no hits. cap = the client keeps the average under the server's 19.5 m/s
  const sim = (secs, cap) => { let t = 0, d = 0, spd = G.speed.start * .6, spr = 0, rec = 0, sprN = G.sprint.first, n = 0; const dt = 1 / 60;
    while (t < secs) { const base = Math.min(G.speed.max, G.speed.start + G.speed.ramp * t) * 1.012, c = cap && d > G.speed.avgMax * t + 20;
      spd += ((c ? base : base * (spr > 0 ? G.sprint.boost : rec > 0 ? .9 : 1)) - spd) * Math.min(1, dt * 3); d += spd * dt; t += dt;
      if (t >= sprN && spr <= 0 && rec <= 0) spr = G.sprint.dur;
      if (spr > 0) { spr -= dt; if (spr <= 0) { spr = 0; rec = 5; n++; sprN = t + G.sprint.gapMin; } } else if (rec > 0) rec = Math.max(0, rec - dt); }
    return { secs: Math.round(t), m: Math.floor(d), sprints: n }; };
  [[600, 'C090'], [1500, 'C091'], [3000, 'C092']].forEach(([secs, id]) => {
    const w = makeWorld(NEW), R = sim(secs, true), coins = Math.floor(R.m * .2);
    const r = save(w, id, { secs: R.secs, m: R.m, coins, score: R.m * 4, spent: 0, ev: { jumps: 200, slides: 150, sprints: R.sprints } });
    ok(r && !r.error, Math.round(secs / 60) + ' minute perfect run (' + R.m + ' m, ' + R.sprints + ' sprints of ' + G.sprint.dur + ' s) is accepted', r && r.error);
  });
  const raw = sim(1500, false);
  ok(raw.m <= raw.secs * 19.5 + 30, 'even without the client cap a 25 minute sprint run passes the server check (' + raw.m + ' m in ' + raw.secs + ' s), the cap is only a safety net');
}

// ---------- 10. runner outfits: prices, unlock rules, buying ----------
console.log('10. runner outfits');
{
  const O = r => { const m = {}; (r.outfits || []).forEach(o => { m[o.id] = o; }); return m; };
  const xpFor = (w, l) => vm.runInContext('(function(){var t=0;for(var i=1;i<' + l + ';i++)t+=lvNeed_(i);return t})()', w);
  const w = makeWorld(NEW); save(w, 'C810', run1);
  let g = w.call({ op: 'get' }, 'C810'), o = O(g);
  ok(g.outfits && g.outfits.length === 10, '10 outfits in every reply', g.outfits && g.outfits.length);
  ok(o.matchday.own && o.matchday.rule === 'free' && !o.modest, 'Yalla Lebnan is free, Modest Mover is gone', [o.matchday, o.modest]);
  ok(!o.coach.own && o.coach.coins === 1500 && o.coach.rule === 'staff' && o.coach.can, 'Coach Kit 1,500 coins for a client', o.coach);
  ok(o.ramadan.coins === 1000 && o.street.coins === 2000 && o.rehab.coins === 1000, 'prices: Ramadan 1,000, Mar Mikhael 2,000, Rehab Hero 1,000', [o.ramadan.coins, o.street.coins, o.rehab.coins]);
  ok(o.tyrian.rule === 'level' && o.tyrian.lv === 20 && o.tyrian.coins === 3000 && !o.tyrian.can && o.cedar.lv === 30 && o.cedar.coins === 6000 && o.legend.lv === 40 && o.legend.coins === 10000, 'prestige: level 20/30/40 and 3,000/6,000/10,000 coins', [o.tyrian, o.cedar, o.legend]);
  const coins0 = g.coins;
  let r = w.call({ op: 'buy', item: 'street' }, 'C810');
  ok(coins0 < 2000 ? r.error === 'Not enough coins' : !r.error, 'not enough coins refused', [coins0, r.error]);
  w.tab().rows[1][4] = 20000;
  r = w.call({ op: 'buy', item: 'ramadan' }, 'C810');
  ok(!r.error && r.coins === 19000 && O(r).ramadan.own && r.bought === 'Ramadan Night Run', 'buy Ramadan Night Run: 1,000 coins off, now yours', r.error || [r.coins, O(r).ramadan]);
  ok(JSON.parse(w.tab().rows[1][20]).of_ramadan === 1, 'saved in Owned as of_ramadan', w.tab().rows[1][20]);
  r = w.call({ op: 'buy', item: 'ramadan' }, 'C810');
  ok(r.error === 'You already have Ramadan Night Run', 'already owned refused', r.error);
  ok(w.call({ op: 'get' }, 'C810').coins === 19000, 'no coins taken for the refused buy');
  r = w.call({ op: 'buy', item: 'matchday' }, 'C810'); ok(r.error === 'You already have Yalla Lebnan', 'free outfit cannot be bought', r.error);
  r = w.call({ op: 'buy', item: 'am530' }, 'C810'); ok(/unlocks after 10 runs started before 7 am/.test(r.error || ''), '5:30 AM Club cannot be bought', r.error);
  r = w.call({ op: 'buy', item: 'race42' }, 'C810'); ok(/unlocks when you have run 42 km/.test(r.error || ''), 'Race Day 42K cannot be bought', r.error);
  r = w.call({ op: 'buy', item: 'tyrian' }, 'C810'); ok(r.error === 'Reach level 20 to buy Tyrian Purple', 'prestige outfit: level gate', r.error);
  r = w.call({ op: 'shop', item: 'o1' }, 'C810'); ok(r.error === 'Reach level 20 to buy the Tyrian Purple outfit', 'shop o1 has the same level gate', r.error);
  r = w.call({ op: 'buy', item: 'constructor' }, 'C810'); ok(r.error === 'Unknown upgrade', 'unknown item refused', r.error);
  // reach level 20: Tyrian Purple opens for coins (not free), Golden Cedar still closed
  w.tab().rows[1][19] = xpFor(w, 20) + 5;
  g = w.call({ op: 'get' }, 'C810'); o = O(g);
  ok(g.lv.level === 20 && !o.tyrian.own && o.tyrian.can && !o.cedar.can && g.lv.have.o1 === false, 'level 20: Tyrian Purple can be bought, not free', [g.lv.level, o.tyrian, g.lv.have.o1]);
  r = w.call({ op: 'buy', item: 'tyrian' }, 'C810');
  ok(!r.error && r.coins === 16000 && O(r).tyrian.own && r.lv.have.o1 === true, 'buy Tyrian Purple: 3,000 coins, level shop shows it owned', r.error || [r.coins, O(r).tyrian, r.lv.have.o1]);
  r = w.call({ op: 'buy', item: 'cedar' }, 'C810'); ok(r.error === 'Reach level 30 to buy Golden Cedar', 'Golden Cedar needs level 30', r.error);
  // level up text for a prestige outfit
  w.tab().rows[1][19] = xpFor(w, 30) - 3;
  r = save(w, 'C810', run1);
  ok((r.levelUps || []).some(u => u.level === 30 && u.got.indexOf('Golden Cedar outfit can now be bought') > -1), 'level 30 chest says Golden Cedar can now be bought', r.levelUps);
  ok(O(r).cedar.can && !O(r).cedar.own, 'level 30: Golden Cedar for coins', O(r).cedar);
  // staff: Coach Kit free (email or phone in STAFF), physio: Rehab Hero free
  const ws = makeWorld(NEW); save(ws, 'C900', run1); save(ws, 'C901', run1); save(ws, 'C801', run1); save(ws, 'C802', run1);
  const a = O(ws.call({ op: 'get' }, 'C900')), b = O(ws.call({ op: 'get' }, 'C901')), c = O(ws.call({ op: 'get' }, 'C801')), d = O(ws.call({ op: 'get' }, 'C802'));
  ok(a.coach.own && a.coach.got === 'Free for staff' && b.coach.own, 'staff (email or phone in STAFF) get the Coach Kit free', [a.coach, b.coach]);
  ok(!c.coach.own && c.rehab.own && c.rehab.got === 'Free with your physio booking', 'a physio client gets Rehab Hero free', [c.coach, c.rehab]);
  ok(!d.rehab.own && d.rehab.can && d.rehab.coins === 1000, 'no physio: Rehab Hero is 1,000 coins', d.rehab);
  save(ws, 'C902', run1); save(ws, 'C903', run1);
  ok(O(ws.call({ op: 'get' }, 'C902')).coach.own, 'staff phone written 03 555 777 matches +961 3 555 777');
  ok(!O(ws.call({ op: 'get' }, 'C903')).coach.own, 'a client on 81 123 456 is not the staff member on 70 123 456');
  ok(ws.call({ op: 'buy', item: 'coach' }, 'C900').error === 'You already have Wellbe Coach Kit', 'staff cannot pay for the free kit');
  const wg = makeWorld(NEW); save(wg, 'G0007', run1); const og = O(wg.call({ op: 'get' }, 'G0007'));
  ok(!og.coach.own && !og.rehab.own, 'a guest is not staff and has no physio');
  // 5:30 AM Club: 10 runs of 300 m+ that started before 7:00
  const we = makeWorld(NEW); const short = { secs: 40, m: 200, coins: 20, score: 300, ev: {} };
  for (let i = 0; i < 9; i++) { NOW = Date.UTC(2026, 10, 1 + i, 6, 30); we.call({ op: 'save', run: run1 }, 'C820'); }
  NOW = Date.UTC(2026, 10, 12, 6, 30); we.call({ op: 'save', run: short }, 'C820');   // too short: not counted
  NOW = Date.UTC(2026, 10, 13, 9, 10); we.call({ op: 'save', run: run1 }, 'C820');    // started at 9:07: not counted
  let e = O(we.call({ op: 'get' }, 'C820')).am530;
  ok(!e.own && e.have === 9 && e.need === 10, '9 early runs: not yet (short and late runs not counted)', e);
  NOW = Date.UTC(2026, 10, 14, 7, 1); r = we.call({ op: 'save', run: run1 }, 'C820');   // ends 7:01, started 6:58
  ok(O(r).am530.own && O(r).am530.have === 10, '10th run started before 7:00 unlocks the 5:30 AM Club', O(r).am530);
  // Race Day 42K: 42 km in total
  ok(!O(r).race42.own && O(r).race42.have === Number(we.tab().rows[1][6]), 'Race Day 42K shows total metres', O(r).race42);
  we.tab().rows[1][6] = 41999; ok(!O(we.call({ op: 'get' }, 'C820')).race42.own, '41,999 m: not yet');
  we.tab().rows[1][6] = 42000; ok(O(we.call({ op: 'get' }, 'C820')).race42.own, '42 km in total unlocks Race Day 42K');
  // other buys still work the old way
  const wo = makeWorld(NEW); save(wo, 'C830', run1); wo.tab().rows[1][4] = 5000;
  r = wo.call({ op: 'buy', item: 'magnet' }, 'C830'); ok(!r.error && r.up.magnet === 1 && r.coins === 4500, 'upgrade buy unchanged', r.error || r.up);
  r = wo.call({ op: 'shop', item: 'magnet' }, 'C830'); ok(r.error === 'You already have the Coin magnet', 'shop: once item still owned by level', r.error);
}

// ---------- 11. runner names: chosen name on the leaderboards, checked on the server ----------
console.log('11. runner names');
{
  const w = makeWorld(NEW); save(w, 'C701', run1); save(w, 'C702', run1);
  let g = w.call({ op: 'get' }, 'C701');
  ok(g.runName === 'Test' && g.runNameSet === false, 'default runner name is the first name', [g.runName, g.runNameSet]);
  ok(g.boards.all.some(x => x.n === 'Test C.'), 'leaderboard shows "First L." before a name is picked', g.boards.all);
  let r = w.call({ op: 'get', name: '  Corniche   Queen ' }, 'C701');
  ok(!r.error && r.runName === 'Corniche Queen' && r.runNameSet === true, 'name saved (spaces tidied) through op get', r.error || r.runName);
  ok(JSON.parse(w.tab().rows[1][21]).nm === 'Corniche Queen', 'saved in the Stats column (V) as nm, no new column', w.tab().rows[1][21]);
  ok(w.tab().rows[0].length === 22 && w.tab().rows[1][1] === 'Test C701', 'header unchanged and the Name column keeps the real name', [w.tab().rows[0].length, w.tab().rows[1][1]]);
  g = w.call({ op: 'get' }, 'C702');
  ok(g.boards.all.some(x => x.n === 'Corniche Queen') && g.boards.all.some(x => x.n === 'Test C.'), 'other players see the chosen name on the leaderboards', g.boards.all);
  r = w.call({ op: 'name', name: 'Majd 961' }, 'C701'); ok(!r.error && r.runName === 'Majd 961', 'op name works too', r.error || r.runName);
  r = save(w, 'C701', run1); ok(!r.error && r.runName === 'Majd 961' && JSON.parse(w.tab().rows[1][21]).nm === 'Majd 961', 'a run keeps the name (Stats is rewritten with it)', r.error || w.tab().rows[1][21]);
  const bad = { 'A': 'Pick a name of 2 to 14 characters.', 'Abcdefghijklmno': 'Pick a name of 2 to 14 characters.', 'Hi!': 'Use letters, numbers and spaces only.', '<b>x</b>': 'Use letters, numbers and spaces only.',
    'fuckboy': 'Pick another name, that one is not allowed.', 'Sh1t Runner': 'Pick another name, that one is not allowed.', 'kos': 'Pick another name, that one is not allowed.', 'Ya Sharmouta': 'Pick another name, that one is not allowed.', 'nazi': 'Pick another name, that one is not allowed.', 'ya ahbe': 'Pick another name, that one is not allowed.', 'نيك': 'Pick another name, that one is not allowed.', 'كسمك': 'Pick another name, that one is not allowed.',
    'manyak 1': 'Pick another name, that one is not allowed.', 'ayre': 'Pick another name, that one is not allowed.', 'شرموطة': 'Pick another name, that one is not allowed.', 'Big Ass': 'Pick another name, that one is not allowed.' };
  Object.keys(bad).forEach(k => { const e = w.call({ op: 'get', name: k }, 'C701').error; ok(e === bad[k], 'refused: ' + k, e); });
  ['Hassan', 'Kostas', 'Assaad', 'Dickson', 'Zeina', 'Airport Run', 'Sexton', 'جاد', 'Élodie', 'Nazih', 'Nazira', 'Wahbe', 'Grape', 'خولة', 'نيكول', 'زبيدة', 'Rami 2'].forEach(k => {
    const x = w.call({ op: 'get', name: k }, 'C701'); ok(!x.error && x.runName === k, 'allowed: ' + k, x.error); });
  ok(w.call({ op: 'get' }, 'C701').runName === 'Rami 2', 'a refused name leaves the last good one');
  r = w.call({ op: 'get', name: '' }, 'C701'); ok(!r.error && r.runName === 'Test' && !r.runNameSet && !('nm' in JSON.parse(w.tab().rows[1][21])), 'empty name goes back to the first name', r.runName);
  // an old phone (no name field) changes nothing; the cached leaderboard rows carry the name
  w.call({ op: 'get', name: 'Speedy' }, 'C701'); r = w.call({ op: 'get' }, 'C702'); r = w.call({ op: 'get' }, 'C702');
  ok(r.boards.all.some(x => x.n === 'Speedy'), 'leaderboard from the cache shows the chosen name', r.boards.all);
}

// ---------- 12. runner studio: gear, tattoos, taunts bought on the server ----------
console.log('12. studio items');
{
  const S = r => r.studio || {}, xpFor = (w, l) => vm.runInContext('(function(){var t=0;for(var i=1;i<' + l + ';i++)t+=lvNeed_(i);return t})()', w);
  const w = makeWorld(NEW); save(w, 'C750', run1); let g = w.call({ op: 'get' }, 'C750'), st = S(g);
  ok(Object.keys(st).length === 36, '36 studio items in every reply', Object.keys(st).length);
  const free = Object.keys(st).filter(k => st[k].own).sort();
  ok(J(free) === J(['g_buds', 'g_cap', 'g_hband', 'g_sport', 'g_sweat', 'tn_yes', 'tt_pulse', 'tt_stars']), 'free: cap, headband, sport shades, earbuds, sweatband, heartbeat and stars tattoos, Yes! taunt', free);
  ok(Object.keys(st).filter(k => /^tn_/.test(k) && st[k].own).length === 1, 'exactly one free taunt');
  const P = { g_capb: 600, g_visor: 900, g_beanie: 800, g_bucket: 1200, g_round: 1000, g_avi: 1500, g_phones: 1500, g_watch: 1200, tt_wellbe: 800, tt_roman: 1000, tt_cedar: 1000, tt_tribal: 1200, tt_rose: 1200, tt_quwwa: 1500, tt_yalla: 1500,
    tn_fistpump: 500, tn_salute: 600, tn_jacks: 700, tn_squat: 700, tn_dance: 800, tn_pushup: 900, tn_taunt: 1000, tn_victory: 1200, tn_hiphop1: 1500, tn_hiphop2: 1500, tn_twirl: 2000, tn_capoeira: 2500, tn_roll: 2500 };
  ok(Object.keys(P).every(k => st[k] && st[k].coins === P[k]), 'prices from Config.gs', Object.keys(P).filter(k => !st[k] || st[k].coins !== P[k]));
  const L = { tn_dance: 3, tn_hiphop1: 5, tn_hiphop2: 5, tn_twirl: 8, tn_capoeira: 10, tn_roll: 12 };
  ok(Object.keys(L).every(k => st[k].lv === L[k]), 'level gates: Dance 3, Hip Hop 5, Butterfly Twirl 8, Capoeira 10, Roll 12', Object.keys(L).map(k => st[k].lv));
  ok(['g_cap', 'g_beanie', 'tt_rose', 'tn_salute'].every(k => ['n', 'k', 'coins', 'lv', 'own', 'can'].every(f => f in st[k])), 'item shape { n, k, coins, lv, own, can }');
  w.tab().rows[1][4] = 3000;
  let r = w.call({ op: 'buy', item: 'g_beanie' }, 'C750');
  ok(!r.error && r.coins === 2200 && S(r).g_beanie.own && r.bought === 'Beanie', 'buy Beanie: 800 coins off, yours', r.error || [r.coins, S(r).g_beanie]);
  ok(JSON.parse(w.tab().rows[1][20]).g_beanie === 1, 'saved in Owned as g_beanie', w.tab().rows[1][20]);
  r = w.call({ op: 'buy', item: 'g_beanie' }, 'C750'); ok(r.error === 'You already have Beanie', 'already owned refused', r.error);
  r = w.call({ op: 'buy', item: 'g_cap' }, 'C750'); ok(r.error === 'You already have Cap', 'free item cannot be bought', r.error);
  r = w.call({ op: 'buy', item: 'tt_quwwa' }, 'C750'); ok(!r.error && r.coins === 700 && S(r).tt_quwwa.own, 'buy Quwwa tattoo for 1,500', r.error || r.coins);
  r = w.call({ op: 'buy', item: 'g_avi' }, 'C750'); ok(r.error === 'Not enough coins' && w.call({ op: 'get' }, 'C750').coins === 700, 'not enough coins: refused, nothing taken', r.error);
  r = w.call({ op: 'buy', item: 'tn_salute' }, 'C750'); ok(!r.error && r.coins === 100, 'buy Salute taunt for 600', r.error || r.coins);
  w.tab().rows[1][4] = 10000; const lv0 = w.call({ op: 'get' }, 'C750').lv.level;
  r = w.call({ op: 'buy', item: 'tn_capoeira' }, 'C750'); ok(r.error === 'Reach level 10 to buy Capoeira' && !S(w.call({ op: 'get' }, 'C750')).tn_capoeira.can, 'level gate refuses Capoeira at level ' + lv0, r.error);
  w.tab().rows[1][19] = xpFor(w, 10) + 5; g = w.call({ op: 'get' }, 'C750');
  ok(S(g).tn_capoeira.can && !S(g).tn_roll.can, 'level 10: Capoeira can be bought, Roll (level 12) not yet', [S(g).tn_capoeira, S(g).tn_roll]);
  r = w.call({ op: 'buy', item: 'tn_capoeira' }, 'C750'); ok(!r.error && r.coins === 7500 && S(r).tn_capoeira.own, 'buy Capoeira at level 10: 2,500 coins', r.error || r.coins);
  r = w.call({ op: 'buy', item: 'tn_moonwalk' }, 'C750'); ok(r.error === 'Unknown upgrade', 'unknown studio id refused', r.error);
  ok(S(w.call({ op: 'get' }, 'C750')).g_beanie.own && r.outfits === undefined, 'owned items stay owned');
  // the old buys still work next to the new ones
  r = w.call({ op: 'buy', item: 'ramadan' }, 'C750'); ok(!r.error && O_(r).ramadan.own, 'outfit buy unchanged', r.error);
  r = w.call({ op: 'buy', item: 'life' }, 'C750'); ok(!r.error, 'extra life buy unchanged', r.error);
}
function O_(r) { const m = {}; (r.outfits || []).forEach(o => { m[o.id] = o; }); return m; }

// ---------- 13. client: taunt files, manifest, sprint ----------
console.log('13. client taunts and studio lists');
{
  const html = fs.readFileSync(path.join(DIR, '..', '..', 'client', 'run.html'), 'utf8'), td = path.join(DIR, '..', '..', 'client', 'models', 'taunts');
  const man = JSON.parse(fs.readFileSync(path.join(td, 'manifest.json'), 'utf8'));
  ok(man.taunts.length === 12, '12 converted Mixamo taunts in the manifest', man.taunts.length);
  const cfg = fs.readFileSync(path.join(DIR, 'Config.gs'), 'utf8');
  man.taunts.forEach(t => {
    const j = JSON.parse(fs.readFileSync(path.join(td, t.f), 'utf8')), n = Math.round(j.dur * j.fps) + 1;
    ok(j.dur >= 1 && j.dur <= 4.05 && j.p.length === n * 3 && j.q.every(a => a.length === 4 || a.length === n * 4) && j.bones.indexOf('pelvis') > -1, t.id + ': ' + j.dur + ' s, tracks complete');
    ok(fs.statSync(path.join(td, t.f)).size < 60000, t.id + ' file under 60 KB', fs.statSync(path.join(td, t.f)).size);
    ok(cfg.indexOf('tn_' + t.id + ':') > -1 && html.indexOf("'tn_" + t.id + "'") > -1, t.id + ' has a price in Config.gs and a name in run.html');
    // stays on the start line: the hips never travel more than 15 cm on the ground
    let mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(j.p[i * 3] - j.p[0]), Math.abs(j.p[i * 3 + 1] - j.p[1]));
    ok(mx < .16, t.id + ' stays in place (pelvis moves ' + mx.toFixed(2) + ' in the local plane)');
  });
  ok(!/—/.test(html.slice(html.indexOf('var FACES='), html.indexOf('/* ---------- music and sounds'))), 'no em dashes in the studio text');
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
